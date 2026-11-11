/**
 * LanguageTool grammar check over its free public endpoint (no account and no API key; the paid Premium service is
 * never used). The text of the request is sent to languagetool.org, so main asks the user first (grammarOnline.ts).
 * Spelling findings are dropped here: the offline checker (spellcheck.ts) owns spelling.
 */
import { ProviderError, postJson } from './http';

/** Fixed endpoint; nothing else is ever contacted. */
export const LANGUAGETOOL_URL = 'https://api.languagetool.org/v2/check';
/** Host shown in the confirmation. */
export const LANGUAGETOOL_HOST = new URL(LANGUAGETOOL_URL).host;
/** The free service accepts at most 20,000 characters per request. */
export const MAX_GRAMMAR_CHARS = 20000;

const LANGUAGE = 'en-US';
const TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 500;
const MAX_REPLACEMENTS = 5;
const MAX_MESSAGE_CHARS = 300;
const MAX_REPLACEMENT_CHARS = 200;

/** One finding: `offset`/`length` are in UTF-16 units of the text that was sent. */
export interface GrammarMatch {
  offset: number;
  length: number;
  message: string;
  ruleId: string;
  replacements: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function readMatch(raw: unknown, textLength: number): GrammarMatch | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.length) || typeof raw.message !== 'string') {
    return null;
  }
  const offset = raw.offset as number;
  const length = raw.length as number;
  const rule = isRecord(raw.rule) ? raw.rule : {};
  if (offset < 0 || length < 1 || offset + length > textLength || rule.issueType === 'misspelling') {
    return null;
  }
  const replacements = Array.isArray(raw.replacements)
    ? raw.replacements
        .map((item) => (isRecord(item) && typeof item.value === 'string' ? item.value : ''))
        .filter((value) => value !== '' && value.length <= MAX_REPLACEMENT_CHARS)
        .slice(0, MAX_REPLACEMENTS)
    : [];
  return {
    offset,
    length,
    message: raw.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS),
    ruleId: typeof rule.id === 'string' ? rule.id.slice(0, 80) : '',
    replacements,
  };
}

/**
 * Checks English text with the free LanguageTool service.
 * @param text The text (at most {@link MAX_GRAMMAR_CHARS} characters).
 * @param signal Cancels the request.
 * @returns The grammar and style findings, in text order.
 * @throws {ProviderError} `E_PROMPT_TOO_LONG` for a long text; `E_RATE_LIMIT` when the free quota is used up;
 *   `E_NETWORK` / `E_TIMEOUT` without internet; other provider codes for refusals.
 */
export async function checkGrammar(text: string, signal?: AbortSignal): Promise<GrammarMatch[]> {
  if (text.length > MAX_GRAMMAR_CHARS) {
    throw new ProviderError('E_PROMPT_TOO_LONG', `The free grammar service accepts at most ${MAX_GRAMMAR_CHARS} characters at a time.`);
  }
  const answer = await postJson({
    url: LANGUAGETOOL_URL,
    headers: {},
    body: new URLSearchParams({ text, language: LANGUAGE }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    signal,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  return parseMatches(answer, text.length);
}

/**
 * Reads the findings of a LanguageTool answer (pure; spelling findings and out-of-range offsets are dropped).
 * @param answer The parsed JSON answer.
 * @param textLength Length of the text that was sent.
 * @returns At most 500 grammar and style findings, in answer order.
 * @throws {ProviderError} `E_BAD_RESPONSE` when the answer has no `matches` list.
 */
export function parseMatches(answer: unknown, textLength: number): GrammarMatch[] {
  if (!isRecord(answer) || !Array.isArray(answer.matches)) {
    throw new ProviderError('E_BAD_RESPONSE', 'The grammar service answered with something unexpected.');
  }
  const matches: GrammarMatch[] = [];
  for (const raw of answer.matches as unknown[]) {
    const match = readMatch(raw, textLength);
    if (match) {
      matches.push(match);
    }
    if (matches.length >= MAX_MATCHES) {
      break;
    }
  }
  return matches;
}
