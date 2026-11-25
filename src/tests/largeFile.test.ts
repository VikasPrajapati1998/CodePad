/* Tests of largeFile.ts (the session manager) with real temp files and the real worker; no Electron needed. */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_SESSIONS, createLargeFiles } from '../largeFile';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepad-large-'));
const events: CpLargeEvent[] = [];
const OWNER = 1;

const deps = {
  resolveAllowed: async (p: string): Promise<string> => path.resolve(p),
  isSameFile: async (a: string, b: string): Promise<boolean> => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(),
  send: (event: CpLargeEvent): void => {
    events.push(event);
  },
  fallbackEncoding: (): string => 'windows-1252',
};

/** Small windows so a few KB of text needs several of them. */
const files = createLargeFiles({
  ...deps,
  limits: { windowTargetBytes: 200, snapBytes: 64, findChunkBytes: 300 },
});
const strict = createLargeFiles({ ...deps, limits: { maxCommitChars: 10 } });
const big = createLargeFiles(deps);

// Every test starts with no open file (the manager allows only MAX_SESSIONS at a time).
afterEach(async () => {
  await files.closeOwner(OWNER);
  await files.closeOwner(OWNER + 1);
});

after(async () => {
  await Promise.all([files.dispose(), strict.dispose(), big.dispose()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
let reqCounter = 0;
const nextReq = (): number => {
  reqCounter += 1;
  return reqCounter;
};

function tempFile(content: Buffer | string): string {
  counter += 1;
  const file = path.join(dir, `file-${counter}.txt`);
  fs.writeFileSync(file, content);
  return file;
}

function expectOk<T extends object>(result: CpLargeResult<T>): { ok: true } & T {
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function expectSaved(result: CpLargeSaveResult): CpFileStamp {
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

const lines = (count: number, eol = '\n'): string =>
  Array.from({ length: count }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`).join(eol) + eol;

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

const indexDone = (handle: string): boolean =>
  events.some((event) => event.handle === handle && event.type === 'index' && event.done);

async function open(content: Buffer | string, encoding: string | null = null): Promise<CpLargeOpenOk> {
  return expectOk(await files.open(OWNER, tempFile(content), { encoding }));
}

const windowAt = async (handle: string, target: CpLargeTarget, place: 'top' | 'center' = 'top'): Promise<CpLargeWindow> =>
  expectOk(await files.window(OWNER, handle, { reqId: nextReq(), target, place })).window;

async function replaceInWindow(handle: string, w: CpLargeWindow, from: string, to: string): Promise<CpLargeResult<{ changed: boolean; revision: number; dirty: boolean; window: CpLargeWindow }>> {
  assert.ok(w.text.includes(from));
  return files.commit(OWNER, handle, { windowId: w.windowId, revision: w.revision, text: w.text.replace(from, to) });
}

test('open gives a line-aligned first window with the index running', async () => {
  const content = lines(200);
  const opened = await open(content);
  const w = opened.window;
  assert.equal(opened.size, content.length);
  assert.equal(opened.encoding, 'utf8');
  assert.equal(opened.eol, 'lf');
  assert.equal(w.byteStart, 0);
  assert.ok(w.byteEnd >= 200 && w.byteEnd % 10 === 0 && w.byteEnd < content.length);
  assert.equal(w.text, content.slice(0, w.byteEnd));
  assert.equal(w.firstLine, 1);
  assert.equal(w.firstLineExact, true);
  assert.equal(w.atStart, true);
  assert.equal(w.atEnd, false);
  assert.equal(w.readOnly, null);
  await waitFor(() => indexDone(opened.handle), 'the index');
  expectOk(await files.window(OWNER, opened.handle, { reqId: nextReq(), target: { to: 'start' }, place: 'top' }));
});

test('windows at a line, a percentage, the end and a byte', async () => {
  const content = lines(200);
  const opened = await open(content);
  await waitFor(() => indexDone(opened.handle), 'the index');
  const atLine = await windowAt(opened.handle, { to: 'line', line: 150 }, 'center');
  assert.equal(atLine.text.split('\n')[atLine.anchorModelLine - 1], 'line 0150');
  assert.equal(atLine.firstLineExact, true);
  assert.equal(atLine.firstLine, atLine.byteStart / 10 + 1);
  assert.equal(atLine.index.done, true);
  assert.equal(atLine.index.totalLines, 201);
  const middle = await windowAt(opened.handle, { to: 'permille', permille: 500 });
  assert.ok(middle.text.includes('line 0101'));
  const tail = await windowAt(opened.handle, { to: 'end' });
  assert.equal(tail.atEnd, true);
  assert.equal(tail.byteEnd, content.length);
  assert.equal(tail.text.split('\n')[tail.anchorModelLine - 1], '');
  const byByte = await windowAt(opened.handle, { to: 'byte', byte: 1000 }, 'center');
  assert.equal(byByte.text.split('\n')[byByte.anchorModelLine - 1], 'line 0101');
  const located = expectOk(await files.locate(OWNER, opened.handle, byByte.windowId, byByte.anchorModelLine));
  assert.equal(located.line, 101);
  assert.equal(located.exact, true);
  assert.equal(located.anchor.byte, 1000);
});

test('find next, previous and count', async () => {
  const opened = await open(lines(200));
  await waitFor(() => indexDone(opened.handle), 'the index');
  const query = { text: 'line 0150', matchCase: true, wholeWord: false, regex: false };
  const next = expectOk(await files.find(OWNER, opened.handle, nextReq(), query, { byte: 0, sub: 0 }, 'next', true));
  assert.ok(next.match);
  assert.equal(next.match.anchor.byte, 1490);
  assert.equal(next.match.line, 150);
  assert.equal(next.match.column, 1);
  assert.equal(next.match.length, 9);
  assert.equal(next.wrapped, false);
  const previous = expectOk(await files.find(OWNER, opened.handle, nextReq(), query, { byte: 1490, sub: 0 }, 'prev', false));
  assert.equal(previous.match, null);
  const wrapped = expectOk(await files.find(OWNER, opened.handle, nextReq(), query, { byte: 1500, sub: 0 }, 'next', true));
  assert.equal(wrapped.wrapped, true);
  assert.equal(wrapped.match?.anchor.byte, 1490);
  const counted = expectOk(await files.count(OWNER, opened.handle, nextReq(), { ...query, text: 'line 0' }));
  assert.equal(counted.count, 200);
  assert.equal(counted.capped, false);
  const bad = await files.find(OWNER, opened.handle, nextReq(), { ...query, text: '(', regex: true }, { byte: 0, sub: 0 }, 'next', true);
  assert.equal(bad.ok, false);
});

test('edits commit, undo, redo and the streaming save equals the expected file', async () => {
  const content = lines(200);
  const file = tempFile(content);
  const opened = expectOk(await files.open(OWNER, file, null));
  const committed = expectOk(await replaceInWindow(opened.handle, opened.window, 'line 0003', 'LINE three!'));
  assert.equal(committed.changed, true);
  assert.equal(committed.dirty, true);
  const unchanged = expectOk(
    await files.commit(OWNER, opened.handle, {
      windowId: committed.window.windowId,
      revision: committed.window.revision,
      text: committed.window.text,
    }),
  );
  assert.equal(unchanged.changed, false);
  const start = await windowAt(opened.handle, { to: 'start' });
  assert.ok(start.text.includes('LINE three!'));
  assert.equal(start.firstLine, 1);

  const undone = expectOk(await files.undo(OWNER, opened.handle));
  assert.ok('dirty' in undone && undone.dirty === false);
  const afterUndo = await windowAt(opened.handle, { to: 'start' });
  assert.equal(afterUndo.text, opened.window.text);
  const redone = expectOk(await files.redo(OWNER, opened.handle));
  assert.ok('dirty' in redone && redone.dirty === true);
  const empty = expectOk(await files.redo(OWNER, opened.handle));
  assert.ok('empty' in empty);

  const saved = expectSaved(await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false }));
  const expected = content.replace('line 0003', 'LINE three!');
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  assert.equal(saved.size, expected.length);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  );
  const reread = await windowAt(opened.handle, { to: 'start' });
  assert.ok(reread.text.includes('LINE three!'));
  const again = expectSaved(await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false }));
  assert.equal(again.size, expected.length);
  await waitFor(() => indexDone(opened.handle), 'the index of the saved file');
});

test('an insertion with new lines keeps the line numbers after it', async () => {
  const content = lines(200);
  const file = tempFile(content);
  const opened = expectOk(await files.open(OWNER, file, null));
  expectOk(await replaceInWindow(opened.handle, opened.window, 'line 0002', 'a\nb\nc'));
  await waitFor(() => indexDone(opened.handle), 'the index');
  const later = await windowAt(opened.handle, { to: 'line', line: 152 }, 'center');
  assert.equal(later.text.split('\n')[later.anchorModelLine - 1], 'line 0150');
  expectSaved(await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false }));
  assert.equal(fs.readFileSync(file, 'utf8'), content.replace('line 0002', 'a\nb\nc'));
});

test('UTF-16 LE with CRLF keeps its line ends and BOM', async () => {
  const content = lines(60, '\r\n');
  const file = tempFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  const opened = expectOk(await files.open(OWNER, file, null));
  assert.equal(opened.encoding, 'utf16le');
  assert.equal(opened.eol, 'crlf');
  assert.ok(!opened.window.text.includes('\r'));
  assert.ok(opened.window.text.startsWith('line 0001\nline 0002\n'));
  expectOk(await replaceInWindow(opened.handle, opened.window, 'line 0002', 'x\ny'));
  expectSaved(await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false }));
  const written = fs.readFileSync(file);
  assert.deepEqual([...written.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(written.subarray(2).toString('utf16le'), content.replace('line 0002', 'x\r\ny'));
});

test('windows-1252 round trips and a lossy save is refused until allowed', async () => {
  const bytes = Buffer.concat([Buffer.from('caf', 'latin1'), Buffer.from([0xe9]), Buffer.from(`\n${lines(40)}`, 'latin1')]);
  const file = tempFile(bytes);
  const opened = expectOk(await files.open(OWNER, file, null));
  assert.equal(opened.encoding, 'windows-1252');
  assert.ok(opened.window.text.startsWith('café\n'));
  const lossy = await replaceInWindow(opened.handle, opened.window, 'line 0002', '漢');
  expectOk(lossy);
  const refused = await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.code, 'lossy');
  expectSaved(await files.save(OWNER, opened.handle, nextReq(), { allowLossy: true, overwriteReplaced: false }));
  const written = fs.readFileSync(file);
  assert.equal(written[3], 0xe9);
  assert.ok(written.toString('latin1').includes('?\nline 0003'));
});

test('Save As writes a new file, rebinds the session and leaves the original alone', async () => {
  const content = lines(50);
  const file = tempFile(content);
  const target = path.join(dir, 'copy.txt');
  const opened = expectOk(await files.open(OWNER, file, null));
  expectOk(await replaceInWindow(opened.handle, opened.window, 'line 0001', 'first'));
  expectSaved(await files.saveAs(OWNER, opened.handle, nextReq(), target, { allowLossy: false }));
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(fs.readFileSync(target, 'utf8'), content.replace('line 0001', 'first'));
  const view = await windowAt(opened.handle, { to: 'start' });
  assert.ok(view.text.startsWith('first\n'));
});

test('disk changes are classified', async () => {
  const content = lines(100);
  const file = tempFile(content);
  const opened = expectOk(await files.open(OWNER, file, null));
  assert.equal(expectOk(await files.refresh(OWNER, opened.handle)).kind, 'same');
  fs.appendFileSync(file, lines(10));
  const grown = expectOk(await files.refresh(OWNER, opened.handle));
  assert.equal(grown.kind, 'appended');
  assert.equal(grown.size, content.length + lines(10).length);
  await waitFor(
    () => events.some((e) => e.handle === opened.handle && e.type === 'index' && e.done && e.lines === 111),
    'the grown index',
  );
  fs.writeFileSync(file, 'short\n');
  assert.equal(expectOk(await files.refresh(OWNER, opened.handle)).kind, 'modified');
});

test('a file changed on disk while edited cannot be saved', async () => {
  const content = lines(100);
  const file = tempFile(content);
  const opened = expectOk(await files.open(OWNER, file, null));
  expectOk(await replaceInWindow(opened.handle, opened.window, 'line 0001', 'mine'));
  fs.writeFileSync(file, 'other\n');
  const result = await files.save(OWNER, opened.handle, nextReq(), { allowLossy: false, overwriteReplaced: false });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'changed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'other\n');
});

test('handles are opaque, bound to their window and validated', async () => {
  const opened = await open(lines(10));
  assert.match(opened.handle, /^[0-9a-f]{32}$/);
  const request = { reqId: nextReq(), target: { to: 'start' }, place: 'top' };
  for (const handle of ['nothex', '0'.repeat(32), 42, null]) {
    const result = await files.window(OWNER, handle, request);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'badHandle');
  }
  const other = await files.window(OWNER + 1, opened.handle, request);
  assert.equal(other.ok ? '' : other.code, 'badHandle');
  const invalid = await files.window(OWNER, opened.handle, { reqId: 0, target: { to: 'start' }, place: 'top' });
  assert.equal(invalid.ok ? '' : invalid.code, 'invalid');
  const stale = await files.commit(OWNER, opened.handle, { windowId: 9999, revision: 0, text: 'x' });
  assert.equal(stale.ok ? '' : stale.code, 'stale');
  assert.equal(await files.close(OWNER + 1, opened.handle), false);
  assert.equal(await files.close(OWNER, opened.handle), true);
  assert.equal(await files.close(OWNER, opened.handle), false);
});

test('caps: binary files, session limit and commit size', async () => {
  const binary = await files.open(OWNER, tempFile(Buffer.from([1, 2, 0, 3, 4, 0, 0, 5])), null);
  assert.equal(binary.ok ? '' : binary.code, 'binary');
  const missing = await files.open(OWNER, path.join(dir, 'missing.txt'), null);
  assert.equal(missing.ok ? '' : missing.code, 'ENOENT');
  const badEncoding = await files.open(OWNER, tempFile('x'), { encoding: 'nope' });
  assert.equal(badEncoding.ok ? '' : badEncoding.code, 'invalid');

  const crowded = createLargeFiles(deps);
  const file = tempFile('a\n');
  for (let i = 0; i < MAX_SESSIONS; i += 1) {
    expectOk(await crowded.open(OWNER, file, null));
  }
  const ninth = await crowded.open(OWNER, file, null);
  assert.equal(ninth.ok ? '' : ninth.code, 'limit');
  const otherWindow = await crowded.open(OWNER + 1, file, null);
  assert.equal(otherWindow.ok, true);
  await crowded.closeOwner(OWNER);
  expectOk(await crowded.open(OWNER, file, null));
  await crowded.dispose();

  const opened = expectOk(await strict.open(OWNER, tempFile(lines(5)), null));
  const tooLarge = await strict.commit(OWNER, opened.handle, {
    windowId: opened.window.windowId,
    revision: opened.window.revision,
    text: `${opened.window.text}${'x'.repeat(20)}`,
  });
  assert.equal(tooLarge.ok ? '' : tooLarge.code, 'tooLarge');
});

test('a 50 MB single line opens fast as a view-only long-line window', async () => {
  const file = tempFile(Buffer.alloc(50 * 1024 * 1024, 97));
  const started = Date.now();
  const opened = expectOk(await big.open(OWNER, file, null));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(opened.window.readOnly, 'longLine');
  assert.ok(opened.window.continuation.length > 0);
  assert.ok(opened.window.text.length <= 4 * 1024 * 1024);
  const refused = await big.commit(OWNER, opened.handle, {
    windowId: opened.window.windowId,
    revision: opened.window.revision,
    text: 'changed',
  });
  assert.equal(refused.ok ? '' : refused.code, 'readOnly');
  const middle = expectOk(await big.window(OWNER, opened.handle, { reqId: nextReq(), target: { to: 'permille', permille: 500 }, place: 'center' }));
  assert.equal(middle.window.readOnly, 'longLine');
  assert.ok(middle.window.byteStart > 20 * 1024 * 1024 && middle.window.byteStart < 30 * 1024 * 1024);
});
