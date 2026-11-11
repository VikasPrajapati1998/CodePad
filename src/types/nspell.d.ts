/** The small part of nspell (Hunspell-compatible spell checker, no bundled types) that spellcheck.ts uses. */
declare module 'nspell' {
  interface NSpell {
    /** True when the word is spelled correctly (case rules of the dictionary apply). */
    correct(word: string): boolean;
    /** Replacement suggestions, best first. */
    suggest(word: string): string[];
    /** Accepts a word for this session. */
    add(word: string): NSpell;
  }

  function nspell(dictionary: { aff: Buffer; dic: Buffer }): NSpell;
  export = nspell;
}
