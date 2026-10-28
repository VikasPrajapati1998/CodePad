/**
 * Hardened HTTPS request helper shared by the remote model adapters (main process only).
 * Rules: https only (http only for loopback hosts when `allowLoopbackHttp`), redirects are never followed,
 * a hard timeout, a response size cap, 429/5xx retries with backoff, and errors that carry a stable `code`
 * and never contain the request headers or key, nor the body of an unstructured error response. Non-loopback
 * hosts must not be (or resolve to) private, link-local, CGNAT or metadata addresses. This file and the adapters
 * are the only network code for remote models; nothing here logs.
 */
import * as dns from 'dns/promises';
import * as net from 'net';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1500, 4000];
const MAX_RETRY_AFTER_MS = 20000;
const MAX_DETAIL_CHARS = 200;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata']);

/** Error with a stable machine-readable code (`E_*`) and an optional HTTP status. */
export class ProviderError extends Error {
  code: string;

  status?: number;

  /**
   * @param code Error code.
   * @param message Short human-readable message (no secrets).
   * @param options HTTP status and original error.
   */
  constructor(code: string, message: string, { status, cause }: { status?: number; cause?: unknown } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    if (status) {
      this.status = status;
    }
  }
}

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Expands an IPv6 literal (with an optional dotted IPv4 tail) to its eight 16-bit groups. */
function expandIpv6(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const fill = right === undefined ? [] : new Array<string>(8 - head.length - tail.length).fill('0');
  return [...head, ...fill, ...tail].map((group) => parseInt(group, 16));
}

/**
 * True for an IP literal that is not a public unicast address: unspecified, loopback, private, link-local
 * (including the cloud metadata address), CGNAT, benchmarking, multicast, and IPv6 forms that embed such an
 * IPv4 address (mapped, NAT64, 6to4). Anything that is not an IP literal returns false.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip.split('.').map(Number));
  }
  if (family !== 6) {
    return false;
  }
  const g = expandIpv6(ip);
  const embedded = (hi: number, lo: number): boolean => isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  return (
    g.every((group) => group === 0) ||
    (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) ||
    (g[0] & 0xfe00) === 0xfc00 ||
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xffc0) === 0xfec0 ||
    (g[0] & 0xff00) === 0xff00 ||
    (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff && embedded(g[6], g[7])) ||
    (g[0] === 0x64 && g[1] === 0xff9b && embedded(g[6], g[7])) ||
    (g[0] === 0x2002 && embedded(g[1], g[2]))
  );
}

/**
 * Validates and normalizes a base URL.
 * @param value Candidate URL.
 * @param options Allow `http://` for loopback hosts.
 * @returns Parsed URL without credentials, query or fragment.
 * @throws {ProviderError} `E_BAD_URL`.
 */
export function parseBaseUrl(value: string, { allowLoopbackHttp = false }: { allowLoopbackHttp?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch (error) {
    throw new ProviderError('E_BAD_URL', 'The server address is not a valid URL.', { cause: error });
  }
  const secure = url.protocol === 'https:';
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if ((!secure && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('E_BAD_URL', 'The server address must be an https:// URL (http:// only for this computer).');
  }
  const host = url.hostname.toLowerCase();
  if (!isLoopbackHost(host) && (isPrivateAddress(host) || METADATA_HOSTS.has(host))) {
    throw new ProviderError('E_BAD_URL', 'The server address must be a public internet host, not a private or local network address.');
  }
  return url;
}

/**
 * Rejects a non-loopback host whose DNS answer contains a private or link-local address. This is a pre-flight
 * check only: the request itself (Chromium's net.fetch) resolves the name again, so a DNS-rebinding server could
 * still answer differently the second time; the address cannot be pinned through this fetch API. A lookup that
 * fails is left to the request, which then fails on its own.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(hostname) || net.isIP(host)) {
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return;
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ProviderError('E_BAD_URL', 'The server name points to a private or local network address, which is not allowed.');
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('E_ABORTED', 'The request was cancelled.'));
      },
      { once: true }
    );
  });

function retryDelay(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get('retry-after'));
  const header = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(header, BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]));
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new ProviderError('E_TOO_LARGE', 'The response was larger than allowed.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Picks a short, key-free detail from a structured JSON error body (`error.message`, `error` or `message`).
 * Bodies that are not such JSON are never echoed, so a custom server cannot read data back through error text.
 */
function errorDetail(body: string, secrets: readonly (string | null | undefined)[]): string {
  let detail: unknown = '';
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown } | null;
    const error = parsed && parsed.error;
    const errorMessage = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
    detail = (error && (errorMessage || (typeof error === 'string' ? error : ''))) || (parsed && parsed.message) || '';
  } catch {
    // Not JSON: nothing is echoed.
  }
  if (typeof detail !== 'string') {
    return '';
  }
  let text = detail.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('***');
    }
  }
  return text.slice(0, MAX_DETAIL_CHARS);
}

