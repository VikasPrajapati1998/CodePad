/* Tests of shared/docOps.ts (operations, validation, atomic apply, diff and partial accept). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const docModel: CodePadDocModelApi = require('../shared/docModel');
const docOps: CodePadDocOpsApi = require('../shared/docOps');

const TEXT = '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n';
const doc = docModel.parse(TEXT, 'markdown');
const [title, alpha, beta, gamma] = doc.blocks;

type OpFields = Partial<CodePadDocOperation>;

function op(type: CodePadOpType, fields: OpFields = {}, on: CodePadDocument = doc): CodePadDocOperation {
  return docOps.create({ operation_type: type, document_id: 'doc-1', document_version: on.version, ...fields });
}

/** Applies one batch and returns the new text (fails the test when the batch fails). */
function run(operations: CodePadDocOperation[], on: CodePadDocument = doc): string {
  const result = docOps.apply(on, operations);
  if (!result.ok) {
    assert.fail(`apply failed: ${result.error}`);
  }
  return result.text;
}

function errorOf(operation: CodePadDocOperation, on: CodePadDocument = doc): string {
  const check = docOps.validate(on, operation);
  return check.ok ? '' : check.error;
}

test('the sample document has the expected blocks', () => {
  assert.deepEqual(doc.blocks.map((block) => block.text), ['# Title', 'Alpha one.', 'Beta two.', 'Gamma three.']);
});

test('newId is unique and create fills every field', () => {
  const first = docOps.newId();
  const second = docOps.newId();
  assert.notEqual(first, second);
  assert.match(first, /^op-[0-9a-z]+-\d+$/);
  const created = op('delete', { target_block_id: beta.id });
  assert.equal(created.execution_status, 'pending');
  assert.equal(created.target_block_id, beta.id);
  assert.equal(created.new_content, null);
  assert.equal(created.formatting_metadata, null);
  assert.equal(created.document_id, 'doc-1');
  assert.match(created.operation_id, /^op-/);
  assert.equal(op('delete', { operation_id: 'fixed' }).operation_id, 'fixed');
});

test('insert after / before a block keeps one blank line on each side', () => {
  assert.equal(
    run([op('insert', { target_block_id: alpha.id, insertion_position: 'after', new_content: 'New para.' })]),
    '# Title\n\nAlpha one.\n\nNew para.\n\nBeta two.\n\nGamma three.\n',
  );
  assert.equal(
    run([op('insert', { target_block_id: alpha.id, insertion_position: 'before', new_content: '\n\nNew para.\n\n\n' })]),
    '# Title\n\nNew para.\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n',
  );
  assert.equal(
    run([op('insert', { target_block_id: gamma.id, insertion_position: 'after', new_content: 'Tail.' })]),
    '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n\nTail.\n',
  );
});

test('insert next to a block without a blank line adds one', () => {
  const tight = docModel.parse('# Head\nBody text.', 'markdown');
  assert.equal(run([op('insert', { target_block_id: tight.blocks[0].id, insertion_position: 'after', new_content: 'Mid.' }, tight)], tight), '# Head\n\nMid.\n\nBody text.');
});

test('two inserts at the same place keep their order', () => {
  assert.equal(
    run([
      op('insert', { target_block_id: alpha.id, insertion_position: 'after', new_content: 'First.' }),
      op('insert', { target_block_id: alpha.id, insertion_position: 'after', new_content: 'Second.' }),
    ]),
    '# Title\n\nAlpha one.\n\nFirst.\n\nSecond.\n\nBeta two.\n\nGamma three.\n',
  );
});

test('insert at the cursor and inside the end of a block', () => {
  assert.equal(run([op('insert', { insertion_position: 'cursor', cursor_offset: 0, new_content: 'X' })]), `X${TEXT}`);
  assert.equal(
    run([op('insert', { target_block_id: alpha.id, insertion_position: 'inside_end', new_content: 'Extra.' })]),
    '# Title\n\nAlpha one. Extra.\n\nBeta two.\n\nGamma three.\n',
  );
  assert.equal(
    run([op('insert', { target_block_id: alpha.id, insertion_position: 'inside_end', new_content: ', and more' })]),
    '# Title\n\nAlpha one., and more\n\nBeta two.\n\nGamma three.\n',
  );
});

