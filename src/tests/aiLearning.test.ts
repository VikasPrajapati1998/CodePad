/* Tests of aiLearning.ts with an in-memory store (no files, no Electron). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearning } from '../aiLearning';
import type { AiLearning } from '../aiLearning';
import type { SummaryCacheStore } from '../summaryCache';

const PREFIX = 'The quick brown fox jumps over the lazy';
const OTHER_PREFIX = 'Another sentence that ends right here and';

interface Harness {
  learning: AiLearning;
  settings: Record<string, unknown>;
  files: Map<string, unknown>;
}

function memoryStore(files: Map<string, unknown>): SummaryCacheStore {
  return {
    readJson: async (file) => (files.has(file) ? { data: files.get(file), integrity: 'ok' } : { data: null, integrity: 'none' }),
    writeJson: async (file, value) => {
      files.set(file, JSON.parse(JSON.stringify(value)));
      return undefined;
    },
    remove: async (file) => {
      files.delete(file);
      return undefined;
    },
  };
}

function harness(settings: Record<string, unknown> = { 'ai.learning': true }, files: Map<string, unknown> = new Map()): Harness {
  const log = { info: (): void => {}, warn: (): void => {}, error: (): void => {} };
  const learning = createLearning({ userStore: memoryStore(files), getSettings: () => settings, log });
  return { learning, settings, files };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function accept(learning: AiLearning, reqId: number, prefix: string, text: string, times: number): void {
  learning.remember(reqId, 'plaintext', prefix, text);
  for (let index = 0; index < times; index += 1) {
    learning.record({ kind: 'suggest', outcome: 'accepted', reqId });
  }
}

function rateChat(learning: AiLearning, rating: 'up' | 'down', answerChars: number, times: number): void {
  for (let index = 0; index < times; index += 1) {
    learning.record({ kind: 'chat', rating, answerChars });
  }
}

test('a phrase is recalled after two acceptances', async () => {
  const { learning } = harness();
  accept(learning, 1, PREFIX, ' dog.', 1);
  assert.equal(learning.recall('plaintext', PREFIX), null);
  learning.record({ kind: 'suggest', outcome: 'accepted', reqId: 1 });
  assert.equal(learning.recall('plaintext', PREFIX), ' dog.');
  assert.equal(learning.recall('markdown', PREFIX), null);
  assert.equal(learning.recall('plaintext', 'a different text before the cursor'), null);
  await learning.flush();
});

test('a suggestion shown three times and never accepted is suppressed', async () => {
  const { learning } = harness();
  learning.remember(7, 'plaintext', OTHER_PREFIX, ' cat');
  learning.record({ kind: 'suggest', outcome: 'shown', reqId: 7 });
  learning.record({ kind: 'suggest', outcome: 'shown', reqId: 7 });
  assert.equal(learning.shouldSuppress('plaintext', OTHER_PREFIX, ' cat'), false);
  learning.record({ kind: 'suggest', outcome: 'shown', reqId: 7 });
  assert.equal(learning.shouldSuppress('plaintext', OTHER_PREFIX, ' cat'), true);
  assert.equal(learning.shouldSuppress('plaintext', OTHER_PREFIX, ' dog'), false);
  // Unknown request ids and short contexts are ignored.
  learning.record({ kind: 'suggest', outcome: 'shown', reqId: 999 });
  learning.remember(8, 'plaintext', 'short', ' x');
  learning.record({ kind: 'suggest', outcome: 'accepted', reqId: 8 });
  assert.equal(learning.details().phrases.length, 1);
  await learning.flush();
});

test('chat ratings produce a length hint', async () => {
  const short = harness();
  rateChat(short.learning, 'up', 100, 3);
  rateChat(short.learning, 'down', 1000, 1);
  assert.equal(short.learning.chatHint(), '');
  rateChat(short.learning, 'down', 1000, 1);
  assert.equal(short.learning.chatHint(), 'The user prefers short answers: be brief.');
  await short.learning.flush();

  const full = harness();
  rateChat(full.learning, 'up', 1000, 3);
  rateChat(full.learning, 'down', 100, 2);
  assert.equal(full.learning.chatHint(), 'The user prefers fuller answers: explain a little more.');
  await full.learning.flush();
});

test('rewriteHint follows Apply/discard and the user sentence comes first', async () => {
  const { learning } = harness();
  for (let index = 0; index < 4; index += 1) {
    learning.record({ kind: 'rewrite', mode: 'grammar', outcome: 'discarded' });
  }
  learning.record({ kind: 'rewrite', mode: 'grammar', outcome: 'applied' });
  assert.match(learning.rewriteHint('grammar'), /rejects corrections/);
  assert.equal(learning.rewriteHint('restructure'), '');
  assert.equal(learning.setCustom('grammar', '  Keep   British spelling. '), true);
  assert.match(learning.rewriteHint('grammar'), /^Keep British spelling\. The user often rejects corrections/);
  assert.equal(learning.setCustom('restructure', 'Use short headings.'), true);
  assert.equal(learning.rewriteHint('restructure'), 'Use short headings.');
  await learning.flush();
});

test('details, remove, setCustom and resetHints', async () => {
  const { learning } = harness();
  accept(learning, 1, PREFIX, ' dog.', 2);
  learning.record({ kind: 'rewrite', mode: 'restructure', outcome: 'applied', instruction: 'Use shorter headings' });
  learning.record({ kind: 'rewrite', mode: 'restructure', outcome: 'applied', instruction: 'use SHORTER headings' });
  rateChat(learning, 'up', 100, 3);
  rateChat(learning, 'down', 1000, 2);
  learning.setCustom('chat', 'Answer in French.');

  const details = learning.details();
  assert.equal(details.enabled, true);
  assert.deepEqual(details.features, { suggest: true, chat: true, rewrite: true, summary: true });
  assert.deepEqual(details.phrases.map((phrase) => [phrase.text, phrase.accepted]), [[' dog.', 2]]);
  assert.deepEqual(details.wishes, [{ text: 'Use shorter headings', count: 2 }]);
  assert.equal(details.custom.chat, 'Answer in French.');
  assert.equal(details.learned.chat, 'The user prefers short answers: be brief.');
  assert.equal(learning.chatHint(), 'Answer in French. The user prefers short answers: be brief.');
  assert.deepEqual(learning.instructions(), ['Use shorter headings']);

  assert.equal(learning.remove('wish', 0, 'something else'), false);
  assert.equal(learning.remove('wish', 0, 'Use shorter headings'), true);
  assert.deepEqual(learning.details().wishes, []);

  learning.resetHints();
  assert.equal(learning.chatHint(), 'Answer in French.');
  assert.equal(learning.details().learned.chat, '');
  assert.equal(learning.recall('plaintext', PREFIX), ' dog.');

  assert.equal(learning.remove('phrase', 0, ' cat'), false);
  assert.equal(learning.remove('phrase', 0, ' dog.'), true);
  assert.equal(learning.recall('plaintext', PREFIX), null);
  assert.equal(learning.setCustom('chat', ''), true);
  assert.equal(learning.chatHint(), '');
  await learning.flush();
});

test('old votes decay: tallies halve past 50 votes', async () => {
  const { learning } = harness();
  rateChat(learning, 'up', 10, 50);
  assert.match(learning.info().lines[1], /^Chat answers rated: 50 helpful, 0 not helpful\./);
  rateChat(learning, 'up', 10, 1);
  assert.match(learning.info().lines[1], /^Chat answers rated: 25 helpful, 0 not helpful\./);
  await learning.flush();
});

test('learning off: events have no effect', async () => {
  const off = harness({ 'ai.learning': false });
  accept(off.learning, 1, PREFIX, ' dog.', 3);
  rateChat(off.learning, 'up', 100, 3);
  rateChat(off.learning, 'down', 1000, 3);
  assert.equal(off.learning.recall('plaintext', PREFIX), null);
  assert.equal(off.learning.chatHint(), '');
  assert.equal(off.learning.details().enabled, false);
  off.settings['ai.learning'] = true;
  assert.equal(off.learning.recall('plaintext', PREFIX), null);
  assert.equal(off.learning.chatHint(), '');
  await off.learning.flush();
  assert.equal(off.files.size, 0);

  const chatOff = harness({ 'ai.learning': true, 'ai.learning.chat': false });
  rateChat(chatOff.learning, 'up', 100, 3);
  rateChat(chatOff.learning, 'down', 1000, 3);
  chatOff.settings['ai.learning.chat'] = true;
  assert.equal(chatOff.learning.chatHint(), '');
  await chatOff.learning.flush();
});

test('learned data is saved and loaded again; clear erases it', async () => {
  const files = new Map<string, unknown>();
  const first = harness({ 'ai.learning': true }, files);
  accept(first.learning, 1, PREFIX, ' dog.', 2);
  await first.learning.flush();
  assert.ok(files.has('ai-learning.json'));

  const second = harness({ 'ai.learning': true }, files);
  await tick();
  assert.equal(second.learning.recall('plaintext', PREFIX), ' dog.');
  await second.learning.clear();
  assert.equal(files.has('ai-learning.json'), false);
  assert.equal(second.learning.recall('plaintext', PREFIX), null);
});
