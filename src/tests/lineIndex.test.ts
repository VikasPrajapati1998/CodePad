/* Tests of shared/lineIndex.ts (line index of the large-file mode). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lineIndex: CodePadLineIndexApi = require('../shared/lineIndex');

type Encoding = 'utf8' | 'utf16le' | 'utf16be';
type Mode = 'lf' | 'crlf' | 'cr' | 'mixed';

interface Layout {
  unit: CpLargeUnit;
  bigEndian: boolean;
  startByte: number;
}

interface Encoded {
  bytes: Uint8Array;
  layout: Layout;
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encode(text: string, encoding: Encoding, bom: boolean): Encoded {
  if (encoding === 'utf8') {
    const prefix = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
    return { bytes: Buffer.concat([prefix, Buffer.from(text, 'utf8')]), layout: { unit: 1, bigEndian: false, startByte: prefix.length } };
  }
  const little = Buffer.from(text, 'utf16le');
  const body = encoding === 'utf16le' ? little : Buffer.from(little).swap16();
  const bomBytes = encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff];
  const prefix = bom ? Buffer.from(bomBytes) : Buffer.alloc(0);
  return { bytes: Buffer.concat([prefix, body]), layout: { unit: 2, bigEndian: encoding === 'utf16be', startByte: prefix.length } };
}

/** Straightforward reference: line starts and break counts of an encoded document. */
function naiveScan(bytes: Uint8Array, layout: Layout): { starts: number[]; counts: Record<CpEolKind, number> } {
  const { unit, bigEndian, startByte } = layout;
  const unitAt = (position: number): number => {
    if (unit === 1) {
      return bytes[position];
    }
    return bigEndian ? (bytes[position] << 8) | bytes[position + 1] : (bytes[position + 1] << 8) | bytes[position];
  };
  const starts = [startByte];
  const counts: Record<CpEolKind, number> = { lf: 0, crlf: 0, cr: 0 };
  let position = startByte;
  while (position + unit <= bytes.length) {
    const value = unitAt(position);
    if (value === 10) {
      counts.lf += 1;
      position += unit;
      starts.push(position);
    } else if (value === 13) {
      if (position + 2 * unit <= bytes.length && unitAt(position + unit) === 10) {
        counts.crlf += 1;
        position += 2 * unit;
      } else {
        counts.cr += 1;
        position += unit;
      }
      starts.push(position);
    } else {
      position += unit;
    }
  }
  return { starts, counts };
}

const WORDS = ['a', 'bc', 'é', '日本', '😀', ' ', 'xਊy', '਀', 'ਊ', ''];
const BMP_WORDS = ['a', 'bc', 'é', '日本', ' ', 'xਊy', '਀', ''];

function eolOf(mode: Mode, rand: () => number): string {
  if (mode === 'lf') {
    return '\n';
  }
  if (mode === 'crlf') {
    return '\r\n';
  }
  if (mode === 'cr') {
    return '\r';
  }
  return ['\n', '\r\n', '\r'][Math.floor(rand() * 3)];
}

function randomText(rand: () => number, mode: Mode, parts: number, words: readonly string[]): string {
  let out = '';
  for (let i = 0; i < parts; i += 1) {
    out += rand() < 0.5 ? words[Math.floor(rand() * words.length)] : eolOf(mode, rand);
  }
  return out;
}

function scanAll(bytes: Uint8Array, options: CpLineIndexOptions, nextSize: () => number, finishIndex = true): CpLineIndex {
  const index = lineIndex.create(options);
  let position = options.startByte;
  while (position < bytes.length) {
    const size = Math.min(Math.max(1, nextSize()), bytes.length - position);
    lineIndex.scanChunk(index, bytes.subarray(position, position + size), position);
    position += size;
  }
  if (finishIndex) {
    lineIndex.finish(index, bytes.length);
  }
  return index;
}

function entriesOf(index: CpLineIndex): number[] {
  return Array.from(index.entries.subarray(0, index.count * 2));
}

