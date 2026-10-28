'use strict';

/*
 * Search Results bottom panel: grouped by file, click to jump, next/previous result,
 * copy and clear. Fed by search.ts through window.CodePadSearchResults.
 * All file-derived text is inserted with textContent.
 */
(function () {
  const MAX_SETS = 20;
  const LAZY_AFTER_MATCHES = 2000;

  interface ResultsUi {
    strip: HTMLElement;
    summary: HTMLElement;
    tree: HTMLElement;
  }

  interface FileNode {
    node: HTMLElement;
    body: HTMLElement;
    arrow: HTMLElement;
    count: HTMLElement;
    filled: boolean;
  }

  interface Selection {
    set: CodePadResultSet;
    file: CodePadResultFile;
    match: CpSearchMatch;
  }

  let ctx: CodePadCtx | null = null;
  let ui: ResultsUi | null = null;
  let sets: CodePadResultSet[] = [];
  let active: CodePadResultSet | null = null;
  let selected: Selection | null = null;
  const rowEls = new WeakMap<CpSearchMatch, HTMLElement>();
  const fileNodes = new WeakMap<CodePadResultFile, FileNode>();

  function app(): CodePadCtx {
    if (!ctx) throw new Error('Search results feature is not initialised.');
    return ctx;
  }

  function panel(): ResultsUi {
    if (!ui) throw new Error('Search results panel is not rendered.');
    return ui;
  }

  function nodesOf(file: CodePadResultFile): FileNode {
    const entry = fileNodes.get(file);
    if (!entry) throw new Error('Search result file has no node.');
    return entry;
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function summaryText(set: CodePadResultSet): string {
    const t = set.totals;
    let text = `"${set.query}" - ${t.matches} match${t.matches === 1 ? '' : 'es'} in ${t.files} file${t.files === 1 ? '' : 's'}`;
    if (set.scope === 'folder' && t.filesScanned) text += `, ${t.filesScanned} scanned`;
    if (t.skippedBinary) text += `, ${t.skippedBinary} binary skipped`;
    if (t.skippedLarge) text += `, ${t.skippedLarge} large skipped`;
    if (set.error) text += ` - ${set.error}`;
    else if (set.running) text += ' - searching...';
    else if (t.cancelled) text += ' - cancelled';
    else if (t.truncated) text += ' - limited (more matches exist)';
    return text;
  }

  function updateSummary(): void {
    if (!ui) return;
    ui.summary.textContent = active ? summaryText(active) : 'No search results.';
    if (ctx) app().panels.setBadge('results', active && active.totals.matches ? String(active.totals.matches) : '');
  }

  function renderStrip(): void {
    const { strip } = panel();
    strip.textContent = '';
    for (const set of sets) {
      const tab = el('div', 'cp-results-tab' + (set === active ? ' active' : ''));
      const title = el('span', 'cp-results-tab-title', set.title);
      title.title = set.title;
      const close = el('span', 'cp-results-tab-close', '×');
      tab.append(title, close);
      tab.addEventListener('click', () => activate(set));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeSet(set);
      });
      strip.appendChild(tab);
    }
  }

  function buildPreview(match: CpSearchMatch): HTMLElement {
    const preview = el('span', 'cp-results-preview');
    const start = Math.max(0, match.col - 1 - match.previewStart);
    const end = Math.min(match.preview.length, start + match.length);
    preview.append(
      document.createTextNode(match.preview.slice(0, start)),
      el('mark', 'cp-results-hit', match.preview.slice(start, end).replace(/\r?\n/g, '↵')),
      document.createTextNode(match.preview.slice(end))
    );
    return preview;
  }

  function buildRow(set: CodePadResultSet, file: CodePadResultFile, match: CpSearchMatch): HTMLElement {
    const row = el('div', 'cp-results-match');
    row.append(el('span', 'cp-results-pos', `${match.line}:${match.col}`), buildPreview(match));
    row.addEventListener('click', () => select(set, file, match, false));
    row.addEventListener('dblclick', () => select(set, file, match, true));
    rowEls.set(match, row);
    return row;
  }

  function fillFile(set: CodePadResultSet, file: CodePadResultFile): void {
    const entry = nodesOf(file);
    if (entry.filled) return;
    entry.filled = true;
    const fragment = document.createDocumentFragment();
    for (const match of file.matches) fragment.appendChild(buildRow(set, file, match));
    entry.body.appendChild(fragment);
  }

  function setCollapsed(set: CodePadResultSet, file: CodePadResultFile, collapsed: boolean): void {
    const entry = nodesOf(file);
    file.collapsed = collapsed;
    entry.arrow.textContent = collapsed ? '▸' : '▾';
    entry.body.hidden = collapsed;
    if (!collapsed) fillFile(set, file);
  }

  function addFileNode(set: CodePadResultSet, file: CodePadResultFile): void {
    const node = el('div', 'cp-results-group');
    const head = el('div', 'cp-results-file');
    const arrow = el('span', 'cp-results-arrow');
    const count = el('span', 'cp-results-count', String(file.matches.length));
    const label = el('span', 'cp-results-label', CodePadSearchCore.displayName(file.label));
    label.title = CodePadSearchCore.displayName(file.path || file.label);
    head.append(arrow, label, count);
    const body = el('div', 'cp-results-body');
    node.append(head, body);
    fileNodes.set(file, { node, body, arrow, count, filled: false });
    head.addEventListener('click', () => setCollapsed(set, file, !file.collapsed));
    panel().tree.appendChild(node);
    setCollapsed(set, file, file.collapsed);
  }

  function renderActive(): void {
    if (!ui) return;
    renderStrip();
    ui.tree.textContent = '';
    selected = null;
    if (active) for (const file of active.files) addFileNode(active, file);
    updateSummary();
  }

  function activate(set: CodePadResultSet): void {
    active = set;
    renderActive();
  }

  function closeSet(set: CodePadResultSet): void {
    sets = sets.filter((s) => s !== set);
    if (active === set) active = sets[sets.length - 1] || null;
    renderActive();
  }

  function open(file: CodePadResultFile, match: CpSearchMatch): void {
    if (file.tabId) {
      const tab = app().tabs.byId(file.tabId);
      if (tab) {
        app().tabs.activate(tab);
        app().tabs.reveal(tab, match.line, match.col, match.length);
        return;
      }
    }
    if (!file.path) {
      app().status.set('The tab for this result was closed.');
      return;
    }
    app().tabs.openPath(file.path, { line: match.line, col: match.col }).then((tab) => {
      if (tab) app().tabs.reveal(tab, match.line, match.col, match.length);
    });
  }

  function select(set: CodePadResultSet, file: CodePadResultFile, match: CpSearchMatch, openIt: boolean): void {
    if (selected) {
      const previous = rowEls.get(selected.match);
      if (previous) previous.classList.remove('selected');
    }
    selected = { set, file, match };
    if (set.files.includes(file) && file.collapsed) setCollapsed(set, file, false);
    const row = rowEls.get(match);
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ block: 'nearest' });
    }
    if (openIt) open(file, match);
  }

  function step(dir: number, openIt: boolean): void {
    if (!active || active.files.length === 0) {
      app().status.set('No search results.');
      return;
    }
    const all: { file: CodePadResultFile; match: CpSearchMatch }[] = [];
    for (const file of active.files) for (const match of file.matches) all.push({ file, match });
    if (all.length === 0) return;
    const current = selected;
    let index = current && current.set === active ? all.findIndex((e) => e.match === current.match) : -1;
    if (index === -1) index = dir > 0 ? -1 : 0;
    const target = all[(index + dir + all.length) % all.length];
    if (target) select(active, target.file, target.match, openIt);
  }

  function removeSelected(): void {
    const current = active;
    if (!selected || !current || selected.set !== current) return;
    const { file, match } = selected;
    const all = current.files.flatMap((f) => f.matches);
    const neighbour = all[all.indexOf(match) + 1] || all[all.indexOf(match) - 1];
    file.matches.splice(file.matches.indexOf(match), 1);
    current.totals.matches--;
    const row = rowEls.get(match);
    if (row) row.remove();
    const entry = nodesOf(file);
    if (file.matches.length === 0) {
      current.files.splice(current.files.indexOf(file), 1);
      current.totals.files--;
      entry.node.remove();
    } else {
      entry.count.textContent = String(file.matches.length);
    }
    selected = null;
    updateSummary();
    if (neighbour) {
      const owner = current.files.find((f) => f.matches.includes(neighbour));
      if (owner) select(current, owner, neighbour, false);
    }
  }

  function resultsAsText(set: CodePadResultSet): string {
    const lines = [summaryText(set)];
    for (const file of set.files) {
      lines.push(file.path || file.label);
      for (const m of file.matches) lines.push(`  ${m.line}:${m.col}  ${m.preview.trim()}`);
    }
    return lines.join('\n');
  }

  function buildUi(container: HTMLElement): ResultsUi {
    const toolbar = el('div', 'cp-results-toolbar');
    const strip = el('div', 'cp-results-strip');
    const actions = el('div', 'cp-results-actions');
    const button = (label: string, title: string, handler: () => void): void => {
      const b = el('button', 'cp-results-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', handler);
      actions.appendChild(b);
    };
    button('Copy', 'Copy these results', () => {
      if (active) app().clipboard.write(resultsAsText(active));
    });
    button('Collapse', 'Collapse all files', () => {
      if (active) for (const f of active.files) setCollapsed(active, f, true);
    });
    button('Expand', 'Expand all files', () => {
      if (active) for (const f of active.files) setCollapsed(active, f, false);
    });
    button('Clear', 'Clear all results', clear);
    toolbar.append(strip, actions);
    const summary = el('div', 'cp-results-summary');
    const tree = el('div', 'cp-results-tree');
    tree.tabIndex = 0;
    tree.addEventListener('keydown', (event) => {
      const current = selected;
      if (event.key === 'ArrowDown') step(1, false);
      else if (event.key === 'ArrowUp') step(-1, false);
      else if (event.key === 'Enter' && current) open(current.file, current.match);
      else if (event.key === 'Delete') removeSelected();
      else return;
      event.preventDefault();
    });
    container.classList.add('cp-results');
    container.append(toolbar, summary, tree);
    return { strip, summary, tree };
  }

  /** Adds a result set (becomes the active one) and shows the panel. */
  function show(set: CodePadResultSet): void {
    sets.push(set);
    if (sets.length > MAX_SETS) sets.shift();
    active = set;
    app().panels.show('results');
    renderActive();
  }

  /** Appends files to a result set that is still being filled (Find in Files streaming). */
  function append(set: CodePadResultSet, files: CodePadResultFile[]): void {
    for (const file of files) {
      file.collapsed = set.totals.matches > LAZY_AFTER_MATCHES;
      set.files.push(file);
      set.totals.files++;
      set.totals.matches += file.matches.length;
      if (set === active && ui) addFileNode(set, file);
    }
    if (set === active) updateSummary();
  }

  /** Marks a result set as complete and merges final totals ({totals, error}). */
  function finish(set: CodePadResultSet, patch: { totals?: Partial<CodePadResultTotals>; error?: string }): void {
    Object.assign(set.totals, patch.totals || {});
    set.error = patch.error || null;
    set.running = false;
    if (set === active) updateSummary();
  }

  /** Redraws the summary line of a set whose totals changed (streaming progress). */
  function refresh(set: CodePadResultSet): void {
    if (set === active) updateSummary();
  }

  function clear(): void {
    sets = [];
    active = null;
    renderActive();
  }

  window.CodePadSearchResults = { show, append, finish, refresh, clear, next: () => step(1, true), prev: () => step(-1, true) };

  CodePadFeatures.register('search-results', {
    init(context) {
      ctx = context;
      app().panels.register({
        id: 'results',
        title: 'Search Results',
        location: 'bottom',
        order: 10,
        render(container) {
          ui = buildUi(container);
          renderActive();
          return {};
        }
      });
    }
  });

  CodePadCommands.register({ id: 'search.toggleResults', run: () => app().panels.toggle('results') });
  CodePadCommands.register({ id: 'search.nextResult', run: () => step(1, true) });
  CodePadCommands.register({ id: 'search.prevResult', run: () => step(-1, true) });
})();