test('invalid inserts', () => {
  assert.match(errorOf(op('insert', { insertion_position: 'cursor', cursor_offset: 999, new_content: 'X' })), /cursor/);
  assert.match(errorOf(op('insert', { insertion_position: 'cursor', cursor_offset: null, new_content: 'X' })), /cursor/);
  assert.match(errorOf(op('insert', { target_block_id: alpha.id, insertion_position: 'after' })), /content/);
  assert.match(errorOf(op('insert', { target_block_id: alpha.id, new_content: 'X' })), /position/);
  assert.match(errorOf(op('insert', { insertion_position: 'after', new_content: 'X' })), /target/);
});

test('append and prepend to the document', () => {
  assert.equal(run([op('append', { new_content: 'The end.' })]), '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n\nThe end.\n');
  assert.equal(run([op('prepend', { new_content: 'Start.' })]), 'Start.\n\n# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n');
  const empty = docModel.parse('', 'markdown');
  assert.equal(run([op('append', { new_content: 'Hello' }, empty)], empty), 'Hello');
  const spaced = docModel.parse('Text\n\n\n', 'plaintext');
  assert.equal(run([op('append', { new_content: 'More' }, spaced)], spaced), 'Text\n\nMore\n\n\n');
  assert.match(errorOf(op('append', {})), /content/);
  assert.match(errorOf(op('prepend', { new_content: '' })), /content/);
});

test('append and prepend with a target work inside the block', () => {
  assert.equal(run([op('append', { target_block_id: beta.id, new_content: 'More.' })]), '# Title\n\nAlpha one.\n\nBeta two. More.\n\nGamma three.\n');
  assert.equal(run([op('prepend', { target_block_id: beta.id, new_content: 'Note:' })]), '# Title\n\nAlpha one.\n\nNote: Beta two.\n\nGamma three.\n');
});

test('replace and rewrite', () => {
  assert.equal(run([op('replace', { target_block_id: beta.id, new_content: 'Beta 2.' })]), '# Title\n\nAlpha one.\n\nBeta 2.\n\nGamma three.\n');
  assert.equal(run([op('rewrite', { target_block_id: beta.id, new_content: 'Beta, rewritten.\n\n' })]), '# Title\n\nAlpha one.\n\nBeta, rewritten.\n\nGamma three.\n');
  assert.equal(run([op('replace', { target_block_id: beta.id, new_content: '' })]), '# Title\n\nAlpha one.\n\nGamma three.\n');
  assert.match(errorOf(op('replace', { target_block_id: beta.id })), /content/);
  assert.match(errorOf(op('rewrite', { new_content: 'x' })), /target/);
});

test('delete a middle block, the last block and neighbouring blocks', () => {
  assert.equal(run([op('delete', { target_block_id: beta.id })]), '# Title\n\nAlpha one.\n\nGamma three.\n');
  assert.equal(run([op('delete', { target_block_id: gamma.id })]), '# Title\n\nAlpha one.\n\nBeta two.\n');
  assert.equal(run([op('delete', { target_block_id: beta.id }), op('delete', { target_block_id: gamma.id })]), '# Title\n\nAlpha one.\n');
  assert.equal(run([op('delete', { target_block_id: title.id }), op('delete', { target_block_id: alpha.id })]), 'Beta two.\n\nGamma three.\n');
  assert.match(errorOf(op('delete', {})), /target/);
});

test('move and reorder', () => {
  assert.equal(run([op('move', { target_block_id: gamma.id, destination_block_id: title.id })]), '# Title\n\nGamma three.\n\nAlpha one.\n\nBeta two.\n');
  assert.equal(run([op('move', { target_block_id: alpha.id, destination_block_id: null })]), 'Alpha one.\n\n# Title\n\nBeta two.\n\nGamma three.\n');
  assert.equal(run([op('reorder', { target_block_id: alpha.id, destination_block_id: beta.id })]), '# Title\n\nBeta two.\n\nAlpha one.\n\nGamma three.\n');
  assert.equal(run([op('move', { target_block_id: beta.id, destination_block_id: gamma.id })]), '# Title\n\nAlpha one.\n\nGamma three.\n\nBeta two.\n');
  assert.equal(run([op('move', { target_block_id: beta.id, destination_block_id: alpha.id })]), TEXT);
  assert.match(errorOf(op('move', { target_block_id: beta.id, destination_block_id: beta.id })), /itself/);
  assert.match(errorOf(op('move', { target_block_id: beta.id, destination_block_id: 'b00000000-0' })), /destination/);
  assert.match(errorOf(op('reorder', { destination_block_id: beta.id })), /target/);
});

