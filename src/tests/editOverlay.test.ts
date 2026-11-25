/* Tests of shared/editOverlay.ts (edit overlay of the large-file mode). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const overlay: CodePadEditOverlayApi = require('../shared/editOverlay');

function change(start: number, end: number, text: string, origLines = 0): CpOverlayChange {
  return { start, end, text, bytes: Buffer.byteLength(text), origLines, newLines: 0 };
}

function applyOk(o: CpOverlay, c: CpOverlayChange): CpOverlayTransaction {
  const result = overlay.apply(o, c);
  if (!result.ok) {
    return assert.fail(`apply [${c.start}, ${c.end}) failed with ${result.code}`);
  }
  return result.transaction;
}

function applyCode(o: CpOverlay, c: CpOverlayChange): string {
  const result = overlay.apply(o, c);
  return result.ok ? 'ok' : result.code;
}

function shape(o: CpOverlay): Array<[number, number, string]> {
  return o.items.map((item): [number, number, string] => [item.start, item.end, item.text]);
}

function transactionChars(tx: CpOverlayTransaction): number {
  return [...tx.removed, ...tx.added].reduce((sum, item) => sum + item.text.length, 0);
}

function checkInvariants(o: CpOverlay): void {
  let previousEnd = 0;
  let live = 0;
  for (const item of o.items) {
    assert.ok(item.end >= item.start && item.start >= previousEnd, 'sorted and disjoint');
    assert.equal(item.newLines, item.text.split('\n').length - 1);
    previousEnd = item.end;
    live += item.text.length;
  }
  assert.equal(o.liveChars, live, 'liveChars');
  const stacked = [...o.undoStack, ...o.redoStack].reduce((sum, tx) => sum + transactionChars(tx), 0);
  assert.equal(o.undoChars, stacked, 'undoChars');
}

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

test('a new overlay is clean and empty', () => {
  const o = overlay.create();
  assert.deepEqual(shape(o), []);
  assert.equal(o.revision, 0);
  assert.equal(o.savedRevision, 0);
  assert.equal(overlay.isDirty(o), false);
  assert.equal(o.liveChars, 0);
  assert.equal(overlay.undo(o), null);
  assert.equal(overlay.redo(o), null);
  assert.deepEqual(overlay.savePlan(o, 5), [{ copy: [0, 5] }]);
  assert.deepEqual(overlay.savePlan(o, 0), []);
});

test('disjoint replacements stay sorted', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'AB'));
  applyOk(o, change(30, 40, 'C'));
  applyOk(o, change(0, 5, 'Z'));
  assert.deepEqual(shape(o), [[0, 5, 'Z'], [10, 20, 'AB'], [30, 40, 'C']]);
  assert.equal(o.liveChars, 4);
  assert.equal(o.revision, 3);
  assert.ok(overlay.isDirty(o));
  checkInvariants(o);
});

test('adjacent replacements stay separate and the save plan covers the file', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'X'));
  applyOk(o, change(20, 30, 'Y'));
  assert.deepEqual(shape(o), [[10, 20, 'X'], [20, 30, 'Y']]);
  assert.deepEqual(overlay.savePlan(o, 40), [{ copy: [0, 10] }, { text: 'X' }, { text: 'Y' }, { copy: [30, 40] }]);
  checkInvariants(o);
});

test('a covering change replaces the replacements inside it', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  applyOk(o, change(30, 40, 'b'));
  const tx = applyOk(o, change(5, 45, 'ALL'));
  assert.deepEqual(shape(o), [[5, 45, 'ALL']]);
  assert.equal(tx.removed.length, 2);
  assert.equal(tx.added.length, 1);
  assert.equal(tx.at, 5);
  assert.equal(o.liveChars, 3);
  checkInvariants(o);
});

test('a change that cuts a replacement is invalid and changes nothing', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  const revision = o.revision;
  assert.equal(applyCode(o, change(15, 25, 'x')), 'invalid');
  assert.equal(applyCode(o, change(5, 15, 'x')), 'invalid');
  assert.equal(applyCode(o, change(12, 18, 'x')), 'invalid');
  assert.equal(applyCode(o, change(9, 9, '')), 'invalid');
  assert.equal(applyCode(o, change(20, 10, 'x')), 'invalid');
  assert.equal(applyCode(o, change(-1, 3, 'x')), 'invalid');
  assert.deepEqual(shape(o), [[10, 20, 'a']]);
  assert.equal(o.revision, revision);
  // snapping makes the same change valid
  const range = overlay.snap(o, 15, 25);
  assert.deepEqual(range, { start: 10, end: 25 });
  assert.equal(applyCode(o, change(range.start, range.end, 'x')), 'ok');
  assert.deepEqual(shape(o), [[10, 25, 'x']]);
});

test('insertions: a zero-length replacement is covered by a change at its point', () => {
  const o = overlay.create();
  applyOk(o, change(10, 10, 'abc'));
  assert.deepEqual(shape(o), [[10, 10, 'abc']]);
  applyOk(o, change(10, 10, 'abcd'));
  assert.deepEqual(shape(o), [[10, 10, 'abcd']]);
  assert.equal(o.liveChars, 4);
  // deleting the inserted text removes the replacement
  const tx = applyOk(o, change(10, 10, ''));
  assert.deepEqual(shape(o), []);
  assert.equal(tx.removed.length, 1);
  assert.equal(tx.added.length, 0);
  assert.equal(applyCode(o, change(10, 10, '')), 'invalid');
  checkInvariants(o);
  // an insertion on the edge of a longer range is covered, a replacement starting at the end is not
  applyOk(o, change(10, 10, 'i'));
  applyOk(o, change(20, 30, 'T'));
  applyOk(o, change(10, 20, 'N'));
  assert.deepEqual(shape(o), [[10, 20, 'N'], [20, 30, 'T']]);
  checkInvariants(o);
});

test('a deletion is a replacement with empty text', () => {
  const o = overlay.create();
  applyOk(o, { start: 10, end: 20, text: '', bytes: 0, origLines: 2, newLines: 0 });
  assert.deepEqual(shape(o), [[10, 20, '']]);
  assert.deepEqual(overlay.savePlan(o, 30), [{ copy: [0, 10] }, { copy: [20, 30] }]);
  assert.deepEqual(overlay.edits(o), [{ start: 10, end: 20, byteDelta: -10, lineDelta: -2 }]);
});

test('an insertion at the end of the file is part of the save plan', () => {
  const o = overlay.create();
  applyOk(o, change(30, 30, 'tail'));
  assert.deepEqual(overlay.savePlan(o, 30), [{ copy: [0, 30] }, { text: 'tail' }]);
});

test('undo and redo restore the exact items', () => {
  const o = overlay.create();
  const snapshots: string[] = [JSON.stringify(shape(o))];
  applyOk(o, change(10, 20, 'a'));
  snapshots.push(JSON.stringify(shape(o)));
  applyOk(o, change(30, 40, 'b'));
  snapshots.push(JSON.stringify(shape(o)));
  applyOk(o, change(5, 45, 'C'));
  snapshots.push(JSON.stringify(shape(o)));
  assert.equal(o.revision, 3);
  for (let step = 3; step >= 1; step -= 1) {
    const tx = overlay.undo(o);
    assert.ok(tx);
    assert.equal(JSON.stringify(shape(o)), snapshots[step - 1]);
    assert.equal(o.revision, step - 1);
    checkInvariants(o);
  }
  assert.equal(overlay.undo(o), null);
  for (let step = 1; step <= 3; step += 1) {
    assert.ok(overlay.redo(o));
    assert.equal(JSON.stringify(shape(o)), snapshots[step]);
    checkInvariants(o);
  }
  assert.equal(overlay.redo(o), null);
});

test('a new change clears the redo stack', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  applyOk(o, change(30, 40, 'b'));
  assert.ok(overlay.undo(o));
  assert.equal(o.redoStack.length, 1);
  applyOk(o, change(60, 70, 'd'));
  assert.equal(o.redoStack.length, 0);
  assert.equal(overlay.redo(o), null);
  assert.deepEqual(shape(o), [[10, 20, 'a'], [60, 70, 'd']]);
  checkInvariants(o);
});

test('dirty follows the history position and markSaved starts a new baseline', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  assert.ok(overlay.isDirty(o));
  assert.ok(overlay.undo(o));
  assert.equal(overlay.isDirty(o), false);
  assert.ok(overlay.redo(o));
  assert.ok(overlay.isDirty(o));
  applyOk(o, change(30, 40, 'b'));
  overlay.markSaved(o);
  assert.deepEqual(shape(o), []);
  assert.equal(o.undoStack.length, 0);
  assert.equal(o.redoStack.length, 0);
  assert.equal(o.liveChars, 0);
  assert.equal(o.undoChars, 0);
  assert.equal(o.savedRevision, o.revision);
  assert.equal(overlay.isDirty(o), false);
  applyOk(o, change(1, 2, 'z'));
  assert.ok(overlay.isDirty(o));
  assert.ok(overlay.undo(o));
  assert.equal(overlay.isDirty(o), false);
  assert.equal(overlay.undo(o), null);
});

test('limits: live text, undo steps and undo text', () => {
  const live = overlay.create({ maxLiveChars: 10 });
  applyOk(live, change(0, 1, 'xxxxxx'));
  assert.equal(applyCode(live, change(5, 6, 'yyyyyy')), 'tooLarge');
  assert.deepEqual(shape(live), [[0, 1, 'xxxxxx']]);
  assert.equal(live.revision, 1);
  assert.equal(live.undoStack.length, 1);
  assert.equal(applyCode(live, change(0, 10, 'zzzzzzzzzz')), 'ok');
  assert.equal(live.liveChars, 10);

  const steps = overlay.create({ maxUndoSteps: 3 });
  for (let i = 0; i < 5; i += 1) {
    applyOk(steps, change(i * 10, i * 10 + 1, 'a'));
  }
  assert.equal(steps.undoStack.length, 3);
  assert.equal(steps.revision, 5);
  checkInvariants(steps);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(overlay.undo(steps));
  }
  assert.equal(overlay.undo(steps), null);
  assert.equal(steps.items.length, 2);
  assert.equal(steps.revision, 2);

  const chars = overlay.create({ maxUndoChars: 10 });
  for (let i = 0; i < 3; i += 1) {
    applyOk(chars, change(i * 10, i * 10 + 1, 'aaaa'));
  }
  assert.equal(chars.undoStack.length, 2);
  assert.equal(chars.undoChars, 8);
  checkInvariants(chars);

  const huge = overlay.create({ maxUndoChars: 2 });
  applyOk(huge, change(0, 1, 'hhhhh'));
  assert.equal(huge.undoStack.length, 1);
  assert.equal(huge.undoChars, 5);
});

test('line and byte deltas and the edit list', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a\nb\nc', 1)); // +1 line, -5 bytes
  applyOk(o, change(30, 30, 'x\n', 0)); // +1 line, +2 bytes
  applyOk(o, { start: 40, end: 50, text: '', bytes: 0, origLines: 3, newLines: 0 }); // -3 lines, -10 bytes
  const lines: Array<[number, number]> = [[9, 0], [10, 0], [19, 0], [20, 1], [29, 1], [30, 2], [49, 2], [50, -1], [1000, -1]];
  for (const [byte, expected] of lines) {
    assert.equal(overlay.lineDeltaBefore(o, byte), expected, `line delta before ${byte}`);
  }
  const bytes: Array<[number, number]> = [[19, 0], [20, -5], [30, -3], [49, -3], [50, -13]];
  for (const [byte, expected] of bytes) {
    assert.equal(overlay.byteDeltaBefore(o, byte), expected, `byte delta before ${byte}`);
  }
  assert.deepEqual(overlay.edits(o), [
    { start: 10, end: 20, byteDelta: -5, lineDelta: 1 },
    { start: 30, end: 30, byteDelta: 2, lineDelta: 1 },
    { start: 40, end: 50, byteDelta: -10, lineDelta: -3 },
  ]);
});

test('snap widens only to whole replacements that are cut', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  applyOk(o, change(30, 40, 'b'));
  assert.deepEqual(overlay.snap(o, 12, 35), { start: 10, end: 40 });
  assert.deepEqual(overlay.snap(o, 20, 30), { start: 20, end: 30 });
  assert.deepEqual(overlay.snap(o, 5, 10), { start: 5, end: 10 });
  assert.deepEqual(overlay.snap(o, 15, 15), { start: 10, end: 20 });
  assert.deepEqual(overlay.snap(o, 0, 100), { start: 0, end: 100 });
});

test('within returns the replacements that intersect a range', () => {
  const o = overlay.create();
  applyOk(o, change(10, 20, 'a'));
  applyOk(o, change(30, 40, 'b'));
  applyOk(o, change(50, 50, 'i'));
  const starts = (start: number, end: number): number[] => overlay.within(o, start, end).map((item) => item.start);
  assert.deepEqual(starts(0, 10), []);
  assert.deepEqual(starts(0, 11), [10]);
  assert.deepEqual(starts(15, 35), [10, 30]);
  assert.deepEqual(starts(40, 50), [50]);
  assert.deepEqual(starts(41, 49), []);
  assert.deepEqual(starts(50, 60), [50]);
});

/** Original file of 20 lines of 10 bytes: line L starts at byte (L - 1) * 10. */
function fixedStarts(known: number): (line: number) => number | null {
  return (line: number): number | null => (line >= 1 && line <= known ? (line - 1) * 10 : null);
}

