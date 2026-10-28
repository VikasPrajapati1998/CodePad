// Offline spell checking (main process), our own implementation: no AI and no spelling library.
// The dictionary is dictionaries/en.txt, a plain list of expanded lower-case American-English word forms
// (SCOWL, see NOTICE), ordered from the most to the least common. It is loaded lazily on the first check.
// Suggestions are ranked by Damerau-Levenshtein distance (insertions, deletions, substitutions and adjacent
// transpositions), a first-letter match and word commonness. Personal words live in userData/spell-words.json.
import fs from 'fs/promises';
import path from 'path';
import { errorMessage } from './errorUtils';
import * as userStore from './userStore';

const WORDS_FILE = 'spell-words.json';
const WORDS_MAX_BYTES = 512 * 1024;
const MAX_PERSONAL_WORDS = 5000;
const MAX_CHECK_WORDS = 2000;
const MAX_WORD_LENGTH = 64;
const MAX_SUGGESTIONS = 5;
/** Suggestions cost a scan of the word list; a request gets them for this many misspellings, the rest on demand. */
const MAX_SUGGEST_PER_CHECK = 40;
const MAX_EDIT_DISTANCE = 2;
const WORD_PATTERN = /^\p{L}[\p{L}\p{M}'-]*$/u;
const CONTRACTION_SUFFIXES = new Set(['s', 're', 've', 'll', 'd', 'm', 't']);
const IRREGULAR_NT = new Set(['can', 'won', 'shan', 'ain']);

/** The word list: lookup set plus the words grouped by length (in commonness order) for suggestions. */
interface Dictionary {
  known: Set<string>;
  byLength: Map<number, string[]>;
  rank: Map<string, number>;
}

let dictionary: Dictionary | null = null;
let loading: Promise<Dictionary> | null = null;
let personalWords: string[] = [];
let personalLower = new Set<string>();

/** Normalizes a typographic apostrophe; returns null for anything that is not a plain word. */
function cleanWord(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const word = value.replace(/’/g, "'");
  return word.length > 0 && word.length <= MAX_WORD_LENGTH && WORD_PATTERN.test(word) ? word : null;
}

function parseDictionary(text: string): Dictionary {
  const known = new Set<string>();
  const byLength = new Map<number, string[]>();
  const rank = new Map<string, number>();
  for (const line of text.split('\n')) {
    const word = line.trim();
    if (word && !known.has(word)) {
      rank.set(word, known.size);
      known.add(word);
      const group = byLength.get(word.length);
      if (group) {
        group.push(word);
      } else {
        byLength.set(word.length, [word]);
      }
    }
  }
  return { known, byLength, rank };
}

async function loadPersonalWords(): Promise<string[]> {
  const { data } = await userStore.readJson(WORDS_FILE, { maxBytes: WORDS_MAX_BYTES });
  const raw = data && Array.isArray(data.words) ? (data.words as unknown[]) : [];
  const words: string[] = [];
  for (const item of raw.slice(0, MAX_PERSONAL_WORDS)) {
    const word = cleanWord(item);
    if (word && !words.includes(word)) {
      words.push(word);
    }
  }
  return words;
}

/** The loaded dictionary; a failed load is not cached, so the next call retries. */
function getDictionary(): Promise<Dictionary> {
  if (dictionary) {
    return Promise.resolve(dictionary);
  }
  if (!loading) {
    loading = Promise.all([fs.readFile(path.join(__dirname, 'dictionaries', 'en.txt'), 'utf8'), loadPersonalWords()]).then(
      ([text, words]) => {
        personalWords = words;
        personalLower = new Set(words.map((word) => word.toLowerCase()));
        dictionary = parseDictionary(text);
        return dictionary;
      },
      (error: unknown) => {
        loading = null;
        throw new Error(`The spelling dictionary could not be loaded: ${errorMessage(error)}`, { cause: error });
      },
    );
  }
  return loading;
}

// ---------- Lookup ----------

/** Contractions and possessives: "don't", "we're", "dog's". */
function isKnownContraction(lower: string, known: Set<string>): boolean {
  const cut = lower.lastIndexOf("'");
  if (cut <= 0) {
    return false;
  }
  const base = lower.slice(0, cut);
  const suffix = lower.slice(cut + 1);
  if (lower.indexOf("'") !== cut || !CONTRACTION_SUFFIXES.has(suffix)) {
    return false;
  }
  if (suffix === 't') {
    return IRREGULAR_NT.has(base) || (base.endsWith('n') && known.has(base.slice(0, -1)));
  }
  return known.has(base);
}

function isKnownWord(word: string, dict: Dictionary): boolean {
  const lower = word.toLowerCase();
  if (dict.known.has(lower) || personalLower.has(lower)) {
    return true;
  }
  if (lower.includes("'")) {
    return isKnownContraction(lower, dict.known);
  }
  if (lower.includes('-')) {
    return lower.split('-').every((part) => part === '' || dict.known.has(part) || personalLower.has(part));
  }
  return false;
}

// ---------- Suggestions ----------

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions); `limit + 1` when above limit. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  const width = b.length + 1;
  let twoBack = new Array<number>(width).fill(0);
  let previous = Array.from({ length: width }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(width).fill(0);
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2] + 1);
      }
      row[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) {
      return limit + 1;
    }
    twoBack = previous;
    previous = row;
  }
  return Math.min(previous[b.length], limit + 1);
}

