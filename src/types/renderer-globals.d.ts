/*
 * Global types of the renderer. Renderer files are classic scripts that talk through window.CodePad* globals, so
 * every global, the feature context (`CodePadCtx`) and the document-editor view interface are declared here once.
 * Source of truth: renderer/core/*.ts, the ctx built in renderer/app.ts and .claude/plans/binary-formats-design.md.
 * `window.codepad` comes from codepad-api.d.ts, the shared UMD globals (settings, search core, command tables) from
 * shared-globals.d.ts. Nothing here is a module: keep it free of top-level import/export.
 */

// ---------- Tabs ----------

type CodePadTabKind = 'text' | 'docx' | 'sheet' | 'pdf' | 'diff';
/** Kinds rendered by an editor module (`CodePadEditors`) instead of Monaco. */
type CodePadViewKind = Exclude<CodePadTabKind, 'text'>;
/** Kinds backed by a file on disk that an editor module opens. */
type CodePadDocumentKind = Exclude<CodePadViewKind, 'diff'>;
type CodePadEol = 'lf' | 'crlf' | 'cr';

/** User-visible tab state that sessions keep. */
interface CodePadTabPersist {
  pinned: boolean;
  color: number;
  readOnly: boolean;
  bookmarks: number[];
  monitor: boolean;
}

/** The file's mtime/size as last read or written by this app. */
interface CodePadDiskStat {
  mtimeMs: number;
  size: number;
}

interface CodePadTabBase {
  id: number;
  path: string | null;
  name: string;
  dirty: boolean;
  diskStat: CodePadDiskStat | null;
}

/**
 * A Monaco text tab. `autoDetect`: the language follows the content (untitled tabs) until the user picks one.
 */
interface CodePadTextTab extends CodePadTabBase {
  kind: 'text';
  persist: CodePadTabPersist;
  encoding: string;
  eol: CodePadEol;
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  savedVersion: number;
  autoDetect: boolean;
  detectTimer: number | null;
}

/** A docx / spreadsheet / pdf tab: `view` is created by the editor module and rendered inside `host`. */
interface CodePadDocumentTab extends CodePadTabBase {
  kind: CodePadDocumentKind;
  persist: CodePadTabPersist;
  view: CodePadEditorView;
  host: HTMLElement;
  /** True when unsaved edits could not be stored in the session. */
  stateLost: boolean;
}

/** The compare view: not a file, never persisted. */
interface CodePadDiffTab extends CodePadTabBase {
  kind: 'diff';
  persist: null;
  view: CodePadEditorView;
  host: HTMLElement;
  stateLost: boolean;
}

type CodePadViewTab = CodePadDocumentTab | CodePadDiffTab;
type CodePadTab = CodePadTextTab | CodePadViewTab;

// ---------- Editor module / view interface (docx, sheet, pdf, diff) ----------

interface CodePadFileFilter {
  name: string;
  extensions: string[];
}

interface CodePadViewCallbacks {
  /** Call after every user mutation (cheap, may be called often). */
  onChange(): void;
  /** Transient message for the status bar. */
  onStatus(text: string): void;
}

/** Options the glue passes to `CodePadEditorModule.create`. */
interface CodePadViewOptions {
  /** Empty div owned by the glue; the view builds all DOM inside it. */
  container: HTMLElement;
  /** File bytes; null only when restoring unsaved edits of a file that no longer exists. */
  bytes: Uint8Array | null;
  /** Display name only, never trusted as a path. */
  fileName: string;
  /** For display / extension checks; the module must never use it for I/O. */
  filePath: string | null;
  /** The object previously returned by `getSessionState()`, applied on top of `bytes`. */
  restoredState: object | null;
  /** Free-form parameters for views that are not files (the 'diff' compare view). */
  params?: object;
  theme: 'dark' | 'light';
  callbacks: CodePadViewCallbacks;
}

