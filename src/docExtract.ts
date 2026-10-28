/*
 * Deterministic document analysis for the summary pipeline. Pure functions: no AI, no I/O, no logging.
 * Splits text into sections, extracts exact facts (dates, numbers with units, e-mails, links, table rows),
 * cuts the sections into model-sized chunks, and provides the helpers that check model output against the
 * source (digitIndex / unverifiedNumbers) and render the copied "Key facts" list. Used by summarizer.ts.
 */

/** A section of the document (`level` 0 marks untitled/synthetic sections). */
export interface Section {
  title: string;
  level: number;
  text: string;
}

/** Exact facts copied from the text; `nameHints` are guesses, never facts. */
export interface Facts {
  dates: string[];
  numbers: string[];
  emails: string[];
  urls: string[];
  tableRows: string[];
  tableHeaders: string[];
  tableCount: number;
  nameHints: string[];
}

/** A model-sized piece of the document. */
export interface Chunk {
  index: number;
  sectionIndex: number;
  title: string;
  text: string;
  tokens: number;
  facts: Facts;
}

interface Heading {
  title: string;
  level: number;
  skipNext: boolean;
}

interface Span {
  start: number;
  end: number;
  value: string;
}

/** A section while small ones are being merged. */
interface MergeEntry extends Section {
  tokens: number;
  combined: boolean;
}

type FactKind = 'dates' | 'numbers' | 'emails' | 'urls';

const BEGINNING_TITLE = '(Beginning)';
const MAX_LINE_CHARS = 10000;
const MAX_HEADING_CHARS = 120;
const MAX_HEADING_TITLE = 80;
const MAX_TABLE_ROW_CHARS = 200;
const SMALL_SECTION_RATIO = 0.25;
const DOMINANT_SECTION_RATIO = 0.9;
const CHARS_PER_TOKEN = 3.5;
const DEFAULT_OVERLAP_TOKENS = 80;
const DEFAULT_MAX_PER_KIND = 300;
const MIN_SPLIT_BUDGET = 50;
const KEY_FACTS_PER_KIND = 20;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff]/g;
const CJK_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED_HEADING = /^(\d{1,3}(?:\.\d{1,3}){0,3})([.)]?)\s+\p{Lu}.{0,100}$/u;
const KEYWORD_HEADING = /^(?:chapter|section|part|article|appendix|annex)\s+[\dIVXLC]+\b/i;
const SETEXT_UNDERLINE = /^(=|-){3,}\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|' +
  'Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\b\\.?\\s+\\d{4}\\b`, 'gi'),
];

const NUMBER_CORE = "\\d+(?:[,.']\\d+|[ \\u202f]\\d{3}\\b)*";
const UNITS =
  '%|percent|per cent|kg|g|mg|t|km|m|cm|mm|mi|ft|lb|lbs|°C|°F|kWh|MWh|kW|MW|W|V|Hz|GB|MB|KB|TB|ms|s|sec|min|' +
  'h|hrs?|hours?|days?|weeks?|months?|years?|USD|EUR|GBP|INR|JPY|CNY|million|billion|trillion|thousand|bn|mn|k';
const NUMBER_PATTERN = new RegExp(
  `[$€£¥₹]\\s?${NUMBER_CORE}|\\b${NUMBER_CORE}\\s?(?:${UNITS})(?![\\p{L}\\d])`,
  'gu'
);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const URL_PATTERNS = [/\bhttps?:\/\/[^\s<>"'`)\]]{1,500}/g, /\bwww\.[^\s<>"'`)\]]{1,500}/g];
const URL_TRAILING = /[.,;:!?]+$/;

const TITLED_NAME = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Dame)\.?[ \t]+\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+)?/gu;
const CAPITALIZED_RUN = /\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+){1,2}/gu;
const NAME_STOP_WORDS = new Set(
  (
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday ' +
    'the this that these those a an in on at for and but or if when while with from by to of as it its we our ' +
    'you your they their he she his her there here what which who how why where after before during each every ' +
    'some any all no not also however therefore table figure section chapter part page appendix introduction ' +
    'conclusion summary overview abstract contents references note notes example total'
  ).split(' ')
);

const SENTENCE_BREAK = /(?<=[.!?。！？])\s+/;
const PARAGRAPH_BREAK = /\n{2,}/;
const SPLITTERS: { split: (text: string) => string[]; joiner: string }[] = [
  { split: (text) => text.split(PARAGRAPH_BREAK), joiner: '\n\n' },
  { split: (text) => text.split('\n'), joiner: '\n' },
  { split: (text) => text.split(SENTENCE_BREAK), joiner: ' ' },
];