function fixedOverlay(): CpOverlay {
  const o = overlay.create();
  applyOk(o, change(10, 30, 'p\nq\nr\ns', 2)); // 2 -> 3 breaks: +1 line, text starts on line 2
  applyOk(o, change(55, 55, 'z\ny', 0)); // insertion in line 6: +1 line
  applyOk(o, { start: 100, end: 120, text: '', bytes: 0, origLines: 2, newLines: 0 }); // deletes 2 breaks
  return o;
}

test('docLineToAnchor on a fixed overlay', () => {
  const o = fixedOverlay();
  const start = fixedStarts(20);
  const expected: Array<[number, CpLargeAnchor | null]> = [
    [1, { byte: 0, sub: 0 }],
    [2, { byte: 10, sub: 0 }],
    [3, { byte: 10, sub: 1 }],
    [4, { byte: 10, sub: 2 }],
    [5, { byte: 10, sub: 3 }],
    [6, { byte: 40, sub: 0 }],
    [7, { byte: 50, sub: 0 }],
    [8, { byte: 55, sub: 1 }],
    [9, { byte: 60, sub: 0 }],
    [13, { byte: 100, sub: 0 }],
    [14, { byte: 130, sub: 0 }],
    [21, null],
    [0, null],
  ];
  for (const [line, anchor] of expected) {
    assert.deepEqual(overlay.docLineToAnchor(o, line, start), anchor, `doc line ${line}`);
  }
});

