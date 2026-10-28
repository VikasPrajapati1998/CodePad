# Notepad++ feature checklist for CodePad

Source: static read of Notepad++ v8.9.8.1 public metadata only (`change.log`, `readme.txt`, `localization\english.xml` menu command names, install-dir folder names; shortcut/menu structure only from the user config, no private content copied). REA binary tools were not needed (english.xml carries the full menu strings) and no binary session was opened. Nothing in the inspected data asked to run/install/send anything. No code was read or reproduced; Notepad++ is GPL, CodePad is MIT, so only user-visible feature ideas are taken. Default shortcuts are the well-known Notepad++ defaults (not all are in english.xml), marked "~" where from general knowledge.

Tags: [EXISTS] CodePad/Monaco already has it; [BUILD-EASY] small renderer-only; [BUILD-MED] needs main-process support or new panel; [BUILD-HARD]; [SKIP].

CodePad baseline (from main.js/app.js): File New/Open/Open Folder/Save/SaveAs/SaveAll/Close; Find/Replace/GoToLine/Palette; sidebar file tree; minimap/word-wrap/theme toggles; zoom; tab next/prev; tabs with docx/xlsx/pdf viewers; session restore incl. unsaved edits; language picker + auto-detect; status-bar EOL toggle and encoding label (utf8, utf8bom, utf16le/be, latin1). Monaco built-ins also give: multi-cursor, column select (Shift+Alt+drag), fold/unfold, move/copy line, delete line, sort lines asc/desc, trim trailing whitespace, transform case (upper/lower/title via palette), toggle comment, join lines, indent/outdent, bracket matching/jump, select all occurrences, add next occurrence, transpose, format document, snippets, suggestions, go to symbol, change tab size/convert indentation, render whitespace.

## File menu
- New (Ctrl+N) [EXISTS]
- Open... (Ctrl+O) [EXISTS]
- Open Containing Folder: Explorer / cmd / PowerShell [BUILD-MED] shell.showItemInFolder for Explorer only; cmd/PowerShell launch is [SKIP] (security: renderer must not spawn)
- Open Folder as Workspace [EXISTS] (Open Folder + tree)
- Open in Default Viewer [BUILD-MED] shell.openPath via allow-listed IPC
- Restore Recent Closed File (Ctrl+Shift+T) [BUILD-EASY] keep closed-tab stack
- Reload from Disk [BUILD-MED] needs read IPC (already used by open); renderer logic small
- Save (Ctrl+S) [EXISTS]; Save As (Ctrl+Alt+S) [EXISTS]; Save All (Ctrl+Shift+S) [EXISTS]
- Save a Copy As... [BUILD-MED] extra save path without retargeting tab
- Rename... [BUILD-MED] main-process fs.rename via fileAccess allow-list
- Move to Recycle Bin [BUILD-MED] shell.trashItem; cross-platform OK
- Close / Close All / Close All BUT Current / to Left / to Right / Unchanged / BUT Pinned (Ctrl+W, Ctrl+Shift+W) [BUILD-EASY] (Close exists; bulk variants are tab-list logic)
- Load Session / Save Session (named session files) [BUILD-MED]; automatic session restore [EXISTS]
- Recent Files list, Open All Recent, Empty Recent List [BUILD-MED] list persisted in main (sessionStore pattern)
- Print (Ctrl+P) [BUILD-MED] webContents.print / print stylesheet
- Exit (Alt+F4) [EXISTS]

