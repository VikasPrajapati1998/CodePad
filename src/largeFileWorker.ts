/*
 * Large-file worker (worker_threads), one per open large file. It scans the line index in chunks and runs searches
 * (find next/previous, count) over the edited document, so a pathological regex only ever blocks this thread and
 * the parent can terminate it. See largeFile.ts for the protocol.
 */
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { parentPort, workerData } from 'worker_threads';
import { errorMessage } from './errorUtils';
import {
  MAX_COUNT,
  MAX_MATCH_CHARS,
  SCAN_CHUNK_BYTES,
  anchorAtChar,
  applySnapshot,
  boundaryKind,
  composeRange,
  itemsWithin,
  normalizeBreaks,
  origByteAt,
  readFully,
  segmentAt,
  snapRange,
  snapshotOf,
} from './largeFile';
import type { Composed, FromWorker, ReadEnv, ToWorker, WorkerInit, WorkerMatch } from './largeFile';
import * as textCodec from './textCodec';

const lineApi: CodePadLineIndexApi = require('./shared/lineIndex');
const searchCore: CodePadSearchCoreApi = require('./shared/searchCore');

if (!parentPort) {
  throw new Error('largeFileWorker must run in a worker thread.');
}
const port = parentPort;

const INDEX_POST_MS = 250;
const PROGRESS_POST_MS = 100;
/** Bytes re-read before a region that starts inside a long line, so a match across the cut is still found. */
const OVERLAP_BYTES = MAX_MATCH_CHARS * 4;

const init = workerData as WorkerInit;
const indexOptions = { unit: init.unit, bigEndian: init.bigEndian, startByte: init.startByte };

let filePath = init.path;
let size = init.size;
let fd: FileHandle | null = null;
let index = lineApi.create(indexOptions);
let readPos = init.startByte;
let scanning = false;
let abortScan = false;
const cancelled = new Set<number>();

if (init.snapshot) {
  applySnapshot(index, init.snapshot);
  readPos = init.snapshot.readPos;
}

const post = (message: FromWorker): void => port.postMessage(message);

async function openFile(): Promise<FileHandle> {
  if (!fd) {
    fd = await fsp.open(filePath, 'r');
  }
  return fd;
}

async function closeFile(): Promise<void> {
  const old = fd;
  fd = null;
  if (old) {
    await old.close().catch(() => undefined);
  }
}

function env(): ReadEnv {
  return {
    unit: init.unit,
    bigEndian: init.bigEndian,
    kind: init.kind,
    encoding: init.encoding,
    size,
    startByte: init.startByte,
    read: async (start, end) => readFully(await openFile(), start, end),
  };
}

// ---------- Index scan ----------

async function runScan(): Promise<void> {
  if (scanning) {
    return;
  }
  scanning = true;
  abortScan = false;
  let lastPost = Date.now();
  try {
    const file = await openFile();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    while (!abortScan && readPos < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(SCAN_CHUNK_BYTES, size - readPos), readPos);
      if (bytesRead === 0) {
        size = readPos;
        break;
      }
      lineApi.scanChunk(index, buffer.subarray(0, bytesRead), readPos);
      readPos += bytesRead;
      if (Date.now() - lastPost >= INDEX_POST_MS) {
        post({ type: 'index', snapshot: snapshotOf(index, readPos) });
        lastPost = Date.now();
      }
    }
    if (!abortScan && readPos >= size && !index.done) {
      lineApi.finish(index, size);
    }
  } catch (error) {
    console.error(`The line index scan stopped: ${errorMessage(error)}`);
  } finally {
    scanning = false;
  }
  post({ type: 'index', snapshot: snapshotOf(index, readPos) });
  post({ type: 'scanDone' });
}

// ---------- Search ----------

class Cancelled extends Error {}

interface SearchJob {
  reqId: number;
  re: RegExp;
  /** Same pattern without the global flag: a quick "does this region contain anything" test. */
  quick: RegExp;
  items: readonly CpOverlayReplacement[];
  lastProgress: number;
}

interface Hit {
  comp: Composed;
  lineStart: number;
  lineEnd: number;
  at: number;
  length: number;
}

function makeJob(reqId: number, query: CpLargeFindQuery, items: readonly CpOverlayReplacement[]): SearchJob | string {
  const built = searchCore.buildMatcher({
    query: query.text,
    isRegex: query.regex,
    matchCase: query.matchCase,
    wholeWord: query.wholeWord,
  });
  if ('error' in built) {
    return built.error;
  }
  const { source, flags } = built.regex;
  return {
    reqId,
    re: new RegExp(source, flags.includes('g') ? flags : `${flags}g`),
    quick: new RegExp(source, flags.replace(/[gy]/g, '')),
    items,
    lastProgress: 0,
  };
}

