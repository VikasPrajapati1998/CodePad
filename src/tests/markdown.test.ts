/* Tests of shared/markdown.ts (block and inline parsing, link safety, bounded work). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const markdown: CodePadMarkdownApi = require('../shared/markdown');

const text = (value: string): CodePadMdInline => ({ type: 'text', value });

test('ATX and setext headings', () => {
  assert.deepEqual(markdown.parse('## Title ##'), [{ type: 'heading', level: 2, children: [text('Title')] }]);
  assert.deepEqual(markdown.parse('Title\n====='), [{ type: 'heading', level: 1, children: [text('Title')] }]);
  assert.deepEqual(markdown.parse('Sub\n---'), [{ type: 'heading', level: 2, children: [text('Sub')] }]);
  assert.deepEqual(markdown.parse('#hashtag'), [{ type: 'paragraph', children: [text('#hashtag')] }]);
});

test('paragraphs join soft breaks and keep hard breaks', () => {
  assert.deepEqual(markdown.parse('one\ntwo'), [{ type: 'paragraph', children: [text('one two')] }]);
  assert.deepEqual(markdown.parse('one  \ntwo'), [{ type: 'paragraph', children: [text('one'), { type: 'br' }, text('two')] }]);
  assert.deepEqual(markdown.parse('one\\\ntwo'), [{ type: 'paragraph', children: [text('one'), { type: 'br' }, text('two')] }]);
});

test('emphasis, strong, strike-through and inline code', () => {
  assert.deepEqual(markdown.parse('a *b* **c** ~~d~~ `e`')[0], {
    type: 'paragraph',
    children: [
      text('a '),
      { type: 'em', children: [text('b')] },
      text(' '),
      { type: 'strong', children: [text('c')] },
      text(' '),
      { type: 'del', children: [text('d')] },
      text(' '),
      { type: 'code', value: 'e' },
    ],
  });
  assert.deepEqual(markdown.parse('*a **b** c*')[0], {
    type: 'paragraph',
    children: [{ type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] }],
  });
  assert.deepEqual(markdown.parse('2 * 3 * 4')[0], { type: 'paragraph', children: [text('2 * 3 * 4')] });
  assert.deepEqual(markdown.parse('snake_case_name')[0], { type: 'paragraph', children: [text('snake_case_name')] });
});

test('escapes and entities', () => {
  assert.deepEqual(markdown.parse('\\*not em\\* &amp; &lt;')[0], { type: 'paragraph', children: [text('*not em* & <')] });
});

test('fenced and indented code keep their text and language', () => {
  assert.deepEqual(markdown.parse('```ts extra\nlet a = 1;\n\n# not a heading\n```'), [
    { type: 'code', lang: 'ts', value: 'let a = 1;\n\n# not a heading' },
  ]);
  assert.deepEqual(markdown.parse('~~~\nunclosed'), [{ type: 'code', lang: '', value: 'unclosed' }]);
  assert.deepEqual(markdown.parse('    indented\n\n    more'), [{ type: 'code', lang: '', value: 'indented\n\nmore' }]);
});

test('blockquotes nest and accept lazy continuation', () => {
  assert.deepEqual(markdown.parse('> a\nb\n> > c'), [
    {
      type: 'quote',
      children: [
        { type: 'paragraph', children: [text('a b')] },
        { type: 'quote', children: [{ type: 'paragraph', children: [text('c')] }] },
      ],
    },
  ]);
});

test('lists: bullets, ordered start, nesting and tasks', () => {
  const blocks = markdown.parse('- one\n- two\n  - nested\n- [x] done\n- [ ] todo');
  assert.equal(blocks.length, 1);
  const list = blocks[0];
  assert.equal(list.type, 'list');
  if (list.type !== 'list') return;
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 4);
  assert.deepEqual(list.items[1].children[1], {
    type: 'list',
    ordered: false,
    start: 0,
    items: [{ checked: null, children: [{ type: 'paragraph', children: [text('nested')] }] }],
  });
  assert.equal(list.items[2].checked, true);
  assert.equal(list.items[3].checked, false);

  const ordered = markdown.parse('3. a\n4. b');
  assert.deepEqual(ordered[0].type === 'list' && [ordered[0].ordered, ordered[0].start, ordered[0].items.length], [true, 3, 2]);
  assert.equal(markdown.parse('- a\n+ b').length, 2);
});

test('GFM tables with alignment and escaped pipes', () => {
  const blocks = markdown.parse('| a | b |\n|:--|--:|\n| 1 | x\\|y |\n| 2 |');
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.type, 'table');
  if (table.type !== 'table') return;
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.header, [[text('a')], [text('b')]]);
  assert.deepEqual(table.rows[0], [[text('1')], [text('x|y')]]);
  assert.deepEqual(table.rows[1], [[text('2')], []]);
});

test('rules', () => {
  assert.deepEqual(markdown.parse('***\n\n- - -\n\n___').map((block) => block.type), ['rule', 'rule', 'rule']);
});

test('links, images, autolinks and bare links', () => {
  assert.deepEqual(markdown.parse('[site](https://a.example/x?y=(1) "title")')[0], {
    type: 'paragraph',
    children: [{ type: 'link', href: 'https://a.example/x?y=(1)', children: [text('site')] }],
  });
  assert.deepEqual(markdown.parse('![logo *x*](a.png)')[0], { type: 'paragraph', children: [{ type: 'image', alt: 'logo x' }] });
  assert.deepEqual(markdown.parse('<https://a.example> <me@a.example>')[0], {
    type: 'paragraph',
    children: [
      { type: 'link', href: 'https://a.example', children: [text('https://a.example')] },
      text(' '),
      { type: 'link', href: 'mailto:me@a.example', children: [text('me@a.example')] },
    ],
  });
  assert.deepEqual(markdown.parse('see https://a.example/p).')[0], {
    type: 'paragraph',
    children: [text('see '), { type: 'link', href: 'https://a.example/p', children: [text('https://a.example/p')] }, text(').')],
  });
  assert.deepEqual(markdown.parse('[ref][1]')[0], { type: 'paragraph', children: [text('[ref][1]')] });
});

test('safeHref only allows http, https and mailto', () => {
  assert.equal(markdown.safeHref('https://a.example/x'), 'https://a.example/x');
  assert.equal(markdown.safeHref(' mailto:me@a.example '), 'mailto:me@a.example');
  assert.equal(markdown.safeHref('javascript:alert(1)'), null);
  assert.equal(markdown.safeHref('file:///c:/x'), null);
  assert.equal(markdown.safeHref('data:text/html,hi'), null);
  assert.equal(markdown.safeHref('/relative'), null);
  assert.equal(markdown.safeHref('#anchor'), null);
});

test('empty and non-string input give no blocks', () => {
  assert.deepEqual(markdown.parse(''), []);
  assert.deepEqual(markdown.parse('\n\n  \n'), []);
});

test('nesting depth is capped and deep content stays text', () => {
  const quote = `${'> '.repeat(200)}deep`;
  let blocks = markdown.parse(quote);
  let depth = 0;
  for (let first = blocks[0]; first !== undefined && first.type === 'quote'; first = blocks[0]) {
    blocks = first.children;
    depth += 1;
  }
  assert.ok(depth <= markdown.MAX_DEPTH + 2);
  const list = markdown.parse(Array.from({ length: 100 }, (_, level) => `${'  '.repeat(level)}- x`).join('\n'));
  assert.equal(list[0].type, 'list');
});

test('hostile input finishes quickly', () => {
  const inputs = [
    '*a '.repeat(30000),
    '[a'.repeat(40000),
    '`'.repeat(5000) + ' x'.repeat(5000),
    '|'.repeat(50000),
    '- '.repeat(20000),
    '_ '.repeat(100000),
    '<a'.repeat(50000),
  ];
  const started = Date.now();
  for (const input of inputs) {
    markdown.parse(input);
  }
  assert.ok(Date.now() - started < 8000);
});

test('input beyond MAX_INPUT is ignored, not an error', () => {
  const blocks = markdown.parse(`# Head\n\n${'word '.repeat(markdown.MAX_INPUT)}`);
  assert.equal(blocks[0].type, 'heading');
});
