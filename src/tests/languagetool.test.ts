/* Tests of providers/languagetool.ts: the answer parsing (pure) and the length guard; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GRAMMAR_CHARS, checkGrammar, parseMatches } from '../providers/languagetool';
import { ProviderError } from '../providers/http';

const codeIs =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof ProviderError && error.code === code;

test('parseMatches reads grammar findings', () => {
  const matches = parseMatches(
    {
      matches: [
        {
          offset: 0,
          length: 4,
          message: '  Possible\n  agreement   error. ',
          rule: { id: 'AGREEMENT', issueType: 'grammar' },
          replacements: [{ value: 'This' }, { value: '' }, { value: 'These' }, { other: 1 }, { value: 'A' }, { value: 'B' }, { value: 'C' }, { value: 'D' }],
        },
      ],
    },
    20,
  );
  assert.deepEqual(matches, [{ offset: 0, length: 4, message: 'Possible agreement error.', ruleId: 'AGREEMENT', replacements: ['This', 'These', 'A', 'B', 'C'] }]);
});

test('parseMatches drops spelling, out-of-range and malformed findings', () => {
  const matches = parseMatches(
    {
      matches: [
        { offset: 0, length: 3, message: 'Spelling', rule: { id: 'MORFOLOGIK', issueType: 'misspelling' } },
        { offset: 8, length: 5, message: 'Past the end' },
        { offset: 2, length: 0, message: 'Empty' },
        { offset: -1, length: 2, message: 'Negative' },
        { offset: 1.5, length: 2, message: 'Fraction' },
        { offset: 1, length: 2 },
        'not an object',
        { offset: 1, length: 2, message: 'Kept' },
      ],
    },
    10,
  );
  assert.deepEqual(matches, [{ offset: 1, length: 2, message: 'Kept', ruleId: '', replacements: [] }]);
});

test('parseMatches caps the number of findings', () => {
  const many = Array.from({ length: 600 }, (_, index) => ({ offset: index, length: 1, message: 'm' }));
  assert.equal(parseMatches({ matches: many }, 1000).length, 500);
});

test('parseMatches rejects an unexpected answer', () => {
  assert.throws(() => parseMatches(null, 10), codeIs('E_BAD_RESPONSE'));
  assert.throws(() => parseMatches({ matches: 'no' }, 10), codeIs('E_BAD_RESPONSE'));
  assert.throws(() => parseMatches([], 10), codeIs('E_BAD_RESPONSE'));
});

test('checkGrammar refuses a text over the free limit before any request', async () => {
  await assert.rejects(checkGrammar('x'.repeat(MAX_GRAMMAR_CHARS + 1)), codeIs('E_PROMPT_TOO_LONG'));
});