/** Checks a finished index of `bytes` against the reference. */
function verify(index: CpLineIndex, bytes: Uint8Array, layout: Layout): void {
  const naive = naiveScan(bytes, layout);
  assert.equal(index.lines, naive.starts.length - 1, 'line count');
  assert.deepEqual(index.eolCounts, naive.counts, 'break counts');
  assert.equal(index.scannedBytes, bytes.length, 'scanned bytes');
  assert.ok(index.done, 'done');
  assert.ok(index.count >= 1 && index.count <= index.options.maxEntries, 'entry count');
  assert.equal(index.entries[0], 1);
  assert.equal(index.entries[1], layout.startByte);
  let previousLine = 0;
  let previousByte = -1;
  for (let i = 0; i < index.count; i += 1) {
    const line = index.entries[2 * i];
    const byte = index.entries[2 * i + 1];
    assert.ok(line > previousLine && byte > previousByte, 'checkpoints are increasing');
    assert.equal(byte, naive.starts[line - 1], `checkpoint of line ${line}`);
    previousLine = line;
    previousByte = byte;
  }
  const { unit, bigEndian } = layout;
  const resolve = (hit: CpLineHit | null, line: number): void => {
    assert.ok(hit, `checkpoint for line ${line}`);
    if (!hit) {
      return;
    }
    assert.ok(hit.line <= line);
    const part = lineIndex.countBreaks(bytes.subarray(hit.byte, naive.starts[line - 1]), unit, bigEndian, false);
    assert.equal(hit.line + part.breaks + (part.endsWithCr ? 1 : 0), line, `exact line ${line}`);
  };
  for (let line = 1; line <= naive.starts.length; line += 1) {
    resolve(lineIndex.checkpointForLine(index, line), line);
    resolve(lineIndex.checkpointAtByte(index, naive.starts[line - 1]), line);
  }
  assert.equal(lineIndex.checkpointForLine(index, naive.starts.length + 1), null);
  assert.equal(lineIndex.checkpointForLine(index, 0), null);
}

