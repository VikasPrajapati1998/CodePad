'use strict';

/*
 * Bookmarks (gutter marker per line, persisted in tab.persist.bookmarks) and five
 * Mark styles (inline highlights of all occurrences, per tab, not persisted).
 * Both are Monaco model decorations, so they follow edits and survive tab switches.
 */
(function () {
  const core = window.CodePadSearchCore;
  const STYLE_COUNT = 5;
  const MAX_MARKS = 20000;
  const MARK_TIME_BUDGET_MS = 3000;
  const MAX_TOKEN = 1000;

  /** Decoration ids of one tab: bookmark gutter markers and one list per mark style. */
  interface TabMarks {
    bookmarks: string[];
    marks: string[][];
  }

  let ctx: CodePadCtx | null = null;
  let lastFind: CodePadSearchOptions | null = null;
  let lastCopiedLines = '';
  let bookmarkOptions: monaco.editor.IModelDecorationOptions = {};
  const markOptions: monaco.editor.IModelDecorationOptions[] = [];
  const states = new WeakMap<CodePadTextTab, TabMarks>();

  function app(): CodePadCtx {
    if (!ctx) throw new Error('Bookmarks feature is not initialised.');
    return ctx;
  }

  function stateOf(tab: CodePadTextTab): TabMarks {
    let state = states.get(tab);
    if (!state) {
      state = { bookmarks: [], marks: Array.from({ length: STYLE_COUNT }, () => [] as string[]) };
      states.set(tab, state);
    }
    return state;
  }

  function activeTab(): CodePadTextTab | null {
    const tab = app().tabs.active();
    return tab && tab.kind === 'text' && tab.model ? tab : null;
  }

  function editableTab(): CodePadTextTab | null {
    const tab = activeTab();
    if (!tab) return null;
    if (tab.persist && tab.persist.readOnly) {
      app().status.set('This tab is read-only.');
      return null;
    }
    return tab;
  }

  function bookmarkLines(tab: CodePadTextTab): number[] {
    const lines = new Set<number>();
    for (const id of stateOf(tab).bookmarks) {
      const range = tab.model.getDecorationRange(id);
      if (range) lines.add(range.startLineNumber);
    }
    return Array.from(lines).sort((a, b) => a - b);
  }

  function setBookmarks(tab: CodePadTextTab, lines: number[]): void {
    const model = tab.model;
    const count = model.getLineCount();
    const decorations = lines
      .filter((line) => line >= 1 && line <= count)
      .map((line) => ({ range: new (app().monaco.Range)(line, 1, line, 1), options: bookmarkOptions }));
    const state = stateOf(tab);
    state.bookmarks = model.deltaDecorations(state.bookmarks, decorations);
    app().session.schedule();
  }

  function toggleLine(tab: CodePadTextTab, line: number): void {
    const lines = bookmarkLines(tab);
    setBookmarks(tab, lines.includes(line) ? lines.filter((l) => l !== line) : lines.concat(line));
  }

  function jumpToLine(line: number): void {
    app().editor.setPosition({ lineNumber: line, column: 1 });
    app().editor.revealLineInCenterIfOutsideViewport(line);
  }

  function stepBookmark(dir: number): void {
    const tab = activeTab();
    if (!tab) return;
    const lines = bookmarkLines(tab);
    if (lines.length === 0) {
      app().status.set('No bookmarks.');
      return;
    }
    const position = app().editor.getPosition();
    if (!position) return;
    const current = position.lineNumber;
    const target =
      dir > 0
        ? lines.find((l) => l > current) || lines[0]
        : [...lines].reverse().find((l) => l < current) || lines[lines.length - 1];
    jumpToLine(target);
  }

  function allLines(model: monaco.editor.ITextModel): number[] {
    return Array.from({ length: model.getLineCount() }, (_, i) => i + 1);
  }

  /** Groups sorted line numbers into [first, last] runs of consecutive lines. */
  function runsOf(lines: number[]): [number, number][] {
    const runs: [number, number][] = [];
    for (const line of lines) {
      const last = runs[runs.length - 1];
      if (last && last[1] === line - 1) last[1] = line;
      else runs.push([line, line]);
    }
    return runs;
  }

  function applyEdits(model: monaco.editor.ITextModel, edits: monaco.editor.IIdentifiedSingleEditOperation[]): void {
    model.pushStackElement();
    model.pushEditOperations([], edits, () => null);
    model.pushStackElement();
  }

  function deleteLines(tab: CodePadTextTab, lines: number[]): void {
    const model = tab.model;
    const count = model.getLineCount();
    const edits = runsOf(lines).map(([first, last]) => {
      let range: monaco.Range;
      if (last < count) range = new (app().monaco.Range)(first, 1, last + 1, 1);
      else if (first > 1) range = new (app().monaco.Range)(first - 1, model.getLineMaxColumn(first - 1), last, model.getLineMaxColumn(last));
      else range = new (app().monaco.Range)(1, 1, last, model.getLineMaxColumn(last));
      return { range, text: '' };
    });
    applyEdits(model, edits);
  }

  function linesText(model: monaco.editor.ITextModel, lines: number[]): string {
    const eol = model.getEOL();
    return lines.map((line) => model.getLineContent(line)).join(eol) + eol;
  }

  function withBookmarks(tab: CodePadTextTab, action: (lines: number[]) => void | Promise<void>): void {
    const lines = bookmarkLines(tab);
    if (lines.length === 0) {
      app().status.set('No bookmarked lines.');
      return;
    }
    action(lines);
  }

  async function copyLines(tab: CodePadTextTab, lines: number[]): Promise<void> {
    lastCopiedLines = linesText(tab.model, lines);
    await app().clipboard.write(lastCopiedLines);
  }

  async function clipboardText(): Promise<string> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Clipboard reads are denied for the sandboxed renderer: use the last bookmarked lines copied here.
      return lastCopiedLines;
    }
  }

  async function replaceLinesWithClipboard(tab: CodePadTextTab): Promise<void> {
    const lines = bookmarkLines(tab);
    if (lines.length === 0) {
      app().status.set('No bookmarked lines.');
      return;
    }
    const text = (await clipboardText()).replace(/\r?\n$/, '');
    if (!text) {
      app().status.set('Nothing to paste (clipboard is empty or cannot be read).');
      return;
    }
    const model = tab.model;
    applyEdits(
      model,
      runsOf(lines).map(([first, last]) => ({
        range: new (app().monaco.Range)(first, 1, last, model.getLineMaxColumn(last)),
        text
      }))
    );
    setBookmarks(tab, []);
  }

  function complement(model: monaco.editor.ITextModel, lines: number[]): number[] {
    const marked = new Set(lines);
    return allLines(model).filter((line) => !marked.has(line));
  }

  function restoreBookmarks(tab: CodePadTab): void {
    if (tab.kind !== 'text' || !tab.model || !tab.persist || !Array.isArray(tab.persist.bookmarks)) return;
    if (tab.persist.bookmarks.length > 0) setBookmarks(tab, tab.persist.bookmarks);
  }

  // ---- marks ----

  function markSeed(): string {
    const model = app().editor.getModel();
    if (!model) return '';
    const selection = app().editor.getSelection();
    if (selection && !selection.isEmpty()) return model.getValueInRange(selection).slice(0, MAX_TOKEN);
    const position = app().editor.getPosition();
    const word = position ? model.getWordAtPosition(position) : null;
    return word ? word.word : '';
  }

  function addMarks(tab: CodePadTextTab, style: number, found: SearchCoreHit[]): void {
    const model = tab.model;
    const decorations = found.map((m) => {
      const from = model.getPositionAt(m.index);
      const to = model.getPositionAt(m.index + m.length);
      return {
        range: new (app().monaco.Range)(from.lineNumber, from.column, to.lineNumber, to.column),
        options: markOptions[style - 1]
      };
    });
    stateOf(tab).marks[style - 1].push(...tab.model.deltaDecorations([], decorations));
  }

  function findForMarks(tab: CodePadTextTab, query: string, options: Omit<SearchCoreOptions, 'query'>): SearchCoreHit[] | null {
    const matcher = core.buildMatcher({ ...options, query });
    if ('error' in matcher) {
      app().status.set(matcher.error);
      return null;
    }
    return core.findAll(tab.model.getValue(), matcher, { limit: MAX_MARKS, timeBudgetMs: MARK_TIME_BUDGET_MS });
  }

  function markStyle(style: number): void {
    const tab = activeTab();
    if (!tab) return;
    const token = markSeed();
    if (!token) {
      app().status.set('Select text or place the cursor in a word to mark.');
      return;
    }
    const found = findForMarks(tab, token, { matchCase: true });
    if (!found) return;
    addMarks(tab, style, found);
    app().status.set(`Marked ${found.length} occurrence(s) with style ${style}.`);
  }

  function markFromFind(): void {
    const tab = activeTab();
    if (!tab) return;
    if (!lastFind || !lastFind.query) {
      app().status.set('Enter text in the Find panel first.');
      return;
    }
    const found = findForMarks(tab, lastFind.query, lastFind);
    if (!found) return;
    addMarks(tab, lastFind.markStyle || 1, found);
    if (lastFind.bookmarkLines) {
      const lines = new Set(bookmarkLines(tab));
      for (const m of found) lines.add(m.line);
      setBookmarks(tab, Array.from(lines));
    }
    app().status.set(`Marked ${found.length} match(es).`);
  }

  function clearMarks(tab: CodePadTextTab, style: number | undefined): void {
    const state = stateOf(tab);
    state.marks.forEach((ids, index) => {
      if (style && style !== index + 1) return;
      tab.model.deltaDecorations(ids, []);
      state.marks[index] = [];
    });
  }

  function stepMark(dir: number): void {
    const tab = activeTab();
    if (!tab) return;
    const ranges = stateOf(tab)
      .marks.flat()
      .map((id) => tab.model.getDecorationRange(id))
      .filter((range): range is monaco.Range => range !== null)
      .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    if (ranges.length === 0) {
      app().status.set('No marks.');
      return;
    }
    const selection = app().editor.getSelection();
    if (!selection) return;
    const start = selection.getStartPosition();
    const before = (r: monaco.Range): boolean => r.startLineNumber < start.lineNumber || (r.startLineNumber === start.lineNumber && r.startColumn < start.column);
    const after = (r: monaco.Range): boolean => r.startLineNumber > start.lineNumber || (r.startLineNumber === start.lineNumber && r.startColumn > start.column);
    const target =
      dir > 0
        ? ranges.find(after) || ranges[0]
        : [...ranges].reverse().find(before) || ranges[ranges.length - 1];
    app().editor.setSelection(target);
    app().editor.revealRangeInCenterIfOutsideViewport(target);
  }

  CodePadFeatures.register('bookmarks', {
    init(context) {
      ctx = context;
      const { TrackedRangeStickiness, OverviewRulerLane, MouseTargetType } = app().monaco.editor;
      bookmarkOptions = {
        isWholeLine: true,
        glyphMarginClassName: 'cp-bookmark',
        stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        overviewRuler: { color: '#3794ff', position: OverviewRulerLane.Left }
      };
      for (let style = 1; style <= STYLE_COUNT; style++) {
        markOptions.push({
          inlineClassName: `cp-mark-${style}`,
          stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        });
      }
      app().events.on('search:options', (options) => {
        lastFind = options;
      });
      app().events.on('tab:created', restoreBookmarks);
      app().events.on('tab:restored', restoreBookmarks);
      app().events.on('session:beforeSnapshot', () => {
        for (const tab of app().tabs.list()) {
          if (tab.kind === 'text' && tab.model && tab.persist && states.has(tab)) {
            tab.persist.bookmarks = bookmarkLines(tab);
          }
        }
      });
      app().editor.onMouseDown((event) => {
        const tab = activeTab();
        if (tab && event.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
          toggleLine(tab, event.target.position.lineNumber);
        }
      });
    }
  });

  CodePadCommands.register({
    id: 'bookmark.toggle',
    run: () => {
      const tab = activeTab();
      const position = app().editor.getPosition();
      if (tab && position) toggleLine(tab, position.lineNumber);
    }
  });
  CodePadCommands.register({ id: 'bookmark.next', run: () => stepBookmark(1) });
  CodePadCommands.register({ id: 'bookmark.prev', run: () => stepBookmark(-1) });
  CodePadCommands.register({
    id: 'bookmark.clearAll',
    run: () => {
      const tab = activeTab();
      if (tab) setBookmarks(tab, []);
    }
  });
  CodePadCommands.register({
    id: 'bookmark.copyLines',
    run: () => {
      const tab = activeTab();
      if (tab) withBookmarks(tab, (lines) => copyLines(tab, lines));
    }
  });
  CodePadCommands.register({
    id: 'bookmark.cutLines',
    run: () => {
      const tab = editableTab();
      if (!tab) return;
      withBookmarks(tab, async (lines) => {
        await copyLines(tab, lines);
        deleteLines(tab, lines);
        setBookmarks(tab, []);
      });
    }
  });
  CodePadCommands.register({
    id: 'bookmark.pasteLines',
    run: () => {
      const tab = editableTab();
      return tab ? replaceLinesWithClipboard(tab) : undefined;
    }
  });
  CodePadCommands.register({
    id: 'bookmark.deleteLines',
    run: () => {
      const tab = editableTab();
      if (!tab) return;
      withBookmarks(tab, (lines) => {
        deleteLines(tab, lines);
        setBookmarks(tab, []);
      });
    }
  });
  CodePadCommands.register({
    id: 'bookmark.deleteUnmarked',
    run: () => {
      const tab = editableTab();
      if (!tab) return;
      withBookmarks(tab, (lines) => deleteLines(tab, complement(tab.model, lines)));
    }
  });
  CodePadCommands.register({
    id: 'bookmark.inverse',
    run: () => {
      const tab = activeTab();
      if (tab) setBookmarks(tab, complement(tab.model, bookmarkLines(tab)));
    }
  });

  for (let style = 1; style <= STYLE_COUNT; style++) {
    CodePadCommands.register({ id: `mark.style${style}`, run: () => markStyle(style) });
  }
  CodePadCommands.register({ id: 'mark.fromFind', run: markFromFind });
  CodePadCommands.register({ id: 'mark.next', run: () => stepMark(1) });
  CodePadCommands.register({ id: 'mark.prev', run: () => stepMark(-1) });
  CodePadCommands.register({
    id: 'mark.clear',
    run: (_ctx, args) => {
      const tab = activeTab();
      if (tab) clearMarks(tab, args && typeof args.style === 'number' ? args.style : undefined);
    }
  });
})();
