/* Tests of shared/chunker.ts (token estimate, budget, chunk plan and merge). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const docModel: CodePadDocModelApi = require('../shared/docModel');
const chunker: CodePadChunkerApi = require('../shared/chunker');

/** Deterministic Markdown document with headings, paragraphs, lists and code. */
function generate(sections: number, seed: number): string {
  let state = seed;
  const random = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
  const sentence = (): string => {
    const count = 4 + Math.floor(random() * 12);
    const body = Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ');
    return `${body[0].toUpperCase()}${body.slice(1)}.`;
  };
  const parts: string[] = [];
  for (let section = 0; section < sections; section += 1) {
    parts.push(`${'#'.repeat(1 + (section % 3))} Section ${section}`);
    const blocks = 1 + Math.floor(random() * 4);
    for (let block = 0; block < blocks; block += 1) {
      const roll = random();
      if (roll < 0.15) {
        parts.push(['- one item', '- another item', '  continued'].join('\n'));
      } else if (roll < 0.25) {
        parts.push(['```', 'const x = 1;', '', 'call(x);', '```'].join('\n'));
      } else {
        parts.push(Array.from({ length: 1 + Math.floor(random() * 8) }, sentence).join(' '));
      }
    }
  }
  return `${parts.join(random() < 0.5 ? '\n\n' : '\n\n\n')}\n`;
}

function assertCoverage(doc: CodePadDocument, chunks: CodePadChunk[], chunkTokens: number): void {
  assert.equal(chunks.map((chunk) => chunk.text).join(''), doc.text);
  let offset = 0;
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.index, index);
    assert.equal(chunk.start, offset);
    assert.equal(doc.text.slice(chunk.start, chunk.end), chunk.text);
    assert.ok(chunk.text.length > 0);
    assert.ok(chunker.estimateTokens(chunk.text) <= chunkTokens, `chunk ${index} has ${chunker.estimateTokens(chunk.text)} tokens`);
    offset = chunk.end;
  });
  assert.equal(offset, doc.text.length);
}

test('estimateTokens: about 4 Latin characters per token, more for other scripts', () => {
  assert.equal(chunker.estimateTokens(''), 0);
  assert.equal(chunker.estimateTokens('abcd'), 1);
  assert.equal(chunker.estimateTokens('abcde'), 2);
  assert.equal(chunker.estimateTokens('é'), 1);
  assert.equal(chunker.estimateTokens('ありがとう'), 4);
  assert.ok(chunker.estimateTokens('日本語の文章です') > chunker.estimateTokens('abcdefgh'));
});

test('budget math', () => {
  assert.deepEqual(chunker.budget({ contextTokens: 8192, maxOutputTokens: 1024 }), { chunkTokens: 819, inputTokens: 6912, outputTokens: 1024 });
  assert.deepEqual(chunker.budget({ contextTokens: 2048, maxOutputTokens: 512, reserveTokens: 100, contextShare: 0.5 }), { chunkTokens: 409, inputTokens: 1436, outputTokens: 512 });
  // Large output: the input share decides (100000 - 4000 - 256 = 95744; 95744 * 0.65 = 62233.6 > 3200).
  assert.equal(chunker.budget({ contextTokens: 100000, maxOutputTokens: 4000 }).chunkTokens, 3200);
  assert.equal(chunker.budget({ contextTokens: 4096, maxOutputTokens: 100000 }).chunkTokens, 150);
  assert.deepEqual(chunker.budget({ contextTokens: 1000, maxOutputTokens: 900 }), { chunkTokens: 150, inputTokens: 0, outputTokens: 900 });
});

test('coverage: chunks joined are exactly the document (small, medium, large)', () => {
  for (const [sections, seed] of [[1, 1], [3, 2], [12, 3], [40, 4], [250, 5]]) {
    const doc = docModel.parse(generate(sections, seed), 'markdown');
    for (const chunkTokens of [150, 400, 2000]) {
      assertCoverage(doc, chunker.plan(doc, { chunkTokens }), chunkTokens);
    }
  }
});

test('coverage with leading blank lines, white space only and empty text', () => {
  const leading = docModel.parse('\n\n\nHello there.\n\n\n', 'plaintext');
  assertCoverage(leading, chunker.plan(leading, { chunkTokens: 150 }), 150);
  const blank = docModel.parse('\n \n', 'plaintext');
  const blankChunks = chunker.plan(blank, { chunkTokens: 150 });
  assert.equal(blankChunks.length, 1);
  assert.equal(blankChunks[0].text, '\n \n');
  assert.deepEqual(chunker.plan(docModel.parse('', 'plaintext'), { chunkTokens: 150 }), []);
});