test('counts LF, CRLF and lone CR and records the line starts', () => {
  // a \n b b \r \n c c c \r d d  -> line starts 0, 2, 6, 10
  const bytes = Buffer.from('a\nbb\r\nccc\rdd', 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 1 }, () => 1000);
  assert.equal(index.lines, 3);
  assert.deepEqual(index.eolCounts, { lf: 1, crlf: 1, cr: 1 });
  assert.equal(index.scannedBytes, 12);
  assert.deepEqual(entriesOf(index), [1, 0, 2, 2, 3, 6, 4, 10]);
  assert.equal(lineIndex.dominantEol(index), 'lf');
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('a CR at the end of a chunk is resolved by the next chunk', () => {
  const bytes = Buffer.from('a\nbb\r\nccc\rdd', 'latin1');
  const index = lineIndex.create({ unit: 1, bigEndian: false, startByte: 0, every: 1 });
  lineIndex.scanChunk(index, bytes.subarray(0, 5), 0); // a \n b b \r
  assert.equal(index.lines, 1);
  assert.equal(index.pendingCr, true);
  assert.equal(index.scannedBytes, 5);
  lineIndex.scanChunk(index, bytes.subarray(5, 10), 5); // \n c c c \r
  assert.equal(index.lines, 2);
  assert.equal(index.pendingCr, true);
  assert.equal(index.scannedBytes, 10);
  assert.deepEqual(index.eolCounts, { lf: 1, crlf: 1, cr: 0 });
  lineIndex.scanChunk(index, bytes.subarray(10, 12), 10); // d d
  assert.equal(index.lines, 3);
  assert.equal(index.pendingCr, false);
  assert.equal(index.scannedBytes, 12);
  assert.deepEqual(index.eolCounts, { lf: 1, crlf: 1, cr: 1 });
  lineIndex.finish(index, 12);
  assert.ok(index.done);
  assert.deepEqual(entriesOf(index), [1, 0, 2, 2, 3, 6, 4, 10]);
});

test('scanChunk rejects bytes that do not continue the scan', () => {
  const index = lineIndex.create({ unit: 1, bigEndian: false, startByte: 0 });
  assert.throws(() => lineIndex.scanChunk(index, Buffer.from('abc'), 5), /expected bytes at 0/);
  lineIndex.scanChunk(index, Buffer.from('abc'), 0);
  lineIndex.finish(index, 3);
  assert.throws(() => lineIndex.scanChunk(index, Buffer.from('d'), 3), /finished/);
});

test('create validates its options', () => {
  assert.throws(() => lineIndex.create({ unit: 1, bigEndian: false, startByte: -1 }));
  assert.throws(() => lineIndex.create({ unit: 1, bigEndian: false, startByte: 0, every: 0 }));
  assert.throws(() => lineIndex.create({ unit: 1, bigEndian: false, startByte: 0, maxEntries: 1 }));
});

test('empty file', () => {
  const index = lineIndex.create({ unit: 1, bigEndian: false, startByte: 0 });
  lineIndex.scanChunk(index, new Uint8Array(0), 0);
  lineIndex.finish(index, 0);
  assert.equal(index.lines, 0);
  assert.equal(index.count, 1);
  assert.ok(index.done);
  assert.deepEqual(lineIndex.checkpointForLine(index, 1), { line: 1, byte: 0 });
  assert.equal(lineIndex.checkpointForLine(index, 2), null);
  assert.deepEqual(lineIndex.checkpointAtByte(index, 0), { line: 1, byte: 0 });
  assert.equal(lineIndex.dominantEol(index), 'lf');
  assert.deepEqual(lineIndex.splitLines(new Uint8Array(0), 1, false), { starts: [0], eolLens: [0] });
});

test('no trailing newline: the last line is counted and resolvable', () => {
  const bytes = Buffer.from('a\nb', 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0 }, () => 2);
  assert.equal(index.lines, 1);
  assert.deepEqual(lineIndex.checkpointForLine(index, 2), { line: 1, byte: 0 });
  assert.deepEqual(lineIndex.countBreaks(bytes.subarray(0, 2), 1, false, false), { breaks: 1, endsWithCr: false });
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('a trailing newline opens an empty last line', () => {
  const bytes = Buffer.from('a\nb\n', 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 1 }, () => 3);
  assert.equal(index.lines, 2);
  assert.deepEqual(entriesOf(index), [1, 0, 2, 2, 3, 4]);
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('a CR at the end of the file is a lone CR; resume re-opens it for appended data', () => {
  const index = scanAll(Buffer.from('x\r', 'latin1'), { unit: 1, bigEndian: false, startByte: 0 }, () => 10);
  assert.equal(index.lines, 1);
  assert.deepEqual(index.eolCounts, { lf: 0, crlf: 0, cr: 1 });
  lineIndex.resume(index);
  assert.equal(index.done, false);
  assert.equal(index.lines, 0);
  assert.deepEqual(index.eolCounts, { lf: 0, crlf: 0, cr: 0 });
  lineIndex.scanChunk(index, Buffer.from('\ny', 'latin1'), 2);
  lineIndex.finish(index, 4);
  assert.equal(index.lines, 1);
  assert.deepEqual(index.eolCounts, { lf: 0, crlf: 1, cr: 0 });
  verify(index, Buffer.from('x\r\ny', 'latin1'), { unit: 1, bigEndian: false, startByte: 0 });
});

test('UTF-16 LE and BE with BOM, one byte at a time', () => {
  for (const encoding of ['utf16le', 'utf16be'] as const) {
    const { bytes, layout } = encode('a\nb\r\nc\rd😀', encoding, true);
    assert.equal(layout.startByte, 2);
    const index = scanAll(bytes, { ...layout }, () => 1);
    // line starts: after a\n, after b\r\n, after c\r
    assert.equal(index.lines, 3);
    assert.deepEqual(index.eolCounts, { lf: 1, crlf: 1, cr: 1 });
    verify(index, bytes, layout);
    const whole = scanAll(bytes, { ...layout }, () => 1000);
    assert.deepEqual(entriesOf(whole), entriesOf(index));
  }
});

test('0x0A bytes inside UTF-16 characters are not breaks', () => {
  // U+0A61 = 61 0A (LE) / 0A 61 (BE); U+0A00 = 00 0A / 0A 00; U+0A0A = 0A 0A.
  for (const encoding of ['utf16le', 'utf16be'] as const) {
    const { bytes, layout } = encode('੡਀ਊഊ', encoding, false);
    const index = scanAll(bytes, { ...layout }, () => 3);
    assert.equal(index.lines, 0, encoding);
    verify(index, bytes, layout);
  }
});

test('UTF-16 with an odd trailing byte keeps it carried', () => {
  const index = lineIndex.create({ unit: 2, bigEndian: false, startByte: 0 });
  lineIndex.scanChunk(index, Uint8Array.from([0x61, 0x00, 0x0a]), 0);
  assert.equal(index.scannedBytes, 2);
  assert.equal(index.pendingOdd, 0x0a);
  assert.equal(index.lines, 0);
  assert.throws(() => lineIndex.scanChunk(index, Uint8Array.from([0x00]), 2), /expected bytes at 3/);
  lineIndex.scanChunk(index, Uint8Array.from([0x00, 0x62, 0x00]), 3);
  assert.equal(index.lines, 1);
  assert.equal(index.scannedBytes, 6);
  assert.equal(index.pendingOdd, -1);
  assert.deepEqual(entriesOf(index), [1, 0]);
  lineIndex.finish(index, 6);
  assert.deepEqual(lineIndex.checkpointForLine(index, 2), { line: 1, byte: 0 });
});

test('UTF-8 multibyte characters across chunk ends', () => {
  const bytes = Buffer.from('é\n日\n😀\n', 'utf8');
  // é(2)+\n -> 3, 日(3)+\n -> 7, emoji(4)+\n -> 12
  for (const size of [1, 2, 3, 5, 100]) {
    const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 1 }, () => size);
    assert.deepEqual(entriesOf(index), [1, 0, 2, 3, 3, 7, 4, 12], `chunk ${size}`);
  }
  for (let position = 0; position <= bytes.length; position += 1) {
    const boundary = lineIndex.safeBoundary(bytes, position, 'utf8');
    assert.ok(boundary <= position && position - boundary <= 3);
    assert.ok(boundary === bytes.length || (bytes[boundary] & 0xc0) !== 0x80, `position ${position}`);
  }
});

test('checkpoints every N lines and lookups', () => {
  const bytes = Buffer.from('x\n'.repeat(10), 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 2 }, () => 7);
  assert.deepEqual(entriesOf(index), [1, 0, 2, 2, 4, 6, 6, 10, 8, 14, 10, 18]);
  assert.deepEqual(lineIndex.checkpointForLine(index, 7), { line: 6, byte: 10 });
  assert.deepEqual(lineIndex.checkpointForLine(index, 10), { line: 10, byte: 18 });
  assert.deepEqual(lineIndex.checkpointForLine(index, 11), { line: 10, byte: 18 });
  assert.equal(lineIndex.checkpointForLine(index, 12), null);
  assert.deepEqual(lineIndex.checkpointAtByte(index, 9), { line: 4, byte: 6 });
  assert.deepEqual(lineIndex.checkpointAtByte(index, 10), { line: 6, byte: 10 });
  assert.deepEqual(lineIndex.checkpointAtByte(index, 1000), { line: 10, byte: 18 });
  assert.deepEqual(lineIndex.checkpointAtByte(index, 0), { line: 1, byte: 0 });
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('a checkpoint is also stored when the byte gap is exceeded', () => {
  const bytes = Buffer.from('abc\n'.repeat(12), 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, maxGapBytes: 10 }, () => 5);
  // line starts are 0, 4, 8, 12 ...: 12 - 0 >= 10, then every 12 bytes (3 lines)
  assert.deepEqual(entriesOf(index), [1, 0, 4, 12, 7, 24, 10, 36, 13, 48]);
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('decimation keeps the entry count bounded and lookups exact', () => {
  const bytes = Buffer.from('x\n'.repeat(200), 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 1, maxEntries: 8 }, () => 13);
  assert.ok(index.count <= 8);
  assert.ok(index.every > 1);
  verify(index, bytes, { unit: 1, bigEndian: false, startByte: 0 });
});

test('random documents match the reference for any chunking, encoding and limits', () => {
  const encodings: Array<[Encoding, boolean]> = [
    ['utf8', false],
    ['utf8', true],
    ['utf16le', true],
    ['utf16le', false],
    ['utf16be', true],
    ['utf16be', false],
  ];
  const modes: Mode[] = ['lf', 'crlf', 'cr', 'mixed'];
  for (let seed = 1; seed <= 300; seed += 1) {
    const rand = seeded(seed);
    const [encoding, bom] = encodings[Math.floor(rand() * encodings.length)];
    const mode = modes[Math.floor(rand() * modes.length)];
    const { bytes, layout } = encode(randomText(rand, mode, Math.floor(rand() * 60), WORDS), encoding, bom);
    const maxChunk = [1, 3, 8, 64][Math.floor(rand() * 4)];
    const options: CpLineIndexOptions = {
      ...layout,
      every: 1 + Math.floor(rand() * 4),
      maxGapBytes: [5, 40, 1048576][Math.floor(rand() * 3)],
      maxEntries: [2, 3, 6, 2000000][Math.floor(rand() * 4)],
    };
    const index = scanAll(bytes, options, () => 1 + Math.floor(rand() * maxChunk));
    verify(index, bytes, layout);
  }
});

test('resume after finish equals one scan of the grown file', () => {
  const encodings: Array<[Encoding, boolean]> = [
    ['utf8', false],
    ['utf16le', true],
    ['utf16be', false],
  ];
  const modes: Mode[] = ['lf', 'crlf', 'cr', 'mixed'];
  for (let seed = 1; seed <= 300; seed += 1) {
    const rand = seeded(seed * 7919);
    const [encoding, bom] = encodings[Math.floor(rand() * encodings.length)];
    const mode = modes[Math.floor(rand() * modes.length)];
    const { bytes, layout } = encode(randomText(rand, mode, 1 + Math.floor(rand() * 40), WORDS), encoding, bom);
    const units = Math.floor((bytes.length - layout.startByte) / layout.unit);
    const cut = layout.startByte + Math.floor(rand() * (units + 1)) * layout.unit;
    const options: CpLineIndexOptions = { ...layout, every: 1 + Math.floor(rand() * 3), maxGapBytes: [6, 1048576][Math.floor(rand() * 2)] };
    const size = (): number => 1 + Math.floor(rand() * 5);
    const grown = lineIndex.create(options);
    let position = layout.startByte;
    while (position < cut) {
      const part = Math.min(size(), cut - position);
      lineIndex.scanChunk(grown, bytes.subarray(position, position + part), position);
      position += part;
    }
    lineIndex.finish(grown, cut);
    assert.ok(grown.done);
    lineIndex.resume(grown);
    assert.equal(grown.done, false);
    while (position < bytes.length) {
      const part = Math.min(size(), bytes.length - position);
      lineIndex.scanChunk(grown, bytes.subarray(position, position + part), position);
      position += part;
    }
    lineIndex.finish(grown, bytes.length);
    const full = scanAll(bytes, options, () => 1000);
    assert.equal(grown.lines, full.lines);
    assert.deepEqual(grown.eolCounts, full.eolCounts);
    assert.equal(grown.scannedBytes, full.scannedBytes);
    assert.deepEqual(entriesOf(grown), entriesOf(full));
    verify(grown, bytes, layout);
  }
});

test('nextLineStart and prevLineStart on a fixed buffer', () => {
  // a b \r \n c d \r e f \n   (indices 0..9, length 10)
  const bytes = Buffer.from('ab\r\ncd\ref\n', 'latin1');
  const next = (from: number): number => lineIndex.nextLineStart(bytes, from, 1, false);
  assert.equal(next(0), 4);
  assert.equal(next(2), 4);
  assert.equal(next(3), 4);
  assert.equal(next(4), 7);
  assert.equal(next(7), 10);
  assert.equal(next(9), 10);
  assert.equal(next(10), -1);
  assert.equal(lineIndex.nextLineStart(Buffer.from('ab\r', 'latin1'), 0, 1, false), -1);
  const prev = (from: number): number => lineIndex.prevLineStart(bytes, from, 1, false);
  assert.equal(prev(10), 10);
  assert.equal(prev(9), 7);
  assert.equal(prev(5), 4);
  assert.equal(prev(4), 4);
  assert.equal(prev(3), -1);
  assert.equal(prev(0), -1);
});

test('nextLineStart and prevLineStart agree with the reference', () => {
  const encodings: Encoding[] = ['utf8', 'utf16le', 'utf16be'];
  const modes: Mode[] = ['lf', 'crlf', 'cr', 'mixed'];
  for (let seed = 1; seed <= 150; seed += 1) {
    const rand = seeded(seed * 31);
    const encoding = encodings[seed % 3];
    const { bytes, layout } = encode(randomText(rand, modes[seed % 4], Math.floor(rand() * 30), WORDS), encoding, false);
    const { unit, bigEndian } = layout;
    const starts = naiveScan(bytes, layout).starts;
    const endsWithCr = bytes.length >= unit && (unit === 1 ? bytes[bytes.length - 1] === 13 : bigEndian ? bytes[bytes.length - 1] === 13 && bytes[bytes.length - 2] === 0 : bytes[bytes.length - 2] === 13 && bytes[bytes.length - 1] === 0);
    for (let from = 0; from <= bytes.length; from += unit) {
      let expectedNext = starts.find((start) => start > from) ?? -1;
      if (expectedNext === bytes.length && endsWithCr) {
        expectedNext = -1;
      }
      assert.equal(lineIndex.nextLineStart(bytes, from, unit, bigEndian), expectedNext, `next ${encoding} from ${from}`);
      const candidates = starts.filter((start) => start > 0 && start <= from && !(start === bytes.length && endsWithCr));
      const expectedPrev = candidates.length > 0 ? candidates[candidates.length - 1] : -1;
      assert.equal(lineIndex.prevLineStart(bytes, from, unit, bigEndian), expectedPrev, `prev ${encoding} from ${from}`);
    }
  }
});

test('safeBoundary never lands inside a UTF-8 sequence or a surrogate pair', () => {
  const eight = Buffer.from('a€b😀c', 'utf8'); // 61 | E2 82 AC | 62 | F0 9F 98 80 | 63
  assert.equal(lineIndex.safeBoundary(eight, 2, 'utf8'), 1);
  assert.equal(lineIndex.safeBoundary(eight, 3, 'utf8'), 1);
  assert.equal(lineIndex.safeBoundary(eight, 4, 'utf8'), 4);
  assert.equal(lineIndex.safeBoundary(eight, 7, 'utf8'), 5);
  assert.equal(lineIndex.safeBoundary(eight, 8, 'utf8'), 5);
  assert.equal(lineIndex.safeBoundary(eight, 9, 'utf8'), 9);
  assert.equal(lineIndex.safeBoundary(eight, 100, 'utf8'), 10);
  assert.equal(lineIndex.safeBoundary(eight, 3, 'single'), 3);
  const little = encode('a😀', 'utf16le', false).bytes; // 61 00 3D D8 00 DE
  assert.equal(lineIndex.safeBoundary(little, 2, 'utf16le'), 2);
  assert.equal(lineIndex.safeBoundary(little, 3, 'utf16le'), 2);
  assert.equal(lineIndex.safeBoundary(little, 4, 'utf16le'), 2);
  assert.equal(lineIndex.safeBoundary(little, 5, 'utf16le'), 2);
  assert.equal(lineIndex.safeBoundary(little, 6, 'utf16le'), 6);
  const big = encode('a😀', 'utf16be', false).bytes; // 00 61 D8 3D DE 00
  assert.equal(lineIndex.safeBoundary(big, 4, 'utf16be'), 2);
  assert.equal(lineIndex.safeBoundary(big, 2, 'utf16be'), 2);
  for (let seed = 1; seed <= 100; seed += 1) {
    const rand = seeded(seed * 17);
    const utf8 = Buffer.from(randomText(rand, 'lf', 30, WORDS), 'utf8');
    for (let position = 0; position <= utf8.length; position += 1) {
      const boundary = lineIndex.safeBoundary(utf8, position, 'utf8');
      assert.ok(boundary <= position && position - boundary <= 3);
      assert.ok(boundary === utf8.length || (utf8[boundary] & 0xc0) !== 0x80);
    }
    const sixteen = encode(randomText(rand, 'lf', 30, WORDS), 'utf16le', false).bytes;
    for (let position = 0; position <= sixteen.length; position += 1) {
      const boundary = lineIndex.safeBoundary(sixteen, position, 'utf16le');
      assert.ok(boundary <= position && position - boundary <= 3 && boundary % 2 === 0);
      if (boundary + 1 < sixteen.length) {
        const high = sixteen[boundary + 1];
        assert.ok(high < 0xdc || high > 0xdf, 'does not start on a low surrogate');
      }
    }
  }
});

test('splitLines returns line starts and EOL lengths', () => {
  // a \r \n b \r c \n  -> lines "a" (CRLF), "b" (CR), "c" (LF), "" (none)
  const bytes = Buffer.from('a\r\nb\rc\n', 'latin1');
  assert.deepEqual(lineIndex.splitLines(bytes, 1, false), { starts: [0, 3, 5, 7], eolLens: [2, 1, 1, 0] });
  // a CR at the end of the buffer is taken as a lone CR
  assert.deepEqual(lineIndex.splitLines(Buffer.from('a\r', 'latin1'), 1, false), { starts: [0, 2], eolLens: [1, 0] });
  const { bytes: wide, layout } = encode('a\r\nb', 'utf16le', false);
  assert.deepEqual(lineIndex.splitLines(wide, layout.unit, layout.bigEndian), { starts: [0, 6], eolLens: [4, 0] });
  for (let seed = 1; seed <= 100; seed += 1) {
    const rand = seeded(seed * 13);
    const encoded = encode(randomText(rand, 'mixed', Math.floor(rand() * 30), WORDS), (['utf8', 'utf16le', 'utf16be'] as const)[seed % 3], false);
    const split = lineIndex.splitLines(encoded.bytes, encoded.layout.unit, encoded.layout.bigEndian);
    assert.deepEqual(split.starts, naiveScan(encoded.bytes, encoded.layout).starts);
    assert.equal(split.eolLens.length, split.starts.length);
    assert.equal(split.eolLens[split.eolLens.length - 1], 0);
    for (let i = 0; i + 1 < split.starts.length; i += 1) {
      assert.ok(split.eolLens[i] === encoded.layout.unit || split.eolLens[i] === 2 * encoded.layout.unit);
    }
  }
});

test('countBreaks is additive over any split', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const rand = seeded(seed * 101);
    const encoded = encode(randomText(rand, 'mixed', Math.floor(rand() * 30), BMP_WORDS), (['utf8', 'utf16le', 'utf16be'] as const)[seed % 3], false);
    const { unit, bigEndian } = encoded.layout;
    const whole = lineIndex.countBreaks(encoded.bytes, unit, bigEndian, false);
    const cut = Math.floor(rand() * (encoded.bytes.length / unit + 1)) * unit;
    const left = lineIndex.countBreaks(encoded.bytes.subarray(0, cut), unit, bigEndian, false);
    const right = lineIndex.countBreaks(encoded.bytes.subarray(cut), unit, bigEndian, left.endsWithCr);
    assert.equal(left.breaks + right.breaks, whole.breaks);
    assert.equal(right.endsWithCr, whole.endsWithCr);
  }
});