/** Normalizes line endings and whitespace and strips control characters (tabs and newlines are kept). */
export function normalize(text: unknown): string {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Deliberately pessimistic token estimate: one token per CJK/kana/hangul character, otherwise 3.5 chars. */
export function estimateTokens(text: unknown): number {
  const value = String(text);
  const cjk = (value.match(CJK_CHARS) || []).length;
  return cjk + Math.ceil((value.length - cjk) / CHARS_PER_TOKEN);
}

function cutTitle(title: string): string {
  return title.length > MAX_HEADING_TITLE ? `${title.slice(0, MAX_HEADING_TITLE - 1)}…` : title;
}

function wordCount(line: string): number {
  return line.split(/\s+/).length;
}

function isAllCapsHeading(line: string): boolean {
  if (line.includes('|') || line.includes('\t') || wordCount(line) > 10) {
    return false;
  }
  const letters = line.match(/\p{L}/gu) || [];
  if (letters.length < 3) {
    return false;
  }
  const upper = letters.filter((letter) => letter !== letter.toLowerCase()).length;
  return upper / letters.length >= 0.8;
}

/** Returns {title, level, skipNext} when the (trimmed) line is a heading, else null. */
function detectHeading(line: string, nextLine: string | undefined): Heading | null {
  if (!line || line.length > MAX_HEADING_CHARS) {
    return null;
  }
  const markdown = MARKDOWN_HEADING.exec(line);
  if (markdown) {
    return { title: markdown[2], level: markdown[1].length, skipNext: false };
  }
  if (/[.,;]$/.test(line)) {
    return null;
  }
  const underline = typeof nextLine === 'string' ? SETEXT_UNDERLINE.exec(nextLine.trim()) : null;
  if (underline) {
    return { title: line, level: underline[1] === '=' ? 1 : 2, skipNext: true };
  }
  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered && wordCount(line) <= 12) {
    const depth = numbered[1].split('.').length;
    if (depth > 1 || numbered[2]) {
      return { title: line, level: depth + 1, skipNext: false };
    }
  }
  if (KEYWORD_HEADING.test(line)) {
    return { title: line, level: 1, skipNext: false };
  }
  if (isAllCapsHeading(line)) {
    return { title: line, level: 2, skipNext: false };
  }
  return null;
}

/** Groups paragraph blocks greedily into parts of about `targetTokens` (used when there is no heading structure). */
function paragraphSections(text: string, targetTokens: number): Section[] {
  const parts: Section[] = [];
  let blocks: string[] = [];
  let tokens = 0;
  const flush = () => {
    if (blocks.length > 0) {
      parts.push({ title: `Part ${parts.length + 1}`, level: 0, text: blocks.join('\n\n') });
      blocks = [];
      tokens = 0;
    }
  };
  for (const block of text.split(PARAGRAPH_BREAK).map((item) => item.trim()).filter(Boolean)) {
    const blockTokens = estimateTokens(block);
    if (tokens > 0 && tokens + blockTokens > targetTokens) {
      flush();
    }
    blocks.push(block);
    tokens += blockTokens;
  }
  flush();
  return parts;
}

/**
 * Splits text into sections by headings (markdown, setext, numbered, keyword, ALL CAPS), falling back to
 * paragraph blocks when the text has no usable structure.
 * @param text Normalized text.
 * @param options Part size used by the paragraph fallback.
 * @returns Never empty; `level` 0 marks untitled/synthetic sections.
 */
export function splitSections(text: string, { targetTokens = 1200 }: { targetTokens?: number } = {}): Section[] {
  const lines = String(text).split('\n');
  const found: { title: string; level: number; lines: string[] }[] = [];
  let current: { title: string; level: number; lines: string[] } = { title: BEGINNING_TITLE, level: 0, lines: [] };
  let headings = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
    }
    const heading = inFence ? null : detectHeading(line.trim(), lines[i + 1]);
    if (heading) {
      found.push(current);
      headings += 1;
      current = { title: cutTitle(heading.title), level: heading.level, lines: [] };
      i += heading.skipNext ? 1 : 0;
    } else {
      current.lines.push(line);
    }
  }
  found.push(current);

  const sections = found
    .map((item) => ({ title: item.title, level: item.level, text: item.lines.join('\n').trim() }))
    .filter((item) => item.text);
  const total = sections.reduce((sum, item) => sum + item.text.length, 0);
  const dominant = sections.some((item) => item.text.length >= total * DOMINANT_SECTION_RATIO);
  if (headings < 2 || dominant) {
    const parts = paragraphSections(String(text), targetTokens);
    return parts.length > 0 ? parts : [{ title: BEGINNING_TITLE, level: 0, text: String(text).trim() }];
  }
  return sections;
}