function statusError(status: number, body: string, secrets: readonly (string | null | undefined)[]): ProviderError {
  const detail = errorDetail(body, secrets);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return new ProviderError('E_AUTH', `The server rejected the API key (HTTP ${status})${suffix}`, { status });
  }
  if (status === 429) {
    return new ProviderError('E_RATE_LIMIT', `The server is rate limiting requests (HTTP 429)${suffix}`, { status });
  }
  if (status >= 500) {
    return new ProviderError('E_SERVER', `The server had an error (HTTP ${status})${suffix}`, { status });
  }
  if (status === 413 || /context|too long|too many tokens|maximum.*tokens|token limit/i.test(detail)) {
    return new ProviderError('E_PROMPT_TOO_LONG', `The text is too long for this model${suffix}`, { status });
  }
  if (status === 404) {
    return new ProviderError('E_NOT_FOUND', `The model or address was not found (HTTP 404)${suffix}`, { status });
  }
  return new ProviderError('E_BAD_REQUEST', `The server refused the request (HTTP ${status})${suffix}`, { status });
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function getFetch(): FetchFn {
  try {
    const { net } = require('electron') as typeof import('electron');
    if (net && typeof net.fetch === 'function') {
      return net.fetch.bind(net);
    }
  } catch {
    // Not running inside Electron (unit tests): use the global fetch.
  }
  return fetch;
}

/** Arguments of an adapter's `complete`. */
export interface ProviderRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

/** Answer of an adapter's `complete`. */
export interface ProviderResult {
  text: string;
  stopReason: string;
}

/** Remote model adapter. */
export interface Provider {
  host: string;
  complete(request: ProviderRequest): Promise<ProviderResult>;
}

/** Options of {@link postJson}. */
export interface PostJsonOptions {
  /** Absolute URL (validated by the caller with parseBaseUrl). */
  url: string;
  /** Request headers (may hold the key; never logged or copied to errors). */
  headers: Record<string, string>;
  /** JSON body. */
  body: object;
  /** Cancels the request. */
  signal?: AbortSignal;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Response size cap. */
  maxBytes?: number;
  /** Strings to scrub from error details. */
  secrets?: readonly (string | null | undefined)[];
}

/**
 * Sends a JSON POST and returns the parsed JSON body (the shape is the provider's; adapters validate it).
 * @param options Request options.
 * @returns Parsed JSON response.
 * @throws {ProviderError} E_AUTH, E_RATE_LIMIT, E_SERVER, E_BAD_REQUEST, E_NOT_FOUND, E_PROMPT_TOO_LONG,
 *   E_TIMEOUT, E_NETWORK, E_REDIRECT, E_TOO_LARGE, E_BAD_RESPONSE, E_ABORTED.
 */
export async function postJson({
  url,
  headers,
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  secrets = [],
}: PostJsonOptions): Promise<unknown> {
  await assertPublicHost(new URL(url).hostname);
  const doFetch = getFetch();
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      throw new ProviderError('E_ABORTED', 'The request was cancelled.');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let retry: number | null = null;
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: payload,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError('E_REDIRECT', 'The server tried to redirect the request, which is not allowed.');
      }
      const text = await readCapped(response, maxBytes);
      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new ProviderError('E_BAD_RESPONSE', 'The server answered with something that is not JSON.', { cause: error });
        }
      }
      const failure = statusError(response.status, text, secrets);
      if ((failure.code === 'E_RATE_LIMIT' || failure.code === 'E_SERVER') && attempt + 1 < MAX_ATTEMPTS) {
        retry = retryDelay(response, attempt);
      } else {
        throw failure;
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (signal?.aborted) {
        throw new ProviderError('E_ABORTED', 'The request was cancelled.', { cause: error });
      }
      if (timedOut) {
        throw new ProviderError('E_TIMEOUT', 'The server did not answer in time.', { cause: error });
      }
      throw new ProviderError('E_NETWORK', 'Could not reach the server. Check the internet connection.', { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    await sleep(retry ?? 0, signal);
  }
}
