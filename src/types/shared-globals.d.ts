/*
 * Ambient types of the shared UMD files (src/shared/*). Those files are plain scripts: Node `require`s them in
 * main and the renderer loads them with <script> tags, where they set the globals declared at the bottom.
 * Everything here is global on purpose (a script file cannot export types without turning into a module).
 */

// ---------- Settings (shared/settingsSchema) ----------

/** One setting value as stored in settings.json. */
type SettingValue = boolean | number | string | string[] | Record<string, number | string>;

/** The complete, validated settings object (main: settingsStore, renderer: CodePadSettings). */
type SettingsValues = {
  'ui.theme': string;
  'ui.sidebar': boolean;
  'ui.minimap': boolean;
  'ui.sidebarWidth': number;
  'ui.bottomPanel': boolean;
  'ui.bottomHeight': number;
  'ui.activeLeft': string;
  'ui.activeBottom': string;
  'editor.wordWrap': boolean;
  'editor.fontFamily': string;
  'editor.fontSize': number;
  'editor.lineNumbers': string;
  'editor.tabSize': number;
  'editor.insertSpaces': boolean;
  'editor.renderWhitespace': string;
  'editor.renderControlCharacters': boolean;
  'editor.indentGuides': boolean;
  'editor.cursorBlinking': string;
  'editor.cursorStyle': string;
  'editor.smoothScrolling': boolean;
  'editor.scrollBeyondLastLine': boolean;
  'editor.autoClosingBrackets': string;
  'editor.autoIndent': string;
  'editor.renderLineHighlight': string;
  'editor.emptySelectionClipboard': boolean;
  'editor.mouseWheelZoom': boolean;
  'editor.wrapIndicator': string;
  'editor.showEol': boolean;
  /** Language id -> tab size. */
  'editor.tabSizeByLanguage': Record<string, number>;
  'files.fallbackEncoding': string;
  'files.defaultEncoding': string;
  /** 'lf' | 'crlf' | 'platform'. */
  'files.defaultEol': string;
  'files.trimTrailingOnSave': boolean;
  'files.watch': boolean;
  /** 'off' | 'afterDelay' | 'onFocusLoss'. */
  'autosave.mode': string;
  'autosave.delayMs': number;
  'search.defaultExcludes': string[];
  'search.maxResults': number;
  'search.maxFileKB': number;
  'clipboard.historyEnabled': boolean;
  'clipboard.historySize': number;
  'editor.autoSuggest': boolean;
  'spell.enabled': boolean;
  'ai.enabled': boolean;
  'ai.autoDownload': boolean;
  'ai.setupPrompted': boolean;
  'ai.suggestDelayMs': number;
  'ai.maxSuggestionTokens': number;
  'ai.contextChars': number;
  'ai.threads': number;
  'ai.unloadAfterMinutes': number;
  'ai.multiline': boolean;
  /** 'both' | 'paragraph' | 'bullets'. */
  'ai.summaryStyle': string;
  'ai.summaryMaxChars': number;
  'ai.chunkTokens': number;
  'ai.summaryCache': boolean;
  /** Command id -> accelerator ('' unbinds). */
  keybindings: Record<string, string>;
};

/** Key of the settings object. */
type SettingKey = keyof SettingsValues;

interface SettingsEntryBase {
  /** Monaco option (dotted path) the value is applied to by the generic option applier. */
  monaco?: string;
  /** 'onOff' maps true/false to 'on'/'off'. */
  monacoMap?: 'onOff';
}
interface SettingsBooleanEntry extends SettingsEntryBase {
  type: 'boolean';
  default: boolean;
}
interface SettingsIntegerEntry extends SettingsEntryBase {
  type: 'integer';
  default: number;
  min: number;
  max: number;
}
interface SettingsEnumEntry extends SettingsEntryBase {
  type: 'enum';
  default: string;
  values: readonly string[];
}
interface SettingsStringEntry extends SettingsEntryBase {
  type: 'string';
  default: string;
  maxLen: number;
}
interface SettingsStringListEntry extends SettingsEntryBase {
  type: 'stringList';
  default: string[];
  maxItems: number;
  maxLen: number;
}
interface SettingsMapEntry extends SettingsEntryBase {
  type: 'map';
  default: Record<string, number | string>;
  valueType: 'tabSize' | 'accelerator';
  maxItems: number;
}
/** One entry of the settings schema. */
type SettingsSchemaEntry =
  | SettingsBooleanEntry
  | SettingsIntegerEntry
  | SettingsEnumEntry
  | SettingsStringEntry
  | SettingsStringListEntry
  | SettingsMapEntry;

interface SettingsValidateHooks {
  isKnownCommand?: (id: string) => boolean;
}

/** `value` is the cleaned value when `ok`. */
type SettingsValidation = { ok: true; value: SettingValue } | { ok: false };

