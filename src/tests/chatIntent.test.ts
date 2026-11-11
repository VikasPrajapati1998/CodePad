/* Tests of shared/chatIntent.ts (deterministic intent parser of the AI chat). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const chatIntent: CodePadChatIntentApi = require('../shared/chatIntent');
const parse = (sentence: string, openNames: readonly string[] = []): CodePadChatIntent => chatIntent.parseIntent(sentence, openNames);

test('completing the file is an edit with completion', () => {
  const intent = parse('complete this essay');
  assert.equal(intent.action, 'edit-file');
  assert.equal(intent.completion, true);
  assert.equal(intent.useCurrent, true);
  assert.equal(parse('Please finish the story').completion, true);
});

test('replace "a" with "b" is an exact find and replace', () => {
  const intent = parse('replace "a" with "b"');
  assert.equal(intent.action, 'find-replace');
  assert.equal(intent.find, 'a');
  assert.equal(intent.replaceWith, 'b');
  const plain = parse('replace colour with color');
  assert.equal(plain.action, 'find-replace');
  assert.equal(plain.find, 'colour');
  assert.equal(plain.replaceWith, 'color');
});

test('rename names the file and the new name', () => {
  const intent = parse('rename x.txt to y.txt');
  assert.equal(intent.action, 'rename-file');
  assert.equal(intent.target, 'x.txt');
  assert.equal(intent.newName, 'y.txt');
});

test('delete a named file', () => {
  const intent = parse('delete notes.txt');
  assert.equal(intent.action, 'delete-file');
  assert.equal(intent.target, 'notes.txt');
});

test('a plain question is an answer', () => {
  const intent = parse('what is a closure?');
  assert.equal(intent.action, 'answer');
  assert.equal(intent.target, null);
  assert.equal(intent.useCurrent, false);
  assert.equal(intent.completion, false);
  assert.deepEqual(intent.steps, []);
  assert.equal(intent.position, null);
  assert.equal(parse('how does photosynthesis work?').action, 'answer');
  assert.equal(parse('what does this file do?').useCurrent, true);
});

test('an open tab named in the sentence becomes the target', () => {
  assert.equal(parse('what is in Notes.md about pricing', ['Notes.md']).target, 'Notes.md');
});

test('append at the end of the file stays append-content', () => {
  const intent = parse('add a closing line at the end of this file');
  assert.equal(intent.action, 'append-content');
  assert.equal(intent.useCurrent, true);
});

test('translate names the language and, for a block, the place', () => {
  const file = parse('translate this file to French');
  assert.equal(file.action, 'translate');
  assert.equal(file.language, 'French');
  assert.equal(file.useCurrent, true);
  assert.equal(file.placeText, null);
  const block = parse('translate the second paragraph into spanish');
  assert.equal(block.action, 'translate');
  assert.equal(block.language, 'Spanish');
  assert.equal(block.placeText, 'translate the second paragraph into spanish');
  assert.equal(parse('translate the selection to German').selectionOnly, true);
});

test('analysing a document', () => {
  assert.equal(parse('what is this document about').action, 'analyze-document');
  assert.equal(parse('analyze this document').action, 'analyze-document');
  assert.equal(parse('find any inconsistencies').action, 'analyze-document');
  assert.equal(parse('analyze this document').useCurrent, true);
});

test('outline / table of contents', () => {
  const toc = parse('generate a table of contents');
  assert.equal(toc.action, 'outline');
  assert.equal(toc.position, null);
  assert.equal(parse('add a table of contents at the top').position, 'start');
  assert.equal(parse('show me the outline').action, 'outline');
});

test('finding duplicate paragraphs', () => {
  const intent = parse('find duplicate paragraphs');
  assert.equal(intent.action, 'find-duplicates');
  assert.equal(intent.useCurrent, true);
  assert.equal(parse('are there repeated sentences in this file').action, 'find-duplicates');
});

test('folders: create and move', () => {
  const folder = parse('create a folder called drafts');
  assert.equal(folder.action, 'create-folder');
  assert.equal(folder.newName, 'drafts');
  assert.equal(parse('new folder archive').newName, 'archive');

  const move = parse('move notes.txt to archive');
  assert.equal(move.action, 'move-file');
  assert.equal(move.target, 'notes.txt');
  assert.equal(move.newName, 'archive');
  const current = parse('move this file into the folder drafts');
  assert.equal(current.action, 'move-file');
  assert.equal(current.target, null);
  assert.equal(current.newName, 'drafts');
});

test('insert-at: around a block, at the end, into a list, at a line', () => {
  const after = parse('add an example after the second paragraph');
  assert.equal(after.action, 'insert-at');
  assert.equal(after.position, 'after');
  assert.equal(after.placeText, 'the second paragraph');
  assert.equal(after.instruction, 'add an example');
  assert.equal(after.useCurrent, true);

  const before = parse('insert a quote before the section Pricing');
  assert.equal(before.position, 'before');
  assert.equal(before.placeText, 'the section Pricing');

  const heading = parse('add a heading Summary at the end');
  assert.equal(heading.action, 'insert-at');
  assert.equal(heading.position, 'end');
  assert.equal(heading.placeText, null);
  assert.equal(heading.instruction, 'add a heading Summary');

  const list = parse('append three points to the existing list');
  assert.equal(list.action, 'insert-at');
  assert.equal(list.position, 'inside_end');
  assert.equal(list.intoList, true);

  const line = parse('insert a sentence at line 4');
  assert.equal(line.position, 'before');
  assert.equal(line.placeText, 'line 4');

  const quoted = parse('add the heading "Summary" after the first paragraph');
  assert.equal(quoted.literal, 'Summary');
  assert.equal(quoted.target, null);
});

test('several steps in one message', () => {
  const intent = parse('rewrite this file and then translate it to Hindi');
  assert.equal(intent.action, 'multi-step');
  assert.deepEqual(intent.steps, ['rewrite this file', 'translate it to Hindi']);
  const numbered = parse('1. Fix the typos 2. Translate it to German');
  assert.equal(numbered.action, 'multi-step');
  assert.deepEqual(numbered.steps, ['Fix the typos', 'Translate it to German']);
  // Steps that are plain sentences are not a plan.
  assert.equal(parse('I went to the store and then I went home').action, 'answer');
  // A completion request is never split into steps.
  assert.notEqual(parse('complete this essay and then translate it to French').action, 'multi-step');
});

test('follow-ups on the pending answer', () => {
  assert.equal(parse('append it to my document').followUp, 'append');
  assert.equal(parse('append it to my document').action, 'follow-up');
  const insert = parse('insert it after the second paragraph');
  assert.equal(insert.followUp, 'insert');
  assert.equal(insert.position, 'after');
  assert.equal(insert.placeText, 'the second paragraph');
  assert.equal(parse('put it at the top').position, 'start');
  assert.equal(parse('replace the selection with it').followUp, 'replace-selection');
  assert.equal(parse('replace this file with the answer').followUp, 'replace-document');
  const revise = parse('add an example');
  assert.equal(revise.action, 'write-content');
  assert.equal(revise.followUp, 'revise');
});

test('a completion keeps priority over a later translate step', () => {
  const intent = parse('complete this essay and then translate it to French');
  assert.equal(intent.action, 'edit-file');
  assert.equal(intent.completion, true);
});

test('a question about translating stays a question', () => {
  assert.equal(parse('how do you translate hello into French?').action, 'answer');
  assert.equal(parse('translate this file to French').action, 'translate');
});

test('moving a paragraph or a section is a move-block with both places', () => {
  const intent = parse('move the second paragraph after the fourth paragraph');
  assert.equal(intent.action, 'move-block');
  assert.equal(intent.placeText, 'the second paragraph');
  assert.equal(intent.position, 'after');
  assert.equal(intent.newName, 'the fourth paragraph');
  const before = parse('Move the section Pricing before the section Plans.');
  assert.equal(before.action, 'move-block');
  assert.equal(before.position, 'before');
  const end = parse('move the first paragraph to the end');
  assert.equal(end.action, 'move-block');
  assert.equal(end.position, 'end');
  assert.equal(parse('move notes.txt to archive').action, 'move-file');
});
