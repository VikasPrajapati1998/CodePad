/**
 * Ollama registry pull (main process). Downloads the GGUF weights of a `name:tag` model from registry.ollama.ai
 * (no Ollama daemon involved): manifest, resumable blob download, size and SHA-256 check, atomic rename.
 * The manifest digest is the integrity anchor; hosts are only a transport allow-list (https, per redirect hop).
 * Network code of the same trust level as modelDownloader.ts; the renderer never supplies a URL or path.
 */

import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ModelError, errorCode, errorMessage, type ModelLog, type PausableMessage } from './modelDownloader';
import { GgufError, validateGgufHeader } from './ggufHeader';

const MiB = 1024 * 1024;
const REGISTRY_HOST = 'registry.ollama.ai';
const HOSTS = Object.freeze([REGISTRY_HOST, '*.r2.cloudflarestorage.com']);
const DEFAULT_NAMESPACE = 'library';
const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
export const MAX_BLOB_BYTES = 20 * 1024 * MiB;
const MAX_MANIFEST_BYTES = 1 * MiB;
const MAX_REDIRECTS = 5;
const ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2000;
const CONNECT_TIMEOUT_MS = 20000;
const STALL_TIMEOUT_MS = 30000;
const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 4000;
const DISK_MARGIN = 64 * MiB;
const PARTITION = 'codepad-model';
const TRANSIENT_HTTP = new Set([408, 425, 429]);
const NO_LOG: ModelLog = Object.freeze({ info() {}, warn() {}, error() {} });
const SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}';
const REF_PATTERN = new RegExp(`^(?:(${SEGMENT})/)?(${SEGMENT}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$`);
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
// Digests being downloaded now: two refs that share a digest would otherwise write the same .part file.
const activeDigests = new Set<string>();

/** Parts of an Ollama model reference. */
export interface ModelRefParts {
  namespace: string;
  name: string;
  tag: string;
}

/** Progress report of a pull. */
export interface PullProgress {
  state: 'downloading' | 'verifying';
  bytes: number;
  total: number;
  bytesPerSec: number;
  etaSec: number | null;
}

/** Result of a pull: the verified file. */
export interface PullResult {
  path: string;
  digest: string;
  size: number;
  ref: string;
}

/** Options of {@link pullOllamaModel}. */
export interface PullOptions {
  /** `name:tag` or `namespace/name:tag` (see `parseModelRef`). */
  ref: string;
  /** Target folder chosen by main (`userData/models`). */
  modelsDir: string;
  /** Used in the User-Agent. */
  appVersion: string;
  /** Cancels the pull (the .part is kept for a later resume). */
  signal?: AbortSignal;
  onProgress?: (progress: PullProgress) => void;
  log?: ModelLog;
}

interface HttpGetOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  appVersion: string;
  onResponse(response: PausableMessage): void;
  onData(chunk: Buffer): Promise<void> | undefined;
}

interface ModelLayer {
  digest: string;
  hex: string;
  size: number;
}

interface ManifestLayer {
  mediaType?: unknown;
  digest?: unknown;
  size?: unknown;
}

type Reporter = (bytes: number, force: boolean, state?: PullProgress['state']) => void;

/**
 * Parses and validates an Ollama model reference.
 * @param ref `name:tag` or `namespace/name:tag` (lower-case name parts; the tag is required).
 * @returns Parts (namespace defaults to `library`), or null when invalid.
 */
export function parseModelRef(ref: unknown): ModelRefParts | null {
  const match = typeof ref === 'string' ? REF_PATTERN.exec(ref) : null;
  return match ? { namespace: match[1] || DEFAULT_NAMESPACE, name: match[2], tag: match[3] } : null;
}

const cancelled = (): ModelError => new ModelError('cancelled', 'Download stopped.', { retry: false });

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return HOSTS.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
  );
}

const headerValue = (headers: Record<string, string | string[]>, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

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
    return new ModelError('offline', `Could not reach the model registry (${message}).`, { cause: error });
  }
  return new ModelError('io', `Could not write the model file (${code ?? message}).`, { retry: false, cause: error });
}

/**
 * One HTTPS GET with manual, allow-listed redirects, connect and stall timeouts and abort support.
 * `onResponse` may throw to reject; `onData` may return a promise to apply back-pressure.
 */
