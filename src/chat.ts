/*
 * Chat assistant driver. Pure and I/O-free like rewriter.ts: it runs inside the AI utility process for local models
 * and in main for remote models, always with an injected `complete(spec, gen)` primitive, and never touches the
 * filesystem, the network or the logs (the instruction, the file text and the answer are never recorded). Long
 * files and histories are cut to the model's budget (a head and tail excerpt for the file), and an answer is cleaned
 * of reasoning blocks, control tokens and, when it should be a whole file, of a wrapping code fence.
 */
import * as prompts from './aiPrompts';
import type { ChatOutput, ChatPromptInput, ChatTurn } from './aiPrompts';
import type { CompleteFn } from './summarizer';

/** How much of the request fits the model, in characters, and the largest answer in tokens. */
export interface ChatLimits {
  maxFileChars: number;
  maxHistoryChars: number;
  maxTokens: number;
}

/** Input of {@link runChat}. */
export interface ChatJob extends ChatPromptInput {
  limits: ChatLimits;
  complete: CompleteFn;
  /** Cancels the run before the model call. */
  signal?: AbortSignal;
}

/** The cleaned answer and notes for the user (for example that only an excerpt of the file was used). */
export interface ChatResult {
  text: string;
  warnings: string[];
}

const HEAD_SHARE = 0.6;
const MIN_FILE_CHARS = 500;
const MAX_FIT_ATTEMPTS = 3;
const MAX_TURN_CHARS = 600;
const OMITTED = '\n[... part of the file omitted ...]\n';
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
const THINK_OPEN = /<think>[\s\S]*$/;
const SPECIAL_TOKEN = /<\|[^|>]{1,32}\|>/g;
/** Wrapper tags a small model sometimes puts around its answer, such as <response> or </answer>. */
const WRAPPER_TAG = /<\/?(?:response|answer|output|result|reply|file|content|assistant|text|document)\s*>/gi;
const WRAPPING_FENCE = /^\s*(```|~~~)[^\n]*\n([\s\S]*?)\n?\1[ \t]*\s*$/;

/**
 * Cuts text to at most `max` characters, keeping the start and the end.
 * @param text Text to cut.
 * @param max Largest result length in characters.
 * @returns The text itself when it fits, otherwise head + marker + tail.
 */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const room = Math.max(0, max - OMITTED.length);
  const head = Math.floor(room * HEAD_SHARE);
  return `${text.slice(0, head)}${OMITTED}${text.slice(text.length - (room - head))}`;
}

/** Keeps the newest turns that fit `maxChars` in total; long turns are cut to their start. */
function fitHistory(history: ChatTurn[], maxChars: number): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const content = history[i].content.slice(0, Math.min(MAX_TURN_CHARS, Math.max(0, maxChars - used)));
    if (content === '') {
      break;
    }
    used += content.length;
    kept.unshift({ role: history[i].role, content });
  }
  return kept;
}

/**
 * Cleans a model answer: drops reasoning blocks and control tokens and, for a whole file, a code fence around it.
 * @param raw Model output.
 * @param output What the answer should be.
 * @returns The text to give the user (may be empty).
 */
export function cleanChatAnswer(raw: string, output: ChatOutput): string {
  let text = raw.replace(THINK_BLOCK, '').replace(THINK_OPEN, '').replace(SPECIAL_TOKEN, '').replace(WRAPPER_TAG, '').replace(/\r\n?/g, '\n');
  if (output !== 'answer') {
    const fenced = WRAPPING_FENCE.exec(text);
    text = (fenced ? fenced[2] : text).replace(/^\n+/, '').replace(/\s+$/, '');
    return text === '' ? '' : `${text}\n`;
  }
  return text.trim();
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

/**
 * Answers one chat request with a single model call. When the prompt does not fit the model (E_PROMPT_TOO_LONG)
 * the file excerpt is halved and the call repeated a few times.
 * @param job Request, limits and the generation primitive.
 * @returns The cleaned text and warnings.
 * @throws {Error} `E_ABORTED` when cancelled; `E_EMPTY` when the model produced no text; the primitive's own errors.
 */
export async function runChat({ instruction, fileName, fileText, history, output, limits, complete, signal }: ChatJob): Promise<ChatResult> {
  const warnings: string[] = [];
  let fileChars = limits.maxFileChars;
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) {
      throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError', code: 'E_ABORTED' });
    }
    const shown = fileText === undefined ? undefined : excerpt(fileText, fileChars);
    const { spec, gen } = prompts.buildChatPrompt(
      { instruction, fileName, fileText: shown, history: fitHistory(history, limits.maxHistoryChars), output },
      limits.maxTokens,
    );
    try {
      const raw = await complete(spec, gen);
      if (fileText !== undefined && shown !== fileText) {
        warnings.push('The file is longer than the model can read, so only its start and end were used.');
      }
      const text = cleanChatAnswer(raw, output);
      if (text === '') {
        throw Object.assign(new Error('The model returned no text.'), { code: 'E_EMPTY' });
      }
      return { text, warnings };
    } catch (error) {
      if (codeOf(error) !== 'E_PROMPT_TOO_LONG' || attempt >= MAX_FIT_ATTEMPTS || fileText === undefined || fileChars <= MIN_FILE_CHARS) {
        throw error;
      }
      fileChars = Math.max(MIN_FILE_CHARS, Math.floor(fileChars / 2));
    }
  }
}
