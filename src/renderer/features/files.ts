/**
 * File lifecycle features: reload from disk, external-change detection with a prompt banner,
 * monitoring (tail -f), auto-save and recent files.
 * Disk access goes through ctx.files / ctx.tabs only; paths come from tabs and from the recent list.
 */
(() => {
  const UNICODE_ENCODINGS = new Set(['utf8', 'utf8bom', 'utf16le', 'utf16be']);

  /** A tab that maps to a file on disk and can be watched. */
  type FileTab = (CodePadTextTab | CodePadDocumentTab) & { path: string };

  /** A pending disk-change notice for a tab. */
  type Banner = { kind: 'deleted' } | { kind: 'changed'; mtimeMs: number };

  interface TabState {
    banner: Banner | null;
    dismissedMtime: number | null;
    busy: boolean;
    prevReadOnly: boolean;
  }

  let appCtx: CodePadCtx | null = null;
  let bar: HTMLElement | null = null;

  /** The context given to `init`; commands and events only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The files feature is not initialized.');
    }
    return appCtx;
  }

  /** The banner element created by `init`. */
  function barEl(): HTMLElement {
    if (!bar) {
      throw new Error('The files feature is not initialized.');
    }
    return bar;
  }
  /** Paths for which the main process confirmed a watcher. */
  const watched = new Set<string>();
  /** Per-tab private state: banner, dismissed mtime, reload guard, read-only before monitoring. */
  const states = new WeakMap<CodePadTab, TabState>();
  /** Pending auto-save timers. */
  const saveTimers = new Map<CodePadTab, number>();
  /** Tab that was active before the latest activation (for focus-loss auto-save). */
  let previousTab: CodePadTab | null = null;

  function stateOf(tab: CodePadTab): TabState {
    let state = states.get(tab);
    if (!state) {
      state = { banner: null, dismissedMtime: null, busy: false, prevReadOnly: false };
      states.set(tab, state);
    }
    return state;
  }

  const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

  /** True for tabs that map to a file on disk and can be watched. */
  const hasFile = (tab: CodePadTab | null | undefined): tab is FileTab =>
    Boolean(tab && tab.path && tab.kind !== 'diff');

  const isMonitoring = (tab: CodePadTab | null | undefined): boolean => Boolean(tab && tab.persist && tab.persist.monitor);

  // ---------------------------------------------------------------------------------- banner

  function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-files-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function clearBanner(tab: CodePadTab): void {
    stateOf(tab).banner = null;
    renderBanner();
  }

  /** Shows the pending banner of the active tab, or hides the bar. */
  function renderBanner(): void {
    const bar = barEl();
    const tab = app().tabs.active();
    const banner = tab ? stateOf(tab).banner : null;
    if (!tab || !banner) {
      bar.classList.add('hidden');
      bar.replaceChildren();
      return;
    }
    const message = document.createElement('span');
    message.className = 'cp-files-message';
    const buttons: HTMLButtonElement[] = [];
    if (banner.kind === 'deleted') {
      message.textContent = `${tab.name} was deleted from disk.`;
      buttons.push(
        makeButton('Keep open', () => clearBanner(tab)),
        makeButton('Close', () => {
          app().tabs.close(tab, { force: false }).then(renderBanner);
        }),
      );
    } else {
      message.textContent = `${tab.name} changed on disk.`;
      buttons.push(
        makeButton('Reload', () => {
          reloadTab(tab);
        }),
        makeButton('Keep mine', () => {
          stateOf(tab).dismissedMtime = banner.mtimeMs;
          clearBanner(tab);
        }),
      );
      if (tab.kind === 'text') {
        buttons.push(makeButton('Compare', () => {
          app().commands.execute('compare.withDisk');
        }));
      }
    }
    bar.replaceChildren(message, ...buttons);
    bar.classList.remove('hidden');
  }

  // ------------------------------------------------------------------------------ reload/watch

  /** Re-reads a tab from disk (asks first when dirty); resolves true when it was reloaded. */
  async function reloadTab(tab: CodePadTab): Promise<boolean> {
    const state = stateOf(tab);
    if (state.busy) {
      return false;
    }
    state.busy = true;
    try {
      const ok = await app().tabs.reload(tab, {});
      if (ok) {
        state.banner = null;
        state.dismissedMtime = null;
      }
      return ok;
    } catch (error) {
      app().status.set(`Could not reload ${tab.name}: ${messageOf(error)}`);
      return false;
    } finally {
      state.busy = false;
      renderBanner();
    }
  }

  /** Silent reload used for clean tabs and monitoring; follows the end of the file when it was at the end. */
  async function reloadSilently(tab: CodePadTab): Promise<void> {
    const follow = isMonitoring(tab) && tab.kind === 'text' && app().tabs.active() === tab
      && tab.model && (app().editor.getPosition()?.lineNumber ?? 0) >= tab.model.getLineCount();
    if (await reloadTab(tab)) {
      if (follow && app().tabs.active() === tab && tab.kind === 'text') {
        const last = tab.model.getLineCount();
        app().editor.setPosition({ lineNumber: last, column: tab.model.getLineMaxColumn(last) });
        app().editor.revealLine(last);
      }
      if (!isMonitoring(tab)) {
        app().status.set(`Reloaded ${tab.name} (changed on disk).`);
      }
    }
  }

  /**
   * Applies one disk event to the tab that owns the path.
   * @param tab Open tab.
   * @param kind Event kind.
   * @param mtimeMs Modification time after the change.
   * @param size File size after the change.
   */
  function handleDiskEvent(tab: FileTab, kind: CpWatchEvent['kind'], mtimeMs: number, size: number): void {
    const state = stateOf(tab);
    if (kind !== 'changed') {
      if (!state.banner || state.banner.kind !== 'deleted') {
        state.banner = { kind: 'deleted' };
        if (tab.kind === 'text') {
          app().tabs.forceDirty(tab);
        }
      }
      renderBanner();
      return;
    }
    const known = tab.diskStat;
    if (known && known.mtimeMs === mtimeMs && known.size === size) {
      if (state.banner && state.banner.kind === 'changed') {
        clearBanner(tab);
      }
      return;
    }
    if (state.dismissedMtime === mtimeMs || (state.banner && state.banner.kind === 'changed' && state.banner.mtimeMs === mtimeMs)) {
      return;
    }
    if (!tab.dirty) {
      reloadSilently(tab);
      return;
    }
    state.banner = { kind: 'changed', mtimeMs };
    renderBanner();
  }

  function onChangedOnDisk(event: CpWatchEvent): void {
    if (!event || typeof event.path !== 'string') {
      return;
    }
    app().tabs.list()
      .filter((tab): tab is FileTab => hasFile(tab) && tab.path === event.path)
      .forEach((tab) => handleDiskEvent(tab, event.kind, event.mtimeMs, event.size));
  }

  /** Stat fallback for tabs without a watcher and for tabs that still show a banner. */
  async function checkStat(tab: FileTab): Promise<void> {
    try {
      const stat = await app().files.stat(tab.path);
      if (!stat.exists) {
        handleDiskEvent(tab, 'deleted', 0, 0);
      } else {
        handleDiskEvent(tab, 'changed', stat.mtimeMs, stat.size);
      }
    } catch (error) {
      app().status.set(`Could not check ${tab.name}: ${messageOf(error)}`);
    }
  }

  function onWindowFocus(): void {
    const watching = app().settings.get('files.watch');
    app().tabs.list().forEach((tab) => {
      if (!hasFile(tab)) {
        return;
      }
      const state = stateOf(tab);
      if (state.banner || ((watching || isMonitoring(tab)) && !watched.has(tab.path))) {
        checkStat(tab);
      }
    });
  }

  const wantsWatch = (tab: CodePadTab | null | undefined): tab is FileTab => hasFile(tab) && (app().settings.get('files.watch') || isMonitoring(tab));

  async function watchTab(tab: CodePadTab): Promise<void> {
    if (!wantsWatch(tab) || watched.has(tab.path)) {
      return;
    }
    try {
      const result = await app().files.watch(tab.path);
      if (result.ok) {
        watched.add(tab.path);
      }
    } catch (error) {
      app().status.set(`Could not watch ${tab.name}: ${messageOf(error)}`);
    }
  }

  function unwatchPath(filePath: string | null): void {
    if (!filePath || !watched.has(filePath)) {
      return;
    }
    const stillWanted = app().tabs.list().some((tab) => wantsWatch(tab) && tab.path === filePath);
    if (!stillWanted) {
      watched.delete(filePath);
      app().files.unwatch(filePath);
    }
  }

  /** Brings watchers in line with the files.watch setting and the open tabs. */
  function syncWatchers(): void {
    [...watched].forEach(unwatchPath);
    app().tabs.list().forEach(watchTab);
  }

  // ------------------------------------------------------------------------------- monitoring

  function applyReadOnly(tab: CodePadTab): void {
    if (tab.kind === 'text' && app().tabs.active() === tab) {
      app().editor.updateOptions({ readOnly: Boolean(tab.persist.readOnly) });
    }
  }

  /** Turns monitoring on or off for a tab, forcing read-only while it is on. */
  function setMonitor(tab: CodePadTextTab, on: boolean): void {
    const state = stateOf(tab);
    if (on) {
      state.prevReadOnly = Boolean(tab.persist.readOnly);
      tab.persist.readOnly = true;
    } else {
      tab.persist.readOnly = state.prevReadOnly;
    }
    tab.persist.monitor = on;
    app().tabs.changed();
    applyReadOnly(tab);
    if (on) {
      watchTab(tab);
    } else {
      unwatchPath(tab.path);
    }
    app().status.set(on ? `Monitoring ${tab.name} (read-only).` : `Stopped monitoring ${tab.name}.`);
  }

  function toggleMonitor(): void {
    const tab = app().tabs.active();
    if (!tab || tab.kind !== 'text' || !tab.path) {
      app().status.set('Monitoring needs a text file that is saved on disk.');
      return;
    }
    setMonitor(tab, !isMonitoring(tab));
  }

  /** Re-applies monitoring (read-only + watch) for a tab restored from a session. */
  function resumeMonitor(tab: CodePadTab): void {
    if (tab.persist && tab.persist.monitor) {
      tab.persist.readOnly = true;
      applyReadOnly(tab);
      watchTab(tab);
    }
  }

  // --------------------------------------------------------------------------------- auto-save

  async function canAutoSave(tab: CodePadTab | null): Promise<boolean> {
    if (!tab || tab.kind !== 'text' || !tab.path || !tab.dirty || !tab.model || isMonitoring(tab)) {
      return false;
    }
    if (stateOf(tab).banner) {
      return false;
    }
    if (tab.encoding && !UNICODE_ENCODINGS.has(tab.encoding)) {
      try {
        const check = await window.codepad.encodings.check(tab.model.getValue(), tab.encoding);
        if (check.lossy) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  async function autoSave(tab: CodePadTab | null): Promise<void> {
    if (tab && (await canAutoSave(tab))) {
      try {
        await app().tabs.save(tab);
      } catch (error) {
        app().status.set(`Auto-save failed for ${tab.name}: ${messageOf(error)}`);
      }
    }
  }

  function cancelTimer(tab: CodePadTab): void {
    clearTimeout(saveTimers.get(tab));
    saveTimers.delete(tab);
  }

  function clearAllTimers(): void {
    saveTimers.forEach((timer) => clearTimeout(timer));
    saveTimers.clear();
  }

  function scheduleAutoSave(tab: CodePadTab | null): void {
    if (!tab || app().settings.get('autosave.mode') !== 'afterDelay') {
      return;
    }
    cancelTimer(tab);
    saveTimers.set(tab, setTimeout(() => {
      saveTimers.delete(tab);
      autoSave(tab);
    }, app().settings.get('autosave.delayMs')));
  }

  function saveAllOnFocusLoss(): void {
    if (app().settings.get('autosave.mode') === 'onFocusLoss') {
      app().tabs.list().forEach(autoSave);
    }
  }

  // ------------------------------------------------------------------------------------ recent

  function addRecent(tab: CodePadTab): void {
    if (hasFile(tab)) {
      Promise.resolve(app().files.recent.add(tab.path)).catch(() => {});
    }
  }

  /** Reads the recent list and approves the selected entries; returns their paths. */
  async function approveRecent(indexes: number[]): Promise<string[]> {
    const paths: string[] = [];
    for (const index of indexes) {
      paths.push(await app().files.recent.approveAt(index));
    }
    return paths;
  }

  async function openRecent(): Promise<void> {
    const items = await app().files.recent.list();
    if (items.length === 0) {
      app().status.set('No recent files.');
      return;
    }
    const index = await app().ui.pick({
      title: 'Open Recent File',
      items: items.map((item, i) => ({ label: item.name, detail: item.path, value: i })),
    });
    if (index === null || index === undefined) {
      return;
    }
    const [filePath] = await approveRecent([index]);
    await app().tabs.openPath(filePath, {});
  }

  async function openAllRecent(): Promise<void> {
    const items = await app().files.recent.list();
    if (items.length === 0) {
      app().status.set('No recent files.');
      return;
    }
    const paths = await approveRecent(items.map((_, index) => index));
    for (const filePath of paths) {
      await app().tabs.openPath(filePath, {});
    }
  }

  async function clearRecent(): Promise<void> {
    await app().files.recent.clear();
    app().status.set('Recent files cleared.');
  }

  // -------------------------------------------------------------------------------- registration

  CodePadCommands.register({
    id: 'files.reload',
    async run() {
      const tab = app().tabs.active();
      if (!hasFile(tab)) {
        app().status.set('Only files saved on disk can be reloaded.');
        return;
      }
      await reloadTab(tab);
    },
  });
  CodePadCommands.register({ id: 'files.monitor', run: toggleMonitor });
  CodePadCommands.register({ id: 'files.openRecent', run: openRecent });
  CodePadCommands.register({ id: 'files.openAllRecent', run: openAllRecent });
  CodePadCommands.register({ id: 'files.clearRecent', run: clearRecent });

  CodePadFeatures.register('files', {
    init(ctx) {
      appCtx = ctx;
      bar = document.createElement('div');
      bar.className = 'cp-files-banner hidden';
      document.getElementById('tabs')?.after(bar);

      const { events } = ctx;
      events.on('file:changedOnDisk', onChangedOnDisk);
      events.on('tab:created', (tab) => {
        watchTab(tab);
        addRecent(tab);
        resumeMonitor(tab);
      });
      events.on('tab:restored', resumeMonitor);
      events.on('tab:pathChanged', (tab, oldPath) => {
        unwatchPath(oldPath);
        watchTab(tab);
        clearBanner(tab);
      });
      events.on('tab:closed', (tab) => {
        cancelTimer(tab);
        unwatchPath(tab.path);
      });
      events.on('tab:saved', (tab) => {
        const state = stateOf(tab);
        state.banner = null;
        state.dismissedMtime = null;
        cancelTimer(tab);
        addRecent(tab);
        renderBanner();
      });
      events.on('tab:reloaded', (tab) => {
        stateOf(tab).banner = null;
        renderBanner();
      });
      events.on('tab:activated', (tab) => {
        if (previousTab && previousTab !== tab && ctx.settings.get('autosave.mode') === 'onFocusLoss') {
          autoSave(previousTab);
        }
        previousTab = tab;
        renderBanner();
      });
      events.on('settings:changed', ({ key }) => {
        if (key === 'files.watch') {
          syncWatchers();
        } else if (key === 'autosave.mode' && ctx.settings.get('autosave.mode') !== 'afterDelay') {
          clearAllTimers();
        }
      });

      // One editor exists today; a later split view would subscribe per editor from editor:created.
      ctx.editor.onDidChangeModelContent(() => scheduleAutoSave(ctx.tabs.active()));
      window.addEventListener('blur', saveAllOnFocusLoss);
      window.addEventListener('focus', onWindowFocus);
    },
  });
})();
