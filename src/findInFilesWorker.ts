/*
 * Find in Files worker (worker_threads). Walks the folder chosen by findInFiles.ts,
 * never follows symlinks or junctions, and streams matches back to the parent.
 * A user-supplied regex only ever runs here so that a pathological pattern can be
 * stopped by terminating this thread.
 */
import fs from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import type { SearchWorkerData } from './findInFiles';
import * as textCodec from './textCodec';

// The shared search core is a UMD script (also loaded by the renderer), so main loads it with require.
const searchCore: CodePadSearchCoreApi = require('./shared/searchCore');

if (!parentPort) {
  throw new Error('findInFilesWorker must run in a worker thread.');
}
const port = parentPort;

const MAX_DEPTH = 40;
const MAX_ENTRIES = 200000;
const MAX_WALL_MS = 120000;
const BINARY_SNIFF_BYTES = 8192;
const FLUSH_MS = 60;
const FLUSH_MATCHES = 200;
const PROGRESS_MS = 250;

const { base, opts, fallbackEncoding } = workerData as SearchWorkerData;
const fallback = textCodec.isKnownEncoding(fallbackEncoding) ? fallbackEncoding : 'windows-1252';
const maxBytes = opts.maxFileKB * 1024;
const excluded = new Set(opts.exclude.map((name) => name.toLowerCase()));
const includeRes = opts.include.map(globToRegExp);
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

const startedAt = Date.now();
const totals: Omit<CpSearchTotals, 'cancelled' | 'elapsedMs'> = {
  filesScanned: 0,
  filesMatched: 0,
  matchCount: 0,
  skippedBinary: 0,
  skippedLarge: 0,
  truncated: false
};
let pendingFiles: CpSearchFileMatches[] = [];
let pendingMatches = 0;
let lastFlush = Date.now();
let lastProgress = 0;
let stopped = false;

/** Converts a validated name glob (chars A-Za-z0-9_.*?-) to an anchored case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/[.-]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + source + '$', 'i');
}

function samePath(a: string, b: string): boolean {
  return caseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function progressMessage(): CpSearchWorkerMessage {
  return { type: 'progress', filesScanned: totals.filesScanned, matchCount: totals.matchCount };
}

/** Sends buffered matches (and a progress heartbeat) to the parent. */
function flush(force: boolean): void {
  const now = Date.now();
  if (pendingFiles.length > 0 && (force || pendingMatches >= FLUSH_MATCHES || now - lastFlush >= FLUSH_MS)) {
    port.postMessage({ type: 'matches', files: pendingFiles } satisfies CpSearchWorkerMessage);
    pendingFiles = [];
    pendingMatches = 0;
    lastFlush = now;
    lastProgress = now;
  } else if (now - lastProgress >= PROGRESS_MS) {
    port.postMessage(progressMessage());
    lastProgress = now;
  }
}

function checkLimits(): void {
  if (Date.now() - startedAt > MAX_WALL_MS) {
    totals.truncated = true;
    stopped = true;
  }
}

/** Reads one file through a no-follow handle, applies binary/size rules and records matches. */
async function searchFile(full: string, size: number, matcher: SearchCoreMatcher): Promise<void> {
  if (size > maxBytes) {
    totals.skippedLarge++;
    return;
  }
  let buffer: Buffer;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(full, openFlags);
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    if (stat.size > maxBytes) {
      totals.skippedLarge++;
      return;
    }
    buffer = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    buffer = buffer.subarray(0, bytesRead);
  } catch {
    // Unreadable (permissions, vanished, symlink swapped in): not searchable, not an error.
    return;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  totals.filesScanned++;
  if (buffer.length === 0) return;

  const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (!/^utf16/.test(textCodec.detect(head, { fallback }).encoding) && head.includes(0)) {
    totals.skippedBinary++;
    return;
  }
  let content: string;
  try {
    content = textCodec.decode(buffer, null, { fallback }).content;
  } catch {
    totals.skippedBinary++;
    return;
  }

  const remaining = opts.maxResults - totals.matchCount;
  const found = searchCore.findAll(content, matcher, { limit: remaining });
  if (found.length === 0) return;
  totals.filesMatched++;
  totals.matchCount += found.length;
  pendingMatches += found.length;
  pendingFiles.push({
    path: full,
    rel: path.relative(base.root, full),
    matches: found.map((m) => ({
      line: m.line,
      col: m.col,
      length: m.length,
      preview: m.lineText,
      previewStart: m.lineOffset
    }))
  });
  if (totals.matchCount >= opts.maxResults) {
    totals.truncated = true;
    stopped = true;
  }
}

/** Handles one directory entry; returns the path to descend into, or null. */
async function visit(dir: string, depth: number, entry: fs.Dirent, matcher: SearchCoreMatcher): Promise<string | null> {
  if (entry.isSymbolicLink()) return null;
  if (!opts.includeHidden && entry.name.startsWith('.')) return null;
  const full = path.join(dir, entry.name);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(full);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  if (stat.isDirectory()) {
    if (excluded.has(entry.name.toLowerCase()) || depth >= MAX_DEPTH) return null;
    try {
      // A junction or mount point resolves elsewhere; only genuine children are searched.
      if (!samePath(await fs.promises.realpath(full), full)) return null;
    } catch {
      return null;
    }
    return full;
  }
  if (!stat.isFile()) return null;
  if (includeRes.length > 0 && !includeRes.some((re) => re.test(entry.name))) return null;
  await searchFile(full, stat.size, matcher);
  return null;
}

async function run(): Promise<void> {
  const matcher = searchCore.buildMatcher(opts);
  if ('error' in matcher) {
    port.postMessage({ type: 'error', message: matcher.error } satisfies CpSearchWorkerMessage);
    return;
  }
  const stack = [{ dir: base.start, depth: 0 }];
  let entries = 0;
  while (stack.length > 0 && !stopped) {
    const item = stack.pop();
    if (!item) break;
    const { dir, depth } = item;
    const children: Array<{ dir: string; depth: number }> = [];
    try {
      for await (const entry of await fs.promises.opendir(dir)) {
        if (stopped) break;
        if (++entries > MAX_ENTRIES) {
          totals.truncated = true;
          stopped = true;
          break;
        }
        const next = await visit(dir, depth, entry, matcher);
        if (next) children.push({ dir: next, depth: depth + 1 });
        checkLimits();
        flush(false);
      }
    } catch {
      // Directory vanished or is unreadable: skip it and keep searching the rest.
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  flush(true);
  port.postMessage({
    type: 'done',
    totals: { ...totals, cancelled: false, elapsedMs: Date.now() - startedAt }
  } satisfies CpSearchWorkerMessage);
}

run().catch((err: unknown) => {
  port.postMessage({
    type: 'error',
    message: 'Search failed: ' + (err instanceof Error ? err.message : String(err))
  } satisfies CpSearchWorkerMessage);
});
