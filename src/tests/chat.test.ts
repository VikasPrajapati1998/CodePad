/* Tests of the pure helpers of chat.ts and aiPrompts.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanChatAnswer, shapeParagraphs } from '../chat';
import { MAX_HINT_CHARS, requestedShape, withHint } from '../aiPrompts';

test('requestedShape reads the word and paragraph counts', () => {
  assert.deepEqual(requestedShape('write 500 words in three paragraphs'), { words: 500, paragraphs: 3 });
  assert.deepEqual(requestedShape('two short paragraphs about cats'), { words: null, paragraphs: 2 });
  assert.deepEqual(requestedShape('a 250-word summary in 4 paragraphs'), { words: 250, paragraphs: 4 });
  assert.deepEqual(requestedShape('hello there'), { words: null, paragraphs: null });
  assert.deepEqual(requestedShape('25 paragraphs'), { words: null, paragraphs: null });
});

test('withHint adds the learned sentence, capped', () => {
  assert.equal(withHint('System.', undefined), 'System.');
  assert.equal(withHint('System.', ''), 'System.');
  assert.equal(withHint('System.', 'Be brief.'), 'System. Be brief.');
  assert.equal(withHint('S', 'x'.repeat(1000)).length, 2 + MAX_HINT_CHARS);
});

test('shapeParagraphs regroups a one-line answer into the requested paragraphs', () => {
  assert.equal(shapeParagraphs('One. Two. Three. Four.', 'write two paragraphs'), 'One. Two.\n\nThree. Four.');
  assert.equal(shapeParagraphs('One. Two. Three. Four.\n', 'write 2 paragraphs'), 'One. Two.\n\nThree. Four.\n');
  assert.equal(shapeParagraphs('One. Two. Three.', 'three paragraphs'), 'One.\n\nTwo.\n\nThree.');
});

test('shapeParagraphs keeps text that has structure, too few sentences or no paragraph count', () => {
  assert.equal(shapeParagraphs('Line one.\nLine two.', 'two paragraphs'), 'Line one.\nLine two.');
  assert.equal(shapeParagraphs('One. Two.', 'three paragraphs'), 'One. Two.');
  assert.equal(shapeParagraphs('One. Two. Three.', 'write about cats'), 'One. Two. Three.');
  assert.equal(shapeParagraphs('One. Two. Three.', 'one paragraph'), 'One. Two. Three.');
});

test('cleanChatAnswer drops reasoning, control tokens and wrapper tags', () => {
  assert.equal(cleanChatAnswer('<think>plan</think>Hello <|im_end|>', 'answer'), 'Hello');
  assert.equal(cleanChatAnswer('<response>Hi there</response>', 'answer'), 'Hi there');
  assert.equal(cleanChatAnswer('Answer<think>unfinished', 'answer'), 'Answer');
  assert.equal(cleanChatAnswer('a\r\nb', 'answer'), 'a\nb');
});

test('cleanChatAnswer unwraps a fenced whole file and ends it with one newline', () => {
  assert.equal(cleanChatAnswer('```js\nconst a = 1;\n```', 'file'), 'const a = 1;\n');
  assert.equal(cleanChatAnswer('~~~\nline\n~~~\n', 'write'), 'line\n');
  assert.equal(cleanChatAnswer('\n\nText  \n\n', 'file'), 'Text\n');
  assert.equal(cleanChatAnswer('   ', 'file'), '');
});
