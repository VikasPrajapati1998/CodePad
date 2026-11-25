/* Tests of shared/largeWindow.ts (window helpers of the large-file mode). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const win: CodePadLargeWindowApi = require('../shared/largeWindow');

const utf8Length = (text: string): number => Buffer.byteLength(text, 'utf8');

test('diffRange finds the common prefix and suffix', () => {
  assert.deepEqual(win.diffRange('abc', 'abc'), { prefix: 3, suffix: 0 });
  assert.deepEqual(win.diffRange('abcdef', 'abXYdef'), { prefix: 2, suffix: 3 });
  assert.deepEqual(win.diffRange('abc', 'xyz'), { prefix: 0, suffix: 0 });
  assert.deepEqual(win.diffRange('', 'abc'), { prefix: 0, suffix: 0 });
  assert.deepEqual(win.diffRange('abc', ''), { prefix: 0, suffix: 0 });
  assert.deepEqual(win.diffRange('ab', 'aXb'), { prefix: 1, suffix: 1 });
  assert.deepEqual(win.diffRange('aa', 'aaa'), { prefix: 2, suffix: 0 });
});

test('diffRange never splits a surrogate pair or a CRLF', () => {
  // different low surrogates after the same high surrogate
  assert.deepEqual(win.diffRange('a😀b', 'a😁b'), { prefix: 1, suffix: 1 });
  // different high surrogates before the same low surrogate
  assert.deepEqual(win.diffRange('😀', '🨀'), { prefix: 0, suffix: 0 });
  // an identical lone high surrogate at the end is not a split
  assert.deepEqual(win.diffRange('a\ud83d', 'a\ud83d'), { prefix: 2, suffix: 0 });
  assert.deepEqual(win.diffRange('a\r\nb', 'a\rXb'), { prefix: 1, suffix: 1 });
  assert.deepEqual(win.diffRange('a\r\nb', 'c\nb'), { prefix: 0, suffix: 1 });
  assert.deepEqual(win.diffRange('x\r\ny', 'z\r\ny'), { prefix: 0, suffix: 3 });
});

test('diffRange: prefix and suffix never overlap and reproduce the new text', () => {
  const words = ['a', 'b', '\n', '\r', '😀', '😁', 'ab', ' '];
  let state = 12345;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 8;
  };
  const make = (): string => {
    let out = '';
    const parts = next() % 8;
    for (let i = 0; i < parts; i += 1) {
      out += words[next() % words.length];
    }
    return out;
  };
  for (let i = 0; i < 2000; i += 1) {
    const oldText = make();
    const newText = make();
    const { prefix, suffix } = win.diffRange(oldText, newText);
    assert.ok(prefix >= 0 && suffix >= 0);
    assert.ok(prefix + suffix <= Math.min(oldText.length, newText.length));
    assert.equal(oldText.slice(0, prefix), newText.slice(0, prefix));
    assert.equal(oldText.slice(oldText.length - suffix), newText.slice(newText.length - suffix));
    if (prefix > 0 && prefix < oldText.length) {
      const pair = oldText.charCodeAt(prefix - 1) >= 0xd800 && oldText.charCodeAt(prefix - 1) <= 0xdbff && oldText.charCodeAt(prefix) >= 0xdc00 && oldText.charCodeAt(prefix) <= 0xdfff;
      assert.equal(pair, false, 'prefix does not end inside a pair');
    }
  }
});

test('segmentLine splits without breaking surrogate pairs', () => {
  assert.deepEqual(win.segmentLine('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(win.segmentLine('abcdefg', 3), ['abc', 'def', 'g']);
  assert.deepEqual(win.segmentLine('', 3), ['']);
  assert.deepEqual(win.segmentLine('ab', 5), ['ab']);
  assert.deepEqual(win.segmentLine('ab😀cd', 3), ['ab', '😀c', 'd']);
  assert.deepEqual(win.segmentLine('😀', 1), ['😀']);
  assert.deepEqual(win.segmentLine('a😀', 1), ['a', '😀']);
  const long = 'x😀'.repeat(1000);
  const pieces = win.segmentLine(long, 7);
  assert.equal(pieces.join(''), long);
  for (const piece of pieces) {
    assert.ok(piece.length <= 7);
    assert.ok(!/^[\udc00-\udfff]/.test(piece) && !/[\ud800-\udbff]$/.test(piece));
  }
});

test('docLine and lineLabel with continuation segments', () => {
  const view = { firstLine: 100, firstLineExact: true, continuation: [3, 4, 8] };
  const expected: Array<[number, number]> = [[1, 100], [2, 101], [3, 101], [4, 101], [5, 102], [8, 104], [9, 105]];
  for (const [line, doc] of expected) {
    assert.equal(win.docLine(view, line), doc, `docLine ${line}`);
  }
  assert.equal(win.lineLabel(view, 1), '100');
  assert.equal(win.lineLabel(view, 3), '↪');
  assert.equal(win.lineLabel(view, 4), '↪');
  assert.equal(win.lineLabel(view, 5), '102');
  assert.equal(win.lineLabel(view, 8), '↪');
  const inexact = { firstLine: 100, firstLineExact: false, continuation: [3] };
  assert.equal(win.lineLabel(inexact, 2), '~101');
  assert.equal(win.lineLabel(inexact, 3), '↪');
  assert.equal(win.lineLabel({ firstLine: 1204381, firstLineExact: false, continuation: [] }, 1), '~1,204,381');
  assert.equal(win.lineLabel({ firstLine: 1204381, firstLineExact: true, continuation: [] }, 1), '1,204,381');
  assert.equal(win.docLine({ firstLine: 7, continuation: [] }, 1), 7);
});

test('shiftNeed uses 35/65 percent for prefetch and 20/80 percent to apply', () => {
  const view = { atStart: false, atEnd: false };
  const need = (top: number, bottom: number): { prefetch: 'up' | 'down' | null; apply: 'up' | 'down' | null } => win.shiftNeed(view, 1000, top, bottom);
  assert.deepEqual(need(500, 600), { prefetch: null, apply: null });
  assert.deepEqual(need(349, 600), { prefetch: 'up', apply: null });
  assert.deepEqual(need(350, 600), { prefetch: null, apply: null });
  assert.deepEqual(need(199, 600), { prefetch: 'up', apply: 'up' });
  assert.deepEqual(need(200, 600), { prefetch: 'up', apply: null });
  assert.deepEqual(need(500, 651), { prefetch: 'down', apply: null });
  assert.deepEqual(need(500, 650), { prefetch: null, apply: null });
  assert.deepEqual(need(500, 801), { prefetch: 'down', apply: 'down' });
  assert.deepEqual(need(500, 800), { prefetch: 'down', apply: null });
  assert.deepEqual(need(100, 900), { prefetch: 'up', apply: 'up' });
  assert.deepEqual(win.shiftNeed({ atStart: true, atEnd: false }, 1000, 10, 500), { prefetch: null, apply: null });
  assert.deepEqual(win.shiftNeed({ atStart: false, atEnd: true }, 1000, 500, 990), { prefetch: null, apply: null });
  assert.deepEqual(win.shiftNeed(view, 0, 1, 1), { prefetch: null, apply: null });
});

test('thumb and permilleAt', () => {
  assert.equal(win.thumb(0, 100, 200, 20), 0);
  assert.equal(win.thumb(100, 100, 200, 20), 180);
  assert.equal(win.thumb(50, 100, 200, 20), 90);
  assert.equal(win.thumb(500, 100, 200, 20), 180);
  assert.equal(win.thumb(5, 0, 200, 20), 0);
  assert.equal(win.thumb(5, 100, 20, 20), 0);
  assert.equal(win.permilleAt(90, 200, 20), 500);
  assert.equal(win.permilleAt(0, 200, 20), 0);
  assert.equal(win.permilleAt(180, 200, 20), 1000);
  assert.equal(win.permilleAt(-5, 200, 20), 0);
  assert.equal(win.permilleAt(500, 200, 20), 1000);
  assert.equal(win.permilleAt(10, 20, 20), 0);
  for (const size of [1000, 123456789, 5368709120]) {
    for (let step = 0; step <= 20; step += 1) {
      const byte = Math.floor((size * step) / 20);
      const permille = win.permilleAt(win.thumb(byte, size, 640, 30), 640, 30);
      assert.ok(Math.abs(permille - Math.round((byte / size) * 1000)) <= 1, `${byte} of ${size}`);
    }
  }
});

test('formatCount', () => {
  assert.equal(win.formatCount(48112334, true), '48,112,334');
  assert.equal(win.formatCount(0, true), '0');
  assert.equal(win.formatCount(1234, true), '1,234');
  assert.equal(win.formatCount(48112334, false), '≈ 48.1M');
  assert.equal(win.formatCount(999, false), '≈ 999');
  assert.equal(win.formatCount(1500, false), '≈ 1.5K');
  assert.equal(win.formatCount(2500000000, false), '≈ 2.5B');
  assert.equal(win.formatCount(999960, false), '≈ 1.0M');
});

/* ---------------------------------------------------------------- mapChar */

