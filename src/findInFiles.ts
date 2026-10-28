/*
 * Find in Files driver (main process). Validates the renderer's request, always
 * searches under the approved root, and runs the search in a worker thread so a
 * pathological regex cannot freeze the app and cancellation is a real terminate.
 * Wired to the search:start / search:cancel IPC handlers by main.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

// The shared search core is a UMD script (also loaded by the renderer), so main loads it with require.
const searchCore: CodePadSearchCoreApi = require('./shared/searchCore');

const WATCHDOG_MS = 10000;
const WATCHDOG_TICK_MS = 1000;
const MAX_QUERY = 1000;
const MAX_INCLUDE = 20;
const MAX_EXCLUDE = 50;
const MAX_PATTERN = 100;
const RESULT_RANGE = [100, 20000] as const;
const FILE_KB_RANGE = [64, 20480] as const;
const GLOB_CHARS = /^[A-Za-z0-9_.*?-]+$/;
const BAD_NAME_CHARS = /[\u0000-\u001f\\/]/;

/** The validated options handed to the worker (and used to build its matcher). */
export interface NormalizedSearchOptions extends SearchCoreOptions {
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  extended: boolean;
  dotAll: boolean;
  include: string[];
  exclude: string[];
  includeHidden: boolean;
  maxResults: number;
  maxFileKB: number;
}

/** `workerData` of findInFilesWorker. */
export interface SearchWorkerData {
  base: { root: string; start: string };
  opts: NormalizedSearchOptions;
  fallbackEncoding: string | undefined;
}

/** Caps from the settings store. */
interface SearchLimits {
  maxResults?: number;
  maxFileKB?: number;
}

/** What `start` needs from main. `root` must be fileAccess.getApprovedRoot(); `send` forwards an event to the renderer. */
export interface SearchContext {
  root: string | null;
  send: (event: CpSearchEvent) => void;
  limits?: SearchLimits;
  fallbackEncoding?: string;
}

/** A running search. */
export interface RunningSearch {
  searchId: string;
  cancel: () => void;
}

let current: RunningSearch | null = null;

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function stringList(value: unknown, maxItems: number, label: string, check: (item: string) => boolean): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid ${label} list.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_PATTERN || !check(item)) {
      throw new Error(`Invalid ${label} entry.`);
    }
    return item;
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Resolves the optional sub folder to a real directory inside the root. */
function resolveStart(realRoot: string, subPath: unknown): string {
  if (subPath === undefined || subPath === null || subPath === '') return realRoot;
  if (typeof subPath !== 'string' || subPath.length > 1024 || subPath.includes('\0')) {
    throw new Error('Invalid sub folder.');
  }
  const segments = subPath.split(/[\\/]/);
  if (path.isAbsolute(subPath) || subPath.includes(':') || segments.includes('..')) {
    throw new Error('The sub folder must be a relative path inside the opened folder.');
  }
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(realRoot, subPath));
  } catch {
    throw new Error('The sub folder does not exist.');
  }
  if (!isInside(realRoot, real) || !fs.statSync(real).isDirectory()) {
    throw new Error('The sub folder must be a folder inside the opened folder.');
  }
  return real;
}

/**
 * Validates and clamps the renderer's options. Throws a plain Error on bad input.
 * @param limits Caps from the settings store.
 */
