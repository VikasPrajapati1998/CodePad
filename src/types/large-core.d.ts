/*
 * Types of the pure large-file core shared by the main process, the worker thread, the renderer and the tests:
 * shared/lineIndex.ts (CodePadLineIndex), shared/editOverlay.ts (CodePadEditOverlay) and shared/largeWindow.ts
 * (CodePadLargeWindow). All byte offsets are absolute offsets into the ORIGINAL file; character offsets are UTF-16
 * offsets into a window text with '\n' breaks. Nothing here is a module.
 */

type CpLargeUnit = 1 | 2;
/** 'lineStart' for the line-synchronous multibyte encodings (decoding may only start at a line start). */
type CpLargeSeek = 'char' | 'lineStart';
type CpLargeReadOnlyReason = 'longLine' | 'truncatedLine' | 'invalidBytes';
type CpEolKind = 'lf' | 'crlf' | 'cr';
/** A doc position main can always resolve: an original line-start byte, or a replacement start plus a line offset in it. */
interface CpLargeAnchor {
  byte: number;
  sub: number;
}

/* ---------------------------------------------------------------- line index */

interface CpLineIndexOptions {
  unit: CpLargeUnit;
  /** UTF-16 BE only. */
  bigEndian: boolean;
  /** BOM length. */
  startByte: number;
  /** Checkpoint every N lines (default 1000). */
  every?: number;
  /** Checkpoint when this many bytes passed since the last one (default 1 MiB). */
  maxGapBytes?: number;
  /** Maximum number of checkpoints before decimation (default 2,000,000). */
  maxEntries?: number;
}

interface CpLineIndex {
  readonly options: Required<CpLineIndexOptions>;
  /** Absolute byte up to which lines are counted (a pending CR is consumed, a carried odd byte is not). */
  scannedBytes: number;
  /** Complete line breaks seen (line count so far = lines + 1). */
  lines: number;
  /** The last consumed unit is a CR whose break is not yet counted (after `finish`: counted provisionally as a lone CR). */
  pendingCr: boolean;
  /** -1 or the carried odd byte (UTF-16). */
  pendingOdd: number;
  eolCounts: Record<CpEolKind, number>;
  done: boolean;
  /** Current checkpoint step in lines (doubles on decimation). */
  every: number;
  /** [line0, byte0, line1, byte1, ...]; line is 1-based and byte is the start of that line. Only `count` pairs are valid. */
  entries: Float64Array;
  count: number;
}

interface CpLineHit {
  line: number;
  byte: number;
}

/** One replacement of an original byte range as the line index sees it (see CpOverlayReplacement). */
interface CpOverlayEdit {
  start: number;
  end: number;
  /** bytes - (end - start) */
  byteDelta: number;
  /** newLines - origLines */
  lineDelta: number;
}

interface CodePadLineIndexApi {
  create(options: CpLineIndexOptions): CpLineIndex;
  /**
   * Feeds bytes that start at absolute offset `at` (must equal index.scannedBytes plus the carried odd byte, if any).
   * @throws {Error} When `at` does not continue the scan or the index is finished.
   */
  scanChunk(index: CpLineIndex, chunk: Uint8Array, at: number): void;
  /** Marks the end of the file at `size`; a pending CR is counted as a lone CR (provisionally, `resume` takes it back). */
  finish(index: CpLineIndex, size: number): void;
  /** Re-opens a finished index so appended bytes can be scanned (growing logs). */
  resume(index: CpLineIndex): void;
  /** Greatest checkpoint with byte <= `byte` (the first checkpoint when `byte` is before it). */
  checkpointAtByte(index: CpLineIndex, byte: number): CpLineHit;
  /** Greatest checkpoint with line <= `line`; null when `line` is below 1 or beyond the scanned range. */
  checkpointForLine(index: CpLineIndex, line: number): CpLineHit | null;
  /**
   * Line breaks in `bytes` (which starts at a line start or follows `startCr`). A CRLF counts once; a CR at the very end
   * is NOT counted (`endsWithCr`): pass `endsWithCr` as `startCr` of the next piece, or add 1 when the piece ends at the
   * wanted line start.
   */
  countBreaks(bytes: Uint8Array, unit: CpLargeUnit, bigEndian: boolean, startCr: boolean): { breaks: number; endsWithCr: boolean };
  /** Offset of the first line start strictly after `from` in `bytes`, or -1 (also when the buffer ends with a CR). CRLF is never split. */
  nextLineStart(bytes: Uint8Array, from: number, unit: CpLargeUnit, bigEndian: boolean): number;
  /** Offset (> 0) of the line start at or before `from` (scans backward), or -1 when none in `bytes`. */
  prevLineStart(bytes: Uint8Array, from: number, unit: CpLargeUnit, bigEndian: boolean): number;
  /** Nearest offset <= `pos` where decoding may start ('utf8' | 'utf16le' | 'utf16be' | 'single'). */
  safeBoundary(bytes: Uint8Array, pos: number, kind: 'utf8' | 'utf16le' | 'utf16be' | 'single'): number;
  /** Line starts and EOL lengths (bytes) of a buffer; `starts[0] === 0`, both arrays have one entry per line, the last EOL length is 0. */
  splitLines(bytes: Uint8Array, unit: CpLargeUnit, bigEndian: boolean): { starts: number[]; eolLens: number[] };
  /** Estimated line number (>= 1) of a byte: checkpoint plus density extrapolation. */
  estimateLine(index: CpLineIndex, byte: number): number;
  /** 'cr' only when no LF or CRLF exists; otherwise 'crlf' when it outnumbers 'lf'; 'lf' when there are no breaks. */
  dominantEol(index: CpLineIndex): CpEolKind;
  /**
   * New index for the file written by a save: checkpoints shifted by the overlay's byte/line deltas, those inside
   * replaced ranges dropped. A scan that is still running and is cut by an edit restarts from the last kept checkpoint
   * (`done` false, `scannedBytes` at that checkpoint). EOL counts are adjusted on a best-effort basis (the line delta goes to
   * the dominant kind).
   */
  rebase(index: CpLineIndex, edits: readonly CpOverlayEdit[]): CpLineIndex;
}

