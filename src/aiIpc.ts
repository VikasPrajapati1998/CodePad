/*
 * Composition root of the AI on the main side. Creates the model manager, the engine supervisor, the model
 * registry (selectable models, signed models.json) with the secret store, and the summary cache; registers every
 * ai:* IPC handler (validated, main-frame only through the handle() helper of main.ts) and streams
 * model/engine/summary/models/pull events to the renderer on the ai:event channel.
 * Suggestions ALWAYS use the built-in engine. Summaries go to the active model: built-in (as before), a local
 * GGUF model (a second, short-lived engine process used for that job only) or a remote provider (summarizer.ts
 * runs here in main with a provider-backed complete(), after the user's one-time consent per model).
 * If a non-built-in model fails, the job emits phase 'modelFailed' and waits for ai:summarize:retryDefault.
 * Grammar check and rewrite jobs (ai:rewrite:*, rewriter.ts) use the same routing, the same consent and fallback
 * questions and the same busy flag (one text job at a time); their results are never cached.
 * The renderer never names paths, URLs, hosts or keys: main reads those from the registry and secret store; the
 * only path comes from a native file dialog opened here. Trust decisions are main's too: adding or re-pointing a
 * remote model, saving its key, activating it and the consent to send text each need a native confirmation that
 * names the real host, and consent is accepted only while a job is waiting for it. A local model is checked
 * structurally (ggufHeader.ts) and acknowledged once per session before its first load. Document text only passes through memory; nothing about
 * it (and no key) is logged or sent anywhere except to the consented provider.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { BrowserWindow, dialog, safeStorage } from 'electron';
import type { IpcMainInvokeEvent, MessageBoxOptions, OpenDialogOptions, WebContents } from 'electron';
import { createModelManager } from './modelDownloader';
import type { ModelLog, ModelStatus } from './modelDownloader';
import { createEngine } from './aiEngine';
import type { ChatOutcome, Engine, EngineProgress, EngineState, RewriteOutcome, SummaryOutcome } from './aiEngine';
import { createSummaryCache } from './summaryCache';
import type { SummaryCacheStore } from './summaryCache';
import { createModelRegistry } from './modelRegistry';
import type { ModelPatch, ModelSpec, PublicModel, RuntimeModel } from './modelRegistry';
import { createSecretStore } from './secretStore';
import { pullOllamaModel, parseModelRef } from './ollamaPull';
import { validateGgufHeader } from './ggufHeader';
import type { PullProgress } from './ollamaPull';
import * as integrity from './integrity';
import * as summarizer from './summarizer';
import type { SummaryStyle } from './summarizer';
import * as chat from './chat';
import * as rewriter from './rewriter';
import type { RewriteMode } from './rewriter';
import * as prompts from './aiPrompts';
import type { ChatOutput, ChatTurn } from './aiPrompts';
import * as providers from './providers';

/** A renderer-safe `{ok:false}` result of a failed operation (code and short message only). */
export interface AiFailure {
  ok: false;
  code: string;
  message: string;
}

/** Progress of an Ollama pull as sent in `pull` events. */
export interface AiPullProgress {
  state: PullProgress['state'] | 'done' | 'cancelled' | 'error';
  bytes?: number;
  total?: number;
  bytesPerSec?: number;
  etaSec?: number | null;
  /** Set with state 'done'. */
  modelId?: string;
  /** Set with state 'error'. */
  code?: string;
  message?: string;
}

/** `summary` event: progress, the final text and the questions a job asks (`consentRequired`, `modelFailed`). */
export interface AiSummaryEvent {
  type: 'summary';
  jobId: number;
  /** extract | map | reduce | final | verify | loading | done | cancelled | error | consentRequired | modelFailed. */
  phase: string;
  current?: number;
  total?: number;
  markdown?: string;
  cached?: boolean;
  /** consentRequired / modelFailed. */
  modelId?: string | null;
  label?: string;
  code?: string;
  message?: string;
}

/** `rewrite` event: progress, the new text and the questions a job asks (`consentRequired`, `modelFailed`). */
export interface AiRewriteEvent {
  type: 'rewrite';
  jobId: number;
  /** loading | progress | consentRequired | modelFailed | done | error | cancelled. */
  phase: string;
  current?: number;
  total?: number;
  /** Set with phase 'done': the full new text. */
  text?: string;
  warnings?: string[];
  changes?: number;
  /** consentRequired / modelFailed. */
  modelId?: string | null;
  label?: string;
  code?: string;
  message?: string;
}

/** `chat` event: like a rewrite event; phase 'done' carries the whole answer (or the whole new file) in `text`. */
export interface AiChatEvent {
  type: 'chat';
  jobId: number;
  /** loading | progress | consentRequired | modelFailed | done | error | cancelled. */
  phase: string;
  current?: number;
  total?: number;
  /** Set with phase 'done'. */
  text?: string;
  /** Set with phase 'done': notes for the user, for example that only an excerpt of the file was read. */
  warnings?: string[];
  /** consentRequired / modelFailed. */
  modelId?: string | null;
  label?: string;
  code?: string;
  message?: string;
}

/** Fields of a job event (summary, rewrite or chat) without the discriminant and the job id. */
type JobEventFields = Omit<AiSummaryEvent, 'type' | 'jobId'> & Omit<AiRewriteEvent, 'type' | 'jobId'> & Omit<AiChatEvent, 'type' | 'jobId'>;

/** Everything sent to the renderer on the `ai:event` channel. */
export type AiEvent =
  | { type: 'model'; status: ModelStatus }
  | { type: 'engine'; state: EngineState }
  | { type: 'models'; models: PublicModel[] }
  | AiSummaryEvent
  | AiRewriteEvent
  | AiChatEvent
  | { type: 'pull'; id: string; progress: AiPullProgress };

/** Main's `handle(channel, handler)` (main-frame check). */
export type IpcHandle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/** Options of {@link registerAiIpc}. */
export interface AiIpcOptions {
  handle: IpcHandle;
  /** Main's `send(channel, ...args)` to the window. */
  send: (channel: string, ...args: unknown[]) => void;
  /** Returns the validated settings object. */
  getSettings: () => Record<string, unknown>;
  /** Passed by main; not used here. */
  patchSettings?: (patch: Record<string, unknown>) => unknown;
  /** Electron userData directory (the model lives in `<dir>/models`). */
  userDataDir: string;
  /** Application version (download User-Agent). */
  appVersion: string;
  /** The userStore module (summary cache persistence). */
  userStore: SummaryCacheStore & { cleanText(value: unknown, max: number): string };
  /** Logger; never receives document content. */
  log: ModelLog;
}

/** The running AI services as returned to main. */
export interface AiService {
  onSettingsChanged(values?: Record<string, unknown>): void;
  onWindowClosed(): void;
  dispose(): Promise<void>;
}

interface SuggestRequestData {
  reqId: number;
  prefix: string;
  suffixLine: string;
  suffix: string;
  header: string;
  scope: string;
  languageId: string;
  multiline: boolean;
}

interface SummaryRequestData {
  text: string;
  name: string;
  scope: string;
}

interface RewriteRequestData {
  text: string;
  mode: RewriteMode;
  instruction: string;
  languageId: string;
}

interface ChatRequestData {
  instruction: string;
  fileName?: string;
  fileText?: string;
  history: ChatTurn[];
  output: ChatOutput;
}

