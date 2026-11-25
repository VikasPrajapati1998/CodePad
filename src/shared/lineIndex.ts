/*
 * Sparse line index of the large-file mode. A scan feeds file chunks to `scanChunk`; the index keeps counts and a
 * sparse list of (line, byte) checkpoints, so any line is found by scanning at most `every` lines or about
 * `maxGapBytes` from a checkpoint. A line break is LF, CRLF or a CR that is not followed by LF. UTF-16 is supported
 * (unit 2, even offsets relative to the BOM).
 * No Node API, no DOM: the same file is a Node module (worker thread, main, tests) and a renderer <script>
 * (window.CodePadLineIndex). Types in types/large-core.d.ts.
 */
(function (root: { CodePadLineIndex?: CodePadLineIndexApi }, factory: () => CodePadLineIndexApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadLineIndex = factory();
  }
})(globalThis, () => {
  const LF = 0x0a;
  const CR = 0x0d;
  const DEFAULT_EVERY = 1000;
  const DEFAULT_MAX_GAP_BYTES = 1048576;
  const DEFAULT_MAX_ENTRIES = 2000000;
  const INITIAL_PAIRS = 1024;
  /** Line breaks per byte assumed before anything was scanned. */
  const DEFAULT_DENSITY = 1 / 80;

  /** State of the break scanner that spans pieces: the last consumed unit was a CR whose break is still open. */
  interface WalkState {
    cr: boolean;
  }
  /** Receives every resolved break with the offset (in the scanned buffer) of the line start it opens. */
  type BreakSink = (kind: CpEolKind, lineStart: number) => void;

  const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

  /** Value of the unit at `pos` (both bytes must exist). */
  function unitAt(bytes: Uint8Array, pos: number, unit: CpLargeUnit, bigEndian: boolean): number {
    if (unit === 1) {
      return bytes[pos];
    }
    return bigEndian ? (bytes[pos] << 8) | bytes[pos + 1] : (bytes[pos + 1] << 8) | bytes[pos];
  }

  /**
   * Offset of the next unit equal to `target` (LF or CR) at or after `from`, aligned to `origin`, below `limit`.
   * @returns The offset, or `limit` when there is none.
   */
  function findBreak(bytes: Uint8Array, target: number, from: number, origin: number, limit: number, unit: CpLargeUnit, bigEndian: boolean): number {
    let at = from;
    while (at < limit) {
      if (unit === 1) {
        const found = bytes.indexOf(target, at);
        return found < 0 || found >= limit ? limit : found;
      }
      if (bigEndian) {
        // The unit is [0x00, target]: look for the low byte and check the high byte before it.
        const found = bytes.indexOf(target, at + 1);
        if (found < 0 || found >= limit) {
          return limit;
        }
        const start = found - 1;
        if (((start - origin) & 1) === 0 && bytes[start] === 0) {
          return start;
        }
        at = found;
      } else {
        const found = bytes.indexOf(target, at);
        if (found < 0 || found >= limit) {
          return limit;
        }
        if (((found - origin) & 1) === 0 && bytes[found + 1] === 0) {
          return found;
        }
        at = found + 1;
      }
    }
    return limit;
  }

  /**
   * Scans the whole units of `bytes` from `from` and reports every break that gets resolved. A CR is resolved by the unit
   * after it, so a trailing CR stays open in `state`.
   * @returns The offset after the last consumed unit (a trailing odd byte is left).
   */
  function walk(bytes: Uint8Array, from: number, unit: CpLargeUnit, bigEndian: boolean, state: WalkState, emit: BreakSink): number {
    const total = bytes.length;
    const limit = unit === 2 ? from + (((Math.max(0, total - from)) >> 1) << 1) : total;
    let pos = from;
    let lf = -1;
    let cr = -1;
    while (pos < limit) {
      if (state.cr) {
        state.cr = false;
        if (unitAt(bytes, pos, unit, bigEndian) === LF) {
          pos += unit;
          emit('crlf', pos);
        } else {
          emit('cr', pos);
        }
        continue;
      }
      if (lf < pos) {
        lf = findBreak(bytes, LF, pos, from, limit, unit, bigEndian);
      }
      if (cr < pos) {
        cr = findBreak(bytes, CR, pos, from, limit, unit, bigEndian);
      }
      const next = Math.min(lf, cr);
      if (next >= limit) {
        pos = limit;
        break;
      }
      pos = next + unit;
      if (next === lf) {
        emit('lf', pos);
      } else {
        state.cr = true;
      }
    }
    return pos;
  }

  /** Drops every second checkpoint (the first one stays) and doubles the step. */
  function decimate(index: CpLineIndex): void {
    const kept = Math.ceil(index.count / 2);
    for (let i = 0; i < kept; i += 1) {
      index.entries[2 * i] = index.entries[4 * i];
      index.entries[2 * i + 1] = index.entries[4 * i + 1];
    }
    index.count = kept;
    index.every *= 2;
  }

  function pushEntry(index: CpLineIndex, line: number, byte: number): void {
    if (index.count >= index.options.maxEntries) {
      decimate(index);
    }
    const needed = (index.count + 1) * 2;
    if (needed > index.entries.length) {
      const grown = new Float64Array(Math.min(Math.max(index.entries.length * 2, needed), index.options.maxEntries * 2));
      grown.set(index.entries.subarray(0, index.count * 2));
      index.entries = grown;
    }
    index.entries[index.count * 2] = line;
    index.entries[index.count * 2 + 1] = byte;
    index.count += 1;
  }

  /** Counts a resolved break and stores a checkpoint for the new line when the step or the byte gap asks for it. */
  function recordBreak(index: CpLineIndex, kind: CpEolKind, lineStart: number): void {
    index.eolCounts[kind] += 1;
    index.lines += 1;
    const line = index.lines + 1;
    const lastByte = index.entries[(index.count - 1) * 2 + 1];
    if (line % index.every === 0 || lineStart - lastByte >= index.options.maxGapBytes) {
      pushEntry(index, line, lineStart);
    }
  }

  function create(options: CpLineIndexOptions): CpLineIndex {
    const normalized: Required<CpLineIndexOptions> = {
      unit: options.unit,
      bigEndian: options.bigEndian,
      startByte: options.startByte,
      every: options.every ?? DEFAULT_EVERY,
      maxGapBytes: options.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    };
    if ((normalized.unit as number) !== 1 && (normalized.unit as number) !== 2) {
      throw new Error('The line index unit must be 1 or 2.');
    }
    if (!isCount(normalized.startByte) || !Number.isSafeInteger(normalized.every) || normalized.every < 1) {
      throw new Error('Invalid line index start or step.');
    }
    if (!Number.isSafeInteger(normalized.maxGapBytes) || normalized.maxGapBytes < 1 || !Number.isSafeInteger(normalized.maxEntries) || normalized.maxEntries < 2) {
      throw new Error('Invalid line index limits.');
    }
    const entries = new Float64Array(2 * Math.min(INITIAL_PAIRS, normalized.maxEntries));
    entries[0] = 1;
    entries[1] = normalized.startByte;
    return {
      options: normalized,
      scannedBytes: normalized.startByte,
      lines: 0,
      pendingCr: false,
      pendingOdd: -1,
      eolCounts: { lf: 0, crlf: 0, cr: 0 },
      done: false,
      every: normalized.every,
      entries,
      count: 1,
    };
  }

  function scanChunk(index: CpLineIndex, chunk: Uint8Array, at: number): void {
    if (index.done) {
      throw new Error('The line index is already finished.');
    }
    const { unit, bigEndian } = index.options;
    const carried = index.pendingOdd >= 0;
    const expected = index.scannedBytes + (carried ? 1 : 0);
    if (at !== expected) {
      throw new Error(`The line index expected bytes at ${expected} but got ${at}.`);
    }
    const state: WalkState = { cr: index.pendingCr };
    let base = at;
    const emit: BreakSink = (kind, lineStart) => recordBreak(index, kind, base + lineStart);
    let from = 0;
    if (carried) {
      if (chunk.length === 0) {
        return;
      }
      base = at - 1;
      walk(new Uint8Array([index.pendingOdd, chunk[0]]), 0, unit, bigEndian, state, emit);
      base = at;
      from = 1;
      index.pendingOdd = -1;
    }
    const end = walk(chunk, from, unit, bigEndian, state, emit);
    index.pendingCr = state.cr;
    index.scannedBytes = at + end;
    if (unit === 2 && end < chunk.length) {
      index.pendingOdd = chunk[end];
    }
  }

  function finish(index: CpLineIndex, size: number): void {
    if (index.done) {
      return;
    }
    if (index.pendingCr) {
      // Provisional: `pendingCr` stays true so `resume` can take the lone CR back when an LF is appended.
      recordBreak(index, 'cr', index.scannedBytes);
    }
    if (index.pendingOdd < 0 && size > index.scannedBytes) {
      index.scannedBytes = size;
    }
    index.done = true;
  }

  function resume(index: CpLineIndex): void {
    if (!index.done) {
      return;
    }
    if (index.pendingCr) {
      const line = index.lines + 1;
      index.eolCounts.cr -= 1;
      index.lines -= 1;
      const last = (index.count - 1) * 2;
      if (index.count > 1 && index.entries[last] === line && index.entries[last + 1] === index.scannedBytes) {
        index.count -= 1;
      }
    }
    index.done = false;
  }

  function checkpointAtByte(index: CpLineIndex, byte: number): CpLineHit {
    let low = 0;
    let high = index.count - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (index.entries[mid * 2 + 1] <= byte) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: index.entries[low * 2], byte: index.entries[low * 2 + 1] };
  }

  function checkpointForLine(index: CpLineIndex, line: number): CpLineHit | null {
    if (!Number.isFinite(line) || line < 1 || line > index.lines + 1) {
      return null;
    }
    let low = 0;
    let high = index.count - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (index.entries[mid * 2] <= line) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: index.entries[low * 2], byte: index.entries[low * 2 + 1] };
  }

  function countBreaks(bytes: Uint8Array, unit: CpLargeUnit, bigEndian: boolean, startCr: boolean): { breaks: number; endsWithCr: boolean } {
    const state: WalkState = { cr: startCr };
    let breaks = 0;
    walk(bytes, 0, unit, bigEndian, state, () => {
      breaks += 1;
    });
    return { breaks, endsWithCr: state.cr };
  }

  function nextLineStart(bytes: Uint8Array, from: number, unit: CpLargeUnit, bigEndian: boolean): number {
    const limit = unit === 2 ? bytes.length & ~1 : bytes.length;
    const pos = unit === 2 ? (Math.max(0, from) + 1) & ~1 : Math.max(0, from);
    if (pos >= limit) {
      return -1;
    }
    const lf = findBreak(bytes, LF, pos, 0, limit, unit, bigEndian);
    const cr = findBreak(bytes, CR, pos, 0, limit, unit, bigEndian);
    const next = Math.min(lf, cr);
    if (next >= limit) {
      return -1;
    }
    if (next === lf) {
      return next + unit;
    }
    if (next + unit >= limit) {
      // A CR at the very end: it is not known whether an LF follows.
      return -1;
    }
    return unitAt(bytes, next + unit, unit, bigEndian) === LF ? next + 2 * unit : next + unit;
  }

  function prevLineStart(bytes: Uint8Array, from: number, unit: CpLargeUnit, bigEndian: boolean): number {
    const limit = unit === 2 ? bytes.length & ~1 : bytes.length;
    let pos = Math.min(Math.floor(from), limit);
    if (unit === 2) {
      pos &= ~1;
    }
    while (pos > 0) {
      const before = unitAt(bytes, pos - unit, unit, bigEndian);
      if (before === LF) {
        return pos;
      }
      if (before === CR && pos < limit && unitAt(bytes, pos, unit, bigEndian) !== LF) {
        return pos;
      }
      pos -= unit;
    }
    return -1;
  }

  function safeBoundary(bytes: Uint8Array, pos: number, kind: 'utf8' | 'utf16le' | 'utf16be' | 'single'): number {
    const length = bytes.length;
    let position = Math.min(Math.max(Math.floor(pos), 0), length);
    if (kind === 'single') {
      return position;
    }
    if (kind === 'utf8') {
      let steps = 0;
      while (position > 0 && position < length && (bytes[position] & 0xc0) === 0x80 && steps < 3) {
        position -= 1;
        steps += 1;
      }
      return position;
    }
    position &= ~1;
    if (position >= 2 && position + 1 < length) {
      const high = kind === 'utf16le' ? bytes[position + 1] : bytes[position];
      if (high >= 0xdc && high <= 0xdf) {
        position -= 2;
      }
    }
    return position;
  }

  function splitLines(bytes: Uint8Array, unit: CpLargeUnit, bigEndian: boolean): { starts: number[]; eolLens: number[] } {
    const starts: number[] = [0];
    const eolLens: number[] = [];
    const state: WalkState = { cr: false };
    const end = walk(bytes, 0, unit, bigEndian, state, (kind, lineStart) => {
      starts.push(lineStart);
      eolLens.push(kind === 'crlf' ? 2 * unit : unit);
    });
    if (state.cr) {
      // A CR at the end of the buffer is taken as a lone CR.
      starts.push(end);
      eolLens.push(unit);
    }
    eolLens.push(0);
    return { starts, eolLens };
  }

  function dominantEol(index: CpLineIndex): CpEolKind {
    const { lf, crlf, cr } = index.eolCounts;
    if (lf + crlf === 0) {
      return cr > 0 ? 'cr' : 'lf';
    }
    return crlf > lf ? 'crlf' : 'lf';
  }

  function estimateLine(index: CpLineIndex, byte: number): number {
    const span = index.scannedBytes - index.options.startByte;
    const density = span > 0 ? index.lines / span : DEFAULT_DENSITY;
    if (byte <= index.scannedBytes) {
      const hit = checkpointAtByte(index, byte);
      return Math.max(1, hit.line + Math.floor(Math.max(0, byte - hit.byte) * density));
    }
    return Math.max(1, index.lines + 1 + Math.floor((byte - index.scannedBytes) * density));
  }

  function rebase(index: CpLineIndex, edits: readonly CpOverlayEdit[]): CpLineIndex {
    const { unit, startByte } = index.options;
    const scanned = index.scannedBytes;
    const tail = index.pendingCr ? unit : 0;
    const odd = index.pendingOdd >= 0 ? 1 : 0;
    const touches = edits.some((edit) => edit.start < scanned + odd && edit.end > scanned - tail);
    const truncate = !index.done && touches;

    // A checkpoint stays when it is at or before an edit's start (unchanged) or after its end (shifted).
    const kept: number[] = [];
    let lineShift = 0;
    let byteShift = 0;
    let next = 0;
    let lastKeptByte = startByte;
    for (let i = 0; i < index.count; i += 1) {
      const line = index.entries[2 * i];
      const byte = index.entries[2 * i + 1];
      while (next < edits.length && edits[next].end < byte) {
        lineShift += edits[next].lineDelta;
        byteShift += edits[next].byteDelta;
        next += 1;
      }
      if (next < edits.length && edits[next].start < byte) {
        continue;
      }
      kept.push(line + lineShift, byte + byteShift);
      lastKeptByte = byte;
    }

    const entries = new Float64Array(Math.max(2, kept.length));
    entries.set(kept);
    const count = kept.length / 2;
    const eolCounts: Record<CpEolKind, number> = { ...index.eolCounts };

    if (truncate) {
      // The scan boundary lies inside a replaced range: restart from the last kept checkpoint.
      const ratio = scanned > startByte ? (lastKeptByte - startByte) / (scanned - startByte) : 0;
      eolCounts.lf = Math.round(eolCounts.lf * ratio);
      eolCounts.crlf = Math.round(eolCounts.crlf * ratio);
      eolCounts.cr = Math.round(eolCounts.cr * ratio);
      return {
        options: index.options,
        scannedBytes: kept[kept.length - 1],
        lines: kept[kept.length - 2] - 1,
        pendingCr: false,
        pendingOdd: -1,
        eolCounts,
        done: false,
        every: index.every,
        entries,
        count,
      };
    }

    let byteDelta = 0;
    let lineDelta = 0;
    for (const edit of edits) {
      if (index.done || edit.start < scanned) {
        byteDelta += edit.byteDelta;
        lineDelta += edit.lineDelta;
      }
    }
    const dominant = dominantEol(index);
    eolCounts[dominant] = Math.max(0, eolCounts[dominant] + lineDelta);
    return {
      options: index.options,
      scannedBytes: scanned + byteDelta,
      lines: Math.max(0, index.lines + lineDelta),
      pendingCr: index.pendingCr && !touches,
      pendingOdd: touches ? -1 : index.pendingOdd,
      eolCounts,
      done: index.done,
      every: index.every,
      entries,
      count,
    };
  }

  return {
    create,
    scanChunk,
    finish,
    resume,
    checkpointAtByte,
    checkpointForLine,
    countBreaks,
    nextLineStart,
    prevLineStart,
    safeBoundary,
    splitLines,
    estimateLine,
    dominantEol,
    rebase,
  };
});
