/*
 * In-memory map-reduce summary driver. Runs inside the AI utility process (aiWorker.ts) for local models and in
 * main for remote models, always with an injected `complete(spec, gen)` generation primitive; it never touches
 * the filesystem, the network or the logs. When the text fits the model context it is summarized in one pass.
 * Chunks, extracted facts and source text live only in local variables of one summarize() call.
 * Every number in model output is checked against the source, and the "Key facts" list is copied from
 * the document by docExtract.ts instead of being written by the model.
 */
import * as extract from './docExtract';
import * as defaultPrompts from './aiPrompts';
import type { BuiltPrompt, ChatSpec, GenOptions, SummaryPrompts } from './aiPrompts';

/** Phase of a running summary. */
export type SummaryPhase = 'extract' | 'map' | 'reduce' | 'final' | 'verify';

/** Progress report of a summary run. */
export interface SummaryProgress {
  phase: SummaryPhase;
  current: number;
  total: number;
  /** Partial summary so far (absent in the `extract` report). */
  markdown?: string;
}

/** Counters of a finished summary run. */
export interface SummaryStats {
  chunks: number;
  calls: number;
  dropped: number;
  elapsedMs: number;
}

/** Result of {@link summarize}; `markdown` is the summary body without the H1 title. */
export interface SummaryResult {
  markdown: string;
  stats: SummaryStats;
}

/** Output style of a summary. */
export type SummaryStyle = 'both' | 'paragraph' | 'bullets';

/** Generation primitive `(spec, gen) => text`; rejects with `{code: 'E_PROMPT_TOO_LONG'}` or an AbortError. */
export type CompleteFn = (spec: ChatSpec, gen: GenOptions) => Promise<string>;

/** Input of {@link summarize}. */
export interface SummarizeJob {
  /** Document text. */
  text: string;
  /** Document name (used in the overview prompt only). */
  name: string;
  style: SummaryStyle | string;
  /** Target chunk size in tokens (`ai.chunkTokens`). */
  chunkTokens: number;
  /** Model context size in tokens. */
  contextTokens?: number;
  /** Model name shown in the summary note (default: the built-in model). */
  modelLabel?: string;
  /** Host that received the text; when set the note says the text left this computer. */
  remoteHost?: string;
  /** Ask for overview and key points in one call when the whole text is one chunk. */
  singlePass?: boolean;
  complete: CompleteFn;
  /** Cancels the run between and during model calls. */
  signal?: AbortSignal;
  onProgress?: (progress: SummaryProgress) => void;
  /** Prompt builders (defaults to ./aiPrompts). */
  prompts?: SummaryPrompts;
}

interface NoteBlock {
  title: string;
  bullets: string[];
}

interface Sections {
  overview: string;
  keyPoints: string;
  sections: string;
  keyFacts: string;
}

export const PIPELINE_VERSION = 1;
const MODEL_LABEL = 'Qwen3-0.6B';
const STYLES = new Set<string>(['both', 'paragraph', 'bullets']);
const PROMPT_RESERVE_TOKENS = 900;
const REDUCE_RESERVE_TOKENS = 1100;
const MIN_CHUNK_TOKENS = 200;
const MAX_PROMPT_FACT_TOKENS = 150;
const MAP_BULLETS = 4;
const REDUCE_BULLETS = 6;
const KEY_POINT_BULLETS = 8;
const LONG_DOCUMENT_CHUNKS = 4;
const MIN_SECTION_TITLES = 3;
const MAX_SECTIONS = 12;
const SECTION_BULLETS = 3;
const MAX_REDUCE_ROUNDS = 8;
const MAX_SHRINK_RETRIES = 4;
const MAX_TITLE_CHARS = 80;
const BULLET_START = /^\s*(?:[-*•]|\d{1,2}[.)])\s/;
const OVERVIEW_OMITTED = '_(The overview could not be verified against the source and was omitted.)_';
const KEY_POINTS_OMITTED = '_(No key points could be verified against the source.)_';

function abortError(): Error {
  const error: Error & { code?: string } = new Error('The summary was cancelled.');
  error.name = 'AbortError';
  error.code = 'E_ABORTED';
  return error;
}