/** Removes matches contained in a longer match and returns the values in order of position. */
function distinctSpans(spans: Span[]): string[] {
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let reach = -1;
  for (const span of sorted) {
    if (span.end > reach) {
      kept.push(span);
      reach = span.end;
    }
  }
  return kept.map((span) => span.value);
}

function spansOf(line: string, patterns: RegExp[], clean: (value: string) => string = (value) => value): string[] {
  const spans: Span[] = [];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const value = clean(match[0].trim());
      if (value) {
        const start = match.index ?? 0;
        spans.push({ start, end: start + match[0].length, value });
      }
    }
  }
  return distinctSpans(spans);
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (let i = text.indexOf(char); i !== -1; i = text.indexOf(char, i + 1)) {
    count += 1;
  }
  return count;
}

const isTableRow = (trimmed: string): boolean => countChar(trimmed, '|') >= 2 || countChar(trimmed, '\t') >= 2;
const isTableRule = (trimmed: string): boolean => /^[\s|:+-]+$/.test(trimmed) && trimmed.includes('-');

function nameKeyOf(words: string[]): string | null {
  const kept = [...words];
  while (kept.length > 0 && NAME_STOP_WORDS.has(kept[0].toLowerCase())) {
    kept.shift();
  }
  while (kept.length > 0 && NAME_STOP_WORDS.has(kept[kept.length - 1].toLowerCase())) {
    kept.pop();
  }
  return kept.length >= 2 ? kept.join(' ') : null;
}

function countNames(line: string, counts: Map<string, number>): void {
  for (const match of line.matchAll(TITLED_NAME)) {
    const key = match[0].replace(/\s+/g, ' ');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const match of line.matchAll(CAPITALIZED_RUN)) {
    const key = nameKeyOf(match[0].split(/[ \t]+/));
    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
}

/**
 * Extracts exact facts from text, copied verbatim. Every list is unique, in order of first appearance and capped.
 * @param text Text to scan.
 * @param options `names: false` skips the (document-wide) name hints.
 * @returns The facts; `nameHints` are guesses, never facts.
 */
export function extractFacts(
  text: string,
  { maxPerKind = DEFAULT_MAX_PER_KIND, names = true }: { maxPerKind?: number; names?: boolean } = {}
): Facts {
  const found: Record<FactKind, Set<string>> = { dates: new Set(), numbers: new Set(), emails: new Set(), urls: new Set() };
  const rows = new Set<string>();
  const headers = new Set<string>();
  const nameCounts = new Map<string, number>();
  const sources: [FactKind, RegExp[]][] = [
    ['dates', DATE_PATTERNS],
    ['numbers', [NUMBER_PATTERN]],
    ['emails', [EMAIL_PATTERN]],
    ['urls', URL_PATTERNS],
  ];
  let tableCount = 0;
  let inTable = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    const trimmed = line.trim();
    if (!trimmed) {
      inTable = false;
      continue;
    }
    if (isTableRow(trimmed)) {
      if (!inTable) {
        tableCount += 1;
        headers.add(trimmed.slice(0, MAX_TABLE_ROW_CHARS));
        inTable = true;
      }
      if (!isTableRule(trimmed)) {
        rows.add(trimmed.slice(0, MAX_TABLE_ROW_CHARS));
      }
    } else {
      inTable = false;
    }
    for (const [kind, patterns] of sources) {
      if (found[kind].size < maxPerKind) {
        const clean = kind === 'urls' ? (value: string) => value.replace(URL_TRAILING, '') : undefined;
        for (const value of spansOf(line, patterns, clean)) {
          if (found[kind].size < maxPerKind) {
            found[kind].add(value);
          }
        }
      }
    }
    if (names) {
      countNames(line, nameCounts);
    }
  }
  const repeated = [...nameCounts].filter(([, count]) => count >= 2).map(([key]) => key);
  const nameHints = repeated
    .filter((key) => !repeated.some((other) => other !== key && other.includes(key)))
    .slice(0, maxPerKind);
  return {
    dates: [...found.dates],
    numbers: [...found.numbers],
    emails: [...found.emails],
    urls: [...found.urls],
    tableRows: [...rows].slice(0, maxPerKind),
    tableHeaders: [...headers].slice(0, maxPerKind),
    tableCount,
    nameHints,
  };
}

