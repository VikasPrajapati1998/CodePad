/**
 * Settings schema shared by the main process (settingsStore.ts validates with it) and the renderer
 * (core/settings.ts, the settings panel, the generic Monaco option applier).
 * Entry: { type, default, min?, max?, values?, maxLen?, maxItems?, valueType?, monaco?, monacoMap? }.
 * `monaco` is the (dotted) editor option the value is applied to; `monacoMap: 'onOff'` maps true/false to 'on'/'off'.
 */
(function (root: { CodePadSettingsSchema?: CodePadSettingsSchemaApi }, factory: () => CodePadSettingsSchemaApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadSettingsSchema = factory();
  }
})(globalThis, () => {
  const THEMES = ['dark', 'light', 'monokai', 'solarized-dark', 'solarized-light', 'zenburn', 'obsidian', 'hc-black'];
  // Same ids as ENCODINGS in textCodec.ts (the main process also checks them against the installed codecs).
  const ENCODING_IDS = [
    'utf8', 'utf8bom', 'utf16le', 'utf16be', 'latin1', 'windows-1252', 'iso-8859-15', 'macintosh', 'windows-1250',
    'iso-8859-2', 'iso-8859-16', 'windows-1251', 'iso-8859-5', 'koi8-r', 'koi8-u', 'windows-1253', 'windows-1254',
    'windows-1255', 'windows-1256', 'windows-1257', 'iso-8859-3', 'iso-8859-4', 'iso-8859-6', 'iso-8859-7',
    'iso-8859-8', 'iso-8859-9', 'iso-8859-10', 'iso-8859-13', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-jp',
    'euc-kr', 'windows-874', 'windows-1258', 'cp437', 'cp850', 'cp852', 'cp866',
  ];
  const MAX_KEYBINDINGS = 200;
  const MAX_LANGUAGE_SIZES = 60;
  const LANGUAGE_ID = /^[A-Za-z0-9_.+-]{1,40}$/;
  const COMMAND_ID = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;
  const ACCELERATOR =
    /^(?:(?:(?:CmdOrCtrl|Ctrl|Cmd|Alt|Shift)\+)+(?:[A-Za-z0-9,.\-=/[\]\\;'`]|F(?:[1-9]|1[0-9]|2[0-4])|PageUp|PageDown|Home|End|Insert|Delete|Tab|Enter|Space|Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4]))$/;

  const bool = (def: boolean, monaco?: string, monacoMap?: 'onOff'): SettingsBooleanEntry => ({
    type: 'boolean',
    default: def,
    monaco,
    monacoMap,
  });
  const int = (def: number, min: number, max: number, extra?: { monaco?: string }): SettingsIntegerEntry => ({
    type: 'integer',
    default: def,
    min,
    max,
    ...extra,
  });
  const choice = (def: string, values: readonly string[], monaco?: string): SettingsEnumEntry => ({
    type: 'enum',
    default: def,
    values,
    monaco,
  });

  const SCHEMA: Readonly<Record<SettingKey, SettingsSchemaEntry>> = Object.freeze({
    'ui.theme': choice('dark', THEMES),
    'ui.sidebar': bool(true),
    'ui.minimap': bool(true, 'minimap.enabled'),
    'ui.sidebarWidth': int(260, 150, 600),
    'ui.bottomPanel': bool(false),
    'ui.bottomHeight': int(240, 80, 800),
    'ui.activeLeft': { type: 'string', default: 'explorer', maxLen: 60 },
    'ui.activeBottom': { type: 'string', default: '', maxLen: 60 },
    'editor.wordWrap': bool(false, 'wordWrap', 'onOff'),
    'editor.fontFamily': {
      type: 'string',
      default: "Consolas, 'Cascadia Code', 'Courier New', monospace",
      maxLen: 200,
      monaco: 'fontFamily',
    },
    'editor.fontSize': int(14, 6, 72, { monaco: 'fontSize' }),
    'editor.lineNumbers': choice('on', ['on', 'off', 'relative'], 'lineNumbers'),
    'editor.tabSize': int(4, 1, 16, { monaco: 'tabSize' }),
    'editor.insertSpaces': bool(true, 'insertSpaces'),
    'editor.renderWhitespace': choice('selection', ['none', 'selection', 'boundary', 'all'], 'renderWhitespace'),
    'editor.renderControlCharacters': bool(false, 'renderControlCharacters'),
    'editor.indentGuides': bool(true, 'guides.indentation'),
    'editor.cursorBlinking': choice('blink', ['blink', 'smooth', 'phase', 'expand', 'solid'], 'cursorBlinking'),
    'editor.cursorStyle': choice(
      'line',
      ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
      'cursorStyle',
    ),
    'editor.smoothScrolling': bool(true, 'smoothScrolling'),
    'editor.scrollBeyondLastLine': bool(false, 'scrollBeyondLastLine'),
    'editor.autoClosingBrackets': choice(
      'languageDefined',
      ['always', 'languageDefined', 'beforeWhitespace', 'never'],
      'autoClosingBrackets',
    ),
    'editor.autoIndent': choice('advanced', ['none', 'keep', 'brackets', 'advanced', 'full'], 'autoIndent'),
    'editor.renderLineHighlight': choice('line', ['none', 'gutter', 'line', 'all'], 'renderLineHighlight'),
    'editor.emptySelectionClipboard': bool(true, 'emptySelectionClipboard'),
    'editor.mouseWheelZoom': bool(true, 'mouseWheelZoom'),
    'editor.wrapIndicator': choice('same', ['none', 'same', 'indent', 'deepIndent'], 'wrappingIndent'),
    'editor.showEol': bool(false),
    'editor.tabSizeByLanguage': { type: 'map', default: {}, valueType: 'tabSize', maxItems: MAX_LANGUAGE_SIZES },
    'files.fallbackEncoding': choice('windows-1252', ENCODING_IDS),
    'files.defaultEncoding': choice('utf8', ENCODING_IDS),
    'files.defaultEol': choice('platform', ['lf', 'crlf', 'platform']),
    'files.trimTrailingOnSave': bool(false),
    'files.watch': bool(true),
    'autosave.mode': choice('off', ['off', 'afterDelay', 'onFocusLoss']),
    'autosave.delayMs': int(30000, 1000, 600000),
    'search.defaultExcludes': {
      type: 'stringList',
      default: ['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next'],
      maxItems: 50,
      maxLen: 100,
    },
    'search.maxResults': int(5000, 100, 20000),
    'search.maxFileKB': int(5120, 64, 20480),
    'clipboard.historyEnabled': bool(true),
    'clipboard.historySize': int(30, 5, 100),
    'editor.autoSuggest': bool(true),
    'spell.enabled': bool(true),
    'ai.enabled': bool(true),
    'ai.autoDownload': bool(true),
    'ai.setupPrompted': bool(false),
    'ai.suggestDelayMs': int(350, 150, 2000),
    'ai.maxSuggestionTokens': int(24, 8, 64),
    'ai.contextChars': int(2000, 500, 6000),
    'ai.threads': int(0, 0, 32),
    'ai.unloadAfterMinutes': int(10, 0, 240),
    'ai.multiline': bool(false),
    'ai.summaryStyle': choice('both', ['both', 'paragraph', 'bullets']),
    'ai.summaryMaxChars': int(2000000, 10000, 2000000),
    'ai.chunkTokens': int(1500, 600, 2400),
    'ai.summaryCache': bool(true),
    'keybindings': { type: 'map', default: {}, valueType: 'accelerator', maxItems: MAX_KEYBINDINGS },
  });

  const KEYS = Object.freeze(Object.keys(SCHEMA) as SettingKey[]);

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  function cloneDefault(entry: SettingsSchemaEntry): SettingValue {
    return Array.isArray(entry.default) ? [...entry.default] : isPlainObject(entry.default) ? { ...entry.default } : entry.default;
  }

  /** Fresh object holding every key at its default value. */
  function defaults(): SettingsValues {
    const out: Record<string, SettingValue> = {};
    KEYS.forEach((key) => {
      out[key] = cloneDefault(SCHEMA[key]);
    });
    return out as SettingsValues;
  }

  function validateMap(entry: SettingsMapEntry, value: unknown, hooks: SettingsValidateHooks): SettingsValidation {
    if (!isPlainObject(value)) {
      return { ok: false };
    }
    const out: Record<string, number | string> = {};
    for (const [name, item] of Object.entries(value).slice(0, entry.maxItems)) {
      if (entry.valueType === 'tabSize') {
        if (LANGUAGE_ID.test(name) && typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 16) {
          out[name] = item;
        }
      } else if (
        COMMAND_ID.test(name) &&
        (!hooks.isKnownCommand || hooks.isKnownCommand(name)) &&
        typeof item === 'string' &&
        (item === '' || ACCELERATOR.test(item))
      ) {
        out[name] = item;
      }
    }
    return { ok: true, value: out };
  }

  /**
   * Checks one value against its schema entry.
   * @param key Setting key.
   * @param value Candidate value.
   * @returns `value` is the cleaned value when `ok`.
   */
  function validate(key: string, value: unknown, hooks: SettingsValidateHooks = {}): SettingsValidation {
    const entry = (SCHEMA as Readonly<Record<string, SettingsSchemaEntry | undefined>>)[key];
    if (!entry) {
      return { ok: false };
    }
    switch (entry.type) {
      case 'boolean':
        return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value) && value >= entry.min && value <= entry.max ? { ok: true, value } : { ok: false };
      case 'enum':
        return typeof value === 'string' && entry.values.includes(value) ? { ok: true, value } : { ok: false };
      case 'string':
        return typeof value === 'string' ? { ok: true, value: value.slice(0, entry.maxLen) } : { ok: false };
      case 'stringList':
        return Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? { ok: true, value: value.slice(0, entry.maxItems).map((item) => item.slice(0, entry.maxLen)) }
          : { ok: false };
      case 'map':
        return validateMap(entry, value, hooks);
      default:
        return { ok: false };
    }
  }

  /** A complete settings object: unknown keys dropped, invalid or missing values replaced by their default. */
  function sanitize(raw: unknown, hooks: SettingsValidateHooks = {}): SettingsValues {
    const out: Record<string, SettingValue> = defaults();
    if (isPlainObject(raw)) {
      KEYS.forEach((key) => {
        if (key in raw) {
          const result = validate(key, raw[key], hooks);
          if (result.ok) {
            out[key] = result.value;
          }
        }
      });
    }
    return out as SettingsValues;
  }

  return Object.freeze({ SCHEMA, KEYS, THEMES, ENCODING_IDS, ACCELERATOR, defaults, validate, sanitize });
});