/** The view object an editor module returns; the glue drives every tab kind but 'text' through it. */
interface CodePadEditorView {
  kind: CodePadViewKind;
  /** True disables Save / Save As (scanned PDFs). */
  readOnly: boolean;
  /** 'overwrite': Ctrl+S writes tab.path; 'saveAs': Ctrl+S always asks for a new file. */
  saveMode: 'overwrite' | 'saveAs';
  saveFilters: CodePadFileFilter[];
  /** Suggested file name for Save As. */
  defaultSaveName: string;
  /** Serializes the current state for a target extension ('docx', 'xlsx', 'csv', 'tsv', 'pdf'); rejects with a user-presentable Error. */
  getBytes(ext: string): Promise<Uint8Array>;
  isDirty(): boolean;
  /** Called by the glue after a successful write. */
  markSaved(): void;
  /** JSON-serializable snapshot of the UNSAVED edits only; null when nothing to persist or too large. */
  getSessionState(): Promise<object | null>;
  /** Set by the view together with a null `getSessionState()` result when the state was too large. */
  sessionStateTooLarge?: boolean;
  /** Text for the status bar info field (page 2/9, "Sheet1 · A1", ...). */
  getStatusText(): string;
  layout(): void;
  focus(): void;
  dispose(): void;
  /** Ctrl+F while this tab is active. */
  find?(): void;
  setTheme?(theme: 'dark' | 'light'): void;
}

/** What an editor module registers with `CodePadEditors.register`. */
interface CodePadEditorModule {
  extensions: string[];
  /** Rejects with an Error (message shown in the status bar) for unreadable files. */
  create(options: CodePadViewOptions): Promise<CodePadEditorView>;
}

interface CodePadEditorUtil {
  /** File URL of a path inside the app's node_modules folder (relative, no '..' segments). */
  nodeModulesUrl(relPath: string): string;
  /** Injects a classic script once; resolves when it has run. */
  loadScript(url: string): Promise<void>;
  /** Dynamically imports the pdf.js ES module once. */
  loadModule(url: string): Promise<PdfJsModule>;
  /** Reads a local asset as bytes. */
  fetchBytes(url: string): Promise<Uint8Array>;
  bytesToBase64(bytes: Uint8Array): string;
  base64ToBytes(text: string): Uint8Array;
  textToBytes(text: string): Uint8Array;
  bytesToText(bytes: Uint8Array): string;
  /** Throws a user-facing Error when a zip's central directory declares a decompression bomb (zip only; other bytes pass). */
  checkZipLimits(bytes: Uint8Array, fileName: string): void;
}

interface CodePadEditorsApi {
  register(kind: string, definition: CodePadEditorModule): void;
  get(kind: string): CodePadEditorModule | undefined;
  readonly util: CodePadEditorUtil;
}

// ---------- Event bus ----------

/**
 * Event name -> listener arguments. It is an interface so a feature that publishes its own events can add them
 * with a declaration merge in its own d.ts.
 */
interface CodePadEventMap {
  'editor:created': [editor: monaco.editor.IStandaloneCodeEditor];
  'file:changedOnDisk': [event: CpWatchEvent];
  'folder:changed': [dirPath: string];
  'layout:changed': [];
  'session:beforeSnapshot': [];
  'session:restored': [];
  'settings:changed': [change: { key: SettingKey; value: SettingValue }];
  'tab:activated': [tab: CodePadTab | null];
  'tab:closed': [tab: CodePadTab];
  'tab:closing': [tab: CodePadTab];
  'tab:created': [tab: CodePadTab];
  'tab:dirty': [tab: CodePadTab];
  'tab:pathChanged': [tab: CodePadTab, oldPath: string | null];
  'tab:reloaded': [tab: CodePadTab];
  'tab:reordered': [];
  'tab:restored': [tab: CodePadTab];
  'tab:saved': [tab: CodePadTab];
  'theme:changed': [id: string];
  'ai:state': [state: { model: unknown; engine: unknown }];
  'output:set': [output: { title: string; text: string }];
  'search:options': [options: CodePadSearchOptions];
}


/** The search form state published as `search:options`. */
interface CodePadSearchOptions {
  query: string;
  replace: string;
  scope: string;
  include: string[];
  exclude: string[];
  subPath: string | null;
  markStyle: number;
  bookmarkLines: boolean;
  [flag: string]: string | number | boolean | string[] | null;
}

type CodePadEventName = keyof CodePadEventMap;

