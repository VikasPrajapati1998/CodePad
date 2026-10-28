/**
 * Prompt templates and output post-processing for the AI (suggestions use the local model only; summaries use
 * the same chat specs for the local and the remote models, plus a single-pass prompt for large-context models).
 * Pure functions with no I/O, so they can be tested without the model. Specs are plain data:
 *   { kind: 'raw', text }                         raw continuation, tokenized as plain text
 *   { kind: 'chat', system, user, assistantPrefix }   rendered by the worker with ChatML special tokens
 */

const suggestText: CodePadSuggestTextApi = require('./shared/suggestText');

/** Raw continuation, tokenized as plain text. */
export interface RawSpec {
  kind: 'raw';
  text: string;
}

/** Chat request, rendered by the worker with ChatML special tokens. */
export interface ChatSpec {
  kind: 'chat';
  system: string;
  user: string;
  assistantPrefix: string;
}

/** A prompt spec (plain data, safe to post to the worker). */
export type PromptSpec = RawSpec | ChatSpec;

/** Generation options shared by the local and remote paths. */
export interface GenOptions {
  maxTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  seed: number;
  repeatPenalty: { readonly penalty: number; readonly lastTokens: number };
  stop: readonly string[];
}

/** A prompt spec together with its generation options. */
export interface BuiltPrompt<S extends PromptSpec = PromptSpec> {
  spec: S;
  gen: GenOptions;
}

/** Exact values for a map prompt: a plain list, or an object with the extracted lists. */
export type FactsInput = readonly unknown[] | { dates?: unknown[]; numbers?: unknown[]; emails?: unknown[]; urls?: unknown[] } | null | undefined;

/** One group of notes for the reduce prompt. */
export interface NoteGroup {
  title: string;
  bullets: string[] | string;
}

/** A segment of a rendered chat prompt. */
export interface ChatSegment {
  text: string;
  special: boolean;
}

/** Result of {@link loopGuard}. */
export interface LoopResult {
  loop: boolean;
  cutAt: number;
}

/** The prompt builders, as injected into the summarizer. */
export interface SummaryPrompts {
  buildMapPrompt(options: { title: string; chunk: string; facts: FactsInput }): BuiltPrompt<ChatSpec>;
  buildReducePrompt(options: { groups: NoteGroup[] }): BuiltPrompt<ChatSpec>;
  buildOverviewPrompt(options: { name: string; material: string; isRawText: boolean }): BuiltPrompt<ChatSpec>;
  buildKeyPointsPrompt(options: { name: string; material: string; isRawText: boolean }): BuiltPrompt<ChatSpec>;
  buildSinglePassPrompt(options: { name: string; material: string }): BuiltPrompt<ChatSpec>;
  parseSinglePass(text: string, options: { max: number }): { overview: string; bullets: string[] } | null;
  parseBullets(text: string, options: { max: number }): string[];
}

export const SPECIAL_TOKENS = Object.freeze([
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<think>',
  '</think>',
  '<|fim_prefix|>',
  '<|fim_middle|>',
  '<|fim_suffix|>',
  '<|fim_pad|>',
  '<|repo_name|>',
  '<|file_sep|>',
]);

export const ALWAYS_STOP = Object.freeze(['<|im_end|>', '<|endoftext|>', '<|im_start|>', '<think>', '</think>', '```']);

export const SYSTEM =
  'You summarize documents. Use only information that appears in the provided text. ' +
  'Never invent names, numbers, dates or facts. Write in the same language as the text. Be brief.';

const MAX_BULLET_CHARS = 300;
const MAX_FACT_CHARS = 450;
const LOOP_MIN_UNIT = 8;
const LOOP_MAX_UNIT = 60;
const LOOP_MIN_LINE = 8;
const LOOP_SCAN_CHARS = 2000;