/* ---------------------------------------------------------------- edit overlay */

interface CpOverlayReplacement {
  /** Original byte range [start, end) that is replaced. */
  start: number;
  end: number;
  /** New text with '\n' breaks. */
  text: string;
  /** Encoded length of `text` in bytes (without BOM). */
  bytes: number;
  /** Line breaks in the original range. */
  origLines: number;
  /** '\n' count of `text`. */
  newLines: number;
}

interface CpOverlayTransaction {
  removed: CpOverlayReplacement[];
  added: CpOverlayReplacement[];
  /** Original byte where the change starts. */
  at: number;
}

interface CpOverlayLimits {
  /** UTF-16 units of live replacement text (default 64M). */
  maxLiveChars?: number;
  /** UTF-16 units kept in the undo and redo stacks (default 64M). */
  maxUndoChars?: number;
  /** Undo steps (default 500). */
  maxUndoSteps?: number;
}

interface CpOverlay {
  /** Sorted by start, disjoint (end <= next.start). */
  readonly items: readonly CpOverlayReplacement[];
  readonly limits: Required<CpOverlayLimits>;
  /** History position: +1 per applied or redone transaction, -1 per undone one. */
  revision: number;
  savedRevision: number;
  liveChars: number;
  undoChars: number;
  undoStack: CpOverlayTransaction[];
  redoStack: CpOverlayTransaction[];
}

type CpSaveStep = { copy: [start: number, end: number] } | { text: string };

interface CpOverlayChange {
  start: number;
  end: number;
  text: string;
  bytes: number;
  origLines: number;
  /** Ignored: the overlay counts the '\n' of `text` itself. */
  newLines: number;
}

type CpOverlayApplyResult = { ok: true; transaction: CpOverlayTransaction } | { ok: false; code: 'tooLarge' | 'invalid' };

