// Offline spell checking (main process) with nspell and the Hunspell en_US dictionary of the dictionary-en package:
// no AI and no network. The dictionary is loaded lazily on the first check from the package folder (read with fs, since
// dictionary-en is an ES module and this process is CommonJS). Personal words live in userData/spell-words.json.
import fs from 'fs/promises';
import path from 'path';
import nspell from 'nspell';
import { errorMessage } from './errorUtils';
import * as userStore from './userStore';

type Speller = ReturnType<typeof nspell>;

const WORDS_FILE = 'spell-words.json';
const WORDS_MAX_BYTES = 512 * 1024;
const MAX_PERSONAL_WORDS = 5000;
const MAX_CHECK_WORDS = 2000;
const MAX_WORD_LENGTH = 64;
const MAX_SUGGESTIONS = 5;
/** Suggestions are slower than lookups; a request gets them for this many misspellings, the rest on demand. */
const MAX_SUGGEST_PER_CHECK = 40;
const WORD_PATTERN = /^\p{L}[\p{L}\p{M}'-]*$/u;

let speller: Speller | null = null;
let loading: Promise<Speller> | null = null;
let personalWords: string[] = [];

/** Normalizes a typographic apostrophe; returns null for anything that is not a plain word. */
function cleanWord(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const word = value.replace(/’/g, "'");
  return word.length > 0 && word.length <= MAX_WORD_LENGTH && WORD_PATTERN.test(word) ? word : null;
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

/** The loaded speller; a failed load is not cached, so the next call retries. */
function getSpeller(): Promise<Speller> {
  if (speller) {
    return Promise.resolve(speller);
  }
  if (!loading) {
    const folder = path.dirname(require.resolve('dictionary-en'));
    loading = Promise.all([fs.readFile(path.join(folder, 'index.aff')), fs.readFile(path.join(folder, 'index.dic')), loadPersonalWords()]).then(
      ([aff, dic, words]) => {
        const loaded = nspell({ aff, dic });
        words.forEach((word) => loaded.add(word));
        personalWords = words;
        speller = loaded;
        return loaded;
      },
      (error: unknown) => {
        loading = null;
        throw new Error(`The spelling dictionary could not be loaded: ${errorMessage(error)}`, { cause: error });
      },
    );
  }
  return loading;
}

/** Hunspell has no hyphen rule: a hyphenated word is right when every part is. */
function isCorrect(word: string, checker: Speller): boolean {
  if (checker.correct(word)) {
    return true;
  }
  return word.includes('-') && word.split('-').every((part) => part === '' || checker.correct(part));
}

// ---------- Public API ----------

/** Checks the words and returns the misspelled ones; entries that are not plain words are ignored. */
async function check(words: unknown): Promise<CpSpellCheckResult> {
  if (!Array.isArray(words) || words.length > MAX_CHECK_WORDS) {
    throw new Error('Invalid spell check request.');
  }
  const checker = await getSpeller();
  const misspelled: CpSpellMisspelling[] = [];
  const seen = new Set<string>();
  let suggested = 0;
  for (const item of words as unknown[]) {
    const word = cleanWord(item);
    if (word === null || seen.has(word) || isCorrect(word, checker)) {
      continue;
    }
    seen.add(word);
    let suggestions: string[] = [];
    if (suggested < MAX_SUGGEST_PER_CHECK) {
      suggested += 1;
      suggestions = checker.suggest(word).slice(0, MAX_SUGGESTIONS);
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
  const checker = await getSpeller();
  if (!personalWords.includes(word)) {
    if (personalWords.length >= MAX_PERSONAL_WORDS) {
      return { ok: false };
    }
    const next = [...personalWords, word];
    await userStore.writeJson(WORDS_FILE, { version: 1, words: next }, { maxBytes: WORDS_MAX_BYTES });
    personalWords = next;
    checker.add(word);
  }
  return { ok: true };
}

export { check, addWord };