test('merge with the next block', () => {
  assert.equal(run([op('merge', { target_block_id: alpha.id })]), '# Title\n\nAlpha one. Beta two.\n\nGamma three.\n');
  const lists = docModel.parse('- a\n\n* b', 'plaintext');
  assert.equal(run([op('merge', { target_block_id: lists.blocks[0].id }, lists)], lists), '- a\n* b');
  assert.match(errorOf(op('merge', { target_block_id: gamma.id })), /following block/);
});

test('split a block', () => {
  assert.equal(run([op('split', { target_block_id: alpha.id, split_at: 6 })]), '# Title\n\nAlpha\n\none.\n\nBeta two.\n\nGamma three.\n');
  assert.match(errorOf(op('split', { target_block_id: alpha.id, split_at: 0 })), /inside/);
  assert.match(errorOf(op('split', { target_block_id: alpha.id, split_at: alpha.text.length })), /inside/);
  assert.match(errorOf(op('split', { target_block_id: alpha.id })), /inside/);
  const padded = docModel.parse('Word     tail', 'plaintext');
  assert.match(errorOf(op('split', { target_block_id: padded.blocks[0].id, split_at: 5 }, padded), padded), /^$/);
  assert.match(errorOf(op('split', { target_block_id: padded.blocks[0].id, split_at: 6 }, padded), padded), /^$/);
});

test('format styles', () => {
  const format = (style: string, extra: Record<string, string> = {}, target: CodePadBlock = alpha): string =>
    run([op('format', { target_block_id: target.id, formatting_metadata: { style, ...extra } })]);
  const around = (text: string): string => `# Title\n\n${text}\n\nBeta two.\n\nGamma three.\n`;
  assert.equal(format('bold'), around('**Alpha one.**'));
  assert.equal(format('italic'), around('*Alpha one.*'));
  assert.equal(format('code'), around('`Alpha one.`'));
  assert.equal(format('quote'), around('> Alpha one.'));
  assert.equal(format('bullets'), around('- Alpha one.'));
  assert.equal(format('numbered'), around('1. Alpha one.'));
  assert.equal(format('heading'), around('# Alpha one.'));
  assert.equal(format('heading', { level: '2' }), around('## Alpha one.'));
  assert.equal(format('bold', {}, title), '# **Title**\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n');
  assert.equal(format('heading', { level: '3' }, title), '### Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n');

  const prose = docModel.parse('One. Two! Three?\n\nx\ny', 'plaintext');
  const formatted = (style: string, target: CodePadBlock): string =>
    run([op('format', { target_block_id: target.id, formatting_metadata: { style } }, prose)], prose);
  assert.equal(formatted('bullets', prose.blocks[0]), '- One.\n- Two!\n- Three?\n\nx\ny');
  assert.equal(formatted('numbered', prose.blocks[1]), 'One. Two! Three?\n\n1. x\n2. y');
  assert.equal(formatted('code', prose.blocks[1]), 'One. Two! Three?\n\n```\nx\ny\n```');
  assert.equal(formatted('quote', prose.blocks[1]), 'One. Two! Three?\n\n> x\n> y');
  assert.equal(formatted('heading', prose.blocks[0]), '# One. Two! Three?\n\nx\ny');

  const list = docModel.parse('- a\n- b', 'markdown');
  assert.equal(run([op('format', { target_block_id: list.blocks[0].id, formatting_metadata: { style: 'bold' } }, list)], list), '- **a**\n- **b**');

  assert.match(errorOf(op('format', { target_block_id: alpha.id, formatting_metadata: { style: 'underline' } })), /style/);
  assert.match(errorOf(op('format', { target_block_id: alpha.id })), /style/);
  assert.match(errorOf(op('format', { target_block_id: alpha.id, formatting_metadata: { style: 'heading', level: '9' } })), /level/);
});

