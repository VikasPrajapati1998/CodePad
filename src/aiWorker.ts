/**
 * Entry point of the AI utility process. Runs node-llama-cpp (ESM, loaded with dynamic import) and answers the
 * protocol of aiEngine.ts (see aiProtocol.ts) over `process.parentPort`. It has no network access and never logs
 * content.
 */

import * as fs from 'fs/promises';
import type {
  Llama,
  LlamaCompletion,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
  Token,
} from 'node-llama-cpp' with { 'resolution-mode': 'import' };
import * as prompts from './aiPrompts';
import type { PromptSpec } from './aiPrompts';
import type { EngineInfo, WorkerMessage, WorkerRequest } from './aiProtocol';

/** The node-llama-cpp module (an ES module, so it is only ever loaded with a dynamic import). */
type NodeLlama = typeof import('node-llama-cpp', { with: { 'resolution-mode': 'import' } });

/** The slice of Electron's utility-process `process.parentPort` this worker uses (missing from @types/node). */
interface ParentPort {
  postMessage(message: WorkerMessage): void;
  on(event: 'message', listener: (event: { data: WorkerRequest }) => void): void;
}

/** Fields of a thrown value this file looks at. */
interface ErrorLike {
  code?: unknown;
  name?: unknown;
  message?: unknown;
}

/** Generation options as received from main: every field is re-validated before use. */
interface UntrustedGen {
  maxTokens?: unknown;
  temperature?: unknown;
  topK?: unknown;
  topP?: unknown;
  minP?: unknown;
  seed?: unknown;
  repeatPenalty?: { penalty?: unknown; lastTokens?: unknown } | null;
  stop?: unknown;
}

interface SanitizedGen {
  maxTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  seed: number;
  repeatPenalty: { penalty: number; lastTokens: number } | false;
  stop: string[];
}

/** A context with one long-lived sequence and the completion helper bound to it. */
interface Slot {
  context: LlamaContext;
  sequence: LlamaContextSequence;
  completion: LlamaCompletion;
}

interface CompletionResult {
  text: string;
  stopReason: string;
  /** What the model produced first (for the "no text" error message). */
  firstToken?: string;
}

type InitRequest = Extract<WorkerRequest, { type: 'init' }>;
type SuggestRequest = Extract<WorkerRequest, { type: 'suggest' }>;
type SummarizeRequest = Extract<WorkerRequest, { type: 'summarize' }>;
type RewriteRequest = Extract<WorkerRequest, { type: 'rewrite' }>;
type ChatRequest = Extract<WorkerRequest, { type: 'chat' }>;

// Network kill-switch: installed before node-llama-cpp (or anything else) is imported. It patches the JS-level
// network APIs only; native sockets, dgram, http2 or child_process are not covered and the process is not OS
// sandboxed. It is defence in depth: the real protection is that main only hands over files whose GGUF header
// passed ggufHeader.ts and that the user confirmed a non-curated model (aiIpc.ts).
(function disableNetwork(): void {
  const blocked = (): never => {
    throw new Error('Network is disabled in the AI engine');
  };
  ['fetch', 'WebSocket'].forEach((name) =>
    Object.defineProperty(globalThis, name, { value: blocked, writable: true, configurable: true }),
  );
  // The live module objects are patched, so they are loaded with require instead of imported as namespaces.
  const load = (name: string): Record<string, unknown> => require(name) as Record<string, unknown>;
  const http = load('http');
  const https = load('https');
  const net = load('net');
  const tls = load('tls');
  const dns = load('dns');
  http['request'] = blocked;
  http['get'] = blocked;
  https['request'] = blocked;
  https['get'] = blocked;
  net['connect'] = blocked;
  net['createConnection'] = blocked;
  tls['connect'] = blocked;
  dns['lookup'] = blocked;
  (dns['promises'] as Record<string, unknown>)['lookup'] = blocked;
  (require('module') as typeof import('module')).syncBuiltinESMExports();
})();

process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'true';
process.env.NODE_LLAMA_CPP_LOG_LEVEL = 'error';