test('estimateLine and dominantEol', () => {
  const bytes = Buffer.from('abcdefgh\n'.repeat(10), 'latin1');
  const index = scanAll(bytes, { unit: 1, bigEndian: false, startByte: 0, every: 2 }, () => 1000);
  assert.equal(lineIndex.estimateLine(index, 27), 4); // a checkpoint: line 4 starts at byte 27
  assert.equal(lineIndex.estimateLine(index, 0), 1);
  const middle = lineIndex.estimateLine(index, 45);
  assert.ok(middle >= 5 && middle <= 7, `estimated ${middle}`);
  assert.ok(lineIndex.estimateLine(index, 180) > 18);
  const empty = lineIndex.create({ unit: 1, bigEndian: false, startByte: 0 });
  assert.equal(lineIndex.estimateLine(empty, 800), 11); // 1 + 800 / 80
  assert.equal(lineIndex.dominantEol(scanAll(Buffer.from('a\r\nb\r\nc\n'), { unit: 1, bigEndian: false, startByte: 0 }, () => 100)), 'crlf');
  assert.equal(lineIndex.dominantEol(scanAll(Buffer.from('a\r\nb\nc\n'), { unit: 1, bigEndian: false, startByte: 0 }, () => 100)), 'lf');
  assert.equal(lineIndex.dominantEol(scanAll(Buffer.from('a\rb\rc'), { unit: 1, bigEndian: false, startByte: 0 }, () => 100)), 'cr');
  assert.equal(lineIndex.dominantEol(scanAll(Buffer.from('a\rb\r\nc'), { unit: 1, bigEndian: false, startByte: 0 }, () => 100)), 'crlf');
});