function httpGet(url: string, { headers = {}, signal, appVersion, onResponse, onData }: HttpGetOptions): Promise<void> {
  // Loaded lazily so the pure helpers of this module work outside Electron.
  const { net, session } = require('electron') as typeof import('electron');
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let redirects = 0;
    let connectTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    const request = net.request({
      url,
      method: 'GET',
      session: session.fromPartition(PARTITION),
      redirect: 'manual',
      useSessionCookies: false,
      credentials: 'omit',
      cache: 'no-store',
    });
    const finish = (error: ModelError | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(stallTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        try {
          request.abort();
        } catch {
          // request already finished
        }
        reject(error);
      } else {
        resolve();
      }
    };
    function onAbort(): void {
      finish(cancelled());
    }
    const armStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(new ModelError('offline', 'The download stalled.')), STALL_TIMEOUT_MS);
    };

    request.setHeader('User-Agent', `CodePad/${appVersion}`);
    request.setHeader('Accept-Encoding', 'identity');
    Object.entries(headers).forEach(([name, value]) => request.setHeader(name, value));
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    connectTimer = setTimeout(() => finish(new ModelError('offline', 'Connecting to the model registry timed out.')), CONNECT_TIMEOUT_MS);

    request.on('redirect', (_status, _method, redirectUrl) => {
      let target: URL;
      try {
        target = new URL(redirectUrl);
      } catch {
        finish(new ModelError('http', 'The server sent an invalid redirect.', { source: true, retry: false }));
        return;
      }
      redirects += 1;
      if (target.protocol !== 'https:' || !hostAllowed(target.hostname) || redirects > MAX_REDIRECTS) {
        finish(new ModelError('http', 'The server redirected to an address that is not allowed.', { source: true, retry: false }));
        return;
      }
      request.followRedirect();
    });
    request.on('error', (error) => finish(classify(error)));
    request.on('response', (response) => {
      clearTimeout(connectTimer);
      armStall();
      try {
        const encoding = headerValue(response.headers, 'content-encoding');
        if (encoding && encoding !== 'identity') {
          throw new ModelError('http', 'The server used an unsupported encoding.', { source: true, retry: false });
        }
        onResponse(response as PausableMessage);
      } catch (error) {
        finish(classify(error));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        armStall();
        try {
          const pending = onData(chunk);
          if (pending && typeof pending.then === 'function') {
            (response as PausableMessage).pause();
            pending.then(
              () => (response as PausableMessage).resume(),
              (error: unknown) => finish(classify(error))
            );
          }
        } catch (error) {
          finish(classify(error));
        }
      });
      response.on('end', () => finish(null));
      response.on('error', (error) => finish(classify(error)));
      response.on('aborted', () => finish(new ModelError('offline', 'The connection was interrupted.')));
    });
    request.end();
  });
}

/** Fetches the manifest and returns `{digest, hex, size}` of the model layer. */
async function fetchModelLayer(parts: ModelRefParts, { signal, appVersion }: { signal?: AbortSignal; appVersion: string }): Promise<ModelLayer> {
  const url = `https://${REGISTRY_HOST}/v2/${encodeURIComponent(parts.namespace)}/${encodeURIComponent(parts.name)}/manifests/${encodeURIComponent(parts.tag)}`;
  const chunks: Buffer[] = [];
  let received = 0;
  await httpGet(url, {
    headers: { Accept: MANIFEST_ACCEPT },
    signal,
    appVersion,
    onResponse(response: PausableMessage) {
      if (response.statusCode === 404) {
        throw new ModelError('http', 'This model was not found in the Ollama registry.', { retry: false });
      }
      if (response.statusCode !== 200) {
        throw new ModelError('http', `The model registry answered with HTTP ${response.statusCode}.`, {
          retry: response.statusCode >= 500 || TRANSIENT_HTTP.has(response.statusCode),
        });
      }
    },
    onData(chunk: Buffer) {
      received += chunk.length;
      if (received > MAX_MANIFEST_BYTES) {
        throw new ModelError('http', 'The model manifest is too large.', { source: true, retry: false });
      }
      chunks.push(chunk);
      return undefined;
    },
  });
  let manifest: { layers?: unknown } | null;
  try {
    manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { layers?: unknown } | null;
  } catch (error) {
    throw new ModelError('http', 'The model manifest is not valid.', { retry: false, cause: error });
  }
  const layers = (Array.isArray(manifest?.layers) ? manifest.layers : []) as (ManifestLayer | null)[];
  const layer = layers.find((item) => item && item.mediaType === MODEL_MEDIA_TYPE);
  const match = typeof layer?.digest === 'string' ? DIGEST_PATTERN.exec(layer.digest) : null;
  if (!layer || typeof layer.digest !== 'string' || !match || typeof layer.size !== 'number' || !Number.isSafeInteger(layer.size) || layer.size < 1) {
    throw new ModelError('http', 'The model manifest has no usable model file.', { retry: false });
  }
  if (layer.size > MAX_BLOB_BYTES) {
    throw new ModelError('http', `The model is larger than the ${Math.round(MAX_BLOB_BYTES / (1024 * MiB))} GB limit.`, { retry: false });
  }
  return { digest: layer.digest, hex: match[1], size: layer.size };
}

