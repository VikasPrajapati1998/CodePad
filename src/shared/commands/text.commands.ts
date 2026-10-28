// Command table for the text tools (menu structure, titles, default accelerators).
// Loaded by the main process (menu builder) and, if needed, by the renderer.
(function (root: { CodePadTextCommands?: CommandEntry[] }, factory: () => CommandEntry[]) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodePadTextCommands = factory();
})(globalThis, () => {
  const LINES = 'Edit/Line Operations';
  const SORT = 'Edit/Sort Lines';
  const CASE = 'Edit/Convert Case';
  const BLANK = 'Edit/Blank Operations';
  const DATE = 'Edit/Insert Date and Time';
  const READONLY = 'Edit/Read-Only';
  const CONVERT = 'Tools/Convert';
  const HASH = 'Tools/Hash';

  /** Builds entries for one submenu; order follows array position. */
  const group = (menu: string, rows: Array<[string, string, Partial<CommandEntry>?]>): CommandEntry[] =>
    rows.map(([id, title, extra], i) => Object.assign({ id, title, menu, order: (i + 1) * 10 }, extra));

  const sortRows: Array<[string, string, Partial<CommandEntry>?]> = [
    ['text.sortAsc', 'Sort Lines Ascending'],
    ['text.sortDesc', 'Sort Lines Descending'],
    ['text.sortCaseInsensitive', 'Sort Lines Case-Insensitive Ascending', { separatorBefore: true }],
    ['text.sortCaseInsensitiveDesc', 'Sort Lines Case-Insensitive Descending'],
    ['text.sortByLength', 'Sort Lines by Length Ascending', { separatorBefore: true }],
    ['text.sortByLengthDesc', 'Sort Lines by Length Descending'],
    ['text.sortInteger', 'Sort Lines as Integers Ascending', { separatorBefore: true }],
    ['text.sortIntegerDesc', 'Sort Lines as Integers Descending'],
    ['text.sortDecimalDot', 'Sort Lines as Decimals (Dot) Ascending'],
    ['text.sortDecimalDotDesc', 'Sort Lines as Decimals (Dot) Descending'],
    ['text.sortDecimalComma', 'Sort Lines as Decimals (Comma) Ascending'],
    ['text.sortDecimalCommaDesc', 'Sort Lines as Decimals (Comma) Descending'],
    ['text.sortLocale', 'Sort Lines in Locale Order Ascending', { separatorBefore: true }],
    ['text.sortLocaleDesc', 'Sort Lines in Locale Order Descending'],
  ];

  return [
    ...group(LINES, [
      ['text.splitLines', 'Split Lines...'],
      ['text.removeDuplicates', 'Remove Duplicate Lines'],
      ['text.removeConsecutiveDuplicates', 'Remove Consecutive Duplicate Lines'],
      ['text.removeEmptyLines', 'Remove Empty Lines'],
      ['text.removeBlankLines', 'Remove Empty Lines (Containing Blank Characters)'],
      ['text.reverseLines', 'Reverse Line Order'],
      ['text.shuffleLines', 'Randomize Line Order'],
      ['text.eolToSpace', 'Join Lines with Spaces (EOL to Space)'],
    ]),
    ...group(SORT, sortRows),
    ...group(CASE, [
      ['text.upper', 'Convert to UPPERCASE', { accelerator: 'CmdOrCtrl+Shift+U' }],
      ['text.lower', 'Convert to lowercase'],
      ['text.proper', 'Convert to Proper Case'],
      ['text.sentence', 'Convert to Sentence case'],
      ['text.invert', 'Invert Case'],
      ['text.random', 'Convert to rAnDoM cAsE'],
    ]),
    ...group(BLANK, [
      ['text.trimTrailing', 'Trim Trailing Space'],
      ['text.trimLeading', 'Trim Leading Space'],
      ['text.trimBoth', 'Trim Leading and Trailing Space'],
      ['text.tabsToSpaces', 'TAB to Space', { separatorBefore: true }],
      ['text.spacesToTabsLeading', 'Space to TAB (Leading)'],
      ['text.spacesToTabsAll', 'Space to TAB (All)'],
    ]),
    ...group(DATE, [
      ['text.insertDateShort', 'Insert Date and Time (Short)', { accelerator: 'F5' }],
      ['text.insertDateLong', 'Insert Date and Time (Long)', { accelerator: 'Shift+F5' }],
      ['text.insertDateCustom', 'Insert Date and Time (Custom)...'],
    ]),
    { id: 'text.columnEditor', title: 'Column Editor...', menu: 'Edit', order: 900, separatorBefore: true, accelerator: 'Alt+Shift+C' },
    { id: 'clipboard.history', title: 'Clipboard History', menu: 'Edit', order: 910, accelerator: 'CmdOrCtrl+Shift+H', when: 'any' },
    { id: 'text.redact', title: 'Redact Selection', menu: 'Edit', order: 920 },
    ...group(READONLY, [
      ['text.toggleReadOnly', 'Toggle Read-Only (This Tab)'],
      ['text.readOnlyAll', 'Toggle Read-Only (All Tabs)'],
    ]),
    ...group(CONVERT, [
      ['conv.base64Encode', 'Base64 Encode'],
      ['conv.base64EncodeUrl', 'Base64 Encode (URL-safe)'],
      ['conv.base64EncodeWrapped', 'Base64 Encode (76-column lines)'],
      ['conv.base64Decode', 'Base64 Decode'],
      ['conv.urlEncode', 'URL Encode', { separatorBefore: true }],
      ['conv.urlDecode', 'URL Decode'],
      ['conv.asciiToHex', 'ASCII to Hex', { separatorBefore: true }],
      ['conv.hexToAscii', 'Hex to ASCII'],
    ]),
    ...group('Tools/JSON', [
      ['json.pretty', 'Pretty-Print JSON'],
      ['json.minify', 'Minify JSON'],
      ['json.validate', 'Validate JSON'],
    ]),
    ...group('Tools/XML', [
      ['xml.pretty', 'Pretty-Print XML'],
      ['xml.minify', 'Minify XML'],
      ['xml.validate', 'Validate XML'],
    ]),
    ...group(HASH, [
      ['hash.selection', 'Hash of Selection...'],
      ['hash.tab', 'Hash of Tab Text...'],
      ['hash.currentFile', 'Hash of Current File on Disk...', { when: 'any' }],
      ['hash.file', 'Hash of Open or Recent File...', { when: 'any' }],
    ]),
  ];
});