/** What a summary job runs on: the built-in engine, a local GGUF model or a remote provider. */
type SummaryTarget = { kind: 'builtin'; id: null } | { kind: 'local' | 'remote'; id: string };

interface KeyParts {
  text: string;
  style: SummaryStyle;
  chunkTokens: number;
  scope: string;
}

interface SummaryParams {
  text: string;
  name: string;
  style: SummaryStyle;
  chunkTokens: number;
  key: string;
  keyParts: KeyParts;
  cacheEnabled: boolean;
  target: SummaryTarget;
}

/** A question the running job asked the renderer (consent or fallback choice). */
interface Waiter {
  kind: 'consent' | 'failure';
  id: string | null;
  finish: (value: unknown) => void;
}

interface TextJobState {
  kind: 'summary' | 'rewrite' | 'chat';
  jobId: number;
  controller: AbortController;
  targetId: string | null;
  waiter: Waiter | null;
}

interface ProbeResult {
  online: boolean;
  error?: string;
}

interface RewriteParams extends RewriteRequestData {
  target: SummaryTarget;
}

interface ChatParams extends ChatRequestData {
  target: SummaryTarget;
}

/** How a text job runs on a model: the engine call of a local model and the provider call of a remote one. */
interface TargetRunner<T> {
  /** Runs on an engine (the built-in one, or the second engine of a local model). */
  onEngine: (engine: Engine, label?: string) => Promise<T>;
  /** Runs in main on a remote provider. */
  onProvider: (provider: providers.Provider, runtime: RuntimeModel) => Promise<T>;
}

type ProgressLike = Pick<EngineProgress, 'phase'> & { current?: unknown; total?: unknown; markdown?: unknown };

const EVENT_CHANNEL = 'ai:event';
const MAX_SUGGEST_PREFIX = 8000;
const MAX_SUGGEST_LINE = 400;
const MAX_SUGGEST_SUFFIX = 2000;
const MAX_SUGGEST_CONTEXT = 1000;
const MAX_SUMMARY_CHARS = 2000000;
// Delay before loading an installed model in the background, so the window opens first.
const STARTUP_PRELOAD_MS = 3000;
const MIN_SUMMARY_CHARS = 10000;
const MAX_INSTRUCTION_CHARS = 500;
const REWRITE_MODES = new Set<string>(['grammar', 'restructure']);
// Local models rewrite in the 4096-token worker context; the worker caps one answer at 1024 tokens.
const LOCAL_REWRITE_CHUNK_TOKENS = 600;
const LOCAL_REWRITE_OUTPUT_TOKENS = 1024;
const REMOTE_REWRITE_CHUNK_SHARE = 0.25;
const REMOTE_REWRITE_CHUNK_RANGE = [400, 2400] as const;
const REMOTE_REWRITE_OUTPUT_TOKENS = 4096;
// Chat: the worker context is 4096 tokens, so a local model reads an excerpt of the file and a short history.
const MAX_CHAT_INSTRUCTION_CHARS = 2000;
const MAX_CHAT_FILE_CHARS = 60000;
const MAX_CHAT_HISTORY = 8;
const MAX_CHAT_TURN_CHARS = 4000;
const CHAT_OUTPUTS = new Set<string>(['answer', 'file', 'write']);
const LOCAL_CHAT_LIMITS: chat.ChatLimits = { maxFileChars: 4500, maxHistoryChars: 1200, maxTokens: 1024 };
const REMOTE_CHAT_CHARS_PER_TOKEN = 2;
const REMOTE_CHAT_FILE_RANGE = [4000, MAX_CHAT_FILE_CHARS] as const;
const REMOTE_CHAT_HISTORY_CHARS = 8000;
const REMOTE_CHAT_OUTPUT_TOKENS = 4096;
const MAX_NAME_CHARS = 120;
const MAX_NAME_INPUT = 1000;
const MAX_MESSAGE_CHARS = 300;
const DEFAULT_CHUNK_TOKENS = 1500;
const CHUNK_TOKENS_RANGE = [600, 2400] as const;
const LANGUAGE_ID = /^[A-Za-z0-9_.+-]{1,40}$/;
const SUMMARY_STYLES = new Set<string>(['both', 'paragraph', 'bullets']);
const SUMMARY_SCOPES = new Set<string>(['file', 'selection']);
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_KEY_CHARS = 600;
const LOCAL_KINDS = new Set<string>(['gguf-file', 'ollama-registry']);
const ADDABLE_KINDS = new Set<string>(['gguf-file', 'huggingface', 'anthropic', 'openai-compatible']);
const SPEC_STRINGS = ['label', 'modelName', 'baseUrl'] as const;
const PATCH_FIELDS = ['label', 'modelName', 'baseUrl', 'contextTokens'] as const;
// Share of the model context a single-pass summary may use (the rest is prompt, output and estimate error).
const CONTEXT_USE = 0.7;
const TEST_TIMEOUT_MS = 30000;
// Same limit as the registry's label (modelRegistry.ts), checked before a pull so a bad label cannot waste a download.
const MAX_MODEL_LABEL = 60;
const CONTROL_CHARS = /\p{C}/u;
const HOST_UNSAFE = /[^A-Za-z0-9.:[\]-]/g;
const MAX_HOST_CHARS = 100;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isShortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
const isSummaryStyle = (value: unknown): value is SummaryStyle => typeof value === 'string' && SUMMARY_STYLES.has(value);

/** `code` and `message` of a thrown value when they are strings. */
function errorFields(error: unknown): { code?: string; message?: string } {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === 'string' ? code : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}

const messageOf = (error: unknown): string => errorFields(error).message ?? String(error);

function validateSuggestRequest(raw: unknown): SuggestRequestData {
  if (
    !(
      isPlainObject(raw) &&
      typeof raw.reqId === 'number' &&
      Number.isSafeInteger(raw.reqId) &&
      isShortText(raw.prefix, MAX_SUGGEST_PREFIX) &&
      isShortText(raw.suffixLine, MAX_SUGGEST_LINE) &&
      isShortText(raw.suffix, MAX_SUGGEST_SUFFIX) &&
      isShortText(raw.header, MAX_SUGGEST_CONTEXT) &&
      isShortText(raw.scope, MAX_SUGGEST_CONTEXT) &&
      typeof raw.languageId === 'string' &&
      LANGUAGE_ID.test(raw.languageId) &&
      typeof raw.multiline === 'boolean'
    )
  ) {
    throw new Error('Invalid AI suggestion request.');
  }
  return {
    reqId: raw.reqId,
    prefix: raw.prefix,
    suffixLine: raw.suffixLine,
    suffix: raw.suffix,
    header: raw.header,
    scope: raw.scope,
    languageId: raw.languageId,
    multiline: raw.multiline,
  };
}

function validateSummaryRequest(raw: unknown, userStore: AiIpcOptions['userStore']): SummaryRequestData {
  if (
    !isPlainObject(raw) ||
    typeof raw.text !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.scope !== 'string' ||
    !SUMMARY_SCOPES.has(raw.scope)
  ) {
    throw new Error('Invalid summary request.');
  }
  const name = userStore.cleanText(raw.name.slice(0, MAX_NAME_INPUT), MAX_NAME_CHARS);
  return { text: raw.text, name: name || 'Untitled', scope: raw.scope };
}

