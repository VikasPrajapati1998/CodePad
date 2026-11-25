/*
 * Window helpers of the large-file mode: diff of a committed window text, splitting of long lines, gutter labels,
 * paging thresholds, the file scrollbar math and the map from a window char offset to an original byte.
 * No Node API, no DOM: the same file is a Node module (main, tests) and a renderer <script> (window.CodePadLargeWindow).
 * Types in types/large-core.d.ts.
 */
(function (root: { CodePadLargeWindow?: CodePadLargeWindowApi }, factory: () => CodePadLargeWindowApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadLargeWindow = factory();
  }
})(globalThis, () => {
  const CONTINUATION_LABEL = '↪';
  /** Prefetch starts when the viewport is within this share (percent) of the window edge. */
  const PREFETCH_PERCENT = 35;
  /** The window is shifted when the viewport is within this share (percent) of the window edge. */
  const APPLY_PERCENT = 20;

  const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

  function diffRange(oldText: string, newText: string): { prefix: number; suffix: number } {
    const oldLength = oldText.length;
    const newLength = newText.length;
    const shortest = Math.min(oldLength, newLength);
    let prefix = 0;
    while (prefix < shortest && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
      prefix += 1;
    }
    let suffix = 0;
    const room = shortest - prefix;
    while (suffix < room && oldText.charCodeAt(oldLength - 1 - suffix) === newText.charCodeAt(newLength - 1 - suffix)) {
      suffix += 1;
    }
    if (prefix > 0) {
      const last = oldText.charCodeAt(prefix - 1);
      const nextOld = prefix < oldLength ? oldText.charCodeAt(prefix) : -1;
      const nextNew = prefix < newLength ? newText.charCodeAt(prefix) : -1;
      if ((isHigh(last) && (isLow(nextOld) || isLow(nextNew))) || (last === 13 && (nextOld === 10 || nextNew === 10))) {
        prefix -= 1;
      }
    }
    if (suffix > 0) {
      const first = oldText.charCodeAt(oldLength - suffix);
      const beforeOld = oldLength - suffix - 1 >= 0 ? oldText.charCodeAt(oldLength - suffix - 1) : -1;
      const beforeNew = newLength - suffix - 1 >= 0 ? newText.charCodeAt(newLength - suffix - 1) : -1;
      if ((isLow(first) && (isHigh(beforeOld) || isHigh(beforeNew))) || (first === 10 && (beforeOld === 13 || beforeNew === 13))) {
        suffix -= 1;
      }
    }
    return { prefix, suffix };
  }

  function segmentLine(line: string, segChars: number): string[] {
    const size = Math.max(1, Math.floor(segChars));
    if (line.length <= size) {
      return [line];
    }
    const pieces: string[] = [];
    let start = 0;
    while (start < line.length) {
      let end = Math.min(start + size, line.length);
      if (end < line.length && isHigh(line.charCodeAt(end - 1)) && isLow(line.charCodeAt(end))) {
        end = end - 1 > start ? end - 1 : end + 1;
      }
      pieces.push(line.slice(start, end));
      start = end;
    }
    return pieces;
  }

  /** Number of entries of the ascending list that are <= n. */
  function countUpTo(sorted: readonly number[], n: number): number {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid] <= n) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  function docLine(view: { firstLine: number; continuation: readonly number[] }, n: number): number {
    return view.firstLine + (n - 1) - countUpTo(view.continuation, n);
  }

  /** 48112334 -> '48,112,334'. */
  function group(value: number): string {
    const digits = String(Math.max(0, Math.floor(value)));
    let out = '';
    for (let i = 0; i < digits.length; i += 1) {
      if (i > 0 && (digits.length - i) % 3 === 0) {
        out += ',';
      }
      out += digits[i];
    }
    return out;
  }

  function lineLabel(view: CpLargeLabelView, n: number): string {
    const upTo = countUpTo(view.continuation, n);
    if (upTo > 0 && view.continuation[upTo - 1] === n) {
      return CONTINUATION_LABEL;
    }
    const label = group(view.firstLine + (n - 1) - upTo);
    return view.firstLineExact ? label : `~${label}`;
  }

  function shiftNeed(view: { atStart: boolean; atEnd: boolean }, lineCount: number, top: number, bottom: number): { prefetch: 'up' | 'down' | null; apply: 'up' | 'down' | null } {
    if (lineCount <= 0) {
      return { prefetch: null, apply: null };
    }
    const nearTop = (percent: number): boolean => !view.atStart && top * 100 < lineCount * percent;
    const nearBottom = (percent: number): boolean => !view.atEnd && bottom * 100 > lineCount * (100 - percent);
    const prefetch = nearTop(PREFETCH_PERCENT) ? 'up' : nearBottom(PREFETCH_PERCENT) ? 'down' : null;
    const apply = nearTop(APPLY_PERCENT) ? 'up' : nearBottom(APPLY_PERCENT) ? 'down' : null;
    return { prefetch, apply };
  }

  function thumb(byte: number, size: number, trackPx: number, thumbPx: number): number {
    const range = trackPx - thumbPx;
    if (!(size > 0) || !(range > 0)) {
      return 0;
    }
    return Math.min(range, Math.max(0, (byte / size) * range));
  }

  function permilleAt(px: number, trackPx: number, thumbPx: number): number {
    const range = trackPx - thumbPx;
    if (!(range > 0)) {
      return 0;
    }
    return Math.min(1000, Math.max(0, Math.round((px / range) * 1000)));
  }

  /** Original byte of a char inside an orig segment (exact: the window text of a segment decodes its bytes line by line). */
  function origByte(segment: CpWindowOrigSegment, text: string, char: number, byteLength: (s: string) => number): number {
    if (segment.lineStarts.length === 0) {
      return segment.byteStart;
    }
    let low = 0;
    let high = segment.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (segment.lineStarts[mid] <= char) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return segment.lineBytes[low] + byteLength(text.slice(segment.lineStarts[low], char));
  }

  function mapChar(segments: readonly CpWindowSegment[], text: string, char: number, side: 'start' | 'end', byteLength: (s: string) => number): { byte: number; char: number } {
    const count = segments.length;
    if (count === 0) {
      return { byte: 0, char: Math.max(0, Math.floor(char)) };
    }
    const c = Math.min(Math.max(Math.floor(char), 0), segments[count - 1].charEnd);
    // First segment ending at or after c.
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (segments[mid].charEnd >= c) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    const first = segments[low];
    if (first.charStart < c && c < first.charEnd) {
      if (first.kind === 'repl') {
        return side === 'start' ? { byte: first.byteStart, char: first.charStart } : { byte: first.byteEnd, char: first.charEnd };
      }
      return { byte: origByte(first, text, c, byteLength), char: c };
    }
    // c lies on a boundary: low..touching are the segments that touch it.
    let touching = low;
    while (touching + 1 < count && segments[touching + 1].charStart <= c) {
      touching += 1;
    }
    let firstInvisible: CpWindowReplSegment | null = null;
    let lastInvisible: CpWindowReplSegment | null = null;
    for (let i = low; i <= touching; i += 1) {
      const segment = segments[i];
      if (segment.kind === 'repl' && (segment.byteStart === segment.byteEnd || segment.charStart === segment.charEnd)) {
        firstInvisible = firstInvisible ?? segment;
        lastInvisible = segment;
      }
    }
    if (firstInvisible && lastInvisible) {
      return side === 'start' ? { byte: firstInvisible.byteStart, char: firstInvisible.charStart } : { byte: lastInvisible.byteEnd, char: lastInvisible.charEnd };
    }
    const before = segments[low].charEnd === c && segments[low].charStart < c ? segments[low] : null;
    const after = segments[touching].charStart === c && segments[touching].charEnd > c ? segments[touching] : null;
    if (side === 'start') {
      return { byte: after ? after.byteStart : before ? before.byteEnd : segments[low].byteStart, char: c };
    }
    return { byte: before ? before.byteEnd : after ? after.byteStart : segments[low].byteStart, char: c };
  }

  const UNITS: ReadonlyArray<{ scale: number; suffix: string }> = [
    { scale: 1e9, suffix: 'B' },
    { scale: 1e6, suffix: 'M' },
    { scale: 1e3, suffix: 'K' },
  ];

  function formatCount(n: number, exact: boolean): string {
    const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (exact) {
      return group(value);
    }
    for (let i = 0; i < UNITS.length; i += 1) {
      if (value >= UNITS[i].scale) {
        let unit = UNITS[i];
        let text = (value / unit.scale).toFixed(1);
        if (parseFloat(text) >= 1000 && i > 0) {
          unit = UNITS[i - 1];
          text = (value / unit.scale).toFixed(1);
        }
        return `≈ ${text}${unit.suffix}`;
      }
    }
    return `≈ ${value}`;
  }

  return { diffRange, segmentLine, lineLabel, docLine, shiftNeed, thumb, permilleAt, mapChar, formatCount };
});