function check(job: SearchJob): void {
  if (cancelled.has(job.reqId)) {
    throw new Cancelled('The search was cancelled.');
  }
}

function report(job: SearchJob, done: number, total: number): void {
  const now = Date.now();
  if (now - job.lastProgress >= PROGRESS_POST_MS) {
    job.lastProgress = now;
    post({ type: 'progress', reqId: job.reqId, permille: Math.min(1000, Math.floor((done * 1000) / Math.max(1, total))) });
  }
}

/** Calls `visit` for every non-empty match that ends after `skipChars` (earlier ones were found by the previous region). */
function eachMatch(comp: Composed, job: SearchJob, skipChars: number, visit: (hit: Hit) => boolean): boolean {
  if (!job.quick.test(comp.text)) {
    return false;
  }
  const { text, lineChars } = comp;
  for (let n = 0; n < lineChars.length; n += 1) {
    const lineStart = lineChars[n];
    const lineEnd = n + 1 < lineChars.length ? lineChars[n + 1] - 1 : text.length;
    if (lineEnd <= lineStart || lineEnd <= skipChars) {
      continue;
    }
    const line = text.slice(lineStart, lineEnd);
    job.re.lastIndex = 0;
    let match = job.re.exec(line);
    while (match !== null) {
      if (match[0].length === 0) {
        job.re.lastIndex += 1;
      } else if (lineStart + match.index + match[0].length > skipChars) {
        if (visit({ comp, lineStart, lineEnd, at: lineStart + match.index, length: match[0].length })) {
          return true;
        }
      }
      match = job.re.exec(line);
    }
  }
  return false;
}

/** The last match of a region, or null. */
function lastMatch(comp: Composed, job: SearchJob): Hit | null {
  if (!job.quick.test(comp.text)) {
    return null;
  }
  const { text, lineChars } = comp;
  for (let n = lineChars.length - 1; n >= 0; n -= 1) {
    const lineStart = lineChars[n];
    const lineEnd = n + 1 < lineChars.length ? lineChars[n + 1] - 1 : text.length;
    if (lineEnd <= lineStart) {
      continue;
    }
    const line = text.slice(lineStart, lineEnd);
    job.re.lastIndex = 0;
    let found: Hit | null = null;
    let match = job.re.exec(line);
    while (match !== null) {
      if (match[0].length === 0) {
        job.re.lastIndex += 1;
      } else {
        found = { comp, lineStart, lineEnd, at: lineStart + match.index, length: match[0].length };
      }
      match = job.re.exec(line);
    }
    if (found) {
      return found;
    }
  }
  return null;
}

/** Position of a hit: its line anchor and column, or (inside a long line) the exact byte of the match. */
function matchOf(hit: Hit): WorkerMatch {
  const { comp, lineStart, lineEnd, at, length } = hit;
  if (lineEnd - lineStart > init.segmentChars) {
    const segment = segmentAt(comp, at);
    if (segment && segment.kind === 'orig') {
      return { byte: origByteAt(segment, comp.text, at, init.encoding), sub: 0, column: 1, length: 0 };
    }
    const anchor = anchorAtChar(comp, lineStart);
    return { byte: anchor.byte, sub: anchor.sub, column: 1, length: 0 };
  }
  const anchor = anchorAtChar(comp, lineStart);
  return { byte: anchor.byte, sub: anchor.sub, column: at - lineStart + 1, length };
}

/** Regions of about `findChunkBytes` over [a, b) in file order; `visit` returns true to stop. */
async function walkForward(
  job: SearchJob,
  a: number,
  b: number,
  progressBase: number,
  progressTotal: number,
  visit: (hit: Hit) => boolean,
): Promise<boolean> {
  let pos = a;
  let carry = false;
  while (pos < b) {
    check(job);
    const e = env();
    let start = pos;
    let skipChars = 0;
    if (carry) {
      const wanted = Math.max(a, pos - OVERLAP_BYTES);
      const from = Math.max(init.startByte, wanted - 4);
      const data = await e.read(from, pos);
      start = Math.max(a, from + lineApi.safeBoundary(data, wanted - from, boundaryKind(init.kind)));
      skipChars = normalizeBreaks(textCodec.decode(await e.read(start, pos), init.encoding).content).length;
    }
    const target = Math.min(b, pos + init.findChunkBytes);
    const snap = await snapRange(e, job.items, start, target, init.snapBytes, false, target < b);
    const end = Math.max(snap.be, Math.min(b, pos + e.unit));
    const comp = await composeRange(e, itemsWithin(job.items, start, end), start, end, 0);
    if (eachMatch(comp, job, skipChars, visit)) {
      return true;
    }
    carry = snap.endMid;
    pos = end;
    report(job, progressBase + (pos - a), progressTotal);
  }
  return false;
}

