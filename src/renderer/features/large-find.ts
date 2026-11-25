/**
 * Find bar for large-file tabs (Ctrl+F, F3, Shift+F3). A large tab's Monaco model holds only a window of the file, so
 * Monaco's own find widget would miss most of it. Next/Previous first search the loaded window from the cursor
 * (instant); when nothing is found there, `ctx.large.find` streams through the whole file in main, wraps once and
 * loads the window around the match. Matching is per line. Count scans the whole file with progress. Replace changes
 * the one selected match in Edit Mode; Replace All is not offered. All text is shown through `textContent`.
 */
(() => {
  const MAX_QUERY_CHARS = 1000;
  const COUNT_CAP = 10000000;
  const MAX_HITS_PER_LINE = 1000;

  /** A match inside one line: 0-based start and length in UTF-16 units. */
  interface LineHit {
    start: number;
    length: number;
  }

  interface BarElements {
    root: HTMLElement;
    find: HTMLInputElement;
    replace: HTMLInputElement;
    replaceRow: HTMLElement;
    matchCase: HTMLButtonElement;
    wholeWord: HTMLButtonElement;
    regex: HTMLButtonElement;
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
    count: HTMLButtonElement;
    info: HTMLElement;
  }

  let appCtx: CodePadCtx | null = null;
  let bar: BarElements | null = null;
  /** True while a streaming find or count runs in main. */
  let busy = false;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The large-file find feature is not initialized.');
    }
    return appCtx;
  }

  /** The bar created by `init`. */
  function elements(): BarElements {
    if (!bar) {
      throw new Error('The large-file find feature is not initialized.');
    }
    return bar;
  }

  const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

  const isOn = (button: HTMLButtonElement): boolean => button.getAttribute('aria-pressed') === 'true';

  function activeLarge(): CodePadLargeTextTab | null {
    const tab = app().tabs.active();
    return app().large.isLarge(tab) ? tab : null;
  }

  function showInfo(text: string): void {
    elements().info.textContent = text;
  }

  // ------------------------------------------------------------------------------------ DOM

  function makeButton(label: string, title: string, className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  function makeFlag(label: string, title: string): HTMLButtonElement {
    const button = makeButton(label, title, 'cp-lfind-flag');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', isOn(button) ? 'false' : 'true');
    });
    return button;
  }

  function makeInput(placeholder: string, label: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cp-lfind-input';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.setAttribute('aria-label', label);
    return input;
  }

  function buildBar(): BarElements {
    const root = document.createElement('div');
    root.className = 'cp-lfind hidden';
    root.setAttribute('role', 'search');
    root.setAttribute('aria-label', 'Find in large file');

    const findRow = document.createElement('div');
    findRow.className = 'cp-lfind-row';
    const find = makeInput('Find in file', 'Find in the large file');
    const matchCase = makeFlag('Aa', 'Match case');
    const wholeWord = makeFlag('W', 'Whole word');
    const regex = makeFlag('.*', 'Regular expression');
    const previous = makeButton('Previous', 'Previous match (Shift+F3)', 'cp-lfind-button');
    const next = makeButton('Next', 'Next match (F3)', 'cp-lfind-button');
    const count = makeButton('Count', 'Count matches in the whole file', 'cp-lfind-button');
    const close = makeButton('Close', 'Close (Esc)', 'cp-lfind-button');
    const info = document.createElement('span');
    info.className = 'cp-lfind-info';
    info.setAttribute('role', 'status');
    info.setAttribute('aria-live', 'polite');
    findRow.append(find, matchCase, wholeWord, regex, previous, next, count, info, close);

    const replaceRow = document.createElement('div');
    replaceRow.className = 'cp-lfind-row hidden';
    const replace = makeInput('Replace with', 'Replacement text');
    const replaceOneButton = makeButton('Replace', 'Replace the selected match (Edit Mode)', 'cp-lfind-button');
    const note = document.createElement('span');
    note.className = 'cp-lfind-note';
    note.textContent = 'Replace All is not available for large files.';
    replaceRow.append(replace, replaceOneButton, note);

    root.append(findRow, replaceRow);

    const parts: BarElements = { root, find, replace, replaceRow, matchCase, wholeWord, regex, previous, next, count, info };
    previous.addEventListener('click', () => void step('prev'));
    next.addEventListener('click', () => void step('next'));
    count.addEventListener('click', () => void countMatches());
    close.addEventListener('click', closeBar);
    replaceOneButton.addEventListener('click', () => void replaceOne());
    find.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void step(event.shiftKey ? 'prev' : 'next');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        escape();
      }
    });
    replace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void replaceOne();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        escape();
      }
    });
    return parts;
  }

  function setBusy(value: boolean): void {
    busy = value;
    const parts = elements();
    [parts.previous, parts.next, parts.count].forEach((button) => {
      button.disabled = value;
    });
    if (value) {
      document.addEventListener('keydown', onBusyKey, true);
    } else {
      document.removeEventListener('keydown', onBusyKey, true);
    }
  }

  /** Esc while a search runs cancels it, wherever the focus is. */
  function onBusyKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelJob();
    }
  }

  function cancelJob(): void {
    const tab = activeLarge();
    if (busy && tab) {
      app().large.cancel(tab);
    }
  }

  function escape(): void {
    if (busy) {
      cancelJob();
    } else {
      closeBar();
    }
  }

  function closeBar(): void {
    const parts = elements();
    parts.root.classList.add('hidden');
    app().editor.layout();
    app().editor.focus();
  }

  function openBar(withReplace: boolean): void {
    const tab = activeLarge();
    if (!tab) {
      app().status.set('Only for large files.');
      return;
    }
    const parts = elements();
    const selection = app().editor.getSelection();
    if (selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
      parts.find.value = tab.model.getValueInRange(selection).slice(0, MAX_QUERY_CHARS);
    }
    parts.root.classList.remove('hidden');
    if (withReplace) {
      parts.replaceRow.classList.remove('hidden');
    }
    app().editor.layout();
    parts.find.focus();
    parts.find.select();
  }

  // ---------------------------------------------------------------------------------- query

  /** The query of the bar, or null after saying why. */
  function readQuery(): CpLargeFindQuery | null {
    const parts = elements();
    const text = parts.find.value;
    const useRegex = isOn(parts.regex);
    if (text === '') {
      showInfo('Type what to find.');
      return null;
    }
    if (text.length > MAX_QUERY_CHARS) {
      showInfo(`The search text is limited to ${MAX_QUERY_CHARS} characters.`);
      return null;
    }
    if (/[\r\n]/.test(text) || (useRegex && /\\[nr]/.test(text))) {
      showInfo('Large files are searched line by line, so a search cannot contain a line break.');
      return null;
    }
    return { text, matchCase: isOn(parts.matchCase), wholeWord: isOn(parts.wholeWord), regex: useRegex };
  }

  /** The matcher of a query, or null after saying why. */
  function matcherOf(query: CpLargeFindQuery): SearchCoreMatcher | null {
    const built = CodePadSearchCore.buildMatcher({ query: query.text, isRegex: query.regex, matchCase: query.matchCase, wholeWord: query.wholeWord });
    if ('error' in built) {
      showInfo(built.error);
      return null;
    }
    return built;
  }

  // ------------------------------------------------------------------------- window search

  const cloneRegex = (source: RegExp, extraFlags: string): RegExp => new RegExp(source.source, source.flags + extraFlags);

  /** First non-empty match of one line that starts at or after `from`. */
  function firstAtOrAfter(source: RegExp, text: string, from: number): LineHit | null {
    const re = cloneRegex(source, '');
    re.lastIndex = from;
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      if (match[0].length > 0) {
        return { start: match.index, length: match[0].length };
      }
      re.lastIndex = match.index + 1;
    }
    return null;
  }

  /** Last non-empty match of one line that ends at or before `limit`. */
  function lastEndingBefore(source: RegExp, text: string, limit: number): LineHit | null {
    const re = cloneRegex(source, '');
    let best: LineHit | null = null;
    let seen = 0;
    for (let match = re.exec(text); match !== null && seen < MAX_HITS_PER_LINE; match = re.exec(text)) {
      if (match[0].length === 0) {
        re.lastIndex = match.index + 1;
        continue;
      }
      if (match.index + match[0].length > limit) {
        break;
      }
      best = { start: match.index, length: match[0].length };
      seen += 1;
    }
    return best;
  }

  /** The nearest match in the loaded window from the selection in the given direction, or null. */
  function searchWindow(tab: CodePadLargeTextTab, matcher: SearchCoreMatcher, direction: 'next' | 'prev'): monaco.Range | null {
    const { Range } = app().monaco;
    const model = tab.model;
    const lineCount = model.getLineCount();
    const selection = app().editor.getSelection();
    if (direction === 'next') {
      const first = selection ? selection.endLineNumber : 1;
      const from = selection ? selection.endColumn - 1 : 0;
      for (let line = first; line <= lineCount; line += 1) {
        const hit = firstAtOrAfter(matcher.regex, model.getLineContent(line), line === first ? from : 0);
        if (hit) {
          return new Range(line, hit.start + 1, line, hit.start + hit.length + 1);
        }
      }
      return null;
    }
    const first = selection ? selection.startLineNumber : lineCount;
    const limit = selection ? selection.startColumn - 1 : Number.POSITIVE_INFINITY;
    for (let line = first; line >= 1; line -= 1) {
      const hit = lastEndingBefore(matcher.regex, model.getLineContent(line), line === first ? limit : Number.POSITIVE_INFINITY);
      if (hit) {
        return new Range(line, hit.start + 1, line, hit.start + hit.length + 1);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------------- actions

  /** Find next/previous: the loaded window first, then the whole file through main. */
  async function step(direction: 'next' | 'prev'): Promise<void> {
    const ctx = app();
    const tab = activeLarge();
    if (!tab) {
      ctx.status.set('Only for large files.');
      return;
    }
    if (busy) {
      return;
    }
    const query = readQuery();
    const matcher = query ? matcherOf(query) : null;
    if (!query || !matcher) {
      if (elements().root.classList.contains('hidden')) {
        openBar(false);
      }
      return;
    }
    const inWindow = searchWindow(tab, matcher, direction);
    if (inWindow) {
      ctx.editor.setSelection(inWindow);
      ctx.editor.revealRangeInCenterIfOutsideViewport(inWindow);
      showInfo('');
      return;
    }
    setBusy(true);
    showInfo('Searching... (Esc to cancel)');
    try {
      const outcome = await ctx.large.find(tab, query, direction);
      if (ctx.tabs.active() !== tab) {
        return;
      }
      if (outcome.found) {
        showInfo(outcome.wrapped ? (direction === 'next' ? 'Wrapped to start.' : 'Wrapped to end.') : '');
      } else {
        showInfo(outcome.cancelled ? 'Search cancelled.' : 'Not found.');
      }
    } catch (error) {
      showInfo(`The search failed: ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Counts the matches in the whole file (edits included) with progress. */
  async function countMatches(): Promise<void> {
    const ctx = app();
    const tab = activeLarge();
    if (!tab) {
      ctx.status.set('Only for large files.');
      return;
    }
    if (busy) {
      return;
    }
    const query = readQuery();
    if (!query || !matcherOf(query)) {
      if (elements().root.classList.contains('hidden')) {
        openBar(false);
      }
      return;
    }
    setBusy(true);
    showInfo('Counting... 0% (Esc to cancel)');
    try {
      const total = await ctx.large.count(tab, query, (permille) => {
        showInfo(`Counting... ${Math.round(permille / 10)}% (Esc to cancel)`);
      });
      if (total === null) {
        showInfo('Count cancelled.');
      } else if (total >= COUNT_CAP) {
        showInfo(`${COUNT_CAP.toLocaleString('en-US')} or more matches in the whole file.`);
      } else {
        showInfo(`${total.toLocaleString('en-US')} ${total === 1 ? 'match' : 'matches'} in the whole file.`);
      }
    } catch (error) {
      showInfo(`The count failed: ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /** The replacement text for the selection when it is exactly one match of the query, else null. */
  function replacementFor(tab: CodePadLargeTextTab, matcher: SearchCoreMatcher, selection: monaco.Selection): string | null {
    if (selection.isEmpty() || selection.startLineNumber !== selection.endLineNumber) {
      return null;
    }
    const line = tab.model.getLineContent(selection.startLineNumber);
    const re = cloneRegex(matcher.regex, matcher.regex.sticky ? '' : 'y');
    re.lastIndex = selection.startColumn - 1;
    const match = re.exec(line);
    if (!match || match[0].length !== selection.endColumn - selection.startColumn) {
      return null;
    }
    return matcher.makeReplacer(elements().replace.value)(match);
  }

  /** Replaces the selected match (Edit Mode) and moves to the next one; with no match selected it only finds the next. */
  async function replaceOne(): Promise<void> {
    const ctx = app();
    const tab = activeLarge();
    if (!tab) {
      ctx.status.set('Only for large files.');
      return;
    }
    if (tab.persist.readOnly) {
      showInfo('Switch to Edit Mode to replace text.');
      return;
    }
    if (tab.large.view.readOnly !== null || tab.large.baseLost) {
      showInfo('This part of the file is view-only, so it cannot be changed.');
      return;
    }
    const query = readQuery();
    const matcher = query ? matcherOf(query) : null;
    if (!query || !matcher) {
      return;
    }
    const selection = ctx.editor.getSelection();
    let replacement: string | null = null;
    try {
      replacement = selection ? replacementFor(tab, matcher, selection) : null;
    } catch (error) {
      showInfo(`The replacement is not valid: ${messageOf(error)}`);
      return;
    }
    if (selection && replacement !== null) {
      ctx.editor.executeEdits('large-find-replace', [{ range: selection, text: replacement, forceMoveMarkers: true }]);
    }
    await step('next');
  }

  // ---------------------------------------------------------------------------- registration

  CodePadCommands.register({
    id: 'large.find',
    run(_ctx, args) {
      openBar(args !== undefined && args.replace === true);
    },
  });

  CodePadCommands.register({
    id: 'large.findNext',
    async run(ctx) {
      if (activeLarge()) {
        await step('next');
      } else {
        ctx.editor.trigger('large-find', 'editor.action.nextMatchFindAction', null);
      }
    },
  });

  CodePadCommands.register({
    id: 'large.findPrev',
    async run(ctx) {
      if (activeLarge()) {
        await step('prev');
      } else {
        ctx.editor.trigger('large-find', 'editor.action.previousMatchFindAction', null);
      }
    },
  });

  CodePadCommands.register({
    id: 'large.count',
    async run() {
      await countMatches();
    },
  });

  CodePadFeatures.register('large-find', {
    init(ctx) {
      appCtx = ctx;
      const editorEl = document.getElementById('editor');
      if (!editorEl) {
        throw new Error('The editor container is missing.');
      }
      bar = buildBar();
      editorEl.before(bar.root);
      ctx.events.on('tab:activated', (tab) => {
        if (!ctx.large.isLarge(tab) && !elements().root.classList.contains('hidden')) {
          elements().root.classList.add('hidden');
          ctx.editor.layout();
        }
      });
    },
  });
})();
