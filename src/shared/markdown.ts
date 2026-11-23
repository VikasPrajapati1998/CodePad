/*
 * Markdown parser of the read-mode preview: source text in, a small node tree out (never HTML), so the renderer builds
 * the page with createElement and textContent only. Supported: ATX and setext headings, paragraphs, emphasis, strong,
 * strike-through, inline code, fenced and indented code, blockquotes, nested ordered/unordered/task lists, GFM tables,
 * rules, inline links, autolinks and bare http(s) links, images (alt text only), hard breaks, escapes and a few
 * entities. Not supported (shown as plain text): reference-style links, raw HTML, footnotes.
 * Work is bounded: the input is cut at MAX_INPUT, nesting at MAX_DEPTH, inline text is parsed in short segments and
 * every scan is linear or limited to a short window, so no input makes the parser blow up.
 * No DOM, no Node API: the same file is a Node module and a renderer <script> (window.CodePadMarkdown).
 * Types in types/markdown.d.ts.
 */
(function (root: { CodePadMarkdown?: CodePadMarkdownApi }, factory: () => CodePadMarkdownApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadMarkdown = factory();
  }
})(globalThis, () => {
  const MAX_INPUT = 400000;
  const MAX_DEPTH = 12;
  /** Inline text longer than this is parsed in pieces so that unmatched markers cannot cost quadratic time. */
  const INLINE_SEGMENT = 2000;
  const MAX_LINK_PART = 1500;
  const MAX_LABEL = 400;
  const MAX_TABLE_ROWS = 2000;
  const MAX_TABLE_COLUMNS = 64;
  const TAB_WIDTH = 4;

  const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,5});/y;
  const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

  interface ListMarker {
    indent: number;
    ordered: boolean;
    delimiter: string;
    number: number;
    /** Column where the item content starts. */
    contentIndent: number;
    /** The text after the marker (with extra indentation kept when it is an indented code block). */
    rest: string;
  }

  const isBlank = (line: string): boolean => line.trim() === '';
  const isSpace = (char: string): boolean => char === '' || char === ' ' || char === '\t' || char === '\n';
  const isAlnum = (char: string): boolean => char !== '' && /[\p{L}\p{N}]/u.test(char);

  function indentOf(line: string): number {
    let count = 0;
    while (line[count] === ' ') {
      count += 1;
    }
    return count;
  }

  /** Turns leading tabs into spaces so that indentation can be measured in columns. */
  function expandLeading(line: string): string {
    if (line[0] !== ' ' && line[0] !== '\t') {
      return line;
    }
    let column = 0;
    let index = 0;
    for (; index < line.length; index += 1) {
      if (line[index] === ' ') {
        column += 1;
      } else if (line[index] === '\t') {
        column += TAB_WIDTH - (column % TAB_WIDTH);
      } else {
        break;
      }
    }
    return ' '.repeat(column) + line.slice(index);
  }

  const stripIndent = (line: string, width: number): string => line.slice(Math.min(indentOf(line), width));

  /**
   * The link target when it is an http, https or mailto address.
   * @param href A raw link target.
   * @returns The normalized address, or null for anything else (javascript:, file:, relative paths, ...).
   */
  function safeHref(href: string): string | null {
    try {
      const url = new URL(href.trim());
      return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
    } catch {
      // Not an absolute URL (relative path, fragment, garbage): it is never turned into a link.
      return null;
    }
  }

  // ---------- Inline ----------

  /** Index of the backtick run of exactly `width` characters at or after `from`, or -1. */
  function findBacktickClose(text: string, from: number, width: number): number {
    let index = text.indexOf('`', from);
    while (index >= 0) {
      let run = 1;
      while (text[index + run] === '`') {
        run += 1;
      }
      if (run === width) {
        return index;
      }
      index = text.indexOf('`', index + run);
    }
    return -1;
  }

  function plainText(nodes: readonly CodePadMdInline[]): string {
    return nodes
      .map((node): string => {
        switch (node.type) {
          case 'text':
          case 'code':
            return node.value;
          case 'image':
            return node.alt;
          case 'br':
            return ' ';
          default:
            return plainText(node.children);
        }
      })
      .join('');
  }

  function decodeEntity(body: string): string | null {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : null;
    }
    const name = body.toLowerCase();
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : null;
  }

  /** Index of the `]` that closes the `[` at `open` (bounded window), or -1. */
  function findClosingBracket(text: string, open: number): number {
    let level = 0;
    const limit = Math.min(text.length, open + MAX_LABEL);
    for (let index = open; index < limit; index += 1) {
      const char = text[index];
      if (char === '\\') {
        index += 1;
      } else if (char === '`') {
        let run = 1;
        while (text[index + run] === '`') {
          run += 1;
        }
        const close = findBacktickClose(text, index + run, run);
        index = (close >= 0 && close < limit ? close + run : index + run) - 1;
      } else if (char === '[') {
        level += 1;
      } else if (char === ']') {
        level -= 1;
        if (level === 0) {
          return index;
        }
      }
    }
    return -1;
  }

  interface LinkMatch {
    label: string;
    href: string;
    end: number;
  }

  /** Parses `[label](target "title")` starting at the `[` at `open`. */
  function parseLinkAt(text: string, open: number): LinkMatch | null {
    const close = findClosingBracket(text, open);
    if (close < 0 || text[close + 1] !== '(') {
      return null;
    }
    let index = close + 2;
    while (text[index] === ' ' || text[index] === '\n') {
      index += 1;
    }
    let href = '';
    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1);
      if (end < 0 || end - index > MAX_LINK_PART || text.slice(index, end).includes('\n')) {
        return null;
      }
      href = text.slice(index + 1, end);
      index = end + 1;
    } else {
      const start = index;
      let level = 0;
      while (index < text.length && index - start < MAX_LINK_PART) {
        const char = text[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (isSpace(char)) {
          break;
        }
        if (char === '(') {
          level += 1;
        } else if (char === ')') {
          if (level === 0) {
            break;
          }
          level -= 1;
        }
        index += 1;
      }
      href = text.slice(start, index);
    }
    while (text[index] === ' ' || text[index] === '\n') {
      index += 1;
    }
    const quote = text[index];
    if (quote === '"' || quote === "'" || quote === '(') {
      const end = text.indexOf(quote === '(' ? ')' : quote, index + 1);
      if (end < 0 || end - index > MAX_LINK_PART) {
        return null;
      }
      index = end + 1;
      while (text[index] === ' ' || text[index] === '\n') {
        index += 1;
      }
    }
    if (text[index] !== ')') {
      return null;
    }
    return { label: text.slice(open + 1, close), href: href.replace(/\\([!-/:-@[-`{-~])/g, '$1'), end: index + 1 };
  }

  /** `<https://x>` or `<me@x.org>` at `open`; null when it is not an autolink. */
  function parseAutolink(text: string, open: number): { href: string; label: string; end: number } | null {
    const end = text.indexOf('>', open + 1);
    if (end < 0 || end - open > MAX_LINK_PART) {
      return null;
    }
    const inner = text.slice(open + 1, end);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) {
      return { href: inner, label: inner, end: end + 1 };
    }
    const at = inner.indexOf('@');
    const domain = inner.slice(at + 1);
    if (at > 0 && !/[\s<>@]/.test(inner.slice(0, at)) && !/[\s<>@]/.test(domain)
      && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')) {
      return { href: `mailto:${inner}`, label: inner, end: end + 1 };
    }
    return null;
  }

  /** A bare http(s) address at `start`; trailing punctuation and an unmatched `)` are not part of it. */
  function matchBareUrl(text: string, start: number): number {
    const head = text.slice(start, start + 8).toLowerCase();
    const prefix = head.startsWith('https://') ? 8 : head.startsWith('http://') ? 7 : 0;
    if (prefix === 0 || isAlnum(text[start - 1] ?? '')) {
      return -1;
    }
    let end = start + prefix;
    while (end < text.length && end - start < MAX_LINK_PART && !isSpace(text[end]) && text[end] !== '<') {
      end += 1;
    }
    for (;;) {
      const last = text[end - 1];
      if (end - start <= prefix) {
        return -1;
      }
      if (last !== undefined && '.,:;!?"\'*_~'.includes(last)) {
        end -= 1;
      } else if (last === ')') {
        const url = text.slice(start, end);
        if (url.split('(').length < url.split(')').length) {
          end -= 1;
        } else {
          return end;
        }
      } else {
        return end;
      }
    }
  }

  /** Start of the closing marker run of an emphasis opened with `width` characters, or -1. */
  function findCloser(text: string, from: number, marker: string, width: number): number {
    let index = from;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        let run = 1;
        while (text[index + run] === '`') {
          run += 1;
        }
        const close = findBacktickClose(text, index + run, run);
        index = close >= 0 ? close + run : index + run;
      } else if (char === marker) {
        let run = 1;
        while (text[index + run] === marker) {
          run += 1;
        }
        const canClose = !isSpace(text[index - 1] ?? '') && (marker !== '_' || !isAlnum(text[index + run] ?? ''));
        if (canClose && run === width) {
          return index;
        }
        index += run;
      } else {
        index += 1;
      }
    }
    return -1;
  }

  function wrapEmphasis(marker: string, width: number, children: CodePadMdInline[]): CodePadMdInline {
    if (marker === '~') {
      return { type: 'del', children };
    }
    if (width === 1) {
      return { type: 'em', children };
    }
    if (width === 2) {
      return { type: 'strong', children };
    }
    return { type: 'em', children: [{ type: 'strong', children }] };
  }

  function parseInline(text: string, depth: number, inLink: boolean): CodePadMdInline[] {
    if (depth >= MAX_DEPTH) {
      return text === '' ? [] : [{ type: 'text', value: text }];
    }
    const out: CodePadMdInline[] = [];
    let buffer = '';
    const flush = (): void => {
      if (buffer !== '') {
        out.push({ type: 'text', value: buffer });
        buffer = '';
      }
    };
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1] ?? '';
        if (next === '\n') {
          flush();
          out.push({ type: 'br' });
          index += 2;
        } else if (next !== '' && ESCAPABLE.includes(next)) {
          buffer += next;
          index += 2;
        } else {
          buffer += char;
          index += 1;
        }
      } else if (char === '\n') {
        if (buffer.endsWith('  ')) {
          buffer = buffer.trimEnd();
          flush();
          out.push({ type: 'br' });
        } else {
          buffer = buffer.trimEnd();
          buffer += ' ';
        }
        index += 1;
      } else if (char === '`') {
        let run = 1;
        while (text[index + run] === '`') {
          run += 1;
        }
        const close = findBacktickClose(text, index + run, run);
        if (close < 0) {
          buffer += '`'.repeat(run);
          index += run;
        } else {
          let code = text.slice(index + run, close).replace(/\n/g, ' ');
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
            code = code.slice(1, -1);
          }
          flush();
          out.push({ type: 'code', value: code });
          index = close + run;
        }
      } else if (char === '&') {
        ENTITY.lastIndex = index;
        const match = ENTITY.exec(text);
        const decoded = match ? decodeEntity(match[1]) : null;
        if (match && decoded !== null) {
          buffer += decoded;
          index += match[0].length;
        } else {
          buffer += char;
          index += 1;
        }
      } else if (char === '!' && text[index + 1] === '[') {
        const link = parseLinkAt(text, index + 1);
        if (link) {
          flush();
          out.push({ type: 'image', alt: plainText(parseInline(link.label, depth + 1, true)) });
          index = link.end;
        } else {
          buffer += char;
          index += 1;
        }
      } else if (char === '[' && !inLink) {
        const link = parseLinkAt(text, index);
        if (link) {
          flush();
          out.push({ type: 'link', href: link.href, children: parseInline(link.label, depth + 1, true) });
          index = link.end;
        } else {
          buffer += char;
          index += 1;
        }
      } else if (char === '<' && !inLink) {
        const link = parseAutolink(text, index);
        if (link) {
          flush();
          out.push({ type: 'link', href: link.href, children: [{ type: 'text', value: link.label }] });
          index = link.end;
        } else {
          buffer += char;
          index += 1;
        }
      } else if ((char === 'h' || char === 'H') && !inLink && matchBareUrl(text, index) > 0) {
        const end = matchBareUrl(text, index);
        const url = text.slice(index, end);
        flush();
        out.push({ type: 'link', href: url, children: [{ type: 'text', value: url }] });
        index = end;
      } else if (char === '*' || char === '_' || char === '~') {
        let run = 1;
        while (text[index + run] === char) {
          run += 1;
        }
        const width = char === '~' ? (run === 2 ? 2 : 0) : run <= 3 ? run : 0;
        const after = text[index + run] ?? '';
        const canOpen = width > 0 && !isSpace(after) && (char !== '_' || !isAlnum(text[index - 1] ?? ''));
        const close = canOpen ? findCloser(text, index + run, char, width) : -1;
        if (close < 0) {
          buffer += char.repeat(run);
          index += run;
        } else {
          flush();
          out.push(wrapEmphasis(char, width, parseInline(text.slice(index + run, close), depth + 1, inLink)));
          index = close + width;
        }
      } else {
        buffer += char;
        index += 1;
      }
    }
    flush();
    return out;
  }

  /** Parses inline text, in pieces when it is long. */
  function inlines(text: string): CodePadMdInline[] {
    if (text.length <= INLINE_SEGMENT) {
      return parseInline(text, 0, false);
    }
    const out: CodePadMdInline[] = [];
    let start = 0;
    while (start < text.length) {
      let cut = start + INLINE_SEGMENT;
      if (cut < text.length) {
        const space = text.indexOf(' ', cut);
        cut = space >= 0 && space < cut + 200 ? space + 1 : cut;
      }
      out.push(...parseInline(text.slice(start, cut), 0, false));
      start = cut;
    }
    return out;
  }

  // ---------- Blocks ----------

  interface Fence {
    char: string;
    width: number;
    indent: number;
    lang: string;
  }

  function fenceOpen(line: string): Fence | null {
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match || (match[2][0] === '`' && match[3].includes('`'))) {
      return null;
    }
    return { char: match[2][0], width: match[2].length, indent: match[1].length, lang: match[3].trim().split(/\s+/)[0] };
  }

  function isFenceClose(line: string, fence: Fence): boolean {
    const trimmed = line.trim();
    return indentOf(line) < 4 && trimmed.length >= fence.width && trimmed.split(fence.char).join('') === '';
  }

  function atxHeading(line: string): { level: number; text: string } | null {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (!match) {
      return null;
    }
    let text = line.slice(match[0].length).trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') {
      end -= 1;
    }
    if (end === 0) {
      text = '';
    } else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
      text = text.slice(0, end).trimEnd();
    }
    return { level: match[1].length, text };
  }

  const isRule = (line: string): boolean => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
  const isQuote = (line: string): boolean => /^ {0,3}>/.test(line);
  const setextLevel = (line: string): number => {
    const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    return match ? (match[1][0] === '=' ? 1 : 2) : 0;
  };

  function listMarker(line: string): ListMarker | null {
    const match = /^( {0,3})([-+*]|[0-9]{1,9}[.)])(?:([ \t]+)(.*)|$)/.exec(line);
    if (!match) {
      return null;
    }
    const indent = match[1].length;
    const token = match[2];
    const ordered = token.length > 1 || (token[0] >= '0' && token[0] <= '9');
    const spaces = match[3] ? match[3].length : 0;
    const rest = match[4] ?? '';
    let contentIndent = indent + token.length + (spaces === 0 || spaces > 4 || rest.trim() === '' ? 1 : spaces);
    let text = rest;
    if (spaces > 4 && rest.trim() !== '') {
      text = ' '.repeat(spaces - 1) + rest;
      contentIndent = indent + token.length + 1;
    }
    return {
      indent,
      ordered,
      delimiter: ordered ? token[token.length - 1] : token,
      number: ordered ? Number.parseInt(token, 10) : 0,
      contentIndent,
      rest: text,
    };
  }

  /** True when the line starts a block that may interrupt a paragraph. */
  function startsBlock(line: string): boolean {
    if (fenceOpen(line) || atxHeading(line) || isRule(line) || isQuote(line)) {
      return true;
    }
    const marker = listMarker(line);
    return marker !== null && marker.rest.trim() !== '' && (!marker.ordered || marker.number === 1);
  }

  function splitRow(line: string): string[] {
    let text = line.trim();
    if (text.startsWith('|')) {
      text = text.slice(1);
    }
    if (text.endsWith('|') && !text.endsWith('\\|')) {
      text = text.slice(0, -1);
    }
    const cells: string[] = [];
    let current = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\\' && text[index + 1] === '|') {
        current += '|';
        index += 1;
      } else if (char === '|') {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function delimiterRow(line: string): CodePadMdAlign[] | null {
    if (!line.includes('|') || !line.includes('-')) {
      return null;
    }
    const aligns: CodePadMdAlign[] = [];
    for (const cell of splitRow(line)) {
      if (!/^:?-+:?$/.test(cell)) {
        return null;
      }
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    }
    return aligns;
  }

  function parseTable(lines: string[], start: number, aligns: CodePadMdAlign[]): { block: CodePadMdBlock; next: number } {
    const columns = aligns.length;
    const cellsOf = (line: string): CodePadMdInline[][] => {
      const cells = splitRow(line);
      return Array.from({ length: columns }, (_, column) => inlines(cells[column] ?? ''));
    };
    const header = cellsOf(lines[start]);
    const rows: CodePadMdInline[][][] = [];
    let index = start + 2;
    while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index])) {
      if (rows.length < MAX_TABLE_ROWS) {
        rows.push(cellsOf(lines[index]));
      }
      index += 1;
    }
    return { block: { type: 'table', align: aligns, header, rows }, next: index };
  }

  function parseList(lines: string[], start: number, first: ListMarker, depth: number): { block: CodePadMdBlock; next: number } {
    const items: CodePadMdListItem[] = [];
    let index = start;
    let marker = first;
    for (;;) {
      const content: string[] = [marker.rest];
      index += 1;
      let afterBlank = false;
      let next: ListMarker | null = null;
      while (index < lines.length) {
        const line = lines[index];
        if (isBlank(line)) {
          content.push('');
          afterBlank = true;
          index += 1;
        } else if (indentOf(line) > marker.indent) {
          content.push(stripIndent(line, marker.contentIndent));
          afterBlank = false;
          index += 1;
        } else if (listMarker(line) && !isRule(line)) {
          next = listMarker(line);
          break;
        } else if (!afterBlank && !startsBlock(line)) {
          content.push(line.trimStart());
          index += 1;
        } else {
          break;
        }
      }
      while (content.length > 1 && content[content.length - 1] === '') {
        content.pop();
      }
      let checked: boolean | null = null;
      const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(content[0]);
      if (task) {
        checked = task[1] !== ' ';
        content[0] = content[0].slice(task[0].length);
      }
      items.push({ checked, children: parseBlocks(content, depth + 1) });
      if (!next || next.ordered !== first.ordered || next.delimiter !== first.delimiter) {
        break;
      }
      marker = next;
    }
    return { block: { type: 'list', ordered: first.ordered, start: first.number, items }, next: index };
  }

  function parseBlocks(lines: string[], depth: number): CodePadMdBlock[] {
    const blocks: CodePadMdBlock[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        index += 1;
        continue;
      }
      if (depth > MAX_DEPTH) {
        blocks.push({ type: 'paragraph', children: [{ type: 'text', value: lines.slice(index).join('\n').trim() }] });
        break;
      }
      const fence = fenceOpen(line);
      if (fence) {
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !isFenceClose(lines[index], fence)) {
          body.push(stripIndent(lines[index], fence.indent));
          index += 1;
        }
        index += 1;
        blocks.push({ type: 'code', lang: fence.lang, value: body.join('\n') });
        continue;
      }
      if (indentOf(line) >= 4) {
        const body: string[] = [];
        while (index < lines.length && (isBlank(lines[index]) || indentOf(lines[index]) >= 4)) {
          body.push(lines[index].slice(4));
          index += 1;
        }
        while (body.length > 0 && isBlank(body[body.length - 1])) {
          body.pop();
        }
        blocks.push({ type: 'code', lang: '', value: body.join('\n') });
        continue;
      }
      const heading = atxHeading(line);
      if (heading) {
        blocks.push({ type: 'heading', level: heading.level, children: inlines(heading.text) });
        index += 1;
        continue;
      }
      if (isRule(line)) {
        blocks.push({ type: 'rule' });
        index += 1;
        continue;
      }
      if (isQuote(line)) {
        const body: string[] = [];
        while (index < lines.length) {
          const current = lines[index];
          if (isQuote(current)) {
            body.push(current.replace(/^ {0,3}> ?/, ''));
          } else if (!isBlank(current) && body.length > 0 && !isBlank(body[body.length - 1]) && !startsBlock(current)) {
            body.push(current.trimStart());
          } else {
            break;
          }
          index += 1;
        }
        blocks.push({ type: 'quote', children: parseBlocks(body, depth + 1) });
        continue;
      }
      const marker = listMarker(line);
      if (marker) {
        const list = parseList(lines, index, marker, depth);
        blocks.push(list.block);
        index = list.next;
        continue;
      }
      const aligns = index + 1 < lines.length && line.includes('|') ? delimiterRow(lines[index + 1]) : null;
      if (aligns && aligns.length === splitRow(line).length && aligns.length <= MAX_TABLE_COLUMNS) {
        const table = parseTable(lines, index, aligns);
        blocks.push(table.block);
        index = table.next;
        continue;
      }
      const paragraph = [line.trimStart()];
      let level = 0;
      index += 1;
      while (index < lines.length && !isBlank(lines[index])) {
        level = setextLevel(lines[index]);
        if (level > 0) {
          index += 1;
          break;
        }
        if (startsBlock(lines[index])) {
          break;
        }
        paragraph.push(lines[index].trimStart());
        index += 1;
      }
      const text = paragraph.join('\n').trim();
      blocks.push(level > 0 ? { type: 'heading', level, children: inlines(text) } : { type: 'paragraph', children: inlines(text) });
    }
    return blocks;
  }

  /**
   * Parses Markdown into a node tree.
   * @param source The document text (cut at MAX_INPUT).
   * @returns The top-level blocks; an empty list for an empty or non-string source.
   */
  function parse(source: string): CodePadMdBlock[] {
    if (typeof source !== 'string' || source === '') {
      return [];
    }
    const text = (source.length > MAX_INPUT ? source.slice(0, MAX_INPUT) : source).replace(/^﻿/, '');
    return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n').map(expandLeading), 0);
  }

  return { MAX_INPUT, MAX_DEPTH, parse, safeHref };
});