/** Splits an over-long text with no usable break into pieces whose estimate fits the budget. */
function hardSplit(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let size = Math.max(1, Math.floor(budget * 3));
  let position = 0;
  while (position < text.length) {
    let end = Math.min(text.length, position + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      end = space > position + size / 2 ? space : end;
    }
    while (end - position > 1 && estimateTokens(text.slice(position, end)) > budget) {
      size = Math.max(1, Math.floor(size * 0.75));
      end = position + Math.min(size, end - position - 1);
    }
    pieces.push(text.slice(position, end));
    position = end;
  }
  return pieces;
}

/** Splits text into pieces of at most `budget` tokens: at blank lines, then lines, then sentences, then characters. */
function splitText(text: string, budget: number): string[] {
  if (estimateTokens(text) <= budget) {
    return [text];
  }
  for (const { split, joiner } of SPLITTERS) {
    const units = split(text).filter((unit) => unit.trim());
    if (units.length > 1) {
      const pieces: string[] = [];
      let buffer: string[] = [];
      let tokens = 0;
      const flush = () => {
        if (buffer.length > 0) {
          pieces.push(buffer.join(joiner));
          buffer = [];
          tokens = 0;
        }
      };
      for (const unit of units) {
        const unitTokens = estimateTokens(unit);
        if (unitTokens > budget) {
          flush();
          pieces.push(...splitText(unit, budget));
        } else {
          if (tokens + unitTokens + 1 > budget) {
            flush();
          }
          buffer.push(unit);
          tokens += unitTokens + 1;
        }
      }
      flush();
      return pieces;
    }
  }
  return hardSplit(text, budget);
}

/** The last paragraph(s) of `text`, at most `overlapTokens` long, to repeat at the start of the next piece. */
function overlapTail(text: string, overlapTokens: number): string {
  const paragraphs = text.split(PARAGRAPH_BREAK);
  const taken: string[] = [];
  let tokens = 0;
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const paragraphTokens = estimateTokens(paragraphs[i]);
    if (tokens + paragraphTokens > overlapTokens) {
      break;
    }
    taken.unshift(paragraphs[i]);
    tokens += paragraphTokens;
  }
  if (taken.length > 0) {
    return taken.join('\n\n');
  }
  let tail = text.slice(-Math.floor(overlapTokens * 3));
  while (tail.length > 1 && estimateTokens(tail) > overlapTokens) {
    tail = tail.slice(Math.ceil(tail.length * 0.1));
  }
  const space = tail.search(/\s/);
  return space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
}

/** Merges tiny sections into their neighbours (keeping each part's title line) while the result fits. */
function mergeSmallSections(sections: Section[], maxTokens: number): MergeEntry[] {
  const small = maxTokens * SMALL_SECTION_RATIO;
  const labelled = (part: Section): string => (part.level > 0 ? `${part.title}\n${part.text}` : part.text);
  const merged: MergeEntry[] = [];
  let pending: MergeEntry | null = null;
  const join = (first: MergeEntry, second: MergeEntry): MergeEntry => ({
    title: cutTitle(`${first.title} / ${second.title}`),
    level: Math.min(first.level, second.level),
    text: `${first.combined ? first.text : labelled(first)}\n\n${labelled(second)}`,
    tokens: first.tokens + second.tokens,
    combined: true,
  });
  for (const section of sections) {
    const entry: MergeEntry = { ...section, tokens: estimateTokens(section.text), combined: false };
    if (pending && pending.tokens + entry.tokens <= maxTokens) {
      pending = join(pending, entry);
    } else {
      if (pending) {
        merged.push(pending);
      }
      pending = entry;
    }
    if (pending.tokens >= small) {
      merged.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const previous = merged[merged.length - 1];
    if (previous && previous.tokens + pending.tokens <= maxTokens) {
      merged[merged.length - 1] = join(previous, pending);
    } else {
      merged.push(pending);
    }
  }
  return merged;
}

/**
 * Cuts sections into chunks of at most `maxTokens`: tiny sections are merged, oversized ones are split at
 * paragraph/line/sentence breaks with a small overlap.
 * @param sections Output of `splitSections`.
 * @param options Chunk budget (the overlap is included in it).
 * @returns The chunks in order.
 */
export function chunkSections(
  sections: Section[],
  { maxTokens, overlapTokens = DEFAULT_OVERLAP_TOKENS }: { maxTokens: number; overlapTokens?: number }
): Chunk[] {
  const chunks: Chunk[] = [];
  const budget = Math.max(MIN_SPLIT_BUDGET, maxTokens - overlapTokens - 4);
  mergeSmallSections(sections, maxTokens).forEach((section, sectionIndex) => {
    const pieces = section.tokens > maxTokens ? splitText(section.text, budget) : [section.text];
    pieces.forEach((piece, pieceIndex) => {
      const body = pieceIndex > 0 ? `${overlapTail(pieces[pieceIndex - 1], overlapTokens)}\n\n${piece}` : piece;
      chunks.push({
        index: chunks.length,
        sectionIndex,
        title: pieceIndex > 0 ? cutTitle(`${section.title} (continued)`) : section.title,
        text: body,
        tokens: estimateTokens(body),
        facts: extractFacts(body, { maxPerKind: 12, names: false }),
      });
    });
  });
  return chunks;
}

/** Canonical form of a digit run: no leading zeros, no trailing decimal zeros. */
function canonicalNumber(run: string): string {
  const [whole, fraction = ''] = run.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? `${integer}.${decimals}` : integer;
}

function digitRuns(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) || [];
}