## Edit menu
- Undo/Redo/Cut/Copy/Paste/Delete/Select All [EXISTS]
- Begin/End Select, Begin/End Select in Column Mode [SKIP] low value; Monaco column selection exists
- Insert Date/Time short/long/custom (F5 ~) [BUILD-EASY]
- Copy Current Full Path / Filename / Dir Path; Copy All Names/Paths [BUILD-EASY] clipboard write
- Indent / Unindent (Tab, Shift+Tab) [EXISTS]
- Convert Case: UPPER (Ctrl+Shift+U), lower (Ctrl+U), Proper, Sentence, invert, random [EXISTS] upper/lower/title; [BUILD-EASY] sentence/invert/random
- Line Ops: Duplicate (Ctrl+D ~) [EXISTS] (Shift+Alt+Down); Delete line (Ctrl+L) [EXISTS]; Move up/down [EXISTS]; Join lines [EXISTS]; Split lines [BUILD-EASY]; Transpose [EXISTS]
- Remove Duplicate Lines / Consecutive Duplicates [BUILD-EASY]
- Sort ascending/descending [EXISTS]; case-insensitive, by length, as integers, decimals (comma/dot), locale order [BUILD-EASY]
- Reverse / Randomize line order [BUILD-EASY]
- Insert Blank Line Above/Below (Ctrl+Alt+Enter) [EXISTS] (Monaco Ctrl+Enter / Ctrl+Shift+Enter)
- Remove Empty Lines (and blank-containing) [BUILD-EASY]
- Comment/Uncomment: toggle (Ctrl+Q), block (Ctrl+Shift+Q), single set/clear [EXISTS]
- Auto-Completion: word completion, function completion, path completion, hint [EXISTS] suggestions; word-from-document completion on plain text [BUILD-EASY]
- EOL Conversion: Windows/Unix/Mac [EXISTS] LF/CRLF; CR-only [BUILD-EASY] (Monaco lacks; do via text replace)
- Blank Operations: Trim trailing/leading/both, EOL to space, TAB to Space, Space to TAB (leading/all) [EXISTS] trim trailing, convert indentation; others [BUILD-EASY]
- Paste Special: HTML/RTF content, Binary copy/cut/paste [SKIP] clipboard-format specific
- On Selection: Open File, Open Containing Folder, Search on Internet, Change Search Engine, Redact Selection [BUILD-EASY] search-on-internet via shell.openExternal https allow; open-file-at-selection [BUILD-MED]
- Multi-select All / Next (match case/whole word variants), Undo last multi-select, Skip current [EXISTS] (Ctrl+D, Ctrl+F2 select all occurrences)
- Column Mode... / Column Editor (Alt+C): insert text or number sequence down a column selection [BUILD-MED] new dialog; numbering (start, step, repeat, leading zeros, base dec/hex/oct/bin)
- Character Panel (ASCII table) [BUILD-MED]
- Clipboard History [BUILD-MED] panel; capture copies in renderer
- Set Read-Only on Current Doc / All / Clear [BUILD-EASY] editor option readOnly per tab; OS attribute variant [SKIP]
- Text Direction RTL/LTR (Ctrl+Alt+R/L) [BUILD-EASY] CSS direction on editor, partial support in Monaco

## Search menu
- Find (Ctrl+F), Replace (Ctrl+H), Find Next (F3), Find Previous (Shift+F3), Select and Find Next/Previous (Ctrl+F3/Ctrl+Shift+F3) [EXISTS]
- Find (Volatile) Next/Previous [EXISTS] approx via selection-find
- Incremental Search (Ctrl+Alt+I) [EXISTS] type-ahead in Monaco find widget
- Find in Files (Ctrl+Shift+F), with filters, directory, recursive, hidden, replace in files [BUILD-MED] needs main-process walker through fileAccess + results panel
- Find in Opened Docs / Current doc with "Find All", "Count", "Find All in All Opened Documents", "Replace All in All Opened Documents" [BUILD-MED] renderer loop over models + results panel
- Search modes: Normal, Extended (\n \r \t \0 \x..), Regular expression with ". matches newline" [EXISTS] regex/case/word; [BUILD-EASY] extended mode (convert escapes to regex)
- Wrap around, Backward direction, In selection [EXISTS] (in-selection toggle)
- Search Results window (F7), next/prev result (F4/Shift+F4), folded per-file/per-search output [BUILD-MED] new bottom panel
- Mark... (Ctrl+M): mark all matches with bookmark line, purge, copy marked text, bookmark line option [BUILD-MED]
- Go to... (Ctrl+G) line or offset [EXISTS] line; [BUILD-EASY] offset mode
- Go to Matching Brace (Ctrl+B) [EXISTS] (Ctrl+Shift+\)
- Select All In-between {} [] () [BUILD-EASY]
- Find characters in range (ASCII / non-ASCII) [BUILD-EASY]
- Bookmark: toggle (Ctrl+F2), next/prev (F2/Shift+F2), clear all, cut/copy/paste/remove bookmarked lines, remove non-bookmarked, inverse [BUILD-MED] gutter decorations + line ops (VS Code-like)
- Style All Occurrences of Token (5 styles), Style One Token, Clear Style [BUILD-MED] decorations; Monaco already highlights occurrences of selection [EXISTS partial]
- Jump Up/Down to styled tokens [BUILD-MED]
- Copy Styled Text [SKIP]
- Change History: go to next/previous change, clear [BUILD-MED] gutter dirty-line decorations vs saved version (diff vs saved text)
- Find in Files results with Ctrl+double-click open [BUILD-MED]

