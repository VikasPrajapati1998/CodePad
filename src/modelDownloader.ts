/**
 * Model download manager (main process). The only module that touches the network: fixed HTTPS sources,
 * a redirect host allow-list, HTTP Range resume, SHA-256 verification before an atomic rename.
 * The renderer never supplies a URL, host, path or file name.
 */

import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { net, session } from 'electron';
import type { ClientRequest, IncomingMessage } from 'electron';
import * as integrity from './integrity';

const MiB = 1024 * 1024;
const MAX_REDIRECTS = 5;
const ATTEMPTS_PER_SOURCE = 5;
const BACKOFF_BASE_MS = 2000;
const CONNECT_TIMEOUT_MS = 20000;
const STALL_TIMEOUT_MS = 30000;
const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 4000;
const OFFLINE_RETRY_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const EXTERNAL_POLL_MS = 2000;
const EXTERNAL_WAIT_MS = 30 * 60 * 1000;
const DISK_MARGIN = 64 * MiB;
const MARKER_FILE = 'model.json';
const LOCK_FILE = 'download.lock';
const PARTITION = 'codepad-model';
const TRANSIENT_HTTP = new Set([408, 425, 429]);
const PROBE_OK = new Set([200, 206, 301, 302, 303, 307, 308]);

/** Logger used by the model modules (the app logger satisfies it). */
export interface ModelLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NO_LOG: ModelLog = Object.freeze({ info() {}, warn() {}, error() {} });

/** An Electron `IncomingMessage` as it behaves at runtime: it can be paused for back-pressure (missing from the typings). */
export interface PausableMessage extends IncomingMessage {
  pause(): void;
  resume(): void;
}

/** Node `code` of a system error, if any. */
export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

/** Message of any thrown value. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A pinned model source. */
export interface CatalogEntry {
  id: string;
  file: string;
  size: number;
  sha256: string;
  url: string;
  hosts: readonly string[];
  label: string;
}

/** Download status sent to the renderer. */
export interface ModelStatus {
  state: 'checking' | 'missing' | 'ready' | 'downloading' | 'verifying' | 'paused' | 'offline' | 'error';
  modelId: string | null;
  bytes: number;
  total: number;
  bytesPerSec: number;
  etaSec: number | null;
  external: boolean;
  error: { code: string; message: string } | null;
}

/** Result of {@link ModelManager.checkConnection}. */
export interface ConnectionProbe {
  online: boolean;
  source?: string;
  error?: string;
}

/** A verified model file on disk. */
export interface ResolvedModel {
  id: string;
  path: string;
  size: number;
}

/** The download manager returned by {@link createModelManager}. */
export interface ModelManager {
  status(): ModelStatus;
  onStatus(callback: (status: ModelStatus) => void): () => boolean;
  resolve(): Promise<ResolvedModel | null>;
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  remove(): Promise<void>;
  checkConnection(options?: { timeoutMs?: number }): Promise<ConnectionProbe>;
  dispose(): Promise<void>;
}

/** The `model.json` verification marker. */
interface Marker {
  version: number;
  id: string;
  file: string;
  size: number;
  sha256: string;
  verifiedAt: string;
  mtimeMs: number;
}

/** Abort handle of one download run. */
interface Control {
  aborted: boolean;
  reason: string | null;
  listeners: Set<() => void>;
  abort(reason: string): void;
}

/** Pinned model sources, primary first. Size and SHA-256 are the integrity anchor, hosts are only a transport allow-list. */
export const CATALOG: readonly Readonly<CatalogEntry>[] = Object.freeze(
  [
    {
      id: 'qwen3-0.6b-q4_k_m',
      file: 'qwen3-0.6b-q4_k_m.gguf',
      size: 522640096,
      sha256: '7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa',
      url: 'https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa',
      hosts: ['registry.ollama.ai', '*.r2.cloudflarestorage.com'],
      label: 'Qwen3-0.6B Q4_K_M',
    },
    {
      id: 'qwen3-0.6b-q8_0',
      file: 'qwen3-0.6b-q8_0.gguf',
      size: 639446688,
      sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
      url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf',
      hosts: ['huggingface.co', '*.hf.co'],
      label: 'Qwen3-0.6B Q8_0',
    },
  ].map((entry): Readonly<CatalogEntry> => Object.freeze({ ...entry, hosts: Object.freeze(entry.hosts) })),
);

