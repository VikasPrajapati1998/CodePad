/*
 * Large-file sessions (main process, no Electron import). Main owns the file: the renderer only gets an opaque handle,
 * a window of about 2 MiB of text and fixed error codes. A background worker (largeFileWorker.ts) scans the line
 * index and runs searches; edits live in an overlay of replaced byte ranges that is streamed into a temp file on save.
 * Design: .claude/plans/large-files.md. The composing helpers are exported because the worker uses them too.
 */
import crypto from 'crypto';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { errorCode } from './errorUtils';
import * as fileAccess from './fileAccess';
import * as textCodec from './textCodec';
import type { SeekInfo } from './textCodec';

// The pure cores are UMD scripts shared with the renderer, so main loads them with require.
const lineApi: CodePadLineIndexApi = require('./shared/lineIndex');
const overlayApi: CodePadEditOverlayApi = require('./shared/editOverlay');
const windowApi: CodePadLargeWindowApi = require('./shared/largeWindow');
const searchCore: CodePadSearchCoreApi = require('./shared/searchCore');

const MB = 1024 * 1024;

export const MAX_SESSIONS = 8;
export const MAX_CONCURRENT_SCANS = 2;
export const WINDOW_TARGET_BYTES = 2 * MB;
export const MAX_WINDOW_BYTES = 4 * MB;
export const MAX_WINDOW_LINES = 100_000;
export const MAX_WINDOW_CHARS = 4_194_304;
export const MAX_COMMIT_CHARS = 16_777_216;
export const MAX_OVERLAY_CHARS = 64 * MB;
export const MAX_UNDO_CHARS = 64 * MB;
export const MAX_UNDO_STEPS = 500;
export const MAX_QUERY_CHARS = 1000;
export const MAX_MATCH_CHARS = 4096;
export const MAX_COUNT = 10_000_000;
export const WATCHDOG_MS = 10_000;
export const FREE_SPACE_MARGIN = 64 * MB;
export const SEGMENT_CHARS = 10_000;
export const SAMPLE_BYTES = 65_536;
export const SNAP_BYTES = MB;
export const SCAN_CHUNK_BYTES = 4 * MB;
export const COPY_CHUNK_BYTES = MB;
export const FIND_CHUNK_BYTES = MB;
export const TAIL_BYTES = 4096;

const PROGRESS_MS = 250;
const MAX_SNAP_ROUNDS = 8;
const MAX_LINE_RETRIES = 6;
const MAX_WORKER_RESTARTS = 3;
const MAX_LINE_COUNT_BYTES = 64 * MB;
const HANDLE_PATTERN = /^[0-9a-f]{32}$/;
const MAX_CURSOR = 1e15;

/** Limits a test may shrink (the exported constants are the production values). */
export interface LargeLimits {
  windowTargetBytes: number;
  maxWindowLines: number;
  snapBytes: number;
  segmentChars: number;
  maxCommitChars: number;
  maxOverlayChars: number;
  maxUndoChars: number;
  maxUndoSteps: number;
  findChunkBytes: number;
}

const DEFAULT_LIMITS: LargeLimits = {
  windowTargetBytes: WINDOW_TARGET_BYTES,
  maxWindowLines: MAX_WINDOW_LINES,
  snapBytes: SNAP_BYTES,
  segmentChars: SEGMENT_CHARS,
  maxCommitChars: MAX_COMMIT_CHARS,
  maxOverlayChars: MAX_OVERLAY_CHARS,
  maxUndoChars: MAX_UNDO_CHARS,
  maxUndoSteps: MAX_UNDO_STEPS,
  findChunkBytes: FIND_CHUNK_BYTES,
};

/** What main.ts (or a test) injects. */
export interface LargeFilesDeps {
  /** fileAccess.resolveAllowed: rejects a path the user never granted. */
  resolveAllowed(p: string): Promise<string>;
  isSameFile(a: string, b: string): Promise<boolean>;
  send(event: CpLargeEvent): void;
  fallbackEncoding(): string;
  limits?: Partial<LargeLimits>;
}

/** A failure that carries one of the fixed codes (it has no `code` property, so fileAccess passes it through). */
export class LargeFileError extends Error {
  readonly largeCode: CpLargeCode;

  constructor(largeCode: CpLargeCode, message: string) {
    super(message);
    this.largeCode = largeCode;
  }
}

// ---------- Worker protocol ----------

/** A copy of a line index that crosses the worker boundary. */
export interface IndexSnapshot {
  entries: Float64Array;
  count: number;
  every: number;
  lines: number;
  scannedBytes: number;
  pendingCr: boolean;
  pendingOdd: number;
  eolCounts: Record<CpEolKind, number>;
  done: boolean;
  /** Next byte the scan reads (the index may hold a carried byte before it). */
  readPos: number;
}

/** `workerData` of largeFileWorker. */
export interface WorkerInit {
  path: string;
  encoding: string;
  unit: 1 | 2;
  bigEndian: boolean;
  kind: SeekInfo['kind'];
  startByte: number;
  size: number;
  snapBytes: number;
  findChunkBytes: number;
  segmentChars: number;
  snapshot: IndexSnapshot | null;
}

/** Where a match is: an anchor (or the exact byte inside a long line) plus the position inside the line. */
export interface WorkerMatch {
  byte: number;
  sub: number;
  column: number;
  length: number;
}

export type ToWorker =
  | { type: 'scan' }
  | { type: 'grow'; size: number }
  | {
      type: 'find';
      reqId: number;
      query: CpLargeFindQuery;
      items: readonly CpOverlayReplacement[];
      from: CpLargeAnchor;
      direction: 'next' | 'prev';
      wrap: boolean;
    }
  | { type: 'count'; reqId: number; query: CpLargeFindQuery; items: readonly CpOverlayReplacement[] }
  | { type: 'cancel'; reqId: number }
  | { type: 'release' }
  | { type: 'adopt'; path: string; size: number; snapshot: IndexSnapshot | null };

export type FromWorker =
  | { type: 'index'; snapshot: IndexSnapshot }
  | { type: 'scanDone' }
  | { type: 'progress'; reqId: number; permille: number }
  | { type: 'found'; reqId: number; match: WorkerMatch | null; wrapped: boolean }
  | { type: 'counted'; reqId: number; count: number; capped: boolean }
  | { type: 'failed'; reqId: number; code: CpLargeCode; message: string }
  | { type: 'released' };

/** Copies a (worker or mirror) index so it can be posted. */
export function snapshotOf(index: CpLineIndex, readPos: number): IndexSnapshot {
  return {
    entries: index.entries.slice(0, index.count * 2),
    count: index.count,
    every: index.every,
    lines: index.lines,
    scannedBytes: index.scannedBytes,
    pendingCr: index.pendingCr,
    pendingOdd: index.pendingOdd,
    eolCounts: { ...index.eolCounts },
    done: index.done,
    readPos,
  };
}

/** Overwrites an index with a snapshot of it. */
export function applySnapshot(index: CpLineIndex, snapshot: IndexSnapshot): void {
  index.entries = snapshot.entries;
  index.count = snapshot.count;
  index.every = snapshot.every;
  index.lines = snapshot.lines;
  index.scannedBytes = snapshot.scannedBytes;
  index.pendingCr = snapshot.pendingCr;
  index.pendingOdd = snapshot.pendingOdd;
  index.eolCounts = { ...snapshot.eolCounts };
  index.done = snapshot.done;
}

// ---------- Byte helpers ----------

/** Reads [start, end) from a file; shorter when the file ends first. */
export async function readFully(fd: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buffer = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fd.read(buffer, got, length - got, start + got);
    if (bytesRead === 0) {
      break;
    }
    got += bytesRead;
  }
  return buffer.subarray(0, got);
}

function unitAt(data: Buffer, at: number, bigEndian: boolean): number {
  return bigEndian ? (data[at] << 8) | data[at + 1] : data[at] | (data[at + 1] << 8);
}

/** Index just after the first line break that starts before `limit` (CRLF is one break), or -1. */
export function breakEnd(data: Buffer, from: number, limit: number, unit: 1 | 2, bigEndian: boolean): number {
  if (unit === 1) {
    for (let i = from; i < limit; i += 1) {
      const byte = data[i];
      if (byte === 10) {
        return i + 1;
      }
      if (byte === 13) {
        return i + 1 < data.length && data[i + 1] === 10 ? i + 2 : i + 1;
      }
    }
    return -1;
  }
  for (let i = from; i < limit && i + 1 < data.length; i += 2) {
    const value = unitAt(data, i, bigEndian);
    if (value === 10) {
      return i + 2;
    }
    if (value === 13) {
      return i + 3 < data.length && unitAt(data, i + 2, bigEndian) === 10 ? i + 4 : i + 2;
    }
  }
  return -1;
}