async function hashFile(file: string): Promise<crypto.Hash> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash;
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

/** Creates the throttled progress reporter. */
function createProgress(onProgress: PullOptions['onProgress'], total: number): Reporter {
  let samples: { at: number; bytes: number }[] = [];
  let last = 0;
  return (bytes, force, state = 'downloading'): void => {
    const now = Date.now();
    samples.push({ at: now, bytes });
    samples = samples.filter((sample) => now - sample.at <= SPEED_WINDOW_MS);
    if (force || now - last >= PROGRESS_INTERVAL_MS) {
      last = now;
      const span = now - samples[0].at;
      const bytesPerSec = span > 500 ? Math.round(((bytes - samples[0].bytes) * 1000) / span) : 0;
      try {
        onProgress?.({
          state,
          bytes,
          total,
          bytesPerSec,
          etaSec: bytesPerSec > 0 ? Math.ceil((total - bytes) / bytesPerSec) : null,
        });
      } catch {
        // A faulty progress listener must not stop the download.
      }
    }
  };
}

/** One transfer into the .part file (resuming from its size). Resolves with the hash of the whole file. */
async function transfer({
  url,
  part,
  size,
  signal,
  appVersion,
  report,
}: {
  url: string;
  part: string;
  size: number;
  signal?: AbortSignal;
  appVersion: string;
  report: Reporter;
}): Promise<crypto.Hash> {
  let partSize = 0;
  try {
    partSize = (await fs.stat(part)).size;
  } catch {
    partSize = 0;
  }
  if (partSize > size) {
    await unlinkQuiet(part);
    partSize = 0;
  }
  const hash = partSize > 0 ? await hashFile(part) : crypto.createHash('sha256');
  if (partSize === size) {
    return hash;
  }
  const state: { base: number; hash: crypto.Hash; out: fsSync.WriteStream | null; writeError: Error | null; received: number } = {
    base: partSize,
    hash,
    out: null,
    writeError: null,
    received: 0,
  };
  try {
    await httpGet(url, {
      headers: partSize > 0 ? { Range: `bytes=${partSize}-` } : {},
      signal,
      appVersion,
      onResponse(response: PausableMessage) {
        const { statusCode, headers } = response;
        let flags = 'a';
        if (statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headerValue(headers, 'content-range') ?? '');
          if (!range || Number(range[1]) !== partSize || Number(range[3]) !== size) {
            throw new ModelError('http', 'The server returned an unexpected byte range.', { source: true, dropPart: true });
          }
        } else if (statusCode === 200) {
          if (Number(headerValue(headers, 'content-length')) !== size) {
            throw new ModelError('http', 'The server returned an unexpected file size.', { source: true, retry: false });
          }
          state.base = 0;
          state.hash = crypto.createHash('sha256');
          flags = 'w';
        } else if (statusCode === 416) {
          throw new ModelError('http', 'The server rejected the resume position.', { dropPart: true });
        } else {
          throw new ModelError('http', `The model registry answered with HTTP ${statusCode}.`, {
            source: true,
            retry: statusCode >= 500 || TRANSIENT_HTTP.has(statusCode),
          });
        }
        const out = fsSync.createWriteStream(part, { flags, mode: 0o600 });
        state.out = out;
        out.on('error', (error) => {
          state.writeError = error;
        });
      },
      onData(chunk: Buffer) {
        if (state.writeError) {
          throw state.writeError;
        }
        state.received += chunk.length;
        if (state.base + state.received > size) {
          throw new ModelError('http', 'The server sent more data than expected.', { source: true, retry: false, dropPart: true });
        }
        state.hash.update(chunk);
        report(state.base + state.received, false);
        const { out } = state;
        return !out || out.write(chunk)
          ? undefined
          : new Promise<void>((resolve) => {
              out.once('drain', () => resolve());
            });
      },
    });
  } finally {
    const { out } = state;
    if (out) {
      await new Promise<void>((done) => {
        out.end(done);
      });
    }
  }
  if (state.writeError) {
    throw state.writeError;
  }
  if (state.base + state.received !== size) {
    throw new ModelError('offline', 'The connection closed before the download finished.');
  }
  return state.hash;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(cancelled());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });

/**
 * Pulls the GGUF weights of an Ollama registry model into `<modelsDir>/<sha256-hex>.gguf`.
 * Resumable (an interrupted or cancelled pull keeps `<hex>.gguf.part`); the result is verified against the
 * manifest size and digest and renamed atomically. An already complete file is re-verified and reused.
 * Two concurrent pulls of the same digest (even under different refs) are refused.
 * @param options See {@link PullOptions}.
 * @returns The verified file.
 * @throws {ModelError} `code`: `invalid | http | offline | integrity | disk | io | cancelled`.
 */
