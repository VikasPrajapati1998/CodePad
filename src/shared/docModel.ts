/*
 * Document model of the AI document assistant: splits a text into blocks (headings, paragraphs, lists, code, tables,
 * quotes, rules) with ids that survive edits elsewhere, groups them into sections, understands places named in words
 * ("the second paragraph", "the section Pricing", "line 12") and builds an outline.
 * No AI, no DOM, no Node API: the same file is a Node module and a renderer <script> (window.CodePadDocModel).
 * Types in types/doc-model.d.ts.
 */
(function (root: { CodePadDocModel?: CodePadDocModelApi }, factory: () => CodePadDocModelApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadDocModel = factory();
  }
})(globalThis, () => {
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
  const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
  const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
  const TABLE = /^ {0,3}\|/;
  const QUOTE = /^ {0,3}>/;
  const INDENTED = /^(?: {2,}|\t)\S/;
  /** Kinds counted by "the second paragraph" (headings and rules are not paragraphs). */
  const PARAGRAPH_KINDS: ReadonlySet<CodePadBlockKind> = new Set<CodePadBlockKind>(['paragraph', 'list', 'quote', 'table', 'code']);

  const ORDINALS: Readonly<Record<string, number>> = Object.freeze({
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  });
  const ORDINAL =
    '(second[ -](?:to[ -])?last|penultimate|last|final|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d{1,3}(?:st|nd|rd|th))';
  /** Words that end a title named in words ("the Pricing section", "the section Pricing and ..."). */
  const STOP_WORDS: ReadonlySet<string> = new Set([
    'the', 'a', 'an', 'of', 'in', 'into', 'to', 'at', 'from', 'on', 'onto', 'this', 'that', 'these', 'those', 'it', 'its',
    'new', 'another', 'last', 'final', 'next', 'previous', 'current', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
    'seventh', 'eighth', 'ninth', 'tenth', 'whole', 'entire', 'end', 'start', 'beginning', 'top', 'bottom', 'and', 'or',
    'under', 'underneath', 'below', 'above', 'after', 'before', 'with', 'for', 'by', 'my', 'your', 'our', 'their', 'please',
    'add', 'write', 'insert', 'move', 'delete', 'remove', 'rewrite', 'put', 'append', 'prepend', 'paragraph', 'paragraphs',
    'section', 'sections', 'heading', 'headings', 'header', 'line', 'called', 'named', 'titled', 'about', 'then', 'so', 'as',
    'is', 'be', 'which', 'but', 'there', 'here', 'each', 'every', 'same', 'following', 'preceding', 'prior', 'one', 'me',
  ]);
  /** Articles that mark a section that is still to be created ("add a section called X"). */
  const CREATION_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'new', 'another']);

  const isBlank = (line: string): boolean => /^\s*$/.test(line);

  /**
   * FNV-1a 32-bit hash of the UTF-16 code units.
   * @param text Any text.
   * @returns 8 lowercase hex digits.
   */
  function hash(text: string): string {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, '0');
  }

  /** A line that ends a paragraph because another kind of block starts on it. */
  const startsBlock = (line: string): boolean =>
    FENCE_OPEN.test(line) || ATX.test(line) || RULE.test(line) || TABLE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);

  interface RawBlock {
    kind: CodePadBlockKind;
    level: number;
    /** 0-based first and last line (inclusive). */
    first: number;
    last: number;
  }

  function scanMarkdown(lines: readonly string[]): RawBlock[] {
    const blocks: RawBlock[] = [];
    const count = lines.length;
    let i = 0;
    while (i < count) {
      const line = lines[i];
      if (isBlank(line)) {
        i += 1;
        continue;
      }
      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        const marker = fence[1];
        const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
        let j = i + 1;
        while (j < count && !close.test(lines[j])) {
          j += 1;
        }
        let last = j < count ? j : count - 1;
        while (j >= count && last > i && isBlank(lines[last])) {
          last -= 1;
        }
        blocks.push({ kind: 'code', level: 0, first: i, last });
        i = last + 1;
        continue;
      }
      const atx = ATX.exec(line);
      if (atx) {
        blocks.push({ kind: 'heading', level: atx[1].length, first: i, last: i });
        i += 1;
        continue;
      }
      if (RULE.test(line)) {
        blocks.push({ kind: 'rule', level: 0, first: i, last: i });
        i += 1;
        continue;
      }
      if (TABLE.test(line)) {
        let j = i + 1;
        while (j < count && TABLE.test(lines[j])) {
          j += 1;
        }
        blocks.push({ kind: 'table', level: 0, first: i, last: j - 1 });
        i = j;
        continue;
      }
      if (QUOTE.test(line)) {
        let j = i + 1;
        while (j < count && !isBlank(lines[j]) && (QUOTE.test(lines[j]) || !startsBlock(lines[j]))) {
          j += 1;
        }
        blocks.push({ kind: 'quote', level: 0, first: i, last: j - 1 });
        i = j;
        continue;
      }
      if (LIST_ITEM.test(line)) {
        let j = i + 1;
        while (j < count) {
          if (!isBlank(lines[j])) {
            if (LIST_ITEM.test(lines[j]) || INDENTED.test(lines[j]) || !startsBlock(lines[j])) {
              j += 1;
              continue;
            }
            break;
          }
          // A blank line inside a loose list: the list goes on when the next text is an item or an indented line.
          let k = j;
          while (k < count && isBlank(lines[k])) {
            k += 1;
          }
          if (k < count && (LIST_ITEM.test(lines[k]) || INDENTED.test(lines[k])) && !RULE.test(lines[k])) {
            j = k;
            continue;
          }
          break;
        }
        blocks.push({ kind: 'list', level: 0, first: i, last: j - 1 });
        i = j;
        continue;
      }
      let j = i + 1;
      let setext = 0;
      while (j < count && !isBlank(lines[j])) {
        const underline = SETEXT.exec(lines[j]);
        if (underline) {
          setext = underline[1][0] === '=' ? 1 : 2;
          break;
        }
        if (startsBlock(lines[j])) {
          break;
        }
        j += 1;
      }
      if (setext > 0) {
        blocks.push({ kind: 'heading', level: setext, first: i, last: j });
        i = j + 1;
      } else {
        blocks.push({ kind: 'paragraph', level: 0, first: i, last: j - 1 });
        i = j;
      }
    }
    return blocks;
  }

  function scanPlain(lines: readonly string[]): RawBlock[] {
    const blocks: RawBlock[] = [];
    let i = 0;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i += 1;
        continue;
      }
      let j = i;
      let allItems = true;
      while (j < lines.length && !isBlank(lines[j])) {
        allItems = allItems && LIST_ITEM.test(lines[j]);
        j += 1;
      }
      blocks.push({ kind: allItems ? 'list' : 'paragraph', level: 0, first: i, last: j - 1 });
      i = j;
    }
    return blocks;
  }

  /** The title of a heading block (ATX markers or the setext underline removed). */
  function headingTitle(block: CodePadBlock): string {
    const lines = block.text.split('\n');
    const atx = ATX.exec(lines[0]);
    if (atx && lines.length === 1) {
      return (atx[2] ?? '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '').trim();
    }
    return lines
      .slice(0, -1)
      .map((line) => line.trim())
      .join(' ')
      .trim();
  }

  /**
   * Parses a document into blocks and sections.
   * @param input The text (CR LF and lone CR are read as LF).
   * @param languageId 'markdown' enables Markdown structure; anything else gets paragraphs and simple lists.
   * @returns The document with its version hash.
   */
  function parse(input: string, languageId: string): CodePadDocument {
    const text = input.replace(/\r\n?/g, '\n');
    const markdown = languageId === 'markdown';
    const lines = text.split('\n');
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const raw = markdown ? scanMarkdown(lines) : scanPlain(lines);
    const seen = new Map<string, number>();
    const stack: CodePadBlock[] = [];
    const blocks: CodePadBlock[] = raw.map((item, index) => {
      const start = lineStarts[item.first];
      const end = lineStarts[item.last] + lines[item.last].length;
      const blockText = text.slice(start, end);
      const key = `${item.kind}\0${blockText.replace(/\s+/g, ' ').trim()}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      if (item.kind === 'heading') {
        while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
          stack.pop();
        }
      }
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const block: CodePadBlock = {
        id: `b${hash(key)}-${occurrence}`,
        kind: item.kind,
        level: item.level,
        start,
        end,
        startLine: item.first + 1,
        endLine: item.last + 1,
        text: blockText,
        sectionId: parent ? parent.id : null,
        index,
      };
      if (item.kind === 'heading') {
        stack.push(block);
      }
      return block;
    });
    const sections: CodePadDocSection[] = [];
    blocks.forEach((block, index) => {
      if (block.kind !== 'heading') {
        return;
      }
      const blockIds = [block.id];
      for (let next = index + 1; next < blocks.length; next += 1) {
        if (blocks[next].kind === 'heading' && blocks[next].level <= block.level) {
          break;
        }
        blockIds.push(blocks[next].id);
      }
      sections.push({ id: block.id, title: headingTitle(block), level: block.level, parentId: block.sectionId, blockIds });
    });
    return { version: hash(text), text, markdown, blocks, sections };
  }

  /**
   * The block at an offset.
   * @param doc Parsed document.
   * @param offset UTF-16 offset (a cursor at the end of a block's last line is inside it).
   * @returns The block that contains `offset`, else the nearest block before it, else null.
   */
  function blockAt(doc: CodePadDocument, offset: number): CodePadBlock | null {
    let before: CodePadBlock | null = null;
    for (const block of doc.blocks) {
      if (offset >= block.start && offset <= block.end) {
        return block;
      }
      if (block.end < offset) {
        before = block;
      } else {
        break;
      }
    }
    return before;
  }

  function ordinalValue(word: string): number | null {
    const value = word.toLowerCase().replace(/-/g, ' ');
    if (value in ORDINALS) {
      return ORDINALS[value];
    }
    if (/^\d/.test(value)) {
      const number = Number.parseInt(value, 10);
      return number >= 1 ? number : null;
    }
    if (value === 'last' || value === 'final') {
      return -1;
    }
    if (value === 'penultimate' || /^second (?:to )?last$/.test(value)) {
      return -2;
    }
    return null;
  }

  const cleanWord = (word: string): string => word.replace(/^["“”'‘’(]+/, '').replace(/["“”'‘’),.;:!?]+$/, '');

  /** Up to `max` title words right after `text` starts, until punctuation or a stop word. */
  function wordsAfter(text: string, max: number): string {
    const clause = /^[^,;:!?()\n]*?(?=\.(?:\s|$)|[,;:!?()\n]|$)/.exec(text);
    const words = (clause ? clause[0] : '').trim().split(/\s+/).filter((word) => word !== '');
    let index = 0;
    while (index < words.length && /^(?:called|named|titled)$/i.test(words[index])) {
      index += 1;
    }
    const kept: string[] = [];
    for (; index < words.length && kept.length < max; index += 1) {
      const word = cleanWord(words[index]);
      if (word === '' || STOP_WORDS.has(word.toLowerCase())) {
        break;
      }
      kept.push(word);
    }
    return kept.join(' ');
  }

  /** Up to `max` title words right before the end of `text`, until punctuation or a stop word. */
  function wordsBefore(text: string, max: number): { title: string; previous: string } {
    const clause = /[^,;:!?()\n]*$/.exec(text);
    const words = (clause ? clause[0] : '').trim().split(/\s+/).filter((word) => word !== '');
    const kept: string[] = [];
    let index = words.length - 1;
    for (; index >= 0 && kept.length < max; index -= 1) {
      const word = cleanWord(words[index]);
      if (word === '' || STOP_WORDS.has(word.toLowerCase())) {
        break;
      }
      kept.unshift(word);
    }
    return { title: kept.join(' '), previous: index >= 0 ? cleanWord(words[index]).toLowerCase() : '' };
  }

  interface Candidate {
    index: number;
    ref: CodePadBlockRef;
  }

  function collect(sentence: string, pattern: RegExp, build: (match: RegExpExecArray) => CodePadBlockRef | null, into: Candidate[]): void {
    for (const match of sentence.matchAll(pattern)) {
      const ref = build(match);
      if (ref) {
        into.push({ index: match.index ?? 0, ref });
      }
    }
  }

  /**
   * The first place a sentence names. Block places (paragraphs, headings, sections, lines, the cursor) win over
   * "at the start / end", so "at the end of the second paragraph" names the paragraph.
   * @param sentence The user's words.
   * @returns The reference, or null when the sentence names no place.
   */
  function parseRef(sentence: string): CodePadBlockRef | null {
    const found: Candidate[] = [];
    collect(sentence, new RegExp(`\\b${ORDINAL}\\s+(?:paragraph|para)\\b`, 'gi'), (match) => {
      const index = ordinalValue(match[1]);
      return index === null ? null : { kind: 'paragraph', index };
    }, found);
    collect(sentence, /\b(?:paragraph|para)\s+(?:number\s+|no\.?\s*|#\s*)?(\d{1,4})\b/gi, (match) => {
      const index = Number.parseInt(match[1], 10);
      return index >= 1 ? { kind: 'paragraph', index } : null;
    }, found);
    collect(sentence, /\b(?:previous|preceding|prior|above)\s+paragraph\b|\bparagraph\s+(?:above|before this one)\b/gi, () => ({ kind: 'previous' }), found);
    collect(sentence, /\b(?:next|following|below)\s+paragraph\b|\bparagraph\s+(?:below|after this one)\b/gi, () => ({ kind: 'next' }), found);
    collect(sentence, /\b(?:this|current|present)\s+paragraph\b|\bparagraph\s+(?:i am|i'm) in\b/gi, () => ({ kind: 'current' }), found);
    collect(sentence, /\b(?:last|final)\s+section\b/gi, () => ({ kind: 'lastSection' }), found);
    collect(sentence, /\bline\s+(?:number\s+|no\.?\s*|#\s*)?(\d{1,7})\b/gi, (match) => {
      const line = Number.parseInt(match[1], 10);
      return line >= 1 ? { kind: 'line', line } : null;
    }, found);
    const quotedSpans: Array<[number, number]> = [];
    collect(sentence, /\b(heading|header|title|section)\s+(?:called\s+|named\s+|titled\s+)?["“'‘]([^"”'’\n]{1,80})["”'’]/gi, (match) => {
      quotedSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
      const title = match[2].trim();
      return title === '' ? null : { kind: match[1].toLowerCase() === 'section' ? 'section' : 'heading', title };
    }, found);
    collect(sentence, /["“]([^"”\n]{1,80})["”]\s+(heading|header|section)\b/gi, (match) => {
      quotedSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
      const title = match[1].trim();
      return title === '' ? null : { kind: match[2].toLowerCase() === 'section' ? 'section' : 'heading', title };
    }, found);
    const inQuoted = (index: number): boolean => quotedSpans.some(([from, to]) => index >= from && index < to);
    collect(sentence, /\b(heading|header|section)\b/gi, (match) => {
      const at = match.index ?? 0;
      if (inQuoted(at)) {
        return null;
      }
      const before = wordsBefore(sentence.slice(0, at), 4);
      if (before.title === '' && CREATION_WORDS.has(before.previous)) {
        return null;
      }
      const title = before.title !== '' ? before.title : wordsAfter(sentence.slice(at + match[0].length), 6);
      if (title === '') {
        return null;
      }
      return { kind: match[1].toLowerCase() === 'section' ? 'section' : 'heading', title };
    }, found);
    collect(sentence, /\bunder(?:neath)?\s+(?:the\s+)?(?:(?:heading|header|section)\s+)?/gi, (match) => {
      const at = (match.index ?? 0) + match[0].length;
      const quoted = /^["“'‘]([^"”'’\n]{1,80})["”'’]/.exec(sentence.slice(at));
      const title = quoted ? quoted[1].trim() : wordsAfter(sentence.slice(at), 6);
      return title === '' ? null : { kind: 'section', title };
    }, found);
    if (found.length > 0) {
      found.sort((a, b) => a.index - b.index);
      return found[0].ref;
    }
    const edges: Candidate[] = [];
    collect(sentence, /\b(?:at|to|in|on)\s+the\s+(?:very\s+)?(?:start|beginning|top)\b|\bat\s+(?:the\s+)?top\b/gi, () => ({ kind: 'start' }), edges);
    collect(sentence, /\b(?:at|to|in|on)\s+the\s+(?:very\s+)?(?:end|bottom)\b|\bat\s+(?:the\s+)?bottom\b/gi, () => ({ kind: 'end' }), edges);
    edges.sort((a, b) => a.index - b.index);
    return edges.length > 0 ? edges[0].ref : null;
  }

  const normalizeTitle = (title: string): string =>
    title
      .toLowerCase()
      .replace(/[*_`"“”'‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.:;,!?]+$/, '');

  /** The section whose title matches: exactly, else one whose title contains the words, else the longest title the words contain. */
  function findSection(doc: CodePadDocument, title: string): CodePadDocSection | null {
    const query = normalizeTitle(title);
    if (query === '') {
      return null;
    }
    const titled = doc.sections.map((section) => ({ section, title: normalizeTitle(section.title) })).filter((entry) => entry.title !== '');
    const exact = titled.find((entry) => entry.title === query);
    if (exact) {
      return exact.section;
    }
    const containing = titled.find((entry) => entry.title.includes(query));
    if (containing) {
      return containing.section;
    }
    const contained = titled
      .filter((entry) => entry.title.length >= 3 && new RegExp(`(?:^|\\W)${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\W|$)`).test(query))
      .sort((a, b) => b.title.length - a.title.length);
    return contained.length > 0 ? contained[0].section : null;
  }

  function sectionBlocks(doc: CodePadDocument, section: CodePadDocSection): CodePadBlock[] {
    const ids = new Set(section.blockIds);
    return doc.blocks.filter((block) => ids.has(block.id));
  }

  /** The last section at the document's main section level (a lone leading top heading counts as the title). */
  function lastSection(doc: CodePadDocument): CodePadDocSection | null {
    if (doc.sections.length === 0) {
      return null;
    }
    let level = Math.min(...doc.sections.map((section) => section.level));
    const top = doc.sections.filter((section) => section.level === level);
    if (top.length === 1 && top[0] === doc.sections[0] && doc.sections.length > 1) {
      level = Math.min(...doc.sections.slice(1).map((section) => section.level));
    }
    const atLevel = doc.sections.filter((section) => section.level === level);
    return atLevel[atLevel.length - 1];
  }

  /**
   * The blocks a reference names.
   * @param doc Parsed document.
   * @param ref Reference from {@link parseRef}.
   * @param cursorOffset Cursor offset for 'current' / 'previous' / 'next'.
   * @returns The blocks ('section' returns the whole section, heading first); empty when nothing matches.
   */
  function resolve(doc: CodePadDocument, ref: CodePadBlockRef, cursorOffset?: number): CodePadBlock[] {
    const paragraphs = doc.blocks.filter((block) => PARAGRAPH_KINDS.has(block.kind));
    switch (ref.kind) {
      case 'paragraph': {
        const position = ref.index > 0 ? ref.index - 1 : paragraphs.length + ref.index;
        const block = Number.isInteger(position) && position >= 0 ? paragraphs[position] : undefined;
        return block ? [block] : [];
      }
      case 'heading': {
        const section = findSection(doc, ref.title);
        const heading = section ? doc.blocks.find((block) => block.id === section.id) : undefined;
        return heading ? [heading] : [];
      }
      case 'section': {
        const section = findSection(doc, ref.title);
        return section ? sectionBlocks(doc, section) : [];
      }
      case 'lastSection': {
        const section = lastSection(doc);
        return section ? sectionBlocks(doc, section) : [];
      }
      case 'current':
      case 'previous':
      case 'next': {
        if (cursorOffset === undefined) {
          return [];
        }
        const here = blockAt(doc, cursorOffset);
        if (ref.kind === 'current') {
          return here ? [here] : [];
        }
        if (ref.kind === 'previous') {
          const earlier = here ? paragraphs.filter((block) => block.index < here.index) : [];
          return earlier.length > 0 ? [earlier[earlier.length - 1]] : [];
        }
        const later = paragraphs.find((block) => (here ? block.index > here.index : block.start >= cursorOffset));
        return later ? [later] : [];
      }
      case 'line': {
        const block = doc.blocks.find((item) => ref.line >= item.startLine && ref.line <= item.endLine);
        return block ? [block] : [];
      }
      case 'start':
        return doc.blocks.length > 0 ? [doc.blocks[0]] : [];
      case 'end':
        return doc.blocks.length > 0 ? [doc.blocks[doc.blocks.length - 1]] : [];
      default:
        return [];
    }
  }

  /**
   * Table of contents of the headings.
   * @param doc Parsed document.
   * @returns A nested Markdown bullet list ('  ' per level below the top level found), '' when there are no headings.
   */
  function outline(doc: CodePadDocument): string {
    if (doc.sections.length === 0) {
      return '';
    }
    const top = Math.min(...doc.sections.map((section) => section.level));
    return doc.sections.map((section) => `${'  '.repeat(section.level - top)}- ${section.title}`).join('\n');
  }

  return { hash, parse, blockAt, parseRef, resolve, outline };
});