test('create_section', () => {
  assert.equal(
    run([op('create_section', { target_block_id: gamma.id, new_content: 'Cheap.', formatting_metadata: { title: 'Pricing' } })]),
    '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n\n# Pricing\n\nCheap.\n',
  );
  assert.equal(
    run([op('create_section', { target_block_id: alpha.id, new_content: 'Cheap.', formatting_metadata: { title: 'Pricing', level: '2' } })]),
    '# Title\n\nAlpha one.\n\n## Pricing\n\nCheap.\n\nBeta two.\n\nGamma three.\n',
  );
  assert.equal(
    run([op('create_section', { new_content: '', formatting_metadata: { title: 'Notes', level: '2' } })]),
    '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n\n## Notes\n',
  );
  const plain = docModel.parse('Just text.', 'plaintext');
  assert.equal(run([op('create_section', { new_content: 'Body.', formatting_metadata: { title: 'New' } }, plain)], plain), 'Just text.\n\n# New\n\nBody.');
  assert.match(errorOf(op('create_section', { new_content: 'x' })), /title/);
  assert.match(errorOf(op('create_section', { new_content: 'x', formatting_metadata: { title: '  ' } })), /title/);
  assert.match(errorOf(op('create_section', { formatting_metadata: { title: 'T' } })), /body/);
  assert.match(errorOf(op('create_section', { new_content: 'x', formatting_metadata: { title: 'T', level: '7' } })), /level/);
});

test('find_replace replaces every occurrence', () => {
  assert.equal(run([op('find_replace', { find: 'e', replace_with: 'E' })]), '# TitlE\n\nAlpha onE.\n\nBEta two.\n\nGamma thrEE.\n');
  assert.equal(run([op('find_replace', { find: 'one', replace_with: '' })]), '# Title\n\nAlpha .\n\nBeta two.\n\nGamma three.\n');
  assert.match(errorOf(op('find_replace', { find: 'zzz', replace_with: 'y' })), /does not occur/);
  assert.match(errorOf(op('find_replace', { find: '', replace_with: 'y' })), /empty/);
  assert.match(errorOf(op('find_replace', { find: 'one' })), /replacement/);
});

test('version and original_content conflicts', () => {
  assert.equal(errorOf(docOps.create({ operation_type: 'delete', document_id: 'doc-1', document_version: 'deadbeef', target_block_id: beta.id })), 'The document changed since the edit was planned.');
  assert.match(errorOf(op('replace', { target_block_id: beta.id, original_content: 'Something else.', new_content: 'x' })), /changed/);
  assert.equal(errorOf(op('replace', { target_block_id: beta.id, original_content: 'Beta two.', new_content: 'x' })), '');
  assert.match(errorOf(op('delete', { target_block_id: 'b12345678-0' })), /no longer exists/);
  const result = docOps.apply(doc, [docOps.create({ operation_type: 'append', document_id: 'doc-1', document_version: '00000000', new_content: 'x' })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, 'The document changed since the edit was planned.');
    assert.equal(result.operations[0].execution_status, 'failed');
  }
});

test('overlapping operations are rejected and nothing is applied', () => {
  const replace = op('replace', { target_block_id: beta.id, new_content: 'B.' });
  const remove = op('delete', { target_block_id: beta.id });
  const result = docOps.apply(doc, [replace, remove]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /overlaps/);
    assert.deepEqual(result.operations.map((item) => item.execution_status), ['rejected', 'failed']);
  }
  const findInside = docOps.apply(doc, [op('rewrite', { target_block_id: alpha.id, new_content: 'A.' }), op('find_replace', { find: 'Alpha', replace_with: 'a' })]);
  assert.equal(findInside.ok, false);
  const insertInside = docOps.apply(doc, [op('delete', { target_block_id: beta.id }), op('insert', { target_block_id: beta.id, insertion_position: 'after', new_content: 'x' })]);
  assert.equal(insertInside.ok, false);
  const twice = docOps.apply(doc, [op('delete', { target_block_id: beta.id }), op('move', { target_block_id: beta.id, destination_block_id: gamma.id })]);
  assert.equal(twice.ok, false);
});

test('edits next to each other do not overlap', () => {
  assert.equal(
    run([op('replace', { target_block_id: alpha.id, new_content: 'A.' }), op('replace', { target_block_id: beta.id, new_content: 'B.' }), op('delete', { target_block_id: gamma.id })]),
    '# Title\n\nA.\n\nB.\n',
  );
});

test('a batch is atomic: one invalid operation rejects all', () => {
  const good = op('replace', { target_block_id: alpha.id, new_content: 'A.' });
  const bad = op('delete', { target_block_id: 'missing' });
  const result = docOps.apply(doc, [good, bad]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.operations.map((item) => item.execution_status), ['rejected', 'failed']);
  }
  // The inputs are not changed.
  assert.equal(good.execution_status, 'pending');
  assert.equal(doc.text, TEXT);
  const duplicate = docOps.apply(doc, [good, good]);
  assert.equal(duplicate.ok, false);
});