/** Lower score is better: distance dominates, then a matching first letter, then how common the word is. */
function scoreCandidate(typed: string, candidate: string, distance: number, rank: number): number {
  let score = distance * 100000;
  if (typed[0] !== candidate[0]) {
    score += 30000;
  }
  if (typed.length === candidate.length && [...typed].sort().join('') === [...candidate].sort().join('')) {
    score -= 20000;
  }
  return score + rank;
}

/** Gives the suggestion the capitalization pattern of the typed word. */
function matchCase(typed: string, suggestion: string): string {
  if (typed.length > 1 && typed === typed.toUpperCase()) {
    return suggestion.toUpperCase();
  }
  if (typed[0] !== typed[0].toLowerCase()) {
    return suggestion[0].toUpperCase() + suggestion.slice(1);
  }
  return suggestion;
}

function suggest(word: string, dict: Dictionary): string[] {
  const typed = word.toLowerCase();
  const limit = typed.length <= 3 ? 1 : MAX_EDIT_DISTANCE;
  const scored: Array<{ word: string; score: number }> = [];
  for (let length = typed.length - limit; length <= typed.length + limit; length++) {
    for (const candidate of dict.byLength.get(length) ?? []) {
      const distance = editDistance(typed, candidate, limit);
      // Distance 2 is noisy: only accept it when the first or last letter agrees.
      if (distance > limit || (distance === 2 && typed[0] !== candidate[0] && typed.at(-1) !== candidate.at(-1))) {
        continue;
      }
      scored.push({ word: candidate, score: scoreCandidate(typed, candidate, distance, dict.rank.get(candidate) ?? 0) });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  const results = scored.slice(0, MAX_SUGGESTIONS).map((item) => item.word);
  // A missing apostrophe is the most common typo of all: "dont" -> "don't".
  const withApostrophe = `${typed.slice(0, -1)}'${typed.slice(-1)}`;
  if (typed.endsWith('nt') && isKnownContraction(withApostrophe, dict.known)) {
    results.unshift(withApostrophe);
  }
  return results.slice(0, MAX_SUGGESTIONS).map((item) => matchCase(word, item));
}

// ---------- Public API ----------

/** Checks the words and returns the misspelled ones; entries that are not plain words are ignored. */
async function check(words: unknown): Promise<CpSpellCheckResult> {
  if (!Array.isArray(words) || words.length > MAX_CHECK_WORDS) {
    throw new Error('Invalid spell check request.');
  }
  const dict = await getDictionary();
  const misspelled: CpSpellMisspelling[] = [];
  const seen = new Set<string>();
  let suggested = 0;
  for (const item of words as unknown[]) {
    const word = cleanWord(item);
    if (word === null || seen.has(word) || isKnownWord(word, dict)) {
      continue;
    }
    seen.add(word);
    let suggestions: string[] = [];
    if (suggested < MAX_SUGGEST_PER_CHECK) {
      suggested += 1;
      suggestions = suggest(word, dict);
    }
    misspelled.push({ word: item as string, suggestions });
  }
  return { misspelled };
}

/** Adds a word to the personal dictionary (stored in userData, capped). */
async function addWord(value: unknown): Promise<{ ok: boolean }> {
  const word = cleanWord(value);
  if (word === null) {
    return { ok: false };
  }
  await getDictionary();
  if (!personalWords.includes(word)) {
    if (personalWords.length >= MAX_PERSONAL_WORDS) {
      return { ok: false };
    }
    const next = [...personalWords, word];
    await userStore.writeJson(WORDS_FILE, { version: 1, words: next }, { maxBytes: WORDS_MAX_BYTES });
    personalWords = next;
    personalLower.add(word.toLowerCase());
  }
  return { ok: true };
}

export { check, addWord };