const SUMMARY_GEN: Readonly<Omit<GenOptions, 'maxTokens'>> = Object.freeze({
  temperature: 0.3,
  topK: 20,
  topP: 0.8,
  minP: 0,
  seed: 42,
  repeatPenalty: Object.freeze({ penalty: 1.1, lastTokens: 96 }),
  stop: Object.freeze(['<|im_end|>', '<|im_start|>', '<think>', '\n\n\n']),
});

/**
 * Detects degenerate repetition in generated text.
 * @param text Text generated so far.
 * @returns `cutAt` is the length of the text to keep when `loop` is true.
 */
export function loopGuard(text: string): LoopResult {
  const base = Math.max(0, text.length - LOOP_SCAN_CHARS);
  const tail = text.slice(base);
  for (let unit = LOOP_MIN_UNIT; unit <= LOOP_MAX_UNIT && unit * 3 <= tail.length; unit += 1) {
    const last = tail.slice(-unit);
    if (tail.slice(-2 * unit, -unit) === last && tail.slice(-3 * unit, -2 * unit) === last) {
      let start = tail.length - 3 * unit;
      while (start - unit >= 0 && tail.slice(start - unit, start) === last) {
        start -= unit;
      }
      return { loop: true, cutAt: base + start + unit };
    }
  }
  const lines = tail.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length - 2; i += 1) {
    offset += lines[i].length + 1;
    const line = lines[i].trim();
    if (line.length >= LOOP_MIN_LINE && lines[i + 1].trim() === line) {
      return { loop: true, cutAt: base + offset };
    }
  }
  return { loop: false, cutAt: text.length };
}

/** Everything the suggestion prompt is built from (the renderer sends the document parts, main assembles them). */
export interface SuggestPromptInput {
  prefix: string;
  header: string;
  scope: string;
  suffix: string;
  languageId: string;
  multiline: boolean;
  maxTokens: number;
}

const SUGGEST_PROSE_TOKEN_FACTOR = 3;
const SUGGEST_CODE_TOKEN_FACTOR = 2;
const SUGGEST_MULTILINE_TOKEN_FACTOR = 1.5;
const SUGGEST_TOKEN_CAP = 128;

/**
 * Lays out the raw prompt. Only text BEFORE the cursor goes in, in reading order: the file header (imports, front
 * matter/heading), an elision marker, the enclosing declarations and then the prefix window. The text after the
 * cursor is deliberately not shown to the 0.6B model (it copies what it sees instead of continuing); it only feeds
 * stop strings and the cleaning stage, which cut any repetition of it.
 * @param input Document parts and the language.
 * @returns The prompt text.
 */
export function layoutSuggestPrompt({ prefix, header, scope, languageId }: Pick<SuggestPromptInput, 'prefix' | 'header' | 'scope' | 'languageId'>): string {
  if (suggestText.languageKind(languageId) === 'prose') {
    return header === '' ? prefix : `${header}\n\n${prefix}`;
  }
  const leader = suggestText.commentLeader(languageId);
  const parts: string[] = [];
  if (header !== '') {
    parts.push(header);
  }
  if (header !== '' || scope !== '') {
    parts.push(leader === '' ? '' : `${leader} ...`);
  }
  if (scope !== '') {
    parts.push(scope);
  }
  parts.push(prefix);
  return parts.join('\n');
}

/**
 * Builds the raw-continuation request for ghost text.
 * @param input Text before the cursor, header/scope/suffix context, language and limits.
 * @returns Prompt spec and generation options.
 */
export function buildSuggestPrompt(input: SuggestPromptInput): BuiltPrompt<RawSpec> {
  const prose = suggestText.languageKind(input.languageId) === 'prose';
  const factor = (prose ? SUGGEST_PROSE_TOKEN_FACTOR : SUGGEST_CODE_TOKEN_FACTOR) * (input.multiline ? SUGGEST_MULTILINE_TOKEN_FACTOR : 1);
  return {
    spec: { kind: 'raw', text: layoutSuggestPrompt(input) },
    gen: {
      maxTokens: Math.min(SUGGEST_TOKEN_CAP, Math.round(input.maxTokens * factor)),
      temperature: 0.2,
      topK: 20,
      topP: 0.9,
      minP: 0.05,
      seed: 7,
      repeatPenalty: prose ? { penalty: 1.1, lastTokens: 64 } : { penalty: 1.05, lastTokens: 32 },
      stop: [...ALWAYS_STOP, ...(input.multiline ? ['\n\n'] : ['\n']), ...suggestText.suggestStops(input.suffix)],
    },
  };
}