/**
 * Original file "ab\r\ncd\r\nef\r\n" (12 bytes) shown as one orig segment of the window text "ab\ncd\nef\n".
 */
const plainText = 'ab\ncd\nef\n';
const plainSegments: CpWindowSegment[] = [{ kind: 'orig', byteStart: 0, byteEnd: 12, charStart: 0, charEnd: 9, lineStarts: [0, 3, 6], lineBytes: [0, 4, 8] }];

test('mapChar inside an unchanged window (CRLF original)', () => {
  const map = (char: number, side: 'start' | 'end'): { byte: number; char: number } => win.mapChar(plainSegments, plainText, char, side, utf8Length);
  assert.deepEqual(map(4, 'start'), { byte: 5, char: 4 }); // "cd": after the c
  assert.deepEqual(map(5, 'start'), { byte: 6, char: 5 }); // end of "cd", before the CR
  assert.deepEqual(map(6, 'end'), { byte: 8, char: 6 }); // start of "ef"
  assert.deepEqual(map(0, 'start'), { byte: 0, char: 0 });
  assert.deepEqual(map(0, 'end'), { byte: 0, char: 0 });
  assert.deepEqual(map(9, 'end'), { byte: 12, char: 9 });
  assert.deepEqual(map(9, 'start'), { byte: 12, char: 9 });
  assert.deepEqual(map(100, 'end'), { byte: 12, char: 9 });
  assert.deepEqual(map(-3, 'start'), { byte: 0, char: 0 });
  assert.deepEqual(win.mapChar([], '', 5, 'start', utf8Length), { byte: 0, char: 5 });
});

