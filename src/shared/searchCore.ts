/*
 * Pattern building and matching shared by the renderer (open tabs, marks) and
 * the Find in Files worker. Pure functions: no DOM and no Node-only API, so the
 * same file is a Node module and a plain renderer <script> (window.CodePadSearchCore).
 */
(function (root: { CodePadSearchCore?: CodePadSearchCoreApi }, factory: () => CodePadSearchCoreApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadSearchCore = factory();
  }
})(globalThis, function () {
  const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
  const WORD_AFTER = '(?![\\p{L}\\p{N}_])';
  const PREVIEW_CONTEXT = 100;
  const PREVIEW_LENGTH = 300;
  const TIME_CHECK_EVERY = 64;
  // Hard caps per findAll call (R-05): a single operation never reports or scans more than this.
  const MAX_MATCHES = 200000;
  const MAX_INPUT_CHARS = 20000000;
  const MAX_REGEX_LENGTH = 1000;
  // A repeat with no upper bound, or a bound this large, counts as unbounded for the catastrophic-shape check.
  const UNBOUNDED_REPEAT = 100;

  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /**
   * Expands the extended-search escapes \n \r \t \0 \\ \xHH \uHHHH.
   * @throws {SyntaxError} on an unknown or malformed escape.
   */
  function expandExtended(str: string): string {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      i++;
      const next = str[i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === '0') out += '\0';
      else if (next === '\\') out += '\\';
      else if (next === 'x' || next === 'u') {
        const digits = next === 'x' ? 2 : 4;
        const hex = str.slice(i + 1, i + 1 + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new SyntaxError('Malformed escape \\' + next + hex);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += digits;
      } else {
        throw new SyntaxError('Unknown escape \\' + (next === undefined ? '(end of text)' : next));
      }
    }
    return out;
  }

  /** Escapes a literal string for use inside a RegExp built with the u flag. */
  function escapeRegex(str: string): string {
    return str.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  /**
   * Builds a replacement function for one regex match (supports $$ $& $` $' $1..$99 $<name>).
   */
  function templateReplacer(rep: string): (match: RegExpExecArray) => string {
    return function (match: RegExpExecArray): string {
      return rep.replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (all: string, token: string) => {
        if (token === '$') return '$';
        if (token === '&') return match[0];
        if (token === '`') return match.input.slice(0, match.index);
        if (token === "'") return match.input.slice(match.index + match[0].length);
        if (token[0] === '<') {
          const value = match.groups ? match.groups[token.slice(1, -1)] : undefined;
          return value === undefined ? all : value;
        }
        const n = parseInt(token, 10);
        if (n >= 1 && n < match.length) return match[n] === undefined ? '' : match[n];
        if (token.length === 2) {
          const first = parseInt(token[0], 10);
          if (first >= 1 && first < match.length) {
            return (match[first] === undefined ? '' : match[first]) + token[1];
          }
        }
        return all;
      });
    };
  }

  // Bidi embedding/override/isolate marks, C0/C1 controls and DEL: they can reorder or hide part of a file name.
  const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

  /**
   * File name for display (tab titles, results, status): bidi controls and control characters removed so a
   * name such as `report<RLO>txt.exe` cannot spoof its extension. Not for paths that are passed to the file layer.
   */
  function displayName(name: string): string {
    return String(name).replace(UNSAFE_NAME_CHARS, '');
  }

  /** One open group while checkRegexShape scans a pattern. */
  interface ShapeFrame {
    unbounded: boolean;
    alternatives: Set<string>;
    duplicateAlternative: boolean;
    first: string;
    atAlternativeStart: boolean;
  }

  /**
   * Conservative ReDoS guard for user regexes (JavaScript regexes cannot be interrupted). Rejects an unbounded
   * repeat of a group that itself contains an unbounded repeat ((a+)+, (\w+\s?)*) and an unbounded repeat of a
   * group whose alternatives start the same way ((a|ab)*). Some harmless patterns are refused on purpose.
   * @returns an error message, or null when the pattern looks safe.
   */
  function checkRegexShape(source: string): string | null {
    if (source.length > MAX_REGEX_LENGTH) return 'The regular expression is too long (limit ' + MAX_REGEX_LENGTH + ' characters).';
    const newFrame = (): ShapeFrame => ({
      unbounded: false,
      alternatives: new Set<string>(),
      duplicateAlternative: false,
      first: '',
      atAlternativeStart: true
    });
    const stack: ShapeFrame[] = [newFrame()];
    const top = (): ShapeFrame => stack[stack.length - 1];
    const noteToken = (token: string): void => {
      const frame = top();
      if (frame.atAlternativeStart) {
        frame.first = token;
        frame.atAlternativeStart = false;
      }
    };
    // Reads a quantifier at `at`; returns its length and whether it is unbounded (length 0: none).
    const quantifierAt = (at: number): { length: number; unbounded: boolean } => {
      const ch = source[at];
      let length = 0;
      let unbounded = false;
      if (ch === '*' || ch === '+') {
        length = 1;
        unbounded = true;
      } else if (ch === '?') {
        length = 1;
      } else if (ch === '{') {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(at, at + 24));
        if (m) {
          length = m[0].length;
          unbounded = m[2] === ',' && (m[3] === '' || Number(m[3]) >= UNBOUNDED_REPEAT);
        }
      }
      if (length > 0 && (source[at + length] === '?')) length++;
      return { length, unbounded };
    };
    const message = 'This regular expression can take exponential time (a repeated group containing a repeat or overlapping alternatives). Simplify it.';
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      let atomIsGroup = false;
      let groupUnbounded = false;
      let groupDuplicate = false;
      if (ch === '\\') {
        const next = source[i + 1] ?? '';
        let end = i + 2;
        if ((next === 'p' || next === 'P') && source[end] === '{') {
          const close = source.indexOf('}', end);
          end = close === -1 ? source.length : close + 1;
        } else if (next === 'k' && source[end] === '<') {
          const close = source.indexOf('>', end);
          end = close === -1 ? source.length : close + 1;
        }
        noteToken(source.slice(i, end));
        i = end;
      } else if (ch === '[') {
        let end = i + 1;
        while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
        noteToken(source.slice(i, end + 1));
        i = end + 1;
      } else if (ch === '(') {
        stack.push(newFrame());
        i++;
        if (source[i] === '?') {
          // (?:  (?=  (?!  (?<=  (?<!  (?<name>
          i++;
          if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
            const close = source.indexOf('>', i);
            i = close === -1 ? source.length : close + 1;
          } else {
            i += source[i] === '<' ? 2 : 1;
          }
        }
        continue;
      } else if (ch === ')') {
        if (stack.length === 1) return null;
        const frame = stack.pop() as ShapeFrame;
        if (!frame.atAlternativeStart && frame.alternatives.has(frame.first)) frame.duplicateAlternative = true;
        atomIsGroup = true;
        groupUnbounded = frame.unbounded;
        groupDuplicate = frame.duplicateAlternative;
        i++;
      } else if (ch === '|') {
        const frame = top();
        if (frame.alternatives.has(frame.first)) frame.duplicateAlternative = true;
        frame.alternatives.add(frame.first);
        frame.first = '';
        frame.atAlternativeStart = true;
        i++;
        continue;
      } else {
        noteToken(ch);
        i++;
      }
      const q = quantifierAt(i);
      i += q.length;
      if (atomIsGroup) {
        if (q.unbounded && (groupUnbounded || groupDuplicate)) return message;
        // The group is one atom of its parent: it counts as an unbounded repeat when it is quantified so or contains one.
        noteToken('(');
        if (q.unbounded || groupUnbounded) top().unbounded = true;
      } else if (q.unbounded) {
        top().unbounded = true;
      }
    }
    return null;
  }

  /**
   * Compiles the user's search options.
   * Normal mode searches literally; extended mode first expands \n \r \t \0 \xHH \uHHHH
   * in the query and the replacement; regex mode passes the query to RegExp (multiline).
   */
  function buildMatcher(opts: SearchCoreOptions): SearchCoreMatcher | SearchCoreError {
    const query = opts && typeof opts.query === 'string' ? opts.query : '';
    if (!query) return { error: 'Nothing to search for.' };
    let source: string;
    try {
      if (opts.isRegex) source = query;
      else source = escapeRegex(opts.extended ? expandExtended(query) : query);
    } catch (err) {
      return { error: messageOf(err) };
    }
    if (opts.isRegex) {
      const unsafe = checkRegexShape(source);
      if (unsafe) return { error: unsafe };
    }
    if (opts.wholeWord) source = WORD_BEFORE + '(?:' + source + ')' + WORD_AFTER;
    let flags = 'gu';
    if (!opts.matchCase) flags += 'i';
    if (opts.isRegex) flags += 'm';
    if (opts.dotAll) flags += 's';
    let regex: RegExp;
    try {
      regex = new RegExp(source, flags);
    } catch (err) {
      return { error: 'Invalid pattern: ' + messageOf(err) };
    }
    return {
      regex,
      /**
       * @throws {SyntaxError} on a malformed extended escape.
       */
      makeReplacer(rep: string): (match: RegExpExecArray) => string {
        const text = opts.extended ? expandExtended(rep) : rep;
        if (!opts.isRegex) return () => text;
        return templateReplacer(text);
      }
    };
  }

  /**
   * Finds all matches. Positions are 1-based; lineText is the matching line cut to
   * at most 300 characters around the match and lineOffset is how many characters
   * were cut from the start of the line.
   *   at most MAX_MATCHES hits are returned and only the first MAX_INPUT_CHARS characters are searched;
   *   timeBudgetMs stops between matches (a single catastrophic match cannot be interrupted here);
   *   keepMatch adds the exec array as `match` (needed to build replacements).
   */
  function findAll(fullText: string, matcher: { regex: RegExp }, options?: SearchCoreFindOptions): SearchCoreHit[] {
    const opts = options || {};
    const text = fullText.length > MAX_INPUT_CHARS ? fullText.slice(0, MAX_INPUT_CHARS) : fullText;
    const limit = Math.min(opts.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity, MAX_MATCHES);
    const deadline = opts.timeBudgetMs !== undefined && opts.timeBudgetMs > 0 ? Date.now() + opts.timeBudgetMs : Infinity;
    const re = new RegExp(matcher.regex.source, matcher.regex.flags);
    const results: SearchCoreHit[] = [];
    let line = 1;
    let lineStart = 0;
    let scan = 0;
    let match: RegExpExecArray | null;
    while (results.length < limit && (match = re.exec(text)) !== null) {
      const index = match.index;
      let nl = text.indexOf('\n', scan);
      while (nl !== -1 && nl < index) {
        line++;
        lineStart = nl + 1;
        scan = lineStart;
        nl = text.indexOf('\n', scan);
      }
      let lineEnd = text.indexOf('\n', index);
      if (lineEnd === -1) lineEnd = text.length;
      const from = Math.max(lineStart, index - PREVIEW_CONTEXT);
      let to = Math.min(lineEnd, from + PREVIEW_LENGTH);
      if (to === lineEnd && to > from && text[to - 1] === '\r') to--;
      const found: SearchCoreHit = {
        index,
        length: match[0].length,
        line,
        col: index - lineStart + 1,
        lineText: text.slice(from, to),
        lineOffset: from - lineStart
      };
      if (opts.keepMatch) found.match = match;
      results.push(found);
      if (match[0].length === 0) {
        const cp = text.codePointAt(re.lastIndex);
        re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
      }
      if (results.length % TIME_CHECK_EVERY === 0 && Date.now() > deadline) break;
    }
    return results;
  }

  return { expandExtended, buildMatcher, findAll, displayName };
});
