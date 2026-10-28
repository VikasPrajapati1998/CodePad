'use strict';

// Text tools: line operations, sorts, case conversion, blank operations,
// date/time insertion, read-only toggle and redaction. Line-based commands go
// through ctx.text.transformLines, case/redact through ctx.text.transformSelections
// (one undo stop each); the editor is never cached, ctx.editor is read per call.
(() => {
  const DATE_FORMAT_KEY = 'codepad.dateFormat';
  const DEFAULT_DATE_FORMAT = 'yyyy-MM-dd HH:mm:ss';
  const DEFAULT_WRAP_WIDTH = 80;
  const REDACT_CHAR = '█';

  let lastWrapWidth = DEFAULT_WRAP_WIDTH;

  const register = (id: string, run: (ctx: CodePadCtx) => void | Promise<void>): void => CodePadCommands.register({ id, run });

  // ---- randomness (crypto only) -------------------------------------------

  function fillRandom(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    }
    return bytes;
  }

  /** Unbiased random integer in [0, n). */
  function randomInt(n: number): number {
    const limit = 0x100000000 - (0x100000000 % n);
    const word = new Uint32Array(1);
    do {
      crypto.getRandomValues(word);
    } while (word[0] >= limit);
    return word[0] % n;
  }

  // ---- line helpers -------------------------------------------------------

  function tabSizeOf(ctx: CodePadCtx): number {
    const model = ctx.editor.getModel();
    return model ? model.getOptions().tabSize : 4;
  }

  function lineOp(id: string, fn: (lines: string[]) => string[]): void {
    register(id, (ctx) => {
      ctx.text.transformLines(fn, { scope: 'selectionOrDocument' });
    });
  }

  function wrapLine(line: string, width: number): string[] {
    if (line.length <= width) return [line];
    const words = line.trim().split(/\s+/);
    if (words[0] === '') return [line];
    const lead = /^\s*/.exec(line)?.[0] ?? '';
    const indent = lead.length < width ? lead : '';
    const out: string[] = [];
    let current = lead + words[0];
    for (let i = 1; i < words.length; i += 1) {
      if (current.length + 1 + words[i].length <= width) {
        current += ` ${words[i]}`;
      } else {
        out.push(current);
        current = indent + words[i];
      }
    }
    out.push(current);
    return out;
  }

  function expandTabs(line: string, tabSize: number): string {
    if (!line.includes('\t')) return line;
    let out = '';
    for (const ch of line) {
      out += ch === '\t' ? ' '.repeat(tabSize - (out.length % tabSize)) : ch;
    }
    return out;
  }

  function spacesToTabsLeading(line: string, tabSize: number): string {
    const lead = /^[ \t]+/.exec(line);
    if (!lead) return line;
    const width = expandTabs(lead[0], tabSize).length;
    return '\t'.repeat(Math.floor(width / tabSize)) + ' '.repeat(width % tabSize) + line.slice(lead[0].length);
  }

  // Runs of two or more spaces are replaced by tabs where they reach a tab stop.
  function spacesToTabsAll(line: string, tabSize: number): string {
    if (!line.includes('  ')) return line;
    let out = '';
    let col = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ') {
        let j = i;
        while (line[j] === ' ') j += 1;
        const end = col + (j - i);
        if (j - i >= 2) {
          let pos = col;
          let stop = (Math.floor(pos / tabSize) + 1) * tabSize;
          while (stop <= end) {
            out += '\t';
            pos = stop;
            stop += tabSize;
          }
          out += ' '.repeat(end - pos);
        } else {
          out += ' ';
        }
        col = end;
        i = j;
      } else {
        col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1;
        out += ch;
        i += 1;
      }
    }
    return out;
  }

  // ---- sorting ------------------------------------------------------------

  const collator = new Intl.Collator(undefined, { numeric: true });
  const compare = <K extends string | number>(a: K, b: K): number => (a < b ? -1 : a > b ? 1 : 0);
  const numberKey = (pattern: RegExp, normalize: (s: string) => string) => (line: string): number => {
    const match = pattern.exec(line);
    return match ? Number(normalize(match[1] as string)) : -Infinity;
  };

  /** Sorts the lines ascending, or descending when the flag is set. */
  type LineSorter = (lines: string[], descending: boolean) => string[];

  /** [ascending id, descending id, sorter built from the sort key of a line and the comparison of two keys] */
  function sortSpec<K>(
    ascId: string,
    descId: string,
    keyOf: (line: string) => K,
    cmp: (a: K, b: K) => number,
  ): [string, string, LineSorter] {
    return [ascId, descId, (lines, descending) => sortLines(lines, keyOf, cmp, descending)];
  }

  const SORTS: [string, string, LineSorter][] = [
    sortSpec('sortAsc', 'sortDesc', (l) => l, compare),
    sortSpec('sortCaseInsensitive', 'sortCaseInsensitiveDesc', (l) => l.toLowerCase(), compare),
    sortSpec('sortByLength', 'sortByLengthDesc', (l) => l.length, compare),
    sortSpec('sortInteger', 'sortIntegerDesc', numberKey(/^\s*([+-]?\d+)/, (s) => s), compare),
    sortSpec('sortDecimalDot', 'sortDecimalDotDesc', numberKey(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/, (s) => s), compare),
    sortSpec('sortDecimalComma', 'sortDecimalCommaDesc',
      numberKey(/^\s*([+-]?(?:\d+(?:,\d*)?|,\d+))/, (s) => s.replace(',', '.')), compare),
    sortSpec('sortLocale', 'sortLocaleDesc', (l) => l, (a, b) => collator.compare(a, b)),
  ];

  function sortLines<K>(lines: string[], keyOf: (line: string) => K, cmp: (a: K, b: K) => number, descending: boolean): string[] {
    const sign = descending ? -1 : 1;
    return lines
      .map((line) => ({ line, key: keyOf(line) }))
      .sort((a, b) => sign * cmp(a.key, b.key))
      .map((entry) => entry.line);
  }

  // ---- case conversion ----------------------------------------------------

  const upperFirst = (word: string): string => {
    const first = String.fromCodePoint(word.codePointAt(0) ?? 0);
    return first.toUpperCase() + word.slice(first.length);
  };

  const toProper = (s: string): string => s.toLowerCase().replace(/\p{L}[\p{L}\p{M}\p{N}'’]*/gu, upperFirst);

  const toSentence = (s: string): string =>
    s.toLowerCase().replace(/(^\s*|[.!?]["')\]]*\s+)(\p{Ll})/gu, (_: string, lead: string, letter: string) => lead + letter.toUpperCase());

  function toInverted(s: string): string {
    let out = '';
    for (const ch of s) {
      const upper = ch.toUpperCase();
      const lower = ch.toLowerCase();
      if (ch === upper && ch !== lower) out += lower;
      else if (ch === lower && ch !== upper) out += upper;
      else out += ch;
    }
    return out;
  }

  function toRandom(s: string): string {
    const chars = Array.from(s);
    const bits = fillRandom(new Uint8Array(chars.length));
    return chars.map((ch, i) => ((bits[i] & 1) === 0 ? ch.toLowerCase() : ch.toUpperCase())).join('');
  }

  function caseOp(id: string, fn: (text: string) => string, label: string): void {
    register(id, (ctx) => {
      ctx.text.transformSelections((text) => fn(text), { scope: 'wordOrSelection', label });
    });
  }

  // ---- date / time --------------------------------------------------------

  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

  function formatDate(date: Date, format: string): string {
    const tokens: Record<string, string> = {
      yyyy: pad(date.getFullYear(), 4),
      MM: pad(date.getMonth() + 1),
      dd: pad(date.getDate()),
      HH: pad(date.getHours()),
      mm: pad(date.getMinutes()),
      ss: pad(date.getSeconds()),
    };
    return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => tokens[token] as string);
  }

  function savedDateFormat(): string {
    try {
      return localStorage.getItem(DATE_FORMAT_KEY) || DEFAULT_DATE_FORMAT;
    } catch {
      return DEFAULT_DATE_FORMAT;
    }
  }

  function rememberDateFormat(format: string): void {
    try {
      localStorage.setItem(DATE_FORMAT_KEY, format);
    } catch {
      // Remembering the format is only a convenience.
    }
  }

  // ---- read-only ----------------------------------------------------------

  function applyReadOnly(ctx: CodePadCtx, tab: CodePadTab | null): void {
    const editor = ctx.editor;
    if (!editor) return;
    editor.updateOptions({ readOnly: Boolean(tab && tab.kind === 'text' && tab.persist && tab.persist.readOnly) });
  }

  // ---- registrations ------------------------------------------------------

  register('text.splitLines', async (ctx) => {
    const answer = await ctx.ui.prompt({
      title: 'Split Lines',
      label: 'Maximum line width (characters)',
      value: String(lastWrapWidth),
      validate: (value) => (/^\d+$/.test(value.trim()) && Number(value) >= 2 && Number(value) <= 10000
        ? null
        : 'Enter a whole number between 2 and 10000.'),
    });
    if (answer === null || answer === undefined) return;
    const width = Number.parseInt(answer, 10);
    if (!Number.isInteger(width) || width < 2) return;
    lastWrapWidth = width;
    ctx.text.transformLines((lines) => lines.flatMap((line) => wrapLine(line, width)), {
      scope: 'selectionOrDocument',
    });
  });

  lineOp('text.removeDuplicates', (lines) => [...new Set(lines)]);
  lineOp('text.removeConsecutiveDuplicates', (lines) => lines.filter((line, i) => i === 0 || line !== lines[i - 1]));
  lineOp('text.removeEmptyLines', (lines) => lines.filter((line) => line.length > 0));
  lineOp('text.removeBlankLines', (lines) => lines.filter((line) => line.trim().length > 0));
  lineOp('text.reverseLines', (lines) => lines.slice().reverse());
  lineOp('text.eolToSpace', (lines) => [lines.join(' ')]);
  lineOp('text.shuffleLines', (lines) => {
    const out = lines.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  });

  for (const [ascId, descId, sorter] of SORTS) {
    lineOp(`text.${ascId}`, (lines) => sorter(lines, false));
    lineOp(`text.${descId}`, (lines) => sorter(lines, true));
  }

  caseOp('text.upper', (s) => s.toUpperCase(), 'UPPERCASE');
  caseOp('text.lower', (s) => s.toLowerCase(), 'lowercase');
  caseOp('text.proper', toProper, 'Proper Case');
  caseOp('text.sentence', toSentence, 'Sentence case');
  caseOp('text.invert', toInverted, 'iNVERT cASE');
  caseOp('text.random', toRandom, 'rAnDoM cAsE');

  lineOp('text.trimLeading', (lines) => lines.map((line) => line.replace(/^[^\S\r\n]+/, '')));
  lineOp('text.trimTrailing', (lines) => lines.map((line) => line.replace(/[^\S\r\n]+$/, '')));
  lineOp('text.trimBoth', (lines) => lines.map((line) => line.trim()));

  const tabOp = (id: string, convert: (line: string, tabSize: number) => string): void =>
    register(id, (ctx) => {
      const tabSize = tabSizeOf(ctx);
      ctx.text.transformLines((lines) => lines.map((line) => convert(line, tabSize)), {
        scope: 'selectionOrDocument',
      });
    });
  tabOp('text.tabsToSpaces', expandTabs);
  tabOp('text.spacesToTabsLeading', spacesToTabsLeading);
  tabOp('text.spacesToTabsAll', spacesToTabsAll);

  register('text.insertDateShort', (ctx) => {
    const now = new Date();
    ctx.text.insertAtCursors(`${now.toLocaleDateString()} ${now.toLocaleTimeString()}`);
  });

  register('text.insertDateLong', (ctx) => {
    ctx.text.insertAtCursors(new Date().toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }));
  });

  register('text.insertDateCustom', async (ctx) => {
    const answer = await ctx.ui.prompt({
      title: 'Insert Date/Time',
      label: 'Format (tokens: yyyy MM dd HH mm ss)',
      value: savedDateFormat(),
      validate: (value) => (value.length > 0 ? null : 'Enter a format.'),
    });
    if (!answer) return;
    rememberDateFormat(answer);
    ctx.text.insertAtCursors(formatDate(new Date(), answer));
  });

  register('text.toggleReadOnly', (ctx) => {
    const tab = ctx.tabs.active();
    if (!tab || !tab.persist) return;
    tab.persist.readOnly = !tab.persist.readOnly;
    ctx.tabs.changed();
    applyReadOnly(ctx, tab);
    ctx.status.set(tab.persist.readOnly ? 'Read-only on' : 'Read-only off');
  });

  register('text.readOnlyAll', (ctx) => {
    const tabs = ctx.tabs.list().filter((tab): tab is CodePadTextTab => tab.kind === 'text' && Boolean(tab.persist));
    if (tabs.length === 0) return;
    const value = !tabs.every((tab) => tab.persist.readOnly);
    for (const tab of tabs) {
      tab.persist.readOnly = value;
      ctx.tabs.changed();
    }
    applyReadOnly(ctx, ctx.tabs.active());
    ctx.status.set(value ? 'All tabs are read-only' : 'Read-only cleared on all tabs');
  });

  register('text.redact', (ctx) => {
    const current = ctx.text.selectionOrDocument();
    if (!current) return;
    if (!current.isSelection) {
      ctx.status.set('Select the text to redact first.');
      return;
    }
    ctx.text.transformSelections((text) => text.replace(/[^\r\n]/gu, REDACT_CHAR), {
      scope: 'selection',
      label: 'Redact',
    });
  });

  CodePadFeatures.register('text-tools', {
    init(ctx) {
      ctx.events.on('tab:activated', (tab) => applyReadOnly(ctx, tab));
      ctx.events.on('tab:restored', (tab) => {
        if (tab === ctx.tabs.active()) applyReadOnly(ctx, tab);
      });
    },
  });
})();