/** Number of line breaks in `data`; a CR at its very end counts (the range ends at a line start). */
export function countBreaksIn(data: Buffer, unit: 1 | 2, bigEndian: boolean): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const next = breakEnd(data, at, data.length, unit, bigEndian);
    if (next < 0) {
      return count;
    }
    count += 1;
    at = next;
  }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  let at = text.indexOf('\n', from);
  while (at !== -1 && at < to) {
    count += 1;
    at = text.indexOf('\n', at + 1);
  }
  return count;
}

/** Number of elements of the sorted array that are <= value. */
function upperBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// ---------- Reading and snapping ----------

/** What composing and searching need from a file. */
export interface ReadEnv {
  unit: 1 | 2;
  bigEndian: boolean;
  kind: SeekInfo['kind'];
  encoding: string;
  size: number;
  startByte: number;
  read(start: number, end: number): Promise<Buffer>;
}

/** A cut position; `mid` is true when no line start was found nearby (a very long line). */
export interface Snap {
  byte: number;
  mid: boolean;
}

/** The kind name `safeBoundary` understands (the multi-byte legacy encodings are not seekable inside a line). */
export function boundaryKind(kind: SeekInfo['kind']): 'utf8' | 'utf16le' | 'utf16be' | 'single' {
  return kind === 'multi' ? 'single' : kind;
}

function alignDown(env: ReadEnv, pos: number): number {
  return env.unit === 2 ? pos - ((pos - env.startByte) % 2) : pos;
}

/** The line start at or before `pos` (looking back at most `snapBytes`), else a safe character boundary. */
export async function snapBack(env: ReadEnv, pos: number, snapBytes: number): Promise<Snap> {
  if (pos <= env.startByte) {
    return { byte: env.startByte, mid: false };
  }
  const target = alignDown(env, Math.min(pos, env.size));
  const from = alignDown(env, Math.max(env.startByte, target - snapBytes));
  const data = await env.read(from, Math.min(env.size, target + 2 * env.unit));
  const found = lineApi.prevLineStart(data, target - from, env.unit, env.bigEndian);
  if (found >= 0) {
    return { byte: from + found, mid: false };
  }
  if (from === env.startByte) {
    return { byte: env.startByte, mid: false };
  }
  return { byte: from + lineApi.safeBoundary(data, target - from, boundaryKind(env.kind)), mid: true };
}

/** The line start at or after `pos` (looking ahead at most `snapBytes`), else a safe character boundary. */
export async function snapForward(env: ReadEnv, pos: number, snapBytes: number): Promise<Snap> {
  if (pos >= env.size) {
    return { byte: env.size, mid: false };
  }
  if (pos <= env.startByte) {
    return { byte: env.startByte, mid: false };
  }
  const target = alignDown(env, pos);
  const from = alignDown(env, Math.max(env.startByte, target - 2 * env.unit));
  const data = await env.read(from, Math.min(env.size, target + snapBytes));
  const rel = target - from;
  if (lineApi.prevLineStart(data, rel, env.unit, env.bigEndian) === rel) {
    return { byte: target, mid: false };
  }
  const next = lineApi.nextLineStart(data, rel, env.unit, env.bigEndian);
  if (next >= 0) {
    return { byte: from + next, mid: false };
  }
  if (from + data.length >= env.size) {
    return { byte: env.size, mid: false };
  }
  // No line start nearby (a very long line): cut at the requested position, so snapping again does not move it.
  return { byte: from + lineApi.safeBoundary(data, rel, boundaryKind(env.kind)), mid: true };
}

/** The part of the overlay a range needs: replacements that lie inside [bs, be]. */
export function itemsWithin(items: readonly CpOverlayReplacement[], bs: number, be: number): CpOverlayReplacement[] {
  return items.filter((item) => item.start >= bs && item.end <= be);
}

/** A byte range cut by `snapRange`. */
export interface SnapResult {
  bs: number;
  be: number;
  startMid: boolean;
  endMid: boolean;
}

/**
 * Snaps a byte range to line starts (when asked) and widens it so no replacement is cut.
 * @param snapStart Move the start back to a line start.
 * @param snapEnd Move the end forward to a line start.
 */
export async function snapRange(
  env: ReadEnv,
  items: readonly CpOverlayReplacement[],
  startRaw: number,
  endRaw: number,
  snapBytes: number,
  snapStart: boolean,
  snapEnd: boolean,
): Promise<SnapResult> {
  let bs = Math.min(Math.max(startRaw, env.startByte), env.size);
  let be = Math.min(Math.max(endRaw, bs), env.size);
  let startMid = false;
  let endMid = false;
  for (let round = 0; round < MAX_SNAP_ROUNDS; round += 1) {
    let nextStart = bs;
    let nextEnd = be;
    if (snapStart) {
      const snap = await snapBack(env, nextStart, snapBytes);
      nextStart = snap.byte;
      startMid = snap.mid;
    }
    if (snapEnd) {
      const snap = await snapForward(env, nextEnd, snapBytes);
      nextEnd = snap.byte;
      endMid = snap.mid;
    }
    for (const item of items) {
      if (item.start < nextStart && item.end > nextStart) {
        nextStart = item.start;
      }
      if (item.start < nextEnd && item.end > nextEnd) {
        nextEnd = item.end;
      }
    }
    const stable = nextStart === bs && nextEnd === be;
    bs = nextStart;
    be = nextEnd;
    if (stable) {
      break;
    }
  }
  return { bs, be, startMid, endMid };
}

// ---------- Composing a window ----------

/** A run of original bytes in a composed text, with the char/byte start of each of its lines. */
export interface OrigSegment {
  kind: 'orig';
  byteStart: number;
  byteEnd: number;
  charStart: number;
  charEnd: number;
  lineChars: number[];
  lineBytes: number[];
}

/** The text of one overlay replacement in a composed text. */
export interface ReplSegment {
  kind: 'repl';
  item: CpOverlayReplacement;
  charStart: number;
  charEnd: number;
}

export type WindowSegment = OrigSegment | ReplSegment;

