/**
 * Named sessions: save the open tabs under a name, load or delete them later.
 * Sessions live in the main process (sessions:* IPC); the renderer only ever handles generated ids.
 */
(() => {
  const NAME_MAX = 60;

  let appCtx: CodePadCtx | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The sessions feature is not initialized.');
    }
    return appCtx;
  }

  const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

  /** Lets the user choose one saved session; resolves its id or null. */
  async function pickSession(title: string): Promise<string | null> {
    const sessions = await window.codepad.sessions.list();
    if (sessions.length === 0) {
      app().status.set('No saved sessions.');
      return null;
    }
    const id = await app().ui.pick({
      title,
      items: sessions.map((session) => ({
        label: session.name,
        detail: `${new Date(session.savedAt).toLocaleString()} - ${session.tabCount} tab${session.tabCount === 1 ? '' : 's'}`,
        value: session.id,
      })),
    });
    return id || null;
  }

  async function saveSession(): Promise<void> {
    const entered = await app().ui.prompt({ title: 'Save Session', label: 'Session name', value: '' });
    const name = entered ? entered.trim().slice(0, NAME_MAX) : '';
    if (!name) {
      return;
    }
    const existing = await window.codepad.sessions.list();
    if (existing.some((session) => session.name.toLowerCase() === name.toLowerCase())) {
      const choice = await app().ui.confirm({
        title: 'Save Session',
        message: `A session named "${name}" already exists. Replace it?`,
        buttons: ['Replace', 'Cancel'],
      });
      if (choice !== 0) {
        return;
      }
    }
    const snapshot = await app().session.snapshot();
    await window.codepad.sessions.save(name, snapshot);
    app().status.set(`Session "${name}" saved.`);
  }

  async function loadSession(): Promise<void> {
    const id = await pickSession('Load Session');
    if (!id) {
      return;
    }
    const unsaved = app().tabs.list().filter((tab) => tab.dirty).length;
    if (unsaved > 0) {
      const choice = await app().ui.confirm({
        title: 'Load Session',
        message: `Loading a session closes the open tabs. ${unsaved} tab${unsaved === 1 ? ' has' : 's have'} unsaved changes that will be lost.`,
        buttons: ['Load Session', 'Cancel'],
      });
      if (choice !== 0) {
        return;
      }
    }
    const session = await window.codepad.sessions.load(id);
    if (!session) {
      app().status.set('That session could not be loaded.');
      return;
    }
    await app().session.restore(session, { replace: true });
    app().status.set(session.integrity === 'failed'
      ? 'Session integrity check failed: file paths were not restored, only untitled text.'
      : 'Session loaded.');
  }

  async function deleteSession(): Promise<void> {
    const id = await pickSession('Delete Session');
    if (!id) {
      return;
    }
    const choice = await app().ui.confirm({
      title: 'Delete Session',
      message: 'Delete this saved session? This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
    });
    if (choice !== 0) {
      return;
    }
    await window.codepad.sessions.delete(id);
    app().status.set('Session deleted.');
  }

  /** Runs a session action and reports failures in the status bar. */
  function guarded(action: () => Promise<void>): () => Promise<void> {
    return async () => {
      try {
        await action();
      } catch (error) {
        app().status.set(`Session error: ${messageOf(error)}`);
      }
    };
  }

  CodePadCommands.register({ id: 'sessions.save', run: guarded(saveSession) });
  CodePadCommands.register({ id: 'sessions.load', run: guarded(loadSession) });
  CodePadCommands.register({ id: 'sessions.delete', run: guarded(deleteSession) });

  CodePadFeatures.register('sessions', {
    init(ctx) {
      appCtx = ctx;
    },
  });
})();