function validateRewriteRequest(raw: unknown, userStore: AiIpcOptions['userStore']): RewriteRequestData {
  if (
    !isPlainObject(raw) ||
    typeof raw.text !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.mode !== 'string' ||
    !REWRITE_MODES.has(raw.mode) ||
    typeof raw.languageId !== 'string' ||
    !LANGUAGE_ID.test(raw.languageId) ||
    (raw.instruction !== undefined && !isShortText(raw.instruction, MAX_INSTRUCTION_CHARS))
  ) {
    throw invalidArgument('Invalid rewrite request.');
  }
  const mode = raw.mode as RewriteMode;
  // Control characters and line breaks are removed; the instruction only applies to the restructure mode.
  const instruction =
    mode === 'restructure' && typeof raw.instruction === 'string'
      ? userStore.cleanText(raw.instruction.replace(/\s+/g, ' '), MAX_INSTRUCTION_CHARS)
      : '';
  return { text: raw.text, mode, instruction, languageId: raw.languageId };
}

/** Validates an `ai:chat:start` request; the failure carries the code the renderer shows (`invalid`, `empty`, `tooLarge`). */
function validateChatRequest(raw: unknown, userStore: AiIpcOptions['userStore']): ChatRequestData | AiFailure {
  const invalid: AiFailure = { ok: false, code: 'invalid', message: 'Invalid chat request.' };
  if (
    !isPlainObject(raw) ||
    typeof raw.instruction !== 'string' ||
    typeof raw.output !== 'string' ||
    !CHAT_OUTPUTS.has(raw.output) ||
    (raw.fileName !== undefined && !isShortText(raw.fileName, MAX_NAME_CHARS)) ||
    (raw.fileText !== undefined && typeof raw.fileText !== 'string') ||
    (raw.history !== undefined && !Array.isArray(raw.history))
  ) {
    return invalid;
  }
  const instruction = raw.instruction.trim();
  if (instruction === '') {
    return { ok: false, code: 'empty', message: 'Type what you want the assistant to do.' };
  }
  const rawHistory: unknown[] = Array.isArray(raw.history) ? raw.history : [];
  if (instruction.length > MAX_CHAT_INSTRUCTION_CHARS || rawHistory.length > MAX_CHAT_HISTORY) {
    return { ok: false, code: 'tooLarge', message: 'The request is too long.' };
  }
  const history: ChatTurn[] = [];
  for (const turn of rawHistory) {
    if (!isPlainObject(turn) || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') {
      return invalid;
    }
    if (turn.content.length > MAX_CHAT_TURN_CHARS) {
      return { ok: false, code: 'tooLarge', message: 'An earlier message is too long.' };
    }
    history.push({ role: turn.role, content: turn.content });
  }
  if (typeof raw.fileText === 'string' && raw.fileText.length > MAX_CHAT_FILE_CHARS) {
    return { ok: false, code: 'tooLarge', message: `The file is too large for the assistant (limit ${MAX_CHAT_FILE_CHARS} characters).` };
  }
  const data: ChatRequestData = { instruction, history, output: raw.output === 'file' || raw.output === 'write' ? raw.output : 'answer' };
  if (typeof raw.fileName === 'string') {
    const name = userStore.cleanText(raw.fileName, MAX_NAME_CHARS);
    if (name) {
      data.fileName = name;
    }
  }
  if (typeof raw.fileText === 'string' && raw.fileText !== '') {
    data.fileText = raw.fileText;
  }
  return data;
}

/** A renderer-safe `{ok:false}` result for a failed model operation (code and short message only). */
function failure(error: unknown): AiFailure {
  const fields = errorFields(error);
  const code = fields.code ?? 'io';
  const message = fields.message ?? 'The operation failed.';
  return { ok: false, code, message: message.slice(0, MAX_MESSAGE_CHARS) };
}

const isModelId = (value: unknown): value is string => typeof value === 'string' && MODEL_ID.test(value);

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: 'E_INVALID' });
}

/** Keeps only the known fields of a renderer-supplied model spec; the registry validates the values. */
function cleanSpec(raw: unknown): ModelSpec {
  if (!isPlainObject(raw) || typeof raw.kind !== 'string' || !ADDABLE_KINDS.has(raw.kind)) {
    throw invalidArgument('Unknown model type.');
  }
  const spec: ModelSpec = { kind: raw.kind };
  SPEC_STRINGS.forEach((field) => {
    const value = raw[field];
    if (typeof value === 'string') {
      spec[field] = value;
    }
  });
  if (typeof raw.contextTokens === 'number' && Number.isSafeInteger(raw.contextTokens)) {
    spec.contextTokens = raw.contextTokens;
  }
  if (typeof raw.enabled === 'boolean') {
    spec.enabled = raw.enabled;
  }
  return spec;
}

function cleanPatch(raw: unknown): ModelPatch {
  if (!isPlainObject(raw)) {
    throw invalidArgument('Invalid changes.');
  }
  const patch: ModelPatch = {};
  PATCH_FIELDS.forEach((field) => {
    if (raw[field] !== undefined) {
      patch[field] = raw[field];
    }
  });
  return patch;
}

/** Resolves the size of a local model file, or throws E_NO_MODEL when it is missing or its GGUF header is invalid. */
async function checkModelFile(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) {
      await validateGgufHeader(file);
      return stat.size;
    }
  } catch {
    // Reported below with one message.
  }
  throw Object.assign(new Error('The model file is missing or is not a valid GGUF file.'), { code: 'E_NO_MODEL' });
}

/**
 * Registers the ai:* IPC handlers and starts the AI services (nothing is loaded until it is used).
 * @param options See {@link AiIpcOptions}.
 * @returns Hooks main calls on settings changes, window close and quit.
 */
