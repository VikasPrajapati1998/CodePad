// Word dropdown, independent of the AI: words from every open text tab in every language (also plain text and
// markdown) plus a small snippet set. `editor.autoSuggest` only switches the automatic popup; Ctrl+Space
// (editor.action.triggerSuggest) works in both states. Monaco's own word suggestions are turned off so the items
// are not duplicated.
(() => {
  const MAX_SCAN_CHARS = 300000;
  const MAX_WORDS = 20000;
  const MAX_RESULTS = 50;
  const SCAN_DELAY_MS = 1000;
  const WORD_PATTERN = /[\p{L}_$][\p{L}\p{N}_$]{2,39}/gu;

  const PAREN_FLOW: Record<string, string> = {
    if: 'if (${1:condition}) {\n\t$0\n}',
    ifelse: 'if (${1:condition}) {\n\t$0\n} else {\n\t\n}',
    while: 'while (${1:condition}) {\n\t$0\n}',
  };
  const BARE_FLOW: Record<string, string> = {
    if: 'if ${1:condition} {\n\t$0\n}',
    ifelse: 'if ${1:condition} {\n\t$0\n} else {\n\t\n}',
    while: 'while ${1:condition} {\n\t$0\n}',
  };
  const TRY_CATCH = (type: string): string => `try {\n\t$0\n} catch (${type}) {\n\t\n}`;
  const INDEXED = (type: string): string => `for (${type} \${1:i} = 0; \${1:i} < \${2:count}; \${1:i}++) {\n\t$0\n}`;

  /** Snippets per Monaco language id: name -> snippet body. */
  const SNIPPETS: Record<string, Record<string, string>> = {
    javascript: {
      ...PAREN_FLOW,
      for: 'for (const ${1:item} of ${2:items}) {\n\t$0\n}',
      fori: INDEXED('let'),
      try: TRY_CATCH('${1:error}'),
      function: 'function ${1:name}(${2:params}) {\n\t$0\n}',
    },
    java: {
      ...PAREN_FLOW,
      for: 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}',
      fori: INDEXED('int'),
      try: TRY_CATCH('${1:Exception} ${2:e}'),
      function: '${1:void} ${2:name}(${3:params}) {\n\t$0\n}',
    },
    csharp: {
      ...PAREN_FLOW,
      for: 'foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}',
      fori: INDEXED('int'),
      try: TRY_CATCH('${1:Exception} ${2:e}'),
      function: '${1:void} ${2:Name}(${3:params})\n{\n\t$0\n}',
    },
    c: {
      ...PAREN_FLOW,
      fori: INDEXED('int'),
      function: '${1:void} ${2:name}(${3:params}) {\n\t$0\n}',
    },
    cpp: {
      ...PAREN_FLOW,
      for: 'for (auto& ${1:item} : ${2:items}) {\n\t$0\n}',
      fori: INDEXED('int'),
      try: TRY_CATCH('const std::exception& ${1:e}'),
      function: '${1:void} ${2:name}(${3:params}) {\n\t$0\n}',
    },
    php: {
      ...PAREN_FLOW,
      for: 'foreach (\\$${1:items} as \\$${2:item}) {\n\t$0\n}',
      fori: 'for (\\$${1:i} = 0; \\$${1:i} < ${2:count}; \\$${1:i}++) {\n\t$0\n}',
      try: TRY_CATCH('Exception \\$${1:e}'),
      function: 'function ${1:name}(${2:params}) {\n\t$0\n}',
    },
    kotlin: {
      ...PAREN_FLOW,
      for: 'for (${1:item} in ${2:items}) {\n\t$0\n}',
      fori: 'for (${1:i} in 0 until ${2:count}) {\n\t$0\n}',
      try: TRY_CATCH('${1:e}: ${2:Exception}'),
      fun: 'fun ${1:name}(${2:params}) {\n\t$0\n}',
    },
    dart: {
      ...PAREN_FLOW,
      for: 'for (final ${1:item} in ${2:items}) {\n\t$0\n}',
      fori: INDEXED('var'),
      try: TRY_CATCH('${1:e}'),
      function: '${1:void} ${2:name}(${3:params}) {\n\t$0\n}',
    },
    go: {
      ...BARE_FLOW,
      while: 'for ${1:condition} {\n\t$0\n}',
      for: 'for ${1:_}, ${2:item} := range ${3:items} {\n\t$0\n}',
      fori: 'for ${1:i} := 0; ${1:i} < ${2:count}; ${1:i}++ {\n\t$0\n}',
      func: 'func ${1:name}(${2:params}) ${3:error} {\n\t$0\n}',
    },
    rust: {
      ...BARE_FLOW,
      for: 'for ${1:item} in ${2:items} {\n\t$0\n}',
      fori: 'for ${1:i} in 0..${2:count} {\n\t$0\n}',
      fn: 'fn ${1:name}(${2:params}) {\n\t$0\n}',
    },
    swift: {
      ...BARE_FLOW,
      for: 'for ${1:item} in ${2:items} {\n\t$0\n}',
      fori: 'for ${1:i} in 0..<${2:count} {\n\t$0\n}',
      try: 'do {\n\t$0\n} catch {\n\t\n}',
      func: 'func ${1:name}(${2:params}) {\n\t$0\n}',
    },
    python: {
      for: 'for ${1:item} in ${2:items}:\n\t$0',
      if: 'if ${1:condition}:\n\t$0',
      ifelse: 'if ${1:condition}:\n\t$0\nelse:\n\t',
      while: 'while ${1:condition}:\n\t$0',
      try: 'try:\n\t$0\nexcept ${1:Exception} as ${2:error}:\n\t',
      def: 'def ${1:name}(${2:params}):\n\t$0',
      class: 'class ${1:Name}:\n\tdef __init__(self${2:, params}):\n\t\t$0',
      with: 'with ${1:expression} as ${2:name}:\n\t$0',
    },
    shell: {
      if: 'if [ ${1:condition} ]; then\n\t$0\nfi',
      for: 'for ${1:item} in ${2:items}; do\n\t$0\ndone',
      while: 'while ${1:condition}; do\n\t$0\ndone',
      function: '${1:name}() {\n\t$0\n}',
    },
  };
  SNIPPETS.typescript = SNIPPETS.javascript;

  type Monaco = CodePadCtx['monaco'];

  /** Word counts of one open text model. */
  interface IndexEntry {
    counts: Map<string, number>;
    dirty: boolean;
    timer: number | null;
    listener: monaco.IDisposable;
  }

  const index = new Map<monaco.editor.ITextModel, IndexEntry>();
  let appCtx: CodePadCtx | null = null;
  const configured = new WeakSet<object>();

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The autosuggest feature is not initialized.');
    }
    return appCtx;
  }

  /** Counts the words of one model (at most the first MAX_SCAN_CHARS characters). */
  function scan(model: monaco.editor.ITextModel): Map<string, number> {
    const counts = new Map<string, number>();
    const text = model.getValue().slice(0, MAX_SCAN_CHARS);
    WORD_PATTERN.lastIndex = 0;
    for (let match = WORD_PATTERN.exec(text); match !== null; match = WORD_PATTERN.exec(text)) {
      const word = match[0];
      if (counts.has(word)) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
      } else if (counts.size < MAX_WORDS) {
        counts.set(word, 1);
      }
    }
    return counts;
  }

  function refreshEntry(model: monaco.editor.ITextModel, entry: IndexEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.counts = scan(model);
    entry.dirty = false;
  }

  /** Brings the index in line with the open text tabs: adds new models, drops closed ones. */
  function sync(): void {
    const models = new Set<monaco.editor.ITextModel>();
    app().tabs.list().forEach((tab) => {
      if (tab.kind === 'text' && tab.model && !tab.model.isDisposed()) {
        models.add(tab.model);
      }
    });
    index.forEach((entry, model) => {
      if (!models.has(model)) {
        entry.listener.dispose();
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
        index.delete(model);
      }
    });
    models.forEach((model) => {
      if (index.has(model)) {
        return;
      }
      const entry: IndexEntry = {
        counts: new Map(),
        dirty: true,
        timer: null,
        listener: model.onDidChangeContent(() => {
          entry.dirty = true;
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
          }
          entry.timer = setTimeout(() => {
            entry.timer = null;
            if (!model.isDisposed()) {
              refreshEntry(model, entry);
            }
          }, SCAN_DELAY_MS);
        }),
      };
      index.set(model, entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.dirty && !model.isDisposed()) {
          refreshEntry(model, entry);
        }
      }, 0);
    });
  }

  /** Words of all open tabs starting with `prefix` (case-insensitive), most frequent first. */
  function matchingWords(model: monaco.editor.ITextModel, prefix: string): string[] {
    const own = index.get(model);
    if (own && own.dirty) {
      refreshEntry(model, own);
    }
    const lower = prefix.toLowerCase();
    const totals = new Map<string, number>();
    index.forEach((entry) => {
      entry.counts.forEach((count, word) => {
        if (word !== prefix && (lower === '' || word.toLowerCase().startsWith(lower))) {
          totals.set(word, (totals.get(word) || 0) + count);
        }
      });
    });
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_RESULTS)
      .map(([word]) => word);
  }

  function provide(
    monaco: Monaco,
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.CompletionContext,
  ): monaco.languages.CompletionList {
    sync();
    const typed = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, typed.startColumn, position.lineNumber, typed.endColumn);
    const prefix = typed.word;
    const invoked = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke;
    const suggestions: monaco.languages.CompletionItem[] = [];
    const lower = prefix.toLowerCase();
    const snippets = SNIPPETS[model.getLanguageId()] || {};
    Object.entries(snippets).forEach(([name, body]) => {
      if (name.startsWith(lower) && (prefix !== '' || invoked)) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: 'snippet',
          insertText: body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: `0${name}`,
          range,
        });
      }
    });
    if (prefix !== '' || invoked) {
      matchingWords(model, prefix).forEach((word, rank) => {
        suggestions.push({
          label: word,
          kind: monaco.languages.CompletionItemKind.Text,
          detail: 'word',
          insertText: word,
          sortText: `1${String(rank).padStart(3, '0')}`,
          range,
        });
      });
    }
    return { suggestions };
  }

  function applyOptions(editor: monaco.editor.IStandaloneCodeEditor): void {
    const on = app().settings.get('editor.autoSuggest') !== false;
    editor.updateOptions({
      quickSuggestions: on ? { other: 'on', comments: 'on', strings: 'on' } : false,
      suggestOnTriggerCharacters: on,
      wordBasedSuggestions: 'off',
    });
  }

  function setup(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (!editor || configured.has(editor)) {
      return;
    }
    configured.add(editor);
    applyOptions(editor);
  }

  CodePadCommands.register({
    id: 'suggest.toggleDropdown',
    run(ctx) {
      const next = ctx.settings.get('editor.autoSuggest') === false;
      ctx.settings.set('editor.autoSuggest', next);
      ctx.status.set(next ? 'Word suggestions while typing: on' : 'Word suggestions while typing: off (Ctrl+Space still works)');
    },
  });

  CodePadFeatures.register('autosuggest', {
    init(ctx) {
      appCtx = ctx;
      const { monaco } = ctx;
      const languages = monaco.languages.getLanguages().map((language) => language.id);
      monaco.languages.registerCompletionItemProvider(languages, {
        provideCompletionItems: (model, position, context) => provide(monaco, model, position, context),
      });
      setup(ctx.editor);
      ctx.events.on('editor:created', setup);
      ctx.events.on('tab:closed', sync);
      ctx.settings.onChange(({ key }) => {
        if (key === 'editor.autoSuggest' && ctx.editor) {
          applyOptions(ctx.editor);
        }
      });
    },
  });
})();