/* ---------------------------------------------------------------- rebase */

interface EditSpec {
  start: number;
  end: number;
  text: string;
}

function breaksIn(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

/** Overlay edits (byte coordinates) for text edits given in UTF-16 offsets of a BMP-only document. */
function overlayEdits(doc: string, specs: readonly EditSpec[]): CpOverlayEdit[] {
  return specs.map((spec) => {
    const start = Buffer.byteLength(doc.slice(0, spec.start));
    const end = Buffer.byteLength(doc.slice(0, spec.end));
    return {
      start,
      end,
      byteDelta: Buffer.byteLength(spec.text) - (end - start),
      lineDelta: breaksIn(spec.text) - breaksIn(doc.slice(spec.start, spec.end)),
    };
  });
}

function applySpecs(doc: string, specs: readonly EditSpec[]): string {
  let out = '';
  let position = 0;
  for (const spec of specs) {
    out += doc.slice(position, spec.start) + spec.text;
    position = spec.end;
  }
  return out + doc.slice(position);
}

/** Random sorted, disjoint edits at positions that never split a CRLF. */
function randomSpecs(rand: () => number, doc: string, eol: string, maxEdits: number): EditSpec[] {
  const allowed: number[] = [];
  for (let position = 0; position <= doc.length; position += 1) {
    if (!(doc[position - 1] === '\r' && doc[position] === '\n')) {
      allowed.push(position);
    }
  }
  const count = Math.floor(rand() * (maxEdits + 1));
  const picks: number[] = [];
  for (let i = 0; i < count * 2; i += 1) {
    picks.push(allowed[Math.floor(rand() * allowed.length)]);
  }
  picks.sort((a, b) => a - b);
  const specs: EditSpec[] = [];
  for (let i = 0; i + 1 < picks.length; i += 2) {
    let text = '';
    const parts = Math.floor(rand() * 4);
    for (let part = 0; part < parts; part += 1) {
      text += rand() < 0.5 ? BMP_WORDS[Math.floor(rand() * BMP_WORDS.length)] : eol;
    }
    specs.push({ start: picks[i], end: picks[i + 1], text });
  }
  return specs;
}

function randomDoc(rand: () => number, eol: string): string {
  const lines: string[] = [];
  const count = Math.floor(rand() * 25);
  for (let i = 0; i < count; i += 1) {
    let line = '';
    const parts = Math.floor(rand() * 4);
    for (let part = 0; part < parts; part += 1) {
      line += BMP_WORDS[Math.floor(rand() * BMP_WORDS.length)];
    }
    lines.push(line);
  }
  return lines.join(eol) + (rand() < 0.5 ? eol : '');
}

test('rebase of a finished index equals a fresh scan of the edited file', () => {
  const eols = ['\n', '\r\n', '\r'];
  for (let seed = 1; seed <= 300; seed += 1) {
    const rand = seeded(seed * 3571);
    const eol = eols[seed % 3];
    const doc = randomDoc(rand, eol);
    const specs = randomSpecs(rand, doc, eol, 4);
    const before = encode(doc, 'utf8', false);
    const options: CpLineIndexOptions = { ...before.layout, every: 1 + Math.floor(rand() * 3), maxGapBytes: [8, 1048576][Math.floor(rand() * 2)] };
    const index = scanAll(before.bytes, options, () => 1 + Math.floor(rand() * 9));
    const edited = applySpecs(doc, specs);
    const after = encode(edited, 'utf8', false);
    const rebased = lineIndex.rebase(index, overlayEdits(doc, specs));
    const fresh = naiveScan(after.bytes, after.layout);
    assert.equal(rebased.lines, fresh.starts.length - 1, `lines (seed ${seed})`);
    assert.equal(rebased.scannedBytes, after.bytes.length);
    assert.ok(rebased.done);
    if (index.lines > 0) {
      assert.deepEqual(rebased.eolCounts, fresh.counts, `breaks (seed ${seed})`);
    }
    for (let i = 0; i < rebased.count; i += 1) {
      const line = rebased.entries[2 * i];
      assert.equal(rebased.entries[2 * i + 1], fresh.starts[line - 1], `checkpoint of line ${line} (seed ${seed})`);
    }
    assert.equal(rebased.entries[0], 1);
    // lookups on the rebased index are exact
    for (let line = 1; line <= fresh.starts.length; line += 1) {
      const hit = lineIndex.checkpointForLine(rebased, line);
      assert.ok(hit);
      if (hit) {
        const part = lineIndex.countBreaks(after.bytes.subarray(hit.byte, fresh.starts[line - 1]), 1, false, false);
        assert.equal(hit.line + part.breaks + (part.endsWithCr ? 1 : 0), line);
      }
    }
  }
});

test('rebase of an unfinished index continues to a correct scan', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const rand = seeded(seed * 4099);
    const doc = randomDoc(rand, '\n');
    const specs = randomSpecs(rand, doc, '\n', 3);
    const before = encode(doc, 'utf8', false);
    const scannedTo = Math.floor(rand() * (before.bytes.length + 1));
    const options: CpLineIndexOptions = { ...before.layout, every: 1 + Math.floor(rand() * 3) };
    const index = lineIndex.create(options);
    if (scannedTo > 0) {
      lineIndex.scanChunk(index, before.bytes.subarray(0, scannedTo), 0);
    }
    const edits = overlayEdits(doc, specs);
    const straddles = edits.some((edit) => edit.start < scannedTo && edit.end > scannedTo);
    const after = encode(applySpecs(doc, specs), 'utf8', false);
    const rebased = lineIndex.rebase(index, edits);
    assert.equal(rebased.done, false);
    if (straddles) {
      const line = rebased.entries[(rebased.count - 1) * 2];
      assert.equal(rebased.lines, line - 1);
      assert.equal(rebased.scannedBytes, rebased.entries[(rebased.count - 1) * 2 + 1]);
    } else {
      let byteDelta = 0;
      let lineDelta = 0;
      for (const edit of edits) {
        if (edit.start < scannedTo) {
          byteDelta += edit.byteDelta;
          lineDelta += edit.lineDelta;
        }
      }
      assert.equal(rebased.scannedBytes, scannedTo + byteDelta);
      assert.equal(rebased.lines, index.lines + lineDelta);
    }
    // finish the scan of the new file from where the rebased index stands
    let position = rebased.scannedBytes;
    while (position < after.bytes.length) {
      const size = Math.min(1 + Math.floor(rand() * 11), after.bytes.length - position);
      lineIndex.scanChunk(rebased, after.bytes.subarray(position, position + size), position);
      position += size;
    }
    lineIndex.finish(rebased, after.bytes.length);
    const fresh = naiveScan(after.bytes, after.layout);
    assert.equal(rebased.lines, fresh.starts.length - 1, `lines (seed ${seed})`);
    if (!straddles) {
      assert.deepEqual(rebased.eolCounts, fresh.counts, `breaks (seed ${seed})`);
    }
    for (let i = 0; i < rebased.count; i += 1) {
      const line = rebased.entries[2 * i];
      assert.equal(rebased.entries[2 * i + 1], fresh.starts[line - 1], `checkpoint of line ${line} (seed ${seed})`);
    }
  }
});

test('rebase drops checkpoints inside replaced ranges and shifts the others', () => {
  const doc = 'aa\nbb\ncc\ndd\nee\n'; // line starts 0, 3, 6, 9, 12, 15
  const index = scanAll(Buffer.from(doc, 'latin1'), { unit: 1, bigEndian: false, startByte: 0, every: 1 }, () => 100);
  assert.deepEqual(entriesOf(index), [1, 0, 2, 3, 3, 6, 4, 9, 5, 12, 6, 15]);
  // replace bytes [4, 10) ("b\ncc\nd") by "X\nY\nZ\nW" (3 breaks instead of 2): bytes +1, lines +1
  const edits: CpOverlayEdit[] = [{ start: 4, end: 10, byteDelta: 1, lineDelta: 1 }];
  const rebased = lineIndex.rebase(index, edits);
  // kept: (1,0), (2,3) (before the range); dropped: (3,6), (4,9); shifted: (5,12) -> (6,13), (6,15) -> (7,16)
  assert.deepEqual(entriesOf(rebased), [1, 0, 2, 3, 6, 13, 7, 16]);
  assert.equal(rebased.lines, 6);
  assert.equal(rebased.scannedBytes, 16);
  assert.ok(rebased.done);
});