interface CodePadEditOverlayApi {
  create(limits?: CpOverlayLimits): CpOverlay;
  /**
   * Replaces original [start, end) by `text`. Every replacement lying inside [start, end) (both ends inclusive, so an
   * insertion at `start` or `end` is covered) is replaced too: `text` must already contain what of it should stay
   * (CodePadLargeWindow.mapChar snaps to exactly this). A range that cuts a replacement (partial overlap, nested change)
   * is `invalid`; use `snap` first. A change that changes nothing (empty range, empty text, nothing covered) is `invalid`;
   * an empty range with empty text that covers replacements just removes them. `tooLarge` when the live text would
   * exceed the limit. A successful apply clears the redo stack and drops the oldest undo steps beyond the limits (the
   * newest step is always kept).
   */
  apply(o: CpOverlay, change: CpOverlayChange): CpOverlayApplyResult;
  undo(o: CpOverlay): CpOverlayTransaction | null;
  redo(o: CpOverlay): CpOverlayTransaction | null;
  isDirty(o: CpOverlay): boolean;
  /** After a save: items cleared, stacks cleared, savedRevision = revision. */
  markSaved(o: CpOverlay): void;
  /** Replacements intersecting [start, end); a zero-length replacement counts when start <= its position <= end. */
  within(o: CpOverlay, start: number, end: number): CpOverlayReplacement[];
  /** Widens [start, end) so no replacement is cut (touching replacements are not cut). */
  snap(o: CpOverlay, start: number, end: number): { start: number; end: number };
  /** Sum of the line deltas of the replacements ending at or before `byte`. */
  lineDeltaBefore(o: CpOverlay, byte: number): number;
  /** Sum of the byte deltas of the replacements ending at or before `byte`. */
  byteDeltaBefore(o: CpOverlay, byte: number): number;
  /**
   * Doc line (1-based, edits included) -> anchor. `origLineStart(L)` is the byte of original line L or null beyond the
   * scanned range. Replacements beyond the scanned range are treated as lying on the last scanned line. null when the
   * line does not exist or is not scanned yet.
   */
  docLineToAnchor(o: CpOverlay, line: number, origLineStart: (origLine: number) => number | null): CpLargeAnchor | null;
  /** Copies and texts in file order, covering [0, size). */
  savePlan(o: CpOverlay, size: number): CpSaveStep[];
  /** For CodePadLineIndex.rebase. */
  edits(o: CpOverlay): CpOverlayEdit[];
}

/* ---------------------------------------------------------------- window helpers */

/** Original bytes shown in a window; `lineStarts` are window char offsets, `lineBytes` the matching original bytes. */
interface CpWindowOrigSegment {
  kind: 'orig';
  byteStart: number;
  byteEnd: number;
  charStart: number;
  charEnd: number;
  lineStarts: number[];
  lineBytes: number[];
}

/** A replacement shown in a window; `byteStart`/`byteEnd` are the replaced ORIGINAL range, the chars are its text. */
interface CpWindowReplSegment {
  kind: 'repl';
  /** Index of the replacement in the overlay items at the time the window was composed. */
  index: number;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

type CpWindowSegment = CpWindowOrigSegment | CpWindowReplSegment;

/** The part of a window view that line labels need (structurally satisfied by CodePadLargeWindowView). */
interface CpLargeLabelView {
  firstLine: number;
  firstLineExact: boolean;
  /** Ascending model lines (1-based) that continue the previous model line. */
  continuation: readonly number[];
}

interface CodePadLargeWindowApi {
  /** Common prefix/suffix lengths in UTF-16 units; never splits a surrogate pair or a CRLF; prefix + suffix <= both lengths. */
  diffRange(oldText: string, newText: string): { prefix: number; suffix: number };
  /** Splits a decoded line into pieces of <= segChars (2 when segChars is 1 and a surrogate pair starts there) without splitting surrogate pairs; '' gives ['']. */
  segmentLine(line: string, segChars: number): string[];
  /** Gutter label of model line n (1-based): the grouped number, '~' prefixed when inexact, '↪' for a continuation. */
  lineLabel(view: CpLargeLabelView, n: number): string;
  /** Doc line of model line n (a continuation has the doc line of the line it continues). */
  docLine(view: { firstLine: number; continuation: readonly number[] }, n: number): number;
  /** Paging decision from the visible model lines (1-based): prefetch at 35% / 65%, apply at 20% / 80% of the window. */
  shiftNeed(view: { atStart: boolean; atEnd: boolean }, lineCount: number, top: number, bottom: number): { prefetch: 'up' | 'down' | null; apply: 'up' | 'down' | null };
  /** Thumb position in px from the top of the track. */
  thumb(byte: number, size: number, trackPx: number, thumbPx: number): number;
  /** Per mille (0..1000) for a thumb position in px. */
  permilleAt(px: number, trackPx: number, thumbPx: number): number;
  /**
   * Original byte of a char offset in a served window. A char strictly inside a replacement snaps outward to the
   * replacement (start side: its start, end side: its end). A char on a boundary also snaps to every adjacent
   * replacement that is invisible on one side (zero original bytes or zero chars), so such an insertion/deletion is
   * always covered by the resulting range. `char` is the snapped char offset to cut the window texts at.
   */
  mapChar(segments: readonly CpWindowSegment[], text: string, char: number, side: 'start' | 'end', byteLength: (s: string) => number): { byte: number; char: number };
  /** '48,112,334' when exact, else '≈ 48.1M'. */
  formatCount(n: number, exact: boolean): string;
}

declare var CodePadLineIndex: CodePadLineIndexApi;
declare var CodePadEditOverlay: CodePadEditOverlayApi;
declare var CodePadLargeWindow: CodePadLargeWindowApi;