interface CodePadBusApi {
  /** Subscribes to an event; returns a function that removes the listener. */
  on<K extends CodePadEventName>(name: K, callback: (...args: CodePadEventMap[K]) => void): () => boolean;
  /** Calls every listener of an event; a throwing listener never stops the others. */
  emit<K extends CodePadEventName>(name: K, ...args: CodePadEventMap[K]): void;
}

// ---------- Commands ----------

type CodePadCommandArgs = Record<string, unknown>;

interface CodePadCommandDefinition {
  id: string;
  run(ctx: CodePadCtx, args?: CodePadCommandArgs): void | Promise<void>;
  enabled?(ctx: CodePadCtx): boolean;
  /** `title`/`category`/`when` are only needed when the id is not in the static table (palette-only commands). */
  title?: string;
  category?: string;
  when?: 'text' | 'any';
}

interface CodePadCommandInfo {
  id: string;
  title: string;
  category: string;
  accelerator: string;
  when: 'text' | 'any';
}

interface CodePadExecutedCommand {
  id: string;
  args?: CodePadCommandArgs;
}

/** The part of the command registry features see (ctx.commands). */
interface CodePadCommandsPublic {
  /** @throws {Error} on a duplicate id. */
  register(definition: CodePadCommandDefinition): void;
  /** Runs a command by id. Never rejects: failures are shown in the status bar. */
  execute(id: string, args?: CodePadCommandArgs): Promise<void>;
  list(): CodePadCommandInfo[];
  /** Subscribes to finished commands; returns an unsubscribe function. */
  onExecute(callback: (command: CodePadExecutedCommand) => void): () => boolean;
}

interface CodePadCommandsApi extends CodePadCommandsPublic {
  readonly internal: {
    setTable(entries: CpCommandInfo[]): void;
    bindContext(ctx: CodePadCtx): void;
    attachEditor(editor: monaco.editor.IStandaloneCodeEditor): void;
  };
}

// ---------- Settings ----------

/** Renderer side of the settings store (ctx.settings). */
interface CodePadSettingsApi {
  /** Loads the saved settings from main without emitting events; true on the first start (no file yet). */
  load(): Promise<boolean>;
  get<K extends SettingKey>(key: K): SettingsValues[K];
  set<K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<void>;
  /** Locally valid values are visible to `get` at once; main's validated result then replaces them. */
  patch(values: Partial<SettingsValues>): Promise<void>;
  all(): SettingsValues;
  onChange(callback: (change: { key: SettingKey; value: SettingValue }) => void): () => boolean;
}

// ---------- Themes ----------

interface CodePadThemeDefinition {
  /** Lowercase letters, digits and dashes, at most 40 characters. */
  id: string;
  label?: string;
  base?: 'vs' | 'vs-dark';
  monaco?: { colors?: monaco.editor.IColors; rules?: monaco.editor.ITokenThemeRule[] };
  /** CSS custom property (`--name`) -> value, applied to the document element. */
  ui?: Record<string, string>;
}

interface CodePadThemeSummary {
  id: string;
  label: string;
  base: 'vs' | 'vs-dark';
}

interface CodePadThemeEntry extends CodePadThemeSummary {
  monaco?: { colors?: monaco.editor.IColors; rules?: monaco.editor.ITokenThemeRule[] };
  ui?: Record<string, string>;
  monacoName: string;
}

interface CodePadThemesPublic {
  /** Adds a theme; registering an id again replaces it. */
  register(definition: CodePadThemeDefinition): void;
  list(): CodePadThemeSummary[];
  get(id: string): CodePadThemeEntry | null;
  /** 'light' or 'dark' for the document editors. */
  kindOf(id: string): 'light' | 'dark';
  /** Applies a theme to the page and to Monaco (unknown id: dark); returns the applied id. */
  apply(id: string): string;
  current(): string;
}

interface CodePadThemesApi extends CodePadThemesPublic {
  readonly internal: { setMonaco(namespace: typeof monaco): void };
}

// ---------- UI toolkit ----------

interface CodePadModalButton {
  label: string;
  primary?: boolean;
  /** Returning `false` keeps the dialog open. */
  onClick?(handle: CodePadModalHandle): boolean | void;
}

interface CodePadModalHandle {
  close(): void;
  element: HTMLElement;
}

