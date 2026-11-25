/*
 * Edit overlay of the large-file mode: the edits of a document that is never loaded as a whole. They are kept as
 * sorted, disjoint replacements of ORIGINAL byte ranges, with undo and redo transactions, line/byte delta bookkeeping and
 * the plan that streams the edited document into a new file (copy original ranges, write replacement texts).
 * No Node API, no DOM: the same file is a Node module (main, tests) and a renderer <script> (window.CodePadEditOverlay).
 * Types in types/large-core.d.ts.
 */
(function (root: { CodePadEditOverlay?: CodePadEditOverlayApi }, factory: () => CodePadEditOverlayApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadEditOverlay = factory();
  }
})(globalThis, () => {
  const DEFAULT_MAX_LIVE_CHARS = 67108864;
  const DEFAULT_MAX_UNDO_CHARS = 67108864;
  const DEFAULT_MAX_UNDO_STEPS = 500;
  /** Upper bound of the doubling search of an original line (2^52). */
  const MAX_SEARCH_LINE = 4503599627370496;

  const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

  /** The items as a mutable array (only this module changes them). */
  const list = (o: CpOverlay): CpOverlayReplacement[] => o.items as CpOverlayReplacement[];

  function countNewLines(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) {
        count += 1;
      }
    }
    return count;
  }

  function textLength(items: readonly CpOverlayReplacement[]): number {
    let total = 0;
    for (const item of items) {
      total += item.text.length;
    }
    return total;
  }

  function transactionChars(tx: CpOverlayTransaction): number {
    return textLength(tx.removed) + textLength(tx.added);
  }

  /** Index of the first item with start >= `start`. */
  function lowerBoundStart(items: readonly CpOverlayReplacement[], start: number): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (items[mid].start < start) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Index where `item` belongs in the order (start, end). */
  function insertIndex(items: readonly CpOverlayReplacement[], item: CpOverlayReplacement): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const other = items[mid];
      if (other.start < item.start || (other.start === item.start && other.end < item.end)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Index of this very item object, or -1. */
  function indexOfItem(items: readonly CpOverlayReplacement[], item: CpOverlayReplacement): number {
    for (let i = lowerBoundStart(items, item.start); i < items.length && items[i].start === item.start; i += 1) {
      if (items[i] === item) {
        return i;
      }
    }
    return -1;
  }

  /** Removes `take` (contiguous) and inserts `put` in its place. */
  function swapItems(o: CpOverlay, take: readonly CpOverlayReplacement[], put: readonly CpOverlayReplacement[]): void {
    const items = list(o);
    if (take.length > 0) {
      const index = indexOfItem(items, take[0]);
      if (index < 0 || index + take.length > items.length) {
        throw new Error('The edit overlay is inconsistent.');
      }
      items.splice(index, take.length, ...put);
    } else if (put.length > 0) {
      items.splice(insertIndex(items, put[0]), 0, ...put);
    }
    o.liveChars += textLength(put) - textLength(take);
  }

  function create(limits?: CpOverlayLimits): CpOverlay {
    return {
      items: [],
      limits: {
        maxLiveChars: Math.max(1, Math.floor(limits?.maxLiveChars ?? DEFAULT_MAX_LIVE_CHARS)),
        maxUndoChars: Math.max(1, Math.floor(limits?.maxUndoChars ?? DEFAULT_MAX_UNDO_CHARS)),
        maxUndoSteps: Math.max(1, Math.floor(limits?.maxUndoSteps ?? DEFAULT_MAX_UNDO_STEPS)),
      },
      revision: 0,
      savedRevision: 0,
      liveChars: 0,
      undoChars: 0,
      undoStack: [],
      redoStack: [],
    };
  }

  function apply(o: CpOverlay, change: CpOverlayChange): CpOverlayApplyResult {
    const { start, end, text, bytes, origLines } = change;
    if (!isCount(start) || !isCount(end) || start > end || !isCount(bytes) || !isCount(origLines) || typeof text !== 'string') {
      return { ok: false, code: 'invalid' };
    }
    const items = list(o);
    const first = lowerBoundStart(items, start);
    if (first > 0 && items[first - 1].end > start) {
      return { ok: false, code: 'invalid' };
    }
    let last = first;
    while (last < items.length && items[last].start <= end) {
      const item = items[last];
      if (item.end > end) {
        if (item.start < end) {
          return { ok: false, code: 'invalid' };
        }
        break;
      }
      last += 1;
    }
    const removed = items.slice(first, last);
    const nothing = text.length === 0 && start === end;
    if (nothing && removed.length === 0) {
      return { ok: false, code: 'invalid' };
    }
    const nextLive = o.liveChars - textLength(removed) + text.length;
    if (nextLive > o.limits.maxLiveChars) {
      return { ok: false, code: 'tooLarge' };
    }
    const added: CpOverlayReplacement[] = nothing ? [] : [{ start, end, text, bytes, origLines, newLines: countNewLines(text) }];
    items.splice(first, last - first, ...added);
    o.liveChars = nextLive;
    for (const dropped of o.redoStack) {
      o.undoChars -= transactionChars(dropped);
    }
    o.redoStack.length = 0;
    const transaction: CpOverlayTransaction = { removed, added, at: start };
    o.undoStack.push(transaction);
    o.undoChars += transactionChars(transaction);
    while (o.undoStack.length > 1 && (o.undoStack.length > o.limits.maxUndoSteps || o.undoChars > o.limits.maxUndoChars)) {
      const oldest = o.undoStack.shift();
      if (oldest) {
        o.undoChars -= transactionChars(oldest);
      }
    }
    o.revision += 1;
    return { ok: true, transaction };
  }

  function undo(o: CpOverlay): CpOverlayTransaction | null {
    const transaction = o.undoStack.pop();
    if (!transaction) {
      return null;
    }
    swapItems(o, transaction.added, transaction.removed);
    o.redoStack.push(transaction);
    o.revision -= 1;
    return transaction;
  }

  function redo(o: CpOverlay): CpOverlayTransaction | null {
    const transaction = o.redoStack.pop();
    if (!transaction) {
      return null;
    }
    swapItems(o, transaction.removed, transaction.added);
    o.undoStack.push(transaction);
    o.revision += 1;
    return transaction;
  }

  function isDirty(o: CpOverlay): boolean {
    return o.revision !== o.savedRevision;
  }

  function markSaved(o: CpOverlay): void {
    list(o).length = 0;
    o.undoStack.length = 0;
    o.redoStack.length = 0;
    o.liveChars = 0;
    o.undoChars = 0;
    o.savedRevision = o.revision;
  }

  function within(o: CpOverlay, start: number, end: number): CpOverlayReplacement[] {
    return o.items.filter((item) => (item.start === item.end ? item.start >= start && item.start <= end : item.start < end && item.end > start));
  }

  function snap(o: CpOverlay, start: number, end: number): { start: number; end: number } {
    const items = o.items;
    let from = start;
    let to = end;
    const afterStart = lowerBoundStart(items, start);
    if (afterStart > 0 && items[afterStart - 1].end > start) {
      from = items[afterStart - 1].start;
    }
    const beforeEnd = lowerBoundStart(items, end) - 1;
    if (beforeEnd >= 0 && items[beforeEnd].start < end && items[beforeEnd].end > end) {
      to = items[beforeEnd].end;
    }
    return { start: from, end: to };
  }

  function lineDeltaBefore(o: CpOverlay, byte: number): number {
    let total = 0;
    for (const item of o.items) {
      if (item.end > byte) {
        break;
      }
      total += item.newLines - item.origLines;
    }
    return total;
  }

  function byteDeltaBefore(o: CpOverlay, byte: number): number {
    let total = 0;
    for (const item of o.items) {
      if (item.end > byte) {
        break;
      }
      total += item.bytes - (item.end - item.start);
    }
    return total;
  }

  /** Original line containing `byte` (the greatest line whose start is <= byte), or null when nothing is scanned. */
  function lineOfByte(byte: number, origLineStart: (origLine: number) => number | null): number | null {
    const firstStart = origLineStart(1);
    if (firstStart === null) {
      return null;
    }
    if (byte < firstStart) {
      return 1;
    }
    let known = 1;
    let unknown = 2;
    while (unknown <= MAX_SEARCH_LINE) {
      const start = origLineStart(unknown);
      if (start === null || start > byte) {
        break;
      }
      known = unknown;
      unknown *= 2;
    }
    while (unknown - known > 1) {
      const mid = Math.floor((known + unknown) / 2);
      const start = origLineStart(mid);
      if (start !== null && start <= byte) {
        known = mid;
      } else {
        unknown = mid;
      }
    }
    return known;
  }

  function docLineToAnchor(o: CpOverlay, line: number, origLineStart: (origLine: number) => number | null): CpLargeAnchor | null {
    if (!Number.isSafeInteger(line) || line < 1) {
      return null;
    }
    const items = o.items;
    // prefix[i] = line delta of the items before item i.
    const prefix: number[] = [0];
    for (const item of items) {
      prefix.push(prefix[prefix.length - 1] + item.newLines - item.origLines);
    }
    const textStartLine = (index: number): number => {
      const origLine = lineOfByte(items[index].start, origLineStart);
      return origLine === null ? Infinity : origLine + prefix[index];
    };
    // The last item whose text starts on a doc line before `line`.
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (textStartLine(mid) < line) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const found = low - 1;
    if (found >= 0) {
      const startLine = textStartLine(found);
      if (line <= startLine + items[found].newLines) {
        return { byte: items[found].start, sub: line - startLine };
      }
    }
    const origLine = line - prefix[found + 1];
    if (origLine < 1) {
      return null;
    }
    const byte = origLineStart(origLine);
    return byte === null ? null : { byte, sub: 0 };
  }

  function savePlan(o: CpOverlay, size: number): CpSaveStep[] {
    const steps: CpSaveStep[] = [];
    let position = 0;
    for (const item of o.items) {
      if (item.start > size) {
        break;
      }
      if (item.start > position) {
        steps.push({ copy: [position, item.start] });
      }
      if (item.text.length > 0) {
        steps.push({ text: item.text });
      }
      position = Math.min(Math.max(position, item.end), size);
    }
    if (position < size) {
      steps.push({ copy: [position, size] });
    }
    return steps;
  }

  function edits(o: CpOverlay): CpOverlayEdit[] {
    return o.items.map((item) => ({ start: item.start, end: item.end, byteDelta: item.bytes - (item.end - item.start), lineDelta: item.newLines - item.origLines }));
  }

  return { create, apply, undo, redo, isDirty, markSaved, within, snap, lineDeltaBefore, byteDeltaBefore, docLineToAnchor, savePlan, edits };
});