## View menu
- View Current File in Firefox/Chrome/Edge/IE [SKIP] browser-specific; generic "Open in default browser" [BUILD-MED]
- Always on Top [BUILD-EASY] main setAlwaysOnTop via IPC
- Toggle Full Screen (F11) [EXISTS]; Post-It [SKIP]; Distraction Free Mode (zen) [BUILD-EASY]
- Show Symbol: space and tab, EOL, non-printing, control chars/Unicode EOL, all characters, indent guides, wrap symbol [EXISTS] renderWhitespace/guides; [BUILD-EASY] toggle menu entries for them, show EOL via renderControlCharacters
- Zoom In/Out (Ctrl+wheel), Restore default zoom (Ctrl+/) [EXISTS]
- Move/Clone Current Document to other view [BUILD-HARD] split view; editor-group split of the same model is [BUILD-MED]
- Tab: 1st..9th, First/Last, Next/Previous (Ctrl+Tab), Move Tab Forward/Backward [EXISTS] next/prev; [BUILD-EASY] go to Nth tab, move tab, tab colors (5) [BUILD-EASY]
- Word wrap [EXISTS] (Alt+Z); Wrap symbol [BUILD-EASY]
- Focus on Another View, Synchronise vertical/horizontal scrolling [BUILD-HARD] requires split view
- Fold All (Alt+0), Unfold All (Alt+Shift+0), Fold Level 1-8, Fold/Unfold current level [EXISTS]
- Hide Lines (Alt+F) [BUILD-MED] hidden-areas API is not public in Monaco; fold selection is the nearest [BUILD-EASY]
- Summary... (chars, words, lines, selection counts, doc length) [BUILD-EASY] dialog; status bar counts exist partially
- Project Panels 1-3 [SKIP] replaced by folder sidebar
- Folder as Workspace panel [EXISTS]
- Document Map (minimap) [EXISTS]
- Document List panel [BUILD-EASY] sidebar list of open tabs
- Function List panel [BUILD-MED] symbol outline (see group 4); Monaco has Go to Symbol quick pick [EXISTS partial]
- Monitoring / tail -f [BUILD-MED] needs main fs.watch + append reload

## Encoding menu
- ANSI, UTF-8, UTF-8-BOM, UTF-16 BE BOM, UTF-16 LE BOM labels [EXISTS] in status bar
- Convert to ANSI/UTF-8/UTF-8-BOM/UTF-16 BE/LE [BUILD-MED] re-encode on save; selector UI in status bar
- Reopen file with different encoding ("Encoding" picker without conversion) [BUILD-MED]
- Character sets: Arabic, Baltic, Celtic, Cyrillic (Windows-1251, KOI8), Central/Eastern European, Chinese (Big5, GB2312), Greek, Hebrew, Japanese (Shift-JIS), Korean, North European, Thai, Turkish, Western European (Windows-1252, ISO-8859-x), Vietnamese, OEM 437/850/... [BUILD-MED] TextDecoder supports most; encoding writes need a lib (iconv-lite = new dependency, ask first)
- EOL status switcher Windows/Unix/Mac [EXISTS] LF/CRLF toggle only