function normalizeOptions(input: unknown, limits: SearchLimits | undefined): NormalizedSearchOptions {
  if (!input || typeof input !== 'object') throw new Error('Invalid search request.');
  const raw = input as Record<string, unknown>;
  if (typeof raw.query !== 'string' || raw.query.length === 0 || raw.query.length > MAX_QUERY) {
    throw new Error(`The search text must be 1 to ${MAX_QUERY} characters.`);
  }
  const opts: NormalizedSearchOptions = {
    query: raw.query,
    isRegex: raw.isRegex === true,
    matchCase: raw.matchCase === true,
    wholeWord: raw.wholeWord === true,
    extended: raw.extended === true,
    dotAll: raw.dotAll === true,
    include: stringList(raw.include, MAX_INCLUDE, 'include', (s) => GLOB_CHARS.test(s)),
    exclude: stringList(raw.exclude, MAX_EXCLUDE, 'exclude', (s) => !BAD_NAME_CHARS.test(s)),
    includeHidden: raw.includeHidden === true,
    maxResults: clamp(raw.maxResults, RESULT_RANGE, 5000),
    maxFileKB: clamp(raw.maxFileKB, FILE_KB_RANGE, 5120)
  };
  const capResults = limits?.maxResults;
  const capFileKB = limits?.maxFileKB;
  if (typeof capResults === 'number' && Number.isFinite(capResults)) opts.maxResults = Math.min(opts.maxResults, capResults);
  if (typeof capFileKB === 'number' && Number.isFinite(capFileKB)) opts.maxFileKB = Math.min(opts.maxFileKB, capFileKB);
  const matcher = searchCore.buildMatcher(opts);
  if ('error' in matcher) throw new Error(matcher.error);
  return opts;
}

/**
 * Starts a search under `root`, cancelling any search that is still running.
 * @param rawOptions Options from the renderer (see the design, section C.3).
 * @throws {Error} when no folder is open or the options are invalid.
 */
function start(rawOptions: unknown, context: SearchContext): RunningSearch {
  if (!context.root) throw new Error('Open a folder first.');
  const realRoot = fs.realpathSync(context.root);
  const opts = normalizeOptions(rawOptions, context.limits);
  const startDir = resolveStart(realRoot, (rawOptions as { subPath?: unknown }).subPath);
  cancelAll();

  const searchId = crypto.randomUUID();
  const startedAt = Date.now();
  const stats = { filesScanned: 0, matchCount: 0 };
  const workerData: SearchWorkerData = {
    base: { root: realRoot, start: startDir },
    opts,
    fallbackEncoding: context.fallbackEncoding
  };
  const worker = new Worker(path.join(__dirname, 'findInFilesWorker.js'), { workerData });
  let lastMessage = Date.now();
  let finished = false;

  const finish = (event: CpSearchWorkerMessage): void => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    if (current && current.searchId === searchId) current = null;
    worker.terminate().catch(() => undefined);
    context.send({ ...event, searchId });
  };
  const watchdog = setInterval(() => {
    if (Date.now() - lastMessage > WATCHDOG_MS) {
      finish({ type: 'error', message: 'Search stopped: the pattern is too slow.' });
    }
  }, WATCHDOG_TICK_MS);

  worker.on('message', (message: CpSearchWorkerMessage) => {
    lastMessage = Date.now();
    if (message.type === 'done') {
      finish({ type: 'done', totals: message.totals });
    } else if (message.type === 'error') {
      finish({ type: 'error', message: message.message });
    } else {
      if (message.type === 'progress') {
        stats.filesScanned = message.filesScanned;
        stats.matchCount = message.matchCount;
      } else if (message.type === 'matches') {
        stats.matchCount += message.files.reduce((sum, f) => sum + f.matches.length, 0);
      }
      if (!finished) context.send({ ...message, searchId });
    }
  });
  worker.on('error', (err: Error) => finish({ type: 'error', message: 'Search failed: ' + err.message }));
  worker.on('exit', () => finish({ type: 'error', message: 'Search stopped unexpectedly.' }));

  const cancelSearch = (): void =>
    finish({
      type: 'done',
      totals: {
        filesScanned: stats.filesScanned,
        filesMatched: 0,
        matchCount: stats.matchCount,
        skippedBinary: 0,
        skippedLarge: 0,
        truncated: false,
        cancelled: true,
        elapsedMs: Date.now() - startedAt
      }
    });
  current = { searchId, cancel: cancelSearch };
  return { searchId, cancel: cancelSearch };
}

/**
 * Cancels the given search.
 * @returns true when it was the running search.
 */
function cancel(searchId: string): boolean {
  if (!current || current.searchId !== searchId) return false;
  current.cancel();
  return true;
}

/** Cancels whatever search is running (new search, window close, quit). */
function cancelAll(): void {
  if (current) current.cancel();
}

export { start, cancel, cancelAll };
