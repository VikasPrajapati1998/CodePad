/*
 * Pure text logic of the AI ghost-text suggestions, shared by the renderer (context extraction: header, enclosing
 * scope, text after the cursor) and the main process (trimming a raw model completion to a complete sentence or
 * statement, dropping repeats). No DOM, no Node API: the same file is a Node module and a renderer <script>
 * (window.CodePadSuggestText). Everything is deterministic so it can be tested without the model.
 */
(function (root: { CodePadSuggestText?: CodePadSuggestTextApi }, factory: () => CodePadSuggestTextApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadSuggestText = factory();
  }
})(globalThis, () => {
  const PROSE_LANGUAGES = new Set(['plaintext', 'markdown', 'mdx', 'restructuredtext', 'rst', 'latex', 'tex', 'asciidoc', 'text', 'log']);
  const HASH_LANGUAGES = new Set([
    'python', 'ruby', 'shell', 'shellscript', 'bash', 'sh', 'zsh', 'yaml', 'perl', 'r', 'powershell', 'toml', 'ini',
    'makefile', 'dockerfile', 'coffeescript', 'elixir', 'julia', 'nim', 'properties',
  ]);
  const DASH_LANGUAGES = new Set(['sql', 'plsql', 'pgsql', 'mysql', 'lua', 'haskell', 'ada', 'vhdl']);
  const NO_COMMENT_LANGUAGES = new Set(['json', 'html', 'xml', 'svg', 'csv', 'tsv', 'handlebars']);
  const SEMICOLON_LANGUAGES = new Set([
    'c', 'cpp', 'csharp', 'java', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'php', 'rust',
    'css', 'scss', 'less', 'objective-c', 'objective-cpp', 'dart', 'glsl', 'hlsl',
  ]);
  const ALWAYS_SEMICOLONS = new Set(['css', 'scss', 'less']);

  const MAX_LINES_CODE = 8;
  const MAX_LINES_PROSE = 3;
  const MAX_CHARS = 300;
  const MAX_CHARS_MULTILINE = 600;
  const HEADER_MAX_CHARS = 800;
  const HEADER_SCAN_LINES = 60;
  const SCOPE_MAX_LINES = 4;
  const SCOPE_LINE_CHARS = 160;
  const SCOPE_MAX_CHARS = 600;
  const SCOPE_SCAN_LINES = 600;
  const HEADING_SCAN_LINES = 500;
  const SUFFIX_MAX_CHARS = 1200;
  const SUFFIX_MIN_LINES = 3;
  const RECENT_LINES = 8;
  const MIN_DUP_CHARS = 8;
  const MIN_DUP_SENTENCE = 15;
  const CONTEXT_SENTENCE_CHARS = 1500;
  const STOP_MIN = 10;
  const STOP_MAX = 40;
  const TAB_WIDTH = 4;

  const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  const ABBREVIATIONS = new Set([
    'e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'prof', 'vs', 'cf', 'fig', 'no', 'inc', 'ltd', 'st', 'approx', 'etc', 'al', 'sr', 'jr',
  ]);
  const DANGLING_WORDS =
    /(?:^|\s)(?:a|an|the|of|in|on|at|to|for|with|by|from|and|or|but|that|which|who|whom|whose|is|are|was|were|be|been|as|than|then|if|when|while|because|into|over|about|between|has|have|had|will|would|can|could|not|its|their|his|her|our|your|my|this|these|those|such|some|any|each|every|per|via|so|nor|yet)$/i;
  const CODE_DANGLING_WORDS = /(?:^|\s)(?:and|or|not|in|is|if|else|elif|while|for|with|as|from|import|return|lambda)$/;
  const IMPORT_LINE =
    /^\s*(?:#\s*(?:include|import|define|pragma|ifndef|ifdef|endif)\b|import\b|from\s+\S+\s+import\b|using\b|use\b|package\b|require\b|(?:const|let|var)\s+.+=\s*require\(|extern\s+crate\b|@import\b|<\?php|namespace\b|['"]use strict['"]|#!)/;
  const IMPORT_STRICT =
    /^(?:#\s*(?:include|import)\b|import\s+\S|from\s+\S+\s+import\b|using\s+[\w.]+\s*;|use\s+[\w:\\]+|package\s+[\w.]+|extern\s+crate\b)/;
  const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*|--|"""|#(?!\s*(?:include|import|define|pragma|if|ifdef|ifndef|else|endif)\b)|;)/;
  const SIGNATURE_KEYWORD = /^(?:def|class|function|func|fn|interface|struct|enum|impl|trait|module|namespace)\s+\S/;
  const SIGNATURE_C =
    /^[A-Za-z_][\w:<>,*&[\]]*[\s*&]+[A-Za-z_~][\w:<>~]*\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{\s*)?$/;
  const NOT_SIGNATURE = /^(?:return|if|else|while|for|switch|case|new|delete|throw|do|goto|using|typedef|print|echo)\b/;
  const LIST_OR_HEADING = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/;
  const MARKDOWN_HEADING = /^#{1,6}\s+\S/;

  const kindOf = (languageId: string): SuggestKind => (PROSE_LANGUAGES.has(languageId) ? 'prose' : 'code');

  function commentLeader(languageId: string): string {
    if (PROSE_LANGUAGES.has(languageId) || NO_COMMENT_LANGUAGES.has(languageId)) {
      return '';
    }
    if (HASH_LANGUAGES.has(languageId)) {
      return '#';
    }
    return DASH_LANGUAGES.has(languageId) ? '--' : '//';
  }

  const indentOf = (line: string): number => {
    let width = 0;
    for (const char of line) {
      if (char === ' ') {
        width += 1;
      } else if (char === '\t') {
        width += TAB_WIDTH;
      } else {
        break;
      }
    }
    return width;
  };

  const cap = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

  // ---------------------------------------------------------------- context extraction (renderer)

  /** Import-like lines of the file top (only when the prefix window no longer reaches line 1). */
  function codeHeader(input: SuggestExtractInput): string {
    const out: string[] = [];
    const last = Math.min(input.windowStartLine - 1, HEADER_SCAN_LINES, input.lineCount);
    for (let n = 1; n <= last; n += 1) {
      const line = input.getLine(n);
      if (IMPORT_LINE.test(line)) {
        out.push(line.trimEnd());
      } else if (line.trim() !== '' && !COMMENT_ONLY.test(line)) {
        break;
      }
    }
    let total = 0;
    const kept: string[] = [];
    for (const line of out) {
      if (total + line.length + 1 > HEADER_MAX_CHARS) {
        break;
      }
      kept.push(line);
      total += line.length + 1;
    }
    return kept.join('\n');
  }

  /** Front matter and the nearest heading above the prefix window (or a short first-line title). */
  function proseHeader(input: SuggestExtractInput): string {
    const parts: string[] = [];
    if (input.windowStartLine > 1 && input.getLine(1).trim() === '---') {
      for (let n = 2; n <= Math.min(20, input.lineCount, input.windowStartLine - 1); n += 1) {
        if (input.getLine(n).trim() === '---') {
          const front: string[] = [];
          for (let m = 1; m <= n; m += 1) {
            front.push(input.getLine(m).trimEnd());
          }
          if (front.join('\n').length <= 400) {
            parts.push(front.join('\n'));
          }
          break;
        }
      }
    }
    let heading = '';
    for (let n = input.windowStartLine - 1; n >= Math.max(1, input.windowStartLine - HEADING_SCAN_LINES); n -= 1) {
      const line = input.getLine(n);
      if (MARKDOWN_HEADING.test(line)) {
        heading = line.trim();
        break;
      }
    }
    if (heading === '' && input.windowStartLine > 1 && input.languageId !== 'markdown') {
      const first = input.getLine(1).trim();
      if (first !== '' && first.length <= 100 && input.lineCount >= 2 && input.getLine(2).trim() === '') {
        heading = first;
      }
    }
    if (heading !== '') {
      parts.push(heading);
    }
    return cap(parts.join('\n'), HEADER_MAX_CHARS);
  }

  /** The enclosing declarations (class, function, ...) that lie above the prefix window, found by indentation. */
  function enclosingScope(input: SuggestExtractInput, leader: string): string {
    let current = input.cursorLine;
    while (current > 1 && input.getLine(current).trim() === '') {
      current -= 1;
    }
    let minIndent = indentOf(input.getLine(current));
    const found: { n: number; text: string }[] = [];
    const first = Math.max(1, current - SCOPE_SCAN_LINES);
    for (let n = current - 1; n >= first && minIndent > 0 && found.length < SCOPE_MAX_LINES; n -= 1) {
      const line = input.getLine(n);
      const text = line.trim();
      if (text === '') {
        continue;
      }
      const indent = indentOf(line);
      const skip = /^[})\]]/.test(text) || (leader !== '' && text.startsWith(leader)) || COMMENT_ONLY.test(line);
      if (indent < minIndent && !skip) {
        found.unshift({ n, text: cap(line.trimEnd(), SCOPE_LINE_CHARS) });
        minIndent = indent;
      }
    }
    const kept: string[] = [];
    let total = 0;
    for (const entry of found) {
      if (entry.n < input.windowStartLine && total + entry.text.length + 1 <= SCOPE_MAX_CHARS) {
        kept.push(entry.text);
        total += entry.text.length + 1;
      }
    }
    return kept.join('\n');
  }

  /** Text after the cursor line: to the end of the enclosing block for code, a fixed amount for prose. */
  function textAfter(input: SuggestExtractInput, kind: SuggestKind): string {
    let base = 0;
    if (kind === 'code') {
      let current = input.cursorLine;
      while (current > 1 && input.getLine(current).trim() === '') {
        current -= 1;
      }
      base = indentOf(input.getLine(current));
    }
    const lines: string[] = [];
    let total = 0;
    for (let n = input.cursorLine + 1; n <= input.lineCount && total < SUFFIX_MAX_CHARS; n += 1) {
      const line = input.getLine(n).trimEnd();
      lines.push(line);
      total += line.length + 1;
      if (kind === 'code' && line.trim() !== '' && indentOf(line) < base && lines.filter((l) => l.trim() !== '').length >= SUFFIX_MIN_LINES - 1) {
        break;
      }
    }
    return cap(lines.join('\n').trimStart(), SUFFIX_MAX_CHARS);
  }

  function extractContext(input: SuggestExtractInput): SuggestContextParts {
    const kind = kindOf(input.languageId);
    return {
      header: kind === 'prose' ? proseHeader(input) : codeHeader(input),
      scope: kind === 'code' ? enclosingScope(input, commentLeader(input.languageId)) : '',
      suffix: textAfter(input, kind),
    };
  }

  /** Stop strings that end generation as soon as the model starts to repeat the line after the cursor. */
  function suggestStops(suffix: string): string[] {
    const first = suffix.split('\n').map((line) => line.trim()).find((line) => line !== '');
    return first !== undefined && first.length >= STOP_MIN && first.length <= STOP_MAX && /[\p{L}\p{N}]/u.test(first) ? [first] : [];
  }

  // ---------------------------------------------------------------- bracket scanner (code)

  interface ScanState {
    stack: string[];
    state: 'code' | 'line' | 'block' | 'string';
    quote: string;
    broken: boolean;
  }

  /** Walks `text` tracking brackets, strings and comments. `lenient` ignores stray or mismatched closers. */
  function scan(text: string, leader: string, init: ScanState, lenient: boolean): ScanState {
    const stack = [...init.stack];
    let { state, quote } = init;
    let broken = init.broken;
    const blockComments = leader === '//';
    const triple = leader === '#';
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (state === 'line') {
        if (char === '\n') {
          state = 'code';
        }
      } else if (state === 'block') {
        if (text.startsWith('*/', i)) {
          state = 'code';
          i += 1;
        }
      } else if (state === 'string') {
        if (char === '\\') {
          i += 1;
        } else if (quote.length === 3) {
          if (text.startsWith(quote, i)) {
            state = 'code';
            i += 2;
          }
        } else if (char === quote || (char === '\n' && quote !== '`')) {
          state = 'code';
        }
      } else if (leader !== '' && text.startsWith(leader, i)) {
        state = 'line';
      } else if (blockComments && text.startsWith('/*', i)) {
        state = 'block';
        i += 1;
      } else if (char === '"' || char === "'" || char === '`') {
        state = 'string';
        if (triple && text.startsWith(char.repeat(3), i)) {
          quote = char.repeat(3);
          i += 2;
        } else {
          quote = char;
        }
      } else if (char in OPENERS) {
        stack.push(char);
      } else if (char in CLOSERS) {
        if (stack.length > 0 && stack[stack.length - 1] === CLOSERS[char]) {
          stack.pop();
        } else if (!lenient && stack.length > 0) {
          broken = true;
        }
      }
    }
    return { stack, state, quote, broken };
  }

  /** The text of `line` without a trailing comment that starts outside a string. */
  function stripLineComment(line: string, leader: string): string {
    if (leader === '') {
      return line;
    }
    const probe = scan(line, '', { stack: [], state: 'code', quote: '', broken: false }, true);
    if (probe.state === 'code' && !line.includes(leader)) {
      return line;
    }
    let quote = '';
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quote !== '') {
        if (char === '\\') {
          i += 1;
        } else if (char === quote) {
          quote = '';
        }
      } else if (line.startsWith(leader, i)) {
        return line.slice(0, i);
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      }
    }
    return line;
  }

  /** Whether the code uses `;` as a statement terminator (judged from the lines before the cursor). */
  function usesSemicolons(prefix: string, languageId: string): boolean {
    if (!SEMICOLON_LANGUAGES.has(languageId)) {
      return false;
    }
    if (ALWAYS_SEMICOLONS.has(languageId)) {
      return true;
    }
    const leader = commentLeader(languageId);
    const lines = prefix.split('\n').slice(0, -1).slice(-40);
    let semis = 0;
    let bare = 0;
    for (const raw of lines) {
      const line = stripLineComment(raw, leader).trim();
      if (line.endsWith(';')) {
        semis += 1;
      } else if (/[\w)\]'"`]$/.test(line) && !/^(?:if|for|while|else|switch|catch)\b/.test(line)) {
        bare += 1;
      }
    }
    return !(semis === 0 && bare >= 3);
  }

  // ---------------------------------------------------------------- repeat removal

  const normalizeSentence = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const squash = (text: string): string => text.trim().replace(/\s+/g, ' ');

  function isSignature(trimmed: string): boolean {
    return !NOT_SIGNATURE.test(trimmed) && (SIGNATURE_KEYWORD.test(trimmed) || SIGNATURE_C.test(trimmed));
  }

  /** The text up to (not including) the first line that repeats text already in the file; null when line 0 does. */
  function dropRepeatedLines(text: string, ctx: SuggestTrimContext): string | null {
    const prefixLines = ctx.prefix.split('\n');
    const lastPrefixLine = prefixLines[prefixLines.length - 1];
    const before = prefixLines.slice(0, -1);
    const recent = new Set(
      before
        .map((line) => squash(line))
        .filter((line) => line.length >= MIN_DUP_CHARS)
        .slice(-RECENT_LINES)
    );
    const suffixLines = ctx.suffix.split('\n').map((line) => squash(line)).filter((line) => line !== '');
    const following = new Set(suffixLines.slice(0, RECENT_LINES).filter((line) => line.length >= MIN_DUP_CHARS));
    const everything = [...ctx.header.split('\n'), ...ctx.scope.split('\n'), ...before, ...suffixLines].map((line) => squash(line));
    const imports = new Set(everything.filter((line) => IMPORT_STRICT.test(line)));
    const signatures = new Set(everything.filter((line) => line !== '' && isSignature(line)));
    let previous = '';
    for (let i = before.length - 1; i >= 0; i -= 1) {
      const line = squash(before[i]);
      if (line !== '') {
        previous = line;
        break;
      }
    }
    if (ctx.header.trim() !== '' && previous === '') {
      previous = squash(ctx.header.split('\n').pop() ?? '');
    }
    const lines = text.split('\n');
    for (let j = 0; j < lines.length; j += 1) {
      const probe = squash(j === 0 ? lastPrefixLine + lines[j] : lines[j]);
      if (probe !== '') {
        const importLine = IMPORT_STRICT.test(probe);
        const importMisplaced =
          importLine && previous !== '' && !IMPORT_LINE.test(previous) && !COMMENT_ONLY.test(previous) && !/^#/.test(previous);
        const repeated =
          (probe.length >= MIN_DUP_CHARS && (recent.has(probe) || following.has(probe))) ||
          (importLine && (imports.has(probe) || importMisplaced)) ||
          (isSignature(probe) && signatures.has(probe));
        if (repeated) {
          return j === 0 ? null : lines.slice(0, j).join('\n').trimEnd();
        }
        previous = probe;
      }
    }
    return text;
  }

  // ---------------------------------------------------------------- prose

  /** Offsets just after each sentence end (terminator plus closing quotes/brackets) in `text`. */
  function sentenceEnds(text: string): number[] {
    const ends: number[] = [];
    const pattern = /[.!?…]+["”’')\]*_`]*(?=\s|$)/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const before = text.slice(0, match.index);
      let skip = false;
      if (match[0].startsWith('.') && !/^\.+[!?]/.test(match[0]) && !match[0].startsWith('..')) {
        const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? '';
        skip = ABBREVIATIONS.has(word.toLowerCase()) || (word.length === 1 && /[A-Z]/.test(word));
        skip = skip || /(?:^|\n)[ \t]*\d{1,3}$/.test(before);
      }
      if (!skip) {
        ends.push(match.index + match[0].length);
      }
    }
    return ends;
  }

  /** The unfinished sentence at the end of `prefix` (its current paragraph). */
  function openSentence(prefix: string): string {
    const paragraph = prefix.slice(prefix.lastIndexOf('\n\n') + 2);
    const ends = sentenceEnds(paragraph);
    return ends.length > 0 ? paragraph.slice(ends[ends.length - 1]) : paragraph;
  }

  function countOf(text: string, pattern: RegExp): number {
    return (text.match(pattern) ?? []).length;
  }

  /** Whether `span` leaves no new quote, bracket or code span open (closing what the paragraph opened is fine). */
  function proseBalanced(span: string, paragraph: string): boolean {
    let depth = Math.max(0, countOf(paragraph, /\(/g) - countOf(paragraph, /\)/g));
    const allowed = depth;
    for (const char of span) {
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth < 0) {
          return false;
        }
      }
    }
    const brackets = countOf(span, /\[/g) - countOf(span, /\]/g);
    const straight = countOf(span, /"/g);
    const wasQuoted = countOf(paragraph, /"/g) % 2 === 1;
    const curly = countOf(span, /“/g) - countOf(span, /”/g);
    const curlyAllowed = Math.max(0, countOf(paragraph, /“/g) - countOf(paragraph, /”/g));
    return (
      depth <= allowed &&
      brackets <= 0 &&
      (wasQuoted || straight % 2 === 0) &&
      curly <= 0 &&
      curly >= -curlyAllowed &&
      countOf(span, /`/g) % 2 === 0 &&
      countOf(span, /\*\*/g) % 2 === 0
    );
  }

  const isDangling = (text: string): boolean => /[,;:\-–—(\[]$/.test(text) || DANGLING_WORDS.test(text);

  /** Cuts `text` to the first complete sentence (two in multiline mode); null when none is complete and clean. */
  function trimProse(text: string, ctx: SuggestTrimContext, truncated: boolean, commentMode: boolean): string | null {
    const maxChars = ctx.multiline ? MAX_CHARS_MULTILINE : MAX_CHARS;
    const paragraph = ctx.prefix.slice(ctx.prefix.lastIndexOf('\n\n') + 2);
    const partial = openSentence(ctx.prefix);
    const known = new Set<string>();
    for (const source of [ctx.prefix.slice(-CONTEXT_SENTENCE_CHARS), ctx.suffix]) {
      const ends = sentenceEnds(source);
      let from = 0;
      for (const end of [...ends, source.length]) {
        const sentence = normalizeSentence(source.slice(from, end));
        if (sentence.length >= MIN_DUP_SENTENCE) {
          known.add(sentence);
        }
        from = end;
      }
    }
    const repeats = (span: string): boolean => {
      const ends = sentenceEnds(span);
      let from = 0;
      for (const end of [...ends, span.length]) {
        const own = normalizeSentence((from === 0 ? partial : '') + span.slice(from, end));
        if (own.length >= MIN_DUP_SENTENCE && known.has(own)) {
          return true;
        }
        from = end;
      }
      return false;
    };
    const valid = (span: string): boolean =>
      span.length <= maxChars && /[\p{L}\p{N}]/u.test(span) && proseBalanced(span, paragraph) && !repeats(span);

    const ends = sentenceEnds(text).filter((end) => end <= text.length);
    let best = -1;
    for (const end of ends) {
      if (valid(text.slice(0, end).trimEnd())) {
        best = end;
        break;
      }
    }
    if (best >= 0 && ctx.multiline) {
      for (const end of ends) {
        if (end > best && !text.slice(best, end).includes('\n\n') && valid(text.slice(0, end).trimEnd())) {
          best = end;
          break;
        }
      }
    }
    if (best >= 0) {
      return text.slice(0, best).trimEnd();
    }
    const lastLine = ctx.prefix.slice(ctx.prefix.lastIndexOf('\n') + 1);
    const unterminatedOk = commentMode || LIST_OR_HEADING.test(lastLine);
    const whole = text.trimEnd();
    return !truncated && unterminatedOk && !isDangling(whole) && valid(whole) ? whole : null;
  }

  // ---------------------------------------------------------------- code

  const lastLine = (prefix: string): string => prefix.slice(prefix.lastIndexOf('\n') + 1);

  /** Whether the code line (comment removed) is a complete statement or construct. */
  function lineComplete(
    rawLine: string,
    leader: string,
    semicolons: boolean,
    brackets: boolean,
    openBrace: boolean,
    colonOk: boolean
  ): boolean {
    const line = rawLine.trim();
    if (line === '' || COMMENT_ONLY.test(rawLine) || (/^#/.test(line) && leader !== '#')) {
      return true;
    }
    const code = stripLineComment(rawLine, leader).trim();
    if (code === '') {
      return true;
    }
    const last = code[code.length - 1];
    if (last === '{' && openBrace) {
      return true;
    }
    if (!brackets || (last === ':' && !colonOk)) {
      return false;
    }
    if (semicolons) {
      return last === ';' || last === '}' || /^(?:case\b.*|default|public|private|protected):$/.test(code);
    }
    if ((last === ':' && colonOk) || last === '}' || last === ']' || last === ')') {
      return true;
    }
    return !/[,+\-*/=&|.(\[{\\<>]$/.test(code) && !CODE_DANGLING_WORDS.test(code);
  }

  /** Cuts `text` after the last complete statement/line whose brackets are balanced. */
  function trimCode(text: string, ctx: SuggestTrimContext, truncated: boolean, semicolons: boolean): string | null {
    const leader = commentLeader(ctx.languageId);
    const maxChars = ctx.multiline ? MAX_CHARS_MULTILINE : MAX_CHARS;
    const init = scan(ctx.prefix, leader, { stack: [], state: 'code', quote: '', broken: false }, true);
    const baseDepth = init.stack.length;
    const colonOk = !NO_COMMENT_LANGUAGES.has(ctx.languageId);
    const limit = Math.min(text.length, maxChars);
    const cuts = new Set<number>();
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\n') {
        cuts.add(i);
      } else if (semicolons && (char === ';' || char === '}' || char === '{')) {
        cuts.add(i + 1);
      }
    }
    if (!truncated) {
      cuts.add(text.length);
    }
    const lineStartOf = (p: number): number => text.lastIndexOf('\n', p - 1) + 1;
    const ordered = [...cuts].filter((p) => p > 0 && p <= limit).sort((a, b) => b - a);
    for (const p of ordered) {
      const head = text.slice(0, p);
      const result = scan(head, leader, init, false);
      if (result.broken || result.state === 'string' || result.state === 'block' || result.stack.length > baseDepth + 1) {
        continue;
      }
      const openBrace = result.stack.length === baseDepth + 1 && result.stack[result.stack.length - 1] === '{' && /\{\s*$/.test(head);
      const balanced = result.stack.length <= baseDepth || openBrace;
      const lineStart = lineStartOf(p);
      const lineText = head.slice(lineStart);
      const fullLine = lineStart === 0 ? lastLine(ctx.prefix) + lineText : lineText;
      const continuesInSuffix = p === text.length && ctx.suffixLine.trim() !== '';
      const wholeLine = p === text.length || text[p] === '\n';
      const trailingComma = baseDepth > 0 && /,\s*$/.test(stripLineComment(lineText, leader));
      const complete = wholeLine
        ? lineComplete(fullLine, leader, semicolons && !continuesInSuffix, balanced, openBrace, colonOk) || (trailingComma && balanced)
        : balanced && /[;{}]$/.test(head);
      if (complete && head.trim() !== '') {
        return head.trimEnd();
      }
    }
    return null;
  }

  /** Cuts a suggestion that continues a string literal at the closing quote. */
  function trimString(text: string, state: ScanState, truncated: boolean): string | null {
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\\') {
        i += 1;
      } else if (text.startsWith(state.quote, i)) {
        const end = i + state.quote.length;
        return text.slice(0, end + (/^[)\]};,]*/.exec(text.slice(end))?.[0].length ?? 0)).trimEnd();
      }
    }
    return truncated ? null : text.trimEnd();
  }

  // ---------------------------------------------------------------- entry point

  function trimSuggestion(raw: string, ctx: SuggestTrimContext): string | null {
    const kind = kindOf(ctx.languageId);
    const maxLines = ctx.multiline ? (kind === 'code' ? MAX_LINES_CODE : MAX_LINES_PROSE) : 1;
    const allLines = raw.replace(/\r\n?/g, '\n').split('\n');
    let truncated = ctx.truncated && allLines.length <= maxLines;
    let text = allLines.slice(0, maxLines).join('\n').trimEnd();

    if (ctx.prefix !== '' && !ctx.prefix.endsWith('\n') && /[ \t]$/.test(ctx.prefix)) {
      text = text.replace(/^[ \t]+/, '');
    }
    const rest = ctx.suffixLine.trim();
    if (rest !== '' && /^[\s)\]}'"`>;,]*$/.test(ctx.suffixLine)) {
      const chars = Array.from(rest);
      let out = text;
      for (;;) {
        const index = out.length > 0 ? chars.indexOf(out[out.length - 1]) : -1;
        if (index < 0) {
          break;
        }
        chars.splice(index, 1);
        out = out.slice(0, -1);
      }
      if (out.length < text.length) {
        text = out.trimEnd();
        truncated = false;
      }
    }
    if (text.trim() === '' || !/[\p{L}\p{N}]/u.test(text)) {
      return null;
    }
    if (rest !== '' && text.trim().startsWith(rest)) {
      return null;
    }
    const nextLine = ctx.suffix.split('\n').map((line) => line.trim()).find((line) => line !== '');
    if (nextLine !== undefined && nextLine.length >= MIN_DUP_CHARS) {
      const at = text.indexOf(nextLine);
      if (at >= 0) {
        text = text.slice(0, at).trimEnd();
        truncated = false;
      }
    }
    if (text.trim() === '' || ctx.suffix.trimStart().startsWith(text.trim())) {
      return null;
    }

    let result: string | null;
    const init = scan(ctx.prefix, commentLeader(ctx.languageId), { stack: [], state: 'code', quote: '', broken: false }, true);
    if (kind === 'prose') {
      result = trimProse(text, ctx, truncated, false);
    } else {
      const deduped = dropRepeatedLines(text, ctx);
      if (deduped === null || deduped.trim() === '') {
        return null;
      }
      if (deduped.length < text.length) {
        truncated = false;
      }
      if (init.state === 'line' || init.state === 'block') {
        result = trimProse(deduped, ctx, truncated, true);
      } else if (init.state === 'string') {
        result = trimString(deduped, init, truncated);
      } else {
        result = trimCode(deduped, ctx, truncated, usesSemicolons(ctx.prefix, ctx.languageId));
      }
    }
    return result !== null && result.trim() !== '' && /[\p{L}\p{N}]/u.test(result) ? result : null;
  }

  return { languageKind: kindOf, commentLeader, extractContext, suggestStops, trimSuggestion, sentenceEnds };
});