test('a heading starts a new chunk once the chunk is half full', () => {
  const big = `${'alpha '.repeat(146).trim()}.`;
  const small = `${'beta '.repeat(40).trim()}.`;
  const doc = docModel.parse(`# A\n\n${big}\n\n# B\n\n${small}\n`, 'markdown');
  const chunks = chunker.plan(doc, { chunkTokens: 400 });
  assert.ok(chunker.estimateTokens(doc.text) < 400, 'the document would fit in one chunk');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].text.startsWith('# B'));
  assert.deepEqual(chunks[0].sectionPath, ['A']);
  assert.deepEqual(chunks[1].sectionPath, ['B']);
  assert.deepEqual(chunks[1].blockIds, doc.blocks.slice(2).map((block) => block.id));
  // Below half of the budget the heading stays in the same chunk.
  assert.equal(chunker.plan(doc, { chunkTokens: 1000 }).length, 1);
});

test('a heading is not left alone at the end of a chunk', () => {
  const para = (word: string): string => `${`${word} `.repeat(100).trim()}.`;
  const doc = docModel.parse(`${para('one')}\n\n## Next\n\n${para('two')}`, 'markdown');
  const chunks = chunker.plan(doc, { chunkTokens: 160 });
  assertCoverage(doc, chunks, 160);
  assert.ok(chunks.every((chunk) => !/^## Next\s*$/m.test(chunk.text.trim().split('\n').slice(-1)[0])));
  assert.ok(chunks.some((chunk) => chunk.text.startsWith('## Next')));
});

test('an oversize paragraph is split at sentence ends', () => {
  const text = Array.from({ length: 60 }, (_, index) => `Sentence number ${index} is here.`).join(' ');
  const doc = docModel.parse(text, 'plaintext');
  const chunks = chunker.plan(doc, { chunkTokens: 150 });
  assert.ok(chunks.length >= 3);
  assertCoverage(doc, chunks, 150);
  for (const chunk of chunks) {
    assert.ok(chunk.text.trimEnd().endsWith('here.'));
    assert.deepEqual(chunk.blockIds, [doc.blocks[0].id]);
  }
});

test('a sentence longer than the budget is split at line breaks, then hard', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line without a stop number ${index}`).join('\n');
  const byLines = docModel.parse(lines, 'plaintext');
  const lineChunks = chunker.plan(byLines, { chunkTokens: 150 });
  assertCoverage(byLines, lineChunks, 150);
  lineChunks.slice(0, -1).forEach((chunk) => assert.ok(chunk.text.endsWith('\n')));

  const word = docModel.parse('x'.repeat(2000), 'plaintext');
  const hard = chunker.plan(word, { chunkTokens: 150 });
  assert.ok(hard.length >= 4);
  assertCoverage(word, hard, 150);

  const wide = docModel.parse('語'.repeat(500), 'plaintext');
  assertCoverage(wide, chunker.plan(wide, { chunkTokens: 150 }), 150);
});

test('chunks are in document order with context before and after', () => {
  const doc = docModel.parse(generate(30, 9), 'markdown');
  const chunks = chunker.plan(doc, { chunkTokens: 150, overlapChars: 50 });
  assert.ok(chunks.length > 3);
  assert.equal(chunks[0].before, '');
  assert.equal(chunks[chunks.length - 1].after, '');
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    assert.ok(chunk.start > chunks[index - 1].start);
    assert.ok(chunk.before.length <= 50);
    assert.ok(doc.text.slice(0, chunk.start).endsWith(chunk.before));
    const cut = chunk.start - chunk.before.length;
    // The context never starts inside a word.
    assert.ok(cut === 0 || chunk.before === '' || /\s/.test(doc.text[cut - 1]) || /^\s/.test(chunk.before));
  }
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.after.length <= 50);
    assert.ok(doc.text.slice(chunk.end).startsWith(chunk.after));
    const cut = chunk.end + chunk.after.length;
    assert.ok(cut === doc.text.length || chunk.after === '' || /\s/.test(doc.text[cut]) || /\s$/.test(chunk.after));
  }
});

test('sectionPath lists the enclosing sections, outermost first', () => {
  const doc = docModel.parse(`# Top\n\n## Middle\n\n${'word '.repeat(300).trim()}.\n\n### Deep\n\nEnd.`, 'markdown');
  const chunks = chunker.plan(doc, { chunkTokens: 150 });
  assert.deepEqual(chunks[0].sectionPath, ['Top']);
  assert.ok(chunks.some((chunk) => chunk.sectionPath.join('/') === 'Top/Middle'));
  assert.deepEqual(chunks[chunks.length - 1].sectionPath.slice(0, 2), ['Top', 'Middle']);
});

test('merge keeps the trailing white space of each chunk', () => {
  const doc = docModel.parse(generate(20, 11), 'markdown');
  const chunks = chunker.plan(doc, { chunkTokens: 150 });
  assert.equal(chunker.merge(chunks, chunks.map((chunk) => chunk.text)), doc.text);
  assert.equal(chunker.merge(chunks, chunks.map((chunk) => `${chunk.text.toUpperCase().trimEnd()}\n\n\n\n`)), doc.text.toUpperCase());
  assert.throws(() => chunker.merge(chunks, []), /Expected/);
});