test('docLineToAnchor with a partly scanned index', () => {
  const o = fixedOverlay();
  const start = fixedStarts(8);
  assert.deepEqual(overlay.docLineToAnchor(o, 8, start), { byte: 55, sub: 1 });
  assert.deepEqual(overlay.docLineToAnchor(o, 9, start), { byte: 60, sub: 0 });
  assert.equal(overlay.docLineToAnchor(o, 13, start), null);
});

/** Candidate doc positions (ASCII: bytes are chars) that an anchor can mean. */
function anchorPositions(items: readonly CpOverlayReplacement[], anchor: CpLargeAnchor): number[] {
  const positions: number[] = [];
  if (anchor.sub === 0) {
    let position = anchor.byte;
    for (const item of items) {
      if (item.start < anchor.byte && item.end <= anchor.byte) {
        position += item.text.length - (item.end - item.start);
      }
    }
    positions.push(position);
    return positions;
  }
  let shift = 0;
  for (const item of items) {
    if (item.start === anchor.byte && item.newLines >= anchor.sub) {
      let index = -1;
      for (let i = 0; i < anchor.sub; i += 1) {
        index = item.text.indexOf('\n', index + 1);
      }
      positions.push(item.start + shift + index + 1);
    }
    shift += item.text.length - (item.end - item.start);
  }
  return positions;
}

