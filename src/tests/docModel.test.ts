/* Tests of shared/docModel.ts (blocks, ids, sections, references in words, outline). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const docModel: CodePadDocModelApi = require('../shared/docModel');

const MD = [
  '# Guide',
  '',
  'Intro paragraph one.',
  'continues here.',
  '',
  '## Pricing',
  '',
  'Prices are low.',
  '',
  '- item one',
  '- item two',
  '  continued',
  '',
  '```js',
  '# not a heading',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '',
  '> quoted',
  '',
  '---',
  '',
  'Setext Title',
  '============',
  '',
  '### Details',
  '',
  'Last words.',
].join('\n');

const kinds = (doc: CodePadDocument): string[] => doc.blocks.map((block) => block.kind);

test('hash is FNV-1a 32-bit as 8 hex digits', () => {
  assert.equal(docModel.hash(''), '811c9dc5');
  assert.equal(docModel.hash('a'), 'e40c292c');
  assert.match(docModel.hash('any text'), /^[0-9a-f]{8}$/);
});

test('markdown blocks: headings, paragraphs, lists, code, tables, quotes, rules, setext', () => {
  const doc = docModel.parse(MD, 'markdown');
  assert.equal(doc.markdown, true);
  assert.deepEqual(kinds(doc), ['heading', 'paragraph', 'heading', 'paragraph', 'list', 'code', 'table', 'quote', 'rule', 'heading', 'heading', 'paragraph']);
  assert.deepEqual(doc.blocks.map((block) => block.level), [1, 0, 2, 0, 0, 0, 0, 0, 0, 1, 3, 0]);
  const intro = doc.blocks[1];
  assert.equal(intro.text, 'Intro paragraph one.\ncontinues here.');
  assert.equal(intro.startLine, 3);
  assert.equal(intro.endLine, 4);
  assert.equal(doc.text.slice(intro.start, intro.end), intro.text);
  assert.equal(doc.blocks[4].text, '- item one\n- item two\n  continued');
  assert.equal(doc.blocks[5].text, '```js\n# not a heading\n```');
  assert.equal(doc.blocks[9].text, 'Setext Title\n============');
  doc.blocks.forEach((block, index) => {
    assert.equal(block.index, index);
    assert.equal(doc.text.slice(block.start, block.end), block.text);
  });
});

test('markdown: tilde fences, loose lists, ordered lists, lazy quote lines', () => {
  const doc = docModel.parse('~~~\n## x\n\n~~~\n\n1. one\n\n2) two\n   more\n\n> a\nlazy\n\nend', 'markdown');
  assert.deepEqual(kinds(doc), ['code', 'list', 'quote', 'paragraph']);
  assert.equal(doc.blocks[1].text, '1. one\n\n2) two\n   more');
  assert.equal(doc.blocks[2].text, '> a\nlazy');
});

test('markdown: an unclosed fence runs to the end without trailing blank lines', () => {
  const doc = docModel.parse('```\ncode\n\n', 'markdown');
  assert.deepEqual(kinds(doc), ['code']);
  assert.equal(doc.blocks[0].text, '```\ncode');
});

test('CR LF is read as LF', () => {
  const doc = docModel.parse('One.\r\n\r\nTwo.', 'plaintext');
  assert.equal(doc.text, 'One.\n\nTwo.');
  assert.equal(doc.blocks.length, 2);
});

test('plain text: paragraphs and lists separated by blank lines, no Markdown headings', () => {
  const doc = docModel.parse('Hello world.\nSecond line.\n\n- a\n- b\n\n- a\nnot item\n\n# Not a heading', 'plaintext');
  assert.equal(doc.markdown, false);
  assert.deepEqual(kinds(doc), ['paragraph', 'list', 'paragraph', 'paragraph']);
  assert.equal(doc.sections.length, 0);
  assert.equal(docModel.outline(doc), '');
});

test('block ids: format, occurrence counter and stability across an edit elsewhere', () => {
  const twins = docModel.parse('Same.\n\nSame.\n\nOther.', 'plaintext');
  assert.match(twins.blocks[0].id, /^b[0-9a-f]{8}-0$/);
  assert.equal(twins.blocks[1].id, twins.blocks[0].id.replace(/-0$/, '-1'));
  assert.notEqual(twins.blocks[2].id.slice(0, 9), twins.blocks[0].id.slice(0, 9));

  const before = docModel.parse(MD, 'markdown');
  const after = docModel.parse(MD.replace('Prices are low.', 'Prices are very low.'), 'markdown');
  assert.notEqual(before.version, after.version);
  before.blocks.forEach((block, index) => {
    if (index === 3) {
      assert.notEqual(after.blocks[index].id, block.id);
    } else {
      assert.equal(after.blocks[index].id, block.id);
    }
  });
  // White space changes inside a block do not change its id.
  const spaced = docModel.parse(MD.replace('Prices are low.', 'Prices   are low.'), 'markdown');
  assert.equal(spaced.blocks[3].id, before.blocks[3].id);
});

test('sections and sectionId', () => {
  const doc = docModel.parse(MD, 'markdown');
  const [guide, , pricing] = doc.blocks;
  const setext = doc.blocks[9];
  const details = doc.blocks[10];
  assert.equal(doc.blocks[1].sectionId, guide.id);
  assert.equal(pricing.sectionId, guide.id);
  assert.equal(doc.blocks[3].sectionId, pricing.id);
  assert.equal(setext.sectionId, null);
  assert.equal(details.sectionId, setext.id);
  assert.equal(doc.blocks[11].sectionId, details.id);
  assert.equal(guide.sectionId, null);

  assert.deepEqual(doc.sections.map((section) => section.title), ['Guide', 'Pricing', 'Setext Title', 'Details']);
  assert.deepEqual(doc.sections.map((section) => section.parentId), [null, guide.id, null, setext.id]);
  assert.deepEqual(doc.sections[0].blockIds, doc.blocks.slice(0, 9).map((block) => block.id));
  assert.deepEqual(doc.sections[1].blockIds, doc.blocks.slice(2, 9).map((block) => block.id));
  assert.deepEqual(doc.sections[2].blockIds, doc.blocks.slice(9).map((block) => block.id));
  assert.deepEqual(doc.sections[3].blockIds, doc.blocks.slice(10).map((block) => block.id));
});

test('ATX titles lose closing hashes', () => {
  const doc = docModel.parse('## Title ##\n\n#hashtag is text', 'markdown');
  assert.equal(doc.sections[0].title, 'Title');
  assert.deepEqual(kinds(doc), ['heading', 'paragraph']);
});

test('outline is a nested bullet list', () => {
  const doc = docModel.parse(MD, 'markdown');
  assert.equal(docModel.outline(doc), '- Guide\n  - Pricing\n- Setext Title\n    - Details');
  assert.equal(docModel.outline(docModel.parse('## A\n\n### B\n\n## C', 'markdown')), '- A\n  - B\n- C');
});

test('blockAt: inside, at the end of a line, between blocks, before the first block', () => {
  const doc = docModel.parse('\n\nOne.\n\nTwo.', 'plaintext');
  assert.equal(docModel.blockAt(doc, 0), null);
  assert.equal(docModel.blockAt(doc, 3)?.text, 'One.');
  assert.equal(docModel.blockAt(doc, 6)?.text, 'One.');
  assert.equal(docModel.blockAt(doc, 7)?.text, 'One.');
  assert.equal(docModel.blockAt(doc, 8)?.text, 'Two.');
  assert.equal(docModel.blockAt(doc, 100)?.text, 'Two.');
});

test('parseRef: paragraphs by ordinal, number and position', () => {
  assert.deepEqual(docModel.parseRef('rewrite the second paragraph'), { kind: 'paragraph', index: 2 });
  assert.deepEqual(docModel.parseRef('shorten paragraph 3 please'), { kind: 'paragraph', index: 3 });
  assert.deepEqual(docModel.parseRef('fix the 3rd paragraph'), { kind: 'paragraph', index: 3 });
  assert.deepEqual(docModel.parseRef('the first paragraph'), { kind: 'paragraph', index: 1 });
  assert.deepEqual(docModel.parseRef('the tenth paragraph'), { kind: 'paragraph', index: 10 });
  assert.deepEqual(docModel.parseRef('the last paragraph'), { kind: 'paragraph', index: -1 });
  assert.deepEqual(docModel.parseRef('The Final Paragraph'), { kind: 'paragraph', index: -1 });
  assert.deepEqual(docModel.parseRef('the second to last paragraph'), { kind: 'paragraph', index: -2 });
});

test('parseRef: relative to the cursor', () => {
  assert.deepEqual(docModel.parseRef('improve the previous paragraph'), { kind: 'previous' });
  assert.deepEqual(docModel.parseRef('merge the paragraph above'), { kind: 'previous' });
  assert.deepEqual(docModel.parseRef('the next paragraph'), { kind: 'next' });
  assert.deepEqual(docModel.parseRef('the paragraph below'), { kind: 'next' });
  assert.deepEqual(docModel.parseRef('translate this paragraph'), { kind: 'current' });
  assert.deepEqual(docModel.parseRef('the current paragraph'), { kind: 'current' });
});

test('parseRef: headings and sections by title', () => {
  assert.deepEqual(docModel.parseRef('rename the heading Pricing'), { kind: 'heading', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('change heading "Pricing Plans" to Costs'), { kind: 'heading', title: 'Pricing Plans' });
  assert.deepEqual(docModel.parseRef('bold the "Pricing" heading'), { kind: 'heading', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('rewrite the section Pricing'), { kind: 'section', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('add a line under Pricing'), { kind: 'section', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('add a sentence under the heading Pricing'), { kind: 'section', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('add an example in the Pricing section'), { kind: 'section', title: 'Pricing' });
  assert.deepEqual(docModel.parseRef('summarize the last section'), { kind: 'lastSection' });
});

test('parseRef: lines, start and end; block places win over start/end', () => {
  assert.deepEqual(docModel.parseRef('go to line 12'), { kind: 'line', line: 12 });
  assert.deepEqual(docModel.parseRef('add a title at the start'), { kind: 'start' });
  assert.deepEqual(docModel.parseRef('put this at the beginning of the document'), { kind: 'start' });
  assert.deepEqual(docModel.parseRef('insert it at the top'), { kind: 'start' });
  assert.deepEqual(docModel.parseRef('add a summary at the end'), { kind: 'end' });
  assert.deepEqual(docModel.parseRef('write it at the bottom'), { kind: 'end' });
  assert.deepEqual(docModel.parseRef('add a sentence at the end of the second paragraph'), { kind: 'paragraph', index: 2 });
});

test('parseRef: null when no place is named, also for a section still to be created', () => {
  assert.equal(docModel.parseRef('what is the weather like'), null);
  assert.equal(docModel.parseRef('add a new section called Pricing'), null);
  assert.equal(docModel.parseRef('add a heading'), null);
});

test('resolve: paragraphs count only paragraph-like blocks', () => {
  const doc = docModel.parse(MD, 'markdown');
  assert.deepEqual(docModel.resolve(doc, { kind: 'paragraph', index: 1 }).map((block) => block.text), ['Intro paragraph one.\ncontinues here.']);
  assert.deepEqual(docModel.resolve(doc, { kind: 'paragraph', index: 2 }).map((block) => block.text), ['Prices are low.']);
  assert.equal(docModel.resolve(doc, { kind: 'paragraph', index: 3 })[0].kind, 'list');
  assert.deepEqual(docModel.resolve(doc, { kind: 'paragraph', index: -1 }).map((block) => block.text), ['Last words.']);
  assert.deepEqual(docModel.resolve(doc, { kind: 'paragraph', index: 99 }), []);
  assert.deepEqual(docModel.resolve(doc, { kind: 'paragraph', index: -99 }), []);
});

test('resolve: headings and sections match case-insensitively, exact first then contains', () => {
  const doc = docModel.parse('# Pricing Plans\n\nA.\n\n# Pricing\n\nB.\n\n## Extras\n\nC.\n\n# Other\n\nD.', 'markdown');
  assert.equal(docModel.resolve(doc, { kind: 'heading', title: 'pricing' })[0].text, '# Pricing');
  assert.equal(docModel.resolve(doc, { kind: 'heading', title: 'PLANS' })[0].text, '# Pricing Plans');
  assert.deepEqual(docModel.resolve(doc, { kind: 'heading', title: 'missing' }), []);
  assert.deepEqual(docModel.resolve(doc, { kind: 'section', title: 'Pricing' }).map((block) => block.text), ['# Pricing', 'B.', '## Extras', 'C.']);
  assert.deepEqual(docModel.resolve(doc, { kind: 'section', title: 'summarize other' }).map((block) => block.text), ['# Other', 'D.']);
  assert.deepEqual(docModel.resolve(doc, { kind: 'lastSection' }).map((block) => block.text), ['# Other', 'D.']);
});

test('resolve: lastSection skips a lone document title', () => {
  const doc = docModel.parse(MD.replace('Setext Title\n============', 'More text.'), 'markdown');
  // Only one level-1 heading (the title): the last level-2 section is meant.
  assert.equal(docModel.resolve(doc, { kind: 'lastSection' })[0].text, '## Pricing');
  assert.deepEqual(docModel.resolve(docModel.parse('No headings.', 'markdown'), { kind: 'lastSection' }), []);
});

test('resolve: current, previous and next relative to the cursor', () => {
  const doc = docModel.parse(MD, 'markdown');
  const cursor = doc.blocks[3].start + 2;
  assert.equal(docModel.resolve(doc, { kind: 'current' }, cursor)[0].text, 'Prices are low.');
  assert.equal(docModel.resolve(doc, { kind: 'previous' }, cursor)[0].text, 'Intro paragraph one.\ncontinues here.');
  assert.equal(docModel.resolve(doc, { kind: 'next' }, cursor)[0].kind, 'list');
  assert.deepEqual(docModel.resolve(doc, { kind: 'current' }), []);
  assert.deepEqual(docModel.resolve(doc, { kind: 'previous' }, doc.blocks[1].start), []);
});

test('resolve: line, start and end', () => {
  const doc = docModel.parse(MD, 'markdown');
  assert.equal(docModel.resolve(doc, { kind: 'line', line: 4 })[0].text, 'Intro paragraph one.\ncontinues here.');
  assert.deepEqual(docModel.resolve(doc, { kind: 'line', line: 2 }), []);
  assert.equal(docModel.resolve(doc, { kind: 'start' })[0].text, '# Guide');
  assert.equal(docModel.resolve(doc, { kind: 'end' })[0].text, 'Last words.');
  assert.deepEqual(docModel.resolve(docModel.parse('', 'markdown'), { kind: 'end' }), []);
});

test('parseRef and resolve together', () => {
  const doc = docModel.parse(MD, 'markdown');
  const ref = docModel.parseRef('add a sentence to the Pricing section');
  assert.ok(ref);
  assert.equal(docModel.resolve(doc, ref)[0].text, '## Pricing');
});
