/*
 * The preload API (`window.codepad`, built by src/preload.ts) and the IPC channel contract behind it.
 * `CpIpcChannels` maps every invoke channel to its arguments and result; src/preload.ts types its `invoke`
 * helper with it and src/main.ts types `handle()` with it, so both sides are checked against this file.
 * All names are global (this file is an ambient script, shared by the main and renderer projects).
 */

// ---------- Files and dialogs ----------

interface CpSaveAsFilter {
  name?: string;
  /** Lower-case extensions without the dot (1 to 8 letters/digits). */
  extensions: string[];
}

interface CpSaveAsOptions {
  filters?: CpSaveAsFilter[];
  /** The chosen file must differ from this path (used so a PDF never overwrites its original). */
  avoidPath?: string | null;
}

interface CpReadTextOptions {
  /** Forces decoding with this encoding id instead of detecting it. */
  encoding?: string | null;
}

interface CpReadTextTooLarge {
  path: string;
  tooLarge: true;
  size: number;
  binary?: undefined;
  content?: undefined;
}
interface CpReadTextBinary {
  path: string;
  binary: true;
  size: number;
  tooLarge?: undefined;
  content?: undefined;
}
interface CpReadTextOk {
  path: string;
  encoding: string;
  content: string;
  /** True when the decoded text contains U+FFFD (wrong guess or damaged bytes). */
  replaced: boolean;
  mtimeMs: number;
  size: number;
  tooLarge?: undefined;
  binary?: undefined;
}
type CpReadTextResult = CpReadTextTooLarge | CpReadTextBinary | CpReadTextOk;

interface CpReadBinaryTooLarge {
  path: string;
  size: number;
  tooLarge: true;
  bytes?: undefined;
  mtimeMs?: undefined;
}
interface CpReadBinaryOk {
  path: string;
  size: number;
  mtimeMs: number;
  bytes: Uint8Array;
  tooLarge?: undefined;
}
type CpReadBinaryResult = CpReadBinaryTooLarge | CpReadBinaryOk;

interface CpWriteOptions {
  /** Write even when characters cannot be represented in the encoding. */
  allowLossy?: boolean;
}

interface CpFileStamp {
  mtimeMs: number;
  size: number;
}

type CpWriteTextResult =
  | ({ ok: true } & CpFileStamp)
  | { ok: false; lossy: true; firstBad: number; badChar: string };

interface CpDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface CpStatResult {
  exists: boolean;
  isFile: boolean;
  mtimeMs: number;
  size: number;
}

interface CpHashResult {
  hex: string;
  size: number;
}

interface CpAppInfo {
  version: string;
}

// ---------- Encodings ----------

interface CpEncodingInfo {
  id: string;
  label: string;
  group: string;
  bom: boolean;
}

interface CpEncodableCheck {
  lossy: boolean;
  /** UTF-16 index of the first unrepresentable character, -1 when lossless. */
  firstBad: number;
  badChar: string;
  count: number;
}

// ---------- Settings and commands ----------

interface CpSettingsState {
  values: SettingsValues;
  /** True until the first patch when no settings file existed (drives the localStorage migration). */
  fresh: boolean;
}

/** One entry of the command table as the renderer sees it (keybinding overrides applied, roles left out). */
interface CpCommandInfo {
  id: string;
  title: string;
  menu: string;
  accelerator: string;
  defaultAccelerator: string;
  when: 'any' | 'text';
  palette: boolean;
}

// ---------- Recent files, macros ----------

interface CpRecentItem {
  path: string;
  openedAt: number;
  name: string;
}

type CpMacroStep =
  | { t: 'type'; text: string }
  | { t: 'key'; key: string }
  | { t: 'cmd'; id: string; args?: Record<string, unknown> };

interface CpMacro {
  name: string;
  steps: CpMacroStep[];
}

// ---------- Sessions ----------

type CpTabKind = 'text' | 'docx' | 'sheet' | 'pdf';

/** A tab as stored in (and restored from) a session. Text-only fields are absent on document tabs. */
interface CpSessionTab {
  kind: CpTabKind;
  /** Opaque, module-defined unsaved edits of a document tab (null when none or dropped for size). */
  state: Record<string, unknown> | null;
  stateTooLarge: boolean;
  path: string | null;
  name: string;
  pinned: boolean;
  color: number;
  active: boolean;
  encoding?: string;
  eol?: 'lf' | 'crlf' | 'cr' | null;
  language?: string | null;
  autoDetect?: boolean;
  /** null: the tab matches the file on disk; a string: unsaved text to restore. */
  content?: string | null;
  viewState?: Record<string, unknown> | null;
  readOnly?: boolean;
  monitor?: boolean;
  bookmarks?: number[];
}