test('docLineToAnchor resolves every line of random edited documents', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = seeded(seed * 977);
    const lineTexts: string[] = [];
    const lineCount = 1 + Math.floor(rand() * 14);
    for (let i = 0; i < lineCount; i += 1) {
      lineTexts.push('abcdef'.slice(0, Math.floor(rand() * 7)));
    }
    const original = lineTexts.join('\n') + (rand() < 0.5 ? '\n' : '');
    const origStarts = [0];
    for (let i = 0; i < original.length; i += 1) {
      if (original[i] === '\n') {
        origStarts.push(i + 1);
      }
    }
    const o = overlay.create();
    const edits = Math.floor(rand() * 6);
    for (let i = 0; i < edits; i += 1) {
      const a = Math.floor(rand() * (original.length + 1));
      const b = Math.floor(rand() * (original.length + 1));
      const range = overlay.snap(o, Math.min(a, b), Math.max(a, b));
      let text = '';
      const parts = Math.floor(rand() * 4);
      for (let part = 0; part < parts; part += 1) {
        text += rand() < 0.5 ? 'xy'.slice(0, 1 + Math.floor(rand() * 2)) : '\n';
      }
      const origLines = original.slice(range.start, range.end).split('\n').length - 1;
      overlay.apply(o, { start: range.start, end: range.end, text, bytes: text.length, origLines, newLines: 0 });
    }
    if (rand() < 0.3) {
      overlay.undo(o);
    }
    let doc = '';
    let position = 0;
    for (const item of o.items) {
      doc += original.slice(position, item.start) + item.text;
      position = item.end;
    }
    doc += original.slice(position);
    const total = doc.split('\n').length;
    const start = (line: number): number | null => (line >= 1 && line <= origStarts.length ? origStarts[line - 1] : null);
    for (let line = 1; line <= total; line += 1) {
      const anchor = overlay.docLineToAnchor(o, line, start);
      assert.ok(anchor, `doc line ${line} (seed ${seed})`);
      if (!anchor) {
        continue;
      }
      const valid = anchorPositions(o.items, anchor).some((pos) => (pos === 0 || doc[pos - 1] === '\n') && doc.slice(0, pos).split('\n').length === line);
      assert.ok(valid, `anchor ${JSON.stringify(anchor)} of doc line ${line} (seed ${seed})`);
    }
    assert.equal(overlay.docLineToAnchor(o, total + 1, start), null, `beyond the end (seed ${seed})`);
    // the line bookkeeping matches the naive document
    assert.equal(origStarts.length + overlay.lineDeltaBefore(o, original.length + 1), total, `line total (seed ${seed})`);
  }
});