export async function pullOllamaModel({ ref, modelsDir, appVersion, signal, onProgress, log = NO_LOG }: PullOptions): Promise<PullResult> {
  const parts = parseModelRef(ref);
  if (!parts) {
    throw new ModelError('invalid', 'Enter a model as name:tag, for example llama3.1:8b.', { retry: false });
  }
  if (signal?.aborted) {
    throw cancelled();
  }
  await fs.mkdir(modelsDir, { recursive: true, mode: 0o700 });
  const layer = await retrying(() => fetchModelLayer(parts, { signal, appVersion }), signal, log);
  if (activeDigests.has(layer.hex)) {
    throw new ModelError('io', 'This model file is already being downloaded.', { retry: false });
  }
  activeDigests.add(layer.hex);
  try {
    return await downloadBlob(layer, parts, { ref, modelsDir, appVersion, signal, onProgress, log });
  } finally {
    activeDigests.delete(layer.hex);
  }
}

/** Downloads, verifies and renames the blob of `layer` (the caller holds the per-digest lock). */
async function downloadBlob(
  layer: ModelLayer,
  parts: ModelRefParts,
  { ref, modelsDir, appVersion, signal, onProgress, log }: Required<Pick<PullOptions, 'log'>> & Omit<PullOptions, 'log'>
): Promise<PullResult> {
  const finalPath = path.join(modelsDir, `${layer.hex}.gguf`);
  const part = `${finalPath}.part`;
  const report = createProgress(onProgress, layer.size);

  try {
    const existing = await fs.stat(finalPath);
    if (existing.isFile() && existing.size === layer.size) {
      report(layer.size, true, 'verifying');
      if ((await hashFile(finalPath)).digest('hex') === layer.hex) {
        report(layer.size, true);
        return { path: finalPath, digest: layer.digest, size: layer.size, ref };
      }
    }
    await unlinkQuiet(finalPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw classify(error);
    }
  }

  let partSize = 0;
  try {
    partSize = (await fs.stat(part)).size;
  } catch {
    partSize = 0;
  }
  const stats = await fs.statfs(modelsDir);
  const needed = layer.size - Math.min(partSize, layer.size) + DISK_MARGIN;
  if (Number(stats.bavail) * Number(stats.bsize) < needed) {
    throw new ModelError('disk', `Not enough free disk space: about ${Math.ceil(needed / MiB)} MB needed.`, { retry: false });
  }

  const url = `https://${REGISTRY_HOST}/v2/${encodeURIComponent(parts.namespace)}/${encodeURIComponent(parts.name)}/blobs/${layer.digest}`;
  const hash = await retrying(
    async () => {
      try {
        return await transfer({ url, part, size: layer.size, signal, appVersion, report });
      } catch (error) {
        if (error instanceof ModelError && error.dropPart) {
          await unlinkQuiet(part);
        }
        throw error;
      }
    },
    signal,
    log,
  );

  report(layer.size, true, 'verifying');
  if (hash.digest('hex') !== layer.hex || !(await hasValidHeader(part))) {
    await unlinkQuiet(part);
    throw new ModelError('integrity', 'The downloaded file failed its integrity check.', { retry: false });
  }
  const handle = await fs.open(part, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(part, finalPath);
  log.info('An Ollama registry model was downloaded and verified.');
  return { path: finalPath, digest: layer.digest, size: layer.size, ref };
}

/** True when the file has a structurally valid GGUF header (a read failure is not swallowed). */
async function hasValidHeader(file: string): Promise<boolean> {
  try {
    await validateGgufHeader(file);
    return true;
  } catch (error) {
    if (error instanceof GgufError) {
      return false;
    }
    throw error;
  }
}

/** Runs `task`, retrying transient failures with exponential backoff (the .part makes retries resume). */
async function retrying<T>(task: () => Promise<T>, signal: AbortSignal | undefined, log: ModelLog): Promise<T> {
  let lastError: ModelError | null = null;
  for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
    try {
      return await task();
    } catch (raw: unknown) {
      const error = classify(raw);
      if (signal?.aborted || error.code === 'cancelled') {
        throw cancelled();
      }
      lastError = error;
      log.warn(`Ollama pull attempt ${tries} failed: ${error.code} - ${error.message}`);
      if (!error.retry || tries === ATTEMPTS) {
        break;
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (tries - 1) * (0.8 + Math.random() * 0.4), signal);
    }
  }
  throw lastError;
}