/** The document text of a byte range (original bytes plus replacements) with the maps back to the file. */
export interface Composed {
  text: string;
  segments: WindowSegment[];
  /** Char offset of each model line (the first is 0). */
  lineChars: number[];
  /** Model lines (1-based) that continue the previous line (long-line segments). */
  continuation: number[];
  /** Byte offset of each continuation segment. */
  segmentBytes: number[];
  byteStart: number;
  byteEnd: number;
  /** A piece did not decode and re-encode to the same bytes. */
  invalid: boolean;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Loose = new TextDecoder('utf-8', { ignoreBOM: true });

function decodePiece(env: ReadEnv, raw: Buffer): { text: string; valid: boolean } {
  if (env.kind === 'utf8') {
    try {
      return { text: utf8Strict.decode(raw), valid: true };
    } catch {
      return { text: utf8Loose.decode(raw), valid: false };
    }
  }
  const text = textCodec.decode(raw, env.encoding).content;
  const bom = env.kind === 'utf16le' || env.kind === 'utf16be' ? 2 : 0;
  return { text, valid: textCodec.encode(text, env.encoding).subarray(bom).equals(raw) };
}

/** Decoded text with every line break turned into `\n`, as the editor sees it. */
export function normalizeBreaks(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

function textLines(text: string): string[] {
  const lines: string[] = [];
  const pattern = /\r\n|\r|\n/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    lines.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  lines.push(text.slice(last));
  return lines;
}

/** Byte start of every line of `raw`, with one entry per line (a trailing empty line included). */
function byteLineStarts(raw: Buffer, env: ReadEnv): number[] {
  const split = lineApi.splitLines(raw, env.unit, env.bigEndian);
  const starts = split.starts.slice();
  const terminators = split.eolLens.filter((length) => length > 0).length;
  if (starts.length === terminators) {
    starts.push(raw.length);
  }
  return starts;
}

/**
 * Composes the document text of [bs, be): original bytes between the replacements (decoded, line breaks turned into
 * `\n`) and the replacement texts. Lines longer than `segmentChars` are split into continuation lines.
 * @param items Replacements inside [bs, be], sorted.
 * @param segmentChars 0 disables the splitting.
 */
export async function composeRange(
  env: ReadEnv,
  items: readonly CpOverlayReplacement[],
  bs: number,
  be: number,
  segmentChars: number,
): Promise<Composed> {
  const parts: string[] = [];
  const segments: WindowSegment[] = [];
  const virtual: number[] = [];
  const segmentBytes: number[] = [];
  let chars = 0;
  let invalid = false;

  const addOriginal = async (from: number, to: number): Promise<void> => {
    if (to <= from) {
      return;
    }
    const raw = await env.read(from, to);
    const decoded = decodePiece(env, raw);
    if (!decoded.valid) {
      invalid = true;
    }
    const lines = textLines(decoded.text);
    let starts = byteLineStarts(raw, env);
    if (starts.length !== lines.length) {
      invalid = true;
      starts = lines.map(() => 0);
    }
    const segment: OrigSegment = {
      kind: 'orig',
      byteStart: from,
      byteEnd: to,
      charStart: chars,
      charEnd: chars,
      lineChars: [],
      lineBytes: [],
    };
    lines.forEach((content, k) => {
      segment.lineChars.push(chars);
      segment.lineBytes.push(from + starts[k]);
      if (segmentChars > 0 && content.length > segmentChars) {
        const pieces = windowApi.segmentLine(content, segmentChars);
        let byteAt = from + starts[k];
        pieces.forEach((piece, i) => {
          if (i > 0) {
            parts.push('\n');
            virtual.push(chars);
            segmentBytes.push(byteAt);
            chars += 1;
          }
          parts.push(piece);
          chars += piece.length;
          byteAt += textCodec.byteLength(piece, env.encoding);
        });
      } else {
        parts.push(content);
        chars += content.length;
      }
      if (k < lines.length - 1) {
        parts.push('\n');
        chars += 1;
      }
    });
    segment.charEnd = chars;
    segments.push(segment);
  };

  let pos = bs;
  for (const item of items) {
    await addOriginal(pos, item.start);
    segments.push({ kind: 'repl', item, charStart: chars, charEnd: chars + item.text.length });
    parts.push(item.text);
    chars += item.text.length;
    pos = item.end;
  }
  await addOriginal(pos, be);

  const text = parts.join('');
  const lineChars = [0];
  const continuation: number[] = [];
  let next = 0;
  let at = text.indexOf('\n');
  while (at !== -1) {
    lineChars.push(at + 1);
    if (next < virtual.length && virtual[next] === at) {
      continuation.push(lineChars.length);
      next += 1;
    }
    at = text.indexOf('\n', at + 1);
  }
  return { text, segments, lineChars, continuation, segmentBytes, byteStart: bs, byteEnd: be, invalid };
}

/** Model line (1-based) of a char offset. */
export function lineOfChar(composed: Composed, char: number): number {
  return upperBound(composed.lineChars, char);
}

function segmentIndexAt(composed: Composed, char: number): number {
  let low = 0;
  let high = composed.segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (composed.segments[mid].charStart <= char) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found >= 0 && composed.segments[found].charEnd > char ? found : -1;
}

/** The segment holding a char offset, or null at the end of the text. */
export function segmentAt(composed: Composed, char: number): WindowSegment | null {
  const index = segmentIndexAt(composed, char);
  return index < 0 ? null : composed.segments[index];
}

/** Original byte of a char offset inside an original segment (the line's byte plus its encoded prefix). */
export function origByteAt(segment: OrigSegment, text: string, char: number, encoding: string): number {
  const k = Math.max(0, upperBound(segment.lineChars, char) - 1);
  return segment.lineBytes[k] + textCodec.byteLength(text.slice(segment.lineChars[k], char), encoding);
}

/** The anchor of the line that contains a char offset (see CpLargeAnchor). */
export function anchorAtChar(composed: Composed, char: number): CpLargeAnchor {
  const index = segmentIndexAt(composed, char);
  if (index < 0) {
    return { byte: composed.byteEnd, sub: 0 };
  }
  const segment = composed.segments[index];
  if (segment.kind === 'repl') {
    return { byte: segment.item.start, sub: countNewlines(composed.text, segment.charStart, char) };
  }
  const k = Math.max(0, upperBound(segment.lineChars, char) - 1);
  const byte = segment.lineBytes[k];
  const before = k === 0 && index > 0 ? composed.segments[index - 1] : null;
  if (before !== null && before.kind === 'repl' && before.item.start === before.item.end && before.item.end === byte) {
    // The original line starts where an insertion was made: it follows the inserted lines.
    return { byte, sub: before.item.newLines };
  }
  return { byte, sub: 0 };
}

/** The model line an anchor points to (the last one when it lies at or beyond the end of the text). */
export function modelLineOfAnchor(composed: Composed, anchor: CpLargeAnchor): number {
  for (const segment of composed.segments) {
    if (segment.kind === 'repl' && segment.item.start === anchor.byte) {
      let pos = segment.charStart;
      for (let i = 0; i < anchor.sub; i += 1) {
        const at = composed.text.indexOf('\n', pos);
        if (at < 0 || at >= segment.charEnd) {
          pos = segment.charEnd;
          break;
        }
        pos = at + 1;
      }
      return lineOfChar(composed, Math.min(pos, composed.text.length));
    }
  }
  for (const segment of composed.segments) {
    if (segment.kind === 'orig' && anchor.byte >= segment.byteStart && anchor.byte < segment.byteEnd) {
      const k = Math.max(0, upperBound(segment.lineBytes, anchor.byte) - 1);
      return lineOfChar(composed, segment.lineChars[k]);
    }
  }
  return anchor.byte >= composed.byteEnd ? composed.lineChars.length : 1;
}

// ---------- The session manager ----------

type ScanState = 'idle' | 'queued' | 'running' | 'done';

interface Job {
  kind: 'find' | 'count' | 'save' | 'line';
  cancelled: boolean;
}

/** A window main served, kept to resolve commits and relative requests. */
interface ServedWindow {
  id: number;
  generation: number;
  revision: number;
  composed: Composed;
  readOnly: CpLargeReadOnlyReason | null;
  firstLine: number;
  firstLineExact: boolean;
  atStart: boolean;
  atEnd: boolean;
}

interface Session {
  handle: string;
  owner: number;
  real: string;
  fd: FileHandle;
  encoding: string;
  seek: SeekInfo;
  startByte: number;
  eol: CpEolKind;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  tail: Buffer;
  index: CpLineIndex;
  overlay: CpOverlay;
  /** Bumped by every overlay change and save, so older windows are refused as stale. */
  generation: number;
  nextWindowId: number;
  windows: ServedWindow[];
  worker: Worker | null;
  workerAt: number;
  restarts: number;
  scan: ScanState;
  readPos: number;
  jobs: Map<number, Job>;
  pending: Map<number, (message: FromWorker) => void>;
  released: (() => void) | null;
  waiters: Array<() => void>;
  baseLost: boolean;
  saving: boolean;
  lossy: boolean;
  closed: boolean;
  chain: Promise<void>;
}

type Failure = { ok: false; code: CpLargeCode; message: string };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function fail(code: CpLargeCode, message: string): Failure {
  return { ok: false, code, message };
}

const FIXED_CODES = new Set<string>(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EIO']);

/** Reduces anything thrown to a fixed code and a message that names no path. */
function toFailure(error: unknown): Failure {
  if (error instanceof LargeFileError) {
    return fail(error.largeCode, error.message);
  }
  const code = errorCode(error);
  if (code !== undefined && FIXED_CODES.has(code)) {
    return fail(code as CpLargeCode, code === 'ENOENT' ? 'The file does not exist.' : 'The file operation failed.');
  }
  return fail('EIO', 'The file operation failed.');
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function readAnchor(value: unknown): CpLargeAnchor | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { byte, sub } = value as { byte?: unknown; sub?: unknown };
  return isInt(byte, 0, MAX_CURSOR) && isInt(sub, 0, MAX_CURSOR) ? { byte, sub } : null;
}

function readQuery(value: unknown): CpLargeFindQuery | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { text, matchCase, wholeWord, regex } = value as Record<string, unknown>;
  if (
    typeof text !== 'string' ||
    text.length < 1 ||
    text.length > MAX_QUERY_CHARS ||
    typeof matchCase !== 'boolean' ||
    typeof wholeWord !== 'boolean' ||
    typeof regex !== 'boolean'
  ) {
    return null;
  }
  return { text, matchCase, wholeWord, regex };
}

/** All channels of the large-file reader; every method takes the id of the window that calls it. */
export class LargeFiles {
  private readonly deps: LargeFilesDeps;

  private readonly limits: LargeLimits;

  private readonly sessions = new Map<string, Session>();

  private runningScans = 0;

  private watchdog: NodeJS.Timeout | null = null;

  constructor(deps: LargeFilesDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  // ----- lookup and ordering -----

  private lookup(owner: number, handle: unknown): Session | null {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
      return null;
    }
    const session = this.sessions.get(handle);
    return session && session.owner === owner && !session.closed ? session : null;
  }

  private exclusive<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const run = session.chain.then(task);
    session.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private env(session: Session): ReadEnv {
    return {
      unit: session.seek.unit,
      bigEndian: session.seek.bigEndian,
      kind: session.seek.kind,
      encoding: session.encoding,
      size: session.size,
      startByte: session.startByte,
      read: (start, end) => readFully(session.fd, start, end),
    };
  }

  private send(session: Session, event: DistributiveOmit<CpLargeEvent, 'handle'>): void {
    this.deps.send({ handle: session.handle, ...event } as CpLargeEvent);
  }

  // ----- index information -----

  private lineDeltaTotal(session: Session): number {
    return session.overlay.items.reduce((sum, item) => sum + item.newLines - item.origLines, 0);
  }

  private indexInfo(session: Session): CpLargeIndexInfo {
    const { index } = session;
    const delta = this.lineDeltaTotal(session);
    const counted = index.lines + 1;
    const scanned = index.scannedBytes - session.startByte;
    const estimated = index.done
      ? counted + delta
      : scanned > 0
        ? Math.max(counted, Math.round((counted * (session.size - session.startByte)) / scanned)) + delta
        : counted + delta;
    return {
      bytes: index.scannedBytes,
      lines: counted + delta,
      done: index.done,
      totalLines: index.done ? counted + delta : null,
      estimatedLines: estimated,
    };
  }

  private wake(session: Session): void {
    const waiting = session.waiters;
    session.waiters = [];
    waiting.forEach((resolve) => resolve());
  }

  private nextIndexUpdate(session: Session): Promise<void> {
    return new Promise((resolve) => session.waiters.push(resolve));
  }

  // ----- worker -----

  private spawnWorker(session: Session, snapshot: IndexSnapshot | null): void {
    const data: WorkerInit = {
      path: session.real,
      encoding: session.encoding,
      unit: session.seek.unit,
      bigEndian: session.seek.bigEndian,
      kind: session.seek.kind,
      startByte: session.startByte,
      size: session.size,
      snapBytes: this.limits.snapBytes,
      findChunkBytes: this.limits.findChunkBytes,
      segmentChars: this.limits.segmentChars,
      snapshot,
    };
    const worker = new Worker(path.join(__dirname, 'largeFileWorker.js'), { workerData: data });
    session.worker = worker;
    session.workerAt = Date.now();
    worker.on('message', (message: FromWorker) => this.onWorkerMessage(session, worker, message));
    worker.on('error', () => this.onWorkerGone(session, worker));
    worker.on('exit', () => this.onWorkerGone(session, worker));
    this.startWatchdog();
  }

  private onWorkerMessage(session: Session, worker: Worker, message: FromWorker): void {
    if (session.worker !== worker || session.closed) {
      return;
    }
    session.workerAt = Date.now();
    switch (message.type) {
      case 'index':
        applySnapshot(session.index, message.snapshot);
        session.readPos = message.snapshot.readPos;
        if (session.index.done) {
          session.eol = lineApi.dominantEol(session.index);
        }
        this.send(session, { type: 'index', ...this.indexInfo(session) });
        this.wake(session);
        break;
      case 'scanDone':
        if (session.scan === 'running') {
          this.runningScans -= 1;
        }
        session.scan = session.index.done ? 'done' : 'idle';
        this.pumpScans();
        this.wake(session);
        break;
      case 'progress':
        this.send(session, {
          type: 'progress',
          reqId: message.reqId,
          job: session.jobs.get(message.reqId)?.kind === 'count' ? 'count' : 'find',
          permille: message.permille,
        });
        break;
      case 'released':
        if (session.released) {
          const resolve = session.released;
          session.released = null;
          resolve();
        }
        break;
      default: {
        const resolve = session.pending.get(message.reqId);
        if (resolve) {
          session.pending.delete(message.reqId);
          resolve(message);
        }
      }
    }
  }

  private failPending(session: Session, code: CpLargeCode, message: string): void {
    const pending = [...session.pending.entries()];
    session.pending.clear();
    pending.forEach(([reqId, resolve]) => resolve({ type: 'failed', reqId, code, message }));
    if (session.released) {
      const resolve = session.released;
      session.released = null;
      resolve();
    }
  }

  private onWorkerGone(session: Session, worker: Worker): void {
    if (session.worker !== worker) {
      return;
    }
    session.worker = null;
    if (session.scan === 'running') {
      this.runningScans -= 1;
    }
    session.scan = 'idle';
    this.failPending(session, 'EIO', 'The search stopped unexpectedly.');
    if (!session.closed && session.restarts < MAX_WORKER_RESTARTS) {
      session.restarts += 1;
      this.restartWorker(session);
    }
    this.pumpScans();
    this.wake(session);
  }

  /** Starts a fresh worker from the last index snapshot, so an interrupted scan continues. */
  private restartWorker(session: Session): void {
    this.spawnWorker(session, snapshotOf(session.index, session.readPos));
    this.queueScan(session);
  }

  private killWorker(session: Session): void {
    const { worker } = session;
    if (!worker) {
      return;
    }
    session.worker = null;
    if (session.scan === 'running') {
      this.runningScans -= 1;
    }
    session.scan = 'idle';
    worker.terminate().catch(() => undefined);
  }

  private queueScan(session: Session): void {
    if (session.index.done || session.scan === 'running' || session.scan === 'queued' || !session.worker) {
      return;
    }
    session.scan = 'queued';
    this.pumpScans();
  }

  private pumpScans(): void {
    for (const session of this.sessions.values()) {
      if (this.runningScans >= MAX_CONCURRENT_SCANS) {
        return;
      }
      if (session.scan === 'queued') {
        if (session.worker) {
          session.scan = 'running';
          this.runningScans += 1;
          session.worker.postMessage({ type: 'scan' } satisfies ToWorker);
        } else {
          session.scan = 'idle';
        }
      }
    }
  }

  /** Stops the worker's scan and file handle (before a save replaces the file). */
  private async releaseWorker(session: Session): Promise<void> {
    const { worker } = session;
    if (!worker) {
      return;
    }
    await new Promise<void>((resolve) => {
      session.released = resolve;
      worker.postMessage({ type: 'release' } satisfies ToWorker);
    });
  }

  private adoptWorker(session: Session, snapshot: IndexSnapshot | null): void {
    if (session.worker) {
      session.worker.postMessage({ type: 'adopt', path: session.real, size: session.size, snapshot } satisfies ToWorker);
    }
    this.queueScan(session);
  }

  private startWatchdog(): void {
    if (this.watchdog) {
      return;
    }
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (session.pending.size > 0 && session.worker && now - session.workerAt > WATCHDOG_MS) {
          this.killWorker(session);
          this.failPending(session, 'cancelled', 'The search took too long.');
          this.restartWorker(session);
        }
      }
    }, 1000);
    this.watchdog.unref();
  }

  // ----- windows -----

  /** The doc line that contains `byte` (edits included) and whether the index already covers it. */
  private async docLineAt(session: Session, byte: number): Promise<{ line: number; exact: boolean }> {
    let delta = 0;
    for (const item of session.overlay.items) {
      if (item.start >= byte) {
        break;
      }
      delta += item.newLines - item.origLines;
    }
    const { index } = session;
    if (byte <= session.startByte) {
      return { line: 1, exact: true };
    }
    if (byte > index.scannedBytes) {
      return { line: Math.max(1, lineApi.estimateLine(index, byte)) + delta, exact: false };
    }
    const checkpoint = lineApi.checkpointAtByte(index, byte);
    if (byte - checkpoint.byte > MAX_LINE_COUNT_BYTES) {
      return { line: Math.max(1, lineApi.estimateLine(index, byte)) + delta, exact: false };
    }
    const data = await readFully(session.fd, checkpoint.byte, byte);
    const breaks = countBreaksIn(data, session.seek.unit, session.seek.bigEndian);
    return { line: checkpoint.line + breaks + delta, exact: true };
  }

  private docLineOf(window: ServedWindow, modelLine: number): number {
    return window.firstLine + (modelLine - 1) - upperBound(window.composed.continuation, modelLine);
  }

  private toView(session: Session, window: ServedWindow, anchorModelLine: number): CpLargeWindow {
    return {
      windowId: window.id,
      revision: window.revision,
      text: window.composed.text,
      byteStart: window.composed.byteStart,
      byteEnd: window.composed.byteEnd,
      firstLine: window.firstLine,
      firstLineExact: window.firstLineExact,
      continuation: window.composed.continuation,
      segmentBytes: window.composed.segmentBytes,
      anchorModelLine,
      atStart: window.atStart,
      atEnd: window.atEnd,
      readOnly: window.readOnly,
      index: this.indexInfo(session),
    };
  }

  /** Composes [bs, be) and remembers it as the newest served window. */
  private async serve(session: Session, snap: SnapResult): Promise<ServedWindow> {
    const env = this.env(session);
    const items = itemsWithin(session.overlay.items, snap.bs, snap.be);
    const composed = await composeRange(env, items, snap.bs, snap.be, this.limits.segmentChars);
    // Replacements that start at or after the window start are part of its text, not of the lines before it.
    const first = await this.docLineAt(session, snap.bs);
    let readOnly: CpLargeReadOnlyReason | null = null;
    if (session.seek.kind === 'multi' && (snap.startMid || snap.endMid)) {
      readOnly = 'truncatedLine';
    } else if (composed.invalid) {
      readOnly = 'invalidBytes';
    } else if (composed.continuation.length > 0) {
      readOnly = 'longLine';
    }
    const window: ServedWindow = {
      id: session.nextWindowId,
      generation: session.generation,
      revision: session.overlay.revision,
      composed,
      readOnly,
      firstLine: first.line,
      firstLineExact: first.exact,
      atStart: snap.bs <= session.startByte,
      atEnd: snap.be >= session.size,
    };
    session.nextWindowId += 1;
    session.windows.push(window);
    if (session.windows.length > 2) {
      session.windows.shift();
    }
    return window;
  }

  /**
   * Builds the window around an anchor: `before` and `after` are the original bytes wanted on each side. Too many
   * lines shrink the window and try again.
   */
  private async windowAround(
    session: Session,
    anchor: CpLargeAnchor,
    place: 'top' | 'center' | 'start' | 'end',
  ): Promise<CpLargeWindow> {
    const target = this.limits.windowTargetBytes;
    let before = place === 'top' ? Math.floor(target / 4) : place === 'center' ? Math.floor(target / 2) : place === 'end' ? target : 0;
    let after = place === 'end' ? 0 : target - before;
    const byte = Math.min(Math.max(anchor.byte, session.startByte), session.size);
    const env = this.env(session);
    for (let attempt = 0; ; attempt += 1) {
      const snap = await snapRange(env, session.overlay.items, byte - before, byte + after, this.limits.snapBytes, true, true);
      const window = await this.serve(session, snap);
      if (window.composed.lineChars.length > this.limits.maxWindowLines && attempt < MAX_LINE_RETRIES) {
        session.windows.pop();
        const factor = (this.limits.maxWindowLines / window.composed.lineChars.length) * 0.8;
        before = Math.floor(before * factor);
        after = Math.floor(after * factor);
        continue;
      }
      const modelLine =
        place === 'end' ? window.composed.lineChars.length : modelLineOfAnchor(window.composed, { byte, sub: anchor.sub });
      return this.toView(session, window, modelLine);
    }
  }

  /** The original line number's start byte, from a checkpoint at or before it; null when the file ends first. */
  private async lineStartByte(session: Session, from: number, need: number): Promise<number | null> {
    if (need === 0) {
      return from;
    }
    const { unit, bigEndian } = session.seek;
    let pos = from;
    let left = need;
    while (pos < session.size) {
      const end = Math.min(session.size, pos + COPY_CHUNK_BYTES);
      const data = await readFully(session.fd, pos, Math.min(session.size, end + unit));
      const limit = end >= session.size ? data.length : end - pos;
      let at = 0;
      while (at < limit) {
        const next = breakEnd(data, at, limit, unit, bigEndian);
        if (next < 0) {
          break;
        }
        at = next;
        left -= 1;
        if (left === 0) {
          return pos + at;
        }
      }
      pos += Math.max(at, limit);
    }
    return null;
  }

  // ----- open / close -----

  async open(owner: number, p: unknown, options: unknown): Promise<CpLargeResult<CpLargeOpenOk>> {
    if (typeof p !== 'string') {
      return fail('invalid', 'Invalid path.');
    }
    const rawEncoding = typeof options === 'object' && options !== null ? (options as { encoding?: unknown }).encoding : null;
    if (rawEncoding !== null && rawEncoding !== undefined && !textCodec.isKnownEncoding(rawEncoding)) {
      return fail('invalid', 'Unknown encoding.');
    }
    const forced = typeof rawEncoding === 'string' ? rawEncoding : null;
    let opened = 0;
    this.sessions.forEach((session) => {
      opened += session.owner === owner ? 1 : 0;
    });
    if (opened >= MAX_SESSIONS) {
      return fail('limit', `Close a large file first (${MAX_SESSIONS} open).`);
    }
    let real: string;
    try {
      real = await this.deps.resolveAllowed(p);
    } catch (error) {
      const failure = toFailure(error);
      return failure.code === 'EIO' ? fail('EACCES', 'Access to this path has not been granted.') : failure;
    }
    let fd: FileHandle | null = null;
    try {
      fd = await fsp.open(real, 'r');
      const stat = await fd.stat();
      if (!stat.isFile()) {
        throw new LargeFileError('invalid', 'Only regular files can be opened.');
      }
      const sample = await readFully(fd, 0, Math.min(stat.size, SAMPLE_BYTES));
      let encoding = forced;
      if (encoding === null) {
        const detected = textCodec.detectSample(sample, {
          truncated: stat.size > sample.length,
          fallback: this.deps.fallbackEncoding(),
        });
        if (detected.binary) {
          throw new LargeFileError('binary', 'This file looks like a binary file.');
        }
        encoding = detected.encoding;
      }
      const seek = textCodec.seekKind(encoding);
      const startByte = textCodec.bomLength(encoding, sample);
      const probe = lineApi.create({ unit: seek.unit, bigEndian: seek.bigEndian, startByte });
      lineApi.scanChunk(probe, sample.subarray(startByte), startByte);
      lineApi.finish(probe, sample.length);
      const session: Session = {
        handle: crypto.randomBytes(16).toString('hex'),
        owner,
        real,
        fd,
        encoding,
        seek,
        startByte,
        eol: lineApi.dominantEol(probe),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        tail: await this.readTail(fd, stat.size),
        index: lineApi.create({ unit: seek.unit, bigEndian: seek.bigEndian, startByte }),
        overlay: overlayApi.create({
          maxLiveChars: this.limits.maxOverlayChars,
          maxUndoChars: this.limits.maxUndoChars,
          maxUndoSteps: this.limits.maxUndoSteps,
        }),
        generation: 0,
        nextWindowId: 1,
        windows: [],
        worker: null,
        workerAt: Date.now(),
        restarts: 0,
        scan: 'idle',
        readPos: startByte,
        jobs: new Map(),
        pending: new Map(),
        released: null,
        waiters: [],
        baseLost: false,
        saving: false,
        lossy: false,
        closed: false,
        chain: Promise.resolve(),
      };
      this.sessions.set(session.handle, session);
      fd = null;
      try {
        this.spawnWorker(session, null);
        this.queueScan(session);
        const window = await this.windowAround(session, { byte: startByte, sub: 0 }, 'start');
        return {
          ok: true,
          handle: session.handle,
          size: session.size,
          mtimeMs: session.mtimeMs,
          encoding,
          replaced: window.text.includes('�'),
          eol: session.eol,
          seek: seek.seek,
          window,
        };
      } catch (error) {
        await this.closeSession(session);
        throw error;
      }
    } catch (error) {
      if (fd) {
        await fd.close().catch(() => undefined);
      }
      return toFailure(error);
    }
  }

  private async readTail(fd: FileHandle, size: number): Promise<Buffer> {
    const length = Math.min(TAIL_BYTES, size);
    return Buffer.from(await readFully(fd, size - length, size));
  }

  private async closeSession(session: Session, code?: CpLargeCode): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.sessions.delete(session.handle);
    if (session.scan === 'running') {
      this.runningScans -= 1;
    }
    session.scan = 'idle';
    session.jobs.forEach((job) => {
      job.cancelled = true;
    });
    this.failPending(session, 'cancelled', 'The file was closed.');
    this.wake(session);
    if (session.worker) {
      session.worker.terminate().catch(() => undefined);
      session.worker = null;
    }
    if (code) {
      this.send(session, { type: 'closed', code });
    }
    await session.fd.close().catch(() => undefined);
    this.pumpScans();
    if (this.sessions.size === 0 && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  async close(owner: number, handle: unknown): Promise<boolean> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return false;
    }
    await this.closeSession(session);
    return true;
  }

  /** Closes every session of a window (renderer reload, crash or destruction). */
  async closeOwner(owner: number): Promise<void> {
    const mine = [...this.sessions.values()].filter((session) => session.owner === owner);
    await Promise.all(mine.map((session) => this.closeSession(session)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session)));
  }

  // ----- windows, locate -----

  async window(owner: number, handle: unknown, request: unknown): Promise<CpLargeResult<{ window: CpLargeWindow }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    const { reqId, target, place } = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
    if (!isInt(reqId, 1, Number.MAX_SAFE_INTEGER) || (place !== 'top' && place !== 'center') || typeof target !== 'object' || target === null) {
      return fail('invalid', 'Invalid window request.');
    }
    const to = (target as { to?: unknown }).to;
    try {
      if (to === 'line') {
        return await this.windowAtLine(session, reqId, (target as { line?: unknown }).line, place);
      }
      return await this.exclusive<CpLargeResult<{ window: CpLargeWindow }>>(session, async () => {
        if (session.saving) {
          return fail('busy', 'The file is being saved.');
        }
        const anchor = this.resolveTarget(session, target as Record<string, unknown>);
        if ('ok' in anchor) {
          return anchor;
        }
        const window = await this.windowAround(session, anchor.anchor, anchor.place ?? place);
        return { ok: true, window };
      });
    } catch (error) {
      return toFailure(error);
    }
  }

  private resolveTarget(
    session: Session,
    target: Record<string, unknown>,
  ): Failure | { anchor: CpLargeAnchor; place: 'start' | 'end' | null } {
    const invalid = fail('invalid', 'Invalid window request.');
    switch (target.to) {
      case 'start':
        return { anchor: { byte: session.startByte, sub: 0 }, place: 'start' };
      case 'end':
        return { anchor: { byte: session.size, sub: 0 }, place: 'end' };
      case 'anchor': {
        const anchor = readAnchor(target.anchor);
        return anchor ? { anchor, place: null } : invalid;
      }
      case 'byte':
        return isInt(target.byte, 0, MAX_CURSOR) ? { anchor: { byte: target.byte, sub: 0 }, place: null } : invalid;
      case 'permille':
        return isInt(target.permille, 0, 1000)
          ? { anchor: { byte: Math.floor((session.size * target.permille) / 1000), sub: 0 }, place: null }
          : invalid;
      case 'relative': {
        const found = isInt(target.windowId, 1, Number.MAX_SAFE_INTEGER)
          ? session.windows.find((item) => item.id === target.windowId)
          : undefined;
        if (!found || found.generation !== session.generation) {
          return fail('stale', 'The view changed; reload it.');
        }
        if (!isInt(target.modelLine, 1, MAX_CURSOR)) {
          return invalid;
        }
        const line = Math.min(target.modelLine, found.composed.lineChars.length);
        return { anchor: anchorAtChar(found.composed, found.composed.lineChars[line - 1]), place: null };
      }
      default:
        return invalid;
    }
  }

  /** Go to line: waits (without blocking other calls) while the index has not reached the line yet. */
  private async windowAtLine(
    session: Session,
    reqId: number,
    line: unknown,
    place: 'top' | 'center',
  ): Promise<CpLargeResult<{ window: CpLargeWindow }>> {
    if (!isInt(line, 1, MAX_CURSOR) || session.jobs.has(reqId)) {
      return fail('invalid', 'Invalid window request.');
    }
    const job: Job = { kind: 'line', cancelled: false };
    session.jobs.set(reqId, job);
    try {
      for (;;) {
        if (job.cancelled || session.closed) {
          return fail('cancelled', 'The search for the line was cancelled.');
        }
        const attempt = await this.exclusive(session, () => this.tryLine(session, line, place));
        if (attempt !== 'wait') {
          return attempt;
        }
        this.send(session, {
          type: 'progress',
          reqId,
          job: 'line',
          permille: Math.min(1000, Math.floor((session.index.scannedBytes * 1000) / Math.max(1, session.size))),
        });
        await this.nextIndexUpdate(session);
      }
    } finally {
      session.jobs.delete(reqId);
    }
  }

  private async tryLine(
    session: Session,
    line: number,
    place: 'top' | 'center',
  ): Promise<CpLargeResult<{ window: CpLargeWindow }> | 'wait'> {
    if (session.saving) {
      return fail('busy', 'The file is being saved.');
    }
    const { index } = session;
    // docLineToAnchor asks for the start byte of several original lines (to place the edits on the line scale):
    // answer the ones already looked up, look up the first unknown one and ask again.
    const resolved = new Map<number, number | null>();
    let anchor: CpLargeAnchor | null = null;
    for (;;) {
      let needed = -1;
      anchor = overlayApi.docLineToAnchor(session.overlay, line, (origLine) => {
        const known = resolved.get(origLine);
        if (known !== undefined) {
          return known;
        }
        if (needed < 0) {
          needed = origLine;
        }
        return null;
      });
      if (needed < 0) {
        break;
      }
      const checkpoint = needed >= 1 ? lineApi.checkpointForLine(index, needed) : null;
      if (checkpoint === null) {
        if (needed >= 1 && !index.done) {
          return 'wait';
        }
        resolved.set(needed, null);
      } else {
        resolved.set(needed, await this.lineStartByte(session, checkpoint.byte, needed - checkpoint.line));
      }
    }
    if (anchor === null) {
      return { ok: true, window: await this.windowAround(session, { byte: session.size, sub: 0 }, 'end') };
    }
    return { ok: true, window: await this.windowAround(session, anchor, place) };
  }

  async locate(
    owner: number,
    handle: unknown,
    windowId: unknown,
    modelLine: unknown,
  ): Promise<CpLargeResult<{ anchor: CpLargeAnchor; line: number; exact: boolean; byte: number }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    if (!isInt(windowId, 1, Number.MAX_SAFE_INTEGER) || !isInt(modelLine, 1, MAX_CURSOR)) {
      return fail('invalid', 'Invalid request.');
    }
    const found = session.windows.find((item) => item.id === windowId);
    if (!found || found.generation !== session.generation) {
      return fail('stale', 'The view changed; reload it.');
    }
    const n = Math.min(modelLine, found.composed.lineChars.length);
    const anchor = anchorAtChar(found.composed, found.composed.lineChars[n - 1]);
    const continued = found.composed.continuation.indexOf(n);
    return {
      ok: true,
      anchor,
      line: this.docLineOf(found, n),
      exact: found.firstLineExact,
      byte: continued >= 0 ? found.composed.segmentBytes[continued] : anchor.byte,
    };
  }

  // ----- edits -----

  async commit(
    owner: number,
    handle: unknown,
    commit: unknown,
  ): Promise<CpLargeResult<{ changed: boolean; revision: number; dirty: boolean; window: CpLargeWindow }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    const { windowId, revision, text } = (typeof commit === 'object' && commit !== null ? commit : {}) as Record<string, unknown>;
    if (!isInt(windowId, 1, Number.MAX_SAFE_INTEGER) || !isInt(revision, 0, Number.MAX_SAFE_INTEGER) || typeof text !== 'string') {
      return fail('invalid', 'Invalid commit.');
    }
    if (text.length > this.limits.maxCommitChars) {
      return fail('tooLarge', 'This edit is too large for a large file.');
    }
    try {
      return await this.exclusive(session, () => this.applyCommit(session, windowId, revision, text));
    } catch (error) {
      return toFailure(error);
    }
  }

  private async applyCommit(
    session: Session,
    windowId: number,
    revision: number,
    rawText: string,
  ): Promise<CpLargeResult<{ changed: boolean; revision: number; dirty: boolean; window: CpLargeWindow }>> {
    if (session.saving) {
      return fail('busy', 'The file is being saved.');
    }
    const served = session.windows.find((item) => item.id === windowId);
    if (!served || served.generation !== session.generation || served.revision !== revision) {
      return fail('stale', 'The view changed; reload it.');
    }
    if (served.readOnly !== null || session.baseLost) {
      return fail('readOnly', 'This part of the file cannot be edited.');
    }
    const text = rawText.includes('\r') ? normalizeBreaks(rawText) : rawText;
    const old = served.composed.text;
    const reply = (changed: boolean, window: CpLargeWindow): CpLargeResult<{ changed: boolean; revision: number; dirty: boolean; window: CpLargeWindow }> => ({
      ok: true,
      changed,
      revision: session.overlay.revision,
      dirty: overlayApi.isDirty(session.overlay),
      window,
    });
    if (text === old) {
      return reply(false, this.toView(session, served, 1));
    }
    const { prefix, suffix } = windowApi.diffRange(old, text);
    let from = prefix;
    let to = old.length - suffix;
    const { segments } = served.composed;
    for (let again = true; again; ) {
      again = false;
      for (const segment of segments) {
        if (segment.kind === 'repl' && segment.charStart <= to && segment.charEnd >= from && (segment.charStart < from || segment.charEnd > to)) {
          from = Math.min(from, segment.charStart);
          to = Math.max(to, segment.charEnd);
          again = true;
        }
      }
    }
    const covered = segments.filter((segment): segment is ReplSegment => segment.kind === 'repl' && segment.charStart >= from && segment.charEnd <= to);
    const startSegment = covered.find((segment) => segment.charStart === from);
    const endSegment = [...covered].reverse().find((segment) => segment.charEnd === to);
    const startByte = startSegment ? startSegment.item.start : this.byteAtChar(session, served, from);
    const endByte = endSegment ? endSegment.item.end : this.byteAtChar(session, served, to);
    let origLines = covered.reduce((sum, segment) => sum + segment.item.origLines, 0);
    for (const segment of segments) {
      if (segment.kind === 'orig' && segment.charEnd > from && segment.charStart < to) {
        origLines += countNewlines(old, Math.max(from, segment.charStart), Math.min(to, segment.charEnd));
      }
    }
    const inserted = text.slice(from, text.length - (old.length - to));
    const newLines = countNewlines(inserted, 0, inserted.length);
    const bytes = textCodec.byteLength(inserted, session.encoding) + (session.eol === 'crlf' ? newLines * session.seek.unit : 0);
    const applied = overlayApi.apply(session.overlay, {
      start: startByte,
      end: Math.max(endByte, startByte),
      text: inserted,
      bytes,
      origLines,
      newLines,
    });
    if (!applied.ok) {
      return applied.code === 'tooLarge'
        ? fail('tooLarge', 'Too many unsaved changes for a large file: save to continue.')
        : fail('invalid', 'The change could not be applied.');
    }
    if (applied.transaction.removed.length !== covered.length) {
      overlayApi.undo(session.overlay);
      return fail('invalid', 'The change could not be applied.');
    }
    session.generation += 1;
    const snap = await snapRange(this.env(session), session.overlay.items, served.composed.byteStart, served.composed.byteEnd, this.limits.snapBytes, false, false);
    const window = await this.serve(session, snap);
    return reply(true, this.toView(session, window, 1));
  }

  /** Original byte of a char offset that is not inside a replacement (the window end for the end of the text). */
  private byteAtChar(session: Session, served: ServedWindow, char: number): number {
    const { composed } = served;
    const segment = segmentAt(composed, char);
    if (segment && segment.kind === 'orig') {
      return origByteAt(segment, composed.text, char, session.encoding);
    }
    return composed.byteEnd;
  }

  async undo(owner: number, handle: unknown): Promise<CpLargeResult<{ anchor: CpLargeAnchor; revision: number; dirty: boolean } | { empty: true }>> {
    return this.step(owner, handle, overlayApi.undo);
  }

  async redo(owner: number, handle: unknown): Promise<CpLargeResult<{ anchor: CpLargeAnchor; revision: number; dirty: boolean } | { empty: true }>> {
    return this.step(owner, handle, overlayApi.redo);
  }

  private async step(
    owner: number,
    handle: unknown,
    move: (overlay: CpOverlay) => CpOverlayTransaction | null,
  ): Promise<CpLargeResult<{ anchor: CpLargeAnchor; revision: number; dirty: boolean } | { empty: true }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    return this.exclusive<CpLargeResult<{ anchor: CpLargeAnchor; revision: number; dirty: boolean } | { empty: true }>>(session, async () => {
      if (session.saving) {
        return fail('busy', 'The file is being saved.');
      }
      if (session.baseLost) {
        return fail('readOnly', 'This file changed on disk; its changes cannot be edited.');
      }
      const transaction = move(session.overlay);
      if (transaction === null) {
        return { ok: true, empty: true };
      }
      session.generation += 1;
      return {
        ok: true,
        anchor: { byte: Math.min(Math.max(transaction.at, session.startByte), session.size), sub: 0 },
        revision: session.overlay.revision,
        dirty: overlayApi.isDirty(session.overlay),
      };
    });
  }

  // ----- find and count -----

  private runWorkerJob(session: Session, reqId: number, message: ToWorker): Promise<FromWorker> {
    return new Promise((resolve) => {
      const { worker } = session;
      if (!worker) {
        resolve({ type: 'failed', reqId, code: 'EIO', message: 'Search is not available.' });
        return;
      }
      session.pending.set(reqId, resolve);
      session.workerAt = Date.now();
      worker.postMessage(message);
    });
  }

  private startJob(session: Session, reqId: unknown, kind: 'find' | 'count'): Failure | number {
    if (!isInt(reqId, 1, Number.MAX_SAFE_INTEGER) || session.jobs.has(reqId)) {
      return fail('invalid', 'Invalid request.');
    }
    if (session.saving) {
      return fail('busy', 'The file is being saved.');
    }
    for (const job of session.jobs.values()) {
      if (job.kind === 'find' || job.kind === 'count') {
        return fail('busy', 'Another search is running.');
      }
    }
    session.jobs.set(reqId, { kind, cancelled: false });
    return reqId;
  }

  async find(
    owner: number,
    handle: unknown,
    reqId: unknown,
    queryRaw: unknown,
    fromRaw: unknown,
    direction: unknown,
    wrap: unknown,
  ): Promise<CpLargeResult<{ match: CpLargeMatch | null; wrapped: boolean }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    const query = readQuery(queryRaw);
    const from = readAnchor(fromRaw);
    if (!query || !from || (direction !== 'next' && direction !== 'prev') || typeof wrap !== 'boolean') {
      return fail('invalid', 'Invalid search.');
    }
    const built = searchCore.buildMatcher({ query: query.text, isRegex: query.regex, matchCase: query.matchCase, wholeWord: query.wholeWord });
    if ('error' in built) {
      return fail('invalid', built.error);
    }
    const started = this.startJob(session, reqId, 'find');
    if (typeof started !== 'number') {
      return started;
    }
    try {
      const reply = await this.runWorkerJob(session, started, {
        type: 'find',
        reqId: started,
        query,
        items: session.overlay.items,
        from,
        direction,
        wrap,
      });
      if (reply.type === 'failed') {
        return fail(reply.code, reply.message);
      }
      if (reply.type !== 'found') {
        return fail('EIO', 'The search failed.');
      }
      if (reply.match === null) {
        return { ok: true, match: null, wrapped: reply.wrapped };
      }
      const { byte, sub, column, length } = reply.match;
      const where = await this.exclusive(session, () => this.docLineAt(session, byte));
      return {
        ok: true,
        match: { anchor: { byte, sub }, line: where.line + sub, lineExact: where.exact, column, length },
        wrapped: reply.wrapped,
      };
    } catch (error) {
      return toFailure(error);
    } finally {
      session.jobs.delete(started);
    }
  }

  async count(owner: number, handle: unknown, reqId: unknown, queryRaw: unknown): Promise<CpLargeResult<{ count: number; capped: boolean }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    const query = readQuery(queryRaw);
    if (!query) {
      return fail('invalid', 'Invalid search.');
    }
    const built = searchCore.buildMatcher({ query: query.text, isRegex: query.regex, matchCase: query.matchCase, wholeWord: query.wholeWord });
    if ('error' in built) {
      return fail('invalid', built.error);
    }
    const started = this.startJob(session, reqId, 'count');
    if (typeof started !== 'number') {
      return started;
    }
    try {
      const reply = await this.runWorkerJob(session, started, { type: 'count', reqId: started, query, items: session.overlay.items });
      if (reply.type === 'failed') {
        return fail(reply.code, reply.message);
      }
      return reply.type === 'counted' ? { ok: true, count: reply.count, capped: reply.capped } : fail('EIO', 'The search failed.');
    } finally {
      session.jobs.delete(started);
    }
  }

  cancel(owner: number, handle: unknown, reqId: unknown): boolean {
    const session = this.lookup(owner, handle);
    if (!session || !isInt(reqId, 1, Number.MAX_SAFE_INTEGER)) {
      return false;
    }
    const job = session.jobs.get(reqId);
    if (!job) {
      return false;
    }
    job.cancelled = true;
    if (job.kind === 'find' || job.kind === 'count') {
      session.worker?.postMessage({ type: 'cancel', reqId } satisfies ToWorker);
    }
    this.wake(session);
    return true;
  }

  // ----- disk changes -----

  /** Compares the file on disk with what the session read (see design 3.6). */
  private async classify(session: Session): Promise<{ kind: CpLargeDiskKind; size: number; mtimeMs: number }> {
    let stat;
    try {
      stat = await fsp.stat(session.real);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'deleted', size: session.size, mtimeMs: session.mtimeMs };
      }
      throw error;
    }
    const current = { size: stat.size, mtimeMs: stat.mtimeMs };
    if (!stat.isFile() || stat.dev !== session.dev || stat.ino !== session.ino) {
      return { kind: stat.isFile() ? 'replaced' : 'deleted', ...current };
    }
    if (stat.size === session.size && stat.mtimeMs === session.mtimeMs) {
      return { kind: 'same', ...current };
    }
    const tail = await readFully(session.fd, session.size - session.tail.length, session.size);
    if (stat.size < session.size || !tail.equals(session.tail)) {
      return { kind: 'modified', ...current };
    }
    return { kind: stat.size > session.size ? 'appended' : 'same', ...current };
  }

  /** Takes a classification into the session (a grown file resumes the index scan). */
  private async applyDisk(session: Session, disk: { kind: CpLargeDiskKind; size: number; mtimeMs: number }): Promise<void> {
    if (disk.kind === 'same') {
      session.mtimeMs = disk.mtimeMs;
    } else if (disk.kind === 'appended') {
      session.size = disk.size;
      session.mtimeMs = disk.mtimeMs;
      session.tail = await this.readTail(session.fd, session.size);
      if (session.index.done) {
        lineApi.resume(session.index);
      }
      session.worker?.postMessage({ type: 'grow', size: session.size } satisfies ToWorker);
      this.queueScan(session);
    } else if (disk.kind === 'modified' && overlayApi.isDirty(session.overlay)) {
      session.baseLost = true;
    }
  }

  async refresh(owner: number, handle: unknown): Promise<CpLargeResult<{ kind: CpLargeDiskKind; size: number; mtimeMs: number }>> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    try {
      return await this.exclusive<CpLargeResult<{ kind: CpLargeDiskKind; size: number; mtimeMs: number }>>(session, async () => {
        const disk = await this.classify(session);
        await this.applyDisk(session, disk);
        return { ok: true, ...disk };
      });
    } catch (error) {
      return toFailure(error);
    }
  }

  // ----- save -----

  save(owner: number, handle: unknown, reqId: unknown, options: unknown): Promise<CpLargeSaveResult> {
    return this.runSave(owner, handle, reqId, null, options);
  }

  saveAs(owner: number, handle: unknown, reqId: unknown, targetPath: unknown, options: unknown): Promise<CpLargeSaveResult> {
    if (typeof targetPath !== 'string') {
      return Promise.resolve(fail('invalid', 'Invalid path.'));
    }
    return this.runSave(owner, handle, reqId, targetPath, options);
  }

  private async runSave(owner: number, handle: unknown, reqId: unknown, targetPath: string | null, rawOptions: unknown): Promise<CpLargeSaveResult> {
    const session = this.lookup(owner, handle);
    if (!session) {
      return fail('badHandle', 'This file is no longer open.');
    }
    const raw = (typeof rawOptions === 'object' && rawOptions !== null ? rawOptions : {}) as Record<string, unknown>;
    if (!isInt(reqId, 1, Number.MAX_SAFE_INTEGER) || session.jobs.has(reqId) || typeof raw.allowLossy !== 'boolean') {
      return fail('invalid', 'Invalid save request.');
    }
    const allowLossy = raw.allowLossy;
    const overwriteReplaced = raw.overwriteReplaced === true;
    let target = session.real;
    let rebind = false;
    if (targetPath !== null) {
      try {
        const resolved = await this.deps.resolveAllowed(targetPath);
        rebind = !(await this.deps.isSameFile(resolved, session.real));
        target = rebind ? resolved : session.real;
      } catch (error) {
        const failure = toFailure(error);
        return failure.code === 'EIO' ? fail('EACCES', 'Access to this path has not been granted.') : failure;
      }
    }
    const job: Job = { kind: 'save', cancelled: false };
    const prepared = await this.exclusive(session, () => this.prepareSave(session, reqId, job, { allowLossy, overwriteReplaced, rebind }));
    if ('result' in prepared) {
      return prepared.result;
    }
    try {
      await this.releaseWorker(session);
      return await this.streamSave(session, reqId, job, target, rebind, prepared);
    } finally {
      session.saving = false;
      session.jobs.delete(reqId);
    }
  }

  /** Checks a save may start; marks the session as saving when it may. */
  private async prepareSave(
    session: Session,
    reqId: number,
    job: Job,
    options: { allowLossy: boolean; overwriteReplaced: boolean; rebind: boolean },
  ): Promise<{ result: CpLargeSaveResult } | { kind: CpLargeDiskKind; expected: number }> {
    if (session.saving) {
      return { result: fail('busy', 'The file is already being saved.') };
    }
    if (session.baseLost) {
      return { result: fail('changed', 'The file changed on disk; your changes cannot be saved.') };
    }
    const disk = await this.classify(session);
    if (disk.kind !== 'same') {
      this.send(session, { type: 'disk', kind: disk.kind, size: disk.size, mtimeMs: disk.mtimeMs });
    }
    if (disk.kind === 'modified') {
      session.baseLost = overlayApi.isDirty(session.overlay) || session.baseLost;
      return { result: fail('changed', 'The file changed on disk; your changes cannot be saved.') };
    }
    if (disk.kind === 'replaced' && !options.rebind && !options.overwriteReplaced) {
      return { result: fail('changed', 'The file was replaced on disk.') };
    }
    await this.applyDisk(session, disk);
    if (!options.rebind && !overlayApi.isDirty(session.overlay)) {
      return { result: { ok: true, mtimeMs: session.mtimeMs, size: session.size } };
    }
    let lossy = false;
    for (const item of session.overlay.items) {
      const check = textCodec.checkEncodable(item.text, session.encoding);
      if (check.lossy) {
        lossy = true;
        if (!options.allowLossy) {
          return {
            result: {
              ok: false,
              code: 'lossy',
              message: `Some characters cannot be saved in this encoding.`,
              firstBad: check.firstBad,
              badChar: check.badChar,
            },
          };
        }
      }
    }
    session.lossy = lossy;
    const expected = session.overlay.items.reduce((sum, item) => sum + item.bytes - (item.end - item.start), session.size);
    session.saving = true;
    session.jobs.set(reqId, job);
    return { kind: disk.kind, expected };
  }

  private async freeSpaceShort(target: string, expected: number): Promise<boolean> {
    try {
      const stats = await fsp.statfs(path.dirname(target));
      return Number(stats.bavail) * Number(stats.bsize) < expected + FREE_SPACE_MARGIN;
    } catch {
      // Not every platform or folder reports free space; the write itself still fails cleanly when the disk is full.
      return false;
    }
  }

  private async streamSave(
    session: Session,
    reqId: number,
    job: Job,
    target: string,
    rebind: boolean,
    prepared: { kind: CpLargeDiskKind; expected: number },
  ): Promise<CpLargeSaveResult> {
    let fdClosed = false;
    try {
      if (await this.freeSpaceShort(target, prepared.expected)) {
        throw new LargeFileError('noSpace', 'There is not enough free space on the disk.');
      }
      const plan = overlayApi.savePlan(session.overlay, session.size);
      const eolText = session.eol === 'crlf' ? '\r\n' : session.eol === 'cr' ? '\r' : '\n';
      const bomOut = session.encoding === 'utf8bom' ? 3 : session.seek.unit === 2 ? 2 : 0;
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      await fileAccess.writeAtomicStream(
        target,
        async (out) => {
          let written = 0;
          let lastReport = 0;
          const report = (): void => {
            const now = Date.now();
            if (now - lastReport >= PROGRESS_MS) {
              lastReport = now;
              this.send(session, {
                type: 'progress',
                reqId,
                job: 'save',
                permille: Math.min(1000, Math.floor((written * 1000) / Math.max(1, prepared.expected))),
              });
            }
          };
          for (const step of plan) {
            if ('text' in step) {
              const text = eolText === '\n' ? step.text : step.text.replace(/\n/g, eolText);
              const encoded = textCodec.encode(text, session.encoding).subarray(bomOut);
              await out.write(encoded);
              written += encoded.length;
              continue;
            }
            let at = step.copy[0];
            const end = step.copy[1];
            while (at < end) {
              if (job.cancelled) {
                throw new LargeFileError('cancelled', 'The save was cancelled.');
              }
              const { bytesRead } = await session.fd.read(buffer, 0, Math.min(COPY_CHUNK_BYTES, end - at), at);
              if (bytesRead === 0) {
                throw new LargeFileError('changed', 'The file changed on disk while it was being saved.');
              }
              await out.write(buffer.subarray(0, bytesRead));
              at += bytesRead;
              written += bytesRead;
              report();
            }
          }
        },
        {
          verifyBeforeRename:
            prepared.kind === 'same' || prepared.kind === 'appended'
              ? async () => {
                  if ((await this.classify(session)).kind !== 'same') {
                    throw new LargeFileError('changed', 'The file changed on disk while it was being saved.');
                  }
                }
              : undefined,
          closeBeforeRename: rebind
            ? undefined
            : async () => {
                await session.fd.close();
                fdClosed = true;
              },
        },
      );
      await this.finishSave(session, target, rebind);
      return { ok: true, mtimeMs: session.mtimeMs, size: session.size };
    } catch (error) {
      if (fdClosed) {
        try {
          session.fd = await fsp.open(session.real, 'r');
          const stat = await session.fd.stat();
          session.baseLost = session.baseLost || stat.ino !== session.ino || stat.dev !== session.dev;
        } catch {
          await this.closeSession(session, 'EIO');
          return fail('EIO', 'The file operation failed.');
        }
      }
      if (!session.closed) {
        this.adoptWorker(session, snapshotOf(session.index, session.readPos));
      }
      return toFailure(error);
    }
  }

  /** Rebinds the session to the file just written: new handle, new index, empty overlay. */
  private async finishSave(session: Session, target: string, rebind: boolean): Promise<void> {
    const edits = overlayApi.edits(session.overlay);
    const wasDone = session.index.done && !session.lossy;
    const oldIndex = session.index;
    const fd = await fsp.open(target, 'r');
    const stat = await fd.stat();
    if (rebind) {
      await session.fd.close().catch(() => undefined);
    }
    session.fd = fd;
    session.real = target;
    session.dev = stat.dev;
    session.ino = stat.ino;
    session.size = stat.size;
    session.mtimeMs = stat.mtimeMs;
    session.tail = await this.readTail(fd, stat.size);
    session.baseLost = false;
    session.lossy = false;
    overlayApi.markSaved(session.overlay);
    session.generation += 1;
    session.windows = [];
    const rebased = wasDone ? lineApi.rebase(oldIndex, edits) : null;
    if (rebased !== null && rebased.done && rebased.scannedBytes === stat.size) {
      session.index = rebased;
      session.readPos = stat.size;
      this.adoptWorker(session, snapshotOf(rebased, stat.size));
    } else {
      session.index = lineApi.create({ unit: session.seek.unit, bigEndian: session.seek.bigEndian, startByte: session.startByte });
      session.readPos = session.startByte;
      this.adoptWorker(session, null);
    }
    this.send(session, { type: 'index', ...this.indexInfo(session) });
  }
}

/** Creates the session manager (one per app). */
export function createLargeFiles(deps: LargeFilesDeps): LargeFiles {
  return new LargeFiles(deps);
}