interface CodePadModalOptions {
  title: string;
  body: HTMLElement;
  buttons?: CodePadModalButton[];
  onClose?(): void;
}

interface CodePadPromptOptions {
  title: string;
  label?: string;
  value?: string;
  /** Returns an error message, or null when the input is acceptable. */
  validate?(value: string): string | null;
}

interface CodePadConfirmOptions {
  title?: string;
  message: string;
  buttons?: (string | { label: string })[];
}

interface CodePadPickItem<T> {
  label: string;
  detail?: string;
  value: T;
  checked?: boolean;
}

interface CodePadContextMenuItem {
  label?: string;
  accelerator?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?(): void;
}

interface CodePadUIApi {
  modal(options: CodePadModalOptions): CodePadModalHandle;
  /** Resolves the text, or null when cancelled. */
  prompt(options: CodePadPromptOptions): Promise<string | null>;
  /** Resolves the index of the clicked button, or -1 when dismissed with Escape. */
  confirm(options: CodePadConfirmOptions): Promise<number>;
  /** Single mode resolves the chosen value; multi mode an array of values; both null when cancelled. */
  pick<T>(options: { title: string; items: CodePadPickItem<T>[]; multi?: false }): Promise<T | null>;
  pick<T>(options: { title: string; items: CodePadPickItem<T>[]; multi: true }): Promise<T[] | null>;
  /** Shows a context menu at client coordinates. */
  contextMenu(x: number, y: number, items: CodePadContextMenuItem[]): void;
  /** Shows text in the bottom `output` panel (or a dialog when no such panel exists). */
  output(title: string, text: string): void;
}

// ---------- Panels ----------

interface CodePadPanelInstance {
  onShow?(): void;
  onHide?(): void;
  dispose?(): void;
}

interface CodePadPanelDefinition {
  id: string;
  title: string;
  location: 'left' | 'bottom';
  order?: number;
  render(container: HTMLElement, ctx: CodePadCtx): CodePadPanelInstance | void;
  /** Lets app.ts adopt an element that already exists in the page. */
  container?: HTMLElement;
}

interface CodePadPanelsPublic {
  register(definition: CodePadPanelDefinition): void;
  /** Shows a panel, opening the sidebar or bottom area when needed. */
  show(id: string, options?: { focus?: boolean }): void;
  hide(id: string): void;
  toggle(id: string): void;
  isVisible(id: string): boolean;
  /** Id of the panel shown (or last shown) in a location; null when none exists. */
  active(location: 'left' | 'bottom'): string | null;
  /** Sets (or clears, with an empty text) the badge on a panel's tab. */
  setBadge(id: string, text?: string | number | null): void;
  has(id: string): boolean;
}

interface CodePadPanelsApi extends CodePadPanelsPublic {
  readonly internal: { start(ctx: CodePadCtx): void };
}

// ---------- Features ----------

interface CodePadFeatureDefinition {
  init?(ctx: CodePadCtx): void;
}

interface CodePadFeaturesApi {
  register(name: string, definition?: CodePadFeatureDefinition): void;
  /** Runs every init(ctx) in its own try/catch; returns the names of the modules whose init threw. */
  initAll(ctx: CodePadCtx): string[];
}

// ---------- Feature context (ctx) ----------

/** Scopes of the text helpers (ctx.text.transformSelections). */
type CodePadTextScope =
  | 'selection'
  | 'lines'
  | 'document'
  | 'wordOrSelection'
  | 'selectionOrDocument'
  | 'linesOrDocument';
/** Scopes of ctx.text.transformLines (mapped to whole-line ranges). */
type CodePadLineScope = 'selection' | 'lines' | 'document' | 'selectionOrDocument';

interface CodePadTransformInfo {
  range: monaco.Range;
  index: number;
  model: monaco.editor.ITextModel;
  tab: CodePadTextTab;
}

interface CodePadTextSelection {
  tab: CodePadTextTab;
  model: monaco.editor.ITextModel;
  ranges: monaco.Range[];
  /** False when nothing was selected and the whole document is used. */
  isSelection: boolean;
}

interface CodePadTextEdit {
  range: monaco.IRange;
  text: string;
}

