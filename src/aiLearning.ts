/**
 * Personal learning of the AI features. The local model cannot be trained on this computer, so "learning" means
 * remembering how this user reacts (accepted ghost text, rated answers, applied or discarded rewrites, rated
 * summaries) and using that to adapt what the AI is asked and what is shown: remembered phrases are offered at once,
 * suggestions that were repeatedly ignored are dropped, and short style hints are added to the chat, grammar and
 * restructure prompts.
 *
 * Everything lives in main: the renderer only reports bounded events and never sees or sets the stored data or the
 * hints. The store is opt-in (`ai.learning`), HMAC-signed, kept in `userData/ai-learning.json` and can be viewed
 * and erased. It contains short pieces of the user's own text (the end of the text before accepted suggestions and
 * the accepted suggestion itself), never whole documents, chat messages or file paths.
 */
import type { SummaryCacheStore } from './summaryCache';
import type { ModelLog } from './modelDownloader';

/** What the renderer may report; the text of a suggestion is looked up in main by `reqId`, never sent. */
export type LearnEvent =
  | { kind: 'suggest'; outcome: 'shown' | 'accepted'; reqId: number; chars?: number }
  | { kind: 'chat'; rating: 'up' | 'down'; answerChars: number }
  | { kind: 'rewrite'; mode: 'grammar' | 'restructure'; outcome: 'applied' | 'discarded'; instruction?: string }
  /** Rates the format of the most recent summary (main knows which one that was). */
  | { kind: 'summary'; rating: 'up' | 'down' };

export type SummaryStyleName = 'both' | 'paragraph' | 'bullets';

/** One remembered suggestion: where it was offered (`c`, the end of the text before the cursor) and how it fared. */
interface SuggestItem {
  /** Language id. */
  l: string;
  /** End of the text before the cursor. */
  c: string;
  /** Suggested text. */
  t: string;
  /** Times shown. */
  s: number;
  /** Times accepted (also partly). */
  a: number;
  /** Last use (ms since epoch). */
  u: number;
}

interface Tally {
  up: number;
  down: number;
}

interface RewriteTally {
  applied: number;
  discarded: number;
}

interface InstructionItem {
  t: string;
  n: number;
  u: number;
}

/** The parts of the AI that can learn; each has its own switch (`ai.learning.<name>`) under the main one. */
export type LearnFeature = 'suggest' | 'chat' | 'rewrite' | 'summary';

/** Prompts that can carry a sentence written by the user. */
export type CustomHintKey = 'chat' | 'grammar' | 'restructure';

interface LearnedData {
  version: 1;
  suggest: SuggestItem[];
  /** Shown/accepted counts of short and long suggestions (drives the suggestion length). */
  length: { shortShown: number; shortAccepted: number; longShown: number; longAccepted: number };
  /** Sentences the user wrote for the prompts; used together with the learned hint. */
  custom: Record<CustomHintKey, string>;
  chat: Tally & { upChars: number; downChars: number };
  rewrite: { grammar: RewriteTally; restructure: RewriteTally; instructions: InstructionItem[] };
  summary: Record<SummaryStyleName, Tally>;
}

/** One remembered ghost-text phrase as the manager lists it. */
export interface PhraseDetail {
  language: string;
  context: string;
  text: string;
  accepted: number;
  shown: number;
}

/** Everything the manager dialog lists and lets the user change. */
export interface LearningDetails {
  enabled: boolean;
  features: Record<LearnFeature, boolean>;
  phrases: PhraseDetail[];
  wishes: Array<{ text: string; count: number }>;
  custom: Record<CustomHintKey, string>;
  /** The sentence learned from feedback alone for each prompt ('' when nothing was learned yet). */
  learned: Record<CustomHintKey, string>;
}

/** What the "AI Learning" view shows: readable lines only, no stored text. */
export interface LearningInfo {
  enabled: boolean;
  lines: string[];
}