// 2048 tokens hold header + scope + a 2000-char window + up to 128 generated tokens; the KV cache of Qwen3-0.6B costs
// about 112 KiB per token (28 layers x 8 KV heads x 128 x 2 x 2 bytes), so this slot grows from ~112 MiB to ~224 MiB.
const SUGGEST_CONTEXT = 2048;
const SUMMARY_CONTEXT = 4096;
const TRIM_STEP_TOKENS = 64;
const SAFETY_TOKENS = 16;
const MAX_RAW_CHARS = 40000;
const MAX_CHAT_CHARS = 60000;
const MAX_SUMMARY_CHARS = 2000000;
const MAX_NAME_CHARS = 200;
const MAX_ERROR_CHARS = 200;
const STYLES = new Set<string>(['both', 'paragraph', 'bullets']);
const REWRITE_MODES = new Set<string>(['grammar', 'restructure']);
const MAX_INSTRUCTION_CHARS = 500;
const LANGUAGE_ID = /^[A-Za-z0-9_.+-]{1,40}$/;
const CHAT_OUTPUTS = new Set<string>(['answer', 'file', 'write']);
const MAX_CHAT_INSTRUCTION_CHARS = 2000;
const MAX_CHAT_HISTORY = 8;
const MAX_CHAT_TURN_CHARS = 4000;

const parent = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort;
const jobs = new Map<number, AbortController>();
let nlc: NodeLlama | null = null;
let llama: Llama | null = null;
let model: LlamaModel | null = null;
let suggestSlot: Slot | null = null;
let initializing: Promise<EngineInfo> | null = null;
let engineThreads = 1;

const send = (message: WorkerMessage): void => parent.postMessage(message);

const errorLike = (error: unknown): ErrorLike => (typeof error === 'object' && error !== null ? error : {});

const messageOf = (error: unknown): string => {
  const { message } = errorLike(error);
  return String(message ?? error);
};

function requireEngine(): NodeLlama {
  if (!nlc) {
    throw new Error('The AI engine is not loaded.');
  }
  return nlc;
}

function requireModel(): LlamaModel {
  if (!model) {
    throw new Error('The AI engine is not loaded.');
  }
  return model;
}

function abortError(): Error {
  return Object.assign(new Error('The request was cancelled.'), { name: 'AbortError', code: 'E_ABORTED' });
}

