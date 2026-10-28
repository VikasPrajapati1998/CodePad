(function () {
  'use strict';

  // Settings dialog. The form is generated from CodePadSettingsSchema; every
  // control writes through ctx.settings immediately (validated by main) and
  // never touches storage directly. The Shortcuts page edits `keybindings`.

  /** key -> schema entry of the settings the dialog can edit. */
  type SettingsSchemaMap = Partial<Record<SettingKey, SettingsSchemaEntry>>;

  /** A generated control: its DOM node and a way to show a new value in it. */
  interface SettingControl {
    node: HTMLElement;
    update(value: unknown): void;
  }

  type SettingUpdater = (value: unknown) => void;

  interface DialogHandle {
    body: HTMLElement;
    updaters: Map<string, SettingUpdater>;
    modal: CodePadModalHandle;
  }

  type TabSizeMap = Record<string, number | string>;

  const CATEGORIES = ['Editor', 'Display', 'Files & Encoding', 'Auto-save', 'Search', 'Tabs', 'AI', 'Shortcuts', 'Clipboard'];
  const PREFIX_CATEGORY: Record<string, string> = {
    editor: 'Editor',
    files: 'Files & Encoding',
    autosave: 'Auto-save',
    search: 'Search',
    clipboard: 'Clipboard',
    tabs: 'Tabs',
    spell: 'Editor',
    ai: 'AI'
  };
  const DISPLAY_KEYS = new Set([
    'ui.theme', 'ui.sidebar', 'ui.minimap', 'editor.fontFamily', 'editor.fontSize', 'editor.lineNumbers',
    'editor.wordWrap', 'editor.renderWhitespace', 'editor.renderControlCharacters', 'editor.indentGuides',
    'editor.showEol', 'editor.wrapIndicator', 'editor.renderLineHighlight'
  ]);
  const HIDDEN_KEYS = new Set(['keybindings', 'ai.setupPrompted']);

  const LABELS: Record<string, [string, string]> = {
    'ui.theme': ['Theme', 'Colour theme of the editor and the interface.'],
    'ui.sidebar': ['Show sidebar', ''],
    'ui.minimap': ['Show minimap', ''],
    'editor.wordWrap': ['Word wrap', ''],
    'editor.fontFamily': ['Font family', 'CSS font-family list for the editor.'],
    'editor.fontSize': ['Font size', 'In pixels.'],
    'editor.lineNumbers': ['Line numbers', ''],
    'editor.tabSize': ['Tab size', 'Default number of columns per tab stop.'],
    'editor.insertSpaces': ['Insert spaces for tab', ''],
    'editor.renderWhitespace': ['Show white space', ''],
    'editor.renderControlCharacters': ['Show control characters', ''],
    'editor.indentGuides': ['Show indent guides', ''],
    'editor.showEol': ['Show end of line markers', ''],
    'editor.wrapIndicator': ['Wrapped line indentation', ''],
    'editor.emptySelectionClipboard': ['Copy line without selection', 'Copy or cut the current line when nothing is selected.'],
    'editor.mouseWheelZoom': ['Zoom with Ctrl+mouse wheel', ''],
    'editor.autoSuggest': ['Show word suggestions while typing (Ctrl+Space always works)', ''],
    'spell.enabled': ['Check spelling in plain text and Markdown', 'Underlines misspelled English words using an offline dictionary. Fix them with the light bulb or Ctrl+.'],
    'editor.tabSizeByLanguage': ['Tab size per language', 'Overrides the default tab size for a language.'],
    'files.fallbackEncoding': ['Fallback encoding', 'Used when a file is not valid UTF-8 and has no byte order mark.'],
    'files.defaultEncoding': ['Default encoding for new files', ''],
    'files.defaultEol': ['Default line ending for new files', ''],
    'files.trimTrailingOnSave': ['Trim trailing white space on save', ''],
    'files.watch': ['Watch open files for changes on disk', ''],
    'autosave.mode': ['Auto-save', ''],
    'autosave.delayMs': ['Auto-save delay (ms)', 'Used by "afterDelay".'],
    'search.defaultExcludes': ['Find in Files: excluded folders', 'Comma separated folder names.'],
    'search.maxResults': ['Find in Files: maximum results', ''],
    'search.maxFileKB': ['Find in Files: maximum file size (KB)', ''],
    'clipboard.historyEnabled': ['Keep clipboard history', 'Kept in memory only; never saved.'],
    'clipboard.historySize': ['Clipboard history size', ''],
    'ai.enabled': ['Suggest text while typing (AI ghost text)', 'Runs on this computer once the AI model is downloaded. Accept with Tab, Ctrl+Right (one word) or Right Arrow at the end of a line; Esc dismisses.'],
    'ai.autoDownload': ['Download the AI model automatically', 'Downloads and resumes the one-time model download without asking.'],
    'ai.suggestDelayMs': ['Suggestion delay (ms)', 'Pause in typing before a suggestion is requested.'],
    'ai.maxSuggestionTokens': ['Suggestion length (tokens)', 'Budget for one sentence or statement (prose gets 3x, code 2x so that it can finish). Longer suggestions take longer to appear.'],
    'ai.contextChars': ['Text before the cursor used for suggestions (characters)', ''],
    'ai.threads': ['CPU threads for the AI', '0 chooses automatically. Applies the next time the model loads.'],
    'ai.unloadAfterMinutes': ['Unload the model after idle minutes', 'Frees memory when AI is not used. 0 keeps it loaded.'],
    'ai.multiline': ['Allow multi-line suggestions', ''],
    'ai.summaryStyle': ['Summary format', 'Overview paragraph, bullet points, or both.'],
    'ai.summaryMaxChars': ['Maximum characters to summarize', 'Larger documents are refused.'],
    'ai.chunkTokens': ['Summary part size (tokens)', 'Smaller parts are faster per step but need more steps.'],
    'ai.summaryCache': ['Cache summaries', 'Summaries are cached on this computer so re-summarizing an unchanged document is instant. The cache stores only the summary text (which can contain facts from your documents), never the documents. Turn this off or use AI > Clear Summary Cache to remove it.']
  };

  const KEY_NAMES: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown',
    Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete', Tab: 'Tab', Enter: 'Enter', Space: 'Space',
    Comma: ',', Period: '.', Minus: '-', Equal: '=', Slash: '/', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: '\'', Backquote: '`'
  };

  let handle: DialogHandle | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  // ---- Schema helpers ----

  const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /** A list setting as the string array it holds ([] for anything else). */
  function asList(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
  }

  /** A per-language tab size setting as its map ({} for anything else). */
  function asMap(value: unknown): TabSizeMap {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TabSizeMap) : {};
  }

  /** Read the settings schema as a key -> entry map. */
  function readSchema(): SettingsSchemaMap {
    const source: Partial<CodePadSettingsSchemaApi> = window.CodePadSettingsSchema || {};
    const candidate: SettingsSchemaMap = source.SCHEMA || {};
    const entries: SettingsSchemaMap = {};
    (Object.keys(candidate) as SettingKey[]).forEach((key) => {
      const value = candidate[key];
      if (value && typeof value === 'object' && typeof value.type === 'string') {
        entries[key] = value;
      }
    });
    return entries;
  }

  function categoryOf(key: string): string | null {
    if (HIDDEN_KEYS.has(key)) {
      return null;
    }
    if (DISPLAY_KEYS.has(key)) {
      return 'Display';
    }
    return PREFIX_CATEGORY[key.split('.')[0]] || null;
  }

  function labelOf(key: string): string {
    if (LABELS[key]) {
      return LABELS[key][0];
    }
    const last = (key.split('.').pop() ?? '').replace(/([A-Z])/g, ' $1').toLowerCase();
    return last.charAt(0).toUpperCase() + last.slice(1);
  }

  function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function describe(value: unknown): string {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  // ---- Generic controls ----

  /**
   * Write a value through the settings API and report problems inline.
   * @param ctx Feature context.
   * @param key Setting key.
   * @param value New value.
   * @param errorEl Element receiving the message.
   * @returns True when accepted unchanged.
   */
  async function commit(ctx: CodePadCtx, key: SettingKey, value: SettingValue, errorEl: HTMLElement): Promise<boolean> {
    errorEl.textContent = '';
    try {
      // Same as ctx.settings.set(key, value): the key is only known as a SettingKey here, not as a literal.
      await ctx.settings.patch({ [key]: value } as Partial<SettingsValues>);
    } catch (error) {
      errorEl.textContent = errorMessage(error);
      return false;
    }
    const stored = ctx.settings.get(key);
    if (!sameValue(stored, value)) {
      errorEl.textContent = `Adjusted to ${describe(stored)}.`;
      return false;
    }
    return true;
  }

  function enumValues(ctx: CodePadCtx, key: SettingKey, entry: SettingsEnumEntry): { value: string; label: string }[] {
    if (key === 'ui.theme') {
      return ctx.themes.list().map((theme) => ({ value: theme.id, label: theme.label }));
    }
    return (entry.values || []).map((value) => ({ value, label: String(value) }));
  }

  function createInput(ctx: CodePadCtx, key: SettingKey, entry: SettingsSchemaEntry, errorEl: HTMLElement): SettingControl {
    const current = () => ctx.settings.get(key);
    if (entry.type === 'boolean') {
      const input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', async () => {
        if (!await commit(ctx, key, input.checked, errorEl)) {
          input.checked = Boolean(current());
        }
      });
      return { node: input, update: (value) => { input.checked = Boolean(value); } };
    }
    if (entry.type === 'enum') {
      const select = el('select');
      enumValues(ctx, key, entry).forEach(({ value, label }) => {
        const option = el('option', '', label);
        option.value = value;
        select.appendChild(option);
      });
      select.addEventListener('change', async () => {
        if (!await commit(ctx, key, select.value, errorEl)) {
          select.value = String(current());
        }
      });
      return { node: select, update: (value) => { select.value = String(value); } };
    }
    if (entry.type === 'integer') {
      const input = el('input');
      input.type = 'number';
      input.step = '1';
      if (entry.min !== undefined) {
        input.min = String(entry.min);
      }
      if (entry.max !== undefined) {
        input.max = String(entry.max);
      }
      input.addEventListener('change', async () => {
        const number = Number(input.value);
        if (input.value.trim() === '' || !Number.isInteger(number)) {
          errorEl.textContent = 'Enter a whole number.';
          input.value = String(current());
          return;
        }
        if (!await commit(ctx, key, number, errorEl)) {
          input.value = String(current());
        }
      });
      return { node: input, update: (value) => { input.value = String(value); } };
    }
    const input = el('input');
    input.type = 'text';
    if ('maxLen' in entry && entry.maxLen) {
      input.maxLength = entry.maxLen;
    }
    if (entry.type === 'stringList') {
      input.addEventListener('change', async () => {
        const list = input.value.split(',').map((part) => part.trim()).filter(Boolean);
        if (!await commit(ctx, key, list, errorEl)) {
          input.value = asList(current()).join(', ');
        }
      });
      return { node: input, update: (value) => { input.value = asList(value).join(', '); } };
    }
    input.addEventListener('change', async () => {
      if (!await commit(ctx, key, input.value, errorEl)) {
        input.value = String(current());
      }
    });
    return { node: input, update: (value) => { input.value = String(value); } };
  }

  // ---- Per-language tab size ----

  function createTabSizeEditor(ctx: CodePadCtx, key: SettingKey, entry: SettingsSchemaEntry, errorEl: HTMLElement): SettingControl {
    const root = el('div', 'cp-settings-langs');
    const rows = el('div', 'cp-settings-lang-rows');
    const adder = el('div', 'cp-settings-lang-add');
    const languageSelect = el('select');
    ctx.monaco.languages.getLanguages()
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((language) => {
        const option = el('option', '', language.aliases && language.aliases[0] ? language.aliases[0] : language.id);
        option.value = language.id;
        languageSelect.appendChild(option);
      });
    const sizeInput = el('input');
    sizeInput.type = 'number';
    sizeInput.min = String(('min' in entry && entry.min) || 1);
    sizeInput.max = String(('max' in entry && entry.max) || 16);
    sizeInput.value = String(ctx.settings.get('editor.tabSize') || 4);
    const addButton = el('button', '', 'Add');
    addButton.type = 'button';
    adder.append(languageSelect, sizeInput, addButton);
    root.append(rows, adder);

    const labelFor = (id: string): string => {
      const language = ctx.monaco.languages.getLanguages().find((item) => item.id === id);
      return language && language.aliases && language.aliases[0] ? language.aliases[0] : id;
    };
    const save = async (map: TabSizeMap): Promise<void> => {
      await commit(ctx, key, map, errorEl);
      update(ctx.settings.get(key));
    };

    function update(value: unknown): void {
      const map = asMap(value);
      rows.textContent = '';
      Object.keys(map).sort().forEach((id) => {
        const row = el('div', 'cp-settings-lang-row');
        const size = el('input');
        size.type = 'number';
        size.min = sizeInput.min;
        size.max = sizeInput.max;
        size.value = String(map[id]);
        size.addEventListener('change', () => save(Object.assign({}, map, { [id]: Number(size.value) })));
        const remove = el('button', '', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          const next = Object.assign({}, map);
          delete next[id];
          save(next);
        });
        row.append(el('span', 'cp-settings-lang-name', labelFor(id)), size, remove);
        rows.appendChild(row);
      });
    }

    addButton.addEventListener('click', () => {
      const size = Number(sizeInput.value);
      save(Object.assign({}, asMap(ctx.settings.get(key)), { [languageSelect.value]: size }));
    });
    return { node: root, update };
  }

  // ---- Settings pages ----

  function buildSettingRow(ctx: CodePadCtx, key: SettingKey, entry: SettingsSchemaEntry, updaters: Map<string, SettingUpdater>): HTMLElement {
    const row = el('div', 'cp-settings-row');
    const head = el('div', 'cp-settings-row-head');
    const label = el('label', 'cp-settings-label', labelOf(key));
    const errorEl = el('div', 'cp-settings-error');
    const control = key === 'editor.tabSizeByLanguage'
      ? createTabSizeEditor(ctx, key, entry, errorEl)
      : createInput(ctx, key, entry, errorEl);
    if (control.node.tagName === 'INPUT' || control.node.tagName === 'SELECT') {
      control.node.id = `cp-setting-${key}`;
      label.htmlFor = control.node.id;
    }
    const reset = el('button', 'cp-settings-reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Restore the default value';
    reset.addEventListener('click', () => commit(ctx, key, entry.default, errorEl));
    head.append(label, control.node, reset);
    row.appendChild(head);
    const description = LABELS[key] && LABELS[key][1];
    if (description) {
      row.appendChild(el('div', 'cp-settings-desc', description));
    }
    row.appendChild(errorEl);
    const refresh = (value: unknown): void => {
      control.update(value);
      reset.disabled = sameValue(value, entry.default);
    };
    refresh(ctx.settings.get(key));
    updaters.set(key, refresh);
    return row;
  }

  function buildSettingsPage(ctx: CodePadCtx, category: string, schema: SettingsSchemaMap, updaters: Map<string, SettingUpdater>): HTMLElement {
    const container = el('div', 'cp-settings-form');
    const keys = (Object.keys(schema) as SettingKey[]).filter((key) => categoryOf(key) === category);
    if (keys.length === 0) {
      container.appendChild(el('div', 'cp-settings-desc', 'No settings in this category.'));
    }
    keys.forEach((key) => {
      const entry = schema[key];
      if (entry) {
        container.appendChild(buildSettingRow(ctx, key, entry, updaters));
      }
    });
    return container;
  }

  // ---- Shortcuts ----

  function keyNameOf(event: KeyboardEvent): string | null {
    if (/^Key[A-Z]$/.test(event.code)) {
      return event.code.slice(3);
    }
    if (/^Digit\d$/.test(event.code)) {
      return event.code.slice(5);
    }
    if (/^F([1-9]|1\d|2[0-4])$/.test(event.code)) {
      return event.code;
    }
    return KEY_NAMES[event.code] || null;
  }

  /**
   * Convert a keydown event to an Electron accelerator.
   * @param event Key event.
   * @param platform process platform name.
   * @returns null while only modifiers are held.
   */
  function acceleratorFromEvent(event: KeyboardEvent, platform: string): { accelerator: string } | { error: string } | null {
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) {
      return null;
    }
    const mac = platform === 'darwin';
    const key = keyNameOf(event);
    if (!key) {
      return { error: 'This key cannot be used.' };
    }
    const parts: string[] = [];
    const primary = mac ? event.metaKey : event.ctrlKey;
    if (primary) {
      parts.push('CmdOrCtrl');
    }
    if (mac && event.ctrlKey) {
      parts.push('Ctrl');
    }
    if (!mac && event.metaKey) {
      return { error: 'The Windows/Super key cannot be used.' };
    }
    if (event.altKey) {
      parts.push('Alt');
    }
    if (event.shiftKey) {
      parts.push('Shift');
    }
    const functionKey = /^F\d+$/.test(key);
    if (!functionKey && !primary && !event.altKey && !(mac && event.ctrlKey)) {
      return { error: 'Include Ctrl, Alt or Cmd, or use a function key.' };
    }
    parts.push(key);
    return { accelerator: parts.join('+') };
  }

  function displayAccelerator(accelerator: string, platform: string): string {
    if (!accelerator) {
      return '';
    }
    return accelerator.replace(/CmdOrCtrl/g, platform === 'darwin' ? 'Cmd' : 'Ctrl');
  }

  async function buildShortcutsPage(ctx: CodePadCtx): Promise<HTMLElement> {
    const container = el('div', 'cp-settings-form');
    container.appendChild(el('div', 'cp-settings-warning',
      'Shortcuts of the editor itself (Ctrl+D, Ctrl+K chords, F2, F12, ...) cannot be remapped here. '
      + 'Click a shortcut, then press the new keys. Esc cancels, Backspace clears.'));
    const filter = el('input', 'cp-settings-filter');
    filter.type = 'text';
    filter.placeholder = 'Filter commands';
    filter.setAttribute('aria-label', 'Filter commands');
    const message = el('div', 'cp-settings-error');
    const table = el('table', 'cp-settings-shortcuts');
    container.append(filter, message, table);

    let commands: CpCommandInfo[] = [];
    let capturing: { button: HTMLButtonElement; onKey: (event: KeyboardEvent) => void } | null = null;

    const overrides = (): Record<string, string> => ctx.settings.get('keybindings') || {};

    async function load(): Promise<void> {
      commands = await window.codepad.commands.table();
      render();
    }

    async function store(map: Record<string, string>): Promise<void> {
      message.textContent = '';
      try {
        await ctx.settings.set('keybindings', map);
      } catch (error) {
        message.textContent = errorMessage(error);
      }
      await load();
    }

    function render(): void {
      const counts = new Map<string, number>();
      commands.forEach((command) => {
        if (command.accelerator) {
          const id = command.accelerator.toLowerCase();
          counts.set(id, (counts.get(id) || 0) + 1);
        }
      });
      const needle = filter.value.trim().toLowerCase();
      const custom = overrides();
      table.textContent = '';
      commands.filter((command) => !needle
        || command.title.toLowerCase().includes(needle)
        || command.id.toLowerCase().includes(needle)
        || (command.accelerator || '').toLowerCase().includes(needle))
        .forEach((command) => {
          const row = el('tr');
          const title = el('td', 'cp-settings-cmd', command.title);
          title.title = command.id;
          const menu = el('td', 'cp-settings-menu', command.menu || '');
          const keys = el('td', 'cp-settings-keys');
          const button = el('button', 'cp-settings-keybutton', displayAccelerator(command.accelerator, ctx.app.platform) || 'None');
          button.type = 'button';
          const duplicate = command.accelerator && (counts.get(command.accelerator.toLowerCase()) || 0) > 1;
          if (duplicate) {
            button.classList.add('cp-settings-duplicate');
            button.title = 'Also assigned to another command';
          }
          button.addEventListener('click', () => startCapture(command, button));
          keys.appendChild(button);
          if (Object.prototype.hasOwnProperty.call(custom, command.id)) {
            const reset = el('button', 'cp-settings-reset', 'Reset');
            reset.type = 'button';
            reset.addEventListener('click', () => {
              const next = Object.assign({}, overrides());
              delete next[command.id];
              store(next);
            });
            keys.appendChild(reset);
          }
          row.append(title, menu, keys);
          table.appendChild(row);
        });
    }

    function stopCapture(): void {
      if (capturing) {
        capturing.button.removeEventListener('keydown', capturing.onKey);
        capturing.button.removeEventListener('blur', stopCapture);
        capturing = null;
        render();
      }
    }

    function startCapture(command: CpCommandInfo, button: HTMLButtonElement): void {
      stopCapture();
      message.textContent = '';
      button.textContent = 'Press keys...';
      const onKey = (event: KeyboardEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          stopCapture();
          return;
        }
        if (event.key === 'Backspace') {
          stopCapture();
          store(Object.assign({}, overrides(), { [command.id]: '' }));
          return;
        }
        const result = acceleratorFromEvent(event, ctx.app.platform);
        if (!result) {
          return;
        }
        if ('error' in result) {
          message.textContent = result.error;
          return;
        }
        stopCapture();
        store(Object.assign({}, overrides(), { [command.id]: result.accelerator }));
      };
      capturing = { button, onKey };
      button.addEventListener('keydown', onKey);
      button.addEventListener('blur', stopCapture);
      button.focus();
    }

    filter.addEventListener('input', render);
    await load();
    return container;
  }

  // ---- Dialog ----

  function open(ctx: CodePadCtx): void {
    if (handle && handle.body.isConnected) {
      return;
    }
    const schema = readSchema();
    const updaters = new Map<string, SettingUpdater>();
    const body = el('div', 'cp-settings');
    const nav = el('nav', 'cp-settings-nav');
    const content = el('section', 'cp-settings-page');
    body.append(nav, content);

    const showPage = async (category: string): Promise<void> => {
      Array.from(nav.children).forEach((button) => {
        button.classList.toggle('active', button.textContent === category);
      });
      updaters.clear();
      content.textContent = '';
      const node = category === 'Shortcuts'
        ? await buildShortcutsPage(ctx)
        : buildSettingsPage(ctx, category, schema, updaters);
      content.textContent = '';
      content.appendChild(node);
    };

    CATEGORIES.forEach((category) => {
      const button = el('button', 'cp-settings-navbutton', category);
      button.type = 'button';
      button.addEventListener('click', () => showPage(category));
      nav.appendChild(button);
    });

    handle = { body, updaters, modal: ctx.ui.modal({ title: 'Settings', body, buttons: [{ label: 'Close' }] }) };
    showPage(CATEGORIES[0]);
  }

  CodePadCommands.register({ id: 'settings.open', run: open });

  CodePadFeatures.register('settings-panel', {
    init(ctx) {
      ctx.settings.onChange(({ key, value }) => {
        if (!handle || !handle.body.isConnected) {
          return;
        }
        const refresh = handle.updaters.get(key);
        const focused = document.activeElement;
        if (refresh && !(focused && focused.id === `cp-setting-${key}`)) {
          refresh(value);
        }
      });
    }
  });
})();
