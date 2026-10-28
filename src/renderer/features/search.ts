'use strict';

/*
 * Search panel (left sidebar): Find All in Folder / Open Tabs / Current Tab, Count,
 * Replace in Open Tabs, Mark All, plus Go to Offset, Select Between Brackets and
 * Find Non-ASCII. Results go to CodePadSearchResults (search-results.ts).
 * Folder searches run in the main process (findInFiles.ts) and stream back.
 */
(function () {
  const core = window.CodePadSearchCore;

  type FlagKey = 'matchCase' | 'wholeWord' | 'isRegex' | 'extended' | 'dotAll';

  interface SearchForm {
    root: HTMLElement;
    query: HTMLInputElement;
    replace: HTMLInputElement;
    scope: HTMLSelectElement;
    folderRow: HTMLElement;
    include: HTMLInputElement;
    exclude: HTMLInputElement;
    subPath: HTMLInputElement;
    markStyle: HTMLSelectElement;
    bookmark: HTMLInputElement;
    findBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
  }

  /** The Find in Files run in progress; events that arrive before `start` replied wait in `queue`. */
  interface RunningSearch {
    id: string | null;
    set: CodePadResultSet;
    queue: CpSearchEvent[];
  }

  interface ReplacePlanEntry {
    tab: CodePadTextTab;
    found: SearchCoreHit[];
    version: number;
  }

  const REGEX_TIME_BUDGET_MS = 4000;
  const MARK_STYLE_COUNT = 5;
  const SCOPES: [string, string][] = [
    ['folder', 'Folder'],
    ['tabs', 'Open Tabs'],
    ['tab', 'Current Tab']
  ];
  const FLAG_BUTTONS: [FlagKey, string, string][] = [
    ['matchCase', 'Aa', 'Match case'],
    ['wholeWord', 'ab', 'Whole word'],
    ['isRegex', '.*', 'Regular expression'],
    ['extended', '\\n', 'Extended: \\n \\r \\t \\0 \\xHH \\uHHHH'],
    ['dotAll', '.↵', 'Dot matches newline (regular expression)']
  ];
  const OPENING = '([{';
  const CLOSING = ')]}';
  const NON_ASCII_OPTIONS: Pick<CodePadSearchOptions, 'query' | 'isRegex' | 'matchCase'> = { query: '[^\\x00-\\x7F]', isRegex: true, matchCase: true };

  let ctx: CodePadCtx | null = null;
  let form: SearchForm | null = null;
  let running: RunningSearch | null = null;
  let resultSeq = 0;
  const flags: Record<FlagKey, boolean> = { matchCase: false, wholeWord: false, isRegex: false, extended: false, dotAll: false };

  function app(): CodePadCtx {
    if (!ctx) throw new Error('Search feature is not initialised.');
    return ctx;
  }

  function formOf(): SearchForm {
    if (!form) throw new Error('Search form is not built.');
    return form;
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function splitList(value: string): string[] {
    return value.split(/[,;\s]+/).filter(Boolean);
  }

  function field<T extends HTMLElement>(parent: HTMLElement, labelText: string, input: T): T {
    const wrap = el('label', 'cp-search-field');
    wrap.append(el('span', 'cp-search-label', labelText), input);
    parent.appendChild(wrap);
    return input;
  }

  function textInput(placeholder: string): HTMLInputElement {
    const input = el('input', 'cp-search-input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = placeholder;
    return input;
  }

  function select(items: [string, string][]): HTMLSelectElement {
    const node = el('select', 'cp-search-input');
    for (const [value, label] of items) {
      const option = el('option', '', label);
      option.value = value;
      node.appendChild(option);
    }
    return node;
  }

  function button(parent: HTMLElement, label: string, handler: () => void): HTMLButtonElement {
    const node = el('button', 'cp-search-btn', label);
    node.type = 'button';
    node.addEventListener('click', handler);
    parent.appendChild(node);
    return node;
  }

  /** Current form values; also published to bookmarks.ts for "Mark All". */
  function readOptions(): CodePadSearchOptions {
    return {
      ...flags,
      query: formOf().query.value,
      replace: formOf().replace.value,
      scope: formOf().scope.value,
      include: splitList(formOf().include.value),
      exclude: splitList(formOf().exclude.value),
      subPath: formOf().subPath.value.trim() || null,
      markStyle: Number(formOf().markStyle.value),
      bookmarkLines: formOf().bookmark.checked
    };
  }

  function publishOptions(): void {
    app().events.emit('search:options', readOptions());
  }

  function updateScopeUi(): void {
    formOf().folderRow.hidden = formOf().scope.value !== 'folder';
  }

  function buildForm(): void {
    const root = el('div', 'cp-search');
    const flagRow = el('div', 'cp-search-flags');
    const query = field(root, 'Find', textInput('Text or pattern'));
    const replace = field(root, 'Replace with', textInput('Replacement'));
    root.appendChild(flagRow);
    for (const [key, label, title] of FLAG_BUTTONS) {
      const toggle = el('button', 'cp-search-flag', label);
      toggle.type = 'button';
      toggle.title = title;
      toggle.setAttribute('aria-pressed', 'false');
      toggle.addEventListener('click', () => {
        flags[key] = !flags[key];
        toggle.setAttribute('aria-pressed', String(flags[key]));
        publishOptions();
      });
      flagRow.appendChild(toggle);
    }
    const scope = field(root, 'Search in', select(SCOPES));
    const folderRow = el('div', 'cp-search-folder');
    root.appendChild(folderRow);
    const include = field(folderRow, 'Files (name patterns)', textInput('*.js, *.json'));
    const exclude = field(folderRow, 'Skip folders', textInput('node_modules, .git'));
    const subPath = field(folderRow, 'Sub folder (relative)', textInput('whole folder'));
    const markStyle = field(
      root,
      'Mark style',
      select(Array.from({ length: MARK_STYLE_COUNT }, (_, i) => [String(i + 1), `Style ${i + 1}`]))
    );
    const bookmarkLabel = el('label', 'cp-search-check');
    const bookmark = el('input');
    bookmark.type = 'checkbox';
    bookmarkLabel.append(bookmark, document.createTextNode(' Bookmark marked lines'));
    root.appendChild(bookmarkLabel);

    const buttons = el('div', 'cp-search-buttons');
    root.appendChild(buttons);
    const findBtn = button(buttons, 'Find All', () => findAll(readOptions()));
    button(buttons, 'Replace All', () => replaceInTabs(readOptions()));
    button(buttons, 'Count', () => countMatches(readOptions()));
    button(buttons, 'Mark All', () => {
      publishOptions();
      app().commands.execute('mark.fromFind');
    });
    const cancelBtn = button(buttons, 'Cancel', cancelRunning);
    cancelBtn.hidden = true;
    form = { root, query, replace, scope, folderRow, include, exclude, subPath, markStyle, bookmark, findBtn, cancelBtn };

    for (const input of [query, replace, include, exclude, subPath, markStyle, bookmark]) {
      input.addEventListener('input', publishOptions);
    }
    scope.addEventListener('change', () => {
      updateScopeUi();
      publishOptions();
    });
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') findAll(readOptions());
      else if (event.key === 'Escape') app().editor.focus();
    });
    replace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') replaceInTabs(readOptions());
      else if (event.key === 'Escape') app().editor.focus();
    });
    const defaults = app().settings.get('search.defaultExcludes');
    exclude.value = Array.isArray(defaults) ? defaults.join(', ') : '';
    updateScopeUi();
  }

  function activeTextTab(): CodePadTextTab | null {
    const tab = app().tabs.active();
    return tab && tab.kind === 'text' && tab.model ? tab : null;
  }

  function textTabs(): CodePadTextTab[] {
    return app().tabs.list().filter((tab): tab is CodePadTextTab => tab.kind === 'text' && Boolean(tab.model));
  }

  /** Selected text (single line) or the word under the cursor in the active text tab. */
  function editorSeed(): string {
    if (!activeTextTab()) return '';
    const model = app().editor.getModel();
    if (!model) return '';
    const selection = app().editor.getSelection();
    if (selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
      return model.getValueInRange(selection);
    }
    const position = app().editor.getPosition();
    const word = position ? model.getWordAtPosition(position) : null;
    return word ? word.word : '';
  }

  function openPanel(scope: string, seed: boolean): void {
    app().panels.show('search', { focus: true });
    formOf().scope.value = scope;
    updateScopeUi();
    if (seed) {
      const text = editorSeed();
      if (text) formOf().query.value = text;
    }
    publishOptions();
    formOf().query.focus();
    formOf().query.select();
  }

  function setBusy(busy: boolean): void {
    formOf().cancelBtn.hidden = !busy;
    formOf().findBtn.disabled = busy;
  }

  function limits(): { maxResults: number; maxFileKB: number } {
    return {
      maxResults: app().settings.get('search.maxResults') || 5000,
      maxFileKB: app().settings.get('search.maxFileKB') || 5120
    };
  }

  function newSet(scope: string, o: Pick<CodePadSearchOptions, 'query'>, title: string): CodePadResultSet {
    return {
      id: ++resultSeq,
      title,
      scope,
      query: o.query,
      options: { ...flags },
      running: false,
      error: null,
      files: [],
      totals: {
        files: 0,
        matches: 0,
        filesScanned: 0,
        skippedBinary: 0,
        skippedLarge: 0,
        truncated: false,
        cancelled: false,
        elapsedMs: 0
      }
    };
  }

  function shortQuery(query: string): string {
    return query.length > 30 ? query.slice(0, 30) + '...' : query;
  }

  function searchTabs(o: CodePadSearchOptions, matcher: SearchCoreMatcher, tabs: CodePadTextTab[]): CodePadResultSet {
    const { maxResults } = limits();
    const label = o.scope === 'tab' ? tabs[0].name : `${tabs.length} open tabs`;
    const set = newSet(o.scope, o, `"${shortQuery(o.query)}" in ${label}`);
    const budget = o.isRegex ? REGEX_TIME_BUDGET_MS : 0;
    for (const tab of tabs) {
      const remaining = maxResults - set.totals.matches;
      if (remaining <= 0) {
        set.totals.truncated = true;
        break;
      }
      const found = core.findAll(tab.model.getValue(), matcher, { limit: remaining, timeBudgetMs: budget });
      set.totals.filesScanned++;
      if (found.length === 0) continue;
      set.files.push({
        key: tab.id,
        label: tab.name,
        path: tab.path || null,
        tabId: tab.id,
        collapsed: false,
        matches: found.map((m) => ({
          line: m.line,
          col: m.col,
          length: m.length,
          preview: m.lineText,
          previewStart: m.lineOffset
        }))
      });
      set.totals.files++;
      set.totals.matches += found.length;
    }
    if (set.totals.matches >= maxResults) set.totals.truncated = true;
    return set;
  }

  function tabsForScope(o: Pick<CodePadSearchOptions, 'scope'>): CodePadTextTab[] {
    if (o.scope === 'tabs') return textTabs();
    const tab = activeTextTab();
    return tab ? [tab] : [];
  }

  function cancelRunning(): void {
    if (!running) return;
    const state = running;
    running = null;
    setBusy(false);
    if (state.id) window.codepad.search.cancel(state.id);
    window.CodePadSearchResults.finish(state.set, { totals: { cancelled: true } });
  }

  function handleSearchEvent(m: CpSearchEvent): void {
    if (!running) return;
    if (running.id === null) {
      running.queue.push(m);
      return;
    }
    if (m.searchId !== running.id) return;
    const results = window.CodePadSearchResults;
    const { set } = running;
    if (m.type === 'matches') {
      results.append(
        set,
        m.files.map((f) => ({ key: f.path, label: f.rel, path: f.path, tabId: null, collapsed: false, matches: f.matches }))
      );
    } else if (m.type === 'progress') {
      set.totals.filesScanned = m.filesScanned;
      results.refresh(set);
    } else if (m.type === 'done') {
      running = null;
      setBusy(false);
      const { filesScanned, skippedBinary, skippedLarge, truncated, cancelled, elapsedMs } = m.totals;
      results.finish(set, { totals: { filesScanned, skippedBinary, skippedLarge, truncated, cancelled, elapsedMs } });
    } else if (m.type === 'error') {
      running = null;
      setBusy(false);
      results.finish(set, { error: m.message });
      app().status.set(m.message);
    }
  }

  async function findInFolder(o: CodePadSearchOptions): Promise<void> {
    cancelRunning();
    const set = newSet('folder', o, `"${shortQuery(o.query)}" in folder`);
    set.running = true;
    const state: RunningSearch = { id: null, set, queue: [] };
    running = state;
    setBusy(true);
    window.CodePadSearchResults.show(set);
    try {
      const { maxResults, maxFileKB } = limits();
      const reply = await window.codepad.search.start({
        query: o.query,
        isRegex: o.isRegex,
        matchCase: o.matchCase,
        wholeWord: o.wholeWord,
        extended: o.extended,
        dotAll: o.dotAll,
        include: o.include,
        exclude: o.exclude,
        subPath: o.subPath ?? undefined,
        includeHidden: false,
        maxResults,
        maxFileKB
      });
      if (running !== state) {
        window.codepad.search.cancel(reply.searchId);
        return;
      }
      state.id = reply.searchId;
      const queued = state.queue;
      state.queue = [];
      for (const event of queued) handleSearchEvent(event);
    } catch (err) {
      if (running === state) running = null;
      setBusy(false);
      const message = err instanceof Error ? err.message : String(err);
      window.CodePadSearchResults.finish(set, { error: message });
      app().status.set(message);
    }
  }

  function findAll(o: CodePadSearchOptions): void {
    const matcher = core.buildMatcher(o);
    if ('error' in matcher) {
      app().status.set(matcher.error);
      return;
    }
    if (o.scope === 'folder') {
      findInFolder(o);
      return;
    }
    const tabs = tabsForScope(o);
    if (tabs.length === 0) {
      app().status.set('No text tab to search.');
      return;
    }
    const set = searchTabs(o, matcher, tabs);
    window.CodePadSearchResults.show(set);
    app().status.set(`${set.totals.matches} match(es) in ${set.totals.files} tab(s).`);
  }

  function countMatches(o: CodePadSearchOptions): void {
    const matcher = core.buildMatcher(o);
    if ('error' in matcher) {
      app().status.set(matcher.error);
      return;
    }
    const tabs = o.scope === 'tabs' ? textTabs() : tabsForScope({ scope: 'tab' });
    if (tabs.length === 0) {
      app().status.set('No text tab to search.');
      return;
    }
    const budget = o.isRegex ? REGEX_TIME_BUDGET_MS : 0;
    let total = 0;
    for (const tab of tabs) total += core.findAll(tab.model.getValue(), matcher, { timeBudgetMs: budget }).length;
    app().status.set(`${total} match(es) in ${tabs.length === 1 ? tabs[0].name : tabs.length + ' tabs'}.`);
  }

  async function replaceInTabs(o: CodePadSearchOptions): Promise<void> {
    if (o.scope === 'folder') {
      app().status.set('Replace in Files is not supported. Use Open Tabs or Current Tab.');
      return;
    }
    const matcher = core.buildMatcher(o);
    if ('error' in matcher) {
      app().status.set(matcher.error);
      return;
    }
    let replacer: (match: RegExpExecArray) => string;
    try {
      replacer = matcher.makeReplacer(o.replace);
    } catch (err) {
      app().status.set(err instanceof Error ? err.message : String(err));
      return;
    }
    const budget = o.isRegex ? REGEX_TIME_BUDGET_MS : 0;
    const plan: ReplacePlanEntry[] = [];
    let total = 0;
    let readOnly = 0;
    for (const tab of tabsForScope(o)) {
      if (tab.persist && tab.persist.readOnly) {
        readOnly++;
        continue;
      }
      const found = core.findAll(tab.model.getValue(), matcher, { keepMatch: true, timeBudgetMs: budget });
      if (found.length === 0) continue;
      plan.push({ tab, found, version: tab.model.getVersionId() });
      total += found.length;
    }
    const note = readOnly ? ` (${readOnly} read-only tab(s) skipped)` : '';
    if (total === 0) {
      app().status.set('No matches to replace' + note + '.');
      return;
    }
    const choice = await app().ui.confirm({
      title: 'Replace in Open Tabs',
      message: `Replace ${total} match(es) in ${plan.length} tab(s)?${note}`,
      buttons: ['Replace', 'Cancel']
    });
    if (choice !== 0) return;
    let replaced = 0;
    for (const { tab, found, version } of plan) {
      const model = tab.model;
      if (model.getVersionId() !== version) continue;
      const edits = found.map((m) => {
        const from = model.getPositionAt(m.index);
        const to = model.getPositionAt(m.index + m.length);
        return {
          range: new (app().monaco.Range)(from.lineNumber, from.column, to.lineNumber, to.column),
          // keepMatch was requested, so every hit carries its exec array.
          text: replacer(m.match as RegExpExecArray)
        };
      });
      model.pushStackElement();
      model.pushEditOperations([], edits, () => null);
      model.pushStackElement();
      replaced += edits.length;
    }
    app().status.set(`Replaced ${replaced} match(es).`);
  }

  function parseOffset(value: string): number {
    const text = value.trim();
    if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    return NaN;
  }

  async function gotoOffset(): Promise<void> {
    const value = await app().ui.prompt({ title: 'Go to Offset', label: 'Offset (decimal or 0x hex)', value: '' });
    if (value === null) return;
    const offset = parseOffset(value);
    if (Number.isNaN(offset)) {
      app().status.set('Enter a decimal number or a 0x hex number.');
      return;
    }
    const model = app().editor.getModel();
    if (!model) return;
    const position = model.getPositionAt(Math.min(offset, model.getValueLength()));
    app().editor.setPosition(position);
    app().editor.revealPositionInCenter(position);
    app().editor.focus();
  }

  /** Finds the innermost bracket pair around `offset` (quotes and comments are not considered). */
  function enclosingPair(text: string, offset: number): { start: number; end: number } | null {
    const stack: string[] = [];
    let open = -1;
    for (let i = offset - 1; i >= 0; i--) {
      const ch = text[i];
      if (CLOSING.includes(ch)) {
        stack.push(ch);
      } else if (OPENING.includes(ch)) {
        if (stack.length === 0) {
          open = i;
          break;
        }
        stack.pop();
      }
    }
    if (open === -1) return null;
    const opener = text[open];
    const closer = CLOSING[OPENING.indexOf(opener)];
    let depth = 0;
    for (let i = open + 1; i < text.length; i++) {
      if (text[i] === opener) depth++;
      else if (text[i] === closer) {
        if (depth === 0) return { start: open + 1, end: i };
        depth--;
      }
    }
    return null;
  }

  function selectBetweenBrackets(): void {
    const model = app().editor.getModel();
    const position = app().editor.getPosition();
    if (!model || !position) return;
    const pair = enclosingPair(model.getValue(), model.getOffsetAt(position));
    if (!pair) {
      app().status.set('No enclosing brackets found.');
      return;
    }
    const from = model.getPositionAt(pair.start);
    const to = model.getPositionAt(pair.end);
    app().editor.setSelection(new (app().monaco.Selection)(from.lineNumber, from.column, to.lineNumber, to.column));
    const selection = app().editor.getSelection();
    if (selection) app().editor.revealRangeInCenterIfOutsideViewport(selection);
  }

  CodePadFeatures.register('search', {
    init(context) {
      ctx = context;
      buildForm();
      app().panels.register({
        id: 'search',
        title: 'Find',
        location: 'left',
        order: 20,
        render(container) {
          container.appendChild(formOf().root);
          return {};
        }
      });
      if (window.codepad && window.codepad.search) window.codepad.search.onEvent(handleSearchEvent);
      publishOptions();
    }
  });

  CodePadCommands.register({
    id: 'search.findInFiles',
    run: () => openPanel('folder', true)
  });
  CodePadCommands.register({
    id: 'search.findInTabs',
    run: () => {
      openPanel('tabs', true);
      if (formOf().query.value) findAll(readOptions());
    }
  });
  CodePadCommands.register({
    id: 'search.findInCurrent',
    run: () => {
      openPanel('tab', true);
      if (formOf().query.value) findAll(readOptions());
    }
  });
  CodePadCommands.register({
    id: 'search.count',
    run: () => {
      if (!formOf().query.value) openPanel('tab', true);
      if (formOf().query.value) countMatches({ ...readOptions(), scope: 'tab' });
    }
  });
  CodePadCommands.register({
    id: 'search.replaceInTabs',
    run: () => {
      const o = readOptions();
      if (!o.query || o.scope === 'folder') {
        openPanel('tabs', true);
        return;
      }
      replaceInTabs(o);
    }
  });
  CodePadCommands.register({ id: 'search.gotoOffset', run: gotoOffset });
  CodePadCommands.register({ id: 'search.selectBetweenBrackets', run: selectBetweenBrackets });
  CodePadCommands.register({
    id: 'search.findNonAscii',
    run: () => findAll({ ...readOptions(), ...NON_ASCII_OPTIONS, extended: false, wholeWord: false, scope: 'tab' })
  });
})();
