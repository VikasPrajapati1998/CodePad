/**
 * Command registry. Menu structure, titles and default accelerators live in the static tables loaded by the main
 * process (shared/commands/*.commands.ts); the renderer registers only the run() handlers here. Main sends
 * `command` events with ids from its own table and app.ts forwards them to `execute`.
 */
(() => {
  const NOT_AVAILABLE_MESSAGE = 'Not available for this file type.';

  const registry = new Map<string, CodePadCommandDefinition>();
  /** Table entries sent by main (id -> {title, menu, accelerator, when, palette}). */
  let table = new Map<string, CpCommandInfo>();
  const executeListeners = new Set<(command: CodePadExecutedCommand) => void>();
  let context: CodePadCtx | null = null;
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  const paletteActions = new Map<string, monaco.IDisposable>();

  const lastSegment = (menu: string): string => menu.split('/').pop() ?? menu;

  function titleOf(id: string): string {
    const def = registry.get(id);
    const entry = table.get(id);
    return (entry && entry.title) || (def && def.title) || id;
  }

  function categoryOf(id: string): string {
    const def = registry.get(id);
    const entry = table.get(id);
    if (entry && entry.menu) {
      return lastSegment(entry.menu);
    }
    return (def && def.category) || id.split('.')[0].replace(/^./, (c) => c.toUpperCase());
  }

  function whenOf(id: string): 'text' | 'any' {
    const def = registry.get(id);
    const entry = table.get(id);
    if (entry) {
      return entry.when;
    }
    return (def && def.when) || 'any';
  }

  const isPalette = (id: string): boolean => {
    const entry = table.get(id);
    return entry ? entry.palette !== false : true;
  };

  function addPaletteAction(id: string): void {
    if (!editor || paletteActions.has(id) || !registry.has(id) || !isPalette(id)) {
      return;
    }
    paletteActions.set(
      id,
      editor.addAction({
        id: `cp.${id}`,
        label: `${categoryOf(id)}: ${titleOf(id)}`,
        keybindings: [],
        run: () => execute(id),
      }),
    );
  }

  /**
   * Registers a command handler.
   * @param definition `title`/`category`/`when` are only needed when the id is not in the static table
   *   (palette-only commands).
   * @throws {Error} on a duplicate id.
   */
  function register(definition: CodePadCommandDefinition): void {
    if (!definition || typeof definition.id !== 'string' || typeof definition.run !== 'function') {
      throw new TypeError('CodePadCommands.register needs an id and a run() function.');
    }
    if (registry.has(definition.id)) {
      throw new Error(`Command "${definition.id}" is already registered.`);
    }
    registry.set(definition.id, definition);
    addPaletteAction(definition.id);
  }

  /** Runs a command by id. Never rejects: failures are shown in the status bar. */
  async function execute(id: string, args?: CodePadCommandArgs): Promise<void> {
    const def = registry.get(id);
    if (!def || !context) {
      if (context) {
        context.status.set(`Unknown command: ${id}`);
      }
      return;
    }
    try {
      if (whenOf(id) === 'text') {
        const tab = context.tabs.active();
        if (!tab || tab.kind !== 'text') {
          context.status.set(NOT_AVAILABLE_MESSAGE);
          return;
        }
      }
      if (typeof def.enabled === 'function' && !def.enabled(context)) {
        return;
      }
      await def.run(context, args);
    } catch (error) {
      console.error(`Command ${id} failed:`, error);
      context.status.set(error instanceof Error && error.message ? error.message : `Command ${id} failed.`);
      return;
    }
    executeListeners.forEach((callback) => {
      try {
        callback({ id, args });
      } catch (error) {
        console.error('Command listener failed:', error);
      }
    });
  }

  /** All registered commands: [{id, title, category, accelerator, when}]. */
  function list(): CodePadCommandInfo[] {
    return [...registry.keys()].map((id) => ({
      id,
      title: titleOf(id),
      category: categoryOf(id),
      accelerator: table.get(id)?.accelerator || '',
      when: whenOf(id),
    }));
  }

  /** Subscribes to finished commands (used by the macro recorder); returns an unsubscribe function. */
  function onExecute(callback: (command: CodePadExecutedCommand) => void): () => boolean {
    executeListeners.add(callback);
    return () => executeListeners.delete(callback);
  }

  /** Called by app.ts: the command table from main (titles, shortcuts, `when`). */
  function setTable(entries: CpCommandInfo[]): void {
    table = new Map(entries.map((entry) => [entry.id, entry]));
  }

  /** Called by app.ts once the ctx exists. */
  function bindContext(ctx: CodePadCtx): void {
    context = ctx;
  }

  /** Called by app.ts when the editor exists: every registered command becomes a command-palette entry. */
  function attachEditor(monacoEditor: monaco.editor.IStandaloneCodeEditor): void {
    editor = monacoEditor;
    registry.forEach((_def, id) => addPaletteAction(id));
  }

  window.CodePadCommands = Object.freeze({
    register,
    execute,
    list,
    onExecute,
    internal: Object.freeze({ setTable, bindContext, attachEditor }),
  });
})();