/** Download failure with a machine-readable code (`offline | http | integrity | disk | io | locked | cancelled`). */
export class ModelError extends Error {
  code: string;

  source: boolean;

  retry: boolean;

  dropPart: boolean;

  /**
   * @param code Error code.
   * @param message Human-readable message (never contains URLs with credentials or file names).
   * @param flags `source`: the source itself is at fault (allows the mirror); `retry`: another attempt may help;
   *   `dropPart`: the .part is unusable.
   */
  constructor(
    code: string,
    message: string,
    {
      source = false,
      retry = true,
      dropPart = false,
      cause,
    }: { source?: boolean; retry?: boolean; dropPart?: boolean; cause?: unknown } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModelError';
    this.code = code;
    this.source = source;
    this.retry = retry;
    this.dropPart = dropPart;
  }
}

const cancelledError = (message: string): ModelError => new ModelError('cancelled', message, { retry: false });

function throwIfAborted(ctl: Control): void {
  if (ctl.aborted) {
    throw cancelledError('Download stopped.');
  }
}

function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
  );
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Maps a low-level failure to a ModelError. Chromium network errors are connectivity problems, not source faults. */
function classify(error: unknown): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  const message = errorMessage(error);
  const code = errorCode(error);
  if (code === 'ENOSPC') {
    return new ModelError('disk', 'The disk is full.', { retry: false, cause: error });
  }
  if (/net::ERR_(CERT|SSL|BAD_SSL|TOO_MANY_REDIRECTS|UNSAFE_REDIRECT|UNSAFE_PORT|INVALID_URL)/.test(message)) {
    return new ModelError('http', `Secure connection failed (${message}).`, { source: true, retry: false, cause: error });
  }
  if (/net::ERR_/.test(message)) {
    return new ModelError('offline', `Could not reach the download server (${message}).`, { cause: error });
  }
  return new ModelError('io', `Could not write the model file (${code ?? message}).`, { retry: false, cause: error });
}

const sleepUnlessAborted = (ms: number, ctl: Control): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(cancelledError('Download stopped.'));
    };
    const timer = setTimeout(() => {
      ctl.listeners.delete(cancel);
      resolve();
    }, ms);
    ctl.listeners.add(cancel);
    if (ctl.aborted) {
      cancel();
    }
  });

function newControl(): Control {
  const ctl: Control = {
    aborted: false,
    reason: null,
    listeners: new Set<() => void>(),
    abort(reason: string): void {
      if (!ctl.aborted) {
        ctl.aborted = true;
        ctl.reason = reason;
        [...ctl.listeners].forEach((listener) => listener());
      }
    },
  };
  return ctl;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new ModelError('io', `Could not remove a model file (${errorCode(error) ?? 'error'}).`, { retry: false, cause: error });
    }
  }
}