/** Editor context and generation outcome that cleanSuggestion needs. */
export interface SuggestCleanContext {
  prefix: string;
  suffixLine: string;
  suffix: string;
  header: string;
  scope: string;
  languageId: string;
  multiline: boolean;
  /** The model stopped because of the token limit (the end is probably cut). */
  truncated: boolean;
}

/**
 * Cleans raw model output into an inline suggestion: cuts it to a complete sentence or statement, drops dangling or
 * unbalanced output and anything that repeats text before or after the cursor.
 * @param raw Generated text.
 * @param context Editor context.
 * @returns The text to show, or null when it should be discarded.
 */
export function cleanSuggestion(raw: unknown, context: SuggestCleanContext): string | null {
  let text = String(raw).replace(/\r\n?/g, '\n');
  const cuts = [...SPECIAL_TOKENS, '```'].map((token) => text.indexOf(token)).filter((index) => index >= 0);
  if (cuts.length > 0) {
    text = text.slice(0, Math.min(...cuts));
  }
  const result = suggestText.trimSuggestion(text, context);
  return result !== null && !loopGuard(result).loop ? result : null;
}

function stripSpecialTokens(text: string): string {
  return SPECIAL_TOKENS.reduce((acc, token) => acc.split(token).join(''), text);
}

/** Joins the exact values of a facts object (or array) for the map prompt, within a small token budget. */
function formatFacts(facts: FactsInput): string {
  let values: readonly unknown[] = [];
  if (Array.isArray(facts)) {
    values = facts;
  } else if (facts && typeof facts === 'object') {
    const lists = facts as { dates?: unknown[]; numbers?: unknown[]; emails?: unknown[]; urls?: unknown[] };
    values = [...(lists.dates ?? []), ...(lists.numbers ?? []), ...(lists.emails ?? []), ...(lists.urls ?? [])];
  }
  const picked: string[] = [];
  let length = 0;
  for (const value of values) {
    const item = String(value).replace(/\s+/g, ' ').trim();
    if (item !== '' && length + item.length + 2 <= MAX_FACT_CHARS) {
      picked.push(item);
      length += item.length + 2;
    }
  }
  return picked.length > 0 ? picked.join('; ') : 'none';
}