/* ---------------------------------------------------------------- save equivalence */

interface Plain {
  start: number;
  end: number;
  text: string;
}

/** Naive model of an apply on a list of plain replacements; null when the overlay must answer 'invalid'. */
function naiveApply(items: readonly Plain[], start: number, end: number, text: string): Plain[] | null {
  for (const item of items) {
    if ((item.start < start && item.end > start) || (item.start < end && item.end > end)) {
      return null;
    }
  }
  const covered = items.filter((item) => item.start >= start && item.end <= end);
  const rest = items.filter((item) => !(item.start >= start && item.end <= end));
  const nothing = text === '' && start === end;
  if (nothing && covered.length === 0) {
    return null;
  }
  const next = nothing ? rest : [...rest, { start, end, text }];
  return next.sort((a, b) => a.start - b.start || a.end - b.end);
}

function naiveSave(original: Buffer, items: readonly Plain[]): Buffer {
  const parts: Buffer[] = [];
  let position = 0;
  for (const item of items) {
    parts.push(original.subarray(position, item.start), Buffer.from(item.text, 'utf8'));
    position = item.end;
  }
  parts.push(original.subarray(position));
  return Buffer.concat(parts);
}

/** Runs the save plan through a reader that hands out `chunk` bytes at a time. */
function streamPlan(plan: readonly CpSaveStep[], original: Buffer, chunk: number): Buffer {
  const parts: Buffer[] = [];
  for (const step of plan) {
    if ('copy' in step) {
      const [from, to] = step.copy;
      for (let position = from; position < to; position += chunk) {
        parts.push(Buffer.from(original.subarray(position, Math.min(position + chunk, to))));
      }
    } else {
      parts.push(Buffer.from(step.text, 'utf8'));
    }
  }
  return Buffer.concat(parts);
}