export function registerAiIpc({ handle, send, getSettings, userDataDir, appVersion, userStore, log }: AiIpcOptions): AiService {
  const manager = createModelManager({ modelsDir: path.join(userDataDir, 'models'), appVersion, log });
  const engine = createEngine({
    workerPath: path.join(__dirname, 'aiWorker.js'),
    getModel: () => manager.resolve(),
    getSettings,
    log,
  });
  const cache = createSummaryCache({ userStore });
  const modelsDir = path.join(userDataDir, 'models');
  const secrets = createSecretStore({ userDataDir, safeStorage, log });
  const registry = createModelRegistry({ userDataDir, secretStore: secrets, integrity, log });

  let suggestion: { reqId: number; controller: AbortController } | null = null;
  let textJob: TextJobState | null = null;
  /** Second engine process of the running local-model summary (null otherwise). */
  let localEngine: Engine | null = null;
  /** Running Ollama pulls by `name:tag`. */
  const pulls = new Map<string, AbortController>();
  /** Model id -> remote host the user confirmed in a native dialog this session (add, key, activate). */
  const approvedHosts = new Map<string, string>();
  /** Local models the user has been warned about this session. */
  const acknowledgedLocal = new Set<string>();
  let trustDialogOpen = false;
  let lastJobId = 0;
  let probe: Promise<ProbeResult> | null = null;
  let previous = getSettings();
  let modelState: ModelStatus['state'] | null = null;

  const emit = (event: AiEvent): void => send(EVENT_CHANNEL, event);
  const stopListening = [
    manager.onStatus((status) => {
      emit({ type: 'model', status });
      // Only the change into 'ready' counts: resolve() re-reports 'ready' every time it runs.
      if (status.state === 'ready' && modelState !== 'ready') {
        setTimeout(preloadEngine, STARTUP_PRELOAD_MS).unref();
      }
      modelState = status.state;
    }),
    engine.onState((state) => emit({ type: 'engine', state })),
    registry.onChange((models) => emit({ type: 'models', models })),
  ];

  function emitProgress(jobId: number, progress: ProgressLike): void {
    const event: AiSummaryEvent = { type: 'summary', jobId, phase: String(progress.phase) };
    if (typeof progress.current === 'number' && Number.isFinite(progress.current)) {
      event.current = progress.current;
    }
    if (typeof progress.total === 'number' && Number.isFinite(progress.total)) {
      event.total = progress.total;
    }
    if (typeof progress.markdown === 'string') {
      event.markdown = progress.markdown;
    }
    emit(event);
  }

  /** Sends an event of a text job: a `summary`, `rewrite` or `chat` event, depending on the job. */
  function emitJob(job: TextJobState, fields: Partial<JobEventFields> & { phase: string }): void {
    if (job.kind === 'summary') {
      emit({ type: 'summary', jobId: job.jobId, ...fields });
    } else if (job.kind === 'rewrite') {
      emit({ type: 'rewrite', jobId: job.jobId, ...fields });
    } else {
      emit({ type: 'chat', jobId: job.jobId, ...fields });
    }
  }

  function cancelWork(): void {
    if (suggestion) {
      suggestion.controller.abort();
    }
    if (textJob) {
      textJob.controller.abort();
    }
  }

  /** Starts the download unless a verified model is already installed. */
  function downloadIfMissing(): void {
    manager
      .resolve()
      .then((model) => (model ? undefined : manager.start()))
      .catch(() => {
        // The model manager already logged the failure and publishes it as a status event.
      });
  }

  /** Loads the model in the background when it is installed and AI is on. */
  function preloadEngine(): void {
    if (getSettings()['ai.enabled'] === false) {
      return;
    }
    manager
      .resolve()
      .then((model) => (model ? engine.preload() : undefined))
      .catch(() => {
        // No usable model yet: the engine loads on first use instead.
      });
  }

  const wantsAutoDownload = (values: Record<string, unknown>): boolean =>
    values['ai.autoDownload'] === true && values['ai.setupPrompted'] === true;

  /** The summary target for a new job: the active model if it is enabled, else the built-in model. */
  function pickTarget(): SummaryTarget {
    try {
      const active = registry.getActive();
      if (active && active.kind !== 'builtin' && active.enabled) {
        return { kind: LOCAL_KINDS.has(active.kind) ? 'local' : 'remote', id: active.id };
      }
    } catch (error) {
      log.warn(`Could not read the active model: ${errorFields(error).code || 'error'}`);
    }
    return { kind: 'builtin', id: null };
  }

  /** Model id used in the summary cache key (a changed model name or address never reuses old summaries). */
  async function cacheModelId(target: SummaryTarget): Promise<string> {
    if (target.kind === 'builtin') {
      const model = await manager.resolve();
      if (!model) {
        throw new Error('The AI model is not installed yet.');
      }
      return model.id;
    }
    const runtime = registry.runtime(target.id);
    return `${runtime.id}:${runtime.modelName}:${runtime.baseUrl}`;
  }

  /**
   * Waits for the renderer's answer to a question the job asked (consent or fallback choice). Resolves with
   * the value given to `finish`, or null when the job is cancelled meanwhile.
   */
  function waitForAnswer(job: TextJobState, kind: Waiter['kind'], id: string | null): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const finish = (value: unknown): void => {
        job.controller.signal.removeEventListener('abort', onAbort);
        job.waiter = null;
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      job.waiter = { kind, id, finish };
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Shows a native Cancel/confirm box (default button: Cancel) and returns true only for the confirm button.
   * One box at a time; a second request while one is open is refused so the renderer cannot stack prompts.
   */
  async function confirmNative(sender: WebContents | null, text: { title: string; message: string; detail: string; confirm: string }): Promise<boolean> {
    if (trustDialogOpen) {
      throw Object.assign(new Error('Another confirmation is already open.'), { code: 'busy' });
    }
    trustDialogOpen = true;
    try {
      const window = (sender ? BrowserWindow.fromWebContents(sender) : null) ?? BrowserWindow.getAllWindows()[0] ?? null;
      const options: MessageBoxOptions = {
        type: 'warning',
        title: text.title,
        message: text.message,
        detail: text.detail,
        buttons: ['Cancel', text.confirm],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
      return result.response === 1;
    } finally {
      trustDialogOpen = false;
    }
  }

  const cancelledByUser = (): Error => Object.assign(new Error('Cancelled.'), { code: 'cancelled' });
  const displayHost = (host: string): string => host.replace(HOST_UNSAFE, '?').slice(0, MAX_HOST_CHARS);
  const displayLabel = (label: string): string => label.replace(/[^\P{C}]/gu, '?').slice(0, MAX_MODEL_LABEL);

  /** Confirms with the user, in a native box, that text and key may go to `host`; remembers the answer for the session. */
  async function approveHost(sender: WebContents, id: string | null, kind: string, baseUrl: string, label: string, why: string): Promise<void> {
    const host = providers.remoteHost({ kind, modelName: '', baseUrl });
    if (id !== null && approvedHosts.get(id) === host) {
      return;
    }
    const ok = await confirmNative(sender, {
      title: 'Remote AI model',
      message: `${why} ${displayHost(host)}?`,
      detail:
        `The model "${displayLabel(label)}" talks to the server ${displayHost(host)}. Anything sent to it (your document text and the API key) ` +
        'leaves this computer and is handled by that server. Only continue if you trust that address.',
      confirm: 'Continue',
    });
    if (!ok) {
      throw cancelledByUser();
    }
    if (id !== null) {
      approvedHosts.set(id, host);
    }
  }

  /** Runs `runner` on a local GGUF model in a second engine process that exists only for this job. */
  async function runOnLocal<T>(runtime: RuntimeModel, runner: TargetRunner<T>): Promise<T> {
    const size = await checkModelFile(runtime.path);
    if (!acknowledgedLocal.has(runtime.id)) {
      const ok = await confirmNative(null, {
        title: 'Third-party model',
        message: `Load the model "${displayLabel(runtime.label)}"?`,
        detail:
          'This file was not made or checked by CodePad. It is third-party data that is parsed by native code (llama.cpp) ' +
          'in a helper process on this computer. Only continue if you trust where it came from.',
        confirm: 'Load model',
      });
      if (!ok) {
        throw Object.assign(new Error('Loading this model was declined.'), { code: 'E_DECLINED' });
      }
      acknowledgedLocal.add(runtime.id);
    }
    const model = { id: runtime.id, path: runtime.path, size };
    // Free the memory of the built-in model first; it reloads on its next use.
    await engine.unload().catch((error: unknown) => log.warn(`Could not unload the AI engine: ${messageOf(error)}`));
    const second = createEngine({
      workerPath: path.join(__dirname, 'aiWorker.js'),
      getModel: async () => model,
      getSettings,
      log,
    });
    localEngine = second;
    try {
      return await runner.onEngine(second, runtime.label);
    } finally {
      localEngine = null;
      await second.dispose().catch((error: unknown) => log.warn(`Could not stop the model process: ${messageOf(error)}`));
    }
  }

  /** Remote models: asks for the one-time consent first (the job waits for ai:models:consent). */
  async function ensureConsent(job: TextJobState, runtime: RuntimeModel): Promise<void> {
    if (runtime.consent) {
      return;
    }
    emitJob(job, { phase: 'consentRequired', modelId: runtime.id, label: runtime.label });
    const granted = await waitForAnswer(job, 'consent', runtime.id);
    if (granted !== true) {
      throw Object.assign(new Error('Sending the text to this model was declined.'), { code: 'E_DECLINED' });
    }
  }

  /**
   * Runs a text job on its target: the built-in engine, a local GGUF model (second engine) or a remote provider
   * (consent first, then the job code in main with the provider as complete()).
   */
  async function runOnTarget<T>(job: TextJobState, target: SummaryTarget, runner: TargetRunner<T>): Promise<T> {
    if (target.kind === 'builtin') {
      return runner.onEngine(engine);
    }
    const runtime = registry.runtime(target.id);
    if (target.kind === 'local') {
      return runOnLocal(runtime, runner);
    }
    await ensureConsent(job, runtime);
    return runner.onProvider(providers.createProvider({ entry: runtime, key: runtime.apiKey }), runtime);
  }

  function summaryRunner(job: TextJobState, params: SummaryParams): TargetRunner<SummaryOutcome> {
    const { signal } = job.controller;
    const onProgress = (progress: ProgressLike): void => emitProgress(job.jobId, progress);
    return {
      onEngine: (target, modelLabel) =>
        target.summarize(
          { jobId: job.jobId, text: params.text, name: params.name, style: params.style, chunkTokens: params.chunkTokens, modelLabel },
          { signal, onProgress }
        ),
      onProvider: (provider, runtime) =>
        summarizer.summarize({
          text: params.text,
          name: params.name,
          style: params.style,
          chunkTokens: Math.max(600, Math.floor(runtime.contextTokens * CONTEXT_USE)),
          contextTokens: runtime.contextTokens,
          modelLabel: runtime.label,
          remoteHost: provider.host,
          singlePass: true,
          prompts,
          signal,
          complete: providers.createSummaryCompleter(provider, signal),
          onProgress,
        }),
    };
  }

  function rewriteRunner(job: TextJobState, params: RewriteParams): TargetRunner<RewriteOutcome> {
    const { signal } = job.controller;
    const common = { text: params.text, mode: params.mode, instruction: params.instruction, languageId: params.languageId };
    return {
      onEngine: (target) =>
        target.rewrite(
          { ...common, chunkTokens: LOCAL_REWRITE_CHUNK_TOKENS, maxOutputTokens: LOCAL_REWRITE_OUTPUT_TOKENS },
          {
            signal,
            onProgress: (progress) => {
              if (progress.phase === 'loading') {
                emitJob(job, { phase: 'loading' });
              } else {
                emitJob(job, { phase: 'progress', current: progress.current, total: progress.total });
              }
            },
          }
        ),
      onProvider: (provider, runtime) =>
        rewriter.rewrite({
          ...common,
          chunkTokens: clamp(runtime.contextTokens * REMOTE_REWRITE_CHUNK_SHARE, ...REMOTE_REWRITE_CHUNK_RANGE, REMOTE_REWRITE_CHUNK_RANGE[0]),
          maxOutputTokens: REMOTE_REWRITE_OUTPUT_TOKENS,
          signal,
          complete: providers.createSummaryCompleter(provider, signal),
          onProgress: (progress) => emitJob(job, { phase: 'progress', current: progress.current, total: progress.total }),
        }),
    };
  }

  function chatRunner(job: TextJobState, params: ChatParams): TargetRunner<ChatOutcome> {
    const { signal } = job.controller;
    const common = { instruction: params.instruction, fileName: params.fileName, fileText: params.fileText, history: params.history, output: params.output };
    return {
      onEngine: (target) =>
        target.chat(
          { ...common, limits: LOCAL_CHAT_LIMITS },
          {
            signal,
            onProgress: (progress) => {
              if (progress.phase === 'loading') {
                emitJob(job, { phase: 'loading' });
              } else {
                emitJob(job, { phase: 'progress', current: progress.current, total: progress.total });
              }
            },
          }
        ),
      onProvider: (provider, runtime) => {
        emitJob(job, { phase: 'progress', current: 0, total: 1 });
        return chat.runChat({
          ...common,
          limits: {
            maxFileChars: clamp(runtime.contextTokens * REMOTE_CHAT_CHARS_PER_TOKEN, ...REMOTE_CHAT_FILE_RANGE, REMOTE_CHAT_FILE_RANGE[0]),
            maxHistoryChars: REMOTE_CHAT_HISTORY_CHARS,
            maxTokens: REMOTE_CHAT_OUTPUT_TOKENS,
          },
          signal,
          complete: providers.createSummaryCompleter(provider, signal),
        });
      },
    };
  }

  const shortMessage = (error: unknown, fallback: string): string =>
    (errorFields(error).message ?? fallback).slice(0, MAX_MESSAGE_CHARS);

  const JOB_WORDS: Record<TextJobState['kind'], string> = { summary: 'Summary', rewrite: 'Rewrite', chat: 'Chat' };
  const jobWord = (job: TextJobState): string => JOB_WORDS[job.kind];

  /**
   * Runs a job on its target. When a non-built-in model fails, the job asks the renderer (phase 'modelFailed')
   * and, if the answer is "use the default model", runs again on the built-in one after `beforeFallback`.
   */
  async function runWithFallback<T>(
    job: TextJobState,
    initial: SummaryTarget,
    run: (target: SummaryTarget) => Promise<T>,
    beforeFallback?: (target: SummaryTarget) => Promise<void>
  ): Promise<T> {
    try {
      return await run(initial);
    } catch (error) {
      if (job.controller.signal.aborted || initial.kind === 'builtin' || errorFields(error).code === 'E_DECLINED') {
        throw error;
      }
      log.warn(`${jobWord(job)} with the selected model failed: ${errorFields(error).code || 'error'}`);
      let label = '';
      try {
        label = registry.runtime(initial.id).label;
      } catch {
        label = '';
      }
      emitJob(job, {
        phase: 'modelFailed',
        modelId: initial.id,
        label,
        code: errorFields(error).code || 'error',
        message: shortMessage(error, 'The model failed.'),
      });
      if ((await waitForAnswer(job, 'failure', initial.id)) !== 'default') {
        throw error;
      }
      const fallback: SummaryTarget = { kind: 'builtin', id: null };
      await beforeFallback?.(fallback);
      return run(fallback);
    }
  }

  /** Ends a text job: frees the job slot and unloads the built-in engine when AI is switched off. */
  function finishJob(): void {
    textJob = null;
    if (!getSettings()['ai.enabled']) {
      engine.unload().catch((error: unknown) => log.warn(`Could not unload the AI engine: ${messageOf(error)}`));
    }
  }

  /** Emits the terminal event of a job that threw: cancelled (also when the consent was declined) or error. */
  function emitFailure(job: TextJobState, error: unknown): void {
    if (job.controller.signal.aborted || errorFields(error).code === 'E_DECLINED') {
      emitJob(job, { phase: 'cancelled' });
    } else {
      log.warn(`${jobWord(job)} failed: ${errorFields(error).code || 'error'}`);
      emitJob(job, { phase: 'error', message: shortMessage(error, `The ${jobWord(job).toLowerCase()} failed.`) });
    }
  }

  async function runSummary(job: TextJobState, params: SummaryParams): Promise<void> {
    let { key } = params;
    try {
      const result = await runWithFallback(
        job,
        params.target,
        (target) => runOnTarget(job, target, summaryRunner(job, params)),
        async (target) => {
          key = cache.keyFor({ ...params.keyParts, modelId: await cacheModelId(target) });
        }
      );
      if (params.cacheEnabled) {
        await cache.set(key, result.markdown).catch((error: unknown) => log.warn(`Could not cache the summary: ${messageOf(error)}`));
      }
      emitJob(job, { phase: 'done', current: result.stats.chunks, total: result.stats.chunks, markdown: result.markdown, cached: false });
    } catch (error) {
      emitFailure(job, error);
    } finally {
      finishJob();
    }
  }

  /** Grammar check / rewrite: same routing and questions as a summary; the result is never cached or logged. */
  async function runRewrite(job: TextJobState, params: RewriteParams): Promise<void> {
    try {
      const result = await runWithFallback(job, params.target, (target) => runOnTarget(job, target, rewriteRunner(job, params)));
      const { stats } = result;
      log.info(`Rewrite (${params.mode}, ${params.languageId}): ${stats.chunks} parts, ${stats.calls} model calls, ${stats.changedChunks} changed, ${stats.fallbacks} kept after loss, ${stats.failed} failed.`);
      emitJob(job, {
        phase: 'done',
        current: result.stats.chunks,
        total: result.stats.chunks,
        text: result.text,
        warnings: result.warnings,
        changes: result.changes,
      });
    } catch (error) {
      emitFailure(job, error);
    } finally {
      finishJob();
    }
  }

  /** Chat assistant request: same routing and questions as a rewrite; the instruction, file and answer are never logged. */
  async function runChatJob(job: TextJobState, params: ChatParams): Promise<void> {
    try {
      // The chat always uses the summary model: a failure is reported, never answered by switching to the default model.
      const result = await runOnTarget(job, params.target, chatRunner(job, params));
      log.info(`Chat (${params.output}): answered.`);
      emitJob(job, { phase: 'done', current: 1, total: 1, text: result.text, warnings: result.warnings });
    } catch (error) {
      emitFailure(job, error);
    } finally {
      finishJob();
    }
  }

  handle('ai:getStatus', () => ({
    model: manager.status(),
    engine: engine.state(),
    enabled: getSettings()['ai.enabled'] === true,
    summary: { running: textJob !== null, jobId: textJob && textJob.kind === 'summary' ? textJob.jobId : null },
  }));

  handle('ai:model:download', () => {
    manager.start().catch(() => {
      // Reported through the model status events.
    });
    return { ok: true };
  });
  handle('ai:model:pause', () => {
    manager.pause();
    return { ok: true };
  });
  handle('ai:model:resume', () => {
    manager.resume().catch(() => {
      // Reported through the model status events.
    });
    return { ok: true };
  });
  handle('ai:model:cancel', async () => {
    try {
      await manager.cancel();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
  handle('ai:model:delete', async () => {
    if (textJob) {
      return { ok: false, code: 'busy', message: 'Wait for the running summary to finish or cancel it first.' };
    }
    try {
      await engine.unload();
      await manager.remove();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
  handle('ai:model:checkConnection', () => {
    if (!probe) {
      probe = manager
        .checkConnection()
        .then((result): ProbeResult => (result.online ? { online: true } : { online: false, error: result.error }))
        .catch((error: unknown): ProbeResult => ({ online: false, error: failure(error).message }))
        .finally(() => {
          probe = null;
        });
    }
    return probe;
  });

  handle('ai:suggest', async (_event, raw) => {
    const request = validateSuggestRequest(raw);
    const none = { reqId: request.reqId, text: null };
    if (suggestion) {
      suggestion.controller.abort();
      suggestion = null;
    }
    if (getSettings()['ai.enabled'] !== true || textJob || manager.status().state !== 'ready') {
      return none;
    }
    const current = { reqId: request.reqId, controller: new AbortController() };
    suggestion = current;
    try {
      const result = await engine.suggest(request, current.controller.signal);
      return current.controller.signal.aborted ? none : { reqId: request.reqId, text: result.text };
    } catch (error) {
      if (!current.controller.signal.aborted) {
        log.warn(`AI suggestion failed: ${errorFields(error).code || 'error'}`);
      }
      return none;
    } finally {
      if (suggestion === current) {
        suggestion = null;
      }
    }
  });
  handle('ai:suggest:cancel', (_event, reqId) => {
    if (suggestion && typeof reqId === 'number' && Number.isSafeInteger(reqId) && suggestion.reqId === reqId) {
      suggestion.controller.abort();
    }
    return true;
  });

  handle('ai:summarize', async (_event, raw) => {
    const { text, name, scope } = validateSummaryRequest(raw, userStore);
    const settings = getSettings();
    const max = clamp(settings['ai.summaryMaxChars'], MIN_SUMMARY_CHARS, MAX_SUMMARY_CHARS, MAX_SUMMARY_CHARS);
    if (text.length > max) {
      return { tooLarge: true, max };
    }
    if (!text.trim()) {
      return { empty: true };
    }
    if (textJob) {
      return { busy: true };
    }
    const configuredStyle = settings['ai.summaryStyle'];
    const style: SummaryStyle = isSummaryStyle(configuredStyle) ? configuredStyle : 'both';
    const chunkTokens = clamp(settings['ai.chunkTokens'], ...CHUNK_TOKENS_RANGE, DEFAULT_CHUNK_TOKENS);
    const cacheEnabled = settings['ai.summaryCache'] !== false;

    const target = pickTarget();
    lastJobId += 1;
    const job: TextJobState = { kind: 'summary', jobId: lastJobId, controller: new AbortController(), targetId: target.id, waiter: null };
    textJob = job;
    const keyParts: KeyParts = { text, style, chunkTokens, scope };
    let key = '';
    try {
      key = cache.keyFor({ ...keyParts, modelId: await cacheModelId(target) });
      const cached = cacheEnabled ? await cache.get(key) : null;
      if (cached !== null) {
        textJob = null;
        setImmediate(() =>
          emit({ type: 'summary', jobId: job.jobId, phase: 'done', current: 1, total: 1, markdown: cached, cached: true })
        );
        return { jobId: job.jobId, cached: true };
      }
    } catch (error) {
      textJob = null;
      throw error;
    }
    if (suggestion) {
      suggestion.controller.abort();
    }
    runSummary(job, { text, name, style, chunkTokens, key, keyParts, cacheEnabled, target });
    return { jobId: job.jobId, cached: false };
  });
  handle('ai:summarize:cancel', (_event, jobId) => {
    if (textJob && typeof jobId === 'number' && Number.isSafeInteger(jobId) && textJob.jobId === jobId) {
      textJob.controller.abort();
    }
    return true;
  });
  handle('ai:rewrite:start', (_event, raw) => {
    let request: RewriteRequestData;
    try {
      request = validateRewriteRequest(raw, userStore);
    } catch (error) {
      return failure(error);
    }
    const settings = getSettings();
    const max = clamp(settings['ai.summaryMaxChars'], MIN_SUMMARY_CHARS, MAX_SUMMARY_CHARS, MAX_SUMMARY_CHARS);
    if (request.text.length > max) {
      return { ok: false, code: 'tooLarge', message: `The text is too large for the AI (limit ${max} characters). Select a smaller part.` };
    }
    if (!request.text.trim()) {
      return { ok: false, code: 'empty', message: 'There is no text to work on.' };
    }
    if (textJob) {
      return { ok: false, code: 'busy', message: 'Another AI task is running. Wait for it to finish or cancel it first.' };
    }
    const target = pickTarget();
    lastJobId += 1;
    const job: TextJobState = { kind: 'rewrite', jobId: lastJobId, controller: new AbortController(), targetId: target.id, waiter: null };
    textJob = job;
    if (suggestion) {
      suggestion.controller.abort();
    }
    runRewrite(job, { ...request, target });
    return { ok: true, jobId: job.jobId };
  });
  handle('ai:rewrite:cancel', (_event, jobId) => {
    if (textJob && textJob.kind === 'rewrite' && typeof jobId === 'number' && Number.isSafeInteger(jobId) && textJob.jobId === jobId) {
      textJob.controller.abort();
    }
    return true;
  });
  handle('ai:chat:start', (_event, raw) => {
    const request = validateChatRequest(raw, userStore);
    if ('ok' in request) {
      return request;
    }
    if (textJob) {
      return { ok: false, code: 'busy', message: 'Another AI task is running. Wait for it to finish or cancel it first.' };
    }
    const target = pickTarget();
    lastJobId += 1;
    const job: TextJobState = { kind: 'chat', jobId: lastJobId, controller: new AbortController(), targetId: target.id, waiter: null };
    textJob = job;
    if (suggestion) {
      suggestion.controller.abort();
    }
    runChatJob(job, { ...request, target });
    return { ok: true, jobId: job.jobId };
  });
  handle('ai:chat:cancel', (_event, jobId) => {
    if (textJob && textJob.kind === 'chat' && typeof jobId === 'number' && Number.isSafeInteger(jobId) && textJob.jobId === jobId) {
      textJob.controller.abort();
    }
    return true;
  });
  handle('ai:summaryCache:clear', async () => ({ removed: await cache.clear() }));

  handle('ai:summarize:retryDefault', (_event, jobId) => {
    const waiter = textJob && textJob.jobId === jobId ? textJob.waiter : null;
    if (typeof jobId !== 'number' || !Number.isSafeInteger(jobId) || !waiter || waiter.kind !== 'failure') {
      return { ok: false, code: 'E_NO_JOB', message: 'There is no failed AI request to retry.' };
    }
    waiter.finish('default');
    return { ok: true };
  });

  /** Runs a model operation and returns `{ok:true, ...result}` or a renderer-safe failure. */
  const guarded = async <T extends object>(operation: () => Promise<T>): Promise<({ ok: true } & T) | AiFailure> => {
    try {
      return { ok: true, ...(await operation()) };
    } catch (error) {
      return failure(error);
    }
  };
  const requireId = (id: unknown): string => {
    if (!isModelId(id)) {
      throw invalidArgument('Invalid model.');
    }
    return id;
  };
  const requireRemote = (id: unknown): RuntimeModel => {
    const runtime = registry.runtime(requireId(id));
    if (!providers.REMOTE_KINDS.includes(runtime.kind)) {
      throw invalidArgument('This model type does not use an API key.');
    }
    return runtime;
  };

  /** Native dialog for a .gguf file; the chosen path never goes through the renderer. */
  async function chooseGgufFile(sender: WebContents): Promise<string> {
    const window = BrowserWindow.fromWebContents(sender);
    const options: OpenDialogOptions = {
      title: 'Choose a GGUF model file',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
    };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    if (result.canceled || !result.filePaths[0]) {
      throw Object.assign(new Error('No file was chosen.'), { code: 'cancelled' });
    }
    const file = result.filePaths[0];
    if (path.extname(file).toLowerCase() !== '.gguf') {
      throw invalidArgument('Choose a file with the .gguf extension.');
    }
    await checkModelFile(file);
    return file;
  }

  /** Deletes a pulled Ollama file in the models folder unless another entry uses it; a user's own .gguf never is. */
  async function deleteUnsharedBlob(file: string): Promise<void> {
    if (path.dirname(file) !== modelsDir) {
      return;
    }
    const shared = registry.list().some((model) => model.kind === 'ollama-registry' && registry.runtime(model.id).path === file);
    if (!shared) {
      await fs.rm(file, { force: true }).catch((error: unknown) => log.warn(`Could not delete a model file: ${errorFields(error).code}`));
    }
  }

  handle('ai:models:list', () => ({ ok: true, models: registry.list() }));

  handle('ai:models:add', (event, raw) =>
    guarded(async () => {
      const spec = cleanSpec(raw);
      let trusted: { path?: string } = {};
      const remote = providers.REMOTE_KINDS.includes(spec.kind);
      if (remote) {
        // Main owns the trust decision: nothing is stored before the user confirmed the real host.
        await approveHost(event.sender, null, spec.kind, spec.baseUrl ?? '', spec.label ?? '', 'Add a model that sends your text to');
      }
      if (spec.kind === 'gguf-file') {
        const file = await chooseGgufFile(event.sender);
        const base = path.basename(file);
        trusted = { path: file };
        spec.modelName = base;
        spec.label = typeof spec.label === 'string' && spec.label.trim() ? spec.label : base.replace(/\.gguf$/i, '');
      }
      const model = registry.add(spec, trusted);
      if (remote) {
        approvedHosts.set(model.id, providers.remoteHost({ kind: spec.kind, modelName: '', baseUrl: spec.baseUrl }));
      }
      return { model };
    })
  );

  handle('ai:models:update', (event, id, raw) =>
    guarded(async () => {
      const modelId = requireId(id);
      const patch = cleanPatch(raw);
      const current = registry.runtime(modelId);
      if (providers.REMOTE_KINDS.includes(current.kind) && typeof patch.baseUrl === 'string') {
        // A different server needs a fresh confirmation (the registry also drops its key and consent).
        const next = providers.remoteHost({ kind: current.kind, modelName: '', baseUrl: patch.baseUrl });
        if (next !== providers.remoteHost(current)) {
          approvedHosts.delete(modelId);
          await approveHost(event.sender, modelId, current.kind, patch.baseUrl, current.label, 'Send your text to');
        }
      }
      return { model: registry.update(modelId, patch) };
    })
  );

  handle('ai:models:remove', (_event, id) =>
    guarded(async () => {
      const modelId = requireId(id);
      if (textJob && textJob.targetId === modelId) {
        throw Object.assign(new Error('Wait for the running summary to finish or cancel it first.'), { code: 'busy' });
      }
      const removed = registry.remove(modelId);
      approvedHosts.delete(modelId);
      acknowledgedLocal.delete(modelId);
      if (removed.kind === 'ollama-registry') {
        await deleteUnsharedBlob(removed.path);
      }
      return {};
    })
  );

  handle('ai:models:setEnabled', (_event, id, enabled) =>
    guarded(async () => {
      if (typeof enabled !== 'boolean') {
        throw invalidArgument('Invalid value.');
      }
      registry.setEnabled(requireId(id), enabled);
      return {};
    })
  );

  handle('ai:models:setActive', (event, id) =>
    guarded(async () => {
      if (id !== null) {
        const runtime = registry.runtime(requireId(id));
        if (providers.REMOTE_KINDS.includes(runtime.kind)) {
          await approveHost(event.sender, runtime.id, runtime.kind, runtime.baseUrl, runtime.label, 'Use this model, which sends your text to');
        }
      }
      registry.setActive(id === null ? null : requireId(id));
      return {};
    })
  );

  // The key is write-only: it goes straight into the secret store and is never echoed or logged.
  handle('ai:models:setKey', (event, id, key) =>
    guarded(async () => {
      if (typeof key !== 'string' || key.length > MAX_KEY_CHARS) {
        throw invalidArgument('Invalid key.');
      }
      const runtime = requireRemote(id);
      if (key.trim() === '') {
        secrets.remove(runtime.id);
      } else {
        await approveHost(event.sender, runtime.id, runtime.kind, runtime.baseUrl, runtime.label, 'Save this API key for');
        secrets.set(runtime.id, key);
      }
      emit({ type: 'models', models: registry.list() });
      return {};
    })
  );

  handle('ai:models:test', (_event, id) =>
    guarded(async () => {
      const runtime = registry.runtime(requireId(id));
      if (LOCAL_KINDS.has(runtime.kind)) {
        await checkModelFile(runtime.path);
      } else if (runtime.kind !== 'builtin') {
        await providers.testProvider({ entry: runtime, key: runtime.apiKey }, AbortSignal.timeout(TEST_TIMEOUT_MS));
      } else if (!(await manager.resolve())) {
        throw Object.assign(new Error('The built-in model is not installed yet.'), { code: 'E_NO_MODEL' });
      }
      return {};
    })
  );

  // Consent is accepted only while a job is waiting for it, and only after main's own native confirmation.
  handle('ai:models:consent', (event, id, granted = true) =>
    guarded(async () => {
      const modelId = requireId(id);
      if (typeof granted !== 'boolean') {
        throw invalidArgument('Invalid value.');
      }
      const job = textJob;
      const waiter = job && job.waiter;
      if (!job || !waiter || waiter.kind !== 'consent' || waiter.id !== modelId) {
        if (granted) {
          throw Object.assign(new Error('No request is waiting for this model.'), { code: 'E_NO_JOB' });
        }
        return {};
      }
      let allowed = false;
      if (granted) {
        try {
          const runtime = registry.runtime(modelId);
          const host = displayHost(providers.remoteHost(runtime));
          allowed = await confirmNative(event.sender, {
            title: 'Send text to a remote model',
            message: `Send your text to ${host}?`,
            detail:
              `The model "${displayLabel(runtime.label)}" is hosted at ${host}. ` +
              'The text of your request leaves this computer and is handled by that server. You are asked once per model.',
            confirm: 'Send',
          });
        } catch (error) {
          log.warn(`Consent could not be requested: ${errorFields(error).code || 'error'}`);
        }
      }
      // The job may have been cancelled, or answered otherwise, while the box was open.
      if (job.waiter === waiter) {
        if (allowed) {
          registry.giveConsent(modelId);
        }
        waiter.finish(allowed);
      }
      return {};
    })
  );

  // Downloads an Ollama-registry model (main picks the URL and folder); the entry is added when the file is verified.
  handle('ai:models:pull', (_event, raw) =>
    guarded(async () => {
      if (!isPlainObject(raw) || !parseModelRef(raw.modelName)) {
        throw invalidArgument('Enter an Ollama model as name:tag, for example llama3.1:8b.');
      }
      // parseModelRef only accepts strings.
      const ref = raw.modelName as string;
      // One download at a time; the label and the room are checked first so a bad request never downloads anything.
      if (pulls.size > 0) {
        throw Object.assign(new Error('Another model is already downloading. Wait for it to finish or cancel it.'), { code: 'busy' });
      }
      registry.ensureRoom();
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : ref;
      if (label.length > MAX_MODEL_LABEL || CONTROL_CHARS.test(label)) {
        throw invalidArgument(`The name must be at most ${MAX_MODEL_LABEL} characters and contain no control characters.`);
      }
      const spec: ModelSpec = { kind: 'ollama-registry', modelName: ref, label };
      if (typeof raw.contextTokens === 'number' && Number.isSafeInteger(raw.contextTokens)) {
        spec.contextTokens = raw.contextTokens;
      }
      const controller = new AbortController();
      pulls.set(ref, controller);
      const report = (progress: AiPullProgress): void => emit({ type: 'pull', id: ref, progress });
      pullOllamaModel({
        ref,
        modelsDir,
        appVersion,
        signal: controller.signal,
        onProgress: (progress) => report({ ...progress }),
        log,
      })
        .then(async (file) => {
          try {
            await checkModelFile(file.path);
            const model = registry.add(spec, { path: file.path });
            report({ state: 'done', bytes: file.size, total: file.size, modelId: model.id });
          } catch (error) {
            // A verified file that cannot become an entry (invalid header, limit, I/O) would otherwise stay on disk.
            await deleteUnsharedBlob(file.path);
            throw error;
          }
        })
        .catch((error: unknown) => {
          const state = controller.signal.aborted ? 'cancelled' : 'error';
          const { code, message } = failure(error);
          report(state === 'error' ? { state, code, message } : { state });
        })
        .finally(() => pulls.delete(ref));
      return {};
    })
  );
  handle('ai:models:pull:cancel', (_event, ref) => {
    const controller = typeof ref === 'string' ? pulls.get(ref) : undefined;
    if (controller) {
      controller.abort();
    }
    return true;
  });

  if (wantsAutoDownload(previous)) {
    downloadIfMissing();
  }

  return {
    /** Reacts to settings changes: unload on ai.enabled false, clear the cache when it is switched off, auto-download. */
    onSettingsChanged(values?: Record<string, unknown>): void {
      const next = { ...previous, ...(values || getSettings()) };
      if (previous['ai.enabled'] !== false && next['ai.enabled'] === false) {
        if (suggestion) {
          suggestion.controller.abort();
        }
        if (!textJob) {
          engine.unload().catch((error: unknown) => log.warn(`Could not unload the AI engine: ${messageOf(error)}`));
        }
      }
      if (previous['ai.summaryCache'] !== false && next['ai.summaryCache'] === false) {
        cache.clear().catch((error: unknown) => log.warn(`Could not clear the summary cache: ${messageOf(error)}`));
      }
      if (previous['ai.enabled'] === false && next['ai.enabled'] !== false) {
        preloadEngine();
      }
      if (!wantsAutoDownload(previous) && wantsAutoDownload(next)) {
        downloadIfMissing();
      }
      previous = next;
    },

    /** Cancels summary and suggestion work when the window closes; a running download continues. */
    onWindowClosed(): void {
      cancelWork();
    },

    /** Stops everything before quit: jobs, engine, downloader, pending cache writes. */
    async dispose(): Promise<void> {
      cancelWork();
      pulls.forEach((controller) => controller.abort());
      if (localEngine) {
        await localEngine.dispose().catch((error: unknown) => log.warn(`Could not stop the model process: ${messageOf(error)}`));
      }
      stopListening.forEach((stop) => stop());
      const results = await Promise.allSettled([cache.flush(), engine.dispose(), manager.dispose()]);
      for (const result of results) {
        if (result.status === 'rejected') {
          log.warn(`AI shutdown step failed: ${errorFields(result.reason).message}`);
        }
      }
    },
  };
}
