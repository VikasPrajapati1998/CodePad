(function () {
  'use strict';

  // Spell checking for plain text and Markdown tabs: misspelled English words get an Info squiggle (Monaco
  // markers) and quick fixes (top suggestions, Add to dictionary, Ignore). The words are checked offline in
  // main (spell:check); code languages are not checked. Skipped: words with digits, ALL-CAPS, camelCase,
  // snake_case, URLs, e-mail addresses, and in Markdown code spans, fenced code and link targets.

  const OWNER = 'cp-spell';
  const MARKER_SOURCE = 'Spelling';
  const LANGUAGES = ['plaintext', 'markdown'];
  const CHECK_DELAY_MS = 600;
  const MAX_CHARS = 1000000;
  const MAX_WORDS_PER_REQUEST = 2000;
  const MAX_MARKERS = 2000;
  const MAX_CACHE = 20000;
  const MIN_WORD_LENGTH = 2;
  const MAX_WORD_LENGTH = 64;
  const MAX_SUGGESTIONS = 5;
  const HOVER_SUGGESTIONS = 3;
  const SUGGEST_BATCH = 40;
  const MAX_HOVER_LOOKUPS = 200;
  const ADD_COMMAND = 'cp.spell.addWord';
  const IGNORE_COMMAND = 'cp.spell.ignoreWord';

  /** One word found in the text, with its 1-based line and 1-based start/end columns. */
  interface WordHit {
    word: string;
    line: number;
    start: number;
    end: number;
    /** False for a word that follows other words in its sentence (a capitalized one is then a proper noun). */
    sentenceStart: boolean;
  }

  // ---- Tokenizer (pure) ----

  const WORD_RE = /\p{L}[\p{L}\p{M}'’]*/gu;
  const SKIP_SPANS_RE = /`[^`\n]*`|https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\]\([^)\n]*\)|<[^>\n]+>/g;
  /** Text before a word that means the word starts a sentence: nothing, only openers, or a sentence end. */
  const SENTENCE_START_RE = /^[\s"'“‘([*#>_-]*$|[.!?:;]\s*["'”’)*_]*\s*$/;
  const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

  /** Blanks (replaces with spaces, keeping columns) the parts of a line that must not be checked. */
  function maskLine(line: string, markdown: boolean): string {
    const blank = (text: string): string => ' '.repeat(text.length);
    if (markdown) {
      return line.replace(SKIP_SPANS_RE, blank);
    }
    return line.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, blank);
  }

  function isSkippedWord(word: string, rawToken: string): boolean {
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) {
      return true;
    }
    if (/[\d_\\/@]/.test(rawToken)) {
      return true;
    }
    if (word === word.toUpperCase()) {
      return true;
    }
    return /\p{Ll}\p{Lu}/u.test(word);
  }

  /** Finds the checkable words of a text; `markdown` also skips fenced code, code spans and link targets. */
  function findWords(text: string, markdown: boolean): WordHit[] {
    const hits: WordHit[] = [];
    const lines = text.split(/\r\n|\r|\n/);
    let fence: string | null = null;
    lines.forEach((original, index) => {
      if (markdown) {
        const match = FENCE_RE.exec(original);
        if (fence) {
          if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
            fence = null;
          }
          return;
        }
        if (match) {
          fence = match[1];
          return;
        }
      }
      const line = maskLine(original, markdown);
      WORD_RE.lastIndex = 0;
      let found = WORD_RE.exec(line);
      while (found) {
        const word = found[0].replace(/['’]+$/, '');
        const begin = found.index;
        const finish = begin + word.length;
        let from = begin;
        while (from > 0 && /\S/.test(line[from - 1])) {
          from -= 1;
        }
        let to = finish;
        while (to < line.length && /\S/.test(line[to])) {
          to += 1;
        }
        if (!isSkippedWord(word, line.slice(from, to).replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ''))) {
          hits.push({
            word,
            line: index + 1,
            start: begin + 1,
            end: finish + 1,
            sentenceStart: SENTENCE_START_RE.test(line.slice(0, begin))
          });
        }
        found = WORD_RE.exec(line);
      }
    });
    return hits;
  }

  // ---- State ----

  let appCtx: CodePadCtx | null = null;
  let timer: number | undefined;
  /** Words main reported as correct (true) or misspelled (false); cleared when the dictionary changes. */
  const verdicts = new Map<string, boolean>();
  const suggestionCache = new Map<string, string[]>();
  const ignored = new Set<string>();
  let failureShown = false;

  function remember(word: string, correct: boolean): void {
    if (verdicts.size >= MAX_CACHE) {
      verdicts.clear();
      suggestionCache.clear();
    }
    verdicts.set(word, correct);
  }

  /** An unknown capitalized word inside a sentence is taken for a name, not a mistake. */
  function isProperNoun(hit: WordHit): boolean {
    return !hit.sentenceStart && /^\p{Lu}\p{Ll}+$/u.test(hit.word);
  }

  /** The hover text: the mistake plus the best suggestions, so they are visible without opening the quick-fix menu. */
  function hoverMessage(word: string): string {
    const suggestions = (suggestionCache.get(word) ?? []).slice(0, HOVER_SUGGESTIONS);
    return suggestions.length > 0
      ? `"${word}": possible spelling mistake. Did you mean: ${suggestions.join(', ')}? (Ctrl+. to fix)`
      : `"${word}": possible spelling mistake`;
  }

  function isCheckable(model: monaco.editor.ITextModel): boolean {
    return LANGUAGES.includes(model.getLanguageId()) && model.getValueLength() <= MAX_CHARS;
  }

  function clearMarkers(ctx: CodePadCtx, model: monaco.editor.ITextModel): void {
    ctx.monaco.editor.setModelMarkers(model, OWNER, []);
  }

  /** Asks main about the words not in the cache yet. */
  async function resolveWords(words: string[]): Promise<void> {
    const unknown = Array.from(new Set(words.filter((word) => !verdicts.has(word))));
    for (let i = 0; i < unknown.length; i += MAX_WORDS_PER_REQUEST) {
      const batch = unknown.slice(i, i + MAX_WORDS_PER_REQUEST);
      const { misspelled } = await window.codepad.spell.check(batch);
      batch.forEach((word) => remember(word, true));
      misspelled.forEach((item) => {
        remember(item.word, false);
        if (item.suggestions.length > 0) {
          suggestionCache.set(item.word, item.suggestions);
        }
      });
    }
  }

  /** Main ranks suggestions for the first 40 misspellings of a request only; ask for the rest in small batches. */
  async function fillSuggestions(words: string[]): Promise<void> {
    const missing = Array.from(new Set(words.filter((word) => !suggestionCache.has(word)))).slice(0, MAX_HOVER_LOOKUPS);
    for (let i = 0; i < missing.length; i += SUGGEST_BATCH) {
      const { misspelled } = await window.codepad.spell.check(missing.slice(i, i + SUGGEST_BATCH));
      misspelled.forEach((item) => suggestionCache.set(item.word, item.suggestions.slice(0, MAX_SUGGESTIONS)));
    }
  }

  async function checkModel(ctx: CodePadCtx, model: monaco.editor.ITextModel): Promise<void> {
    if (model.isDisposed()) {
      return;
    }
    if (!ctx.settings.get('spell.enabled') || !isCheckable(model)) {
      clearMarkers(ctx, model);
      return;
    }
    const version = model.getVersionId();
    const hits = findWords(model.getValue(), model.getLanguageId() === 'markdown');
    try {
      await resolveWords(hits.map((hit) => hit.word));
      await fillSuggestions(hits.filter((hit) => verdicts.get(hit.word) === false).map((hit) => hit.word));
    } catch (error) {
      if (!failureShown) {
        failureShown = true;
        ctx.status.set(`Spell checking is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (model.isDisposed() || model.getVersionId() !== version || !ctx.settings.get('spell.enabled')) {
      return;
    }
    const markers: monaco.editor.IMarkerData[] = [];
    for (const hit of hits) {
      if (verdicts.get(hit.word) === false && !ignored.has(hit.word.toLowerCase()) && !isProperNoun(hit)) {
        markers.push({
          severity: ctx.monaco.MarkerSeverity.Info,
          message: hoverMessage(hit.word),
          source: MARKER_SOURCE,
          startLineNumber: hit.line,
          startColumn: hit.start,
          endLineNumber: hit.line,
          endColumn: hit.end
        });
        if (markers.length >= MAX_MARKERS) {
          break;
        }
      }
    }
    ctx.monaco.editor.setModelMarkers(model, OWNER, markers);
  }

  function activeModel(ctx: CodePadCtx): monaco.editor.ITextModel | null {
    const tab = ctx.tabs.active();
    return tab && tab.kind === 'text' ? tab.model : null;
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const ctx = appCtx;
      const model = ctx ? activeModel(ctx) : null;
      if (ctx && model) {
        void checkModel(ctx, model);
      }
    }, CHECK_DELAY_MS);
  }

  function recheckAll(ctx: CodePadCtx): void {
    ctx.tabs.list().forEach((tab) => {
      if (tab.kind === 'text') {
        clearMarkers(ctx, tab.model);
      }
    });
    schedule();
  }

  // ---- Quick fixes ----

  async function suggestionsFor(word: string): Promise<string[]> {
    const cached = suggestionCache.get(word);
    if (cached) {
      return cached;
    }
    try {
      const { misspelled } = await window.codepad.spell.check([word]);
      const list = misspelled.length > 0 ? misspelled[0].suggestions.slice(0, MAX_SUGGESTIONS) : [];
      suggestionCache.set(word, list);
      return list;
    } catch {
      return [];
    }
  }

  async function provideActions(
    ctx: CodePadCtx,
    model: monaco.editor.ITextModel,
    requested: monaco.Range
  ): Promise<monaco.languages.CodeActionList> {
    const actions: monaco.languages.CodeAction[] = [];
    const ours = ctx.monaco.editor
      .getModelMarkers({ resource: model.uri, owner: OWNER })
      .filter((item) => requested.intersectRanges(new ctx.monaco.Range(item.startLineNumber, item.startColumn, item.endLineNumber, item.endColumn)));
    for (const marker of ours) {
      const range = new ctx.monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
      const word = model.getValueInRange(range);
      const suggestions = await suggestionsFor(word);
      suggestions.forEach((suggestion, index) => {
        actions.push({
          title: suggestion,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: index === 0,
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range, text: suggestion } }] }
        });
      });
      actions.push({
        title: `Add "${word}" to dictionary`,
        kind: 'quickfix',
        diagnostics: [marker],
        command: { id: ADD_COMMAND, title: 'Add to dictionary', arguments: [word] }
      });
      actions.push({
        title: `Ignore "${word}"`,
        kind: 'quickfix',
        diagnostics: [marker],
        command: { id: IGNORE_COMMAND, title: 'Ignore', arguments: [word] }
      });
    }
    return { actions, dispose: () => undefined };
  }

  async function addWord(ctx: CodePadCtx, word: string): Promise<void> {
    try {
      const result = await window.codepad.spell.addWord(word);
      if (!result.ok) {
        ctx.status.set('The word could not be added to the dictionary.');
        return;
      }
      verdicts.clear();
      suggestionCache.clear();
      recheckAll(ctx);
    } catch (error) {
      ctx.status.set(`Could not add the word: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  CodePadCommands.register({
    id: 'view.toggleSpellcheck',
    run: (ctx) => {
      void ctx.settings.set('spell.enabled', !ctx.settings.get('spell.enabled'));
    }
  });

  CodePadFeatures.register('spellcheck', {
    init(ctx) {
      appCtx = ctx;
      ctx.monaco.languages.registerCodeActionProvider(LANGUAGES, {
        provideCodeActions: (model, range) => provideActions(ctx, model, range)
      });
      ctx.monaco.editor.registerCommand(ADD_COMMAND, (_accessor, word: unknown) => {
        if (typeof word === 'string') {
          void addWord(ctx, word);
        }
      });
      ctx.monaco.editor.registerCommand(IGNORE_COMMAND, (_accessor, word: unknown) => {
        if (typeof word === 'string') {
          ignored.add(word.toLowerCase());
          recheckAll(ctx);
        }
      });
      ctx.editor.onDidChangeModelContent(schedule);
      ctx.editor.onDidChangeModelLanguage(schedule);
      ctx.events.on('tab:activated', schedule);
      ctx.events.on('tab:restored', schedule);
      ctx.events.on('tab:reloaded', schedule);
      ctx.settings.onChange(({ key }) => {
        if (key === 'spell.enabled') {
          recheckAll(ctx);
        }
      });
      schedule();
    }
  });
})();