/** The learning service main talks to. */
export interface AiLearning {
  /** Applies one reported event (ignored when learning is off). */
  record(event: unknown): void;
  /** Remembers a suggestion just sent to the renderer so later `shown`/`accepted` events can name it by `reqId`. */
  remember(reqId: number, languageId: string, prefix: string, text: string): void;
  /** Notes the format of the summary that just started, so a later rating is credited to it. */
  noteSummaryStyle(style: SummaryStyleName): void;
  /** A remembered phrase that fits the end of `prefix`, or null. */
  recall(languageId: string, prefix: string): string | null;
  /** True when this model suggestion was offered repeatedly here and never accepted. */
  shouldSuppress(languageId: string, prefix: string, text: string): boolean;
  /** One short style sentence for chat answers (empty when nothing was learned). */
  chatHint(): string;
  /** One short style sentence for a grammar or restructure run (empty when nothing was learned). */
  rewriteHint(mode: 'grammar' | 'restructure'): string;
  /** The summary format the user rates best, or null. */
  preferredSummaryStyle(): SummaryStyleName | null;
  /** Restructure wishes the user typed before, most useful first. */
  instructions(): string[];
  info(): LearningInfo;
  details(): LearningDetails;
  /** Deletes one listed phrase or restructure wish (`text` guards against a list that changed meanwhile). */
  remove(kind: 'phrase' | 'wish', index: number, text: string): boolean;
  /** Sets (or with '' removes) the user's own sentence for a prompt. */
  setCustom(key: CustomHintKey, text: string): boolean;
  /** Forgets ratings and Apply/discard counts (the learned hints) but keeps phrases and restructure wishes. */
  resetHints(): void;
  /** Factor for the ghost-text length: shorter when long suggestions are mostly ignored, longer when they are taken. */
  suggestTokenScale(): number;
  /** Erases everything learned (memory and file). */
  clear(): Promise<void>;
  /** Writes pending changes now (called when the app quits). */
  flush(): Promise<void>;
}

/** Options of {@link createLearning}. */
export interface LearningOptions {
  userStore: SummaryCacheStore;
  /** Reads the validated settings; learning is active only while `ai.learning` and the feature's switch are true. */
  getSettings: () => Record<string, unknown>;
  log: ModelLog;
}