## Language menu
- Language list (~90 built-in lexers, alphabetical submenus) [EXISTS] Monaco languages + picker
- None (Normal Text) [EXISTS] plaintext
- Style Configurator (per-language token colors, fonts, themes) [BUILD-HARD]
- Define your language (User Defined Language editor: keywords, delimiters, folding) [BUILD-HARD]; custom Monarch import [SKIP]
- Language detection by extension and shebang [EXISTS]
- Per-language tab size / tab-vs-spaces defaults [BUILD-EASY]

## Settings menu
- Preferences dialog categories: General (tab bar, toolbar, reduce-to-tray, multi-instance, localization), Editing, Dark Mode, Margins/Border/Edge, New Document (default EOL/encoding/language), Default Directory, Recent Files History, File Association, Language, Indentation, Highlighting, Print, Searching, Backup (session snapshot, auto-backup), Auto-Completion, Multi-Instance & Date, Delimiter, Performance (large file), Cloud & Link, Search Engine, MISC [BUILD-MED] a Settings panel (persist in main)
- Settings worth copying: default new-doc EOL/encoding, line numbers, font family/size, tab size, auto-indent, brace auto-close, caret blinking, scroll beyond last line, copy line when no selection, highlight current line, smooth scroll, show tab close button, double-click-to-close tab, drag-drop tabs, tab bar vertical [BUILD-EASY] each (Monaco options)
- Dark mode / themes (Obsidian, Monokai, Solarized, Zenburn, Twilight, Bespin, etc. in `themes\`) [EXISTS] light/dark; extra themes [BUILD-EASY] via monaco.editor.defineTheme (new palettes, own colors)
- Shortcut Mapper (rebind menu/editor/macro commands) [BUILD-MED]
- Edit Popup Context Menu [SKIP]; Import plugin/theme [SKIP]
- Plugins Admin [SKIP]; Open Plugins Folder [SKIP]

## Tools menu
- Hashes: MD5, SHA-1, SHA-256, SHA-512; Generate from file(s), from selection into clipboard [BUILD-MED] Web Crypto in renderer for selection (SHA only; MD5 needs main node crypto); files via main
- Converter plugin (ASCII to HEX / HEX to ASCII) [BUILD-EASY]
- MIME Tools: Base64 encode/decode (with line-break/unbreak, URL-safe), URL encode/decode, Quoted-Printable, SAML decode [BUILD-EASY] Base64/URL; rest [SKIP]
- NppExport: copy RTF/HTML to clipboard, export to file [BUILD-MED] HTML export of highlighted text via Monaco colorize
- Not shipped (common plugins, ideas only): JSON pretty/minify, XML tidy (XML Tools), Compare [see group 4]

## Macro menu
- Start/Stop Recording (Ctrl+Shift+R), Playback (Ctrl+Shift+P ~), Save Current Macro, Run Macro Multiple Times (incl. until end of file), user macro list with shortcuts [BUILD-MED] record Monaco keystroke/edit commands; replay; persist in main

## Run menu
- Run... (external command with $(FULL_CURRENT_PATH) variables), Open in Browser, Search on Google/Wikipedia, Launch in browser variants [SKIP] arbitrary process spawn violates the sandbox/IPC trust model; browser opens via https allow-list [BUILD-EASY]
- Command-line args (`-monitoringMode`, `-n`line, `-multiInst`, `-nosession`, `-lLanguage`) [BUILD-MED] argv parsing in main (open files passed at launch, `-n` line jump)

## Plugins menu
- Plugins Admin, install/update, Plugin API (NPPM_*), plugin deactivation [SKIP] needs a plugin system; excluded for security

## Window / Tab context menu
- Tab context: Close, Close Multiple (all but this, left, right, unchanged, but pinned), Save, Save As, Open Containing Folder, Open in Default Viewer, Rename, Move to Recycle Bin, Reload from Disk, Print, Read-Only, Clear Read-Only Flag, Copy Full Path / Filename / Dir, Move to Other View / Clone, Open in New Instance, Pin Tab, Apply Color 1-5, Remove Color [BUILD-EASY] pin/color/copy-path/close-variants; others [BUILD-MED]
- Window menu: Windows... (list/activate/save/close/sort windows), Sort tabs by name/path/type/size [BUILD-EASY]
- Pinned tabs (locked from close, shown with pin icon; "Close All BUT Pinned") [BUILD-EASY]
- Tab bar: drag to reorder, double-click to close, middle-click close, multi-line tabs, vertical tabs, close button on hover, color/icon for unsaved vs saved vs read-only [BUILD-EASY]

## Recent notable features (change.log, v8.9.8 / 8.9.8.1)
- Monitoring mode via `-monitoringMode` argument [BUILD-MED]
- Plugin deactivation capability [SKIP]
- Folder as Workspace: option to follow symlinks, remembered across sessions [BUILD-MED] CodePad's fileAccess must keep symlink policy deliberate (security)
- Network/UNC path warning dialog and NTLM-leak protection [SKIP] CodePad should keep its own allow-list; reject UNC paths in fileAccess if not already
- UTF-16 loading, session backup path-traversal, UAC save fixes: reminders to harden session and file-save paths [BUILD-MED] audit sessionStore for path traversal
- Fixes: column-mode paste, CJK IME in Save As, locale-formatted counts, search results scrolling [EXISTS/N-A]
- Scintilla 5.6.6 / Lexilla 5.5.3 [SKIP]
- Other long-standing headline features not in this log: Document Map, Function List, Folder as Workspace, Change History margin, multi-view split, tab colors, dark mode, auto-completion, bookmarks, session snapshot/backup (periodic crash-safe backup), multi-select, column editing, multi-instance control.

## Not in the install dir
- `functionList\*.xml` (48 per-language parser definitions, regex outline rules) and `autoCompletion\*.xml` (34 languages: keyword/function/call-tip lists) show the outline and call-tip feature set; CodePad gets equivalents from Monaco's document symbol providers and suggestions [EXISTS partial]. Themes shipped: 22 (Bespin, Black board, Choco, DansLeRuSH-Dark, DarkModeDefault, Deep Black, Hello Kitty, HotFudgeSundae, khaki, Mono Industrial, Monokai, MossyLawn, Navajo, Obsidian, Plastic Code Wrap, Ruby Blue, Solarized(-light), Twilight, Vibrant Ink, vim Dark Blue, Zenburn).

---

# BUILD items by requested group

## (1) Search and replace power
1. Extended search mode (\n \t \r \0 \xHH escapes in plain find) [BUILD-EASY]
2. Count / Find All in current document with results list [BUILD-EASY]
3. Go to offset (line or byte offset) [BUILD-EASY]
4. Select all in-between brackets; find characters in range [BUILD-EASY]
5. Search Results panel (bottom dock, grouped by file, click-to-jump, F4/Shift+F4) [BUILD-MED]
6. Find/Replace in all open documents [BUILD-MED]
7. Find in Files / Replace in Files (folder, filters, recursive; walker lives in main via fileAccess) [BUILD-MED]
8. Bookmarks: toggle, next/prev, clear, cut/copy/remove/inverse bookmarked lines [BUILD-MED]
9. Mark (highlight all matches, 5 token styles, jump) [BUILD-MED]
10. Change-history gutter and next/previous change [BUILD-MED]

## (2) Text tools
1. Line ops: split lines, remove duplicate / consecutive duplicate, remove empty / blank lines, reverse, randomize [BUILD-EASY]
2. Extra sorts: case-insensitive, by length, integer, decimal (comma/dot), locale [BUILD-EASY]
3. Case variants: sentence, proper (blend), invert, random [BUILD-EASY]
4. Blank ops: trim leading/both, EOL to space, tab/space conversions [BUILD-EASY]
5. Insert date/time (short/long/custom) [BUILD-EASY]
6. Column editor: text and number sequences with base/step/leading zeros [BUILD-MED]
7. Redact selection, copy path/name variants [BUILD-EASY]
8. Clipboard history panel, character panel [BUILD-MED]
9. Read-only toggle per tab / all tabs [BUILD-EASY]

## (3) Encoding, EOL and view
1. EOL picker including CR-only; default EOL for new docs [BUILD-EASY]
2. Encoding picker: reopen with encoding vs convert to encoding; wider charset list (TextDecoder for read; write support needs iconv-lite, ask before adding) [BUILD-MED]
3. View > Show Symbol toggles (whitespace, EOL, control chars, all), wrap symbol, indent guides toggle, distraction-free mode, always-on-top [BUILD-EASY]
4. Summary dialog (chars, words, lines, selection) [BUILD-EASY]
5. Additional editor themes (Monokai, Solarized, Zenburn, Obsidian, etc., own palettes) [BUILD-EASY]
6. Settings panel (font, tab size, per-language indent, line numbers, caret, wrap, default encoding/EOL) [BUILD-MED]
7. Split view / clone document, synchronized scroll [BUILD-HARD]
8. Print / HTML export [BUILD-MED]

## (4) Tabs, sessions and tools
1. Pinned tabs, tab colors (5), close variants (others / left / right / unchanged / but pinned), move tab, go to Nth tab, sort tabs [BUILD-EASY]
2. Restore recently closed tab; Recent Files list with Open All / Empty [BUILD-EASY (closed stack) / BUILD-MED (persisted recent list)]
3. Document List panel [BUILD-EASY]
4. Reload from disk; detect external change with prompt ("file changed, reload?") via main fs.watch [BUILD-MED]
5. Monitoring (tail -f) mode [BUILD-MED]
6. Auto-save (interval or on focus loss) and backup snapshots [BUILD-MED] (session already stores unsaved edits)
7. Named session save/load [BUILD-MED]
8. Rename, Save a Copy As, Move to Recycle Bin, open containing folder, open in default viewer [BUILD-MED]
9. Compare files (side-by-side diff of two tabs, Monaco createDiffEditor) [BUILD-MED]
10. Hashes MD5/SHA-1/256/512 for selection and files [BUILD-MED]
11. JSON pretty-print/minify, XML pretty-print (renderer; JSON.parse, DOMParser, Monaco format action) [BUILD-EASY]
12. Base64 / URL encode-decode, ASCII<->Hex [BUILD-EASY]
13. Macros: record/playback/save/run N times [BUILD-MED]
14. Code outline panel (Function List), via Monaco document symbols + regex fallback [BUILD-MED]
15. Shortcut mapper (rebindable keys, persisted) [BUILD-MED]
16. Command-line args (file open at launch, `-n` line, `-nosession`) [BUILD-MED]

---

# Recommended implementation ORDER
1. Text tools quick wins (group 2 EASY): line ops, sorts, case, blanks, date/time, Base64/URL/Hex, JSON/XML pretty-print. Pure renderer, high visibility, shared "command" pattern (register in palette and Edit menu).
2. Tabs EASY: pinned tabs, close variants, tab colors, copy path, restore closed tab, Document List, read-only toggle.
3. View/EOL EASY: show-symbol toggles, CR EOL, distraction-free, summary, extra themes, always-on-top.
4. Search power EASY then MED: extended mode, Count/Find All, Search Results panel, Find in open docs, bookmarks, then Find in Files (main walker via fileAccess allow-list).
5. File-system MED: reload from disk, external-change detection, Rename/Trash/Save a Copy, recent files, auto-save.
6. Compare files (diff editor), hashes, Column editor, change-history gutter, code outline.
7. Encoding picker (reopen/convert; decide on iconv-lite dependency with the user first).
8. Settings panel and shortcut mapper, macros, named sessions, command-line args, monitoring mode.
9. Last: split view / clone / synced scroll (BUILD-HARD). Never: plugin system, Run command, Windows-only shell bits.
