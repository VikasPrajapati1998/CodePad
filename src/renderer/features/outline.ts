(function () {
  'use strict';

  // Code outline (function list) bottom panel. JavaScript/TypeScript use the
  // Monaco TypeScript worker; other languages use a regex heuristic that does
  // not parse comments or strings.

  const REFRESH_DELAY_MS = 500;
  const MAX_LINES = 200000;
  const MAX_SYMBOLS = 5000;
  const MAX_TS_CHARS = 5000000;
  const MAX_LEVEL = 3;

  /** One line-based heuristic: `re` captures the name, `skip` rejects keyword lines that look like declarations. */
  interface OutlineRule {
    re: RegExp;
    kind: string;
    skip?: RegExp;
  }

  interface OutlineSymbol {
    name: string;
    kind: string;
    line: number;
    level: number;
  }

  /** The part of the TypeScript worker's navigation tree the outline reads. */
  interface NavigationNode {
    text: string;
    kind: string;
    spans?: { start: number; length: number }[];
    childItems?: NavigationNode[];
  }

  const NAME = '([A-Za-z_$][\\w$]*)';
  const JS_RULES: OutlineRule[] = [
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${NAME}`), kind: 'class' },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${NAME}`), kind: 'function' },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${NAME}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${NAME}\\s*=>)`), kind: 'function' }
  ];
  const C_TYPE = new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|export|data|open)\\s+)*(?:class|struct|interface|enum|namespace|object|record|trait|protocol|extension)\\s+${NAME}`);
  const C_FUNC = new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|inline|extern|unsafe|synchronized|const)\\s+)*[A-Za-z_][\\w:<>,\\[\\]*&\\s]*?[\\s*&]${NAME}\\s*\\([^;]*$`);
  const CLIKE_RULES: OutlineRule[] = [
    { re: C_TYPE, kind: 'class' },
    { re: C_FUNC, kind: 'function', skip: /^\s*(?:return|else|if|for|while|switch|catch|new|throw|delete|case|using)\b/ }
  ];

  const RULES: Record<string, OutlineRule[]> = {
    python: [
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' }
    ],
    go: [
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'class' }
    ],
    rust: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)/, kind: 'class' },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)*fn\s+([A-Za-z_]\w*)/, kind: 'function' }
    ],
    java: CLIKE_RULES,
    csharp: CLIKE_RULES,
    c: CLIKE_RULES,
    cpp: CLIKE_RULES,
    kotlin: [
      { re: C_TYPE, kind: 'class' },
      { re: /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, kind: 'function' }
    ],
    swift: [
      { re: C_TYPE, kind: 'class' },
      { re: /^\s*(?:(?:public|private|fileprivate|internal|open|static|class|override|mutating)\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function' }
    ],
    php: [
      { re: /^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, kind: 'function' }
    ],
    ruby: [
      { re: /^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/, kind: 'class' },
      { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'function' }
    ],
    lua: [
      { re: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/, kind: 'function' }
    ],
    shell: [
      { re: /^\s*function\s+([A-Za-z_][\w-]*)/, kind: 'function' },
      { re: /^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function' }
    ],
    markdown: [],
    ini: [
      { re: /^\s*\[([^\]]+)\]/, kind: 'section' }
    ],
    yaml: [
      { re: /^([A-Za-z_][\w. -]*):(?:\s|$)/, kind: 'section' }
    ],
    sql: [
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:table|view|function|procedure|trigger|index|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)/i, kind: 'section' }
    ],
    bat: [
      { re: /^\s*:([A-Za-z_][\w-]*)/, kind: 'section' }
    ]
  };
  RULES.javascript = JS_RULES;
  RULES.typescript = JS_RULES;
  RULES.shellscript = RULES.shell;

  const TS_KINDS: Record<string, string | undefined> = {
    function: 'function',
    method: 'method',
    constructor: 'method',
    class: 'class',
    interface: 'class',
    enum: 'class',
    type: 'class',
    module: 'section',
    namespace: 'section',
    const: 'variable',
    let: 'variable',
    var: 'variable',
    property: 'variable'
  };

  const KIND_MARK: Record<string, string | undefined> = {
    function: 'fn', method: 'm', class: 'C', heading: '#', section: '[ ]', variable: 'v'
  };

  /**
   * Heuristic symbols for one document.
   * @param model Monaco text model.
   * @param languageId Language id of the model.
   * @param tabSize Indent width used to derive nesting levels.
   */
  function regexSymbols(model: monaco.editor.ITextModel, languageId: string, tabSize: number): OutlineSymbol[] {
    const symbols: OutlineSymbol[] = [];
    const lineCount = Math.min(model.getLineCount(), MAX_LINES);
    const rules = RULES[languageId] || [];
    const isMarkdown = languageId === 'markdown';
    let inFence = false;
    for (let line = 1; line <= lineCount && symbols.length < MAX_SYMBOLS; line++) {
      const text = model.getLineContent(line);
      if (text.length > 400) {
        continue;
      }
      if (isMarkdown) {
        if (/^\s*(```|~~~)/.test(text)) {
          inFence = !inFence;
        }
        const heading = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
        if (heading) {
          symbols.push({ name: heading[2], kind: 'heading', line, level: heading[1].length - 1 });
        }
        continue;
      }
      for (const rule of rules) {
        if (rule.skip && rule.skip.test(text)) {
          continue;
        }
        const match = rule.re.exec(text);
        if (match) {
          const name = match[1] || match[2];
          const indent = (/^\s*/.exec(text)?.[0] ?? '').replace(/\t/g, ' '.repeat(tabSize)).length;
          symbols.push({ name, kind: rule.kind, line, level: Math.min(MAX_LEVEL, Math.floor(indent / tabSize)) });
          break;
        }
      }
    }
    return symbols;
  }

  /**
   * Symbols from the Monaco TypeScript worker's navigation tree.
   * @param monacoNs Monaco namespace.
   * @param model Monaco text model (JavaScript or TypeScript).
   * @returns null when the worker is unavailable.
   */
  async function tsSymbols(monacoNs: typeof monaco, model: monaco.editor.ITextModel): Promise<OutlineSymbol[] | null> {
    const api = monacoNs.languages.typescript;
    if (!api || typeof api.getTypeScriptWorker !== 'function') {
      return null;
    }
    const getWorker = await api.getTypeScriptWorker();
    const client = await getWorker(model.uri);
    const root: NavigationNode | undefined = await client.getNavigationTree(model.uri.toString());
    if (!root) {
      return null;
    }
    const symbols: OutlineSymbol[] = [];
    const walk = (node: NavigationNode, level: number): void => {
      (node.childItems || []).forEach((child) => {
        const kind = TS_KINDS[child.kind];
        const span = child.spans && child.spans[0];
        const descend = kind === 'function' || kind === 'method' || kind === 'class' || kind === 'section';
        if (kind && span && symbols.length < MAX_SYMBOLS && (kind !== 'variable' || level <= 1)) {
          symbols.push({
            name: child.text,
            kind,
            line: model.getPositionAt(span.start).lineNumber,
            level: Math.min(MAX_LEVEL, level)
          });
        }
        if (descend) {
          walk(child, kind ? level + 1 : level);
        }
      });
    };
    walk(root, 0);
    return symbols;
  }

  /**
   * Collect outline symbols for a text tab.
   * @param ctx Feature context.
   * @param tab Text tab.
   */
  async function getSymbols(ctx: CodePadCtx, tab: CodePadTextTab): Promise<OutlineSymbol[]> {
    const model = tab.model;
    const languageId = model.getLanguageId();
    if ((languageId === 'javascript' || languageId === 'typescript') && model.getValueLength() <= MAX_TS_CHARS) {
      try {
        const symbols = await tsSymbols(ctx.monaco, model);
        if (symbols) {
          return symbols;
        }
      } catch (error) {
        console.warn('Outline: TypeScript worker unavailable, using regex fallback.', error);
      }
    }
    return regexSymbols(model, languageId, model.getOptions().tabSize || 4);
  }

  // ---- Panel ----

  function createPanel(container: HTMLElement, ctx: CodePadCtx): CodePadPanelInstance {
    const root = document.createElement('div');
    root.className = 'cp-outline';

    const bar = document.createElement('div');
    bar.className = 'cp-outline-bar';
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'cp-outline-filter';
    filter.placeholder = 'Filter symbols';
    filter.setAttribute('aria-label', 'Filter symbols');
    const sortButton = document.createElement('button');
    sortButton.type = 'button';
    sortButton.className = 'cp-outline-sort';
    bar.append(filter, sortButton);

    const list = document.createElement('div');
    list.className = 'cp-outline-list';
    root.append(bar, list);
    container.appendChild(root);

    let symbols: OutlineSymbol[] = [];
    let alphabetical = false;
    let visible = false;
    let timer: number | undefined;
    let requestId = 0;

    function message(text: string): void {
      list.textContent = '';
      const note = document.createElement('div');
      note.className = 'cp-outline-empty';
      note.textContent = text;
      list.appendChild(note);
    }

    function render(): void {
      sortButton.textContent = alphabetical ? 'Sort: A-Z' : 'Sort: position';
      const needle = filter.value.trim().toLowerCase();
      let shown = symbols.filter((symbol) => !needle || symbol.name.toLowerCase().includes(needle));
      if (alphabetical) {
        shown = shown.slice().sort((a, b) => a.name.localeCompare(b.name));
      }
      if (shown.length === 0) {
        message(symbols.length === 0 ? 'No symbols found.' : 'No matching symbols.');
        ctx.panels.setBadge('outline', String(symbols.length || ''));
        return;
      }
      list.textContent = '';
      const fragment = document.createDocumentFragment();
      shown.forEach((symbol) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `cp-outline-row cp-outline-${symbol.kind}`;
        row.style.paddingLeft = `${8 + (alphabetical || needle ? 0 : symbol.level * 14)}px`;
        const mark = document.createElement('span');
        mark.className = 'cp-outline-kind';
        mark.textContent = KIND_MARK[symbol.kind] || '';
        const name = document.createElement('span');
        name.className = 'cp-outline-name';
        name.textContent = symbol.name;
        const line = document.createElement('span');
        line.className = 'cp-outline-line';
        line.textContent = String(symbol.line);
        row.append(mark, name, line);
        row.addEventListener('click', () => {
          const tab = ctx.tabs.active();
          if (tab && tab.kind === 'text') {
            ctx.tabs.reveal(tab, symbol.line, 1);
          }
        });
        fragment.appendChild(row);
      });
      list.appendChild(fragment);
      ctx.panels.setBadge('outline', String(symbols.length));
    }

    async function refresh(): Promise<void> {
      const tab = ctx.tabs.active();
      if (!visible) {
        return;
      }
      if (!tab || tab.kind !== 'text') {
        symbols = [];
        message('Outline is available for text files.');
        return;
      }
      const id = ++requestId;
      let result: OutlineSymbol[];
      try {
        result = await getSymbols(ctx, tab);
      } catch (error) {
        result = [];
        ctx.status.set(`Outline failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (id === requestId && ctx.tabs.active() === tab) {
        symbols = result;
        render();
      }
    }

    function schedule(): void {
      clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DELAY_MS);
    }

    filter.addEventListener('input', render);
    sortButton.addEventListener('click', () => {
      alphabetical = !alphabetical;
      render();
    });
    const offActivated = ctx.events.on('tab:activated', schedule);
    const offReloaded = ctx.events.on('tab:reloaded', schedule);
    const contentListener = ctx.editor.onDidChangeModelContent(schedule);
    render();

    return {
      onShow() {
        visible = true;
        refresh();
      },
      onHide() {
        visible = false;
      },
      dispose() {
        clearTimeout(timer);
        offActivated();
        offReloaded();
        contentListener.dispose();
      }
    };
  }

  CodePadCommands.register({
    id: 'view.outline',
    run: (ctx) => ctx.panels.toggle('outline')
  });

  CodePadFeatures.register('outline', {
    init(ctx) {
      ctx.panels.register({
        id: 'outline',
        title: 'Outline',
        location: 'bottom',
        order: 30,
        render: (container) => createPanel(container, ctx)
      });
    }
  });
})();
