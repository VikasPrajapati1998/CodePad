/**
 * Compare: side-by-side diff of two tabs, of a tab and its file on disk, or of a tab and the clipboard,
 * shown in a tab of kind 'diff' (Monaco's built-in diff editor). Nothing here writes to disk.
 */
(() => {
  const CLIPBOARD_MAX_CHARS = 5 * 1024 * 1024;

  /** Parameters `openView('diff', ...)` passes in: tab ids, or a tab and a text. */
  interface CompareParams {
    leftTabId: number;
    rightTabId?: number;
    rightText?: string;
    rightLabel?: string;
  }

  /** The diff view: the tab-kind contract plus what the next/previous/clear commands need. */
  interface CompareView extends CodePadEditorView {
    isVisible(): boolean;
    next(): void;
    previous(): void;
  }

  /** One side of the diff: the model shown, the tab it belongs to (null for temporary text), its label. */
  interface CompareSide {
    tab: CodePadTextTab | null;
    model: monaco.editor.ITextModel;
    temp: boolean;
    label: string;
  }

  let appCtx: CodePadCtx | null = null;
  /** Live diff views, used by the next/previous/clear commands. */
  const views = new Set<CompareView>();

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The compare feature is not initialized.');
    }
    return appCtx;
  }

  function button(label: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cp-compare-button';
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', onClick);
    return el;
  }

  /**
   * Builds the diff view for a 'diff' tab.
   * @param options View options from the app (container, params, callbacks).
   * @returns The view object of the tab-kind contract.
   */
  async function create(options: CodePadViewOptions): Promise<CodePadEditorView> {
    const { container, callbacks } = options;
    const params = options.params as CompareParams;
    const { monaco, tabs, events } = app();

    // Each side: the model shown, the tab it belongs to (null for temporary text), its label.
    const resolveTab = (id: number): CodePadTextTab => {
      const tab = tabs.byId(id);
      if (!tab || tab.kind !== 'text' || !tab.model) {
        throw new Error('The tab to compare is no longer open.');
      }
      return tab;
    };
    const leftTab = resolveTab(params.leftTabId);
    const sides: CompareSide[] = [{ tab: leftTab, model: leftTab.model, temp: false, label: leftTab.name }];
    if (params.rightTabId) {
      const rightTab = resolveTab(params.rightTabId);
      sides.push({ tab: rightTab, model: rightTab.model, temp: false, label: rightTab.name });
    } else {
      const model = monaco.editor.createModel(String(params.rightText), leftTab.model.getLanguageId());
      sides.push({ tab: null, model, temp: true, label: params.rightLabel || 'Compared text' });
    }

    container.classList.add('cp-compare');
    const toolbar = document.createElement('div');
    toolbar.className = 'cp-compare-toolbar';
    const labels = document.createElement('div');
    labels.className = 'cp-compare-labels';
    const leftLabel = document.createElement('span');
    const rightLabel = document.createElement('span');
    labels.append(leftLabel, rightLabel);
    const body = document.createElement('div');
    body.className = 'cp-compare-body';

    const diffEditor = monaco.editor.createDiffEditor(body, {
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      ignoreTrimWhitespace: false,
    });

    let ignoreWhitespace = false;
    let sideBySide = true;

    const applySides = () => {
      diffEditor.setModel({ original: sides[0].model, modified: sides[1].model });
      diffEditor.getModifiedEditor().updateOptions({ readOnly: sides[1].temp });
      leftLabel.textContent = sides[0].label;
      rightLabel.textContent = sides[1].label;
    };

    const statusText = () => {
      const changes = diffEditor.getLineChanges();
      if (!changes) {
        return 'Comparing...';
      }
      return changes.length === 0 ? 'No differences' : `${changes.length} difference${changes.length === 1 ? '' : 's'}`;
    };

    toolbar.append(
      button('▲ Previous', 'Previous difference', () => diffEditor.goToDiff('previous')),
      button('▼ Next', 'Next difference', () => diffEditor.goToDiff('next')),
      button('Inline', 'Switch between side-by-side and inline', (event) => {
        sideBySide = !sideBySide;
        diffEditor.updateOptions({ renderSideBySide: sideBySide });
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.textContent = sideBySide ? 'Inline' : 'Side by side';
        }
      }),
      button('Ignore whitespace', 'Ignore leading and trailing whitespace changes', (event) => {
        ignoreWhitespace = !ignoreWhitespace;
        diffEditor.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace });
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.classList.toggle('active', ignoreWhitespace);
        }
      }),
      button('Swap', 'Swap the two sides', () => {
        sides.reverse();
        applySides();
      }),
    );
    container.append(toolbar, labels, body);
    applySides();

    const subscriptions: monaco.IDisposable[] = [diffEditor.onDidUpdateDiff(() => callbacks.onChange())];
    // A compared tab that closes keeps showing its text through a temporary copy.
    subscriptions.push({
      dispose: events.on('tab:closing', (tab) => {
        if (tab.kind !== 'text') {
          return;
        }
        const affected = sides.filter((side) => side.tab === tab);
        affected.forEach((side) => {
          side.model = monaco.editor.createModel(tab.model.getValue(), tab.model.getLanguageId());
          side.temp = true;
          side.tab = null;
        });
        if (affected.length > 0) {
          applySides();
        }
      }),
    });

    const view: CompareView = {
      kind: 'diff',
      readOnly: false,
      saveMode: 'saveAs',
      saveFilters: [],
      defaultSaveName: 'compare.txt',
      isVisible: () => container.offsetParent !== null,
      next: () => diffEditor.goToDiff('next'),
      previous: () => diffEditor.goToDiff('previous'),
      getBytes() {
        return Promise.reject(new Error('A comparison cannot be saved.'));
      },
      isDirty: () => false,
      markSaved() {},
      getSessionState: () => Promise.resolve(null),
      getStatusText: statusText,
      layout: () => diffEditor.layout(),
      focus: () => diffEditor.focus(),
      dispose() {
        views.delete(view);
        subscriptions.forEach((subscription) => subscription.dispose());
        diffEditor.setModel(null);
        diffEditor.dispose();
        sides.filter((side) => side.temp).forEach((side) => side.model.dispose());
        container.replaceChildren();
      },
    };
    views.add(view);
    return view;
  }

  /** The visible diff view, or null (reports in the status bar). */
  function activeView(): CompareView | null {
    const active = app().tabs.active();
    const view = active && active.kind === 'diff' ? [...views].find((candidate) => candidate.isVisible()) : null;
    if (!view) {
      app().status.set('Open a comparison first.');
    }
    return view || null;
  }

  function activeTextTab(): CodePadTextTab | null {
    const tab = app().tabs.active();
    if (!tab || tab.kind !== 'text') {
      app().status.set('Comparing needs an active text tab.');
      return null;
    }
    return tab;
  }

  async function withTab(): Promise<void> {
    const left = activeTextTab();
    if (!left) {
      return;
    }
    const others = app().tabs.list().filter((tab) => tab !== left && tab.kind === 'text');
    if (others.length === 0) {
      app().status.set('There is no other text tab to compare with.');
      return;
    }
    const id = await app().ui.pick({
      title: `Compare ${left.name} with...`,
      items: others.map((tab) => ({ label: tab.name, detail: tab.path || 'Untitled', value: tab.id })),
    });
    const right = id ? app().tabs.byId(id) : null;
    if (right) {
      await app().tabs.openView('diff', {
        name: `Compare: ${left.name} / ${right.name}`,
        params: { leftTabId: left.id, rightTabId: right.id },
      });
    }
  }

  async function withDisk(): Promise<void> {
    const tab = activeTextTab();
    if (!tab) {
      return;
    }
    if (!tab.path) {
      app().status.set('Save the file first: there is no file on disk to compare with.');
      return;
    }
    const result = await app().files.readText(tab.path, tab.encoding ? { encoding: tab.encoding } : {});
    if (!result || typeof result.content !== 'string') {
      app().status.set('The file on disk cannot be shown as text.');
      return;
    }
    await app().tabs.openView('diff', {
      name: `Compare: ${tab.name} / disk`,
      params: { leftTabId: tab.id, rightText: result.content, rightLabel: `${tab.name} (on disk)` },
    });
  }

  async function withClipboard(): Promise<void> {
    const tab = activeTextTab();
    if (!tab) {
      return;
    }
    const text = await navigator.clipboard.readText();
    if (text.length > CLIPBOARD_MAX_CHARS) {
      app().status.set('The clipboard text is too large to compare (limit 5 MB).');
      return;
    }
    await app().tabs.openView('diff', {
      name: `Compare: ${tab.name} / clipboard`,
      params: { leftTabId: tab.id, rightText: text, rightLabel: 'Clipboard' },
    });
  }

  /** Wraps a compare action so failures land in the status bar. */
  function guarded(action: () => Promise<void>): () => Promise<void> {
    return async () => {
      try {
        await action();
      } catch (error) {
        app().status.set(`Compare failed: ${error instanceof Error && error.message ? error.message : String(error)}`);
      }
    };
  }

  CodePadEditors.register('diff', { extensions: [], create });

  CodePadCommands.register({ id: 'compare.withTab', run: guarded(withTab) });
  CodePadCommands.register({ id: 'compare.withDisk', run: guarded(withDisk) });
  CodePadCommands.register({ id: 'compare.withClipboard', run: guarded(withClipboard) });
  CodePadCommands.register({
    id: 'compare.next',
    run() {
      const view = activeView();
      if (view) {
        view.next();
      }
    },
  });
  CodePadCommands.register({
    id: 'compare.prev',
    run() {
      const view = activeView();
      if (view) {
        view.previous();
      }
    },
  });
  CodePadCommands.register({
    id: 'compare.clear',
    async run() {
      const active = app().tabs.active();
      if (activeView() && active) {
        await app().tabs.close(active, { force: true });
      }
    },
  });

  CodePadFeatures.register('compare', {
    init(ctx) {
      appCtx = ctx;
    },
  });
})();