/** What the renderer sends to save a session; main validates every field and drops what it does not accept. */
interface CpSessionSnapshot {
  tabs: Array<Partial<CpSessionTab>>;
}

/** A restorable session returned by main (paths re-approved by main only when the signature was valid). */
interface CpSessionRestore {
  root: string | null;
  tabs: CpSessionTab[];
  /** 'ok' or 'failed' (bad signature: paths and folder were dropped). */
  integrity: 'ok' | 'failed';
}

interface CpNamedSession {
  id: string;
  name: string;
  savedAt: number;
  tabCount: number;
}

// ---------- Find in Files and file watching ----------

interface CpSearchStartOptions {
  query: string;
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  extended?: boolean;
  dotAll?: boolean;
  /** Name globs (letters, digits and _ . * ? -). */
  include?: string[];
  /** Folder/file names to skip. */
  exclude?: string[];
  includeHidden?: boolean;
  maxResults?: number;
  maxFileKB?: number;
  /** Relative folder inside the opened folder. */
  subPath?: string;
}

interface CpSearchMatch {
  line: number;
  col: number;
  length: number;
  preview: string;
  previewStart: number;
}

interface CpSearchFileMatches {
  path: string;
  rel: string;
  matches: CpSearchMatch[];
}

interface CpSearchTotals {
  filesScanned: number;
  filesMatched: number;
  matchCount: number;
  skippedBinary: number;
  skippedLarge: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

/** Messages of the Find in Files worker, before main adds the `searchId`. */
type CpSearchWorkerMessage =
  | { type: 'progress'; filesScanned: number; matchCount: number }
  | { type: 'matches'; files: CpSearchFileMatches[] }
  | { type: 'done'; totals: CpSearchTotals }
  | { type: 'error'; message: string };

/** Events delivered through `codepad.search.onEvent`. */
type CpSearchEvent = CpSearchWorkerMessage & { searchId: string };

interface CpWatchEvent {
  path: string;
  kind: 'changed' | 'deleted' | 'renamed';
  mtimeMs: number;
  size: number;
}

// ---------- Other main -> renderer events ----------

interface CpCommandEvent {
  id: string;
}

interface CpOpenPathsEvent {
  /** Already approved by main. */
  paths: string[];
  line?: number;
}

// ---------- AI ----------

/** `{ok:false}` result of a model operation: code and short message only. */
interface CpAiFailure {
  ok: false;
  code: string;
  message: string;
}
type CpAiResult<T extends object = object> = ({ ok: true } & T) | CpAiFailure;

interface CpAiModelError {
  code: string;
  message: string;
}

interface CpAiModelStatus {
  state: 'checking' | 'missing' | 'downloading' | 'verifying' | 'paused' | 'offline' | 'ready' | 'error';
  modelId: string | null;
  bytes: number;
  total: number;
  bytesPerSec: number;
  etaSec: number | null;
  /** Another process holds the download. */
  external: boolean;
  error: CpAiModelError | null;
}

interface CpAiEngineState {
  /** 'off' (not loaded), 'loading', 'ready', 'busy' (a summary runs) or 'error'. */
  state: 'off' | 'loading' | 'ready' | 'busy' | 'error';
  error: string | null;
  gpu: boolean | null;
  threads: number | null;
  modelId: string | null;
}

interface CpAiStatus {
  model: CpAiModelStatus;
  engine: CpAiEngineState;
  enabled: boolean;
  summary: { running: boolean; jobId: number | null };
}

type CpAiModelKind = 'builtin' | 'gguf-file' | 'ollama-registry' | 'huggingface' | 'anthropic' | 'openai-compatible';

/** A selectable summary model as listed by main (no secrets, no paths). */
interface CpAiModelEntry {
  id: string;
  kind: CpAiModelKind;
  label: string;
  modelName: string;
  baseUrl: string;
  enabled: boolean;
  builtin: boolean;
  active: boolean;
  hasKey: boolean;
  keyHint: string;
  consent: boolean;
  contextTokens: number;
  state: 'ready' | 'disabled' | 'needsKey' | 'needsConsent' | 'missingFile';
}

interface CpAiSuggestRequest {
  reqId: number;
  prefix: string;
  suffixLine: string;
  /** Text after the cursor line, to the end of the enclosing block (capped); only used to avoid repeating it. */
  suffix: string;
  /** Import lines (code) or front matter plus nearest heading (prose) above the prefix window. */
  header: string;
  /** Enclosing declarations above the prefix window (code only). */
  scope: string;
  languageId: string;
  multiline: boolean;
}

interface CpAiSuggestResult {
  reqId: number;
  text: string | null;
}

interface CpAiSummarizeRequest {
  text: string;
  name: string;
  scope: 'file' | 'selection';
}

/** Result of `ai.summarize`: progress and the final text arrive as `summary` events with the `jobId`. */
type CpAiSummarizeResult =
  | { tooLarge: true; max: number }
  | { empty: true }
  | { busy: true }
  | { jobId: number; cached: boolean };

interface CpAiRewriteRequest {
  text: string;
  name: string;
  mode: 'grammar' | 'restructure';
  /** Restructure only, at most 500 characters. */
  instruction?: string;
  languageId: string;
}

interface CpAiChatTurn {
  role: 'user' | 'assistant';
  /** At most 4000 characters. */
  content: string;
}

/**
 * `output: 'answer'` is a reply for the transcript; `'file'` is the complete new content of a file and nothing else.
 * Failures (`busy`, `empty`, `tooLarge`, `invalid`) come back as `{ok:false, code, message}`.
 */
interface CpAiChatRequest {
  /** 1 to 2000 characters. */
  instruction: string;
  /** At most 120 characters. */
  fileName?: string;
  /** The current file, at most 60000 characters; a local model reads a head and tail excerpt of it. */
  fileText?: string;
  /** The last messages, oldest first, at most 8. */
  history?: CpAiChatTurn[];
  output: 'answer' | 'file' | 'write';
}

interface CpAiModelSpec {
  kind: Exclude<CpAiModelKind, 'builtin' | 'ollama-registry'>;
  label?: string;
  modelName?: string;
  baseUrl?: string;
  contextTokens?: number;
  enabled?: boolean;
}

interface CpAiModelPatch {
  label?: string;
  modelName?: string;
  baseUrl?: string;
  contextTokens?: number;
}

interface CpAiPullRequest {
  /** Ollama `name:tag`, for example llama3.1:8b. */
  modelName: string;
  label?: string;
  contextTokens?: number;
}

interface CpAiPullProgress {
  state: 'downloading' | 'verifying' | 'done' | 'cancelled' | 'error';
  bytes?: number;
  total?: number;
  bytesPerSec?: number;
  etaSec?: number | null;
  /** Set with state 'done'. */
  modelId?: string;
  /** Set with state 'error'. */
  code?: string;
  message?: string;
}

/** Events of an `ai.chat` job, like rewrite events; phase 'done' carries the whole answer (or whole new file) in `text`. */
interface CpAiChatEvent {
  type: 'chat';
  jobId: number;
  phase: 'loading' | 'progress' | 'consentRequired' | 'modelFailed' | 'done' | 'error' | 'cancelled';
  current?: number;
  total?: number;
  /** Set with phase 'done'. */
  text?: string;
  /** Set with phase 'done', for example that only an excerpt of the file was read. */
  warnings?: string[];
  /** consentRequired / modelFailed. */
  modelId?: string | null;
  label?: string;
  code?: string;
  message?: string;
}

type CpAiEvent =
  | { type: 'model'; status: CpAiModelStatus }
  | { type: 'engine'; state: CpAiEngineState }
  | { type: 'models'; models: CpAiModelEntry[] }
  | {
      type: 'summary';
      jobId: number;
      /** extract | map | reduce | final | verify | done | cancelled | error | consentRequired | modelFailed. */
      phase: string;
      current?: number;
      total?: number;
      markdown?: string;
      cached?: boolean;
      /** consentRequired / modelFailed. */
      modelId?: string | null;
      label?: string;
      code?: string;
      message?: string;
    }
  | {
      type: 'rewrite';
      jobId: number;
      phase: 'loading' | 'progress' | 'consentRequired' | 'modelFailed' | 'done' | 'error' | 'cancelled';
      current?: number;
      total?: number;
      /** Set with phase 'done': the full new text. */
      text?: string;
      warnings?: string[];
      changes?: number;
      /** consentRequired / modelFailed. */
      modelId?: string | null;
      label?: string;
      code?: string;
      message?: string;
    }
  | CpAiChatEvent
  | { type: 'pull'; id: string; progress: CpAiPullProgress };

// ---------- Chat file operations ----------

/** A refused or failed `files:*` operation; `message` is meant for the user. */
interface CpFileOpFailure {
  ok: false;
  code: string;
  message: string;
  /** Set when the user answered No in the delete confirmation. */
  cancelled?: boolean;
}
type CpFileOpResult<T extends object = object> = ({ ok: true } & T) | CpFileOpFailure;

// ---------- Spelling ----------

interface CpSpellMisspelling {
  word: string;
  /** At most 5; empty when main skipped them for speed (ask again with that single word). */
  suggestions: string[];
}

interface CpSpellCheckResult {
  misspelled: CpSpellMisspelling[];
}

// ---------- Channel contract ----------

interface CpChannel<A extends unknown[], R> {
  args: A;
  result: R;
}

interface CpIpcChannels {
  'dialog:openFiles': CpChannel<[], string[]>;
  'dialog:openFolder': CpChannel<[], string | null>;
  'dialog:saveAs': CpChannel<[defaultPath?: string, options?: CpSaveAsOptions], string | null>;
  /** Result: 0 Save, 1 Don't Save, 2 Cancel. */
  'dialog:confirmClose': CpChannel<[name: string, kind?: string], number>;
  'fs:read': CpChannel<[path: string, options?: CpReadTextOptions], CpReadTextResult>;
  'fs:readBinary': CpChannel<[path: string], CpReadBinaryResult>;
  'fs:writeBinary': CpChannel<[path: string, bytes: ArrayBufferView | ArrayBuffer], CpFileStamp>;
  'fs:write': CpChannel<
    [path: string, content: string, encoding?: string, options?: CpWriteOptions],
    CpWriteTextResult
  >;
  'fs:readDir': CpChannel<[path: string], CpDirEntry[]>;
  'fs:stat': CpChannel<[path: string], CpStatResult>;
  'fs:isSameFile': CpChannel<[approvedPath: string, otherPath: string], boolean>;
  'fs:hash': CpChannel<[path: string, algo: string], CpHashResult>;
  'fs:approveDropped': CpChannel<[path: string], void>;
  'shell:reveal': CpChannel<[path: string], void>;
  'app:info': CpChannel<[], CpAppInfo>;
  'encoding:list': CpChannel<[], readonly CpEncodingInfo[]>;
  'encoding:check': CpChannel<[content: string, encodingId: string], CpEncodableCheck>;
  'settings:get': CpChannel<[], CpSettingsState>;
  'settings:set': CpChannel<[patch: Partial<SettingsValues>], SettingsValues>;
  'commands:table': CpChannel<[], CpCommandInfo[]>;
  'recent:list': CpChannel<[], CpRecentItem[]>;
  'recent:add': CpChannel<[path: string], void>;
  /** Approves the file at a position of main's own list and resolves with its real path. */
  'recent:approveAt': CpChannel<[index: number], string>;
  'recent:clear': CpChannel<[], void>;
  'macros:get': CpChannel<[], CpMacro[]>;
  'macros:set': CpChannel<[list: CpMacro[]], CpMacro[]>;
  /** Result: indexes of tabs whose unsaved document state could not be stored. */
  'session:save': CpChannel<[snapshot: CpSessionSnapshot], number[]>;
  'session:load': CpChannel<[], CpSessionRestore | null>;
  'sessions:list': CpChannel<[], CpNamedSession[]>;
  'sessions:save': CpChannel<[name: string, snapshot: CpSessionSnapshot], { id: string }>;
  'sessions:load': CpChannel<[id: string], CpSessionRestore | null>;
  'sessions:delete': CpChannel<[id: string], void>;
  'window:setFullScreen': CpChannel<[value: boolean], void>;
  'window:setAlwaysOnTop': CpChannel<[value: boolean], void>;
  'search:start': CpChannel<[options: CpSearchStartOptions], { searchId: string }>;
  'search:cancel': CpChannel<[searchId: string], boolean>;
  'watch:add': CpChannel<[path: string], { ok: boolean }>;
  'watch:remove': CpChannel<[path: string], { ok: true }>;
  /** Up to 2000 words of at most 64 characters each. */
  'spell:check': CpChannel<[words: string[]], CpSpellCheckResult>;
  'spell:addWord': CpChannel<[word: string], { ok: boolean }>;

