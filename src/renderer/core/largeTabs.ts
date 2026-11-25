/**
 * Large-file tabs (design: .claude/plans/large-files.md). A large tab is a normal Monaco text tab whose model holds
 * one window of the file; main owns the file, the line index and the edit overlay. This module is the renderer side:
 * paging between windows, the byte-proportional file scrollbar, commits of in-window edits, undo across windows,
 * save / reload, jumps (line, percent, byte), the status items and the `ctx.large` capability API.
 *
 * Undo note: Monaco 0.52's public ITextModel has no canUndo()/canRedo(). Undo first runs Monaco's own undo through
 * `editor.trigger` and looks at `model.getVersionId()`: unchanged means the window had nothing to undo, so the
 * overlay transaction is undone in main (`large:undo`) instead. Window swaps never reach Monaco's undo stack:
 * `model.setValue` resets it and `model.applyEdits` (used only while the window has no user edits) does not use it.
 */
(() => {
  /** Largest model text a commit may carry (UTF-16 units); an edit that grows the window past it is undone. */
  const MAX_COMMIT_CHARS = 16777216;
  /** The file scrollbar sends a jump at most this often while the thumb is dragged. */
  const DRAG_JUMP_MS = 150;
  const MIN_THUMB_PX = 24;
  const PAGING_RETRY_MS = 1000;
  /** Upper bound of the cursor numbers a session stores (main validates the same cap). */
  const SESSION_NUMBER_CAP = 10000000;
  const MAX_PERCENT = 100;

  type Direction = 'up' | 'down';
  type BusyKind = NonNullable<CodePadLargeState['busy']>;
  type JobKind = 'find' | 'count' | 'save' | 'line';

  interface Job {
    reqId: number;
    kind: JobKind;
  }

  /** A window requested ahead of the scroll position (paging) and what it was requested from. */
  interface Prefetch {
    direction: Direction;
    fromWindowId: number;
    revision: number;
    requestLine: number;
    window: CpLargeWindow;
  }

  /** Scroll position of a tab that is not the active one yet (restored sessions, jumps in the background). */
  interface Reveal {
    top: number;
    line: number;
    column: number;
  }

  /** Renderer-only bookkeeping of one large tab; the shared shape stays in CodePadLargeState. */
  interface Internals {
    lock: Promise<void>;
    queued: number;
    /** The user edited the window since it was loaded, so Monaco's undo stack is not empty: never shift it. */
    touched: boolean;
    /** Main refused a commit as too large: paging and jumps are blocked until the file is saved. */
    blocked: boolean;
    refusing: boolean;
    prefetch: Prefetch | null;
    prefetching: boolean;
    /** Paging stays quiet until this time after a failed window request (no retry on every scroll frame). */
    pagingRetryAt: number;
    job: Job | null;
    onCount: ((permille: number) => void) | null;
    progressShown: boolean;
    locating: boolean;
    reveal: Reveal | null;
    trimNoted: boolean;
  }

  interface Captured {
    topLine: number;
    offsetPx: number;
    selection: monaco.Selection | null;
  }

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const fmt = (value: number): string => Math.round(value).toLocaleString('en-US');

  function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
  }

  /** A positive whole number typed by the user ('1,204,381' is fine), or null. */
  function parseLineNumber(text: string): number | null {
    const cleaned = text.replace(/[\s,_]/g, '');
    if (!/^\d{1,15}$/.test(cleaned)) {
      return null;
    }
    const value = Number(cleaned);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }

  function viewOf(win: CpLargeWindow): CodePadLargeWindowView {
    return {
      windowId: win.windowId,
      revision: win.revision,
      byteStart: win.byteStart,
      byteEnd: win.byteEnd,
      firstLine: win.firstLine,
      firstLineExact: win.firstLineExact,
      continuation: [...win.continuation],
      segmentBytes: [...win.segmentBytes],
      atStart: win.atStart,
      atEnd: win.atEnd,
      readOnly: win.readOnly,
    };
  }

  function create(deps: CodePadLargeDeps): CodePadLargeController {
    const { api, monaco, ui, bus, settings } = deps;
    const editorOf = deps.getEditor;
    const byHandle = new Map<string, CodePadLargeTextTab>();
    const internalsOf = new WeakMap<CodePadTextTab, Internals>();
    let current: CodePadLargeTextTab | null = null;
    let overridesOn = false;
    let requestSeq = 1;
    let dragging = false;
    let frame = 0;

    const nextReq = (): number => {
      requestSeq += 1;
      return requestSeq;
    };

    function isLarge(tab: CodePadTab | null | undefined): tab is CodePadLargeTextTab {
      return tab !== null && tab !== undefined && tab.kind === 'text' && tab.large !== null;
    }

    function stateOf(tab: CodePadLargeTextTab): Internals {
      let state = internalsOf.get(tab);
      if (!state) {
        state = {
          lock: Promise.resolve(),
          queued: 0,
          touched: false,
          blocked: false,
          refusing: false,
          prefetch: null,
          prefetching: false,
          pagingRetryAt: 0,
          job: null,
          onCount: null,
          progressShown: false,
          locating: false,
          reveal: null,
          trimNoted: false,
        };
        internalsOf.set(tab, state);
      }
      return state;
    }

    // ---------- Locking: one window operation per tab at a time ----------

    async function exclusive<T>(tab: CodePadLargeTextTab, kind: BusyKind, work: () => Promise<T>): Promise<T> {
      const state = stateOf(tab);
      const previous = state.lock;
      let release: () => void = () => undefined;
      state.lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.queued += 1;
      await previous;
      state.queued -= 1;
      tab.large.busy = kind;
      if (kind === 'save' && tab === current) {
        applyOptions();
      }
      try {
        return await work();
      } finally {
        tab.large.busy = null;
        if (kind === 'save' && tab === current) {
          applyOptions();
        }
        release();
      }
    }

    /** Like `exclusive`, but gives up (null) when the tab is busy: for work nobody waits for (paging, drag jumps). */
    async function tryExclusive<T>(tab: CodePadLargeTextTab, kind: BusyKind, work: () => Promise<T>): Promise<T | null> {
      if (stateOf(tab).queued > 0 || tab.large.busy !== null) {
        return null;
      }
      return exclusive(tab, kind, work);
    }

    // ---------- State, options, dirty marker ----------

    function createState(opened: CpLargeOpenOk): CodePadLargeState {
      return {
        handle: opened.handle,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        seek: opened.seek,
        view: viewOf(opened.window),
        pending: null,
        baseVersion: 0,
        overlayDirty: false,
        applying: false,
        busy: null,
        index: { ...opened.window.index },
        baseLost: false,
        following: false,
      };
    }

    function initTab(tab: CodePadLargeTextTab): void {
      byHandle.set(tab.large.handle, tab);
      tab.large.baseVersion = tab.model.getAlternativeVersionId();
      tab.savedVersion = tab.large.baseVersion;
    }

    function refreshDirty(tab: CodePadLargeTextTab): void {
      deps.markDirty(tab, tab.large.overlayDirty || tab.model.getAlternativeVersionId() !== tab.large.baseVersion);
    }

    const computeReadOnly = (tab: CodePadLargeTextTab): boolean =>
      tab.persist.readOnly || tab.large.view.readOnly !== null || tab.large.busy === 'save' || tab.large.baseLost;

    function reasonText(tab: CodePadLargeTextTab): string {
      switch (tab.large.view.readOnly) {
        case 'longLine':
          return 'This part contains a line longer than 10,000 characters, shown in pieces; it is view-only.';
        case 'truncatedLine':
          return 'This line is longer than can be shown in this encoding; it is view-only.';
        case 'invalidBytes':
          return `This part contains bytes that are not valid ${deps.encodingLabel(tab.encoding)}; it is view-only. Try Encoding > Reopen with Encoding.`;
        default:
          return '';
      }
    }

    /** Edit Mode on a view-only part: say why typing does nothing. */
    function announceReadOnly(tab: CodePadLargeTextTab): void {
      if (tab === current && !tab.persist.readOnly && tab.large.view.readOnly !== null) {
        deps.setStatus(reasonText(tab));
      }
    }

    function gutterOptions(tab: CodePadLargeTextTab): Record<string, unknown> {
      const widest = CodePadLargeWindow.lineLabel(tab.large.view, Math.max(1, tab.model.getLineCount()));
      return {
        lineNumbers: (line: number): string => CodePadLargeWindow.lineLabel(tab.large.view, line),
        lineNumbersMinChars: Math.max(4, widest.length + 1),
      };
    }

    /** Applies (or, for any other tab, removes) the large-tab editor options on top of the settings. */
    function applyOptions(): void {
      const editor = editorOf();
      const tab = current;
      if (tab === null) {
        if (overridesOn) {
          overridesOn = false;
          const restored: Record<string, unknown> = {
            ...deps.settingsOptions(),
            folding: true,
            scrollbar: { vertical: 'auto' },
            lineNumbersMinChars: 5,
          };
          editor.updateOptions(restored as monaco.editor.IEditorOptions);
        }
        return;
      }
      overridesOn = true;
      const options: Record<string, unknown> = {
        ...deps.settingsOptions(),
        wordWrap: 'off',
        minimap: { enabled: false },
        folding: false,
        scrollbar: { vertical: 'hidden' },
        ...gutterOptions(tab),
        readOnly: computeReadOnly(tab),
      };
      editor.updateOptions(options as monaco.editor.IEditorOptions);
    }

    // ---------- Status items ----------

    const fileItem = deps.addStatusItem({ id: 'large-file', order: 40, onClick: () => showActions() });
    const indexItem = deps.addStatusItem({ id: 'large-index', order: 41, onClick: () => undefined });

    function updateStatusItems(): void {
      const tab = current;
      if (tab === null) {
        fileItem.set('');
        indexItem.set('');
        return;
      }
      const large = tab.large;
      const trouble = large.baseLost ? 'Changed on disk: your edits cannot be saved.' : large.view.readOnly !== null ? reasonText(tab) : '';
      fileItem.set(`Large file · ${formatBytes(large.size)}`, {
        title: trouble || 'Only part of this file is loaded at a time. Click for go-to actions.',
        state: trouble ? 'warn' : '',
      });
      const index = large.index;
      if (index.done) {
        const exact = index.totalLines !== null;
        indexItem.set(`${CodePadLargeWindow.formatCount(index.totalLines ?? index.estimatedLines, exact)} lines`, {
          title: exact ? 'Total number of lines' : 'Estimated number of lines',
        });
      } else {
        const percent = Math.min(99, Math.floor((index.bytes / Math.max(1, large.size)) * 100));
        indexItem.set(`Indexing ${percent}% · ${CodePadLargeWindow.formatCount(index.estimatedLines, false)} lines`, {
          title: 'The line index is built in the background; line numbers marked ~ are estimates until it reaches them.',
        });
      }
    }

    async function showActions(): Promise<void> {
      if (current === null) {
        return;
      }
      const choice = await ui.pick<string>({
        title: 'Large File',
        items: [
          { label: 'Go to Line...', value: 'edit.gotoLine' },
          { label: 'Go to Percent...', value: 'large.goToPercent' },
          { label: 'Go to Start of File', value: 'large.goToStart' },
          { label: 'Go to End of File', value: 'large.goToEnd' },
          { label: 'Count Matches in Whole File', value: 'large.count' },
        ],
      });
      if (choice !== null) {
        await window.CodePadCommands.execute(choice);
      }
    }

    function positionLabel(tab: CodePadLargeTextTab, position: { lineNumber: number; column: number }): string {
      const view = tab.large.view;
      const mark = view.firstLineExact ? '' : '~';
      const doc = fmt(CodePadLargeWindow.docLine(view, position.lineNumber));
      const piece = view.continuation.indexOf(position.lineNumber);
      if (piece >= 0) {
        const base = view.segmentBytes[piece] ?? view.byteStart;
        return `Ln ${mark}${doc}, Byte ≈${fmt(base + position.column - 1)}`;
      }
      return `Ln ${mark}${doc}, Col ${position.column}`;
    }

    // ---------- File scrollbar ----------

    const track = deps.scrollHost;
    const thumb = document.createElement('div');
    thumb.className = 'large-thumb';
    const tip = document.createElement('div');
    tip.className = 'large-tip';
    tip.hidden = true;
    track.append(thumb, tip);

    const trackPx = (): number => track.clientHeight;

    function thumbPx(tab: CodePadLargeTextTab): number {
      const view = tab.large.view;
      const share = (view.byteEnd - view.byteStart) / Math.max(1, tab.large.size);
      return Math.max(MIN_THUMB_PX, Math.min(trackPx(), trackPx() * share));
    }

    /** Estimated byte of the top visible line: the window's bytes spread evenly over its model lines. */
    function topByte(tab: CodePadLargeTextTab): number {
      const ranges = editorOf().getVisibleRanges();
      const view = tab.large.view;
      const top = ranges.length > 0 ? ranges[0].startLineNumber : 1;
      return view.byteStart + ((top - 1) / Math.max(1, tab.model.getLineCount())) * (view.byteEnd - view.byteStart);
    }

    function updateThumb(): void {
      const tab = current;
      if (tab === null || dragging) {
        return;
      }
      const height = thumbPx(tab);
      thumb.style.height = `${height}px`;
      thumb.style.top = `${CodePadLargeWindow.thumb(topByte(tab), tab.large.size, trackPx(), height)}px`;
    }

    function showTip(permille: number, top: number): void {
      tip.textContent = `${(permille / 10).toFixed(1)}%`;
      tip.style.top = `${top}px`;
      tip.hidden = false;
    }

    async function jumpPermille(tab: CodePadLargeTextTab, permille: number, skipIfBusy: boolean): Promise<boolean> {
      const target: CpLargeTarget = { to: 'permille', permille: Math.min(1000, Math.max(0, Math.round(permille))) };
      if (skipIfBusy) {
        return (await tryExclusive(tab, 'window', () => loadTargetNow(tab, target))) === true;
      }
      return exclusive(tab, 'window', () => loadTargetNow(tab, target));
    }

    let dragStartY = 0;
    let dragStartTop = 0;
    let lastJump = 0;

    thumb.addEventListener('pointerdown', (event) => {
      if (current === null) {
        return;
      }
      event.preventDefault();
      dragging = true;
      dragStartY = event.clientY;
      dragStartTop = thumb.offsetTop;
      lastJump = 0;
      thumb.setPointerCapture(event.pointerId);
      track.classList.add('dragging');
    });

    thumb.addEventListener('pointermove', (event) => {
      const tab = current;
      if (!dragging || tab === null) {
        return;
      }
      const height = thumb.offsetHeight;
      const top = Math.min(Math.max(0, trackPx() - height), Math.max(0, dragStartTop + event.clientY - dragStartY));
      thumb.style.top = `${top}px`;
      const permille = CodePadLargeWindow.permilleAt(top, trackPx(), height);
      showTip(permille, top);
      const now = Date.now();
      if (now - lastJump >= DRAG_JUMP_MS) {
        lastJump = now;
        void jumpPermille(tab, permille, true);
      }
    });

    const endDrag = (): void => {
      if (!dragging) {
        return;
      }
      const tab = current;
      track.classList.remove('dragging');
      tip.hidden = true;
      if (tab === null) {
        dragging = false;
        return;
      }
      const permille = CodePadLargeWindow.permilleAt(thumb.offsetTop, trackPx(), thumb.offsetHeight);
      void jumpPermille(tab, permille, false).finally(() => {
        dragging = false;
        updateThumb();
      });
    };
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);

    // A click on the empty track pages by one window.
    track.addEventListener('pointerdown', (event) => {
      const tab = current;
      if (tab === null || event.target !== track) {
        return;
      }
      const view = tab.large.view;
      const span = view.byteEnd - view.byteStart;
      const byte = event.offsetY < thumb.offsetTop ? Math.max(0, view.byteStart - span) : Math.min(tab.large.size, view.byteEnd);
      void exclusive(tab, 'window', () => loadTargetNow(tab, { to: 'byte', byte }));
    });

    // ---------- Windows: request, install, position ----------

    function failed(tab: CodePadLargeTextTab, code: CpLargeCode, message: string): void {
      switch (code) {
        case 'cancelled':
          deps.setStatus(message || 'Cancelled.');
          break;
        case 'stale':
          deps.setStatus('The loaded part was out of date. Try again.');
          break;
        case 'busy':
          deps.setStatus('The file is busy. Try again in a moment.');
          break;
        case 'badHandle':
          sessionEnded(tab, 'its session is no longer known');
          break;
        default:
          deps.setStatus(message || 'The operation failed.');
      }
    }

    function sessionEnded(tab: CodePadLargeTextTab, reason: string): void {
      tab.large.baseLost = true;
      if (tab === current) {
        applyOptions();
        updateStatusItems();
      }
      deps.setStatus(`${tab.name} can no longer be used (${reason}). Reload it from disk to continue.`);
    }

    async function requestWindow(
      tab: CodePadLargeTextTab,
      target: CpLargeTarget,
      place: 'top' | 'center',
      reqId: number = nextReq(),
      quiet = false,
    ): Promise<CpLargeWindow | null> {
      try {
        const result = await api.large.window(tab.large.handle, { reqId, target, place });
        if (result.ok) {
          return result.window;
        }
        if (!quiet) {
          failed(tab, result.code, result.message);
        }
        return null;
      } catch (error) {
        if (!quiet) {
          deps.setStatus(`Could not load that part of the file: ${errorText(error)}`);
        }
        return null;
      }
    }

    /** Takes over a served window as the tab's current view (the model text is already in place). */
    function adoptView(tab: CodePadLargeTextTab, win: CpLargeWindow): void {
      const large = tab.large;
      const state = stateOf(tab);
      large.view = viewOf(win);
      large.index = { ...win.index };
      large.baseVersion = tab.model.getAlternativeVersionId();
      large.pending = null;
      state.prefetch = null;
      state.touched = false;
      refreshDirty(tab);
    }

    /** Replaces the model text with a window: resets Monaco's undo stack and never marks the tab dirty. */
    function installWindow(tab: CodePadLargeTextTab, win: CpLargeWindow): void {
      const large = tab.large;
      large.applying = true;
      try {
        tab.model.setValue(win.text);
      } finally {
        large.applying = false;
      }
      adoptView(tab, win);
    }

    function afterWindowChange(tab: CodePadLargeTextTab): void {
      if (tab !== current) {
        return;
      }
      applyOptions();
      updateThumb();
      updateStatusItems();
      deps.refreshStatus();
    }

    function capture(): Captured {
      const editor = editorOf();
      const ranges = editor.getVisibleRanges();
      const topLine = ranges.length > 0 ? ranges[0].startLineNumber : 1;
      return { topLine, offsetPx: editor.getScrollTop() - editor.getTopForLineNumber(topLine), selection: editor.getSelection() };
    }

    /** Puts the scroll position and selection back after a window swap; `delta` = new model line - old model line. */
    function restore(tab: CodePadLargeTextTab, captured: Captured, delta: number): void {
      if (tab !== current) {
        return;
      }
      const editor = editorOf();
      const count = tab.model.getLineCount();
      const clamp = (line: number): number => Math.min(count, Math.max(1, line));
      const selection = captured.selection;
      if (selection) {
        const inside = (line: number): boolean => line + delta >= 1 && line + delta <= count;
        if (inside(selection.selectionStartLineNumber) && inside(selection.positionLineNumber)) {
          editor.setSelection(
            new monaco.Selection(
              selection.selectionStartLineNumber + delta,
              selection.selectionStartColumn,
              selection.positionLineNumber + delta,
              selection.positionColumn,
            ),
          );
        } else {
          editor.setPosition({ lineNumber: clamp(selection.positionLineNumber + delta), column: selection.positionColumn });
        }
      }
      editor.setScrollTop(editor.getTopForLineNumber(clamp(captured.topLine + delta)) + captured.offsetPx, monaco.editor.ScrollType.Immediate);
    }

    /** Moves the cursor to a loaded window's anchor line and shows it, for jumps and search results. */
    function showJump(tab: CodePadLargeTextTab, win: CpLargeWindow, select?: { column: number; length: number }, toEnd = false): void {
      installWindow(tab, win);
      const count = tab.model.getLineCount();
      const line = Math.min(count, Math.max(1, toEnd ? count : win.anchorModelLine));
      if (tab === current) {
        const editor = editorOf();
        if (select && select.length > 0) {
          editor.setSelection(new monaco.Range(line, select.column, line, select.column + select.length));
        } else {
          editor.setPosition({ lineNumber: line, column: toEnd ? tab.model.getLineMaxColumn(line) : select ? select.column : 1 });
        }
        if (toEnd) {
          editor.revealLine(line, monaco.editor.ScrollType.Immediate);
        } else {
          editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
        }
        afterWindowChange(tab);
      } else {
        stateOf(tab).reveal = { top: line, line, column: 1 };
      }
      announceReadOnly(tab);
    }

    function applyReveal(tab: CodePadLargeTextTab): void {
      const state = stateOf(tab);
      const reveal = state.reveal;
      if (reveal === null) {
        return;
      }
      state.reveal = null;
      const editor = editorOf();
      const count = tab.model.getLineCount();
      const line = Math.min(count, Math.max(1, reveal.line));
      editor.setPosition({ lineNumber: line, column: Math.min(tab.model.getLineMaxColumn(line), Math.max(1, reveal.column)) });
      editor.setScrollTop(editor.getTopForLineNumber(Math.min(count, Math.max(1, reveal.top))), monaco.editor.ScrollType.Immediate);
    }

    // ---------- Commit ----------

    /** Sends the in-window edits to main (no lock: call inside `exclusive`). False when they could not be kept. */
    async function commitNow(tab: CodePadLargeTextTab): Promise<boolean> {
      const large = tab.large;
      const model = tab.model;
      const version = model.getAlternativeVersionId();
      if (version === large.baseVersion || large.view.readOnly !== null || large.baseLost) {
        return true;
      }
      const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
      if (text.length > MAX_COMMIT_CHARS) {
        deps.setStatus('This edit is too large for a large file.');
        return false;
      }
      let result: Awaited<ReturnType<typeof api.large.commit>>;
      try {
        result = await api.large.commit(large.handle, { windowId: large.view.windowId, revision: large.view.revision, text });
      } catch (error) {
        deps.setStatus(`Could not keep your edits: ${errorText(error)}`);
        return false;
      }
      const state = stateOf(tab);
      if (!result.ok) {
        if (result.code === 'tooLarge') {
          state.blocked = true;
          deps.setStatus('Too many unsaved changes for a large file: save to continue.');
        } else if (result.code === 'stale') {
          deps.setStatus('The loaded part was out of date, so your latest edits there could not be kept.');
        } else {
          failed(tab, result.code, result.message);
        }
        return false;
      }
      state.blocked = false;
      large.view = viewOf(result.window);
      large.index = { ...result.window.index };
      large.overlayDirty = result.dirty;
      large.baseVersion = version;
      large.pending = null;
      state.prefetch = null;
      refreshDirty(tab);
      return true;
    }

    // ---------- Jumps ----------

    async function loadTargetNow(
      tab: CodePadLargeTextTab,
      target: CpLargeTarget,
      options: { select?: { column: number; length: number }; toEnd?: boolean } = {},
    ): Promise<boolean> {
      if (!(await commitNow(tab))) {
        return false;
      }
      const state = stateOf(tab);
      const reqId = nextReq();
      if (target.to === 'line') {
        state.job = { reqId, kind: 'line' };
      }
      let win: CpLargeWindow | null;
      try {
        win = await requestWindow(tab, target, 'center', reqId);
      } finally {
        endJob(tab, reqId);
      }
      if (win === null) {
        return false;
      }
      if (tab.model.getAlternativeVersionId() !== tab.large.baseVersion) {
        deps.setStatus('Your text changed while the part was loading. Try again.');
        return false;
      }
      showJump(tab, win, options.select, options.toEnd);
      return true;
    }

    function endJob(tab: CodePadLargeTextTab, reqId: number): void {
      const state = stateOf(tab);
      if (state.job !== null && state.job.reqId === reqId) {
        state.job = null;
        state.onCount = null;
        if (state.progressShown && tab === current) {
          deps.setStatus('');
        }
        state.progressShown = false;
      }
    }

    function placeCursor(tab: CodePadLargeTextTab, line: number, column: number, length: number): void {
      const editor = editorOf();
      if (length > 0) {
        editor.setSelection(new monaco.Range(line, column, line, column + length));
      } else {
        editor.setPosition({ lineNumber: line, column: Math.min(tab.model.getLineMaxColumn(line), Math.max(1, column)) });
      }
      editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
      editor.focus();
    }

    async function goToLine(tab: CodePadLargeTextTab, line: number, column = 1, length = 0): Promise<boolean> {
      if (!Number.isSafeInteger(line) || line < 1) {
        return false;
      }
      const view = tab.large.view;
      if (tab === current && view.firstLineExact && view.continuation.length === 0) {
        const local = line - view.firstLine + 1;
        if (local >= 1 && local <= tab.model.getLineCount()) {
          placeCursor(tab, local, column, length);
          return true;
        }
      }
      const select = length > 0 || column > 1 ? { column, length } : undefined;
      return exclusive(tab, 'window', () => loadTargetNow(tab, { to: 'line', line }, select ? { select } : {}));
    }

    async function goToStart(tab: CodePadLargeTextTab): Promise<boolean> {
      if (tab === current && tab.large.view.atStart) {
        placeCursor(tab, 1, 1, 0);
        editorOf().revealLine(1, monaco.editor.ScrollType.Immediate);
        return true;
      }
      return exclusive(tab, 'window', () => loadTargetNow(tab, { to: 'start' }));
    }

    async function goToEnd(tab: CodePadLargeTextTab): Promise<boolean> {
      if (tab === current && tab.large.view.atEnd) {
        const last = tab.model.getLineCount();
        editorOf().setPosition({ lineNumber: last, column: tab.model.getLineMaxColumn(last) });
        editorOf().revealLine(last, monaco.editor.ScrollType.Immediate);
        return true;
      }
      return exclusive(tab, 'window', () => loadTargetNow(tab, { to: 'end' }, { toEnd: true }));
    }

    function goTo(tab: CodePadLargeTextTab, target: Parameters<CodePadLargeApi['goTo']>[1]): Promise<boolean> {
      if (target === 'start') {
        return goToStart(tab);
      }
      if (target === 'end') {
        return goToEnd(tab);
      }
      if ('line' in target) {
        return goToLine(tab, target.line);
      }
      if ('permille' in target) {
        return jumpPermille(tab, target.permille, false);
      }
      const byte = Math.max(0, Math.floor(target.byte));
      return exclusive(tab, 'window', () => loadTargetNow(tab, { to: 'byte', byte }));
    }

    async function promptGoToLine(tab: CodePadLargeTextTab): Promise<void> {
      const index = tab.large.index;
      const total = index.done && index.totalLines !== null ? index.totalLines : null;
      const answer = await ui.prompt({
        title: 'Go to Line',
        label: total !== null ? `Line number (1 - ${fmt(total)})` : 'Line number (the line index is still being built; far lines may take a moment)',
        validate: (value) => (parseLineNumber(value) === null ? 'Enter a whole line number, 1 or higher.' : null),
      });
      const line = answer === null ? null : parseLineNumber(answer);
      if (line !== null) {
        await goToLine(tab, total !== null ? Math.min(line, total) : line);
      }
    }

    async function promptGoToPercent(tab: CodePadLargeTextTab): Promise<void> {
      const parse = (value: string): number | null => {
        const percent = Number(value.trim().replace(',', '.').replace(/%$/, ''));
        return value.trim() !== '' && Number.isFinite(percent) && percent >= 0 && percent <= MAX_PERCENT ? percent : null;
      };
      const answer = await ui.prompt({
        title: 'Go to Percent',
        label: 'Position in the file (0 - 100 %)',
        validate: (value) => (parse(value) === null ? 'Enter a number between 0 and 100.' : null),
      });
      const percent = answer === null ? null : parse(answer);
      if (percent !== null) {
        await jumpPermille(tab, percent * 10, false);
      }
    }

    // ---------- Paging ----------

    const prefetchValid = (tab: CodePadLargeTextTab, prefetch: Prefetch | null): prefetch is Prefetch =>
      prefetch !== null &&
      prefetch.fromWindowId === tab.large.view.windowId &&
      prefetch.revision === tab.large.view.revision &&
      tab.model.getAlternativeVersionId() === tab.large.baseVersion;

    async function prefetchWindow(tab: CodePadLargeTextTab, direction: Direction, middle: number): Promise<void> {
      const state = stateOf(tab);
      if (state.blocked || state.prefetching || tab.model.getAlternativeVersionId() !== tab.large.baseVersion) {
        return;
      }
      if (prefetchValid(tab, state.prefetch) && state.prefetch.direction === direction) {
        return;
      }
      const from = { windowId: tab.large.view.windowId, revision: tab.large.view.revision };
      state.prefetching = true;
      try {
        const win = await requestWindow(tab, { to: 'relative', windowId: from.windowId, modelLine: middle }, 'center', nextReq(), true);
        if (win === null) {
          state.pagingRetryAt = Date.now() + PAGING_RETRY_MS;
        } else if (tab.large.view.windowId === from.windowId && tab.large.view.revision === from.revision) {
          state.prefetch = { direction, fromWindowId: from.windowId, revision: from.revision, requestLine: middle, window: win };
          tab.large.pending = win;
        }
      } finally {
        state.prefetching = false;
      }
    }

    /** Overlap of two windows is re-used: only the lines that differ are edited, so the view does not jump. */
    function shiftByEdits(tab: CodePadLargeTextTab, win: CpLargeWindow, delta: number): boolean {
      const model = tab.model;
      const oldCount = model.getLineCount();
      const newLines = win.text.split('\n');
      const newCount = newLines.length;
      const overlapStart = Math.max(1, 1 - delta);
      const overlapEnd = Math.min(oldCount, newCount - delta);
      if (overlapStart > overlapEnd) {
        return false;
      }
      if (
        model.getLineContent(overlapStart) !== newLines[overlapStart + delta - 1] ||
        model.getLineContent(overlapEnd) !== newLines[overlapEnd + delta - 1]
      ) {
        return false;
      }
      const newStart = overlapStart + delta;
      const newEnd = overlapEnd + delta;
      const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
      if (overlapStart > 1 || newStart > 1) {
        edits.push({
          range: new monaco.Range(1, 1, overlapStart, 1),
          text: newLines
            .slice(0, newStart - 1)
            .map((line) => `${line}\n`)
            .join(''),
        });
      }
      if (overlapEnd < oldCount || newEnd < newCount) {
        edits.push({
          range: new monaco.Range(overlapEnd, model.getLineMaxColumn(overlapEnd), oldCount, model.getLineMaxColumn(oldCount)),
          text: newLines
            .slice(newEnd)
            .map((line) => `\n${line}`)
            .join(''),
        });
      }
      const large = tab.large;
      large.applying = true;
      try {
        model.applyEdits(edits);
      } finally {
        large.applying = false;
      }
      return model.getValue(monaco.editor.EndOfLinePreference.LF) === win.text;
    }

    function applyShift(tab: CodePadLargeTextTab, win: CpLargeWindow, requestLine: number): void {
      const captured = capture();
      const delta = win.anchorModelLine - requestLine;
      if (stateOf(tab).touched || !shiftByEdits(tab, win, delta)) {
        installWindow(tab, win);
      } else {
        adoptView(tab, win);
      }
      restore(tab, captured, delta);
      afterWindowChange(tab);
      announceReadOnly(tab);
    }

    async function shiftWindow(tab: CodePadLargeTextTab, direction: Direction, middle: number): Promise<void> {
      await tryExclusive(tab, 'window', async () => {
        const state = stateOf(tab);
        if (state.blocked) {
          deps.setStatus('Too many unsaved changes for a large file: save to continue.');
          return;
        }
        if (tab.model.getAlternativeVersionId() !== tab.large.baseVersion) {
          if (!(await commitNow(tab))) {
            return;
          }
        }
        let win: CpLargeWindow | null = null;
        let requestLine = middle;
        const ready = state.prefetch;
        if (prefetchValid(tab, ready) && ready.direction === direction) {
          win = ready.window;
          requestLine = ready.requestLine;
        } else {
          win = await requestWindow(tab, { to: 'relative', windowId: tab.large.view.windowId, modelLine: middle }, 'center');
        }
        state.prefetch = null;
        tab.large.pending = null;
        if (win === null) {
          state.pagingRetryAt = Date.now() + PAGING_RETRY_MS;
          return;
        }
        if (tab.model.getAlternativeVersionId() !== tab.large.baseVersion) {
          return;
        }
        applyShift(tab, win, requestLine);
      });
    }

    function checkPaging(tab: CodePadLargeTextTab): void {
      if (dragging || tab !== current || tab.large.busy !== null || stateOf(tab).queued > 0 || Date.now() < stateOf(tab).pagingRetryAt) {
        return;
      }
      const ranges = editorOf().getVisibleRanges();
      if (ranges.length === 0) {
        return;
      }
      const top = ranges[0].startLineNumber;
      const bottom = ranges[ranges.length - 1].endLineNumber;
      const need = CodePadLargeWindow.shiftNeed(tab.large.view, tab.model.getLineCount(), top, bottom);
      const middle = Math.round((top + bottom) / 2);
      if (need.apply !== null) {
        void shiftWindow(tab, need.apply, middle);
      } else if (need.prefetch !== null) {
        void prefetchWindow(tab, need.prefetch, middle);
      }
    }

    // ---------- Edits, undo ----------

    function modelChanged(tab: CodePadLargeTextTab, event: monaco.editor.IModelContentChangedEvent): void {
      if (tab.large.applying || event.isFlush) {
        return;
      }
      const state = stateOf(tab);
      state.touched = true;
      if (tab.model.getValueLength() > MAX_COMMIT_CHARS) {
        if (!state.refusing) {
          state.refusing = true;
          setTimeout(() => {
            state.refusing = false;
            if (tab === current && !tab.model.isDisposed()) {
              editorOf().trigger('large', 'undo', null);
              deps.setStatus('This edit is too large for a large file.');
            }
          }, 0);
        }
        return;
      }
      refreshDirty(tab);
      if (tab === current) {
        deps.refreshStatus();
      }
    }

    async function undoRedo(tab: CodePadLargeTextTab, kind: 'undo' | 'redo'): Promise<void> {
      if (computeReadOnly(tab)) {
        return;
      }
      const before = tab.model.getVersionId();
      editorOf().trigger('large', kind, null);
      if (tab.model.getVersionId() !== before) {
        return;
      }
      // Nothing left to undo inside this window: step through the transactions kept in main.
      await exclusive(tab, 'undo', async () => {
        if (!(await commitNow(tab))) {
          return;
        }
        let result: Awaited<ReturnType<typeof api.large.undo>>;
        try {
          result = kind === 'undo' ? await api.large.undo(tab.large.handle) : await api.large.redo(tab.large.handle);
        } catch (error) {
          deps.setStatus(`Could not ${kind}: ${errorText(error)}`);
          return;
        }
        if (!result.ok) {
          failed(tab, result.code, result.message);
          return;
        }
        if ('empty' in result) {
          deps.setStatus(kind === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
          return;
        }
        tab.large.overlayDirty = result.dirty;
        const win = await requestWindow(tab, { to: 'anchor', anchor: result.anchor }, 'center');
        if (win !== null) {
          showJump(tab, win);
          refreshDirty(tab);
        }
      });
    }

    function runOnCurrent(work: (tab: CodePadLargeTextTab) => Promise<unknown>): void {
      const tab = current;
      if (tab !== null) {
        void work(tab);
      }
    }

    // ---------- Search, count, refresh ----------

    function cancelJob(tab: CodePadLargeTextTab): void {
      const job = stateOf(tab).job;
      if (job !== null) {
        void api.large.cancel(tab.large.handle, job.reqId).catch(() => undefined);
      }
    }

    async function find(tab: CodePadLargeTextTab, query: CpLargeFindQuery, direction: 'next' | 'prev'): Promise<CodePadLargeFindOutcome> {
      return exclusive(tab, 'find', async (): Promise<CodePadLargeFindOutcome> => {
        const none: CodePadLargeFindOutcome = { found: false, cancelled: false };
        if (!(await commitNow(tab))) {
          return none;
        }
        const state = stateOf(tab);
        const reqId = nextReq();
        state.job = { reqId, kind: 'find' };
        try {
          const view = tab.large.view;
          const from: CpLargeAnchor = { byte: direction === 'next' ? view.byteEnd : view.byteStart, sub: 0 };
          const result = await api.large.find(tab.large.handle, reqId, query, from, direction, true);
          if (!result.ok) {
            failed(tab, result.code, result.message);
            return { found: false, cancelled: result.code === 'cancelled' };
          }
          if (result.match === null) {
            return none;
          }
          const match = result.match;
          const win = await requestWindow(tab, { to: 'anchor', anchor: match.anchor }, 'center');
          if (win === null) {
            return none;
          }
          showJump(tab, win, { column: match.column, length: match.length });
          return { found: true, wrapped: result.wrapped };
        } catch (error) {
          deps.setStatus(`The search failed: ${errorText(error)}`);
          return none;
        } finally {
          endJob(tab, reqId);
        }
      });
    }

    async function count(tab: CodePadLargeTextTab, query: CpLargeFindQuery, onProgress: (permille: number) => void): Promise<number | null> {
      if (!(await exclusive(tab, 'commit', () => commitNow(tab)))) {
        return null;
      }
      const state = stateOf(tab);
      const reqId = nextReq();
      state.job = { reqId, kind: 'count' };
      state.onCount = onProgress;
      try {
        const result = await api.large.count(tab.large.handle, reqId, query);
        if (!result.ok) {
          failed(tab, result.code, result.message);
          return null;
        }
        if (result.capped) {
          deps.setStatus(`Counting stopped at ${fmt(result.count)} matches.`);
        }
        return result.count;
      } catch (error) {
        deps.setStatus(`Could not count the matches: ${errorText(error)}`);
        return null;
      } finally {
        endJob(tab, reqId);
      }
    }

    function windowText(tab: CodePadLargeTextTab): { text: string; firstLine: number; exact: boolean; lineCount: number } {
      return {
        text: tab.model.getValue(monaco.editor.EndOfLinePreference.LF),
        firstLine: tab.large.view.firstLine,
        exact: tab.large.view.firstLineExact,
        lineCount: tab.model.getLineCount(),
      };
    }

    function openWindowAsUntitled(tab: CodePadLargeTextTab): CodePadTextTab {
      const shown = windowText(tab);
      const mark = shown.exact ? '' : '~';
      return deps.openText({
        name: `${tab.name} (lines ${mark}${fmt(shown.firstLine)}-${mark}${fmt(shown.firstLine + shown.lineCount - 1)})`,
        content: shown.text,
        language: tab.model.getLanguageId(),
      });
    }

    /** What the user sees of a change on disk: the quiet cases are handled here, the rest is up to the caller. */
    async function applyDisk(tab: CodePadLargeTextTab, kind: CpLargeDiskKind, size: number, mtimeMs: number): Promise<void> {
      const large = tab.large;
      switch (kind) {
        case 'same':
          return;
        case 'appended': {
          const grew = Math.max(0, size - large.size);
          large.size = size;
          large.mtimeMs = mtimeMs;
          tab.diskStat = { mtimeMs, size };
          large.following = tab.persist.monitor || large.view.atEnd;
          if (tab === current) {
            deps.setStatus(`The file grew by ${formatBytes(grew)}.`);
            updateStatusItems();
            updateThumb();
          }
          if (large.following && !tab.dirty) {
            await goToEnd(tab);
          }
          return;
        }
        case 'replaced':
        case 'modified': {
          if (!tab.dirty) {
            if (await reload(tab)) {
              bus.emit('tab:reloaded', tab);
            }
          } else if (kind === 'replaced') {
            deps.setStatus(`${tab.name} was replaced on disk. Saving asks before overwriting it.`);
          } else {
            large.baseLost = true;
            if (tab === current) {
              applyOptions();
              updateStatusItems();
            }
            deps.setStatus(`${tab.name} changed on disk while you were editing; your changes cannot be saved. Reload it (discarding them) or copy the visible part to a new tab.`);
          }
          return;
        }
        case 'deleted':
          deps.setStatus(`${tab.name} was deleted on disk.`);
          return;
      }
    }

    async function refresh(tab: CodePadLargeTextTab): Promise<CpLargeDiskKind> {
      try {
        const result = await api.large.refresh(tab.large.handle);
        if (!result.ok) {
          failed(tab, result.code, result.message);
          return 'same';
        }
        await applyDisk(tab, result.kind, result.size, result.mtimeMs);
        return result.kind;
      } catch (error) {
        deps.setStatus(`Could not check ${tab.name} on disk: ${errorText(error)}`);
        return 'same';
      }
    }

    // ---------- Save, Save As, reload ----------

    async function saveNow(tab: CodePadLargeTextTab, targetPath: string | null, allowLossy: boolean, overwriteReplaced: boolean): Promise<boolean> {
      const large = tab.large;
      const state = stateOf(tab);
      const captured = tab === current ? capture() : null;
      const view = large.view;
      const topDocLine = CodePadLargeWindow.docLine(view, captured ? captured.topLine : 1);
      const topPermille = Math.round((topByte(tab) / Math.max(1, large.size)) * 1000);
      const reqId = nextReq();
      state.job = { reqId, kind: 'save' };
      deps.setStatus('Saving… 0%');
      state.progressShown = true;
      let result: Awaited<ReturnType<typeof api.large.save>>;
      try {
        result =
          targetPath === null
            ? await api.large.save(large.handle, reqId, { allowLossy, overwriteReplaced })
            : await api.large.saveAs(large.handle, reqId, targetPath, { allowLossy });
      } catch (error) {
        endJob(tab, reqId);
        deps.setStatus(`Could not save ${tab.name}: ${errorText(error)}`);
        return false;
      }
      endJob(tab, reqId);
      if (!result.ok) {
        return saveFailed(tab, targetPath, result, allowLossy, overwriteReplaced);
      }
      large.size = result.size;
      large.mtimeMs = result.mtimeMs;
      large.overlayDirty = false;
      state.blocked = false;
      tab.diskStat = { mtimeMs: result.mtimeMs, size: result.size };
      // The file was rewritten: reload the part that was on screen by its (unchanged) line number.
      const target: CpLargeTarget = view.firstLineExact ? { to: 'line', line: topDocLine } : { to: 'permille', permille: topPermille };
      const win = await requestWindow(tab, target, 'center');
      if (win !== null) {
        installWindow(tab, win);
        if (captured) {
          restore(tab, captured, win.anchorModelLine - captured.topLine);
        }
        afterWindowChange(tab);
      } else {
        refreshDirty(tab);
      }
      const trimNote = settings.get('files.trimTrailingOnSave') && !state.trimNoted;
      state.trimNoted = state.trimNoted || trimNote;
      deps.setStatus(`Saved ${targetPath === null ? tab.name : deps.baseName(targetPath)}${trimNote ? '. Trim on save is skipped for large files.' : ''}`);
      return true;
    }

    async function saveFailed(
      tab: CodePadLargeTextTab,
      targetPath: string | null,
      result: Extract<Awaited<ReturnType<typeof api.large.save>>, { ok: false }>,
      allowLossy: boolean,
      overwriteReplaced: boolean,
    ): Promise<boolean> {
      switch (result.code) {
        case 'lossy': {
          const bad = 'badChar' in result && result.badChar ? ` ("${result.badChar}")` : '';
          const choice = await ui.confirm({
            title: 'Characters cannot be saved',
            message: `${tab.name} contains characters${bad} that ${deps.encodingLabel(tab.encoding)} cannot represent.`,
            buttons: ['Save anyway (characters become ?)', 'Cancel'],
          });
          return choice === 0 ? saveNow(tab, targetPath, true, overwriteReplaced) : false;
        }
        case 'changed':
        case 'readOnly': {
          let kind: CpLargeDiskKind = 'modified';
          try {
            const state = await api.large.refresh(tab.large.handle);
            if (state.ok) {
              kind = state.kind;
            }
          } catch {
            // Treated as modified: the safe reading of "cannot tell what happened to the file".
          }
          if (kind === 'replaced' && targetPath === null && !overwriteReplaced) {
            const choice = await ui.confirm({
              title: 'File replaced on disk',
              message: `${tab.name} was replaced on disk by another program. Overwrite it with your version?`,
              buttons: ['Overwrite', 'Cancel'],
            });
            return choice === 0 ? saveNow(tab, targetPath, allowLossy, true) : false;
          }
          tab.large.baseLost = true;
          if (tab === current) {
            applyOptions();
            updateStatusItems();
          }
          deps.setStatus(`${tab.name} changed on disk while you were editing; your changes cannot be saved. Reload it (discarding them) or copy the visible part to a new tab.`);
          return false;
        }
        case 'noSpace':
          deps.setStatus(`There is not enough free disk space to save ${tab.name} (a full temporary copy is written first).`);
          return false;
        default:
          failed(tab, result.code, result.message);
          return false;
      }
    }

    function save(tab: CodePadLargeTextTab): Promise<boolean> {
      return exclusive(tab, 'save', async () => {
        if (tab.large.baseLost) {
          deps.setStatus(`${tab.name} changed on disk, so it cannot be saved here. Reload it or copy the visible part to a new tab.`);
          return false;
        }
        return (await commitNow(tab)) && saveNow(tab, null, false, false);
      });
    }

    function saveAs(tab: CodePadLargeTextTab, targetPath: string): Promise<boolean> {
      return exclusive(tab, 'save', async () => (await commitNow(tab)) && saveNow(tab, targetPath, false, false));
    }

    /** Where the tab's top line and cursor are, as a session or a reload wants them. */
    async function position(tab: CodePadLargeTextTab): Promise<CodePadLargePosition> {
      const state = stateOf(tab);
      let topLine = 1;
      let cursorLine = 1;
      let cursorColumn = 1;
      if (tab === current) {
        const ranges = editorOf().getVisibleRanges();
        topLine = ranges.length > 0 ? ranges[0].startLineNumber : 1;
        const cursor = editorOf().getPosition();
        cursorLine = cursor ? cursor.lineNumber : topLine;
        cursorColumn = cursor ? cursor.column : 1;
      } else if (tab.viewState) {
        topLine = tab.viewState.viewState.firstPosition.lineNumber;
        const cursor = tab.viewState.cursorState[0];
        cursorLine = cursor ? cursor.position.lineNumber : topLine;
        cursorColumn = cursor ? cursor.position.column : 1;
      } else if (state.reveal) {
        topLine = state.reveal.top;
        cursorLine = state.reveal.line;
        cursorColumn = state.reveal.column;
      }
      let anchor: CpLargeAnchor = { byte: tab.large.view.byteStart, sub: 0 };
      try {
        const located = await api.large.locate(tab.large.handle, tab.large.view.windowId, topLine);
        if (located.ok) {
          anchor = located.anchor;
        }
      } catch {
        // The window start is a good enough position when main cannot resolve the line.
      }
      return {
        byte: Math.min(SESSION_NUMBER_CAP * SESSION_NUMBER_CAP, Math.max(0, anchor.byte)),
        sub: Math.min(SESSION_NUMBER_CAP, Math.max(0, anchor.sub)),
        cursorLine: Math.min(SESSION_NUMBER_CAP, Math.max(0, cursorLine - topLine)),
        cursorColumn: Math.min(SESSION_NUMBER_CAP, Math.max(1, cursorColumn)),
      };
    }

    function restorePosition(tab: CodePadLargeTextTab, saved: CodePadLargePosition): Promise<void> {
      return exclusive(tab, 'window', async () => {
        const win = await requestWindow(tab, { to: 'byte', byte: Math.min(saved.byte, tab.large.size) }, 'center');
        if (win === null) {
          return;
        }
        installWindow(tab, win);
        const count = tab.model.getLineCount();
        const top = Math.min(count, Math.max(1, win.anchorModelLine));
        stateOf(tab).reveal = { top, line: Math.min(count, top + saved.cursorLine), column: saved.cursorColumn };
        if (tab === current) {
          applyReveal(tab);
          afterWindowChange(tab);
        }
      });
    }

    function reload(tab: CodePadLargeTextTab, options: { encoding?: string } = {}): Promise<boolean> {
      return exclusive(tab, 'window', async () => {
        const filePath = tab.path;
        if (filePath === null) {
          return false;
        }
        const old = tab.large;
        const where = await position(tab);
        const encoding = options.encoding || tab.encoding;
        let opened = await api.large.open(filePath, { encoding }).catch((error: unknown) => {
          deps.setStatus(`Could not reload ${tab.name}: ${errorText(error)}`);
          return null;
        });
        if (opened !== null && !opened.ok && opened.code === 'limit') {
          // Every session slot is taken (this tab holds one): release the old session first, then try again.
          void api.large.close(old.handle).catch(() => undefined);
          opened = await api.large.open(filePath, { encoding }).catch(() => null);
        }
        if (opened === null) {
          return false;
        }
        if (!opened.ok) {
          deps.setStatus(`Could not reload ${tab.name}: ${opened.message}`);
          return false;
        }
        byHandle.delete(old.handle);
        void api.large.close(old.handle).catch(() => undefined);
        const state = createState(opened);
        state.following = old.following;
        tab.large = state;
        byHandle.set(state.handle, tab);
        const internals = stateOf(tab);
        internals.blocked = false;
        internals.job = null;
        tab.encoding = opened.encoding;
        tab.eol = opened.eol;
        tab.diskStat = { mtimeMs: opened.mtimeMs, size: opened.size };
        installWindow(tab, opened.window);
        afterWindowChange(tab);
        if (where.byte > 0) {
          await loadTargetNow(tab, { to: 'byte', byte: Math.min(where.byte, opened.size) });
        }
        return true;
      });
    }

    function close(tab: CodePadLargeTextTab): void {
      const handle = tab.large.handle;
      byHandle.delete(handle);
      internalsOf.delete(tab);
      if (tab === current) {
        activate(null);
      }
      void api.large.close(handle).catch(() => undefined);
    }

    // ---------- Activation and events ----------

    function activate(tab: CodePadLargeTextTab | null): void {
      current = tab;
      deps.editorHost.classList.toggle('large', tab !== null);
      track.hidden = tab === null;
      largeKey.set(tab !== null);
      applyOptions();
      if (tab !== null) {
        editorOf().layout();
        applyReveal(tab);
        updateThumb();
      }
      updateStatusItems();
    }

    function modeChanged(tab: CodePadTab): void {
      if (isLarge(tab) && tab === current) {
        applyOptions();
        announceReadOnly(tab);
        updateStatusItems();
      }
    }

    async function locateFirstLine(tab: CodePadLargeTextTab): Promise<void> {
      const state = stateOf(tab);
      const large = tab.large;
      if (large.view.firstLineExact || state.locating || large.index.bytes <= large.view.byteStart) {
        return;
      }
      const windowId = large.view.windowId;
      state.locating = true;
      try {
        const located = await api.large.locate(large.handle, windowId, 1);
        if (located.ok && located.exact && tab.large.view.windowId === windowId) {
          tab.large.view.firstLine = located.line;
          tab.large.view.firstLineExact = true;
          if (tab === current) {
            applyOptions();
            deps.refreshStatus();
          }
        }
      } catch {
        // The labels stay estimates; the next index event tries again.
      } finally {
        state.locating = false;
      }
    }

    const PROGRESS_TEXT: Record<JobKind, (percent: number) => string> = {
      find: (percent) => `Searching… ${percent}% (Esc to cancel)`,
      count: (percent) => `Counting… ${percent}%`,
      save: (percent) => `Saving… ${percent}%`,
      line: (percent) => `Locating line… ${percent}% (Esc to cancel)`,
    };

    function onLargeEvent(event: CpLargeEvent): void {
      const tab = byHandle.get(event.handle);
      if (!tab) {
        return;
      }
      const state = stateOf(tab);
      switch (event.type) {
        case 'index':
          tab.large.index = {
            bytes: event.bytes,
            lines: event.lines,
            done: event.done,
            totalLines: event.totalLines,
            estimatedLines: event.estimatedLines,
          };
          if (tab === current) {
            updateStatusItems();
          }
          void locateFirstLine(tab);
          break;
        case 'progress':
          if (state.job !== null && state.job.reqId === event.reqId) {
            if (state.job.kind === 'count') {
              state.onCount?.(event.permille);
            } else if (tab === current) {
              deps.setStatus(PROGRESS_TEXT[state.job.kind](Math.round(event.permille / 10)));
              state.progressShown = true;
            }
          }
          break;
        case 'disk':
          void applyDisk(tab, event.kind, event.size, event.mtimeMs);
          break;
        case 'closed':
          sessionEnded(tab, `closed: ${event.code}`);
          break;
      }
    }

    api.large.onEvent(onLargeEvent);

    document.addEventListener(
      'keydown',
      (event) => {
        const tab = current;
        if (event.key !== 'Escape' || tab === null) {
          return;
        }
        const job = stateOf(tab).job;
        if (job !== null && job.kind !== 'save') {
          cancelJob(tab);
        }
      },
      true,
    );

    // ---------- Editor wiring ----------

    const editor = editorOf();
    const largeKey = editor.createContextKey<boolean>('cpLargeTab', false);
    const whenLarge = 'cpLargeTab && editorTextFocus';
    const { KeyMod, KeyCode } = monaco;
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => runOnCurrent((tab) => undoRedo(tab, 'undo')), whenLarge);
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => runOnCurrent((tab) => undoRedo(tab, 'redo')), whenLarge);
    editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => runOnCurrent((tab) => undoRedo(tab, 'redo')), whenLarge);
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.Home, () => runOnCurrent(goToStart), whenLarge);
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.End, () => runOnCurrent(goToEnd), whenLarge);

    editor.onDidScrollChange(() => {
      if (frame !== 0 || current === null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        const tab = current;
        if (tab !== null) {
          updateThumb();
          checkPaging(tab);
        }
      });
    });
    editor.onDidLayoutChange(() => updateThumb());

    const largeApi: CodePadLargeApi = Object.freeze({
      isLarge,
      notAvailable: (tab: CodePadLargeTextTab, what: string): void => {
        deps.setStatus(`${what} is not available for large files (${formatBytes(tab.large.size)}).`);
      },
      windowText,
      goTo,
      find,
      count,
      cancel: cancelJob,
      refresh,
      openWindowAsUntitled,
    });

    return Object.freeze({
      api: largeApi,
      open: (filePath: string, options?: { encoding?: string | null }) => api.large.open(filePath, options),
      createState,
      initTab,
      modelChanged,
      activate,
      commit: (tab: CodePadLargeTextTab) => exclusive(tab, 'commit', () => commitNow(tab)),
      applyOptions,
      modeChanged,
      save,
      saveAs,
      reload,
      close,
      position,
      restorePosition,
      goToLine,
      promptGoToLine,
      promptGoToPercent,
      positionLabel,
    });
  }

  window.CodePadLargeTabs = Object.freeze({ create });
})();