interface CodePadSettingsSchemaApi {
  SCHEMA: Readonly<Record<SettingKey, SettingsSchemaEntry>>;
  KEYS: readonly SettingKey[];
  THEMES: readonly string[];
  ENCODING_IDS: readonly string[];
  ACCELERATOR: RegExp;
  /** Fresh object holding every key at its default value. */
  defaults(): SettingsValues;
  validate(key: string, value: unknown, hooks?: SettingsValidateHooks): SettingsValidation;
  /** A complete settings object: unknown keys dropped, invalid or missing values replaced by their default. */
  sanitize(raw: unknown, hooks?: SettingsValidateHooks): SettingsValues;
}

// ---------- Search core (shared/searchCore) ----------

interface SearchCoreOptions {
  query: string;
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  extended?: boolean;
  dotAll?: boolean;
}

interface SearchCoreMatcher {
  regex: RegExp;
  /** Throws SyntaxError on a malformed extended escape. */
  makeReplacer(rep: string): (match: RegExpExecArray) => string;
}

interface SearchCoreError {
  error: string;
}

interface SearchCoreFindOptions {
  limit?: number;
  timeBudgetMs?: number;
  /** Adds the exec array as `match` (needed to build replacements). */
  keepMatch?: boolean;
}

/** Positions are 1-based; `lineOffset` is how many characters were cut from the start of the line preview. */
interface SearchCoreHit {
  index: number;
  length: number;
  line: number;
  col: number;
  lineText: string;
  lineOffset: number;
  match?: RegExpExecArray;
}

interface CodePadSearchCoreApi {
  expandExtended(str: string): string;
  buildMatcher(opts: SearchCoreOptions): SearchCoreMatcher | SearchCoreError;
  findAll(text: string, matcher: { regex: RegExp }, options?: SearchCoreFindOptions): SearchCoreHit[];
  /** File name for display: bidi controls and C0/C1 control characters removed. */
  displayName(name: string): string;
}

// ---------- Command tables (shared/commands/*.commands) ----------

/** One command declaration of a static table (menu item and/or palette entry). */
interface CommandEntry {
  id: string;
  title: string;
  /** '/'-separated menu path, e.g. 'Edit/Sort Lines'. Omitted: palette only. */
  menu?: string;
  order?: number;
  accelerator?: string;
  /** 'text': needs an active text editor; 'any': always enabled. Default 'text'. */
  when?: 'any' | 'text';
  separatorBefore?: boolean;
  /** Setting whose boolean value is the check mark of the menu item. */
  checkedSetting?: SettingKey;
  /** Electron menu role: the item is native and never sent to the renderer. */
  role?: 'quit' | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen' | 'minimize' | 'toggleDevTools';
  /** process.platform values the item is shown on. */
  platforms?: string[];
  devOnly?: boolean;
  /** false: left out of the command palette. */
  palette?: boolean;
  /** 'recent': the item is the Open Recent submenu built by main. */
  dynamic?: 'recent';
}

// ---------- AI suggestion text logic (shared/suggestText) ----------

type SuggestKind = 'prose' | 'code';

/** Line access to the edited document for context extraction (line numbers are 1-based). */
interface SuggestExtractInput {
  languageId: string;
  lineCount: number;
  getLine(n: number): string;
  cursorLine: number;
  /** First line of the prefix window that is sent as `prefix`. */
  windowStartLine: number;
}

/** Context sent besides the prefix window. */
interface SuggestContextParts {
  /** Import lines (code) or front matter plus nearest heading (prose) above the window. */
  header: string;
  /** Enclosing declarations above the window (code only). */
  scope: string;
  /** Text after the cursor line, to the end of the enclosing block (capped). */
  suffix: string;
}

interface SuggestTrimContext {
  prefix: string;
  suffixLine: string;
  suffix: string;
  header: string;
  scope: string;
  languageId: string;
  multiline: boolean;
  /** The model hit its token limit (the last word, line or statement is probably cut). */
  truncated: boolean;
}

interface CodePadSuggestTextApi {
  languageKind(languageId: string): SuggestKind;
  /** Line comment leader of the language ('' when it has none). */
  commentLeader(languageId: string): string;
  extractContext(input: SuggestExtractInput): SuggestContextParts;
  /** Stop strings derived from the text after the cursor. */
  suggestStops(suffix: string): string[];
  /** Cuts a raw completion to complete sentences/statements and drops repeats; null when nothing usable remains. */
  trimSuggestion(raw: string, ctx: SuggestTrimContext): string | null;
  sentenceEnds(text: string): number[];
}

// ---------- Globals set by the UMD wrappers ----------

declare var CodePadSuggestText: CodePadSuggestTextApi;
declare var CodePadSettingsSchema: CodePadSettingsSchemaApi;
declare var CodePadSearchCore: CodePadSearchCoreApi;
declare var CodePadTextCommands: CommandEntry[];