test('property: the streamed save equals the naive in-memory result', () => {
  const pieces = ['a', 'bc', 'é', '日本', '😀', ' ', '\r\n', '\n', '\r', 'x'];
  const texts = ['', 'q', 'rs', '€', '😁', '\n', 'a\nb', '\r\n', 'ééé'];
  for (let seed = 1; seed <= 500; seed += 1) {
    const rand = seeded(seed * 2654435761);
    let originalText = '';
    const length = Math.floor(rand() * 40);
    for (let i = 0; i < length; i += 1) {
      originalText += pieces[Math.floor(rand() * pieces.length)];
    }
    const original = Buffer.from(originalText, 'utf8');
    const boundaries: number[] = [0];
    let offset = 0;
    for (const character of originalText) {
      offset += Buffer.byteLength(character);
      boundaries.push(offset);
    }
    const o = overlay.create();
    let truth: Plain[] = [];
    const undoHistory: Plain[][] = [];
    const redoHistory: Plain[][] = [];
    const operations = 1 + Math.floor(rand() * 25);
    for (let step = 0; step < operations; step += 1) {
      const roll = rand();
      if (roll < 0.7) {
        const a = boundaries[Math.floor(rand() * boundaries.length)];
        const b = boundaries[Math.floor(rand() * boundaries.length)];
        const range = overlay.snap(o, Math.min(a, b), Math.max(a, b));
        let text = '';
        const parts = Math.floor(rand() * 3);
        for (let part = 0; part < parts; part += 1) {
          text += texts[Math.floor(rand() * texts.length)];
        }
        const expected = naiveApply(truth, range.start, range.end, text);
        const origLines = original.subarray(range.start, range.end).toString('utf8').split('\n').length - 1;
        const result = overlay.apply(o, { start: range.start, end: range.end, text, bytes: Buffer.byteLength(text), origLines, newLines: 0 });
        assert.equal(result.ok, expected !== null, `apply agreement (seed ${seed}, step ${step})`);
        if (expected) {
          undoHistory.push(truth);
          redoHistory.length = 0;
          truth = expected;
        }
      } else if (roll < 0.85) {
        const tx = overlay.undo(o);
        const previous = undoHistory.pop();
        assert.equal(tx !== null, previous !== undefined, `undo agreement (seed ${seed})`);
        if (previous) {
          redoHistory.push(truth);
          truth = previous;
        }
      } else {
        const tx = overlay.redo(o);
        const next = redoHistory.pop();
        assert.equal(tx !== null, next !== undefined, `redo agreement (seed ${seed})`);
        if (next) {
          undoHistory.push(truth);
          truth = next;
        }
      }
      checkInvariants(o);
      assert.deepEqual(shape(o), truth.map((item): [number, number, string] => [item.start, item.end, item.text]), `items (seed ${seed}, step ${step})`);
      const expectedBytes = naiveSave(original, truth);
      assert.ok(streamPlan(overlay.savePlan(o, original.length), original, 7).equals(expectedBytes), `save with chunk 7 (seed ${seed}, step ${step})`);
    }
    const plan = overlay.savePlan(o, original.length);
    const expectedBytes = naiveSave(original, truth);
    for (const chunk of [1, 7, 1048576]) {
      assert.ok(streamPlan(plan, original, chunk).equals(expectedBytes), `save with chunk ${chunk} (seed ${seed})`);
    }
    // the byte and line bookkeeping adds up to the saved size
    const size = original.length + overlay.byteDeltaBefore(o, original.length);
    assert.equal(size, expectedBytes.length, `size (seed ${seed})`);
  }
});
