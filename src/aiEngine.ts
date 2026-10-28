/**
 * Main-side controller of the single AI utility process (aiWorker.ts): lazy start, request/response and
 * streaming protocol with cancellation, crash detection with a respawn budget, idle unload and status events.
 * Prompts are built here with aiPrompts; the worker has no network and nothing is logged except codes.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import * as prompts from './aiPrompts';
import type {
  ChatResultMessage,
  EngineError,
  EngineInfo,
  EngineProgress,
  EngineState,
  RewriteResultMessage,
  SuggestResultMessage,
  SummaryResultMessage,
  WorkerMessage,
  WorkerRequest,
} from './aiProtocol';
import type { ModelLog, ResolvedModel } from './modelDownloader';
import type { ChatOutput, ChatTurn } from './aiPrompts';
import type { ChatLimits } from './chat';
import type { RewriteMode, RewriteStats } from './rewriter';
import type { SummaryStats } from './summarizer';

export type { EngineError, EngineInfo, EngineProgress, EngineState } from './aiProtocol';

/** Request for a ghost-text suggestion (validated by the caller). */
export interface SuggestRequest {
  prefix: string;
  suffixLine: string;
  /** Text after the cursor line, to the end of the enclosing block (not shown to the model). */
  suffix: string;
  /** Import lines or front matter/heading above the prefix window. */
  header: string;
  /** Enclosing declarations above the prefix window. */
  scope: string;
  languageId: string;
  multiline: boolean;
}

/** Result of a suggestion request. */
export interface SuggestOutcome {
  text: string | null;
  cached: boolean;
}

/** A validated summary job from main. */
export interface SummaryJob {
  jobId?: unknown;
  text: string;
  name: string;
  style: string;
  chunkTokens: number;
  modelLabel?: string;
}

/** Handlers of a summary run. */
export interface SummaryHandlers {
  signal?: AbortSignal;
  /** `phase: 'loading'` is reported while the model starts. */
  onProgress?: (progress: EngineProgress) => void;
}

/** Summary body and statistics. */
export interface SummaryOutcome {
  markdown: string;
  stats: SummaryStats;
}

/** A validated grammar/rewrite job from main. */
export interface RewriteJobRequest {
  text: string;
  mode: RewriteMode;
  instruction: string;
  languageId: string;
  /** Chunk size in tokens (200 to 2400). */
  chunkTokens: number;
  /** Largest answer per chunk in tokens (128 to 1024). */
  maxOutputTokens: number;
}

/** New text, warnings and the number of changed lines. */
export interface RewriteOutcome {
  text: string;
  warnings: string[];
  changes: number;
  stats: RewriteStats;
}

/** A validated chat request from main. */
export interface ChatJobRequest {
  instruction: string;
  fileName?: string;
  fileText?: string;
  history: ChatTurn[];
  output: ChatOutput;
  limits: ChatLimits;
}

/** The answer (or the whole new file) and notes for the user. */
export interface ChatOutcome {
  text: string;
  warnings: string[];
}

/** Flat settings object (`'ai.threads'` and so on). */
export type EngineSettings = Record<string, unknown>;

/** Options of {@link createEngine}. */
export interface EngineOptions {
  workerPath: string;
  /** Main's verified model. */
  getModel: () => Promise<ResolvedModel | null>;
  getSettings: () => EngineSettings;
  log?: ModelLog;
}

/** The AI engine controller. */
export interface Engine {
  state(): EngineState;
  onState(callback: (state: EngineState) => void): () => boolean;
  suggest(req: SuggestRequest, signal?: AbortSignal): Promise<SuggestOutcome>;
  summarize(job: SummaryJob, handlers?: SummaryHandlers): Promise<SummaryOutcome>;
  rewrite(job: RewriteJobRequest, handlers?: SummaryHandlers): Promise<RewriteOutcome>;
  chat(job: ChatJobRequest, handlers?: SummaryHandlers): Promise<ChatOutcome>;
  preload(): Promise<void>;
  busy(): { suggest: boolean; summary: boolean };
  unload(): Promise<void>;
  dispose(): Promise<void>;
}