interface CodePadTabsApi {
  list(): CodePadTab[];
  active(): CodePadTab | null;
  byId(id: number): CodePadTab | null;
  activate(tab: CodePadTab): void;
  /** Resolves false when the tab was pinned, vetoed, or the user cancelled the unsaved-changes prompt. */
  close(tab: CodePadTab, options?: { force?: boolean }): Promise<boolean>;
  /** Closes tabs one by one (skipping pinned ones); false when the user cancelled. */
  closeMany(tabs: CodePadTab[]): Promise<boolean>;
  /** Moves a tab; pinned tabs always stay at the left. */
  move(tab: CodePadTab, newIndex: number): void;
  /** Opens a file in the editor its extension selects; `asText` forces Monaco. Null when it could not be opened. */
  openPath(filePath: string, options?: { line?: number; col?: number; asText?: boolean }): Promise<CodePadTab | null>;
  /** Opens an untitled text tab. */
  openText(options?: { name?: string; content?: string; language?: string }): CodePadTextTab;
  /** Opens a non-file tab (e.g. the compare view) from a registered view kind. */
  openView(kind: CodePadViewKind, options?: { name?: string; params?: object }): Promise<CodePadViewTab>;
  /** Selects a position (or a range when `length` is given) and scrolls it to the center. */
  reveal(tab: CodePadTab, line: number, col?: number, length?: number): void;
  save(tab: CodePadTab): Promise<boolean>;
  saveAs(tab: CodePadTab): Promise<boolean>;
  saveAll(): Promise<boolean>;
  /** Re-reads a tab from disk (optionally with another encoding); false when nothing was reloaded. */
  reload(tab: CodePadTab, options?: { encoding?: string }): Promise<boolean>;
  /** 'lf', 'crlf' or 'cr' (lone CRs only); mixed files report their dominant LF/CRLF style. */
  detectEol(content: string): CodePadEol;
  /** Re-renders the tab bar. */
  changed(): void;
  /** Marks a text tab as changed although its model is not (e.g. a new encoding). */
  forceDirty(tab: CodePadTextTab): void;
  decorate(fn: (tab: CodePadTab, item: HTMLElement, label: HTMLElement) => void): void;
  onContextMenu(fn: (tab: CodePadTab, event: MouseEvent) => void): void;
  /** A listener returning `false` vetoes closing a tab. */
  interceptClose(fn: (tab: CodePadTab) => boolean | void): void;
  contributeMenu(fn: (tab: CodePadTab) => CodePadContextMenuItem[] | null | undefined): void;
  menuContributions(tab: CodePadTab): CodePadContextMenuItem[];
  /** Serialized bytes of a document tab (current edits included); rejects for text/diff tabs. */
  exportBytes(tab: CodePadTab, ext: string): Promise<Uint8Array>;
}

interface CodePadTextApi {
  /** The selections (or the whole document) of the active text tab; null when the active tab is not text. */
  selectionOrDocument(): CodePadTextSelection | null;
  /** Replaces each range by fn(text, info); nothing is edited when fn throws. True when text changed. */
  transformSelections(
    fn: (text: string, info: CodePadTransformInfo) => string,
    options?: { scope?: CodePadTextScope; label?: string },
  ): boolean;
  /** fn gets the lines of each range (without line breaks) and returns the new lines. */
  transformLines(
    fn: (lines: string[], info: CodePadTransformInfo) => string[],
    options?: { scope?: CodePadLineScope; label?: string },
  ): boolean;
  insertAtCursors(textOrFn: string | ((index: number, selection: monaco.Selection) => string)): boolean;
  /** Applies edits to any text model as one undo step. */
  replaceAll(model: monaco.editor.ITextModel, edits: CodePadTextEdit[], label?: string): void;
}

interface CodePadRecentEntry {
  path: string;
  name: string;
}

