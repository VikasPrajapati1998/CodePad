/**
 * Tab management: pinned tabs, tab colors, drag reorder, context menu, close variants,
 * copy path / reveal, reopen closed tab and the Documents panel.
 * Talks to the app only through ctx (tabs.decorate / onContextMenu / interceptClose and friends).
 */
(() => {
  const COLOR_NAMES = ['None', 'Orange', 'Green', 'Blue', 'Pink', 'Yellow'];
  const CLOSED_STACK_MAX = 20;
  const CLOSED_TEXT_MAX = 1024 * 1024;
  const DRAG_TYPE = 'application/x-codepad-tab';

  /** A tab that is about to close, kept so Reopen Closed Tab can bring it back. */
  interface ClosedTabEntry {
    kind: CodePadTabKind;
    path: string | null;
    name: string;
    encoding: string | null;
    persist: CodePadTabPersist | null;
    language: string | null;
    viewState: monaco.editor.ICodeEditorViewState | null;
    content: string | null;
  }

  let appCtx: CodePadCtx | null = null;
  /** True while a command closes pinned tabs on purpose, so interceptClose lets it through. */
  let forceClosing = false;
  /** Tab being dragged inside the tab bar or the Documents panel. */
  let dragged: CodePadTab | null = null;
  /** Closed tabs, newest last. */
  const closedStack: ClosedTabEntry[] = [];
  /** Re-renders the Documents panel (set when the panel is first shown). */
  let refreshDocuments = () => {};

  /** The context given to `init`; commands and menus only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The tabs feature is not initialized.');
    }
    return appCtx;
  }

  const isPinned = (tab: CodePadTab | null | undefined): boolean => Boolean(tab && tab.persist && tab.persist.pinned);

  /** Directory part of a path (either separator); empty string for a bare name. */
  function dirName(filePath: string): string {
    const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (index < 0) {
      return '';
    }
    return index === 0 ? filePath.slice(0, 1) : filePath.slice(0, index);
  }

  /** Tabs that carry persist data (everything except diff tabs). */
  const persistable = (tab: CodePadTab | null | undefined): tab is CodePadTextTab | CodePadDocumentTab =>
    Boolean(tab && tab.persist);

  /** Toggles a tab's pin state and moves it to the edge of the pinned block. */
  function togglePin(tab: CodePadTab): void {
    if (!persistable(tab)) {
      return;
    }
    tab.persist.pinned = !tab.persist.pinned;
    const pinnedOthers = app().tabs.list().filter((other) => other !== tab && isPinned(other)).length;
    app().tabs.move(tab, pinnedOthers);
    app().tabs.changed();
  }

  function setColor(tab: CodePadTab, color: number): void {
    if (!persistable(tab)) {
      return;
    }
    tab.persist.color = color;
    app().tabs.changed();
  }

  /**
   * Closes tabs without touching pinned ones; resolves false when the user cancels.
   * @param candidates Tabs to close.
   */
  async function closeUnpinned(candidates: CodePadTab[]): Promise<boolean> {
    const targets = candidates.filter((tab) => !isPinned(tab));
    if (targets.length === 0) {
      return true;
    }
    return app().tabs.closeMany(targets);
  }

  async function closeAll(): Promise<boolean> {
    const all = app().tabs.list();
    if (!(await closeUnpinned(all))) {
      return false;
    }
    forceClosing = true;
    try {
      for (const tab of all.filter(isPinned)) {
        if (!(await app().tabs.close(tab, { force: true }))) {
          return false;
        }
      }
    } finally {
      forceClosing = false;
    }
    return true;
  }

  function closeRelative(tab: CodePadTab, direction: number): Promise<boolean> {
    const list = app().tabs.list();
    const index = list.indexOf(tab);
    if (index < 0) {
      return Promise.resolve(false);
    }
    const slice = direction < 0 ? list.slice(0, index) : list.slice(index + 1);
    return closeUnpinned(slice);
  }

  /** Moves a tab to a final index (pinned/unpinned block rules are enforced by ctx.tabs.move). */
  function moveTo(tab: CodePadTab, index: number): void {
    const list = app().tabs.list();
    const target = Math.max(0, Math.min(list.length - 1, index));
    if (list.indexOf(tab) !== target) {
      app().tabs.move(tab, target);
    }
  }

  function moveBy(tab: CodePadTab, delta: number): void {
    moveTo(tab, app().tabs.list().indexOf(tab) + delta);
  }

  /** Active tab or a status message when there is none. */
  function requireActive(): CodePadTab | null {
    const tab = app().tabs.active();
    if (!tab) {
      app().status.set('No open tab.');
    }
    return tab;
  }

  async function copyText(text: string, label: string): Promise<void> {
    await app().clipboard.write(text);
    app().status.set(`Copied ${label}.`);
  }

  function copyPath(tab: CodePadTab): Promise<void> {
    if (!tab.path) {
      app().status.set('This tab has no file path yet.');
      return Promise.resolve();
    }
    return copyText(tab.path, 'file path');
  }

  function copyName(tab: CodePadTab): Promise<void> {
    return copyText(tab.name, 'file name');
  }

  function copyDir(tab: CodePadTab): Promise<void> {
    const dir = tab.path ? dirName(tab.path) : '';
    if (!dir) {
      app().status.set('This tab has no file path yet.');
      return Promise.resolve();
    }
    return copyText(dir, 'directory path');
  }

  async function revealTab(tab: CodePadTab): Promise<void> {
    if (!tab.path) {
      app().status.set('This tab has no file path yet.');
      return;
    }
    try {
      await app().files.reveal(tab.path);
    } catch (error) {
      app().status.set(`Could not reveal the file: ${error instanceof Error && error.message ? error.message : String(error)}`);
    }
  }

  /** Remembers a tab that is about to close so Reopen Closed Tab can bring it back. */
  function rememberClosed(tab: CodePadTab): void {
    if (!tab || tab.kind === 'diff') {
      return;
    }
    const entry: ClosedTabEntry = {
      kind: tab.kind,
      path: tab.path || null,
      name: tab.name,
      encoding: tab.kind === 'text' ? tab.encoding || null : null,
      persist: tab.persist ? { ...tab.persist, bookmarks: [...(tab.persist.bookmarks || [])] } : null,
      language: null,
      viewState: null,
      content: null,
    };
    if (tab.kind === 'text' && tab.model) {
      entry.language = tab.model.getLanguageId();
      if (app().tabs.active() === tab) {
        entry.viewState = app().editor.saveViewState();
      }
      if ((!tab.path || tab.dirty) && tab.model.getValueLength() <= CLOSED_TEXT_MAX) {
        entry.content = tab.model.getValue();
      }
    }
    // Untitled tabs can only come back with their text; empty ones are not worth remembering.
    if (!entry.path && !entry.content) {
      return;
    }
    closedStack.push(entry);
    if (closedStack.length > CLOSED_STACK_MAX) {
      closedStack.shift();
    }
  }

  async function restoreClosed(): Promise<void> {
    const entry = closedStack.pop();
    if (!entry) {
      app().status.set('No recently closed tabs.');
      return;
    }
    let tab: CodePadTab | null = null;
    if (entry.path) {
      tab = await app().tabs.openPath(entry.path, {});
      if (tab && entry.encoding && tab.kind === 'text' && tab.encoding !== entry.encoding && !entry.content) {
        await app().tabs.reload(tab, { encoding: entry.encoding });
      }
    } else if (entry.kind === 'text') {
      tab = app().tabs.openText({ name: entry.name, content: entry.content ?? undefined, language: entry.language ?? undefined });
    }
    if (!tab) {
      return;
    }
    if (tab.kind === 'text' && entry.path && entry.content !== null && tab.model) {
      tab.model.setValue(entry.content);
    }
    if (tab.persist && entry.persist) {
      tab.persist.pinned = Boolean(entry.persist.pinned);
      tab.persist.color = entry.persist.color || 0;
      tab.persist.readOnly = Boolean(entry.persist.readOnly);
      tab.persist.bookmarks = entry.persist.bookmarks || [];
      app().tabs.changed();
    }
    if (entry.viewState && tab.kind === 'text' && app().tabs.active() === tab) {
      app().editor.restoreViewState(entry.viewState);
    }
  }

  /** Items of the per-tab context menu (also used by the Documents panel). */
  function menuItems(tab: CodePadTab): CodePadContextMenuItem[] {
    const list = app().tabs.list();
    const index = list.indexOf(tab);
    const hasPath = Boolean(tab.path);
    const canPersist = persistable(tab);
    const run = (fn: () => unknown) => (): void => {
      Promise.resolve(fn()).catch((error) => {
        app().status.set(error instanceof Error && error.message ? error.message : String(error));
      });
    };
    const items: CodePadContextMenuItem[] = [
      { label: 'Close', run: run(() => app().tabs.close(tab, { force: false })) },
      { label: 'Close All But This', run: run(() => closeUnpinned(list.filter((other) => other !== tab))) },
      { label: 'Close to the Left', disabled: index <= 0, run: run(() => closeRelative(tab, -1)) },
      { label: 'Close to the Right', disabled: index >= list.length - 1, run: run(() => closeRelative(tab, 1)) },
      { label: 'Close All Unchanged', run: run(() => closeUnpinned(list.filter((other) => !other.dirty))) },
      { label: 'Close All But Pinned', run: run(() => closeUnpinned(list)) },
      { separator: true },
    ];
    if (canPersist) {
      items.push({
        label: isPinned(tab) ? 'Unpin Tab' : 'Pin Tab',
        run: () => togglePin(tab),
      });
      COLOR_NAMES.forEach((name, color) => {
        items.push({
          label: color === 0 ? 'Remove Tab Color' : `Tab Color: ${name}`,
          checked: color > 0 && tab.persist.color === color,
          disabled: color === 0 && !tab.persist.color,
          run: () => setColor(tab, color),
        });
      });
      items.push({ separator: true });
    }
    items.push(
      { label: 'Copy Full Path', disabled: !hasPath, run: run(() => copyPath(tab)) },
      { label: 'Copy File Name', run: run(() => copyName(tab)) },
      { label: 'Copy Directory Path', disabled: !hasPath, run: run(() => copyDir(tab)) },
      { label: 'Reveal in File Explorer', disabled: !hasPath, run: run(() => revealTab(tab)) },
      { separator: true },
    );
    if (tab.kind === 'text') {
      items.push({
        label: 'Read-Only',
        checked: Boolean(tab.persist && tab.persist.readOnly),
        run: () => {
          app().tabs.activate(tab);
          app().commands.execute('text.toggleReadOnly');
        },
      });
    }
    items.push(
      { label: 'Reload from Disk', disabled: !hasPath || tab.kind === 'diff', run: run(() => app().tabs.reload(tab, {})) },
      { label: 'Save', disabled: tab.kind === 'diff', run: run(() => app().tabs.save(tab)) },
      { label: 'Save As...', disabled: tab.kind === 'diff', run: run(() => app().tabs.saveAs(tab)) },
    );
    const contributed = app().tabs.menuContributions(tab);
    if (contributed.length > 0) {
      items.push({ separator: true }, ...contributed);
    }
    return items;
  }

  function showMenu(tab: CodePadTab, event: MouseEvent): void {
    app().ui.contextMenu(event.clientX, event.clientY, menuItems(tab));
  }

  /**
   * Makes an element draggable for tab reordering. Drags that do not start from a tab (files from the
   * OS) are ignored so the app's own drop handling keeps working.
   * @param el Tab element or document list row.
   * @param tab The tab the element represents.
   */
  function attachDrag(el: HTMLElement, tab: CodePadTab): void {
    el.draggable = true;
    const clearMarks = (): void => el.classList.remove('cp-drop-before', 'cp-drop-after');
    const sameBlock = (): boolean => dragged !== null && dragged !== tab && isPinned(dragged) === isPinned(tab);
    const isAfter = (event: DragEvent): boolean => {
      const rect = el.getBoundingClientRect();
      const vertical = el.classList.contains('cp-doc-row');
      return vertical ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2;
    };
    el.addEventListener('dragstart', (event) => {
      dragged = tab;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_TYPE, String(tab.id));
      }
    });
    el.addEventListener('dragend', () => {
      dragged = null;
      clearMarks();
    });
    el.addEventListener('dragover', (event) => {
      if (!sameBlock()) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      const after = isAfter(event);
      el.classList.toggle('cp-drop-after', after);
      el.classList.toggle('cp-drop-before', !after);
    });
    el.addEventListener('dragleave', clearMarks);
    el.addEventListener('drop', (event) => {
      if (!sameBlock()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearMarks();
      const list = app().tabs.list();
      const moving = dragged;
      if (!moving) {
        return;
      }
      const from = list.indexOf(moving);
      const target = list.indexOf(tab);
      const after = isAfter(event);
      let to = after ? target + 1 : target;
      if (from < to) {
        to -= 1;
      }
      dragged = null;
      if (to !== from) {
        app().tabs.move(moving, to);
      }
    });
  }

  /** Adds pin icon, color class, close-button removal and drag handlers to one rendered tab. */
  function decorate(tab: CodePadTab, el: HTMLElement, labelEl: HTMLElement): void {
    if (!persistable(tab)) {
      return;
    }
    const color = tab.persist.color || 0;
    if (color > 0) {
      el.classList.add(`cp-tabcolor-${color}`);
    }
    if (isPinned(tab)) {
      el.classList.add('cp-tab-pinned');
      const pin = document.createElement('span');
      pin.className = 'cp-tab-pin';
      pin.textContent = '◆';
      pin.title = 'Pinned';
      el.insertBefore(pin, labelEl);
      const close = el.querySelector('.close');
      if (close) {
        close.remove();
      }
    }
    attachDrag(el, tab);
  }

  /** Renders the Documents panel into a container; returns its panel lifecycle hooks. */
  function renderDocuments(container: HTMLElement): CodePadPanelInstance {
    container.classList.add('cp-docs');
    const list = document.createElement('div');
    list.className = 'cp-docs-list';
    container.appendChild(list);

    function refresh(): void {
      const active = app().tabs.active();
      const rows = app().tabs.list().map((tab) => {
        const row = document.createElement('div');
        row.className = 'cp-doc-row';
        if (tab === active) {
          row.classList.add('active');
        }
        if (persistable(tab) && tab.persist.color > 0) {
          row.classList.add(`cp-tabcolor-${tab.persist.color}`);
        }
        row.title = CodePadSearchCore.displayName(tab.path || tab.name);
        const marks = [];
        if (isPinned(tab)) {
          marks.push('◆');
        }
        if (tab.dirty) {
          marks.push('●');
        }
        if (persistable(tab) && tab.persist.readOnly) {
          marks.push('R');
        }
        const mark = document.createElement('span');
        mark.className = 'cp-doc-mark';
        mark.textContent = marks.join(' ');
        const name = document.createElement('span');
        name.className = 'cp-doc-name';
        name.textContent = CodePadSearchCore.displayName(tab.name);
        row.append(mark, name);
        row.addEventListener('click', () => app().tabs.activate(tab));
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          showMenu(tab, event);
        });
        attachDrag(row, tab);
        return row;
      });
      list.replaceChildren(...rows);
    }

    refreshDocuments = refresh;
    refresh();
    return {
      onShow: refresh,
      dispose() {
        refreshDocuments = () => {};
      },
    };
  }

  /** Registers a command whose run() receives the active tab (and reports when there is none). */
  function registerTabCommand(id: string, action: (tab: CodePadTab) => unknown): void {
    CodePadCommands.register({
      id,
      async run() {
        const tab = requireActive();
        if (tab) {
          await action(tab);
        }
      },
    });
  }

  registerTabCommand('tabs.closeOthers', (tab) => closeUnpinned(app().tabs.list().filter((other) => other !== tab)));
  registerTabCommand('tabs.closeLeft', (tab) => closeRelative(tab, -1));
  registerTabCommand('tabs.closeRight', (tab) => closeRelative(tab, 1));
  registerTabCommand('tabs.closeUnchanged', () => closeUnpinned(app().tabs.list().filter((tab) => !tab.dirty)));
  registerTabCommand('tabs.closeAllButPinned', () => closeUnpinned(app().tabs.list()));
  registerTabCommand('tabs.pin', togglePin);
  registerTabCommand('tabs.colorNone', (tab) => setColor(tab, 0));
  for (let color = 1; color < COLOR_NAMES.length; color += 1) {
    registerTabCommand(`tabs.color${color}`, (tab) => setColor(tab, color));
  }
  registerTabCommand('tabs.moveLeft', (tab) => moveBy(tab, -1));
  registerTabCommand('tabs.moveRight', (tab) => moveBy(tab, 1));
  registerTabCommand('tabs.moveStart', (tab) => moveTo(tab, 0));
  registerTabCommand('tabs.moveEnd', (tab) => moveTo(tab, Number.MAX_SAFE_INTEGER));
  registerTabCommand('tabs.copyPath', copyPath);
  registerTabCommand('tabs.copyName', copyName);
  registerTabCommand('tabs.copyDir', copyDir);
  registerTabCommand('tabs.reveal', revealTab);

  CodePadCommands.register({
    id: 'tabs.closeAll',
    async run() {
      await closeAll();
    },
  });
  CodePadCommands.register({
    id: 'tabs.restoreClosed',
    run() {
      return restoreClosed();
    },
  });
  for (let n = 1; n <= 9; n += 1) {
    CodePadCommands.register({
      id: `tabs.goto${n}`,
      run(ctx) {
        const list = ctx.tabs.list();
        const tab = n === 9 ? list[list.length - 1] : list[n - 1];
        if (tab) {
          ctx.tabs.activate(tab);
        }
      },
    });
  }

  CodePadFeatures.register('tabs', {
    init(ctx) {
      appCtx = ctx;
      ctx.tabs.decorate(decorate);
      ctx.tabs.onContextMenu((tab, event) => showMenu(tab, event));
      ctx.tabs.interceptClose((tab) => {
        if (isPinned(tab) && !forceClosing) {
          ctx.status.set('This tab is pinned. Unpin it to close it.');
          return false;
        }
        return true;
      });
      ctx.events.on('tab:closing', rememberClosed);
      (['tab:created', 'tab:restored', 'tab:activated', 'tab:closed', 'tab:dirty', 'tab:reordered', 'tab:pathChanged', 'tab:saved'] as const)
        .forEach((name) => ctx.events.on(name, () => refreshDocuments()));
      ctx.panels.register({
        id: 'documents',
        title: 'Documents',
        location: 'left',
        order: 20,
        render: renderDocuments,
      });
    },
  });
})();