  'ai:getStatus': CpChannel<[], CpAiStatus>;
  'ai:model:download': CpChannel<[], CpAiResult>;
  'ai:model:pause': CpChannel<[], CpAiResult>;
  'ai:model:resume': CpChannel<[], CpAiResult>;
  'ai:model:cancel': CpChannel<[], CpAiResult>;
  'ai:model:delete': CpChannel<[], CpAiResult>;
  'ai:model:checkConnection': CpChannel<[], { online: true } | { online: false; error?: string }>;
  'ai:suggest': CpChannel<[request: CpAiSuggestRequest], CpAiSuggestResult>;
  'ai:suggest:cancel': CpChannel<[reqId: number], boolean>;
  'ai:summarize': CpChannel<[request: CpAiSummarizeRequest], CpAiSummarizeResult>;
  'ai:summarize:cancel': CpChannel<[jobId: number], boolean>;
  'ai:summaryCache:clear': CpChannel<[], { removed: number }>;
  'ai:summarize:retryDefault': CpChannel<[jobId: number], CpAiResult>;
  'ai:rewrite:start': CpChannel<[request: CpAiRewriteRequest], CpAiResult<{ jobId: number }>>;
  'ai:rewrite:cancel': CpChannel<[jobId: number], boolean>;
  'ai:chat:start': CpChannel<[request: CpAiChatRequest], CpAiResult<{ jobId: number }>>;
  'ai:chat:cancel': CpChannel<[jobId: number], boolean>;
  /** Creates a new file (never overwrites) inside the opened folder; the path is approved afterwards. */
  'files:create': CpChannel<[path: string, content: string], CpFileOpResult<{ path: string }>>;
  /** `newName` is a bare file name; the file stays in its folder and nothing is overwritten. */
  'files:rename': CpChannel<[path: string, newName: string], CpFileOpResult<{ path: string }>>;
  /** Main asks Yes/No in a native box, then moves the file to the OS trash. */
  'files:trash': CpChannel<[path: string], CpFileOpResult>;
  'ai:models:list': CpChannel<[], { ok: true; models: CpAiModelEntry[] }>;
  /** A `gguf-file` spec opens a native file dialog in main; the path never reaches the renderer. */
  'ai:models:add': CpChannel<[spec: CpAiModelSpec], CpAiResult<{ model: CpAiModelEntry }>>;
  'ai:models:update': CpChannel<[id: string, patch: CpAiModelPatch], CpAiResult<{ model: CpAiModelEntry }>>;
  'ai:models:remove': CpChannel<[id: string], CpAiResult>;
  'ai:models:setEnabled': CpChannel<[id: string, enabled: boolean], CpAiResult>;
  /** `null` selects the built-in model. */
  'ai:models:setActive': CpChannel<[id: string | null], CpAiResult>;
  /** Write-only; an empty key removes the stored one. */
  'ai:models:setKey': CpChannel<[id: string, key: string], CpAiResult>;
  'ai:models:test': CpChannel<[id: string], CpAiResult>;
  'ai:models:consent': CpChannel<[id: string, granted?: boolean], CpAiResult>;
  'ai:models:pull': CpChannel<[request: CpAiPullRequest], CpAiResult>;
  'ai:models:pull:cancel': CpChannel<[modelName: string], boolean>;
}

/** A function that invokes channel `C`. */
type CpInvoke<C extends keyof CpIpcChannels> = (
  ...args: CpIpcChannels[C]['args']
) => Promise<CpIpcChannels[C]['result']>;

/** Subscribes to a main -> renderer event; the callback receives the payload only (there is no unsubscribe). */
type CpSubscribe<T> = (callback: (payload: T) => void) => void;

// ---------- window.codepad ----------

interface CodePadApi {
  openFiles: CpInvoke<'dialog:openFiles'>;
  openFolder: CpInvoke<'dialog:openFolder'>;
  saveAsDialog: CpInvoke<'dialog:saveAs'>;
  confirmClose: CpInvoke<'dialog:confirmClose'>;
  readFile: CpInvoke<'fs:read'>;
  readBinary: CpInvoke<'fs:readBinary'>;
  writeBinary: CpInvoke<'fs:writeBinary'>;
  writeFile: CpInvoke<'fs:write'>;
  readDir: CpInvoke<'fs:readDir'>;
  appInfo: CpInvoke<'app:info'>;
  statFile: CpInvoke<'fs:stat'>;
  isSameFile: CpInvoke<'fs:isSameFile'>;
  hashFile: CpInvoke<'fs:hash'>;
  reveal: CpInvoke<'shell:reveal'>;
  saveSession: CpInvoke<'session:save'>;
  loadSession: CpInvoke<'session:load'>;
  /** Grants access to a dropped File object (only real, user-dropped files have a path); resolves with the path. */
  approveDropped: (file: File) => Promise<string>;
  approveClose: () => void;
  /** Tells main the user cancelled the close, so a later approval is not honored without a new request. */
  cancelClose: () => void;
  /** Tells main the session restore finished, so queued command-line files can be opened. */
  ready: () => void;
  encodings: { list: CpInvoke<'encoding:list'>; check: CpInvoke<'encoding:check'> };
  search: {
    start: CpInvoke<'search:start'>;
    cancel: CpInvoke<'search:cancel'>;
    onEvent: CpSubscribe<CpSearchEvent>;
  };
  watch: {
    add: CpInvoke<'watch:add'>;
    remove: CpInvoke<'watch:remove'>;
    onEvent: CpSubscribe<CpWatchEvent>;
  };
  files: { create: CpInvoke<'files:create'>; rename: CpInvoke<'files:rename'>; trash: CpInvoke<'files:trash'> };
  spell: { check: CpInvoke<'spell:check'>; addWord: CpInvoke<'spell:addWord'> };
  settings: { get: CpInvoke<'settings:get'>; patch: CpInvoke<'settings:set'> };
  commands: { table: CpInvoke<'commands:table'> };
  recent: {
    list: CpInvoke<'recent:list'>;
    add: CpInvoke<'recent:add'>;
    approveAt: CpInvoke<'recent:approveAt'>;
    clear: CpInvoke<'recent:clear'>;
  };
  macros: { get: CpInvoke<'macros:get'>; set: CpInvoke<'macros:set'> };
  sessions: {
    list: CpInvoke<'sessions:list'>;
    save: CpInvoke<'sessions:save'>;
    load: CpInvoke<'sessions:load'>;
    delete: CpInvoke<'sessions:delete'>;
  };
  window: {
    setFullScreen: CpInvoke<'window:setFullScreen'>;
    setAlwaysOnTop: CpInvoke<'window:setAlwaysOnTop'>;
  };
  ai: {
    status: CpInvoke<'ai:getStatus'>;
    onEvent: CpSubscribe<CpAiEvent>;
    model: {
      download: CpInvoke<'ai:model:download'>;
      pause: CpInvoke<'ai:model:pause'>;
      resume: CpInvoke<'ai:model:resume'>;
      cancel: CpInvoke<'ai:model:cancel'>;
      remove: CpInvoke<'ai:model:delete'>;
      checkConnection: CpInvoke<'ai:model:checkConnection'>;
    };
    suggest: CpInvoke<'ai:suggest'>;
    cancelSuggest: CpInvoke<'ai:suggest:cancel'>;
    summarize: CpInvoke<'ai:summarize'>;
    cancelSummary: CpInvoke<'ai:summarize:cancel'>;
    clearSummaryCache: CpInvoke<'ai:summaryCache:clear'>;
    retryDefault: CpInvoke<'ai:summarize:retryDefault'>;
    rewrite: CpInvoke<'ai:rewrite:start'>;
    cancelRewrite: CpInvoke<'ai:rewrite:cancel'>;
    chat: CpInvoke<'ai:chat:start'>;
    cancelChat: CpInvoke<'ai:chat:cancel'>;
    models: {
      list: CpInvoke<'ai:models:list'>;
      add: CpInvoke<'ai:models:add'>;
      update: CpInvoke<'ai:models:update'>;
      remove: CpInvoke<'ai:models:remove'>;
      setEnabled: CpInvoke<'ai:models:setEnabled'>;
      setActive: CpInvoke<'ai:models:setActive'>;
      setKey: CpInvoke<'ai:models:setKey'>;
      test: CpInvoke<'ai:models:test'>;
      consent: CpInvoke<'ai:models:consent'>;
      pull: CpInvoke<'ai:models:pull'>;
      cancelPull: CpInvoke<'ai:models:pull:cancel'>;
    };
  };
  onCommand: CpSubscribe<CpCommandEvent>;
  onOpenPaths: CpSubscribe<CpOpenPathsEvent>;
  onRequestClose: (callback: () => void) => void;
}

/** `window.codepadInstall`, exposed by src/preloadInstall.ts to the model-install window only. */
interface CodePadInstallApi {
  onProgress: CpSubscribe<Omit<CpAiModelStatus, 'modelId'>>;
  cancel: () => void;
}

interface Window {
  codepad: CodePadApi;
  codepadInstall: CodePadInstallApi;
}
