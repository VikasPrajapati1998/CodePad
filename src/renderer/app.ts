(() => {
  const api = window.codepad;
  const bus = window.CodePadBus;
  const appSettings = window.CodePadSettings;
  const schema = window.CodePadSettingsSchema;
  const themes = window.CodePadThemes;
  const panelsHost = window.CodePadPanels;
  const commandRegistry = window.CodePadCommands;
  const ui = window.CodePadUI;

  // The app root (the folder holding node_modules/) is two levels above dist/renderer/.
  const baseUrl = new URL('../..', window.location.href).href.replace(/\/$/, '');
  const monacoBase = `${baseUrl}/node_modules/monaco-editor/min`;

  // Monaco workers must be bootstrapped through a data: URL when loaded from file://.
  window.MonacoEnvironment = {
    getWorkerUrl: () =>
      `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:${JSON.stringify(`${monacoBase}/`)}};` +
          `importScripts(${JSON.stringify(`${monacoBase}/vs/base/worker/workerMain.js`)});`,
      )}`,
  };

  // Extensions Monaco has no language entry for, mapped to the closest one.
  const EXTRA_EXTENSIONS: Record<string, string> = {
    '.toml': 'ini',
    '.env': 'ini',
    '.vue': 'html',
    '.svelte': 'html',
  };

  // localStorage keys of earlier versions; their values move into the settings store on the first start.
  const LEGACY_SETTINGS = ['theme', 'minimap', 'wordWrap', 'sidebar'];
  const EOL_LABELS: Record<CodePadEol, string> = { lf: 'LF', crlf: 'CRLF', cr: 'CR' };
  // Encodings that automatic detection recognizes by themselves; any other saved encoding is re-read explicitly.
  const AUTO_DETECTED_ENCODINGS = new Set(['utf8', 'utf8bom', 'utf16le', 'utf16be']);

  /** The element of a fixed id in index.html (the page always contains them). */
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

  /** The message of a caught value, whatever was thrown. */
  const errorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String(error.message);
    }
    return String(error);
  };

  const els = {
    statusBar: byId('statusbar'),
    folderName: byId('folder-name'),
    fileTree: byId('file-tree'),
    tabs: byId('tabs'),
    editor: byId('editor'),
    views: byId('views'),
    welcome: byId('welcome'),
    message: byId('status-message'),
    info: byId('status-info'),
    pos: byId('status-pos'),
    eol: byId('status-eol'),
    encoding: byId('status-encoding'),
    lang: byId<HTMLSelectElement>('status-lang'),
  };

  // Document kinds are opened by an editor module (renderer/editors/*); everything else is a Monaco text tab.
  const KIND_BY_EXTENSION: Record<string, CodePadDocumentKind> = {
    '.docx': 'docx',
    '.xlsx': 'sheet',
    '.xls': 'sheet',
    '.ods': 'sheet',
    '.csv': 'sheet',
    '.tsv': 'sheet',
    '.pdf': 'pdf',
  };
  const NOT_AVAILABLE_MESSAGE = 'Not available for this file type.';

  const SESSION_SAVE_DELAY_MS = 800;
  const LANGUAGE_DETECT_DELAY_MS = 400;
  // Content sniffing looks at (at most) this much text, and scores patterns on the first SNIFF_SAMPLE_CHARS of it.
  const SNIFF_MAX_CHARS = 1000000;
  // Both caps keep the scoring patterns cheap on hostile text (R-01): few lines, short lines, no whitespace-only runs.
  const SNIFF_SAMPLE_CHARS = 4096;
  const SNIFF_LINE_CHARS = 300;
  const SNIFF_MIN_SCORE = 3;

  // Crash-loop guard (R-02): set while a document tab is being rebuilt from a session; a value left over from the
  // previous run means that run died while parsing, so document tabs are not auto-restored this time.
  const RESTORE_MARKER_KEY = 'codepad.restoring';

  const platform = /Win/i.test(navigator.platform) ? 'win32' : /Mac/i.test(navigator.platform) ? 'darwin' : 'linux';

  type MonacoNamespace = typeof window.monaco;
  type BooleanSettingKey = { [K in SettingKey]: SettingsValues[K] extends boolean ? K : never }[SettingKey];

  /** Options of createTab (a Monaco text tab). */
  interface TextTabOptions {
    filePath?: string | null;
    name?: string;
    content: string;
    encoding?: string;
    eol?: CodePadEol;
    language?: string | null;
    autoDetect?: boolean;
    persist?: Partial<CodePadTabPersist>;
    diskStat?: CodePadDiskStat | null;
  }

  /** Options of createViewTab (a tab backed by an editor module). */
  interface ViewTabOptions {
    kind: CodePadViewKind;
    filePath?: string | null;
    name: string;
    bytes?: Uint8Array | null;
    restoredState?: object | null;
    params?: object;
    diskStat?: CodePadDiskStat | null;
  }
  type DocumentTabOptions = ViewTabOptions & { kind: CodePadDocumentKind };

  /** A view tab while its editor module is still creating the view. */
  type PendingViewTab = Omit<CodePadViewTab, 'view'> & { view: CodePadEditorView | null };

  /** The tabs a session keeps (everything but the compare view). */
  type SessionTab = CodePadTextTab | CodePadDocumentTab;

  /** A session as handed to restoreSnapshot (`integrity` is only set by main on a loaded session). */
  interface SessionToRestore {
    root?: string | null;
    tabs: CpSessionTab[];
    integrity?: 'ok' | 'failed';
  }

  /**
   * kind 'text' tabs own a Monaco model (autoDetect: the language follows the content, for untitled tabs,
   * until the user picks one by hand); document kinds and 'diff' own a `view` (editor module) rendered inside `host`.
   * `persist` (not on 'diff' tabs) holds the user-visible state that sessions keep; `diskStat` is the file's
   * mtime/size as last read or written by this app.
   */
  const tabs: CodePadTab[] = [];
  let activeTab: CodePadTab | null = null;
  let nextId = 1;
  // Assigned in init() before anything reads them (the AMD loader delivers Monaco asynchronously).
  let monaco!: MonacoNamespace;
  let editor!: monaco.editor.IStandaloneCodeEditor;
  let ctx: CodePadCtx | null = null;
  let extensionMap = new Map<string, string>();
  let filenameMap = new Map<string, string>();
  let languageIds = new Set<string>();
  let sessionTimer: number | undefined;
  let sessionRestored: Promise<void> = Promise.resolve();
  let appVersion = '';
  const encodingLabels = new Map<string, string>();
  // Tab bar extension points (ctx.tabs.decorate / onContextMenu / interceptClose).
  const tabDecorators: Parameters<CodePadTabsApi['decorate']>[0][] = [];
  const closeInterceptors: Parameters<CodePadTabsApi['interceptClose']>[0][] = [];
  let tabContextMenuHandler: Parameters<CodePadTabsApi['onContextMenu']>[0] | null = null;
  /** Functions returning extra tab context-menu items (ctx.tabs.contributeMenu). */
  const menuContributors: Parameters<CodePadTabsApi['contributeMenu']>[0][] = [];
  /** Status bar buttons added by features (ctx.status.addItem), ordered by their `order`. */
  const statusItems: { order: number; button: HTMLButtonElement }[] = [];

  const baseName = (p: string): string => p.split(/[\\/]/).pop() as string;

  const extensionOf = (p: string): string => {
    const name = baseName(p).toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
  };

  const kindForPath = (p: string): CodePadDocumentKind | 'text' => KIND_BY_EXTENSION[extensionOf(p)] || 'text';

  // File names reach the UI only through shown() (bidi/control characters removed, R-06).
  const shown = (name: string): string => CodePadSearchCore.displayName(name);

  function setStatus(text: string): void {
    els.message.textContent = shown(text);
  }

  /** Language for a path by file name or extension, or null when neither is known. */
  function detectLanguage(filePath: string): string | null {
    const name = baseName(filePath).toLowerCase();
    if (filenameMap.has(name)) {
      return filenameMap.get(name) as string;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    return extensionMap.get(ext) || EXTRA_EXTENSIONS[ext] || null;
  }

  // ---------- Content-based language detection ----------

  const SHEBANG_LANGUAGES: [RegExp, string][] = [
    [/\bpython[\d.]*\b/, 'python'],
    [/\b(?:node|deno|bun)\b/, 'javascript'],
    [/\b(?:ba|z|k|da)?sh\b/, 'shell'],
    [/\bruby\b/, 'ruby'],
    [/\bperl\b/, 'perl'],
    [/\bphp\b/, 'php'],
    [/\b(?:pwsh|powershell)\b/, 'powershell'],
  ];

  const JAVASCRIPT_PATTERNS: [RegExp, number][] = [
    [/\bfunction\s*\*?\s*\w*\s*\(/, 2],
    [/=>\s*[{(]|\)\s*=>/, 2],
    [/\bconsole\.(?:log|error|warn|info)\(/, 3],
    [/\brequire\(['"]|\bmodule\.exports\b|^[ \t]*export\s+(?:default|const|function|class)\b/m, 3],
    [/^[ \t]*import\s+.+\s+from\s+['"]/m, 3],
    [/^[ \t]*(?:const|let|var)\s+[\w${}[\], \t]{1,200}=/m, 1],
    [/\b(?:document|window)\.\w+/, 1],
  ];

  // Order matters: on equal scores the earlier language wins.
  const CONTENT_RULES: { id: string; patterns: [RegExp, number][] }[] = [
    { id: 'html', patterns: [
      [/<!doctype\s+html/i, 10],
      [/<html[\s>]/i, 8],
      [/<\/(?:div|p|a|span|body|head|ul|li|table|h[1-6]|script|style)>/i, 3],
      [/<(?:div|span|body|head|meta|link|script|style|img|br|input|button|ul|li|table|h[1-6])\b[^>]*>/i, 3],
    ] },
    { id: 'xml', patterns: [
      [/^[ \t]*<\?xml\b/, 10],
      [/^[ \t]*<([A-Za-z_][\w:.-]*)(?:\s[^>]{0,300})?>[\s\S]{0,3500}?<\/\1>/, 4],
    ] },
    { id: 'php', patterns: [
      [/<\?php/, 10],
      [/\$this->\w+/, 2],
      [/\bfunction\s+\w+\s*\(\s*\$/, 2],
    ] },
    { id: 'sql', patterns: [
      [/^[ \t]*select\s+[\s\S]{1,1000}?\bfrom\b/im, 4],
      [/^[ \t]*insert\s+into\s+\S+/im, 4],
      [/^[ \t]*update\s+\S+\s+set\b/im, 4],
      [/^[ \t]*delete\s+from\s+\S+/im, 4],
      [/^[ \t]*create\s+(?:or\s+replace\s+)?(?:table|view|index|database|procedure|function)\b/im, 5],
      [/^[ \t]*alter\s+table\b/im, 5],
      [/\b(?:where|group\s+by|order\s+by|inner\s+join|left\s+join)\b/i, 1],
    ] },
    { id: 'dockerfile', patterns: [
      [/^FROM\s+\S+/m, 5],
      [/^(?:RUN|CMD|COPY|ENTRYPOINT|WORKDIR|EXPOSE|ENV)\s+\S/m, 3],
    ] },
    { id: 'python', patterns: [
      [/^[ \t]*def\s+\w+\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$/m, 3],
      [/^[ \t]*class\s+\w+(?:\([^)]*\))?\s*:\s*$/m, 3],
      [/^[ \t]*(?:from\s+[\w.]+\s+import\s+\S|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$)/m, 2],
      [/^[ \t]*if\s+__name__\s*==/m, 4],
      [/^[ \t]*(?:elif\b.*|else|try|except\b.*|finally)\s*:\s*$/m, 1],
      [/\bself\.\w+/, 1],
      [/^[ \t]*print\(/m, 1],
    ] },
    { id: 'javascript', patterns: JAVASCRIPT_PATTERNS },
    { id: 'typescript', patterns: [
      ...JAVASCRIPT_PATTERNS,
      [/^[ \t]*(?:export\s+)?interface\s+\w+/m, 3],
      [/^[ \t]*(?:export\s+)?type\s+\w+\s*=/m, 3],
      [/[\w)]\s*:\s*(?:string|number|boolean|void|any|unknown)\b/, 2],
      [/\bas\s+(?:string|number|const|any|unknown)\b/, 1],
    ] },
    { id: 'java', patterns: [
      [/^[ \t]*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+\w+/m, 4],
      [/\bSystem\.out\.print/, 4],
      [/^[ \t]*import\s+javax?\./m, 4],
      [/public\s+static\s+void\s+main\s*\(/, 4],
      [/^[ \t]*package\s+[\w.]+;/m, 2],
      [/@Override\b/, 2],
    ] },
    { id: 'csharp', patterns: [
      [/^[ \t]*using\s+System[\w.]*;/m, 4],
      [/\bConsole\.Write(?:Line)?\(/, 4],
      [/^[ \t]*namespace\s+[\w.]+/m, 2],
      [/\b(?:public|private|internal)\s+(?:static\s+)?(?:async\s+)?(?:class|void|string|int|Task)\b/, 1],
    ] },
    { id: 'c', patterns: [
      [/^[ \t]*#include\s*<(?:stdio|stdlib|string|stdint|unistd)\.h>/m, 5],
      [/\bint\s+main\s*\(/, 3],
      [/\bprintf\s*\(/, 2],
      [/\bmalloc\s*\(/, 2],
      [/^[ \t]*#define\s+\w+/m, 1],
    ] },
    { id: 'cpp', patterns: [
      [/^[ \t]*#include\s*<(?:iostream|vector|string|map|memory|algorithm)>/m, 5],
      [/\busing\s+namespace\s+std;/, 4],
      [/\bstd::\w+/, 3],
      [/\bcout\s*<</, 3],
      [/\btemplate\s*<.*>/, 3],
      [/\bint\s+main\s*\(/, 3],
    ] },
    { id: 'go', patterns: [
      [/^[ \t]*func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/m, 4],
      [/\bfmt\.Print/, 4],
      [/^[ \t]*package\s+\w+\s*$/m, 3],
      [/^[ \t]*import\s+(?:\(|")/m, 2],
      [/:=/, 1],
    ] },
    { id: 'rust', patterns: [
      [/^[ \t]*fn\s+\w+\s*(?:<[^>]*>)?\s*\(/m, 4],
      [/\blet\s+mut\s+\w+/, 4],
      [/^[ \t]*use\s+(?:std|crate|super)::/m, 4],
      [/\bprintln!\s*\(/, 4],
      [/^[ \t]*(?:pub\s+)?(?:struct|enum|impl|trait)\s+\w+/m, 2],
      [/->\s*(?:Result|Option)</, 2],
    ] },
    { id: 'ruby', patterns: [
      [/^[ \t]*def\s+\w+[?!]?(?:\(.*\))?\s*$/m, 3],
      [/^[ \t]*end\s*$/m, 3],
      [/^[ \t]*(?:class|module)\s+[A-Z]\w*(?:\s*<\s*\w+)?\s*$/m, 3],
      [/\battr_(?:accessor|reader|writer)\b/, 3],
      [/\bputs\s+/, 2],
      [/^[ \t]*require\s+['"]/m, 2],
    ] },
    { id: 'powershell', patterns: [
      [/\b(?:Get|Set|New|Remove|Write)-[A-Z]\w+/, 3],
      [/\$env:\w+/i, 3],
      [/^[ \t]*param\s*\(/im, 2],
    ] },
    { id: 'shell', patterns: [
      [/^[ \t]*if\s+\[\[?\s.*\]\]?\s*;\s*then\s*$/m, 4],
      [/^[ \t]*for\s+\w+\s+in\s+.*;\s*do\s*$/m, 4],
      [/^[ \t]*(?:fi|esac|done)\s*$/m, 3],
      [/^[ \t]*(?:echo|export|source)\s+\S/m, 1],
      [/\$\{?\w+\}?/, 1],
      [/\$\(\s*\w.*\)/, 1],
    ] },
    { id: 'css', patterns: [
      [/^[ \t]*@(?:media|import|font-face|keyframes)\b/m, 4],
      [/^[ \t]*:root\s*\{/m, 4],
      [/^[ \t]*[.#]?[\w-][\w .#:>+,~[\]="'-]{0,200}\{[^{}]{0,1000}:[^{}]{0,1000}\}/m, 4],
      [/^[ \t]*[\w-]+[ \t]*:[ \t]*[^;{}\n]+;[ \t]*$/m, 1],
    ] },
    { id: 'ini', patterns: [
      [/^\[[\w .-]+\]\s*$/m, 3],
      [/^[\w.-]+\s*=\s*\S.*$/m, 1],
    ] },
    { id: 'yaml', patterns: [
      [/^---\s*$/m, 2],
      [/^(?:[A-Za-z_][\w-]*:(?:[ \t]+\S.*)?\n){2,}/m, 3],
      [/^[ \t]*-\s+[A-Za-z_][\w-]*:\s+\S/m, 2],
    ] },
    { id: 'markdown', patterns: [
      [/^#{1,6}\s+\S/m, 2],
      [/^```/m, 3],
      [/\[[^\]\n]+\]\([^)\s]+\)/, 2],
      [/^[ \t]*(?:[-*+]|\d+\.)\s+\S/m, 1],
      [/^[ \t]*>\s+\S/m, 1],
      [/\*\*[^*\n]+\*\*/, 1],
    ] },
  ];

  /** Guesses a Monaco language id from text alone; 'plaintext' when nothing is convincing. */
  function sniffLanguage(content: string): string {
    const text = (content.length > SNIFF_MAX_CHARS ? content.slice(0, SNIFF_MAX_CHARS) : content).trimStart();
    if (text.length === 0) {
      return 'plaintext';
    }
    const firstLine = text.split(/\r?\n/, 1)[0];
    if (firstLine.startsWith('#!')) {
      const match = SHEBANG_LANGUAGES.find(([pattern, id]) => languageIds.has(id) && pattern.test(firstLine));
      if (match) {
        return match[1];
      }
    }
    if (/^[[{]/.test(text) && languageIds.has('json')) {
      try {
        JSON.parse(text);
        return 'json';
      } catch {
        // Not JSON: fall through to the pattern scoring.
      }
    }
    const sample = text
      .slice(0, SNIFF_SAMPLE_CHARS)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => (line.length > SNIFF_LINE_CHARS ? line.slice(0, SNIFF_LINE_CHARS) : line))
      .join('\n');
    let best = 'plaintext';
    let bestScore = SNIFF_MIN_SCORE - 1;
    CONTENT_RULES.forEach(({ id, patterns }) => {
      if (!languageIds.has(id)) {
        return;
      }
      const score = patterns.reduce((sum, [pattern, weight]) => sum + (pattern.test(sample) ? weight : 0), 0);
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    });
    return best;
  }

  /** The file name or extension decides when it is known; otherwise the content does. */
  function resolveLanguage(filePath: string | null, content: string): string {
    return (filePath && detectLanguage(filePath)) || sniffLanguage(content);
  }

  /** Re-detects the language of a tab that follows its content, after typing or pasting settles. */
  function scheduleLanguageDetect(tab: CodePadTextTab): void {
    clearTimeout(tab.detectTimer ?? undefined);
    tab.detectTimer = setTimeout(() => {
      if (!tab.autoDetect || tab.model.isDisposed()) {
        return;
      }
      const language = sniffLanguage(tab.model.getValue());
      if (language !== tab.model.getLanguageId()) {
        monaco.editor.setModelLanguage(tab.model, language);
        if (tab === activeTab) {
          updateStatusForModel();
        }
      }
    }, LANGUAGE_DETECT_DELAY_MS);
  }

  function buildLanguageIndex(): void {
    const languages = monaco.languages.getLanguages();
    extensionMap = new Map();
    filenameMap = new Map();
    languageIds = new Set(languages.map((lang) => lang.id));
    languages.forEach((lang) => {
      (lang.extensions || []).forEach((ext) => extensionMap.set(ext.toLowerCase(), lang.id));
      (lang.filenames || []).forEach((file) => filenameMap.set(file.toLowerCase(), lang.id));
    });
    const options = languages
      .map((lang) => ({ id: lang.id, label: (lang.aliases && lang.aliases[0]) || lang.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    options.forEach(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      els.lang.appendChild(option);
    });
  }

  // ---------- Encodings and line endings ----------

  const encodingLabel = (id: string): string => encodingLabels.get(id) || id || '';

  async function loadEncodingLabels(): Promise<void> {
    try {
      (await api.encodings.list()).forEach((item) => encodingLabels.set(item.id, item.label));
    } catch (error) {
      console.error('Could not load the encoding list:', error);
    }
  }

  /** 'lf', 'crlf' or 'cr' (a file that only uses lone CRs); mixed files report their dominant LF/CRLF style. */
  function detectEol(content: string): CodePadEol {
    const crlf = (content.match(/\r\n/g) || []).length;
    const lf = (content.match(/\n/g) || []).length - crlf;
    const cr = (content.match(/\r/g) || []).length - crlf;
    if (cr > 0 && lf === 0 && crlf === 0) {
      return 'cr';
    }
    return crlf > lf ? 'crlf' : 'lf';
  }

  /** Text for a Monaco model plus its original line-ending style (Monaco itself cannot hold lone-CR files). */
  function prepareText(content: string): { content: string; eol: CodePadEol } {
    const eol = detectEol(content);
    return { content: eol === 'cr' ? content.replace(/\r/g, '\n') : content, eol };
  }

  function defaultEol(): CodePadEol {
    const value = appSettings.get('files.defaultEol');
    return value === 'platform' ? (platform === 'win32' ? 'crlf' : 'lf') : (value as CodePadEol);
  }

  const modelEol = (model: monaco.editor.ITextModel): CodePadEol => (model.getEOL() === '\r\n' ? 'crlf' : 'lf');

  // ---------- Tabs ----------

  const newPersist = (source: Partial<CodePadTabPersist> = {}): CodePadTabPersist => ({
    pinned: false,
    color: 0,
    readOnly: false,
    monitor: false,
    ...source,
    bookmarks: Array.isArray(source.bookmarks) ? [...source.bookmarks] : [],
  });

  const isPinned = (tab: CodePadTab): boolean => Boolean(tab.persist && tab.persist.pinned);

  /** True when a registered interceptor (e.g. the pinned-tab guard) refuses to close the tab. */
  const closeVetoed = (tab: CodePadTab): boolean => closeInterceptors.some((intercept) => intercept(tab) === false);

  function renderTabs(): void {
    els.tabs.replaceChildren();
    tabs.forEach((tab) => {
      const readOnly = tab.kind !== 'text' && tab.view.readOnly;
      const item = document.createElement('div');
      item.className = `tab${tab === activeTab ? ' active' : ''}${tab.dirty ? ' dirty' : ''}${readOnly ? ' readonly' : ''}`;
      item.title = readOnly
        ? `${shown(tab.path || tab.name)} - view only: this PDF has no text layer to edit`
        : shown(tab.path || tab.name);

      const label = document.createElement('span');
      label.textContent = shown(readOnly ? `${tab.name} (view only)` : tab.name);

      const close = document.createElement('span');
      close.className = 'close';
      const closeGlyph = document.createElement('span');
      closeGlyph.textContent = '×';
      close.append(closeGlyph);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTabFromUi(tab);
      });

      item.addEventListener('click', () => activateTab(tab));
      item.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
          closeTabFromUi(tab);
        }
      });
      item.addEventListener('contextmenu', (event) => {
        if (tabContextMenuHandler) {
          event.preventDefault();
          tabContextMenuHandler(tab, event);
        }
      });
      item.append(label, close);
      tabDecorators.forEach((decorate) => {
        try {
          decorate(tab, item, label);
        } catch (error) {
          console.error('Tab decorator failed:', error);
        }
      });
      els.tabs.appendChild(item);
    });
    const newTab = document.createElement('button');
    newTab.type = 'button';
    newTab.id = 'new-tab';
    newTab.title = 'New File';
    newTab.textContent = '+';
    newTab.addEventListener('click', () => commandRegistry.execute('file.new'));
    els.tabs.appendChild(newTab);
    if (tabs.length > 0) {
      const closeAll = document.createElement('button');
      closeAll.type = 'button';
      closeAll.id = 'close-all-tabs';
      closeAll.title = 'Close All Files';
      closeAll.textContent = '×';
      closeAll.addEventListener('click', async () => {
        const choice = await ui.confirm({
          title: 'Close All Files',
          message: `Close all ${tabs.length} open file${tabs.length === 1 ? '' : 's'}?`,
          buttons: ['Yes', 'No'],
        });
        if (choice === 0) {
          commandRegistry.execute('tabs.closeAll');
        }
      });
      els.tabs.appendChild(closeAll);
    }
    const active = els.tabs.querySelector('.tab.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    document.title = activeTab ? `${shown(activeTab.name)}${activeTab.dirty ? ' ●' : ''} - CodePad` : 'CodePad';
    scheduleSessionSave();
  }

  /** Smallest N for which no open tab is called Untitled-N. */
  function lowestFreeUntitled(): number {
    const used = new Set(tabs.map((tab) => tab.name));
    let number = 1;
    while (used.has(`Untitled-${number}`)) {
      number += 1;
    }
    return number;
  }

  function activateTab(tab: CodePadTab): void {
    if (activeTab && activeTab.kind === 'text') {
      activeTab.viewState = editor.saveViewState();
    }
    activeTab = tab;
    if (tab.kind === 'text') {
      editor.setModel(tab.model);
      if (tab.viewState) {
        editor.restoreViewState(tab.viewState);
      }
    }
    updateEditorVisibility();
    if (tab.kind === 'text') {
      editor.layout();
      editor.focus();
    } else {
      tab.view.layout();
      tab.view.focus();
    }
    updateStatusForModel();
    highlightTreeFile();
    renderTabs();
    bus.emit('tab:activated', tab);
  }

  /** Shows the surface of the active tab (Monaco, or its document host) or the welcome screen. */
  function updateEditorVisibility(): void {
    const hasTabs = tabs.length > 0;
    const showView = activeTab !== null && activeTab.kind !== 'text';
    els.editor.classList.toggle('hidden', !hasTabs);
    els.editor.classList.toggle('inactive', showView);
    els.views.classList.toggle('hidden', !showView);
    tabs.forEach((tab) => {
      if (tab.kind !== 'text') {
        tab.host.classList.toggle('hidden', tab !== activeTab);
      }
    });
    els.welcome.classList.toggle('hidden', hasTabs);
  }

  /** Re-lays out the active document view (Monaco lays itself out); call after the available space changes. */
  function layoutActiveView(): void {
    if (activeTab && activeTab.kind !== 'text') {
      activeTab.view.layout();
    }
  }

  function markDirty(tab: CodePadTab, dirty: boolean): void {
    if (dirty !== tab.dirty) {
      tab.dirty = dirty;
      renderTabs();
      bus.emit('tab:dirty', tab);
    }
  }

  /**
   * Creates a text tab and its model without activating it.
   * `language` and `autoDetect` are only passed when restoring a saved session; `eol` is applied to the model of
   * untitled documents (files keep the line endings Monaco detected in their content).
   */
  function createTab({
    filePath = null,
    name,
    content,
    encoding,
    eol,
    language,
    autoDetect,
    persist,
    diskStat = null,
  }: TextTabOptions): CodePadTextTab {
    const model = monaco.editor.createModel(
      content,
      typeof language === 'string' && languageIds.has(language) ? language : resolveLanguage(filePath, content),
      filePath ? monaco.Uri.file(filePath) : undefined,
    );
    const lineEnding = eol || (filePath ? detectEol(content) : defaultEol());
    if (!filePath) {
      model.setEOL(lineEnding === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    }
    const tab: CodePadTextTab = {
      id: nextId++,
      kind: 'text',
      path: filePath,
      name: name || (filePath ? baseName(filePath) : `Untitled-${lowestFreeUntitled()}`),
      encoding: encoding || appSettings.get('files.defaultEncoding'),
      eol: lineEnding,
      model,
      viewState: null,
      savedVersion: model.getAlternativeVersionId(),
      dirty: false,
      autoDetect: autoDetect ?? !filePath,
      detectTimer: null,
      persist: newPersist(persist),
      diskStat,
    };
    model.onDidChangeContent((event) => {
      // Keep tab.eol in step with the model; a lone-CR tab stays 'cr' until the user picks LF or CRLF.
      if (event.eol === '\r\n' && tab.eol !== 'crlf') {
        tab.eol = 'crlf';
      } else if (event.eol === '\n' && tab.eol === 'crlf') {
        tab.eol = 'lf';
      }
      markDirty(tab, model.getAlternativeVersionId() !== tab.savedVersion);
      if (tab === activeTab) {
        updateStatusForModel();
      }
      if (tab.autoDetect) {
        scheduleLanguageDetect(tab);
      }
      scheduleSessionSave();
    });
    tabs.push(tab);
    bus.emit('tab:created', tab);
    return tab;
  }

  function addTab(options: TextTabOptions): CodePadTextTab {
    const tab = createTab(options);
    activateTab(tab);
    return tab;
  }

  /** A document view reported an edit: refresh the dirty flag (re-rendering tabs only when it flips) and status. */
  function onViewChange(tab: CodePadViewTab): void {
    if (!tab.view) {
      return;
    }
    const dirty = tab.view.isDirty();
    if (dirty !== tab.dirty) {
      markDirty(tab, dirty);
    } else {
      scheduleSessionSave();
    }
    if (tab === activeTab) {
      updateViewStatus(tab);
    }
  }

  /**
   * Creates a tab backed by an editor module without activating it; rejects when the module cannot open the file.
   * `bytes` is null only when restoring unsaved edits of a file that no longer exists; `params` is for views that
   * are not files (the 'diff' compare view).
   */
  async function createViewTab(options: DocumentTabOptions): Promise<CodePadDocumentTab>;
  async function createViewTab(options: ViewTabOptions): Promise<CodePadViewTab>;
  async function createViewTab({
    kind,
    filePath = null,
    name,
    bytes = null,
    restoredState = null,
    params,
    diskStat = null,
  }: ViewTabOptions): Promise<CodePadViewTab> {
    const definition = window.CodePadEditors.get(kind);
    if (!definition) {
      throw new Error(`No editor is available for ${kind} files.`);
    }
    const host = document.createElement('div');
    host.className = 'view-host hidden';
    host.dataset.kind = kind;
    els.views.appendChild(host);
    const tab: PendingViewTab = {
      id: nextId++,
      kind,
      path: filePath,
      name,
      dirty: false,
      view: null,
      host,
      stateLost: false,
      persist: kind === 'diff' ? null : newPersist(),
      diskStat,
    };
    try {
      tab.view = await definition.create({
        container: host,
        bytes,
        fileName: name,
        filePath,
        restoredState,
        params,
        theme: themes.kindOf(themes.current()),
        callbacks: {
          onChange: () => onViewChange(tab as CodePadViewTab),
          onStatus: (text) => {
            if (tab === activeTab) {
              setStatus(text);
            }
          },
        },
      });
    } catch (error) {
      host.remove();
      throw error;
    }
    tab.dirty = tab.view.isDirty();
    const created = tab as CodePadViewTab;
    tabs.push(created);
    bus.emit('tab:created', created);
    return created;
  }

  /** Asks about unsaved changes. Returns true when it is safe to discard the tab. */
  async function confirmDiscard(tab: CodePadTab): Promise<boolean> {
    if (!tab.dirty) {
      return true;
    }
    activateTab(tab);
    const choice = await api.confirmClose(tab.name, tab.kind);
    if (choice === 0) {
      return saveTab(tab);
    }
    return choice === 1;
  }

  async function closeTab(tab: CodePadTab): Promise<boolean> {
    if (await confirmDiscard(tab)) {
      removeTab(tab);
      return true;
    }
    return false;
  }

  /** Close button, middle click and Close Tab command: honours the interceptors (pinned tabs). */
  async function closeTabFromUi(tab: CodePadTab): Promise<boolean> {
    if (closeVetoed(tab)) {
      return false;
    }
    // A file-less tab with content (Untitled-N, a summary) is lost for good when closed, even if it is not "dirty".
    if (!tab.dirty && tab.kind === 'text' && !tab.path && tab.model.getValueLength() > 0) {
      const choice = await ui.confirm({
        title: 'Close Unsaved File',
        message: `${tab.name} has not been saved. Close it without saving?`,
        buttons: ['Yes', 'No'],
      });
      if (choice !== 0) {
        return false;
      }
      removeTab(tab);
      return true;
    }
    return closeTab(tab);
  }

  /** Removes a tab without asking and releases its model or view. */
  function removeTab(tab: CodePadTab): void {
    const index = tabs.indexOf(tab);
    if (index < 0) {
      return;
    }
    bus.emit('tab:closing', tab);
    tabs.splice(index, 1);
    if (tab === activeTab) {
      activeTab = null;
      if (tabs.length > 0) {
        activateTab(tabs[Math.min(index, tabs.length - 1)]);
      } else {
        editor.setModel(null);
        updateEditorVisibility();
        updateStatusForModel();
        highlightTreeFile();
        renderTabs();
        bus.emit('tab:activated', null);
      }
    } else {
      renderTabs();
    }
    if (tab.kind === 'text') {
      clearTimeout(tab.detectTimer ?? undefined);
      tab.model.dispose();
    } else {
      try {
        tab.view.dispose();
      } finally {
        tab.host.remove();
      }
    }
    bus.emit('tab:closed', tab);
  }

  function cycleTab(step: number): void {
    if (tabs.length < 2) {
      return;
    }
    const index = tabs.indexOf(activeTab as CodePadTab);
    activateTab(tabs[(index + step + tabs.length) % tabs.length]);
  }

  /** Closes tabs one by one (skipping pinned ones); stops at the first dirty tab the user cancels. */
  async function closeMany(list: CodePadTab[]): Promise<boolean> {
    for (const tab of [...list]) {
      if (tabs.includes(tab) && !isPinned(tab) && !(await closeTab(tab))) {
        return false;
      }
    }
    return true;
  }

  /** Moves a tab; pinned tabs always stay in the contiguous block at the left. */
  function moveTab(tab: CodePadTab, newIndex: number): void {
    const from = tabs.indexOf(tab);
    if (from < 0 || !Number.isInteger(newIndex)) {
      return;
    }
    const others = tabs.filter((item) => item !== tab);
    const pinnedOthers = others.filter(isPinned).length;
    const index = isPinned(tab)
      ? Math.max(0, Math.min(newIndex, pinnedOthers))
      : Math.max(pinnedOthers, Math.min(newIndex, others.length));
    others.splice(index, 0, tab);
    if (others.every((item, position) => item === tabs[position])) {
      return;
    }
    tabs.splice(0, tabs.length, ...others);
    renderTabs();
    bus.emit('tab:reordered');
  }

  /** Marks a text tab as having unsaved changes that are not visible in its model (e.g. a new encoding). */
  function forceDirty(tab: CodePadTextTab): void {
    if (tab.kind === 'text') {
      tab.savedVersion = -1;
      markDirty(tab, true);
    }
  }

  // ---------- Files ----------

  /** Selects a position (or a range when `length` is given) and scrolls it to the center. */
  function revealInTab(tab: CodePadTab, line: number | undefined, col = 1, length = 0): void {
    if (tab !== activeTab) {
      activateTab(tab);
    }
    if (tab.kind !== 'text' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      return;
    }
    const lineNumber = Math.min(line, tab.model.getLineCount());
    const column = Math.max(1, Number.isInteger(col) ? col : 1);
    const range = new monaco.Range(lineNumber, column, lineNumber, column + Math.max(0, length));
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
  }

  function textTabOptions(filePath: string, result: CpReadTextOk): TextTabOptions {
    const prepared = prepareText(result.content);
    return {
      filePath,
      content: prepared.content,
      encoding: result.encoding,
      eol: prepared.eol,
      diskStat: { mtimeMs: result.mtimeMs, size: result.size },
    };
  }

  /** The open tab of the same kind showing this file: same string first, then the same file under another spelling or link. */
  async function findOpenTab(filePath: string, kind: CodePadTabKind): Promise<CodePadTab | null> {
    const exact = tabs.find((tab) => tab.path === filePath && tab.kind === kind);
    if (exact) {
      return exact;
    }
    for (const tab of tabs) {
      if (tab.path && tab.kind === kind && (await api.isSameFile(tab.path, filePath))) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Opens a file in the editor its extension selects; `asText` forces the Monaco text editor.
   * @returns The (new or existing) tab, or null when the file could not be opened.
   */
  async function openPath(
    filePath: string,
    { line, col, asText = false }: { line?: number; col?: number; asText?: boolean } = {},
  ): Promise<CodePadTab | null> {
    const kind = asText ? 'text' : kindForPath(filePath);
    const existing = await findOpenTab(filePath, kind);
    if (existing) {
      activateTab(existing);
      revealInTab(existing, line, col);
      return existing;
    }
    try {
      if (kind !== 'text') {
        return await openViewPath(kind, filePath);
      }
      const result = await api.readFile(filePath);
      if (result.binary) {
        setStatus(`${baseName(filePath)} is a binary file and cannot be opened.`);
        return null;
      }
      if (result.tooLarge) {
        setStatus(`${baseName(filePath)} is larger than 20 MB and cannot be opened.`);
        return null;
      }
      const tab = addTab(textTabOptions(filePath, result));
      setStatus(
        result.replaced
          ? `${baseName(filePath)} contains characters that are not valid ${encodingLabel(result.encoding)}: try Encoding > Reopen with Encoding.`
          : '',
      );
      revealInTab(tab, line, col);
      return tab;
    } catch (error) {
      setStatus(`Could not open ${baseName(filePath)}: ${errorMessage(error)}`);
      return null;
    }
  }

  async function openViewPath(kind: CodePadDocumentKind, filePath: string): Promise<CodePadDocumentTab | null> {
    if (!window.CodePadEditors.get(kind)) {
      throw new Error(`No editor is available for ${kind} files.`);
    }
    const result = await api.readBinary(filePath);
    if (result.tooLarge) {
      setStatus(`${baseName(filePath)} is too large to open.`);
      return null;
    }
    const tab = await createViewTab({
      kind,
      filePath,
      name: baseName(filePath),
      bytes: result.bytes,
      diskStat: { mtimeMs: result.mtimeMs, size: result.size },
    });
    activateTab(tab);
    setStatus('');
    return tab;
  }

  /** Opens a non-file tab (e.g. the compare view) from a registered view kind. */
  async function openView(kind: CodePadViewKind, { name, params }: { name?: string; params?: object } = {}): Promise<CodePadViewTab> {
    const tab = await createViewTab({ kind, name: name || kind, params });
    activateTab(tab);
    return tab;
  }

  /** Opens an untitled text tab. */
  function openText({ name, content = '', language }: { name?: string; content?: string; language?: string } = {}): CodePadTextTab {
    const known = language !== undefined && languageIds.has(language);
    const tab = addTab({ name, content, language: known ? language : undefined, autoDetect: known ? false : undefined });
    return tab;
  }

  /** Reopens the active document in the Monaco text editor (e.g. a CSV as plain text). */
  async function openActiveAsText(): Promise<void> {
    const tab = activeTab;
    if (!tab || tab.kind === 'text' || !tab.path) {
      setStatus('Open as Text Editor needs a document opened from disk.');
      return;
    }
    if (!(await confirmDiscard(tab))) {
      return;
    }
    removeTab(tab);
    await openPath(tab.path, { asText: true });
  }

  /** Re-reads a tab from disk (optionally with another encoding); asks first when it has unsaved changes. */
  async function reloadTab(tab: CodePadTab, { encoding }: { encoding?: string } = {}): Promise<boolean> {
    if (!tab || !tab.path || tab.kind === 'diff' || !tabs.includes(tab)) {
      return false;
    }
    if (tab.dirty) {
      const choice = await ui.confirm({
        title: 'Reload from Disk',
        message: `${tab.name} has unsaved changes. Reloading discards them.`,
        buttons: ['Reload', 'Cancel'],
      });
      if (choice !== 0) {
        return false;
      }
    }
    try {
      if (tab.kind !== 'text') {
        return await reloadViewTab(tab, tab.path);
      }
      const result = await api.readFile(tab.path, { encoding: encoding || tab.encoding });
      if (result.binary || result.tooLarge) {
        setStatus(`${tab.name} can no longer be opened as text.`);
        return false;
      }
      const prepared = prepareText(result.content);
      const viewState = tab === activeTab ? editor.saveViewState() : null;
      tab.model.setValue(prepared.content);
      tab.encoding = result.encoding;
      tab.eol = prepared.eol === 'cr' ? 'cr' : modelEol(tab.model);
      tab.diskStat = { mtimeMs: result.mtimeMs, size: result.size };
      tab.savedVersion = tab.model.getAlternativeVersionId();
      markDirty(tab, false);
      if (viewState) {
        editor.restoreViewState(viewState);
      }
      updateStatusForModel();
      if (result.replaced) {
        setStatus(`${tab.name} contains characters that are not valid ${encodingLabel(result.encoding)}.`);
      }
      bus.emit('tab:reloaded', tab);
      return true;
    } catch (error) {
      setStatus(`Could not reload ${tab.name}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Document tabs are re-created from the file's bytes, keeping their position. */
  async function reloadViewTab(tab: CodePadDocumentTab, filePath: string): Promise<boolean> {
    const result = await api.readBinary(filePath);
    if (result.tooLarge) {
      setStatus(`${tab.name} is too large to open.`);
      return false;
    }
    const wasActive = tab === activeTab;
    const index = tabs.indexOf(tab);
    const persist = { ...tab.persist };
    const fresh = await createViewTab({
      kind: tab.kind,
      filePath: tab.path,
      name: tab.name,
      bytes: result.bytes,
      diskStat: { mtimeMs: result.mtimeMs, size: result.size },
    });
    fresh.persist = newPersist(persist);
    tabs.splice(tabs.indexOf(fresh), 1);
    tabs.splice(index, 0, fresh);
    if (wasActive) {
      activateTab(fresh);
    }
    removeTab(tab);
    bus.emit('tab:reloaded', fresh);
    return true;
  }

  function trimTrailingWhitespace(model: monaco.editor.ITextModel): void {
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    for (let line = 1; line <= model.getLineCount(); line += 1) {
      const text = model.getLineContent(line);
      const trimmed = text.replace(/[ \t]+$/, '');
      if (trimmed.length !== text.length) {
        edits.push({ range: new monaco.Range(line, trimmed.length + 1, line, text.length + 1), text: '' });
      }
    }
    if (edits.length > 0) {
      model.pushEditOperations([], edits, () => null);
    }
  }

  /** Asks what to do when the target encoding cannot represent some characters. Returns 'utf8', 'lossy' or null. */
  async function askLossy(
    tab: CodePadTextTab,
    result: Extract<CpWriteTextResult, { ok: false }>,
  ): Promise<'utf8' | 'lossy' | null> {
    const shown = result.badChar ? ` ("${result.badChar}")` : '';
    const choice = await ui.confirm({
      title: 'Characters cannot be saved',
      message: `${tab.name} contains characters${shown} that ${encodingLabel(tab.encoding)} cannot represent.`,
      buttons: ['Save as UTF-8 instead', 'Save anyway (characters become ?)', 'Cancel'],
    });
    return choice === 0 ? 'utf8' : choice === 1 ? 'lossy' : null;
  }

  async function writeTab(tab: CodePadTextTab, filePath: string, { allowLossy = false } = {}): Promise<boolean> {
    if (appSettings.get('files.trimTrailingOnSave')) {
      trimTrailingWhitespace(tab.model);
    }
    let value = tab.model.getValue();
    if (tab.eol === 'cr') {
      value = value.replace(/\r?\n/g, '\r');
    }
    let result: CpWriteTextResult;
    try {
      result = await api.writeFile(filePath, value, tab.encoding, { allowLossy });
    } catch (error) {
      setStatus(`Could not save ${baseName(filePath)}: ${errorMessage(error)}`);
      return false;
    }
    if (!result.ok) {
      const decision = await askLossy(tab, result);
      if (decision === 'utf8') {
        tab.encoding = 'utf8';
        updateStatusForModel();
      } else if (decision === null) {
        return false;
      }
      return writeTab(tab, filePath, { allowLossy: decision === 'lossy' });
    }
    tab.diskStat = { mtimeMs: result.mtimeMs, size: result.size };
    tab.savedVersion = tab.model.getAlternativeVersionId();
    markDirty(tab, false);
    setStatus(`Saved ${baseName(filePath)}`);
    return true;
  }

  /** Serializes a document view for the target file's extension and writes it. */
  async function writeViewTab(tab: CodePadViewTab, filePath: string): Promise<boolean> {
    try {
      const bytes = await tab.view.getBytes(extensionOf(filePath).slice(1));
      const result = await api.writeBinary(filePath, bytes);
      tab.diskStat = { mtimeMs: result.mtimeMs, size: result.size };
    } catch (error) {
      setStatus(`Could not save ${baseName(filePath)}: ${errorMessage(error)}`);
      return false;
    }
    tab.view.markSaved();
    markDirty(tab, false);
    setStatus(`Saved ${baseName(filePath)}`);
    return true;
  }

  async function saveTab(tab: CodePadTab): Promise<boolean> {
    if (tab.kind === 'diff') {
      return false;
    }
    let ok: boolean;
    if (tab.kind !== 'text') {
      if (tab.view.readOnly) {
        setStatus('This PDF is view-only.');
        return false;
      }
      if (!(tab.view.saveMode === 'overwrite' && tab.path)) {
        return saveTabAs(tab);
      }
      ok = await writeViewTab(tab, tab.path);
    } else {
      if (!tab.path) {
        return saveTabAs(tab);
      }
      ok = await writeTab(tab, tab.path);
    }
    renderTabs();
    if (ok) {
      bus.emit('tab:saved', tab);
    }
    return ok;
  }

  /** Records a new path for a tab after Save As and tells the features. */
  function adoptPath(tab: CodePadTab, filePath: string): void {
    const oldPath = tab.path;
    tab.path = filePath;
    tab.name = baseName(filePath);
    updateStatusForModel();
    highlightTreeFile();
    renderTabs();
    bus.emit('tab:pathChanged', tab, oldPath);
    bus.emit('tab:saved', tab);
  }

  /** Save As for a document: the view picks the formats and suggested name; a PDF never targets its original. */
  async function saveViewTabAs(tab: CodePadViewTab): Promise<boolean> {
    if (tab.view.readOnly) {
      setStatus('This PDF is view-only.');
      return false;
    }
    const folder = tab.path ? tab.path.slice(0, Math.max(tab.path.lastIndexOf('/'), tab.path.lastIndexOf('\\')) + 1) : '';
    const filePath = await api.saveAsDialog(`${folder}${tab.view.defaultSaveName}`, {
      filters: tab.view.saveFilters,
      avoidPath: tab.kind === 'pdf' ? tab.path : undefined,
    });
    if (!filePath) {
      return false;
    }
    if (!(await writeViewTab(tab, filePath))) {
      return false;
    }
    adoptPath(tab, filePath);
    return true;
  }

  async function saveTabAs(tab: CodePadTab): Promise<boolean> {
    if (tab.kind === 'diff') {
      return false;
    }
    if (tab.kind !== 'text') {
      return saveViewTabAs(tab);
    }
    const filePath = await api.saveAsDialog(tab.path || tab.name);
    if (!filePath) {
      return false;
    }
    if (!(await writeTab(tab, filePath))) {
      return false;
    }
    tab.autoDetect = false;
    monaco.editor.setModelLanguage(tab.model, resolveLanguage(filePath, tab.model.getValue()));
    adoptPath(tab, filePath);
    return true;
  }

  async function saveAll(): Promise<boolean> {
    for (const tab of tabs.filter((item) => item.dirty)) {
      if (!(await saveTab(tab))) {
        return false;
      }
    }
    return true;
  }

  async function handleOpenFiles(): Promise<void> {
    const paths = await api.openFiles();
    for (const filePath of paths) {
      await openPath(filePath);
    }
  }

  // ---------- Session ----------

  const sessionTabs = (): SessionTab[] => tabs.filter((tab): tab is SessionTab => tab.kind !== 'diff');

  /** The saved form of one tab; unsaved and untitled text tabs carry their full text, documents their view state. */
  async function snapshotTab(tab: SessionTab): Promise<Partial<CpSessionTab>> {
    if (tab.kind !== 'text') {
      let state: Record<string, unknown> | null = null;
      let stateTooLarge = false;
      if (tab.dirty) {
        try {
          state = (await tab.view.getSessionState()) as Record<string, unknown> | null;
          stateTooLarge = state === null && tab.view.sessionStateTooLarge === true;
        } catch {
          // The view could not describe its edits: treat them as not restorable.
          stateTooLarge = true;
        }
      }
      return {
        kind: tab.kind,
        path: tab.path,
        name: tab.name,
        state,
        stateTooLarge,
        pinned: tab.persist.pinned,
        color: tab.persist.color,
        active: tab === activeTab,
      };
    }
    return {
      kind: 'text',
      path: tab.path,
      name: tab.name,
      encoding: tab.encoding,
      eol: tab.eol,
      language: tab.model.getLanguageId(),
      autoDetect: tab.autoDetect,
      content: tab.path && !tab.dirty ? null : tab.model.getValue(),
      viewState: tab.viewState as Record<string, unknown> | null,
      pinned: tab.persist.pinned,
      color: tab.persist.color,
      readOnly: tab.persist.readOnly,
      monitor: tab.persist.monitor,
      bookmarks: tab.persist.bookmarks,
      active: tab === activeTab,
    };
  }

  /** Everything needed to rebuild the given tabs. */
  async function snapshotSession(snapshotTabs: SessionTab[]): Promise<{ tabs: Partial<CpSessionTab>[] }> {
    if (activeTab && activeTab.kind === 'text') {
      activeTab.viewState = editor.saveViewState();
    }
    bus.emit('session:beforeSnapshot');
    return { tabs: await Promise.all(snapshotTabs.map(snapshotTab)) };
  }

  /** Saves the session and flags document tabs whose unsaved edits could not be stored (`stateLost`). */
  async function persistSession(): Promise<void> {
    const snapshotTabs = sessionTabs();
    const session = await snapshotSession(snapshotTabs);
    const lost = await api.saveSession(session);
    snapshotTabs.forEach((tab, index) => {
      if (tab.kind !== 'text') {
        tab.stateLost = tab.dirty && (session.tabs[index].stateTooLarge || lost.includes(index));
      }
    });
  }

  function scheduleSessionSave(): void {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(async () => {
      await sessionRestored;
      try {
        await persistSession();
      } catch (error) {
        setStatus(`Could not save the session: ${errorMessage(error)}`);
      }
    }, SESSION_SAVE_DELAY_MS);
  }

  /** Rebuilds a saved document tab from disk plus its unsaved state; null when it cannot be rebuilt. */
  async function restoreViewTab(
    saved: CpSessionTab,
    kind: CodePadDocumentKind,
    notes: string[],
  ): Promise<CodePadDocumentTab | null> {
    if (saved.path === null) {
      throw new TypeError('A saved document tab has no path.');
    }
    const name = baseName(saved.path);
    let disk: CpReadBinaryOk | null = null;
    try {
      const result = await api.readBinary(saved.path);
      if (!result.tooLarge) {
        disk = result;
      }
    } catch {
      // Missing or unreadable: fall back to the saved edits, if the format allows it.
    }
    if (disk) {
      const tab = await createViewTab({
        kind,
        filePath: saved.path,
        name,
        bytes: disk.bytes,
        restoredState: saved.state,
        diskStat: { mtimeMs: disk.mtimeMs, size: disk.size },
      });
      if (saved.stateTooLarge) {
        notes.push(`Unsaved changes in ${name} could not be restored.`);
      }
      return tab;
    }
    if ((kind === 'docx' || kind === 'sheet') && saved.state) {
      const tab = await createViewTab({
        kind,
        filePath: saved.path,
        name,
        bytes: null,
        restoredState: saved.state,
      });
      tab.dirty = true;
      notes.push(`${name} was not found on disk; restored your unsaved edits.`);
      return tab;
    }
    return null;
  }

  function readRestoreMarker(): string | null {
    try {
      return localStorage.getItem(RESTORE_MARKER_KEY);
    } catch {
      return null;
    }
  }

  function writeRestoreMarker(path: string | null): void {
    try {
      if (path === null) {
        localStorage.removeItem(RESTORE_MARKER_KEY);
      } else {
        localStorage.setItem(RESTORE_MARKER_KEY, path);
      }
    } catch {
      // Storage unavailable: the guard is simply off.
    }
  }

  /** Rebuilds one saved tab; returns null when its file is gone and there is no unsaved text to keep. */
  async function restoreTab(saved: CpSessionTab, notes: string[]): Promise<SessionTab | null> {
    if (saved.kind !== 'text') {
      return restoreViewTab(saved, saved.kind, notes);
    }
    if (!saved.path) {
      return createTab({
        name: saved.name,
        content: saved.content ?? '',
        encoding: saved.encoding,
        eol: saved.eol || undefined,
        language: saved.language,
        autoDetect: saved.autoDetect,
      });
    }
    let disk: CpReadTextOk | null = null;
    try {
      const forced = saved.encoding && !AUTO_DETECTED_ENCODINGS.has(saved.encoding) ? { encoding: saved.encoding } : undefined;
      const result = await api.readFile(saved.path, forced);
      if (!result.binary && !result.tooLarge) {
        disk = result;
      }
    } catch {
      // Missing or unreadable: fall back to the saved unsaved text, if any.
    }
    if (!disk && saved.content === null) {
      return null;
    }
    const prepared = disk ? prepareText(disk.content) : { content: saved.content ?? '', eol: saved.eol || undefined };
    const tab = createTab({
      filePath: saved.path,
      content: prepared.content,
      encoding: disk ? disk.encoding : saved.encoding,
      eol: saved.content !== null && saved.eol ? saved.eol : prepared.eol,
      language: saved.language,
      autoDetect: saved.autoDetect,
      diskStat: disk ? { mtimeMs: disk.mtimeMs, size: disk.size } : null,
    });
    if (!disk) {
      // The file is gone: keep the text, flagged as unsaved.
      tab.savedVersion = -1;
      tab.dirty = true;
    } else if (typeof saved.content === 'string' && saved.content !== prepared.content) {
      tab.model.setValue(saved.content);
    }
    return tab;
  }

  /** Applies the user-visible state a session stored for a tab. */
  function applySavedState(tab: SessionTab, saved: CpSessionTab): void {
    tab.persist.pinned = saved.pinned === true;
    tab.persist.color = Number.isInteger(saved.color) ? saved.color : 0;
    if (tab.kind === 'text') {
      tab.viewState = saved.viewState as monaco.editor.ICodeEditorViewState | null;
      tab.persist.readOnly = saved.readOnly === true;
      tab.persist.monitor = saved.monitor === true;
      tab.persist.bookmarks = Array.isArray(saved.bookmarks) ? [...saved.bookmarks] : [];
    }
  }

  /**
   * Rebuilds tabs from a session (startup, named sessions). With `replace` every open tab is closed first
   * (the caller already confirmed discarding unsaved changes).
   */
  async function restoreSnapshot(session: SessionToRestore, { replace = false } = {}): Promise<void> {
    if (replace) {
      [...tabs].reverse().forEach(removeTab);
    }
    if (session.root) {
      await showFolder(session.root);
    }
    const restored: { tab: SessionTab; active: boolean }[] = [];
    const notes: string[] = [];
    let skipped = 0;
    const interrupted = readRestoreMarker() !== null;
    for (const saved of session.tabs) {
      let tab: SessionTab | null = null;
      if (interrupted && saved.kind !== 'text') {
        notes.push(`${saved.name} was not reopened because the last start did not finish; open it again from File > Open.`);
        continue;
      }
      try {
        writeRestoreMarker(saved.kind === 'text' ? null : saved.path ?? saved.name);
        tab = await restoreTab(saved, notes);
      } catch (error) {
        // One unreadable document must not block the other tabs.
        notes.push(`Could not restore ${saved.name}: ${errorMessage(error)}`);
        continue;
      }
      if (tab) {
        applySavedState(tab, saved);
        restored.push({ tab, active: saved.active });
      } else {
        skipped += 1;
      }
    }
    writeRestoreMarker(null);
    restored.forEach(({ tab }) => bus.emit('tab:restored', tab));
    const target = restored.find((item) => item.active) || restored[0];
    if (target) {
      activateTab(target.tab);
    } else {
      renderTabs();
    }
    if (skipped > 0) {
      notes.push(`${skipped} file(s) from the previous session no longer exist.`);
    }
    if (session.integrity === 'failed') {
      notes.push('The saved session failed its integrity check: file paths were not restored, only untitled text.');
    }
    if (notes.length > 0) {
      setStatus(notes.join(' '));
    }
    bus.emit('session:restored');
  }

  async function restoreSession(): Promise<void> {
    const session = await api.loadSession();
    if (session) {
      await restoreSnapshot(session);
    }
  }

  async function requestClose(): Promise<void> {
    await sessionRestored;
    clearTimeout(sessionTimer);
    let toConfirm: CodePadTab[];
    try {
      await persistSession();
      // Unsaved document edits that could not be stored would be lost, so those tabs still ask.
      toConfirm = tabs.filter((item) => item.kind !== 'text' && item.stateLost);
    } catch (error) {
      // The session could not be stored, so fall back to asking about unsaved changes.
      setStatus(`Could not save the session: ${errorMessage(error)}`);
      toConfirm = tabs.filter((item) => item.dirty);
    }
    for (const tab of toConfirm) {
      if (!(await confirmDiscard(tab))) {
        api.cancelClose();
        return;
      }
    }
    api.approveClose();
  }

  // ---------- File tree ----------

  async function renderDir(container: HTMLElement, dirPath: string, depth: number): Promise<void> {
    let entries: CpDirEntry[];
    try {
      entries = await api.readDir(dirPath);
    } catch (error) {
      setStatus(`Could not read ${baseName(dirPath)}: ${errorMessage(error)}`);
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = entry.path;
      row.style.paddingLeft = `${8 + depth * 12}px`;

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = entry.isDirectory ? '▸' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = shown(entry.name);
      row.append(arrow, label);
      container.appendChild(row);

      if (!entry.isDirectory) {
        row.addEventListener('click', () => openPath(entry.path));
        return;
      }
      const children = document.createElement('div');
      container.appendChild(children);
      let loaded = false;
      row.addEventListener('click', async () => {
        const expanded = arrow.textContent === '▾';
        if (expanded) {
          arrow.textContent = '▸';
          children.hidden = true;
          return;
        }
        arrow.textContent = '▾';
        children.hidden = false;
        if (!loaded) {
          loaded = true;
          await renderDir(children, entry.path, depth + 1);
          highlightTreeFile();
        }
      });
    });
  }

  async function showFolder(dirPath: string): Promise<void> {
    els.folderName.textContent = shown(baseName(dirPath));
    els.fileTree.replaceChildren();
    await renderDir(els.fileTree, dirPath, 0);
    bus.emit('folder:changed', dirPath);
  }

  async function openFolder(): Promise<void> {
    const dirPath = await api.openFolder();
    if (!dirPath) {
      return;
    }
    await showFolder(dirPath);
    appSettings.set('ui.sidebar', true);
    panelsHost.show('explorer');
    scheduleSessionSave();
  }

  function highlightTreeFile(): void {
    els.fileTree.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
    if (!activeTab || !activeTab.path) {
      return;
    }
    const activePath = activeTab.path;
    els.fileTree.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
      if (row.dataset.path === activePath) {
        row.classList.add('active');
      }
    });
  }

  // ---------- Status bar ----------

  /** Status text of the active document view (page, sheet and cell, word count...). */
  function updateViewStatus(tab: CodePadViewTab): void {
    els.info.textContent = tab.view.getStatusText();
  }

  function updateStatusForModel(): void {
    document.body.dataset.kind = activeTab ? activeTab.kind : 'none';
    els.info.textContent = '';
    if (!activeTab) {
      els.pos.textContent = '';
      els.eol.textContent = '';
      els.encoding.textContent = '';
      els.lang.value = 'plaintext';
      return;
    }
    if (activeTab.kind !== 'text') {
      updateViewStatus(activeTab);
      return;
    }
    const model = activeTab.model;
    els.encoding.textContent = encodingLabel(activeTab.encoding);
    els.eol.textContent = EOL_LABELS[activeTab.eol || modelEol(model)];
    els.lang.value = model.getLanguageId();
    updateCursorStatus();
  }

  /**
   * Adds a button to the status bar, placed before the cursor position and ordered by `order` (lower first).
   * It stays hidden until `set` gives it text.
   */
  function addStatusItem({
    id,
    order = 100,
    onClick,
  }: {
    id: string;
    order?: number;
    onClick(event: MouseEvent): void | Promise<void>;
  }): CodePadStatusItem {
    if (typeof id !== 'string' || typeof onClick !== 'function') {
      throw new TypeError('A status item needs an id and an onClick function.');
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-status-item';
    button.dataset.id = id;
    button.hidden = true;
    button.addEventListener('click', (event) => {
      try {
        Promise.resolve(onClick(event)).catch((error) => setStatus(errorMessage(error)));
      } catch (error) {
        setStatus(errorMessage(error));
      }
    });
    const entry = { order, button };
    const next = statusItems.find((item) => item.order > order);
    els.statusBar.insertBefore(button, next ? next.button : els.pos);
    statusItems.push(entry);
    statusItems.sort((a, b) => a.order - b.order);
    return Object.freeze({
      set(text: string, { title = '', state = '' }: { title?: string; state?: string } = {}) {
        button.textContent = text;
        button.title = title;
        button.dataset.state = state;
        button.hidden = text === '';
      },
      dispose() {
        const index = statusItems.indexOf(entry);
        if (index >= 0) {
          statusItems.splice(index, 1);
          button.remove();
        }
      },
    });
  }

  function updateCursorStatus(): void {
    if (!activeTab || activeTab.kind !== 'text') {
      return;
    }
    const position = editor.getPosition();
    if (position) {
      els.pos.textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
    }
  }

  // ---------- View settings ----------

  /** Nested Monaco option object for a dotted option name ('minimap.enabled' -> {minimap: {enabled}}). */
  function nestOption(name: string, value: unknown): Record<string, unknown> {
    return name.split('.').reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as Record<string, unknown>;
  }

  function mergeOptions(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    Object.entries(source).forEach(([key, value]) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = mergeOptions((target[key] || {}) as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        target[key] = value;
      }
    });
    return target;
  }

  const monacoValue = (entry: SettingsSchemaEntry, value: SettingValue): SettingValue => (entry.monacoMap === 'onOff' ? (value ? 'on' : 'off') : value);

  /** Monaco options for every setting that maps to one (the schema is the single source). */
  function settingsEditorOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    schema.KEYS.forEach((key) => {
      const entry = schema.SCHEMA[key];
      if (entry.monaco) {
        mergeOptions(options, nestOption(entry.monaco, monacoValue(entry, appSettings.get(key))));
      }
    });
    return options;
  }

  function applyTheme(): void {
    const id = themes.apply(appSettings.get('ui.theme'));
    const kind = themes.kindOf(id);
    tabs.forEach((tab) => {
      if (tab.kind !== 'text' && tab.view.setTheme) {
        tab.view.setTheme(kind);
      }
    });
    bus.emit('theme:changed', id);
  }

  function onSettingChanged({ key, value }: { key: SettingKey; value: SettingValue }): void {
    const entry = schema.SCHEMA[key];
    if (editor && entry && entry.monaco) {
      editor.updateOptions(nestOption(entry.monaco, monacoValue(entry, value)) as monaco.editor.IEditorOptions);
    }
    if (key === 'ui.theme' && editor) {
      applyTheme();
    }
  }

  /** Moves the values that earlier versions kept in localStorage into the settings store (first start only). */
  async function migrateLegacySettings(): Promise<void> {
    try {
      const theme = localStorage.getItem('theme');
      const patch: Partial<SettingsValues> = {};
      if (theme === 'light' || theme === 'dark') {
        patch['ui.theme'] = theme;
      }
      const flags: Record<string, 'ui.minimap' | 'editor.wordWrap' | 'ui.sidebar'> = { minimap: 'ui.minimap', wordWrap: 'editor.wordWrap', sidebar: 'ui.sidebar' };
      Object.entries(flags).forEach(([legacy, key]) => {
        const stored = localStorage.getItem(legacy);
        if (stored === 'true' || stored === 'false') {
          patch[key] = stored === 'true';
        }
      });
      if (Object.keys(patch).length > 0) {
        await appSettings.patch(patch);
      }
    } catch (error) {
      console.error('Could not migrate the old settings:', error);
    }
  }

  function clearLegacySettings(): void {
    try {
      LEGACY_SETTINGS.forEach((key) => localStorage.removeItem(key));
    } catch {
      // Storage unavailable: nothing to clean up.
    }
  }

  /** Runs a Monaco action; document tabs have no such action, so the status bar says so. */
  function runEditorAction(actionId: string): void {
    if (activeTab && activeTab.kind !== 'text') {
      setStatus(NOT_AVAILABLE_MESSAGE);
      return;
    }
    editor.focus();
    editor.trigger('menu', actionId, null);
  }

  function findInActiveTab(): void {
    if (activeTab && activeTab.kind !== 'text') {
      if (activeTab.view.find) {
        activeTab.view.find();
      } else {
        setStatus(NOT_AVAILABLE_MESSAGE);
      }
      return;
    }
    runEditorAction('actions.find');
  }

  // ---------- Core commands ----------

  const toggleSetting = (key: BooleanSettingKey): Promise<void> => appSettings.set(key, !appSettings.get(key));

  function registerCoreCommands(): void {
    const core: Record<string, () => unknown> = {
      'file.new': () => addTab({ content: '' }),
      'file.open': handleOpenFiles,
      'file.openAsText': openActiveAsText,
      'file.openFolder': openFolder,
      'file.save': () => activeTab && saveTab(activeTab),
      'file.saveAs': () => activeTab && saveTabAs(activeTab),
      'file.saveAll': saveAll,
      'tabs.close': () => activeTab && closeTabFromUi(activeTab),
      'edit.palette': () => runEditorAction('editor.action.quickCommand'),
      'edit.gotoLine': () => runEditorAction('editor.action.gotoLine'),
      'edit.find': findInActiveTab,
      'edit.replace': () => runEditorAction('editor.action.startFindReplace'),
      'view.toggleSidebar': () => toggleSetting('ui.sidebar'),
      'view.toggleMinimap': () => toggleSetting('ui.minimap'),
      'view.toggleWordWrap': () => toggleSetting('editor.wordWrap'),
      'view.toggleTheme': () => appSettings.set('ui.theme', themes.kindOf(themes.current()) === 'light' ? 'dark' : 'light'),
      'tabs.next': () => cycleTab(1),
      'tabs.prev': () => cycleTab(-1),
    };
    Object.entries(core).forEach(([id, run]) => commandRegistry.register({ id, run: run as () => void | Promise<void> }));
  }

  // ---------- Feature context ----------

  /** Serialized bytes of a document tab (current edits included) for the given extension; rejects for text/diff tabs. */
  async function exportTabBytes(tab: CodePadTab, ext: string): Promise<Uint8Array> {
    if (!tabs.includes(tab) || tab.kind === 'text' || tab.kind === 'diff') {
      throw new Error(NOT_AVAILABLE_MESSAGE);
    }
    return tab.view.getBytes(ext);
  }

  // Libraries the editors load lazily; ctx.libs.load reuses their files and globals.
  const LIB_SCRIPTS: Record<string, { path: string; global: 'mammoth' | 'docx' | 'XLSX' }> = {
    mammoth: { path: 'mammoth/mammoth.browser.min.js', global: 'mammoth' },
    docx: { path: 'docx/dist/index.iife.js', global: 'docx' },
    xlsx: { path: 'xlsx/dist/xlsx.full.min.js', global: 'XLSX' },
  };
  const PDFJS_MODULE = 'pdfjs-dist/build/pdf.min.mjs';
  const PDFJS_WORKER = 'pdfjs-dist/build/pdf.worker.min.mjs';

  /** Loads 'mammoth', 'xlsx', 'docx' or 'pdfjs' (pdf.js with its worker configured) and returns the library. */
  async function loadLibrary<K extends keyof CodePadLibraries>(name: K): Promise<CodePadLibraries[K]> {
    const util = window.CodePadEditors.util;
    if (name === 'pdfjs') {
      const lib = await util.loadModule(util.nodeModulesUrl(PDFJS_MODULE));
      lib.GlobalWorkerOptions.workerSrc = util.nodeModulesUrl(PDFJS_WORKER);
      return lib as CodePadLibraries[K];
    }
    const script = Object.hasOwn(LIB_SCRIPTS, name) ? LIB_SCRIPTS[name] : null;
    if (!script) {
      throw new Error(`Unknown library: ${name}`);
    }
    if (!window[script.global]) {
      await util.loadScript(util.nodeModulesUrl(script.path));
    }
    if (!window[script.global]) {
      throw new Error(`The ${name} library failed to load.`);
    }
    return window[script.global] as CodePadLibraries[K];
  }

  /** File URL of a pdf.js asset folder or file (e.g. 'pdfjs-dist/cmaps/'). */
  function libAssetUrl(rel: string): string {
    if (typeof rel !== 'string' || !rel.startsWith('pdfjs-dist/')) {
      throw new Error(`Invalid library asset: ${rel}`);
    }
    return window.CodePadEditors.util.nodeModulesUrl(rel);
  }

  /** The preload `ai` API as a frozen object for ctx.ai. */
  function buildAiApi(): CodePadAiApi {
    const ai = api.ai;
    return Object.freeze({
      status: ai.status,
      onEvent: ai.onEvent,
      model: Object.freeze({
        download: ai.model.download,
        pause: ai.model.pause,
        resume: ai.model.resume,
        cancel: ai.model.cancel,
        remove: ai.model.remove,
        checkConnection: ai.model.checkConnection,
      }),
      suggest: ai.suggest,
      cancelSuggest: ai.cancelSuggest,
      summarize: ai.summarize,
      cancelSummary: ai.cancelSummary,
      clearSummaryCache: ai.clearSummaryCache,
      retryDefault: ai.retryDefault,
      rewrite: ai.rewrite,
      cancelRewrite: ai.cancelRewrite,
      chat: ai.chat,
      cancelChat: ai.cancelChat,
      models: Object.freeze({
        list: ai.models.list,
        add: ai.models.add,
        update: ai.models.update,
        remove: ai.models.remove,
        setEnabled: ai.models.setEnabled,
        setActive: ai.models.setActive,
        setKey: ai.models.setKey,
        test: ai.models.test,
        consent: ai.models.consent,
        pull: ai.models.pull,
        cancelPull: ai.models.cancelPull,
      }),
    });
  }

  function activeTextTab(): CodePadTextTab | null {
    if (!activeTab || activeTab.kind !== 'text') {
      setStatus(NOT_AVAILABLE_MESSAGE);
      return null;
    }
    return activeTab;
  }

  /** Merges overlapping ranges away (keeps the first of each overlapping group), in document order. */
  function disjointRanges(ranges: monaco.Range[]): monaco.Range[] {
    const sorted = [...ranges].sort((a, b) => monaco.Range.compareRangesUsingStarts(a, b));
    return sorted.filter((range, index) => index === 0 || !monaco.Range.areIntersecting(sorted[index - 1], range));
  }

  /** Resolves a text-helper scope to the ranges it covers (see ctx.text.transformSelections). */
  function rangesForScope(scope: CodePadTextScope, model: monaco.editor.ITextModel): monaco.Range[] {
    const selections = (editor.getSelections() || []).map((selection) => monaco.Range.lift(selection));
    const filled = selections.filter((range) => !range.isEmpty());
    const full = model.getFullModelRange();
    const wholeLines = (range: monaco.Range): monaco.Range => {
      const endLine = range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber;
      return new monaco.Range(range.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
    };
    switch (scope) {
      case 'selection':
        return filled;
      case 'lines':
        return (filled.length > 0 ? filled : selections).map(wholeLines);
      case 'document':
        return [full];
      case 'wordOrSelection': {
        if (filled.length > 0) {
          return filled;
        }
        const position = editor.getPosition();
        const word = position ? model.getWordAtPosition(position) : null;
        return position && word ? [new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)] : [];
      }
      case 'selectionOrDocument':
        return filled.length > 0 ? filled : [full];
      case 'linesOrDocument':
        return filled.length > 0 ? filled.map(wholeLines) : [full];
      default:
        throw new Error(`Unknown text scope: ${scope}`);
    }
  }

  /** Replaces each range by fn(text, info); nothing is edited when fn throws. Returns true when text changed. */
  function transformSelections(
    fn: (text: string, info: CodePadTransformInfo) => string,
    { scope = 'selection', label }: { scope?: CodePadTextScope; label?: string } = {},
  ): boolean {
    const tab = activeTextTab();
    if (!tab) {
      return false;
    }
    const model = tab.model;
    const ranges = disjointRanges(rangesForScope(scope, model));
    if (ranges.length === 0) {
      setStatus(scope === 'wordOrSelection' ? 'Nothing to convert.' : 'Nothing selected.');
      return false;
    }
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    ranges.forEach((range, index) => {
      const text = model.getValueInRange(range);
      const next = fn(text, { range, index, model, tab });
      if (typeof next !== 'string') {
        throw new TypeError('The transform must return a string.');
      }
      if (next !== text) {
        edits.push({ range, text: next, forceMoveMarkers: true });
      }
    });
    if (edits.length === 0) {
      return false;
    }
    editor.pushUndoStop();
    editor.executeEdits(label || 'transform', edits);
    editor.pushUndoStop();
    return true;
  }

  /** Line-mode helper: fn gets the lines of each range (without line breaks) and returns the new lines. */
  function transformLines(
    fn: (lines: string[], info: CodePadTransformInfo) => string[],
    { scope = 'selectionOrDocument', label }: { scope?: CodePadLineScope; label?: string } = {},
  ): boolean {
    const lineScopes: Record<CodePadLineScope, CodePadTextScope> = { selection: 'selection', lines: 'lines', document: 'document', selectionOrDocument: 'linesOrDocument' };
    return transformSelections(
      (text, info) => {
        const eol = info.model.getEOL();
        const trailing = text.endsWith(eol);
        const lines = (trailing ? text.slice(0, -eol.length) : text).split(/\r\n|\r|\n/);
        const out = fn(lines, info);
        if (!Array.isArray(out)) {
          throw new TypeError('The line transform must return an array of lines.');
        }
        return out.join(eol) + (trailing ? eol : '');
      },
      { scope: lineScopes[scope] || scope, label },
    );
  }

  function selectionOrDocument(): CodePadTextSelection | null {
    const tab = activeTextTab();
    if (!tab) {
      return null;
    }
    const selections = (editor.getSelections() || []).filter((selection) => !selection.isEmpty());
    return selections.length > 0
      ? { tab, model: tab.model, ranges: selections.map((selection) => monaco.Range.lift(selection)), isSelection: true }
      : { tab, model: tab.model, ranges: [tab.model.getFullModelRange()], isSelection: false };
  }

  function insertAtCursors(textOrFn: string | ((index: number, selection: monaco.Selection) => string)): boolean {
    const tab = activeTextTab();
    if (!tab) {
      return false;
    }
    const edits = (editor.getSelections() || []).map((selection, index) => ({
      range: selection,
      text: typeof textOrFn === 'function' ? textOrFn(index, selection) : textOrFn,
      forceMoveMarkers: true,
    }));
    editor.pushUndoStop();
    editor.executeEdits('insert', edits);
    editor.pushUndoStop();
    return true;
  }

  /** Applies edits ({range, text}) to any text model as one undo step. */
  function replaceAll(model: monaco.editor.ITextModel, edits: CodePadTextEdit[], label?: string): void {
    model.pushStackElement();
    model.pushEditOperations([], edits.map(({ range, text }) => ({ range, text })), () => null);
    model.pushStackElement();
    if (label) {
      setStatus(label);
    }
  }

  const publicApi = <T extends { internal: unknown }>(source: T): Readonly<Omit<T, 'internal'>> => {
    const { internal: _internal, ...rest } = source;
    return Object.freeze(rest);
  };

  function buildContext(): CodePadCtx {
    const tabsApi = Object.freeze<CodePadTabsApi>({
      list: () => [...tabs],
      active: () => activeTab,
      byId: (id) => tabs.find((tab) => tab.id === id) || null,
      activate: activateTab,
      close: async (tab, { force = false } = {}) => {
        if (!tabs.includes(tab) || (!force && (isPinned(tab) || closeVetoed(tab)))) {
          return false;
        }
        return closeTab(tab);
      },
      closeMany,
      move: moveTab,
      openPath,
      openText,
      openView,
      reveal: revealInTab,
      save: saveTab,
      saveAs: saveTabAs,
      saveAll,
      reload: reloadTab,
      detectEol,
      changed: () => renderTabs(),
      forceDirty,
      decorate: (fn) => tabDecorators.push(fn),
      onContextMenu: (fn) => {
        tabContextMenuHandler = fn;
      },
      interceptClose: (fn) => closeInterceptors.push(fn),
      contributeMenu: (fn) => menuContributors.push(fn),
      menuContributions: (tab) =>
        menuContributors.flatMap((contribute) => {
          try {
            return contribute(tab) || [];
          } catch (error) {
            console.error('Tab menu contributor failed:', error);
            return [];
          }
        }),
      exportBytes: exportTabBytes,
    });
    const filesApi = Object.freeze<CodePadFilesApi>({
      readText: (filePath, options = {}) => api.readFile(filePath, options),
      stat: (filePath) => api.statFile(filePath),
      hashFile: (filePath, algo) => api.hashFile(filePath, algo),
      reveal: (filePath) => api.reveal(filePath),
      watch: (filePath) => api.watch.add(filePath),
      unwatch: (filePath) => api.watch.remove(filePath),
      create: (filePath, content) => api.files.create(filePath, content),
      rename: (filePath, newName) => api.files.rename(filePath, newName),
      trash: (filePath) => api.files.trash(filePath),
      recent: Object.freeze({
        list: async () => (await api.recent.list()).map(({ path, name }) => ({ path, name })),
        add: (filePath) => api.recent.add(filePath),
        clear: () => api.recent.clear(),
        approveAt: (index) => api.recent.approveAt(index),
      }),
    });
    const context: CodePadCtx = {
      version: 1,
      get monaco() {
        return monaco;
      },
      get editor() {
        return editor;
      },
      tabs: tabsApi,
      text: Object.freeze({ selectionOrDocument, transformSelections, transformLines, insertAtCursors, replaceAll }),
      files: filesApi,
      settings: appSettings,
      status: Object.freeze({ set: setStatus, addItem: addStatusItem }),
      ai: buildAiApi(),
      libs: Object.freeze({ load: loadLibrary, assetUrl: libAssetUrl }),
      clipboard: Object.freeze({ write: (text) => navigator.clipboard.writeText(text) }),
      ui,
      panels: publicApi(panelsHost),
      commands: publicApi(commandRegistry),
      themes: publicApi(themes),
      events: Object.freeze({ on: bus.on, emit: bus.emit }),
      session: Object.freeze({
        schedule: scheduleSessionSave,
        snapshot: () => snapshotSession(sessionTabs()) as Promise<{ tabs: CpSessionTab[] }>,
        restore: restoreSnapshot,
      }),
      app: Object.freeze({ version: appVersion, platform, baseName, extensionOf }),
    };
    return Object.freeze(context);
  }

  // ---------- Startup ----------

  function registerExplorerPanel(): void {
    panelsHost.register({
      id: 'explorer',
      title: 'Explorer',
      location: 'left',
      order: 0,
      container: byId('panel-explorer'),
      render: () => ({}),
    });
  }

  function bindEvents(): void {
    bus.on('settings:changed', onSettingChanged);
    bus.on('layout:changed', () => {
      editor.layout();
      layoutActiveView();
    });
    editor.onDidChangeCursorPosition(updateCursorStatus);
    els.lang.addEventListener('change', () => {
      if (activeTab && activeTab.kind === 'text') {
        activeTab.autoDetect = false;
        monaco.editor.setModelLanguage(activeTab.model, els.lang.value);
        editor.focus();
      }
    });

    api.onCommand(({ id }) => commandRegistry.execute(id));
    api.onOpenPaths(async ({ paths, line }) => {
      for (let index = 0; index < paths.length; index += 1) {
        await openPath(paths[index], { line: index === 0 ? line : undefined });
      }
    });
    api.watch.onEvent((event) => bus.emit('file:changedOnDisk', event));
    api.onRequestClose(requestClose);
    window.addEventListener('resize', layoutActiveView);

    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', async (event) => {
      event.preventDefault();
      for (const file of event.dataTransfer?.files ?? []) {
        try {
          await openPath(await api.approveDropped(file));
        } catch (error) {
          setStatus(`Could not open ${file.name}: ${errorMessage(error)}`);
        }
      }
    });
  }

  async function init(): Promise<void> {
    monaco = window.monaco;
    const firstStart = await appSettings.load();
    if (firstStart) {
      await migrateLegacySettings();
      clearLegacySettings();
    }
    try {
      commandRegistry.internal.setTable(await api.commands.table());
      appVersion = (await api.appInfo()).version;
    } catch (error) {
      console.error('Could not load the command table:', error);
    }
    await loadEncodingLabels();

    themes.internal.setMonaco(monaco);
    editor = monaco.editor.create(els.editor, {
      model: null,
      automaticLayout: true,
      glyphMargin: true,
      fontLigatures: true,
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      ...settingsEditorOptions(),
    });

    buildLanguageIndex();
    ctx = buildContext();
    registerCoreCommands();
    commandRegistry.internal.bindContext(ctx);
    commandRegistry.internal.attachEditor(editor);
    registerExplorerPanel();
    panelsHost.internal.start(ctx);
    updateEditorVisibility();
    bindEvents();
    bus.emit('editor:created', editor);

    const failed = window.CodePadFeatures.initAll(ctx);
    applyTheme();
    if (failed.length > 0) {
      setStatus(`Some features could not start: ${failed.join(', ')}.`);
    }

    sessionRestored = restoreSession()
      .catch((error) => setStatus(`Could not restore the previous session: ${errorMessage(error)}`))
      .then(() => api.ready());
  }

  window.require.config({ paths: { vs: `${monacoBase}/vs` } });
  window.require(['vs/editor/editor.main'], () => {
    init().catch((error) => {
      console.error(error);
      setStatus(`CodePad could not start: ${errorMessage(error)}`);
    });
  });
})();