test('mapChar counts multibyte characters', () => {
  // file bytes: C3 A9 61 0A ("éa\n")
  const segments: CpWindowSegment[] = [{ kind: 'orig', byteStart: 0, byteEnd: 4, charStart: 0, charEnd: 3, lineStarts: [0], lineBytes: [0] }];
  assert.deepEqual(win.mapChar(segments, 'éa\n', 1, 'start', utf8Length), { byte: 2, char: 1 });
  assert.deepEqual(win.mapChar(segments, 'éa\n', 2, 'end', utf8Length), { byte: 3, char: 2 });
});

/**
 * Window text "line1\nXX\nYY\niN\nline4\n":
 *   orig bytes [0,6) "line1\n"; replacement of bytes [6,11) by "XX\n"; orig bytes [11,14) "YY\n";
 *   an insertion "iN\n" at byte 14 (zero original bytes); orig bytes [14,20) "line4\n".
 */
const replText = 'line1\nXX\nYY\niN\nline4\n';
const replSegments: CpWindowSegment[] = [
  { kind: 'orig', byteStart: 0, byteEnd: 6, charStart: 0, charEnd: 6, lineStarts: [0], lineBytes: [0] },
  { kind: 'repl', index: 0, charStart: 6, charEnd: 9, byteStart: 6, byteEnd: 11 },
  { kind: 'orig', byteStart: 11, byteEnd: 14, charStart: 9, charEnd: 12, lineStarts: [9], lineBytes: [11] },
  { kind: 'repl', index: 1, charStart: 12, charEnd: 15, byteStart: 14, byteEnd: 14 },
  { kind: 'orig', byteStart: 14, byteEnd: 20, charStart: 15, charEnd: 21, lineStarts: [15], lineBytes: [14] },
];

test('mapChar snaps to replacements', () => {
  const map = (char: number, side: 'start' | 'end'): { byte: number; char: number } => win.mapChar(replSegments, replText, char, side, utf8Length);
  // strictly inside a replacement: the whole replacement
  assert.deepEqual(map(7, 'start'), { byte: 6, char: 6 });
  assert.deepEqual(map(7, 'end'), { byte: 11, char: 9 });
  // on the boundary of an ordinary replacement: not snapped
  assert.deepEqual(map(6, 'start'), { byte: 6, char: 6 });
  assert.deepEqual(map(6, 'end'), { byte: 6, char: 6 });
  assert.deepEqual(map(9, 'start'), { byte: 11, char: 9 });
  assert.deepEqual(map(9, 'end'), { byte: 11, char: 9 });
  // an insertion (zero original bytes) is always included, from either side and inside
  for (const char of [12, 13, 15]) {
    assert.deepEqual(map(char, 'start'), { byte: 14, char: 12 }, `start at ${char}`);
    assert.deepEqual(map(char, 'end'), { byte: 14, char: 15 }, `end at ${char}`);
  }
  // inside an orig segment after the insertion
  assert.deepEqual(map(16, 'start'), { byte: 15, char: 16 });
  assert.deepEqual(map(21, 'end'), { byte: 20, char: 21 });
  assert.deepEqual(map(21, 'start'), { byte: 20, char: 21 });
});

test('mapChar includes a deletion (zero chars) at a boundary', () => {
  // window text "a\nb\n": orig [0,2) "a\n", deletion of bytes [2,5), orig [5,7) "b\n"
  const segments: CpWindowSegment[] = [
    { kind: 'orig', byteStart: 0, byteEnd: 2, charStart: 0, charEnd: 2, lineStarts: [0], lineBytes: [0] },
    { kind: 'repl', index: 0, charStart: 2, charEnd: 2, byteStart: 2, byteEnd: 5 },
    { kind: 'orig', byteStart: 5, byteEnd: 7, charStart: 2, charEnd: 4, lineStarts: [2], lineBytes: [5] },
  ];
  assert.deepEqual(win.mapChar(segments, 'a\nb\n', 2, 'start', utf8Length), { byte: 2, char: 2 });
  assert.deepEqual(win.mapChar(segments, 'a\nb\n', 2, 'end', utf8Length), { byte: 5, char: 2 });
  assert.deepEqual(win.mapChar(segments, 'a\nb\n', 3, 'start', utf8Length), { byte: 6, char: 3 });
  assert.deepEqual(win.mapChar(segments, 'a\nb\n', 1, 'end', utf8Length), { byte: 1, char: 1 });
});