/** The last match in [a, b), reading regions from the end. */
async function walkBackward(job: SearchJob, a: number, b: number, progressBase: number, progressTotal: number): Promise<WorkerMatch | null> {
  let end = b;
  let extend = false;
  while (end > a) {
    check(job);
    const e = env();
    const snap = await snapRange(e, job.items, Math.max(a, end - init.findChunkBytes), end, init.snapBytes, true, false);
    const start = Math.min(Math.max(a, snap.bs), end - e.unit);
    const stop = extend ? Math.min(e.size, end + OVERLAP_BYTES) : end;
    const comp = await composeRange(e, itemsWithin(job.items, start, stop), start, stop, 0);
    const found = lastMatch(comp, job);
    if (found) {
      return matchOf(found);
    }
    extend = snap.startMid;
    end = start;
    report(job, progressBase + (b - end), progressTotal);
  }
  return null;
}

function clampByte(byte: number): number {
  return Math.min(Math.max(byte, init.startByte), size);
}

async function runFind(message: Extract<ToWorker, { type: 'find' }>): Promise<void> {
  const { reqId, direction, wrap } = message;
  const job = makeJob(reqId, message.query, message.items);
  if (typeof job === 'string') {
    post({ type: 'failed', reqId, code: 'invalid', message: job });
    return;
  }
  const from = clampByte(message.from.byte);
  const total = Math.max(1, size - init.startByte);
  const result: { match: WorkerMatch | null } = { match: null };
  let wrapped = false;
  if (direction === 'next') {
    await walkForward(job, from, size, 0, total, (hit) => {
      result.match = matchOf(hit);
      return true;
    });
    if (result.match === null && wrap && from > init.startByte) {
      wrapped = true;
      await walkForward(job, init.startByte, from, size - from, total, (hit) => {
        result.match = matchOf(hit);
        return true;
      });
    }
  } else {
    result.match = await walkBackward(job, init.startByte, from, 0, total);
    if (result.match === null && wrap && from < size) {
      wrapped = true;
      result.match = await walkBackward(job, from, size, from - init.startByte, total);
    }
  }
  post({ type: 'found', reqId, match: result.match, wrapped });
}

async function runCount(message: Extract<ToWorker, { type: 'count' }>): Promise<void> {
  const { reqId } = message;
  const job = makeJob(reqId, message.query, message.items);
  if (typeof job === 'string') {
    post({ type: 'failed', reqId, code: 'invalid', message: job });
    return;
  }
  let count = 0;
  let capped = false;
  await walkForward(job, init.startByte, size, 0, Math.max(1, size - init.startByte), () => {
    count += 1;
    capped = count >= MAX_COUNT;
    return capped;
  });
  post({ type: 'counted', reqId, count, capped });
}

/** Runs a search job and turns cancellation and failures into a `failed` message. */
async function guarded(reqId: number, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Cancelled) {
      post({ type: 'failed', reqId, code: 'cancelled', message: 'The search was cancelled.' });
    } else {
      console.error(`The search failed: ${errorMessage(error)}`);
      post({ type: 'failed', reqId, code: 'EIO', message: 'The search failed.' });
    }
  } finally {
    cancelled.delete(reqId);
  }
}

// ---------- Messages ----------

async function release(): Promise<void> {
  abortScan = true;
  while (scanning) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await closeFile();
  post({ type: 'released' });
}

async function adopt(message: Extract<ToWorker, { type: 'adopt' }>): Promise<void> {
  await closeFile();
  filePath = message.path;
  size = message.size;
  index = lineApi.create(indexOptions);
  readPos = init.startByte;
  if (message.snapshot) {
    applySnapshot(index, message.snapshot);
    readPos = message.snapshot.readPos;
  }
  abortScan = false;
}

async function dispatch(message: ToWorker): Promise<void> {
  switch (message.type) {
    case 'scan':
      await runScan();
      break;
    case 'grow':
      size = message.size;
      if (index.done) {
        lineApi.resume(index);
      }
      break;
    case 'find':
      await guarded(message.reqId, () => runFind(message));
      break;
    case 'count':
      await guarded(message.reqId, () => runCount(message));
      break;
    case 'cancel':
      cancelled.add(message.reqId);
      break;
    case 'release':
      await release();
      break;
    case 'adopt':
      await adopt(message);
      break;
  }
}

port.on('message', (message: ToWorker) => {
  dispatch(message).catch((error: unknown) => console.error(`largeFileWorker: ${errorMessage(error)}`));
});