async function hashFile(file: string, hash: crypto.Hash = crypto.createHash('sha256')): Promise<crypto.Hash> {
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash;
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Creates the model manager for one models directory.
 * @param options `modelsDir` is chosen by main (`userData/models`).
 * @returns Manager: status, onStatus, resolve, start, pause, resume, cancel, remove, checkConnection, dispose.
 */
export function createModelManager({
  modelsDir,
  appVersion,
  log = NO_LOG,
}: {
  modelsDir: string;
  appVersion: string;
  log?: ModelLog;
}): ModelManager {
  const markerPath = path.join(modelsDir, MARKER_FILE);
  const lockPath = path.join(modelsDir, LOCK_FILE);
  const listeners = new Set<(status: ModelStatus) => void>();
  let status: ModelStatus = {
    state: 'checking',
    modelId: null,
    bytes: 0,
    total: CATALOG[0].size,
    bytesPerSec: 0,
    etaSec: null,
    external: false,
    error: null,
  };
  let run: { ctl: Control; promise: Promise<void> } | null = null;
  let offlineTimer: NodeJS.Timeout | undefined;
  let lastEmit = 0;
  let speedSamples: { at: number; bytes: number }[] = [];
  let resolving: Promise<ResolvedModel | null> | null = null;
  let probing: Promise<ConnectionProbe> | null = null;
  let hashCache: { file: string | null; bytes: number; hash: crypto.Hash | null } = { file: null, bytes: -1, hash: null };
  let disposed = false;
  /** Catalog ids whose file was hashed (or just downloaded and verified) during this run. */
  const hashedThisRun = new Set<string>();

  const partPathOf = (entry: CatalogEntry): string => path.join(modelsDir, `${entry.file}.part`);
  const filePathOf = (entry: CatalogEntry): string => path.join(modelsDir, entry.file);

  function emit(): void {
    lastEmit = Date.now();
    const snapshot = { ...status };
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn(`Model status listener failed: ${errorMessage(error)}`);
      }
    });
  }

  function setStatus(patch: Partial<ModelStatus>): void {
    status = { ...status, ...patch };
    emit();
  }

  function setProgress(bytes: number, total: number, force: boolean): void {
    const now = Date.now();
    speedSamples.push({ at: now, bytes });
    speedSamples = speedSamples.filter((sample) => now - sample.at <= SPEED_WINDOW_MS);
    const first = speedSamples[0];
    const span = now - first.at;
    const bytesPerSec = span > 500 ? Math.round(((bytes - first.bytes) * 1000) / span) : status.bytesPerSec;
    status = {
      ...status,
      bytes,
      total,
      bytesPerSec,
      etaSec: bytesPerSec > 0 ? Math.ceil((total - bytes) / bytesPerSec) : null,
    };
    if (force || now - lastEmit >= PROGRESS_INTERVAL_MS) {
      emit();
    }
  }

  function setError(error: ModelError): void {
    log.warn(`Model download failed: ${error.code} - ${error.message}`);
    setStatus({ state: 'error', error: { code: error.code, message: error.message }, bytesPerSec: 0, etaSec: null });
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(modelsDir, { recursive: true, mode: 0o700 });
  }

  async function writeMarker(entry: CatalogEntry): Promise<void> {
    const stat = await fs.stat(filePathOf(entry));
    const marker = {
      version: 1,
      id: entry.id,
      file: entry.file,
      size: entry.size,
      sha256: entry.sha256,
      verifiedAt: new Date().toISOString(),
      mtimeMs: stat.mtimeMs,
    };
    const temp = `${markerPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(integrity.sign(marker, MARKER_FILE)), { mode: 0o600 });
    await fs.rename(temp, markerPath);
  }

  async function readMarker(): Promise<Marker | null> {
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Marker | null;
      // An unsigned (older) or tampered marker counts as missing, which forces a re-hash.
      return marker && typeof marker === 'object' && integrity.verify(marker, MARKER_FILE) ? marker : null;
    } catch {
      return null;
    }
  }

  /** Deletes model files except `keepId`; `partsOnly` keeps every .gguf and the marker. */
  async function removeModelFiles({ keepId = null, partsOnly = false }: { keepId?: string | null; partsOnly?: boolean } = {}): Promise<void> {
    for (const entry of CATALOG) {
      if (entry.id !== keepId) {
        if (!partsOnly) {
          await unlinkQuiet(filePathOf(entry));
        }
        await unlinkQuiet(partPathOf(entry));
      }
    }
    if (keepId === null && !partsOnly) {
      await unlinkQuiet(markerPath);
    }
  }

  /**
   * Verifies the model on disk and returns it or null. The signed marker (size, mtime) only vouches for a file that
   * was already hashed during this run; the first check of every run re-hashes the file.
   */
  async function verifyOnDisk(): Promise<ResolvedModel | null> {
    const marker = await readMarker();
    const entries = marker
      ? [...CATALOG].sort((a, b) => Number(b.id === marker.id) - Number(a.id === marker.id))
      : CATALOG;
    for (const entry of entries) {
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(filePathOf(entry));
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size !== entry.size) {
        continue;
      }
      const trusted =
        hashedThisRun.has(entry.id) &&
        marker &&
        marker.id === entry.id &&
        marker.file === entry.file &&
        marker.size === entry.size &&
        marker.sha256 === entry.sha256 &&
        marker.mtimeMs === stat.mtimeMs;
      if (trusted) {
        return { id: entry.id, path: filePathOf(entry), size: entry.size };
      }
      const digest = (await hashFile(filePathOf(entry))).digest('hex');
      if (digest === entry.sha256) {
        await writeMarker(entry);
        hashedThisRun.add(entry.id);
        return { id: entry.id, path: filePathOf(entry), size: entry.size };
      }
      log.warn('A model file failed its integrity check and was removed.');
      await unlinkQuiet(filePathOf(entry));
    }
    return null;
  }

  async function refresh(force = false): Promise<ResolvedModel | null> {
    let model: ResolvedModel | null = null;
    try {
      model = await verifyOnDisk();
    } catch (error) {
      log.warn(`Could not check the model: ${errorMessage(error)}`);
    }
    if (force || ['checking', 'missing', 'ready'].includes(status.state)) {
      setStatus(
        model
          ? { state: 'ready', modelId: model.id, bytes: model.size, total: model.size, error: null, external: false }
          : { state: 'missing', modelId: null, bytes: 0, total: CATALOG[0].size, error: null, external: false },
      );
    }
    return model;
  }

  const initialCheck = fs
    .mkdir(modelsDir, { recursive: true, mode: 0o700 })
    .catch((error) => log.warn(`Could not create the models folder: ${errorCode(error) ?? errorMessage(error)}`))
    .then(() => refresh());

  function resolve(): Promise<ResolvedModel | null> {
    if (!resolving) {
      resolving = initialCheck.then(() => refresh()).finally(() => {
        resolving = null;
      });
    }
    return resolving;
  }

  async function acquireLock(): Promise<boolean> {
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw new ModelError('io', `Could not lock the models folder (${errorCode(error) ?? 'error'}).`, { retry: false, cause: error });
        }
        if (!(await lockIsStale())) {
          return false;
        }
        await unlinkQuiet(lockPath);
      }
    }
    return false;
  }

  async function lockIsStale(): Promise<boolean> {
    try {
      const holder = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown } | null;
      if (typeof holder?.pid !== 'number' || !Number.isInteger(holder.pid) || holder.pid === process.pid || !processAlive(holder.pid)) {
        return true;
      }
      const times = [(await fs.stat(lockPath)).mtimeMs];
      for (const entry of CATALOG) {
        try {
          times.push((await fs.stat(partPathOf(entry))).mtimeMs);
        } catch {
          // no .part for this source
        }
      }
      return Date.now() - Math.max(...times) > LOCK_STALE_MS;
    } catch (error) {
      return errorCode(error) === 'ENOENT' || error instanceof SyntaxError;
    }
  }

  async function releaseLock(): Promise<void> {
    try {
      const holder = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown } | null;
      if (holder?.pid === process.pid) {
        await unlinkQuiet(lockPath);
      }
    } catch {
      // lock already gone
    }
  }

  async function freeBytes(): Promise<number> {
    const stats = await fs.statfs(modelsDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  /** Hash of the first `partSize` bytes of the .part, reusing the in-memory state when it matches. */
  async function hashForPart(entry: CatalogEntry, partSize: number): Promise<crypto.Hash> {
    const file = partPathOf(entry);
    if (hashCache.hash && hashCache.file === file && hashCache.bytes === partSize && partSize > 0) {
      return hashCache.hash;
    }
    return hashFile(file);
  }

  /** One HTTP transfer: appends to the .part, hashing as it goes. Resolves with the hash once the pinned size has been received. */
  function transfer(entry: CatalogEntry, partSize: number, hash: crypto.Hash, ctl: Control): Promise<crypto.Hash> {
    return new Promise<crypto.Hash>((resolveTransfer, rejectTransfer) => {
      const file = partPathOf(entry);
      const state: {
        base: number;
        hash: crypto.Hash;
        out: fsSync.WriteStream | null;
        request: ClientRequest | null;
        settled: boolean;
        received: number;
        redirects: number;
      } = { base: partSize, hash, out: null, request: null, settled: false, received: 0, redirects: 0 };
      let connectTimer: NodeJS.Timeout | undefined;
      let stallTimer: NodeJS.Timeout | undefined;

      const finish = async (error: ModelError | null): Promise<void> => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        clearTimeout(connectTimer);
        clearTimeout(stallTimer);
        ctl.listeners.delete(onAbort);
        if (error) {
          try {
            state.request?.abort();
          } catch {
            // request already finished
          }
        }
        const { out } = state;
        if (out) {
          await new Promise<void>((done) => {
            out.end(done);
          });
        }
        hashCache = { file, bytes: state.base + state.received, hash: state.hash };
        if (error) {
          rejectTransfer(error);
        } else {
          resolveTransfer(state.hash);
        }
      };
      const onAbort = (): void => {
        void finish(cancelledError('Download stopped.'));
      };
      const armStall = (): void => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => void finish(new ModelError('offline', 'The download stalled.')), STALL_TIMEOUT_MS);
      };

      const request = net.request({
        url: entry.url,
        method: 'GET',
        session: session.fromPartition(PARTITION),
        redirect: 'manual',
        useSessionCookies: false,
        credentials: 'omit',
        cache: 'no-store',
      });
      state.request = request;
      request.setHeader('User-Agent', `CodePad/${appVersion}`);
      request.setHeader('Accept-Encoding', 'identity');
      if (partSize > 0) {
        request.setHeader('Range', `bytes=${partSize}-`);
      }
      ctl.listeners.add(onAbort);
      if (ctl.aborted) {
        onAbort();
      }
      connectTimer = setTimeout(
        () => void finish(new ModelError('offline', 'Connecting to the download server timed out.')),
        CONNECT_TIMEOUT_MS
      );

      request.on('redirect', (_status, _method, redirectUrl) => {
        let target: URL;
        try {
          target = new URL(redirectUrl);
        } catch {
          void finish(new ModelError('http', 'The server sent an invalid redirect.', { source: true, retry: false }));
          return;
        }
        state.redirects += 1;
        if (target.protocol !== 'https:' || !hostAllowed(target.hostname, entry.hosts) || state.redirects > MAX_REDIRECTS) {
          void finish(new ModelError('http', 'The server redirected to an address that is not allowed.', { source: true, retry: false }));
          return;
        }
        request.followRedirect();
      });
      request.on('error', (error) => void finish(classify(error)));
      request.on('response', (response) => {
        clearTimeout(connectTimer);
        armStall();
        onResponse(response as PausableMessage).catch((error: unknown) => void finish(classify(error)));
      });
      request.end();

      async function onResponse(response: PausableMessage): Promise<void> {
        const { statusCode } = response;
        const headers = response.headers;
        const encoding = headerValue(headers, 'content-encoding');
        if (encoding && encoding !== 'identity') {
          throw new ModelError('http', 'The server used an unsupported encoding.', { source: true, retry: false });
        }
        let flags = 'a';
        if (statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headerValue(headers, 'content-range') ?? '');
          if (!range || Number(range[1]) !== partSize || Number(range[3]) !== entry.size) {
            throw new ModelError('http', 'The server returned an unexpected byte range.', { source: true, dropPart: true });
          }
        } else if (statusCode === 200) {
          if (Number(headerValue(headers, 'content-length')) !== entry.size) {
            throw new ModelError('http', 'The server returned an unexpected file size.', { source: true, retry: false });
          }
          state.base = 0;
          state.hash = crypto.createHash('sha256');
          flags = 'w';
        } else if (statusCode === 416) {
          throw new ModelError('http', 'The server rejected the resume position.', { dropPart: true });
        } else {
          throw new ModelError('http', `The download server answered with HTTP ${statusCode}.`, {
            source: true,
            retry: statusCode >= 500 || TRANSIENT_HTTP.has(statusCode),
          });
        }
        if (state.settled) {
          return;
        }
        const out = fsSync.createWriteStream(file, { flags, mode: 0o600 });
        state.out = out;
        out.on('error', (error) => void finish(classify(error)));
        response.on('data', (chunk: Buffer) => {
          if (state.settled) {
            return;
          }
          armStall();
          state.received += chunk.length;
          if (state.base + state.received > entry.size) {
            void finish(new ModelError('http', 'The server sent more data than expected.', { source: true, retry: false, dropPart: true }));
            return;
          }
          state.hash.update(chunk);
          if (!out.write(chunk)) {
            response.pause();
            out.once('drain', () => response.resume());
          }
          setProgress(state.base + state.received, entry.size, false);
        });
        response.on('end', () => {
          if (state.base + state.received === entry.size) {
            void finish(null);
          } else {
            void finish(new ModelError('offline', 'The connection closed before the download finished.'));
          }
        });
        response.on('error', (error) => void finish(classify(error)));
        response.on('aborted', () => void finish(new ModelError('offline', 'The connection was interrupted.')));
      }
    });
  }

  /** Downloads one source once, then verifies and commits it. */
  async function attempt(entry: CatalogEntry, ctl: Control): Promise<void> {
    await ensureDir();
    const part = partPathOf(entry);
    let partSize = 0;
    try {
      partSize = (await fs.stat(part)).size;
    } catch {
      partSize = 0;
    }
    if (partSize > entry.size) {
      await unlinkQuiet(part);
      partSize = 0;
    }
    const needed = entry.size - partSize + DISK_MARGIN;
    if ((await freeBytes()) < needed) {
      throw new ModelError('disk', `Not enough free disk space: about ${Math.ceil(needed / MiB)} MB needed.`, { retry: false });
    }
    throwIfAborted(ctl);
    speedSamples = [];
    setStatus({ state: 'downloading', modelId: entry.id, bytes: partSize, total: entry.size, error: null, external: false });
    let hash = partSize > 0 ? await hashForPart(entry, partSize) : crypto.createHash('sha256');
    hashCache = { file: null, bytes: -1, hash: null };
    throwIfAborted(ctl);
    if (partSize < entry.size) {
      try {
        hash = await transfer(entry, partSize, hash, ctl);
      } catch (error) {
        if (error instanceof ModelError && error.dropPart) {
          await unlinkQuiet(part);
          hashCache = { file: null, bytes: -1, hash: null };
        }
        throw error;
      }
    }
    setProgress(entry.size, entry.size, true);
    setStatus({ state: 'verifying', bytesPerSec: 0, etaSec: null });
    if (hash.digest('hex') !== entry.sha256) {
      await unlinkQuiet(part);
      hashCache = { file: null, bytes: -1, hash: null };
      throw new ModelError('integrity', 'The downloaded file failed its integrity check.', { source: true, retry: false });
    }
    await fsyncFile(part);
    await fs.rename(part, filePathOf(entry));
    await writeMarker(entry);
    hashedThisRun.add(entry.id);
    await removeModelFiles({ keepId: entry.id });
  }

  async function downloadSource(entry: CatalogEntry, ctl: Control): Promise<void> {
    let lastError: ModelError | null = null;
    for (let tries = 1; tries <= ATTEMPTS_PER_SOURCE; tries += 1) {
      try {
        await attempt(entry, ctl);
        return;
      } catch (raw) {
        const error = classify(raw);
        if (ctl.aborted || error.code === 'cancelled') {
          throw cancelledError('Download stopped.');
        }
        lastError = error;
        log.warn(`Model download attempt ${tries} failed: ${error.code} - ${error.message}`);
        if (!error.retry || tries === ATTEMPTS_PER_SOURCE) {
          break;
        }
        const delay = BACKOFF_BASE_MS * 2 ** (tries - 1) * (0.8 + Math.random() * 0.4);
        await sleepUnlessAborted(delay, ctl);
      }
    }
    throw lastError;
  }

  async function orderedSources(): Promise<CatalogEntry[]> {
    const withPart: CatalogEntry[] = [];
    const without: CatalogEntry[] = [];
    for (const entry of CATALOG) {
      const hasPart = await pathExists(partPathOf(entry));
      (hasPart ? withPart : without).push(entry);
    }
    return [...withPart, ...without];
  }

  async function downloadAll(ctl: Control): Promise<void> {
    const sources = await orderedSources();
    let lastError: unknown = null;
    for (const entry of sources) {
      try {
        await downloadSource(entry, ctl);
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ModelError) || error.code === 'cancelled' || !error.source) {
          throw error;
        }
        log.warn(`Model source ${entry.id} failed; trying the next source.`);
      }
    }
    throw lastError;
  }

  /** Follows a download owned by another process (e.g. the installer) by polling its .part size. */
  async function followExternal(ctl: Control): Promise<boolean> {
    setStatus({ state: 'downloading', external: true, error: null });
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    for (;;) {
      await sleepUnlessAborted(EXTERNAL_POLL_MS, ctl);
      if (await verifyOnDisk()) {
        return true;
      }
      if (!(await pathExists(lockPath)) || (await lockIsStale())) {
        return false;
      }
      if (Date.now() > deadline) {
        throw new ModelError('locked', 'Another process is still downloading the model.', { retry: false });
      }
      let bytes = status.bytes;
      for (const entry of CATALOG) {
        try {
          bytes = Math.max(bytes, (await fs.stat(partPathOf(entry))).size);
        } catch {
          // no .part for this source
        }
      }
      setProgress(bytes, status.total, false);
    }
  }

  async function runDownload(ctl: Control): Promise<void> {
    await initialCheck;
    if (await refresh()) {
      return;
    }
    await ensureDir();
    setStatus({ state: 'downloading', error: null, bytes: 0, bytesPerSec: 0, etaSec: null });
    for (;;) {
      if (await acquireLock()) {
        try {
          await downloadAll(ctl);
        } finally {
          await releaseLock();
        }
        break;
      }
      if (await followExternal(ctl)) {
        break;
      }
    }
    await refresh(true);
    log.info('The AI model is ready.');
  }

  function scheduleOfflineRetry(): void {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => {
      start().catch(() => {});
    }, OFFLINE_RETRY_MS);
    offlineTimer.unref();
  }

  /**
   * Starts (or joins) the download. Idempotent.
   * @returns Resolves when the model is ready; rejects with a ModelError (`code`).
   */
  async function start(): Promise<void> {
    if (disposed) {
      throw cancelledError('The model manager was disposed.');
    }
    await initialCheck;
    if (status.state === 'ready') {
      return;
    }
    if (run) {
      return run.promise;
    }
    clearTimeout(offlineTimer);
    const ctl = newControl();
    const current: { ctl: Control; promise: Promise<void> } = { ctl, promise: Promise.resolve() };
    run = current;
    current.promise = runDownload(ctl)
      .catch((raw: unknown) => {
        const error = classify(raw);
        if (ctl.aborted) {
          throw cancelledError(ctl.reason === 'pause' ? 'Download paused.' : 'Download stopped.');
        }
        if (error.code === 'offline') {
          setStatus({ state: 'offline', error: { code: 'offline', message: error.message }, bytesPerSec: 0, etaSec: null });
          scheduleOfflineRetry();
        } else {
          setError(error);
        }
        throw error;
      })
      .finally(() => {
        if (run === current) {
          run = null;
        }
      });
    current.promise.catch(() => {});
    return current.promise;
  }

  async function stopRun(reason: string): Promise<void> {
    const current = run;
    if (current) {
      current.ctl.abort(reason);
      await current.promise.catch(() => {});
    }
    clearTimeout(offlineTimer);
  }

  /** Aborts the transfer but keeps the .part for a later resume. */
  function pause(): void {
    if (status.state === 'downloading' || status.state === 'offline') {
      setStatus({ state: 'paused', bytesPerSec: 0, etaSec: null, external: false });
      stopRun('pause').catch(() => {});
    }
  }

  /** Continues a paused or failed download from its .part. */
  async function resume(): Promise<void> {
    if (['paused', 'offline', 'error', 'missing'].includes(status.state)) {
      return start();
    }
    return run ? run.promise : undefined;
  }

  /** Aborts and deletes the .part. */
  async function cancel(): Promise<void> {
    await stopRun('cancel');
    if (status.state !== 'ready') {
      await removeModelFiles({ partsOnly: true });
      setStatus({ state: 'missing', modelId: null, bytes: 0, bytesPerSec: 0, etaSec: null, error: null, external: false });
    }
  }

  /** Deletes the model file, any .part and the marker. The caller must unload the engine first. */
  async function remove(): Promise<void> {
    await stopRun('cancel');
    await removeModelFiles();
    setStatus({ state: 'missing', modelId: null, bytes: 0, total: CATALOG[0].size, bytesPerSec: 0, etaSec: null, error: null, external: false });
  }

  function probe(entry: CatalogEntry, timeoutMs: number): Promise<ConnectionProbe> {
    return new Promise<ConnectionProbe>((resolveProbe) => {
      let done = false;
      const request = net.request({
        url: entry.url,
        method: 'HEAD',
        session: session.fromPartition(PARTITION),
        redirect: 'manual',
        useSessionCookies: false,
        credentials: 'omit',
        cache: 'no-store',
      });
      const settle = (result: ConnectionProbe): void => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          try {
            request.abort();
          } catch {
            // request already finished
          }
          resolveProbe(result);
        }
      };
      const timer: NodeJS.Timeout = setTimeout(() => settle({ online: false, error: 'timeout' }), timeoutMs);
      request.setHeader('User-Agent', `CodePad/${appVersion}`);
      request.on('redirect', (redirectStatus) => settle({ online: PROBE_OK.has(redirectStatus), source: entry.id }));
      request.on('response', (response) => {
        const lengthOk = entry.id !== CATALOG[0].id || Number(headerValue(response.headers, 'content-length')) === entry.size;
        settle(
          PROBE_OK.has(response.statusCode) && lengthOk
            ? { online: true, source: entry.id }
            : { online: false, error: `HTTP ${response.statusCode}` },
        );
      });
      request.on('error', (error) => settle({ online: false, error: String(error.message).replace(/^net::/, '') }));
      request.end();
    });
  }

  /**
   * Checks that a model host answers (HEAD of the primary, then the mirror). One probe runs at a time.
   * @param options Per-host timeout.
   * @returns Probe result.
   */
  function checkConnection({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<ConnectionProbe> {
    if (!probing) {
      probing = (async () => {
        let result: ConnectionProbe = { online: false, error: 'unreachable' };
        for (const entry of CATALOG) {
          result = await probe(entry, timeoutMs);
          if (result.online) {
            break;
          }
        }
        return result;
      })().finally(() => {
        probing = null;
      });
    }
    return probing;
  }

  /** Aborts any transfer (keeping the .part), stops timers and releases the lock. */
  async function dispose(): Promise<void> {
    disposed = true;
    await stopRun('dispose');
    await releaseLock();
    listeners.clear();
  }

  return {
    status: () => ({ ...status }),
    onStatus(callback: (status: ModelStatus) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    resolve,
    start,
    pause,
    resume,
    cancel,
    remove,
    checkConnection,
    dispose,
  };
}