interface CodePadFilesApi {
  readText(filePath: string, options?: CpReadTextOptions): Promise<CpReadTextResult>;
  stat(filePath: string): Promise<CpStatResult>;
  hashFile(filePath: string, algo: string): Promise<CpHashResult>;
  reveal(filePath: string): Promise<void>;
  /** Creates a new file inside the opened folder (never overwrites); the path is approved afterwards. */
  create(filePath: string, content: string): Promise<CpFileOpResult<{ path: string }>>;
  /** Renames a file inside its folder; `newName` is a bare file name and nothing is overwritten. */
  rename(filePath: string, newName: string): Promise<CpFileOpResult<{ path: string }>>;
  /** Moves a file to the OS trash after main's native Yes/No box; `{ok:false, cancelled:true}` when declined. */
  trash(filePath: string): Promise<CpFileOpResult>;
  watch(filePath: string): Promise<{ ok: boolean }>;
  unwatch(filePath: string): Promise<{ ok: true }>;
  readonly recent: {
    list(): Promise<CodePadRecentEntry[]>;
    add(filePath: string): Promise<void>;
    clear(): Promise<void>;
    /** Approves the entry at a position of main's own list; resolves with its real path. */
    approveAt(index: number): Promise<string>;
  };
}

interface CodePadStatusItem {
  /** Empty text hides the button. */
  set(text: string, options?: { title?: string; state?: string }): void;
  dispose(): void;
}

interface CodePadStatusApi {
  set(text: string): void;
  /** Adds a button before the cursor position, ordered by `order` (lower first). Hidden until `set` gives it text. */
  addItem(options: { id: string; order?: number; onClick(event: MouseEvent): void | Promise<void> }): CodePadStatusItem;
}

interface CodePadSessionApi {
  /** Schedules a (debounced) save of the session. */
  schedule(): void;
  snapshot(): Promise<{ tabs: CpSessionTab[] }>;
  /** Rebuilds tabs from a session; with `replace` every open tab is closed first. */
  restore(session: { root?: string | null; tabs: CpSessionTab[] }, options?: { replace?: boolean }): Promise<void>;
}

interface CodePadAppApi {
  version: string;
  platform: 'win32' | 'darwin' | 'linux';
  baseName(path: string): string;
  /** Lowercase extension with the dot, or ''. */
  extensionOf(path: string): string;
}

/** The preload `ai` API as exposed to features (frozen copy). */
type CodePadAiApi = Window['codepad']['ai'];

/** Libraries ctx.libs.load can return. */
interface CodePadLibraries {
  mammoth: MammothModule;
  docx: DocxModule;
  xlsx: XlsxModule;
  pdfjs: PdfJsModule;
}

interface CodePadLibsApi {
  /** Loads a document library (pdf.js with its worker configured) and returns it. */
  load<K extends keyof CodePadLibraries>(name: K): Promise<CodePadLibraries[K]>;
  /** File URL of a pdf.js asset folder or file (e.g. 'pdfjs-dist/cmaps/'). */
  assetUrl(rel: string): string;
}

/** The frozen context handed to every feature (`init(ctx)`) and command (`run(ctx)`), built in renderer/app.ts. */
interface CodePadCtx {
  readonly version: number;
  /** The Monaco namespace. */
  readonly monaco: typeof monaco;
  /** A getter: never cache it, split view would change it to the focused editor. */
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly tabs: CodePadTabsApi;
  readonly text: CodePadTextApi;
  readonly files: CodePadFilesApi;
  readonly settings: CodePadSettingsApi;
  readonly status: CodePadStatusApi;
  readonly ai: CodePadAiApi;
  readonly libs: CodePadLibsApi;
  readonly clipboard: { write(text: string): Promise<void> };
  readonly ui: CodePadUIApi;
  readonly panels: CodePadPanelsPublic;
  readonly commands: CodePadCommandsPublic;
  readonly themes: CodePadThemesPublic;
  readonly events: CodePadBusApi;
  readonly session: CodePadSessionApi;
  readonly app: CodePadAppApi;
}

// ---------- Globals set by renderer/core/*.ts ----------

declare var CodePadBus: Readonly<CodePadBusApi>;
declare var CodePadCommands: Readonly<CodePadCommandsApi>;
declare var CodePadSettings: Readonly<CodePadSettingsApi>;
declare var CodePadThemes: Readonly<CodePadThemesApi>;
declare var CodePadUI: Readonly<CodePadUIApi>;
declare var CodePadPanels: Readonly<CodePadPanelsApi>;
declare var CodePadFeatures: Readonly<CodePadFeaturesApi>;
declare var CodePadEditors: Readonly<CodePadEditorsApi>;