const isTooLong = (error: unknown): boolean => Boolean(error) && (error as { code?: unknown }).code === 'E_PROMPT_TOO_LONG';

function cleanTitle(title: unknown): string {
  const flat = String(title).replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

/** Exact values handed to the model with a chunk (dates, numbers, e-mails, links), within a small token budget. */
function promptFacts(facts: extract.Facts): string[] {
  const values: string[] = [];
  let tokens = 0;
  for (const value of [...facts.dates, ...facts.numbers, ...facts.emails, ...facts.urls]) {
    tokens += extract.estimateTokens(value) + 1;
    if (tokens > MAX_PROMPT_FACT_TOKENS) {
      break;
    }
    values.push(value);
  }
  return values;
}

/** Splits text in two at the break (blank line, line, space) nearest to the middle. */
function splitHalf(text: string): [string, string] {
  const middle = Math.floor(text.length / 2);
  for (const separator of ['\n\n', '\n', ' ']) {
    const before = text.lastIndexOf(separator, middle);
    const after = text.indexOf(separator, middle);
    const candidates = [before, after].filter((position) => position > 0 && position < text.length - 1);
    if (candidates.length > 0) {
      const position = candidates.reduce((best, item) => (Math.abs(item - middle) < Math.abs(best - middle) ? item : best));
      return [text.slice(0, position).trim(), text.slice(position + separator.length).trim()];
    }
  }
  return [text.slice(0, middle), text.slice(middle)];
}

/** Drops the last quarter of a text (at a line break when possible) after the model rejected it as too long. */
function shrink(text: string): string {
  const cut = text.slice(0, Math.floor(text.length * 0.75));
  const lineEnd = cut.lastIndexOf('\n');
  return lineEnd > cut.length / 2 ? cut.slice(0, lineEnd) : cut;
}

function renderGroup(group: NoteBlock): string {
  return `### ${extract.escapeMarkdown(group.title)}\n${group.bullets.map((bullet) => `- ${bullet}`).join('\n')}`;
}

const renderGroups = (groups: NoteBlock[]): string =>
  groups
    .filter((group) => group.bullets.length > 0)
    .map(renderGroup)
    .join('\n\n');

/** Per-section bullet blocks: at most 12 sections of 3 distinct map bullets each. */
function sectionBlocks(groups: NoteBlock[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const group of groups) {
    const bullets: string[] = [];
    for (const bullet of group.bullets) {
      const key = bullet.toLowerCase();
      if (bullets.length < SECTION_BULLETS && !seen.has(key)) {
        seen.add(key);
        bullets.push(bullet);
      }
    }
    if (bullets.length > 0 && blocks.length < MAX_SECTIONS) {
      blocks.push(renderGroup({ title: group.title, bullets }));
    }
  }
  return blocks.join('\n\n');
}

/** Packs consecutive groups into batches whose rendered size stays within the budget. */
function packGroups(groups: NoteBlock[], budget: number): NoteBlock[][] {
  const batches: NoteBlock[][] = [];
  let batch: NoteBlock[] = [];
  let tokens = 0;
  for (const group of groups) {
    const groupTokens = extract.estimateTokens(renderGroup(group));
    if (batch.length > 0 && tokens + groupTokens > budget) {
      batches.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(group);
    tokens += groupTokens;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function composeMarkdown(
  { overview, keyPoints, sections, keyFacts }: Partial<Sections>,
  dropped: number,
  origin: string
): string {
  const note =
    `_Generated ${origin}. AI text can be wrong or incomplete; the Key facts are copied ` +
    `from the document.${dropped > 0 ? ` ${dropped} statement${dropped === 1 ? '' : 's'} with numbers not found in the source ${dropped === 1 ? 'was' : 'were'} removed.` : ''}_`;
  const parts: string[] = [note];
  if (overview) {
    parts.push(`## Overview\n${overview}`);
  }
  if (keyPoints) {
    parts.push(`## Key points\n${keyPoints}`);
  }
  if (sections) {
    parts.push(`## Sections\n${sections}`);
  }
  if (keyFacts) {
    parts.push(keyFacts);
  }
  return parts.join('\n\n');
}

/**
 * Summarizes a document with map-reduce over structure-based chunks.
 * @param job See {@link SummarizeJob}.
 * @returns `markdown` is the summary body without the H1 title.
 * @throws {Error} AbortError (code E_ABORTED) when cancelled; model errors propagate unchanged.
 */
export async function summarize({
  text,
  name,
  style,
  chunkTokens,
  contextTokens = 4096,
  modelLabel = MODEL_LABEL,
  remoteHost = '',
  singlePass = false,
  complete,
  signal,
  onProgress = () => {},
  prompts = defaultPrompts,
}: SummarizeJob): Promise<SummaryResult> {
  const started = Date.now();
  const origin = remoteHost
    ? `by ${modelLabel}; the document text was sent to ${remoteHost}`
    : `on this computer by ${modelLabel}`;
  const stats: SummaryStats = { chunks: 0, calls: 0, dropped: 0, elapsedMs: 0 };
  const wanted = STYLES.has(style) ? style : 'both';
  const wantsParagraph = wanted !== 'bullets';
  const wantsBullets = wanted !== 'paragraph';

  const generate = async (built: BuiltPrompt<ChatSpec>): Promise<string> => {
    if (signal && signal.aborted) {
      throw abortError();
    }
    stats.calls += 1;
    return complete(built.spec, built.gen);
  };
  /** Runs a prompt built from `material`, shrinking the material when the model says it is too long. */
  const generateFitting = async (
    buildFor: (material: string) => BuiltPrompt<ChatSpec>,
    material: string
  ): Promise<{ built: BuiltPrompt<ChatSpec>; output: string }> => {
    let current = material;
    for (let attempt = 0; ; attempt += 1) {
      const built = buildFor(current);
      try {
        return { built, output: await generate(built) };
      } catch (error) {
        if (!isTooLong(error) || attempt >= MAX_SHRINK_RETRIES) {
          throw error;
        }
        current = shrink(current);
      }
    }
  };
  const parseBullets = (built: BuiltPrompt<ChatSpec>, output: string, max: number): string[] => {
    const prefix = (built.spec && built.spec.assistantPrefix) || '';
    const body = prefix && !BULLET_START.test(output) ? prefix + output : output;
    return prompts.parseBullets(body, { max });
  };

  const source = extract.normalize(text);
  const maxTokens = Math.max(MIN_CHUNK_TOKENS, Math.min(chunkTokens, contextTokens - PROMPT_RESERVE_TOKENS));
  const chunks = extract.chunkSections(extract.splitSections(source, { targetTokens: maxTokens }), { maxTokens });
  const facts = extract.extractFacts(source);
  const index = extract.digitIndex(source);
  stats.chunks = chunks.length;
  onProgress({ phase: 'extract', current: 0, total: chunks.length });

  /** Keeps the statements whose numbers all occur in the source; counts the rest as dropped. */
  const verified = (statements: string[]): string[] =>
    statements.filter((statement) => {
      if (extract.unverifiedNumbers(statement, index).length === 0) {
        return true;
      }
      stats.dropped += 1;
      return false;
    });

  const mapChunk = async (chunk: extract.Chunk, depth: number): Promise<string[]> => {
    const built = prompts.buildMapPrompt({ title: chunk.title, chunk: chunk.text, facts: promptFacts(chunk.facts) });
    try {
      return parseBullets(built, await generate(built), MAP_BULLETS);
    } catch (error) {
      if (!isTooLong(error) || depth > 0) {
        throw error;
      }
      const results: string[] = [];
      for (const half of splitHalf(chunk.text)) {
        const halfFacts = extract.extractFacts(half, { maxPerKind: 12, names: false });
        results.push(...(await mapChunk({ ...chunk, text: half, facts: halfFacts }, depth + 1)));
      }
      return results.slice(0, REDUCE_BULLETS);
    }
  };

  const groups: NoteBlock[] = [];
  let material: string;
  let isRawText = false;
  if (chunks.length === 1) {
    material = chunks[0].text;
    isRawText = true;
  } else {
    for (let i = 0; i < chunks.length; i += 1) {
      onProgress({
        phase: 'map',
        current: i + 1,
        total: chunks.length,
        markdown: groups.length > 0 ? composeMarkdown({ sections: sectionBlocks(groups) }, stats.dropped, origin) : '',
      });
      const bullets = verified(await mapChunk(chunks[i], 0));
      groups.push({ title: cleanTitle(chunks[i].title), bullets });
    }

    // Hierarchical reduce: merge neighbouring notes until they fit the model context.
    const reduceBudget = contextTokens - REDUCE_RESERVE_TOKENS;
    let notes = groups.filter((group) => group.bullets.length > 0);
    for (
      let round = 0;
      round < MAX_REDUCE_ROUNDS && extract.estimateTokens(renderGroups(notes)) > reduceBudget;
      round += 1
    ) {
      const batches = packGroups(notes, reduceBudget);
      if (batches.length >= notes.length) {
        break;
      }
      const next: NoteBlock[] = [];
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        if (batch.length === 1) {
          next.push(batch[0]);
        } else {
          onProgress({ phase: 'reduce', current: i + 1, total: batches.length, markdown: '' });
          const built = prompts.buildReducePrompt({ groups: batch });
          const bullets = verified(parseBullets(built, await generate(built), REDUCE_BULLETS));
          next.push({
            title: cleanTitle(`${batch[0].title} - ${batch[batch.length - 1].title}`),
            bullets: bullets.length > 0 ? bullets : batch.map((group) => group.bullets[0]),
          });
        }
      }
      notes = next;
    }
    material = renderGroups(notes);
    if (!material) {
      material = chunks[0].text;
      isRawText = true;
    }
  }

  const sections: Sections = { overview: '', keyPoints: '', sections: '', keyFacts: '' };
  const partial = (): string => composeMarkdown(sections, stats.dropped, origin);
  onProgress({ phase: 'final', current: 0, total: 1, markdown: partial() });

  let combined: { overview: string; bullets: string[] } | null = null;
  if (singlePass && isRawText && wantsParagraph && wantsBullets) {
    const built = prompts.buildSinglePassPrompt({ name, material });
    try {
      combined = prompts.parseSinglePass(await generate(built), { max: KEY_POINT_BULLETS });
    } catch (error) {
      if (!isTooLong(error)) {
        throw error;
      }
    }
    if (combined) {
      const sentences = verified(extract.splitSentences(combined.overview));
      sections.overview = sentences.length > 0 ? sentences.join(' ') : OVERVIEW_OMITTED;
      const points = verified(combined.bullets);
      sections.keyPoints = points.length > 0 ? points.map((point) => `- ${point}`).join('\n') : KEY_POINTS_OMITTED;
      onProgress({ phase: 'final', current: 1, total: 1, markdown: partial() });
    }
  }

  if (wantsParagraph && !combined) {
    const { output } = await generateFitting(
      (value) => prompts.buildOverviewPrompt({ name, material: value, isRawText }),
      material
    );
    const flat = output
      .replace(/<\|[^|>]*\|>|<\/?think>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sentences = verified(extract.splitSentences(flat));
    sections.overview = sentences.length > 0 ? sentences.join(' ') : OVERVIEW_OMITTED;
    onProgress({ phase: 'final', current: 1, total: 1, markdown: partial() });
  }
  if (wantsBullets && !combined) {
    const { built, output } = await generateFitting(
      (value) => prompts.buildKeyPointsPrompt({ name, material: value, isRawText }),
      material
    );
    const points = verified(parseBullets(built, output, KEY_POINT_BULLETS));
    sections.keyPoints = points.length > 0 ? points.map((point) => `- ${point}`).join('\n') : KEY_POINTS_OMITTED;
    const titles = new Set(groups.map((group) => group.title.replace(/ \(continued\)$/, '')));
    if (chunks.length >= LONG_DOCUMENT_CHUNKS && titles.size >= MIN_SECTION_TITLES) {
      sections.sections = sectionBlocks(groups);
    }
    onProgress({ phase: 'final', current: 1, total: 1, markdown: partial() });
  }

  onProgress({ phase: 'verify', current: 1, total: 1, markdown: partial() });
  sections.keyFacts = extract.formatKeyFacts(facts);
  stats.elapsedMs = Date.now() - started;
  return { markdown: partial(), stats };
}