test('operations already applied are skipped', () => {
  const first = op('replace', { target_block_id: alpha.id, new_content: 'A.' });
  const second = op('replace', { target_block_id: beta.id, new_content: 'B.' });
  const result = docOps.apply(doc, [first, second], new Set([first.operation_id]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, '# Title\n\nAlpha one.\n\nB.\n\nGamma three.\n');
    assert.deepEqual(result.operations.map((item) => item.execution_status), ['skipped', 'applied']);
  }
  const none = docOps.apply(doc, [first], new Set([first.operation_id]));
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.equal(none.text, TEXT);
    assert.deepEqual(none.changes, []);
  }
});

test('apply returns the line diff of the change', () => {
  const result = docOps.apply(doc, [op('insert', { target_block_id: alpha.id, insertion_position: 'after', new_content: 'New para.' })]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changes.length, 1);
    assert.deepEqual(result.changes[0].added.filter((line) => line !== ''), ['New para.']);
    assert.equal(docOps.applyChanges(TEXT, result.changes, new Set(result.changes.map((change) => change.id))), result.text);
  }
});

test('diff: hunks, ids and ranges', () => {
  assert.deepEqual(docOps.diff('same\ntext', 'same\ntext'), []);
  assert.deepEqual(docOps.diff('a\nb\nc', 'a\nB\nc'), [{ id: 'c1', beforeStart: 1, beforeEnd: 2, afterStart: 1, afterEnd: 2, removed: ['b'], added: ['B'] }]);
  assert.deepEqual(docOps.diff('a\nc', 'a\nb\nc'), [{ id: 'c1', beforeStart: 1, beforeEnd: 1, afterStart: 1, afterEnd: 2, removed: [], added: ['b'] }]);
  assert.deepEqual(docOps.diff('a\nb\nc', 'a\nc'), [{ id: 'c1', beforeStart: 1, beforeEnd: 2, afterStart: 1, afterEnd: 1, removed: ['b'], added: [] }]);
  const two = docOps.diff('a\nb\nc\nd\ne', 'A\nb\nc\nD\ne');
  assert.deepEqual(two.map((change) => change.id), ['c1', 'c2']);
  assert.deepEqual(two.map((change) => [change.beforeStart, change.beforeEnd, change.afterStart, change.afterEnd]), [[0, 1, 0, 1], [3, 4, 3, 4]]);
  assert.deepEqual(two.map((change) => [change.removed, change.added]), [[['a'], ['A']], [['d'], ['D']]]);
});

test('applyChanges accepts any subset of hunks', () => {
  const before = 'a\nb\nc\nd\ne\nf';
  const after = 'A\nb\nc\nd\ne\nf\ng';
  const changes = docOps.diff(before, after);
  assert.equal(changes.length, 2);
  assert.equal(docOps.applyChanges(before, changes, new Set()), before);
  assert.equal(docOps.applyChanges(before, changes, new Set(changes.map((change) => change.id))), after);
  assert.equal(docOps.applyChanges(before, changes, new Set(['c1'])), 'A\nb\nc\nd\ne\nf');
  assert.equal(docOps.applyChanges(before, changes, new Set(['c2'])), 'a\nb\nc\nd\ne\nf\ng');
});

test('diff of large texts falls back to one hunk of the differing middle', () => {
  const before = Array.from({ length: 4500 }, (_, index) => `x${index}`);
  const after = Array.from({ length: 4500 }, (_, index) => `y${index}`);
  const head = 'same head';
  const tail = 'same tail';
  const oldText = [head, ...before, tail].join('\n');
  const newText = [head, ...after, tail].join('\n');
  const changes = docOps.diff(oldText, newText);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].beforeStart, 1);
  assert.equal(changes[0].beforeEnd, 4501);
  assert.equal(docOps.applyChanges(oldText, changes, new Set(['c1'])), newText);
});

test('random edits: diff then applyChanges with all hunks reproduces the new text', () => {
  let seed = 7;
  const random = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (let round = 0; round < 30; round += 1) {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index % 7}`);
    const edited = lines.flatMap((line) => {
      const roll = random();
      return roll < 0.1 ? [] : roll < 0.2 ? [line, 'inserted'] : roll < 0.3 ? ['changed'] : [line];
    });
    const before = lines.join('\n');
    const after = edited.join('\n');
    const changes = docOps.diff(before, after);
    assert.equal(docOps.applyChanges(before, changes, new Set(changes.map((change) => change.id))), after);
    assert.equal(docOps.applyChanges(before, changes, new Set()), before);
  }
});