function quoteName(name: unknown): string {
  return String(name).replace(/["\r\n]+/g, ' ').trim();
}

function chatPrompt(user: string, assistantPrefix: string, maxTokens: number): BuiltPrompt<ChatSpec> {
  return {
    spec: { kind: 'chat', system: SYSTEM, user: `${user} /no_think`, assistantPrefix },
    gen: { maxTokens, ...SUMMARY_GEN },
  };
}

/**
 * Prompt that condenses one chunk of the document into a few bullets.
 * @param options Chunk title, text and extracted facts.
 * @returns Chat prompt and generation options.
 */
export function buildMapPrompt({ title, chunk, facts }: { title: string; chunk: string; facts: FactsInput }): BuiltPrompt<ChatSpec> {
  return chatPrompt(
    `Part title: ${String(title).replace(/\s+/g, ' ').trim()}\n` +
      `Exact facts found in this part (copy them exactly if you mention them): ${formatFacts(facts)}\n\n` +
      `Text:\n<<<\n${chunk}\n>>>\n\n` +
      'Write 2 to 4 bullet points with the most important information in this text. ' +
      'Each bullet starts with "- " and is one short sentence. Output only the bullets.',
    '- ',
    160,
  );
}

/**
 * Prompt that merges per-section notes into at most six bullets.
 * @param options Ordered note groups.
 * @returns Chat prompt and generation options.
 */
export function buildReducePrompt({ groups }: { groups: NoteGroup[] }): BuiltPrompt<ChatSpec> {
  const notes = groups
    .map((group) => {
      const bullets = Array.isArray(group.bullets) ? group.bullets.map((b) => `- ${b}`).join('\n') : group.bullets;
      return `### ${group.title}\n${bullets}`;
    })
    .join('\n\n');
  return chatPrompt(
    `Notes from consecutive parts of one document:\n\n${notes}\n\n` +
      'Combine these notes into at most 6 bullet points that keep the most important information. ' +
      'Do not repeat yourself. Each bullet starts with "- ". Output only the bullets.',
    '- ',
    260,
  );
}

function documentHeader(name: string, material: string, isRawText: boolean): string {
  return `${isRawText ? 'Document' : 'Notes about the document'} "${quoteName(name)}":\n<<<\n${material}\n>>>\n\n`;
}

/**
 * Prompt for the one-paragraph overview.
 * @param options Document name and source material.
 * @returns Chat prompt and generation options.
 */
export function buildOverviewPrompt({ name, material, isRawText }: { name: string; material: string; isRawText: boolean }): BuiltPrompt<ChatSpec> {
  return chatPrompt(
    `${documentHeader(name, material, isRawText)}` +
      'Write one paragraph of 3 to 5 sentences that summarizes the document. Output only the paragraph.',
    '',
    220,
  );
}

/**
 * Prompt for the key-points bullet list.
 * @param options Document name and source material.
 * @returns Chat prompt and generation options.
 */
export function buildKeyPointsPrompt({ name, material, isRawText }: { name: string; material: string; isRawText: boolean }): BuiltPrompt<ChatSpec> {
  return chatPrompt(
    `${documentHeader(name, material, isRawText)}` +
      'Write 4 to 8 bullet points with the key points of the document. ' +
      'Each bullet starts with "- ". Output only the bullets.',
    '- ',
    260,
  );
}

/**
 * Prompt that produces the overview paragraph and the key points in one call (single-pass mode for models whose
 * context holds the whole document).
 * @param options Document name and full text.
 * @returns Chat prompt and generation options.
 */
export function buildSinglePassPrompt({ name, material }: { name: string; material: string }): BuiltPrompt<ChatSpec> {
  return chatPrompt(
    `${documentHeader(name, material, true)}` +
      'Answer in exactly this format and nothing else:\n' +
      'OVERVIEW:\n<one paragraph of 3 to 5 sentences that summarizes the document>\n' +
      'KEY POINTS:\n<4 to 8 bullet points, each starting with "- ">',
    '',
    700,
  );
}

/**
 * Splits the answer of buildSinglePassPrompt.
 * @param text Model output.
 * @param options Maximum number of key points.
 * @returns Parsed parts, or null when the format was not followed.
 */
export function parseSinglePass(text: string, { max }: { max: number }): { overview: string; bullets: string[] } | null {
  const match = /^\s*\**OVERVIEW:?\**\s*([\s\S]*?)\n\s*\**KEY POINTS:?\**\s*([\s\S]*)$/i.exec(stripSpecialTokens(String(text)));
  if (!match) {
    return null;
  }
  const overview = match[1].replace(/\s+/g, ' ').trim();
  const bullets = parseBullets(match[2], { max });
  return overview && bullets.length > 0 ? { overview, bullets } : null;
}

/**
 * Extracts bullet lines from model output.
 * @param text Model output (including the assistant prefix).
 * @param options Maximum number of bullets.
 * @returns Unique, cleaned bullets in order.
 */
export function parseBullets(text: string, { max }: { max: number }): string[] {
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const line of stripSpecialTokens(String(text)).split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    const bullet = match ? match[1].trim().slice(0, MAX_BULLET_CHARS) : '';
    const key = bullet.toLowerCase();
    if (bullet !== '' && !seen.has(key)) {
      seen.add(key);
      bullets.push(bullet);
      if (bullets.length >= max) {
        break;
      }
    }
  }
  return bullets;
}

/** What the chat assistant should return: a reply for the transcript or the complete new content of a file. */
export type ChatOutput = 'answer' | 'file' | 'write';

/** One earlier message of the chat. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Everything the chat prompt is built from (file text and history are already cut to the model's budget). */
export interface ChatPromptInput {
  instruction: string;
  fileName?: string;
  fileText?: string;
  history: ChatTurn[];
  output: ChatOutput;
}

const CHAT_SYSTEM_ANSWER =
  'You are the assistant of a text editor. Answer the user\'s request briefly and directly in the same language as the request. ' +
  'The current file, if any, is given between <<< and >>>; use it only when the request is about it. ' +
  'Never invent content that is not in the file. Write plain text only: no XML or HTML tags such as <response>.';

const CHAT_SYSTEM_FILE =
  'You are the writing engine of a text editor. Carry out the user\'s request and output ONLY the complete content of the resulting file. ' +
  'No explanations, no introduction, no closing remark and no code fence around the file. ' +
  'The current file, if any, is given between <<< and >>>; keep everything the request does not ask to change. ' +
  'Never invent facts, names, numbers or dates. Do not wrap the answer in XML or HTML tags such as <response>.';

// New content for a file of any type (text, JSON, code...): the task names the file type and the format rules.
const CHAT_SYSTEM_WRITE =
  'You are the content writer of a text editor. Write the new content the task asks for, in the format of the file type the task names. ' +
  'Output ONLY that content: no title unless asked, no introduction, no closing remark, no explanation and no code fence. ' +
  'Do not repeat the task. Do not wrap the answer in XML or HTML tags such as <response>.';

const CHAT_TEMPERATURE = { answer: 0.4, file: 0.2, write: 0.5 } as const;

/**
 * Chat prompt for the assistant: earlier messages, the file in a delimited block and the request.
 * @param input Request, file and history (already cut to fit the model).
 * @param maxTokens Largest answer in tokens.
 * @returns Chat prompt and generation options (the stop list has no blank-line stop, so files keep their paragraphs).
 */
export function buildChatPrompt({ instruction, fileName, fileText, history, output }: ChatPromptInput, maxTokens: number): BuiltPrompt<ChatSpec> {
  const parts: string[] = [];
  if (history.length > 0) {
    const turns = history.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n');
    parts.push(`Earlier messages:\n${turns}`);
  }
  if (fileText !== undefined && fileText !== '') {
    parts.push(`Current file${fileName ? ` "${quoteName(fileName)}"` : ''}:\n<<<\n${fileText}\n>>>`);
  }
  parts.push(output === 'write' ? instruction : `Request: ${instruction}`);
  return {
    spec: {
      kind: 'chat',
      system: output === 'file' ? CHAT_SYSTEM_FILE : output === 'write' ? CHAT_SYSTEM_WRITE : CHAT_SYSTEM_ANSWER,
      user: parts.join('\n\n'),
      assistantPrefix: '',
    },
    gen: {
      maxTokens,
      temperature: CHAT_TEMPERATURE[output],
      topK: 20,
      topP: 0.8,
      minP: 0,
      seed: 42,
      repeatPenalty: { penalty: 1.05, lastTokens: 96 },
      stop: ['<|im_end|>', '<|im_start|>', '<think>'],
    },
  };
}

/**
 * Splits a chat spec into ChatML segments. Only the template tags are special; the system, user and
 * assistant-prefix strings are always plain text, so document content can never inject control tokens.
 * @param spec Chat spec.
 * @returns Ordered segments for the worker to tokenize.
 */
export function chatSegments({ system, user, assistantPrefix }: Pick<ChatSpec, 'system' | 'user' | 'assistantPrefix'>): ChatSegment[] {
  return [
    { text: '<|im_start|>system\n', special: true },
    { text: system, special: false },
    { text: '<|im_end|>\n<|im_start|>user\n', special: true },
    { text: user, special: false },
    { text: '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n', special: true },
    { text: assistantPrefix, special: false },
  ].filter((segment) => segment.text !== '');
}