type ResultMessage = SuggestResultMessage | SummaryResultMessage | RewriteResultMessage | ChatResultMessage;

interface PendingEntry {
  resolve: (message: ResultMessage) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: EngineProgress) => void;
  lastPhase?: string | null;
  lastAt?: number;
}

interface SuggestJob {
  id: number;
  cancelled: boolean;
}

const GiB = 1024 * 1024 * 1024;
const MIN_TOTAL_MEMORY = 3 * GiB;
const WARN_FREE_MEMORY = 1 * GiB;
const INIT_TIMEOUT_MS = 2 * 60 * 1000;
const WORKER_LOG_CHARS = 4000;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;
const KILL_AFTER_MS = 3000;
const EXIT_WAIT_MS = 5000;
const PROGRESS_INTERVAL_MS = 250;
const CACHE_ENTRIES = 64;
const CACHE_PREFIX_CHARS = 600;
const CACHE_SUFFIX_CHARS = 200;

/** A raw completion kept for repeated requests, with how the generation ended. */
interface CachedCompletion {
  text: string;
  truncated: boolean;
}
const MAX_THREADS = 8;
const NO_LOG: ModelLog = Object.freeze({ info() {}, warn() {}, error() {} });

function engineError(code: string, message: string): EngineError {
  return Object.assign(new Error(message), { code });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `code` of an engine error, if the value carries one. */
const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

/** True when a message from the worker has the protocol shape (a `type` string). */
const isWorkerMessage = (data: unknown): data is WorkerMessage =>
  typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string';

function defaultThreads(): number {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(cpus / 2)));
}

/**
 * Creates the AI engine controller.
 * @param options `getSettings` returns the flat settings object (`'ai.threads'` and so on); `getModel` is main's
 *   verified model.
 * @returns Engine: state, onState, suggest, summarize, preload, busy, unload, dispose.
 */