/** Text with thousands separators removed and a decimal comma turned into a dot. */
function stripSeparators(text: string, includeSpaces: boolean): string {
  const separators = includeSpaces ? "[,' _\\u202f]" : "[,'_]";
  return text
    .replace(new RegExp(`(?<=\\d)${separators}(?=\\d{3}\\b)`, 'g'), '')
    .replace(/(?<=\d),(?=\d{1,2}\b)/g, '.');
}

/**
 * Every number in the text in the spellings a model may reproduce (raw, separators removed, canonical,
 * integer part of decimals), for `unverifiedNumbers`.
 * @param text Source text.
 * @returns The set of spellings.
 */
export function digitIndex(text: string): Set<string> {
  const index = new Set<string>();
  const source = String(text);
  for (const variant of [source, stripSeparators(source, false), stripSeparators(source, true)]) {
    for (const run of digitRuns(variant)) {
      index.add(run);
      index.add(canonicalNumber(run));
      index.add(canonicalNumber(run.split('.')[0]));
    }
  }
  return index;
}

/**
 * The numbers in a sentence that do not occur in the source.
 * @param sentence Model output.
 * @param index Result of `digitIndex` for the source.
 * @returns Offending digit runs (empty when every number is verified).
 */
export function unverifiedNumbers(sentence: string, index: Set<string>): string[] {
  return digitRuns(stripSeparators(String(sentence), false)).filter((run) => !index.has(canonicalNumber(run)));
}

/** Splits text into sentences at ., !, ? (and CJK equivalents) followed by whitespace. */
export function splitSentences(text: string): string[] {
  return String(text)
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export const escapeMarkdown = (value: unknown): string => String(value).replace(/[\\*_[\]`]/g, '\\$&');

/**
 * Renders the "Key facts" markdown block straight from extracted facts (no AI involved).
 * @param facts Result of `extractFacts` for the whole document.
 * @returns Markdown block, or '' when the document has no extractable facts.
 */
export function formatKeyFacts(facts: Facts): string {
  const list = (items: string[]): string => items.slice(0, KEY_FACTS_PER_KIND).map(escapeMarkdown).join('; ');
  const lines: string[] = [];
  const add = (label: string, items: string[]): void => {
    if (items.length > 0) {
      lines.push(`- **${label}:** ${list(items)}`);
    }
  };
  add('Dates', facts.dates);
  add('Numbers', facts.numbers);
  add('Emails', facts.emails);
  add('Links', facts.urls);
  if (facts.tableCount > 0) {
    const headers = facts.tableHeaders
      .slice(0, 5)
      .map((row) => `\`${row.slice(0, 120).replace(/`/g, "'")}\``)
      .join('; ');
    lines.push(`- **Tables:** ${facts.tableCount} ${facts.tableCount === 1 ? 'table' : 'tables'}; header rows: ${headers}`);
  }
  add('Possible names (automatic guess)', facts.nameHints);
  return lines.length > 0 ? `## Key facts (copied from the document, not AI)\n${lines.join('\n')}` : '';
}
