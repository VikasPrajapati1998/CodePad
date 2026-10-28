/**
 * Macros: record typed text, navigation/edit keys and CodePad commands, play them back
 * (once, N times or until the end of the file) and save them by name through the macros:* IPC.
 * Macros are plain data: the main process only stores them and never executes anything.
 */
(() => {
  const STEP_LIMIT = 5000;
  const TYPE_TEXT_LIMIT = 10000;
  const ARGS_LIMIT = 1024;
  const NAME_LIMIT = 60;
  const MAX_REPEAT = 100000;
  const RUN_TO_END_LIMIT = 1e6;
  const YIELD_AFTER_MS = 30;
  const CURRENT_NAME = 'Current Macro';
  /** Commands that must never be recorded (macro control, file/tab handling, folder search). */
  const EXCLUDED_PREFIXES = ['macro.', 'file.', 'files.', 'tabs.', 'sessions.', 'compare.', 'search.findInFiles'];

  // Key name -> Monaco command id. This closed table is both the recordable set and the playback map.
  const KEY_COMMANDS: Record<string, string | null> = {};
  const keyRows: Array<[string, string, string | null]> = [
    ['left', 'cursorLeft', 'cursorWordLeft'],
    ['right', 'cursorRight', 'cursorWordRight'],
    ['up', 'cursorUp', null],
    ['down', 'cursorDown', null],
    ['home', 'cursorHome', 'cursorTop'],
    ['end', 'cursorEnd', 'cursorBottom'],
    ['pageUp', 'cursorPageUp', null],
    ['pageDown', 'cursorPageDown', null],
  ];
  keyRows.forEach(([name, plain, withCtrl]) => {
    KEY_COMMANDS[name] = plain;
    KEY_COMMANDS[`shift+${name}`] = `${plain}Select`;
    if (withCtrl) {
      KEY_COMMANDS[`ctrl+${name}`] = withCtrl;
      KEY_COMMANDS[`ctrl+shift+${name}`] = `${withCtrl}Select`;
    }
  });
  Object.assign(KEY_COMMANDS, {
    backspace: 'deleteLeft',
    'ctrl+backspace': 'deleteWordLeft',
    delete: 'deleteRight',
    'ctrl+delete': 'deleteWordRight',
    tab: 'tab',
    'shift+tab': 'outdent',
    enter: null, // played back as a typed line break
  });

  let appCtx: CodePadCtx | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The macros feature is not initialized.');
    }
    return appCtx;
  }

  let recording = false;
  let playing = false;
  let cancelRequested = false;
  /** Steps of the macro being recorded. */
  let steps: CpMacroStep[] = [];
  /** The last recorded (or last run) macro; memory only. */
  let current: CpMacro | null = null;
  let recBadge: HTMLElement | null = null;
  /** Monaco KeyCode -> macro key name. */
  const keyNames = new Map<number, string>();

  const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

  // ----------------------------------------------------------------------------------- recording

  function pushStep(step: CpMacroStep): void {
    if (steps.length >= STEP_LIMIT) {
      stopRecording();
      app().status.set(`Recording stopped: a macro holds at most ${STEP_LIMIT} steps.`);
      return;
    }
    steps.push(step);
  }

  function recordTyped(text: string): void {
    if (!recording || playing || text === '\n' || text === '\r\n') {
      return;
    }
    const last = steps[steps.length - 1];
    if (last && last.t === 'type' && last.text.length + text.length <= TYPE_TEXT_LIMIT) {
      last.text += text;
    } else {
      pushStep({ t: 'type', text });
    }
  }

  function recordKey(event: monaco.IKeyboardEvent): void {
    if (!recording || playing) {
      return;
    }
    const mac = app().app.platform === 'darwin';
    // Alt (non-mac) and Meta/Ctrl (mac) combinations are application shortcuts, not edit keys.
    if (event.metaKey || (mac ? event.ctrlKey : event.altKey)) {
      return;
    }
    const base = keyNames.get(event.keyCode);
    if (!base) {
      return;
    }
    const word = mac ? event.altKey : event.ctrlKey;
    const name = `${word ? 'ctrl+' : ''}${event.shiftKey ? 'shift+' : ''}${base}`;
    if (name in KEY_COMMANDS) {
      pushStep({ t: 'key', key: name });
    }
  }

  /** True when a command may be part of a macro: not excluded, a known text command (checked again at playback, R-04). */
  function isMacroCommand(id: string): boolean {
    if (EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      return false;
    }
    const entry = app().commands.list().find((command) => command.id === id);
    return entry !== undefined && (entry.when || 'text') === 'text';
  }

  /** The step's args as plain JSON data within the size limit, or null when they are not (undefined args stay undefined). */
  function plainArgs(args: unknown): Record<string, unknown> | undefined | null {
    if (args === undefined || args === null) {
      return undefined;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(args);
    } catch {
      return null;
    }
    if (typeof json !== 'string' || json.length > ARGS_LIMIT) {
      return null;
    }
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  }

  function recordCommand({ id, args }: CodePadExecutedCommand): void {
    if (!recording || playing || !isMacroCommand(id)) {
      return;
    }
    const step: Extract<CpMacroStep, { t: 'cmd' }> = { t: 'cmd', id };
    const plain = plainArgs(args);
    if (plain === null) {
      return;
    }
    if (plain !== undefined) {
      step.args = plain;
    }
    pushStep(step);
  }

  function setRecording(on: boolean): void {
    recording = on;
    if (!recBadge) {
      return;
    }
    recBadge.classList.toggle('hidden', !on);
  }

  function startRecording(): void {
    if (playing) {
      app().status.set('Wait for the macro to finish playing.');
      return;
    }
    steps = [];
    setRecording(true);
    app().status.set('Recording macro... press the record shortcut again to stop.');
  }

  function stopRecording(): void {
    if (!recording) {
      return;
    }
    setRecording(false);
    if (steps.length === 0) {
      app().status.set('Nothing was recorded.');
      return;
    }
    current = { name: CURRENT_NAME, steps };
    app().status.set(`Macro recorded: ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
  }

  // ------------------------------------------------------------------------------------ playback

  function onPlaybackKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      cancelRequested = true;
    }
  }

  /** Runs every step once on the active editor; resolves false when playback must stop. */
  async function runOnce(macroSteps: CpMacroStep[], tab: CodePadTab, clock: { last: number }): Promise<boolean> {
    for (const step of macroSteps) {
      if (cancelRequested || app().tabs.active() !== tab) {
        return false;
      }
      const editor = app().editor;
      if (step.t === 'type') {
        editor.trigger('macro', 'type', { text: step.text });
      } else if (step.t === 'key') {
        const command = KEY_COMMANDS[step.key];
        if (command === null) {
          editor.trigger('macro', 'type', { text: '\n' });
        } else if (command) {
          editor.trigger('macro', command, null);
        }
      } else if (step.t === 'cmd') {
        // A saved or shared macro is untrusted data: the record-time rules apply again here.
        const args = plainArgs(step.args);
        if (args === null || !isMacroCommand(step.id)) {
          app().status.set(`Macro stopped: the command "${step.id}" is not allowed in macros.`);
          return false;
        }
        await app().commands.execute(step.id, args);
      }
      if (performance.now() - clock.last > YIELD_AFTER_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        clock.last = performance.now();
      }
    }
    return true;
  }

  /**
   * Plays a macro on the active text tab as a single undo step.
   * @param macroSteps Steps to run.
   * @param mode Repeat count, or repeat until the end of the file.
   */
  async function play(macroSteps: CpMacroStep[], mode: { times?: number; toEnd?: boolean }): Promise<void> {
    const tab = app().tabs.active();
    if (!tab || tab.kind !== 'text') {
      app().status.set('Macros play back in text tabs only.');
      return;
    }
    if (recording || playing) {
      app().status.set(recording ? 'Stop recording before playing a macro.' : 'A macro is already playing.');
      return;
    }
    playing = true;
    cancelRequested = false;
    window.addEventListener('keydown', onPlaybackKey, true);
    const clock = { last: performance.now() };
    app().editor.pushUndoStop();
    try {
      if (mode.toEnd) {
        for (let i = 0; i < RUN_TO_END_LIMIT; i += 1) {
          const before = app().editor.getPosition();
          if (!(await runOnce(macroSteps, tab, clock))) {
            break;
          }
          const after = app().editor.getPosition();
          if (!before || !after || after.equals(before) || after.lineNumber >= tab.model.getLineCount()) {
            break;
          }
        }
      } else {
        for (let i = 0; i < (mode.times ?? 0); i += 1) {
          if (!(await runOnce(macroSteps, tab, clock))) {
            break;
          }
        }
      }
    } finally {
      app().editor.pushUndoStop();
      window.removeEventListener('keydown', onPlaybackKey, true);
      playing = false;
      if (cancelRequested) {
        app().status.set('Macro playback cancelled.');
      }
    }
  }

  // ----------------------------------------------------------------------------------- commands

  function requireCurrent(): CpMacro | null {
    if (!current || current.steps.length === 0) {
      app().status.set('No macro recorded yet.');
      return null;
    }
    return current;
  }

  async function loadSaved(): Promise<CpMacro[]> {
    const list = await window.codepad.macros.get();
    return Array.isArray(list) ? list : [];
  }

  async function runMultiple(): Promise<void> {
    const macro = requireCurrent();
    if (!macro) {
      return;
    }
    const answer = await app().ui.prompt({ title: 'Run Macro Multiple Times', label: 'Number of runs', value: '2' });
    if (answer === null || answer === undefined) {
      return;
    }
    const times = Number.parseInt(answer, 10);
    if (!Number.isInteger(times) || times < 1 || times > MAX_REPEAT) {
      app().status.set(`Enter a number between 1 and ${MAX_REPEAT}.`);
      return;
    }
    await play(macro.steps, { times });
  }

  async function runSaved(): Promise<void> {
    const saved = await loadSaved();
    const choices: Array<{ label: string; detail: string; macro: CpMacro }> = [];
    if (current && current.steps.length > 0) {
      choices.push({ label: CURRENT_NAME, detail: `${current.steps.length} steps`, macro: current });
    }
    saved.forEach((macro) => choices.push({ label: macro.name, detail: `${macro.steps.length} steps`, macro }));
    if (choices.length === 0) {
      app().status.set('No macros available.');
      return;
    }
    const index = await app().ui.pick({
      title: 'Run Macro',
      items: choices.map((choice, i) => ({ label: choice.label, detail: choice.detail, value: i })),
    });
    if (index === null || index === undefined) {
      return;
    }
    current = { name: choices[index].macro.name, steps: choices[index].macro.steps };
    await play(current.steps, { times: 1 });
  }

  async function saveMacro(): Promise<void> {
    const macro = requireCurrent();
    if (!macro) {
      return;
    }
    const entered = await app().ui.prompt({ title: 'Save Macro', label: 'Macro name', value: '' });
    const name = entered ? entered.trim().slice(0, NAME_LIMIT) : '';
    if (!name) {
      return;
    }
    const saved = (await loadSaved()).filter((item) => item.name !== name);
    saved.push({ name, steps: macro.steps });
    await window.codepad.macros.set(saved);
    app().status.set(`Macro "${name}" saved.`);
  }

  async function deleteMacro(): Promise<void> {
    const saved = await loadSaved();
    if (saved.length === 0) {
      app().status.set('No saved macros.');
      return;
    }
    const index = await app().ui.pick({
      title: 'Delete Macro',
      items: saved.map((macro, i) => ({ label: macro.name, detail: `${macro.steps.length} steps`, value: i })),
    });
    if (index === null || index === undefined) {
      return;
    }
    const choice = await app().ui.confirm({
      title: 'Delete Macro',
      message: `Delete the macro "${saved[index].name}"?`,
      buttons: ['Delete', 'Cancel'],
    });
    if (choice !== 0) {
      return;
    }
    await window.codepad.macros.set(saved.filter((_, i) => i !== index));
    app().status.set('Macro deleted.');
  }

  /** Wraps an async macro action so failures land in the status bar. */
  function guarded(action: () => Promise<void>): () => Promise<void> {
    return async () => {
      try {
        await action();
      } catch (error) {
        app().status.set(`Macro error: ${messageOf(error)}`);
      }
    };
  }

  CodePadCommands.register({
    id: 'macro.toggleRecord',
    run() {
      if (recording) {
        stopRecording();
      } else {
        startRecording();
      }
    },
  });
  CodePadCommands.register({
    id: 'macro.playback',
    run: guarded(async () => {
      const macro = requireCurrent();
      if (macro) {
        await play(macro.steps, { times: 1 });
      }
    }),
  });
  CodePadCommands.register({ id: 'macro.runMultiple', run: guarded(runMultiple) });
  CodePadCommands.register({
    id: 'macro.runToEnd',
    run: guarded(async () => {
      const macro = requireCurrent();
      if (macro) {
        await play(macro.steps, { toEnd: true });
      }
    }),
  });
  CodePadCommands.register({ id: 'macro.run', run: guarded(runSaved) });
  CodePadCommands.register({ id: 'macro.save', run: guarded(saveMacro) });
  CodePadCommands.register({ id: 'macro.delete', run: guarded(deleteMacro) });

  CodePadFeatures.register('macros', {
    init(ctx) {
      appCtx = ctx;
      const { KeyCode } = ctx.monaco;
      const keyPairs: Array<[number, string]> = [
        [KeyCode.LeftArrow, 'left'], [KeyCode.RightArrow, 'right'], [KeyCode.UpArrow, 'up'], [KeyCode.DownArrow, 'down'],
        [KeyCode.Home, 'home'], [KeyCode.End, 'end'], [KeyCode.PageUp, 'pageUp'], [KeyCode.PageDown, 'pageDown'],
        [KeyCode.Backspace, 'backspace'], [KeyCode.Delete, 'delete'], [KeyCode.Enter, 'enter'], [KeyCode.Tab, 'tab'],
      ];
      keyPairs.forEach(([code, name]) => keyNames.set(code, name));

      recBadge = document.createElement('span');
      recBadge.className = 'cp-macro-rec hidden';
      recBadge.textContent = 'REC';
      document.getElementById('status-message')?.after(recBadge);

      // One editor exists today; a later split view would subscribe per editor from editor:created.
      ctx.editor.onDidType(recordTyped);
      ctx.editor.onKeyDown(recordKey);
      ctx.commands.onExecute(recordCommand);
    },
  });
})();