export function createEngine({ workerPath, getModel, getSettings, log = NO_LOG }: EngineOptions): Engine {
  const listeners = new Set<(state: EngineState) => void>();
  const pending = new Map<number, PendingEntry>();
  const cache = new Map<string, CachedCompletion>();
  let child: UtilityProcess | null = null;
  let ready: Promise<UtilityProcess> | null = null;
  let phase: EngineState['state'] = 'off';
  let error: string | null = null;
  let info: EngineInfo = { gpu: null, threads: null, modelId: null };
  let failures: number[] = [];
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  let suggestJob: SuggestJob | null = null;
  let summaryRunning = false;
  let lowMemoryWarned = false;
  let lastEmitted = '';
  let disposed = false;

  const snapshot = (): EngineState => ({
    state: phase === 'ready' && summaryRunning ? 'busy' : phase,
    error,
    gpu: info.gpu,
    threads: info.threads,
    modelId: info.modelId,
  });

  function setPhase(next: EngineState['state'], nextError: string | null = null): void {
    phase = next;
    error = nextError;
    if (next === 'off') {
      info = { gpu: null, threads: null, modelId: null };
    }
    publish();
  }

  function publish(): void {
    const current = snapshot();
    const key = JSON.stringify(current);
    if (key !== lastEmitted) {
      lastEmitted = key;
      listeners.forEach((listener) => {
        try {
          listener(current);
        } catch (listenerError) {
          log.warn(`AI state listener failed: ${messageOf(listenerError)}`);
        }
      });
    }
  }

  function failAll(code: string, message: string): void {
    const entries = [...pending.values()];
    pending.clear();
    entries.forEach((entry) => entry.reject(engineError(code, message)));
  }

  function onMessage(data: unknown): void {
    if (!isWorkerMessage(data)) {
      return;
    }
    switch (data.type) {
      case 'suggestResult':
      case 'summaryResult':
      case 'rewriteResult':
      case 'chatResult':
        pending.get(data.id)?.resolve(data);
        pending.delete(data.id);
        break;
      case 'progress': {
        const entry = pending.get(data.id);
        const now = Date.now();
        if (entry?.onProgress && (data.phase !== entry.lastPhase || now - (entry.lastAt ?? 0) >= PROGRESS_INTERVAL_MS)) {
          entry.lastPhase = data.phase;
          entry.lastAt = now;
          entry.onProgress({ phase: data.phase, current: data.current, total: data.total, markdown: data.markdown });
        }
        break;
      }
      case 'error':
        pending.get(data.id)?.reject(engineError(data.code, data.message));
        pending.delete(data.id);
        break;
      default:
        break;
    }
  }

  function recordFailure(): void {
    const now = Date.now();
    failures = failures.filter((at) => now - at < RESPAWN_WINDOW_MS);
    failures.push(now);
  }

  function spawn(): UtilityProcess {
    // The worker gets a minimal environment (no tokens, proxy settings or user paths from main's environment).
    const env: Record<string, string> = { NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true', NODE_LLAMA_CPP_LOG_LEVEL: 'error' };
    ['PATH', 'SystemRoot'].forEach((name) => {
      const value = process.env[name];
      if (value) {
        env[name] = value;
      }
    });
    const proc = utilityProcess.fork(workerPath, [], { serviceName: 'CodePad AI', stdio: 'pipe', env });
    // Worker output is only engine diagnostics (the worker never logs content); keep a bounded amount of it.
    let logged = 0;
    const forward = (stream: NodeJS.ReadableStream | null | undefined): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        if (logged < WORKER_LOG_CHARS) {
          const text = String(chunk).slice(0, WORKER_LOG_CHARS - logged);
          logged += text.length;
          log.warn(`AI engine output: ${text.trim()}`);
        }
      });
    };
    forward(proc.stdout);
    forward(proc.stderr);
    proc.on('exit', (code: number) => {
      if (child !== proc) {
        return;
      }
      child = null;
      ready = null;
      recordFailure();
      log.error(`AI engine exited unexpectedly (code ${code}).`);
      failAll('E_ENGINE_CRASHED', 'The AI engine stopped unexpectedly.');
      setPhase('error', 'The AI engine stopped unexpectedly.');
    });
    return proc;
  }

  async function start(): Promise<UtilityProcess> {
    if (disposed) {
      throw engineError('E_ENGINE', 'The AI engine was shut down.');
    }
    const now = Date.now();
    failures = failures.filter((at) => now - at < RESPAWN_WINDOW_MS);
    if (failures.length >= MAX_RESPAWNS) {
      throw engineError('E_ENGINE', error ?? 'The AI engine is not available on this computer.');
    }
    if (os.totalmem() < MIN_TOTAL_MEMORY) {
      const message = 'Not enough memory for the AI model (needs about 1.5 GB).';
      setPhase('error', message);
      throw engineError('E_ENGINE', message);
    }
    if (os.freemem() < WARN_FREE_MEMORY && !lowMemoryWarned) {
      lowMemoryWarned = true;
      log.warn('Low free memory; the AI model may load slowly.');
    }
    const model = await getModel();
    if (!model) {
      throw engineError('E_NO_MODEL', 'The AI model is not installed.');
    }
    setPhase('loading');
    const startedAt = Date.now();
    const proc = spawn();
    child = proc;
    const threads = Number(getSettings()['ai.threads']) || defaultThreads();
    const id = nextId;
    nextId += 1;
    let lastStep = 'start';
    let timer: NodeJS.Timeout | undefined;
    const loaded = new Promise<EngineInfo>((resolve, reject) => {
      // Only `reject` is ever used for this entry (the ready message is handled by `onInit` below).
      pending.set(id, { resolve: () => {}, reject });
      const finish = (): void => {
        clearTimeout(timer);
        proc.off('message', onInit);
        pending.delete(id);
      };
      // A utilityProcess delivers the posted message itself (unlike the worker's parentPort, which wraps it in `{data}`).
      const onInit = (data: unknown): void => {
        if (!isWorkerMessage(data)) {
          return;
        }
        if (data.type === 'step') {
          lastStep = String(data.label);
          log.info(`AI engine loading: ${lastStep}`);
        } else if (data.type === 'ready') {
          finish();
          resolve(data.info);
        } else if (data.type === 'initError') {
          finish();
          reject(engineError('E_ENGINE', data.message));
        }
      };
      timer = setTimeout(() => {
        finish();
        reject(engineError('E_ENGINE', `loading did not finish within ${INIT_TIMEOUT_MS / 1000} s (stuck at "${lastStep}")`));
      }, INIT_TIMEOUT_MS);
      proc.on('message', onInit);
    });
    proc.postMessage({ type: 'init', modelPath: model.path, modelId: model.id, size: model.size, threads });
    try {
      info = { ...(await loaded) };
    } catch (loadError) {
      if (codeOf(loadError) === 'E_ABORTED') {
        throw loadError;
      }
      if (child === proc) {
        child = null;
        ready = null;
        recordFailure();
        proc.kill();
      }
      const loadCode = codeOf(loadError);
      const message =
        loadCode === 'E_ENGINE_CRASHED'
          ? 'The AI engine stopped unexpectedly.'
          : `The AI engine could not start on this computer: ${messageOf(loadError)}`;
      log.error(`AI engine failed to start: ${loadCode ?? 'error'}`);
      setPhase('error', message);
      throw engineError(loadCode ?? 'E_ENGINE', message);
    }
    proc.on('message', onMessage);
    const steps = Object.entries(info.timings ?? {})
      .map(([label, ms]) => `${label} ${ms}`)
      .join(', ');
    log.info(`AI engine ready in ${Date.now() - startedAt} ms (${steps}; ms per step).`);
    setPhase('ready');
    return proc;
  }

  function ensureWorker(): Promise<UtilityProcess> {
    if (!ready) {
      ready = start().catch((startError: unknown) => {
        ready = null;
        throw startError;
      });
    }
    return ready;
  }

  /**
   * Waits for the engine, but gives up as soon as `signal` aborts. Cancelling during a load abandons that load
   * (the worker is stopped), so Cancel works even when the model is slow or stuck.
   * @param signal Cancels the wait.
   * @returns The ready worker process.
   */
  async function loadOrAbort(signal?: AbortSignal): Promise<UtilityProcess> {
    const cancelled = (): EngineError => engineError('E_ABORTED', 'The summary was cancelled.');
    if (signal?.aborted) {
      throw cancelled();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const handler = (): void => reject(cancelled());
      onAbort = handler;
      signal?.addEventListener('abort', handler, { once: true });
    });
    try {
      return await Promise.race([ensureWorker(), aborted]);
    } catch (loadError) {
      if (codeOf(loadError) === 'E_ABORTED' && signal?.aborted) {
        stopWorker().catch((stopError: unknown) => log.warn(`Could not stop the AI engine: ${messageOf(stopError)}`));
      }
      throw loadError;
    } finally {
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  async function stopWorker(): Promise<void> {
    const proc = child;
    clearTimeout(idleTimer);
    if (!proc) {
      if (phase !== 'off') {
        setPhase('off');
      }
      return;
    }
    child = null;
    ready = null;
    failAll('E_ABORTED', 'The AI engine was unloaded.');
    setPhase('off');
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => proc.kill(), KILL_AFTER_MS);
      const giveUp = setTimeout(() => resolve(), EXIT_WAIT_MS);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        clearTimeout(giveUp);
        resolve();
      });
      try {
        proc.postMessage({ type: 'dispose' });
      } catch {
        proc.kill();
      }
    });
  }

  function scheduleIdleUnload(): void {
    clearTimeout(idleTimer);
    const minutes = Number(getSettings()['ai.unloadAfterMinutes']) || 0;
    if (minutes > 0 && child && !suggestJob && !summaryRunning) {
      idleTimer = setTimeout(() => {
        log.info('Unloading the idle AI engine.');
        stopWorker().catch((stopError: unknown) => log.warn(`Could not unload the AI engine: ${messageOf(stopError)}`));
      }, minutes * 60 * 1000);
      idleTimer.unref();
    }
  }

  function cacheKey({ prefix, header, scope, suffix, languageId, multiline }: SuggestRequest): string {
    return crypto
      .createHash('sha1')
      .update(`${prefix.slice(-CACHE_PREFIX_CHARS)}\0${header}\0${scope}\0${suffix.slice(0, CACHE_SUFFIX_CHARS)}\0${languageId}\0${multiline}`)
      .digest('hex');
  }

  function cacheGet(key: string): CachedCompletion | undefined {
    if (!cache.has(key)) {
      return undefined;
    }
    const value = cache.get(key);
    cache.delete(key);
    if (value !== undefined) {
      cache.set(key, value);
    }
    return value;
  }

  function cacheSet(key: string, value: CachedCompletion): void {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  }

  function cancelRequest(id: number): void {
    if (pending.has(id) && child) {
      child.postMessage({ type: 'cancel', id });
    }
  }

  function supersedeSuggest(): void {
    if (suggestJob) {
      suggestJob.cancelled = true;
      cancelRequest(suggestJob.id);
    }
  }

  /**
   * Requests a completion for the text before the cursor. Resolves `{text: null}` when superseded, cancelled,
   * too long, or while a summary runs; rejects on engine failures.
   * @param req Validated request.
   * @param signal Aborts this request.
   * @returns Cleaned suggestion.
   */
  async function suggest(req: SuggestRequest, signal?: AbortSignal): Promise<SuggestOutcome> {
    if (summaryRunning || disposed) {
      return { text: null, cached: false };
    }
    const context = {
      prefix: req.prefix,
      suffixLine: req.suffixLine,
      suffix: req.suffix,
      header: req.header,
      scope: req.scope,
      languageId: req.languageId,
      multiline: req.multiline,
    };
    const key = cacheKey(req);
    const hit = cacheGet(key);
    if (hit !== undefined) {
      return { text: prompts.cleanSuggestion(hit.text, { ...context, truncated: hit.truncated }), cached: true };
    }
    supersedeSuggest();
    const job: SuggestJob = { id: 0, cancelled: false };
    suggestJob = job;
    try {
      const proc = await ensureWorker();
      if (job.cancelled || signal?.aborted || summaryRunning) {
        return { text: null, cached: false };
      }
      const { spec, gen } = prompts.buildSuggestPrompt({
        prefix: req.prefix,
        header: req.header,
        scope: req.scope,
        suffix: req.suffix,
        languageId: req.languageId,
        multiline: req.multiline,
        maxTokens: Number(getSettings()['ai.maxSuggestionTokens']) || 24,
      });
      job.id = nextId;
      nextId += 1;
      const onAbort = (): void => cancelRequest(job.id);
      signal?.addEventListener('abort', onAbort, { once: true });
      const result = (await new Promise<ResultMessage>((resolve, reject) => {
        pending.set(job.id, { resolve, reject });
        proc.postMessage({ type: 'suggest', id: job.id, prompt: spec, gen });
      }).finally(() => signal?.removeEventListener('abort', onAbort))) as SuggestResultMessage;
      if (job.cancelled || signal?.aborted) {
        return { text: null, cached: false };
      }
      // A token-limit or loop stop means the end of the text is probably cut; the cleaner then keeps only complete units.
      const truncated = result.stopReason === 'maxTokens' || result.stopReason === 'loop';
      cacheSet(key, { text: result.text, truncated });
      return { text: prompts.cleanSuggestion(result.text, { ...context, truncated }), cached: false };
    } catch (suggestError) {
      if (['E_ABORTED', 'E_PROMPT_TOO_LONG', 'E_NO_MODEL'].includes(codeOf(suggestError) ?? '')) {
        return { text: null, cached: false };
      }
      throw suggestError;
    } finally {
      if (suggestJob === job) {
        suggestJob = null;
        scheduleIdleUnload();
      }
    }
  }

  /**
   * Runs one text job (summary or rewrite) inside the worker; only one runs at a time.
   * @param request Builds the worker request for the allocated request id.
   * @param handlers `onProgress({phase, current, total, markdown})`, with `phase: 'loading'` while the model starts.
   * @returns The worker's result message.
   */
  async function runTextJob(request: (id: number) => WorkerRequest, { signal, onProgress }: SummaryHandlers = {}): Promise<ResultMessage> {
    if (summaryRunning) {
      throw engineError('E_BUSY', 'An AI text job is already running.');
    }
    summaryRunning = true;
    clearTimeout(idleTimer);
    supersedeSuggest();
    publish();
    try {
      onProgress?.({ phase: 'loading', current: 0, total: 0, markdown: null });
      const proc = await loadOrAbort(signal);
      publish();
      const id = nextId;
      nextId += 1;
      const onAbort = (): void => cancelRequest(id);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await new Promise<ResultMessage>((resolve, reject) => {
          pending.set(id, { resolve, reject, onProgress, lastPhase: null, lastAt: 0 });
          proc.postMessage(request(id));
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      summaryRunning = false;
      publish();
      if (!getSettings()['ai.enabled']) {
        stopWorker().catch((stopError: unknown) => log.warn(`Could not unload the AI engine: ${messageOf(stopError)}`));
      } else {
        scheduleIdleUnload();
      }
    }
  }

  /**
   * Runs a summary job inside the worker (one at a time).
   * @param job Validated job from main.
   * @param handlers `onProgress({phase, current, total, markdown})`, with `phase: 'loading'` while the model starts.
   * @returns Summary body and statistics.
   */
  async function summarize(job: SummaryJob, handlers: SummaryHandlers = {}): Promise<SummaryOutcome> {
    const result = (await runTextJob(
      (id) => ({
        type: 'summarize',
        id,
        text: job.text,
        name: job.name,
        style: job.style,
        chunkTokens: job.chunkTokens,
        modelLabel: job.modelLabel,
      }),
      handlers
    )) as SummaryResultMessage;
    return { markdown: result.markdown, stats: result.stats };
  }

  /**
   * Runs a grammar check / rewrite job inside the worker (one text job at a time, shared with summaries).
   * @param job Validated job from main.
   * @param handlers `onProgress({phase, current, total})`: `phase: 'loading'` while the model starts, then `'rewrite'` per part.
   * @returns New text, warnings and the number of changed lines.
   */
  async function rewrite(job: RewriteJobRequest, handlers: SummaryHandlers = {}): Promise<RewriteOutcome> {
    const result = (await runTextJob(
      (id) => ({
        type: 'rewrite',
        id,
        text: job.text,
        mode: job.mode,
        instruction: job.instruction,
        languageId: job.languageId,
        chunkTokens: job.chunkTokens,
        maxOutputTokens: job.maxOutputTokens,
      }),
      handlers
    )) as RewriteResultMessage;
    return { text: result.text, warnings: result.warnings, changes: result.changes, stats: result.stats };
  }

  /**
   * Runs one chat request inside the worker (one text job at a time, shared with summaries and rewrites).
   * @param job Validated job from main.
   * @param handlers `onProgress`: `phase: 'loading'` while the model starts, then `'chat'` when generation begins.
   * @returns The cleaned answer and warnings.
   */
  async function chat(job: ChatJobRequest, handlers: SummaryHandlers = {}): Promise<ChatOutcome> {
    const result = (await runTextJob(
      (id) => ({
        type: 'chat',
        id,
        instruction: job.instruction,
        fileName: job.fileName,
        fileText: job.fileText,
        history: job.history,
        output: job.output,
        limits: job.limits,
      }),
      handlers
    )) as ChatResultMessage;
    return { text: result.text, warnings: result.warnings };
  }

  return {
    state: snapshot,
    onState(callback: (state: EngineState) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    suggest,
    summarize,
    rewrite,
    chat,
    /** Loads the model in the background so the first suggestion or summary does not wait for it. */
    async preload(): Promise<void> {
      if (disposed) {
        return;
      }
      try {
        await ensureWorker();
        scheduleIdleUnload();
      } catch {
        // The failure is already in the engine state and the log; callers do not need it.
      }
    },
    busy: (): { suggest: boolean; summary: boolean } => ({ suggest: suggestJob !== null, summary: summaryRunning }),
    /** Stops the worker and frees its memory; also clears the error state and the crash budget. */
    async unload(): Promise<void> {
      failures = [];
      cache.clear();
      await stopWorker();
    },
    /** Stops the worker for good (application quit). */
    async dispose(): Promise<void> {
      disposed = true;
      clearTimeout(idleTimer);
      await stopWorker();
      listeners.clear();
    },
  };
}