const FILE = 'ai-learning.json';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ITEMS = 300;
const CONTEXT_CHARS = 48;
const MIN_CONTEXT_CHARS = 12;
const MAX_TEXT_CHARS = 200;
const MAX_INSTRUCTIONS = 20;
const MAX_CUSTOM_CHARS = 150;
const DECAY_AT = 50;
const LENGTH_DECAY_AT = 400;
const MIN_LENGTH_VOTES = 10;
const SHORT_SUGGESTION_CHARS = 30;
const LENGTH_SCALES = { shorter: 0.6, longer: 1.3 } as const;
const MAX_INSTRUCTION_CHARS = 120;
const MAX_REMEMBERED = 16;
const SAVE_DELAY_MS = 3000;
const MIN_ACCEPTS_TO_RECALL = 2;
const MIN_SHOWN_TO_SUPPRESS = 3;
const MIN_VOTES = 5;
const NEGATIVE_SHARE = 0.6;
const LENGTH_RATIO = 1.4;
const LANGUAGE_ID = /^[A-Za-z0-9_.+-]{1,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const STYLES: readonly SummaryStyleName[] = ['both', 'paragraph', 'bullets'];
const LEARN_FEATURES = new Set<string>(['suggest', 'chat', 'rewrite', 'summary']);
const CUSTOM_KEYS: readonly CustomHintKey[] = ['chat', 'grammar', 'restructure'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

function emptyData(): LearnedData {
  return {
    version: 1,
    suggest: [],
    length: { shortShown: 0, shortAccepted: 0, longShown: 0, longAccepted: 0 },
    custom: { chat: '', grammar: '', restructure: '' },
    chat: { up: 0, down: 0, upChars: 0, downChars: 0 },
    rewrite: {
      grammar: { applied: 0, discarded: 0 },
      restructure: { applied: 0, discarded: 0 },
      instructions: [],
    },
    summary: { both: { up: 0, down: 0 }, paragraph: { up: 0, down: 0 }, bullets: { up: 0, down: 0 } },
  };
}

function cleanLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function readTally(raw: unknown): Tally {
  return isPlainObject(raw) ? { up: count(raw.up), down: count(raw.down) } : { up: 0, down: 0 };
}

function readRewriteTally(raw: unknown): RewriteTally {
  return isPlainObject(raw) ? { applied: count(raw.applied), discarded: count(raw.discarded) } : { applied: 0, discarded: 0 };
}

/** Rebuilds a stored object field by field, so a damaged or edited file can never inject unexpected values. */
function normalize(raw: unknown): LearnedData {
  const data = emptyData();
  if (!isPlainObject(raw)) {
    return data;
  }
  if (Array.isArray(raw.suggest)) {
    for (const item of raw.suggest.slice(0, MAX_ITEMS) as unknown[]) {
      if (
        isPlainObject(item) &&
        typeof item.l === 'string' &&
        LANGUAGE_ID.test(item.l) &&
        typeof item.c === 'string' &&
        item.c.length >= MIN_CONTEXT_CHARS &&
        item.c.length <= CONTEXT_CHARS &&
        typeof item.t === 'string' &&
        item.t.length > 0 &&
        item.t.length <= MAX_TEXT_CHARS
      ) {
        data.suggest.push({ l: item.l, c: item.c, t: item.t, s: count(item.s), a: count(item.a), u: count(item.u) });
      }
    }
  }
  if (isPlainObject(raw.length)) {
    data.length = {
      shortShown: count(raw.length.shortShown),
      shortAccepted: count(raw.length.shortAccepted),
      longShown: count(raw.length.longShown),
      longAccepted: count(raw.length.longAccepted),
    };
  }
  if (isPlainObject(raw.custom)) {
    for (const key of CUSTOM_KEYS) {
      data.custom[key] = cleanLine(raw.custom[key], MAX_CUSTOM_CHARS);
    }
  }
  if (isPlainObject(raw.chat)) {
    data.chat = { ...readTally(raw.chat), upChars: count(raw.chat.upChars), downChars: count(raw.chat.downChars) };
  }
  if (isPlainObject(raw.rewrite)) {
    data.rewrite.grammar = readRewriteTally(raw.rewrite.grammar);
    data.rewrite.restructure = readRewriteTally(raw.rewrite.restructure);
    if (Array.isArray(raw.rewrite.instructions)) {
      for (const item of raw.rewrite.instructions.slice(0, MAX_INSTRUCTIONS) as unknown[]) {
        const text = isPlainObject(item) ? cleanLine(item.t, MAX_INSTRUCTION_CHARS) : '';
        if (isPlainObject(item) && text !== '') {
          data.rewrite.instructions.push({ t: text, n: Math.max(1, count(item.n)), u: count(item.u) });
        }
      }
    }
  }
  if (isPlainObject(raw.summary)) {
    for (const style of STYLES) {
      data.summary[style] = readTally(raw.summary[style]);
    }
  }
  return data;
}

/** Share of negative votes, or null while there are too few votes to say anything. */
function negativeShare(negative: number, total: number): number | null {
  return total >= MIN_VOTES ? negative / total : null;
}

const average = (sum: number, votes: number): number => (votes > 0 ? sum / votes : 0);

/**
 * Creates the learning service and loads the stored data in the background.
 * @param options Store, settings and logger.
 * @returns The service; every method is safe to call before the data finished loading.
 */
export function createLearning({ userStore, getSettings, log }: LearningOptions): AiLearning {
  let data = emptyData();
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastSummaryStyle: SummaryStyleName = 'both';
  const remembered = new Map<number, { l: string; c: string; t: string }>();

  const enabled = (feature?: LearnFeature): boolean => {
    const settings = getSettings();
    return settings['ai.learning'] === true && (feature === undefined || settings[`ai.learning.${feature}`] !== false);
  };

  const loaded = userStore
    .readJson(FILE, { maxBytes: MAX_FILE_BYTES, signed: true })
    .then((stored) => {
      // A file that fails its signature or cannot be read is ignored: learning starts again from nothing.
      if (stored.integrity === 'ok' && !dirty) {
        data = normalize(stored.data);
      }
    })
    .catch(() => log.warn('The learned AI data could not be read.'));

  function save(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) {
      return writing;
    }
    dirty = false;
    const snapshot = data;
    writing = writing
      .then(() => loaded)
      .then(() => userStore.writeJson(FILE, snapshot, { maxBytes: MAX_FILE_BYTES, signed: true }))
      .then(() => undefined)
      .catch(() => log.warn('The learned AI data could not be saved.'));
    return writing;
  }

  function touch(): void {
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void save();
      }, SAVE_DELAY_MS);
      timer.unref();
    }
  }

  const contextOf = (prefix: string): string => prefix.slice(-CONTEXT_CHARS);
  const find = (l: string, c: string, t: string): SuggestItem | undefined =>
    data.suggest.find((item) => item.l === l && item.c === c && item.t === t);

  function upsert(l: string, c: string, t: string): SuggestItem {
    const known = find(l, c, t);
    if (known) {
      return known;
    }
    const item: SuggestItem = { l, c, t, s: 0, a: 0, u: Date.now() };
    data.suggest.push(item);
    if (data.suggest.length > MAX_ITEMS) {
      // Least valuable first: fewest acceptances, then the oldest.
      data.suggest.sort((x, y) => y.a - x.a || y.u - x.u);
      data.suggest.length = MAX_ITEMS;
    }
    return item;
  }

  function recordSuggest(event: Extract<LearnEvent, { kind: 'suggest' }>): void {
    const shown = remembered.get(event.reqId);
    if (!shown) {
      return;
    }
    const accepted = event.outcome === 'accepted';
    const text = accepted && typeof event.chars === 'number' && event.chars > 0 ? shown.t.slice(0, Math.min(event.chars, shown.t.length)) : shown.t;
    if (text.trim() === '') {
      return;
    }
    const isLong = shown.t.length > SHORT_SUGGESTION_CHARS;
    const stats = data.length;
    if (accepted) {
      stats[isLong ? 'longAccepted' : 'shortAccepted'] += 1;
    } else {
      stats[isLong ? 'longShown' : 'shortShown'] += 1;
    }
    if (stats.shortShown + stats.longShown > LENGTH_DECAY_AT) {
      stats.shortShown = Math.floor(stats.shortShown / 2);
      stats.shortAccepted = Math.floor(stats.shortAccepted / 2);
      stats.longShown = Math.floor(stats.longShown / 2);
      stats.longAccepted = Math.floor(stats.longAccepted / 2);
    }
    // A partly accepted suggestion is remembered as the part that was accepted.
    const item = upsert(shown.l, shown.c, accepted ? text : shown.t);
    if (accepted) {
      item.a += 1;
      if (item.s < item.a) {
        item.s = item.a;
      }
    } else {
      item.s += 1;
    }
    item.u = Date.now();
    touch();
  }

  function recordChat(event: Extract<LearnEvent, { kind: 'chat' }>): void {
    const chars = Math.min(count(event.answerChars), 100000);
    if (event.rating === 'up') {
      data.chat.up += 1;
      data.chat.upChars += chars;
    } else {
      data.chat.down += 1;
      data.chat.downChars += chars;
    }
    if (data.chat.up + data.chat.down > DECAY_AT) {
      // Old votes fade: halving keeps the ratio but lets new behavior change the hint within a few ratings.
      data.chat = {
        up: Math.floor(data.chat.up / 2),
        down: Math.floor(data.chat.down / 2),
        upChars: Math.floor(data.chat.upChars / 2),
        downChars: Math.floor(data.chat.downChars / 2),
      };
    }
  }

  function recordRewrite(event: Extract<LearnEvent, { kind: 'rewrite' }>): void {
    const tally = data.rewrite[event.mode];
    if (event.outcome === 'applied') {
      tally.applied += 1;
      const wish = event.mode === 'restructure' ? cleanLine(event.instruction, MAX_INSTRUCTION_CHARS) : '';
      if (wish !== '') {
        const known = data.rewrite.instructions.find((item) => item.t.toLowerCase() === wish.toLowerCase());
        if (known) {
          known.n += 1;
          known.u = Date.now();
        } else {
          data.rewrite.instructions.push({ t: wish, n: 1, u: Date.now() });
          data.rewrite.instructions.sort((x, y) => y.n - x.n || y.u - x.u);
          data.rewrite.instructions.length = Math.min(data.rewrite.instructions.length, MAX_INSTRUCTIONS);
        }
      }
    } else {
      tally.discarded += 1;
    }
    if (tally.applied + tally.discarded > DECAY_AT) {
      tally.applied = Math.floor(tally.applied / 2);
      tally.discarded = Math.floor(tally.discarded / 2);
    }
  }

  function record(raw: unknown): void {
    if (!enabled() || !isPlainObject(raw)) {
      return;
    }
    if (typeof raw.kind !== 'string' || !LEARN_FEATURES.has(raw.kind) || !enabled(raw.kind as LearnFeature)) {
      return;
    }
    if (raw.kind === 'suggest' && (raw.outcome === 'shown' || raw.outcome === 'accepted') && Number.isSafeInteger(raw.reqId)) {
      recordSuggest({ kind: 'suggest', outcome: raw.outcome, reqId: raw.reqId as number, chars: typeof raw.chars === 'number' ? raw.chars : undefined });
      return;
    }
    if (raw.kind === 'chat' && (raw.rating === 'up' || raw.rating === 'down')) {
      recordChat({ kind: 'chat', rating: raw.rating, answerChars: count(raw.answerChars) });
    } else if (
      raw.kind === 'rewrite' &&
      (raw.mode === 'grammar' || raw.mode === 'restructure') &&
      (raw.outcome === 'applied' || raw.outcome === 'discarded')
    ) {
      recordRewrite({ kind: 'rewrite', mode: raw.mode, outcome: raw.outcome, instruction: typeof raw.instruction === 'string' ? raw.instruction : undefined });
    } else if (raw.kind === 'summary' && (raw.rating === 'up' || raw.rating === 'down')) {
      const tally = data.summary[lastSummaryStyle];
      tally[raw.rating] += 1;
      if (tally.up + tally.down > DECAY_AT) {
        tally.up = Math.floor(tally.up / 2);
        tally.down = Math.floor(tally.down / 2);
      }
    } else {
      return;
    }
    touch();
  }

  function noteSummaryStyle(style: SummaryStyleName): void {
    lastSummaryStyle = style;
  }

  function remember(reqId: number, languageId: string, prefix: string, text: string): void {
    if (!enabled('suggest') || text === '' || text.length > MAX_TEXT_CHARS || !LANGUAGE_ID.test(languageId)) {
      return;
    }
    const context = contextOf(prefix);
    if (context.length < MIN_CONTEXT_CHARS) {
      return;
    }
    remembered.set(reqId, { l: languageId, c: context, t: text });
    if (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next();
      if (!oldest.done) {
        remembered.delete(oldest.value);
      }
    }
  }

  function recall(languageId: string, prefix: string): string | null {
    if (!enabled('suggest')) {
      return null;
    }
    const context = contextOf(prefix);
    let best: SuggestItem | null = null;
    for (const item of data.suggest) {
      if (
        item.l === languageId &&
        item.c === context &&
        item.a >= MIN_ACCEPTS_TO_RECALL &&
        item.a * 2 >= item.s &&
        (!best || item.a > best.a)
      ) {
        best = item;
      }
    }
    return best ? best.t : null;
  }

  function shouldSuppress(languageId: string, prefix: string, text: string): boolean {
    if (!enabled('suggest')) {
      return false;
    }
    const item = find(languageId, contextOf(prefix), text);
    return item !== undefined && item.a === 0 && item.s >= MIN_SHOWN_TO_SUPPRESS;
  }

  /** The sentence learned from chat ratings alone. */
  function learnedChat(): string {
    const { up, down, upChars, downChars } = data.chat;
    if (up < 2 || down < 2 || up + down < MIN_VOTES) {
      return '';
    }
    const liked = average(upChars, up);
    const disliked = average(downChars, down);
    if (disliked > liked * LENGTH_RATIO) {
      return 'The user prefers short answers: be brief.';
    }
    if (liked > disliked * LENGTH_RATIO) {
      return 'The user prefers fuller answers: explain a little more.';
    }
    return '';
  }

  /** The sentence learned from Apply/discard of one rewrite mode alone. */
  function learnedRewrite(mode: 'grammar' | 'restructure'): string {
    const tally = data.rewrite[mode];
    const share = negativeShare(tally.discarded, tally.applied + tally.discarded);
    if (share === null || share < NEGATIVE_SHARE) {
      return '';
    }
    return mode === 'grammar'
      ? 'The user often rejects corrections: change only clear mistakes and leave wording and style untouched.'
      : 'The user often rejects restructuring: keep the original order and wording, change the layout only where it clearly helps.';
  }

  /** The user's own sentence first, then the learned one. */
  const combine = (custom: string, learned: string): string => [custom, learned].filter((part) => part !== '').join(' ');

  function chatHint(): string {
    return enabled('chat') ? combine(data.custom.chat, learnedChat()) : '';
  }

  function rewriteHint(mode: 'grammar' | 'restructure'): string {
    return enabled('rewrite') ? combine(data.custom[mode], learnedRewrite(mode)) : '';
  }

  function preferredSummaryStyle(): SummaryStyleName | null {
    if (!enabled('summary')) {
      return null;
    }
    let best: SummaryStyleName | null = null;
    let bestScore = 1;
    for (const style of STYLES) {
      const score = data.summary[style].up - data.summary[style].down;
      if (score > bestScore) {
        best = style;
        bestScore = score;
      }
    }
    return best;
  }

  function instructions(): string[] {
    return enabled('rewrite') ? data.rewrite.instructions.slice(0, 5).map((item) => item.t) : [];
  }

  function info(): LearningInfo {
    const lines: string[] = [];
    const accepted = data.suggest.reduce((sum, item) => sum + item.a, 0);
    const shown = data.suggest.reduce((sum, item) => sum + item.s, 0);
    lines.push(`Ghost text: ${data.suggest.length} remembered suggestions, ${accepted} accepted of ${shown} shown.`);
    lines.push(`Chat answers rated: ${data.chat.up} helpful, ${data.chat.down} not helpful. Learned hint: ${learnedChat() || 'none yet'}`);
    const { grammar, restructure } = data.rewrite;
    lines.push(`Grammar check: ${grammar.applied} applied, ${grammar.discarded} discarded. Learned hint: ${learnedRewrite('grammar') || 'none yet'}`);
    lines.push(`Restructure: ${restructure.applied} applied, ${restructure.discarded} discarded. Learned hint: ${learnedRewrite('restructure') || 'none yet'}`);
    lines.push(`Restructure wishes remembered: ${data.rewrite.instructions.length}.`);
    const styles = STYLES.map((style) => `${style} ${data.summary[style].up}/${data.summary[style].down}`).join(', ');
    lines.push(`Summaries rated (helpful/not helpful): ${styles}. Preferred format: ${preferredSummaryStyle() ?? 'none yet'}`);
    return { enabled: enabled(), lines };
  }

  function featureStates(): Record<LearnFeature, boolean> {
    return { suggest: enabled('suggest'), chat: enabled('chat'), rewrite: enabled('rewrite'), summary: enabled('summary') };
  }

  const bestFirst = (x: SuggestItem, y: SuggestItem): number => y.a - x.a || y.u - x.u;

  function details(): LearningDetails {
    return {
      enabled: enabled(),
      features: featureStates(),
      phrases: data.suggest
        .slice()
        .sort(bestFirst)
        .map((item) => ({ language: item.l, context: item.c, text: item.t, accepted: item.a, shown: item.s })),
      wishes: data.rewrite.instructions.map((item) => ({ text: item.t, count: item.n })),
      custom: { ...data.custom },
      learned: { chat: learnedChat(), grammar: learnedRewrite('grammar'), restructure: learnedRewrite('restructure') },
    };
  }

  function remove(kind: 'phrase' | 'wish', index: number, text: string): boolean {
    if (kind === 'phrase') {
      const target = Number.isSafeInteger(index) ? data.suggest.slice().sort(bestFirst)[index] : undefined;
      if (!target || target.t !== text) {
        return false;
      }
      data.suggest = data.suggest.filter((item) => item !== target);
    } else {
      const target = Number.isSafeInteger(index) ? data.rewrite.instructions[index] : undefined;
      if (!target || target.t !== text) {
        return false;
      }
      data.rewrite.instructions = data.rewrite.instructions.filter((item) => item !== target);
    }
    touch();
    return true;
  }

  function setCustom(key: CustomHintKey, text: string): boolean {
    if (!CUSTOM_KEYS.includes(key) || typeof text !== 'string') {
      return false;
    }
    data.custom[key] = cleanLine(text, MAX_CUSTOM_CHARS);
    touch();
    return true;
  }

  function resetHints(): void {
    const fresh = emptyData();
    data.chat = fresh.chat;
    data.summary = fresh.summary;
    data.rewrite.grammar = fresh.rewrite.grammar;
    data.rewrite.restructure = fresh.rewrite.restructure;
    data.length = fresh.length;
    touch();
  }

  function suggestTokenScale(): number {
    if (!enabled('suggest')) {
      return 1;
    }
    const { shortShown, shortAccepted, longShown, longAccepted } = data.length;
    if (shortShown < MIN_LENGTH_VOTES || longShown < MIN_LENGTH_VOTES) {
      return 1;
    }
    const shortRate = shortAccepted / shortShown;
    const longRate = longAccepted / longShown;
    if (longRate < shortRate * 0.5) {
      return LENGTH_SCALES.shorter;
    }
    return longRate > shortRate * 1.2 ? LENGTH_SCALES.longer : 1;
  }

  async function clear(): Promise<void> {
    await loaded;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    data = emptyData();
    remembered.clear();
    await writing;
    await userStore.remove(FILE);
  }

  return { record, noteSummaryStyle, remember, recall, shouldSuppress, chatHint, rewriteHint, preferredSummaryStyle, instructions, info, details, remove, setCustom, resetHints, suggestTokenScale, clear, flush: save };
}