function codeOf(error: unknown): string {
  const { code, name } = errorLike(error);
  if (code === 'E_PROMPT_TOO_LONG' || code === 'E_ABORTED') {
    return code;
  }
  return name === 'AbortError' ? 'E_ABORTED' : 'E_ENGINE';
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Re-builds generation options from validated, clamped fields only. */
function sanitizeGen(gen: UntrustedGen | null | undefined): SanitizedGen {
  const penalty = gen?.repeatPenalty;
  const stop = Array.isArray(gen?.stop)
    ? (gen.stop as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 40).slice(0, 12)
    : [];
  return {
    maxTokens: Math.round(clamp(gen?.maxTokens, 1, 1024, 32)),
    temperature: clamp(gen?.temperature, 0, 2, 0.3),
    topK: Math.round(clamp(gen?.topK, 0, 200, 20)),
    topP: clamp(gen?.topP, 0, 1, 0.9),
    minP: clamp(gen?.minP, 0, 1, 0),
    seed: Math.round(clamp(gen?.seed, 0, 2 ** 31 - 1, 0)),
    repeatPenalty: penalty
      ? { penalty: clamp(penalty.penalty, 1, 2, 1.1), lastTokens: Math.round(clamp(penalty.lastTokens, 0, 256, 64)) }
      : false,
    stop,
  };
}

/** Plain strings plus, for template tags, the special-token form so both spellings stop generation. */
function stopTriggers(stop: string[]): (string | InstanceType<NodeLlama['LlamaText']>)[] {
  const { LlamaText, SpecialTokensText } = requireEngine();
  return stop.flatMap((item) =>
    prompts.SPECIAL_TOKENS.includes(item) ? [item, new LlamaText(new SpecialTokensText(item))] : [item],
  );
}

/** Forbids the "<think>" token so the model cannot open a new thinking block. */
function noThinkBias(): InstanceType<NodeLlama['TokenBias']> {
  const { TokenBias, LlamaText, SpecialTokensText } = requireEngine();
  return new TokenBias(requireModel().tokenizer).set(new LlamaText(new SpecialTokensText('<think>')), 'never');
}

function tokenizeSpec(spec: PromptSpec): Token[] {
  const { LlamaText, SpecialTokensText } = requireEngine();
  const loaded = requireModel();
  if (spec?.kind === 'raw' && typeof spec.text === 'string' && spec.text.length <= MAX_RAW_CHARS) {
    return loaded.tokenize(spec.text, false);
  }
  if (
    spec?.kind === 'chat' &&
    [spec.system, spec.user, spec.assistantPrefix].every((part) => typeof part === 'string') &&
    spec.system.length + spec.user.length <= MAX_CHAT_CHARS
  ) {
    const values = prompts.chatSegments(spec).map((part) => (part.special ? new SpecialTokensText(part.text) : part.text));
    return new LlamaText(...values).tokenize(loaded.tokenizer);
  }
  throw Object.assign(new Error('Invalid prompt.'), { code: 'E_ENGINE' });
}

/**
 * Runs one completion on a long-lived sequence (the unchanged prefix is not re-evaluated).
 * Resolves `{text, stopReason}`; throws AbortError when `signal` aborts, E_PROMPT_TOO_LONG when the prompt does not fit
 * (or, with `trimToFit`, drops the oldest tokens in steps so the kept window stays stable).
 */
async function complete(
  slot: Slot,
  spec: PromptSpec,
  genInput: UntrustedGen | null | undefined,
  signal: AbortSignal,
  { trimToFit = false }: { trimToFit?: boolean } = {}
): Promise<CompletionResult> {
  const gen = sanitizeGen(genInput);
  let tokens = tokenizeSpec(spec);
  const budget = slot.sequence.contextSize - gen.maxTokens - SAFETY_TOKENS;
  if (tokens.length > budget) {
    if (!trimToFit) {
      throw Object.assign(new Error('The prompt is too long for the AI context.'), { code: 'E_PROMPT_TOO_LONG' });
    }
    tokens = tokens.slice(Math.ceil((tokens.length - budget) / TRIM_STEP_TOKENS) * TRIM_STEP_TOKENS);
  }
  const loop = new AbortController();
  let text = '';
  let cutAt: number | null = null;
  let firstToken: string | undefined;
  // Chat answers already start after an empty think block: a new "<think>" would only end in a stop trigger with no text.
  const tokenBias = spec?.kind === 'chat' ? noThinkBias() : undefined;
  try {
    const result = await slot.completion.generateCompletionWithMeta(tokens, {
      ...(tokenBias ? { tokenBias } : {}),
      onToken(generated: Token[]) {
        if (firstToken === undefined) {
          firstToken = requireModel().detokenize(generated, true);
        }
      },
      maxTokens: gen.maxTokens,
      temperature: gen.temperature,
      topK: gen.topK,
      topP: gen.topP,
      minP: gen.minP,
      seed: gen.seed,
      repeatPenalty: gen.repeatPenalty,
      customStopTriggers: stopTriggers(gen.stop),
      signal: AbortSignal.any([signal, loop.signal]),
      stopOnAbortSignal: false,
      onTextChunk(chunk: string) {
        text += chunk;
        const guard = cutAt === null ? prompts.loopGuard(text) : null;
        if (guard?.loop) {
          cutAt = guard.cutAt;
          loop.abort();
        }
      },
    });
    return { text: result.response, stopReason: result.metadata.stopReason, firstToken };
  } catch (error) {
    if (signal.aborted) {
      throw abortError();
    }
    if (cutAt !== null) {
      return { text: text.slice(0, cutAt), stopReason: 'loop' };
    }
    throw error;
  }
}

async function createSlot(contextSize: number, threads: number): Promise<Slot> {
  const context = await requireModel().createContext({ contextSize, threads, sequences: 1, flashAttention: false });
  const sequence = context.getSequence();
  return { context, sequence, completion: new (requireEngine().LlamaCompletion)({ contextSequence: sequence }) };
}

async function disposeSlot(slot: Slot | null): Promise<void> {
  if (slot) {
    await slot.context.dispose();
  }
}

async function loadEngine({ modelPath, size, threads }: { modelPath: string; size: number; threads: number }): Promise<EngineInfo> {
  const stat = await fs.stat(modelPath);
  if (!stat.isFile() || stat.size !== size) {
    throw new Error('The model file is missing or has an unexpected size.');
  }
  engineThreads = threads;
  const marks: [string, number][] = [['start', performance.now()]];
  const mark = (label: string): void => {
    marks.push([label, performance.now()]);
  };
  // Each step is announced before it starts, so the supervisor can name the one a hung load is stuck in.
  send({ type: 'step', label: 'import' });
  const lib = await import('node-llama-cpp');
  nlc = lib;
  mark('import');
  send({ type: 'step', label: 'getLlama' });
  const apple = process.platform === 'darwin' && process.arch === 'arm64';
  const options = {
    build: 'never' as const,
    usePrebuiltBinaries: true,
    skipDownload: true,
    progressLogs: false,
    logLevel: lib.LlamaLogLevel.error,
  };
  let gpu = false;
  try {
    llama = await lib.getLlama({ ...options, gpu: apple ? 'metal' : false });
    gpu = apple;
    mark('getLlama');
    send({ type: 'step', label: 'loadModel' });
    model = await llama.loadModel({ modelPath, gpuLayers: apple ? 'max' : 0, useMmap: true });
    mark('loadModel');
  } catch (error) {
    if (!apple) {
      throw error;
    }
    if (llama) {
      await llama.dispose();
    }
    gpu = false;
    llama = await lib.getLlama({ ...options, gpu: false });
    model = await llama.loadModel({ modelPath, gpuLayers: 0, useMmap: true });
  }
  send({ type: 'step', label: 'context' });
  const slot = await createSlot(SUGGEST_CONTEXT, threads);
  suggestSlot = slot;
  mark('context');
  send({ type: 'step', label: 'warmup' });
  await slot.sequence.evaluateWithoutGeneratingNewTokens(requireModel().tokenize('Hello', false));
  await slot.sequence.clearHistory();
  mark('warmup');
  // Milliseconds spent in each load step, so a slow start can be traced to one of them.
  const timings = Object.fromEntries(
    marks.slice(1).map(([label, at], index): [string, number] => [label, Math.round(at - marks[index][1])]),
  );
  return { gpu: gpu ? 'metal' : null, threads, modelId: null, timings };
}

async function handleInit(message: InitRequest): Promise<void> {
  const { modelPath, modelId, size, threads } = message;
  if (
    typeof modelPath !== 'string' ||
    typeof modelId !== 'string' ||
    !Number.isSafeInteger(size) ||
    !Number.isInteger(threads) ||
    threads < 1 ||
    threads > 64
  ) {
    send({ type: 'initError', message: 'Invalid init message.' });
    return;
  }
  if (!initializing) {
    initializing = loadEngine({ modelPath, size, threads });
  }
  try {
    const info = await initializing;
    send({ type: 'ready', info: { ...info, modelId } });
  } catch (error) {
    send({ type: 'initError', message: messageOf(error).slice(0, MAX_ERROR_CHARS) });
  }
}

function startJob(id: number): AbortController {
  const controller = new AbortController();
  jobs.set(id, controller);
  return controller;
}

async function handleSuggest({ id, prompt, gen }: SuggestRequest): Promise<void> {
  const controller = startJob(id);
  try {
    if (!suggestSlot) {
      throw new Error('The AI engine is not loaded.');
    }
    const { text, stopReason } = await complete(suggestSlot, prompt, gen, controller.signal, { trimToFit: true });
    send({ type: 'suggestResult', id, text, stopReason });
  } catch (error) {
    send({ type: 'error', id, code: codeOf(error), message: messageOf(error).slice(0, MAX_ERROR_CHARS) });
  } finally {
    jobs.delete(id);
  }
}

async function handleSummarize({ id, text, name, style, chunkTokens, modelLabel }: SummarizeRequest): Promise<void> {
  const controller = startJob(id);
  let slot: Slot | null = null;
  try {
    if (
      !model ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_SUMMARY_CHARS ||
      typeof name !== 'string' ||
      name.length > MAX_NAME_CHARS ||
      !STYLES.has(style) ||
      !Number.isInteger(chunkTokens) ||
      chunkTokens < 600 ||
      chunkTokens > 2400
    ) {
      throw new Error('Invalid summarize request.');
    }
    const summarizer = require('./summarizer') as typeof import('./summarizer');
    const created = await createSlot(SUMMARY_CONTEXT, engineThreads);
    slot = created;
    const result = await summarizer.summarize({
      text,
      name,
      style,
      chunkTokens,
      modelLabel: typeof modelLabel === 'string' && modelLabel ? modelLabel.slice(0, 80) : undefined,
      contextTokens: SUMMARY_CONTEXT,
      prompts,
      signal: controller.signal,
      complete: async (spec, gen) => {
        const { text: output } = await complete(created, spec, gen, controller.signal);
        return `${spec.assistantPrefix ?? ''}${output}`;
      },
      onProgress: (progress) =>
        send({
          type: 'progress',
          id,
          phase: progress.phase,
          current: progress.current ?? 0,
          total: progress.total ?? 0,
          markdown: progress.markdown ?? null,
        }),
    });
    send({ type: 'summaryResult', id, markdown: result.markdown, stats: result.stats });
  } catch (error) {
    send({ type: 'error', id, code: codeOf(error), message: messageOf(error).slice(0, MAX_ERROR_CHARS) });
  } finally {
    jobs.delete(id);
    await disposeSlot(slot).catch(() => {});
  }
}

/** Grammar check / rewrite of one text (rewriter.ts) on a fresh summary-sized context. */
async function handleRewrite({ id, text, mode, instruction, languageId, chunkTokens, maxOutputTokens }: RewriteRequest): Promise<void> {
  const controller = startJob(id);
  let slot: Slot | null = null;
  try {
    if (
      !model ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_SUMMARY_CHARS ||
      !REWRITE_MODES.has(mode) ||
      typeof instruction !== 'string' ||
      instruction.length > MAX_INSTRUCTION_CHARS ||
      typeof languageId !== 'string' ||
      !LANGUAGE_ID.test(languageId) ||
      !Number.isInteger(chunkTokens) ||
      chunkTokens < 200 ||
      chunkTokens > 2400 ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 128 ||
      maxOutputTokens > 1024
    ) {
      throw new Error('Invalid rewrite request.');
    }
    const rewriter = require('./rewriter') as typeof import('./rewriter');
    const created = await createSlot(SUMMARY_CONTEXT, engineThreads);
    slot = created;
    const result = await rewriter.rewrite({
      text,
      mode,
      instruction,
      languageId,
      chunkTokens,
      maxOutputTokens,
      signal: controller.signal,
      complete: async (spec, gen) => {
        const { text: output, stopReason, firstToken } = await complete(created, spec, gen, controller.signal);
        if (output.trim() === '') {
          // Lets the rewriter name why generation produced nothing (it retries with a shorter prompt).
          throw Object.assign(new Error(`generation stopped by "${stopReason}" before any text (first token: ${JSON.stringify(firstToken ?? "none")})`), { code: 'E_EMPTY' });
        }
        return `${spec.assistantPrefix ?? ''}${output}`;
      },
      onProgress: (progress) =>
        send({ type: 'progress', id, phase: 'rewrite', current: progress.current, total: progress.total, markdown: null }),
    });
    send({ type: 'rewriteResult', id, text: result.text, warnings: result.warnings, changes: result.changes, stats: result.stats });
  } catch (error) {
    send({ type: 'error', id, code: codeOf(error), message: messageOf(error).slice(0, MAX_ERROR_CHARS) });
  } finally {
    jobs.delete(id);
    await disposeSlot(slot).catch(() => {});
  }
}

/** Chat request (chat.ts) on a fresh summary-sized context; the file is cut to the limits main computed. */
async function handleChat({ id, instruction, fileName, fileText, history, output, limits }: ChatRequest): Promise<void> {
  const controller = startJob(id);
  let slot: Slot | null = null;
  try {
    if (
      !model ||
      typeof instruction !== 'string' ||
      instruction.length === 0 ||
      instruction.length > MAX_CHAT_INSTRUCTION_CHARS ||
      (fileName !== undefined && (typeof fileName !== 'string' || fileName.length > MAX_NAME_CHARS)) ||
      (fileText !== undefined && (typeof fileText !== 'string' || fileText.length > MAX_CHAT_CHARS)) ||
      !Array.isArray(history) ||
      history.length > MAX_CHAT_HISTORY ||
      !history.every(
        (turn) => (turn?.role === 'user' || turn?.role === 'assistant') && typeof turn.content === 'string' && turn.content.length <= MAX_CHAT_TURN_CHARS
      ) ||
      !CHAT_OUTPUTS.has(output) ||
      !Number.isInteger(limits?.maxFileChars) ||
      limits.maxFileChars < 200 ||
      limits.maxFileChars > MAX_CHAT_CHARS ||
      !Number.isInteger(limits.maxHistoryChars) ||
      limits.maxHistoryChars < 0 ||
      limits.maxHistoryChars > MAX_CHAT_CHARS ||
      !Number.isInteger(limits.maxTokens) ||
      limits.maxTokens < 1 ||
      limits.maxTokens > 1024
    ) {
      throw new Error('Invalid chat request.');
    }
    const chat = require('./chat') as typeof import('./chat');
    const created = await createSlot(SUMMARY_CONTEXT, engineThreads);
    slot = created;
    send({ type: 'progress', id, phase: 'chat', current: 0, total: 1, markdown: null });
    const result = await chat.runChat({
      instruction,
      fileName,
      fileText,
      history,
      output,
      limits,
      signal: controller.signal,
      complete: async (spec, gen) => {
        const { text: answer, stopReason, firstToken } = await complete(created, spec, gen, controller.signal);
        if (answer.trim() === '') {
          throw Object.assign(new Error(`generation stopped by "${stopReason}" before any text (first token: ${JSON.stringify(firstToken ?? "none")})`), { code: 'E_EMPTY' });
        }
        return `${spec.assistantPrefix ?? ''}${answer}`;
      },
    });
    send({ type: 'chatResult', id, text: result.text, warnings: result.warnings });
  } catch (error) {
    send({ type: 'error', id, code: codeOf(error), message: messageOf(error).slice(0, MAX_ERROR_CHARS) });
  } finally {
    jobs.delete(id);
    await disposeSlot(slot).catch(() => {});
  }
}

async function handleDispose(): Promise<void> {
  jobs.forEach((controller) => controller.abort());
  try {
    await disposeSlot(suggestSlot);
    if (model) {
      await model.dispose();
    }
    if (llama) {
      await llama.dispose();
    }
  } finally {
    process.exit(0);
  }
}

parent.on('message', ({ data }) => {
  switch (data?.type) {
    case 'init':
      handleInit(data);
      break;
    case 'suggest':
      handleSuggest(data);
      break;
    case 'summarize':
      handleSummarize(data);
      break;
    case 'rewrite':
      handleRewrite(data);
      break;
    case 'chat':
      handleChat(data);
      break;
    case 'cancel':
      jobs.get(data.id)?.abort();
      break;
    case 'dispose':
      handleDispose();
      break;
    default:
      break;
  }
});
