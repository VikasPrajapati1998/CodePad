# Design: Notepad++-class features for CodePad

Status: DESIGN ONLY, nothing implemented. Requirements source: `.claude/research/notepad-plus-plus-features.md` (scope fixed by the user). Builds on `.claude/plans/binary-formats-design.md` (tab kinds, `CodePadEditors`, binary IPC, session store). Facts about the code were read from the current tree (main.js, preload.js, fileAccess.js, sessionStore.js, renderer/app.js, index.html, common.js, package.json). Monaco is 0.52.2; `IStandaloneDiffEditor.goToDiff`, `getLineChanges`, `createDecorationsCollection`, `onDidPaste` were verified in its `editor.api.d.ts`.

Guiding decisions (all later sections follow from these):

1. **One command table, one registry.** Menu structure, titles and default accelerators live in static per-module files `shared/commands/<module>.commands.js` that the main process `require`s and builds the native menu from. The renderer registers only the `run()` handlers (`CodePadCommands.register`). Main only ever sends command IDs from its own table; the renderer cannot add or alter native menu items.
2. **Feature modules are self-contained plain scripts** under `renderer/features/`, loaded before `app.js`, talking to the app only through the documented `ctx` object. `app.js` is touched only by Agent 1.
3. **Main owns trust.** Every new capability that touches the disk (search, watch, hash, encodings, recent files, sessions) is a `handle()`-guarded IPC over `fileAccess` and never takes a path that is not already allow-listed or main-originated.
4. **No new dependency beyond iconv-lite 0.7.3.** Diff = Monaco diff editor, hashes = Web Crypto + ~50 lines MD5 (renderer) / Node `crypto` (main, files), XML/JSON = DOMParser/JSON, macros/outline/everything else in-house.

---

## A. Feature-to-module map

Owners: **A1** glue/infra, **A2** search, **A3** text tools, **A4** view/encoding/settings/outline, **A5** tabs/files/sessions/compare/macros. Module file = `renderer/features/<file>` unless noted.

### A.1 Included features

| # | Feature | Module (owner) | Menu location | Accelerator |
|---|---|---|---|---|
| **Group 1 Search** |||||
| 1 | Find in Files (folder, include/exclude filters, subfolder, regex/case/word/extended) | search.js + `findInFiles.js` (A2) | Search > Find in Files... | Ctrl+Shift+F |
| 2 | Find All in Current Tab / in All Open Tabs, Count | search.js (A2) | Search > Find All in Current Tab / in Open Tabs / Count | none (Find panel scope selector) |
| 3 | Replace All in Open Tabs | search.js (A2) | Search > Replace in Open Tabs... | none |
| 4 | Search Results panel, next/prev result | search-results.js (A2) | Search > Toggle Search Results / Next / Previous Result | F7 / F4 / Shift+F4 |
| 5 | Extended search mode (`\n \r \t \0 \xHH \uHHHH`) | `shared/searchCore.js` (A2), toggle in Find panel | Find panel option | n/a |
| 6 | Mark all / 5 styles / clear / jump | bookmarks.js (A2) | Search > Mark > Style 1..5, Clear All, Next/Previous Mark | Ctrl+Shift+M (style 1) |
| 7 | Bookmarks: toggle, next/prev, clear, cut/copy/paste/delete bookmarked lines, delete unmarked, inverse | bookmarks.js (A2) | Search > Bookmark > ... | Alt+F2 toggle, Alt+F3 next, Alt+Shift+F3 prev |
| 8 | Go to Offset, Select Between Brackets, Find Characters in Range (non-ASCII preset) | search.js (A2) | Search > Go to Offset... / Select Between Brackets / Find Non-ASCII | none |
| **Group 2 Text tools** |||||
| 9 | Line ops: split/wrap lines, remove duplicate / consecutive duplicate, remove empty / blank, reverse, randomize, EOL to space | text-tools.js (A3) | Edit > Line Operations > ... | none |
| 10 | Sorts: case-insensitive, by length, integer, decimal (dot/comma), locale, asc/desc | text-tools.js (A3) | Edit > Sort Lines > ... | none |
| 11 | Case: UPPER, lower, Proper, Sentence, Invert, Random | text-tools.js (A3) | Edit > Convert Case > ... | Ctrl+Shift+U (UPPER) |
| 12 | Blank ops: trim leading/trailing/both, tab<->space (leading/all) | text-tools.js (A3) | Edit > Blank Operations > ... | none |
| 13 | Insert date/time short/long/custom | text-tools.js (A3) | Edit > Insert Date/Time > ... | F5 short, Shift+F5 long |
| 14 | Column Editor (text / number sequence, base, step, repeat, zero pad) | column-editor.js (A3) | Edit > Column Editor... | Alt+Shift+C |
| 15 | Clipboard history panel | clipboard-history.js (A3) | Edit > Clipboard History | Ctrl+Shift+H |
| 16 | Read-only toggle (tab / all), redact selection | text-tools.js (A3) | Edit > Read-Only / Redact Selection | none |
| 17 | Base64 / URL encode-decode, ASCII<->Hex | converters.js (A3) | Tools > Convert > ... | none |
| 18 | JSON pretty/minify/validate; XML pretty/minify/validate | converters.js (A3) | Tools > JSON / XML > ... | none |
| 19 | Hashes MD5/SHA-1/256/384/512: selection/tab text, current file, file from dialog | hashes.js (A3) + `fs:hash` (A1) | Tools > Hash > ... | none |
| **Group 3 Encoding, EOL, view** |||||
| 20 | Encoding picker: Reopen with Encoding / Convert to Encoding / set default | encoding.js (A4) + fileAccess codec (A1) | Encoding > ... + status bar encoding click | none |
| 21 | EOL picker LF / CRLF / CR, default EOL for new docs | encoding.js (A4) (+ `tab.eol` in app.js, A1) | Encoding > End of Line > ... + status bar EOL click | none |
| 22 | Show Symbol toggles: whitespace, EOL, control chars, all, indent guides, wrap symbol | view.js (A4) | View > Show Symbol > ... | none |
| 23 | Extra themes (Monokai, Solarized Dark/Light, Zenburn, Obsidian, High Contrast) | themes.js (A4) + registry (A1) | View > Theme > ... | none |
| 24 | Distraction-free mode, Full screen (exists), Always on Top | view.js (A4) + `window:*` IPC (A1) | View > Distraction Free / Always on Top | Ctrl+Shift+F11 |
| 25 | Summary dialog (chars, words, lines, bytes, selection) | view.js (A4) | View > Summary... | none |
| 26 | Settings panel (+ per-language tab size, shortcut mapper) | settings-panel.js (A4) + settingsStore (A1) | File > Settings... | Ctrl+, |
| 27 | Code outline (Function List) panel | outline.js (A4) | View > Outline | Ctrl+Shift+Y |
| **Group 4 Tabs, sessions, tools** |||||
| 28 | Pinned tabs, tab colors (5), drag reorder, Move Tab, Go to Nth tab | tabs.js (A5) | Tab context menu; View > Tab > ... | Ctrl+1..9 (9 = last), Ctrl+Shift+PgUp/PgDn move |
| 29 | Tab context menu + Close variants (others/left/right/unchanged/but pinned/all) | tabs.js (A5) | right-click on tab; File > Close > ... | Ctrl+Shift+W (Close All) |
| 30 | Copy full path / file name / dir path, Reveal in Explorer/Finder | tabs.js (A5) + `shell:reveal` (A1) | Tab context menu; Edit > Copy to Clipboard > ... | none |
| 31 | Restore recently closed tab, Document List panel | tabs.js (A5) | File > Reopen Closed Tab; View > Documents | Ctrl+Shift+T / Ctrl+Shift+D |
| 32 | Recent files (open, open all, clear) | files.js (A5) + `recent:*` (A1) | File > Open Recent (dynamic, built by main) | none |
| 33 | Reload from disk (with optional encoding via A4) | files.js (A5) | File > Reload from Disk; tab menu | none |
| 34 | File-changed-on-disk watch + prompt, Monitoring (tail -f) | files.js (A5) + `fileWatcher.js` (A5, main) | File > Monitor (tail -f) (checkbox) | none |
| 35 | Auto-save (off / after delay / on focus loss) | files.js (A5) | Settings panel | n/a |
| 36 | Compare two files / tab vs disk (Monaco diff editor, tab kind `diff`) | compare.js (A5) | Tools > Compare > ... | none |
| 37 | Macro record / playback / run N times / save named / delete | macros.js (A5) + `macros:*` (A1) | Macro > ... | Ctrl+Shift+R record/stop, F9 playback |
| 38 | Named sessions: save, load, delete | sessions.js (A5) + `sessions:*` (A1) | File > Sessions > Save / Load / Delete | none |
| 39 | Command-line args: files to open, `-n<line>`, `-nosession` | main.js (A1) | n/a | n/a |
| 40 | Keyboard shortcut mapper (override menu accelerators) | settings-panel.js (A4) + menu builder (A1) | Settings panel > Shortcuts | n/a |

The existing native accelerators stay: Ctrl+N/O/Shift+O/S/Shift+S, Ctrl+Alt+S, Ctrl+W, Ctrl+Shift+P, Ctrl+G, Ctrl+F, Ctrl+H, Ctrl+B, Alt+Z, Ctrl+Tab, Ctrl+Shift+Tab.

### A.2 Final shortcut table (new accelerators only; all `CmdOrCtrl` unless written otherwise)

| Command id | Accelerator | Command id | Accelerator |
|---|---|---|---|
| search.findInFiles | CmdOrCtrl+Shift+F | tabs.restoreClosed | CmdOrCtrl+Shift+T |
| search.toggleResults | F7 | tabs.closeAll | CmdOrCtrl+Shift+W |
| search.nextResult / prevResult | F4 / Shift+F4 | tabs.goto1..goto9 | CmdOrCtrl+1..9 |
| bookmark.toggle | Alt+F2 | tabs.moveLeft / moveRight | CmdOrCtrl+Shift+PageUp / PageDown |
| bookmark.next / prev | Alt+F3 / Alt+Shift+F3 | view.showExplorer | CmdOrCtrl+Shift+E |
| mark.style1 | CmdOrCtrl+Shift+M | view.showDocuments | CmdOrCtrl+Shift+D |
| text.insertDateShort / Long | F5 / Shift+F5 | view.toggleBottomPanel | CmdOrCtrl+J |
| text.upper | CmdOrCtrl+Shift+U | view.outline | CmdOrCtrl+Shift+Y |
| text.columnEditor | Alt+Shift+C | view.zen | CmdOrCtrl+Shift+F11 |
| clipboard.history | CmdOrCtrl+Shift+H | settings.open | CmdOrCtrl+, |
| macro.toggleRecord | CmdOrCtrl+Shift+R | macro.playback | F9 |

Conflict rules applied: not used = any Monaco default (Ctrl+D, Ctrl+K chords, Ctrl+L, Ctrl+Shift+K, Ctrl+Shift+L, Ctrl+F2, F2, F3/Shift+F3, F8, F12, Ctrl+Shift+\, Alt+Up/Down, Ctrl+/ , Ctrl+], Alt+Shift+F format), no Ctrl+Alt+letter (AltGr on European keyboards types characters), no Alt+letter (Windows menu mnemonics `&File &Edit ...`), F10 and Alt+F4. Every accelerator is user-overridable (item 40). User must verify on Windows that a native menu accelerator wins over Monaco for Ctrl+Shift+F, F4, F5, F9 (item F.2).

### A.3 Deferred / skipped

| Item | Decision | Reason |
|---|---|---|
| Split view / clone to second pane, synced scroll | DEFER (phase 2) | `app.js` has one global `editor` and `activeTab.model` assumptions in ~40 places; a second editor needs `ctx.editor` to become "focused editor" everywhere, view-state per pane and layout of every document host. Not worth destabilising everything else; design hook kept: all feature code must read `ctx.editor` on each call, never cache it. |
| Replace in Files (unopened files) | DEFER | Writes to many files not open in tabs from a renderer-supplied request; needs conflict handling with dirty tabs and an undo story. Find in Files results + Replace in Open Tabs cover the safe 90%. |
| Change-history gutter | DEFER | Needs a per-keystroke line diff against the saved text; Monaco only exposes it through a hidden diff editor (cost/complexity). |
| Rename, Save a Copy As, Move to Recycle Bin, Open in Default Viewer | DEFER / SKIP | Rename/trash are destructive fs ops; `shell.openPath` executes arbitrary files (.exe/.lnk) so it is refused outright. Reveal in folder (`showItemInFolder`, non-executing) is included. |
| Import/export session files from arbitrary paths | SKIP | Would let a crafted file grant file access (the Notepad++ session path-traversal class). Named sessions live only in userData and are integrity-signed. |
| Character panel, Hide Lines, text direction RTL, Search on Internet, Open file at selection, tab sort, HTML export | DEFER | Low value or Monaco has no support (RTL, hidden areas); HTML export counts as print variant. |
| Plugin system, Run/external commands, OS shell integration, print variants | SKIP | Per user decision. |

---

## B. Architecture for extensibility

### B.1 Shared static files (loadable by main via `require` AND by the renderer via `<script src="../shared/...">`)

`shared/` files are UMD-style: `(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.NAME = factory(); })(this, ...)`. The sandboxed preload cannot `require` them; they are not needed there. CSP `script-src 'self'` already admits them (same as `../node_modules`). `package.json` `build.files` must add `shared/**`.

```
shared/
  settingsSchema.js        A1  window.CodePadSettingsSchema (also required by settingsStore.js)
  searchCore.js            A2  window.CodePadSearchCore (also required by findInFilesWorker.js)
  commands/core.commands.js    A1  File/Edit/View items that exist today + Window/Help/roles
  commands/search.commands.js  A2
  commands/text.commands.js    A3
  commands/view.commands.js    A4
  commands/tabs.commands.js    A5  (tabs, files, sessions, compare, macros)
```

### B.2 Command table (main reads it; one entry per command)

Each `*.commands.js` exports an array of:

```
{ id: 'text.sortAsc',            // unique, 'module.name'; the module prefix equals the file name
  title: 'Sort Lines Ascending', // menu label and palette label (no ampersands; mnemonics only on top-level menus)
  menu: 'Edit/Sort Lines',       // submenu path from the menubar, '/'-separated; omitted => palette only
  order: 10,                     // sort key inside that menu (ties: file order); 'separatorBefore': true allowed
  accelerator: 'CmdOrCtrl+...',  // optional default
  when: 'text' | 'any',          // default 'text'; 'text' commands show "Not available for this file type" on other tabs
  checkedSetting: 'editor.wordWrap',  // optional: renders as a checkbox bound to a boolean setting (main owns settings)
  role: 'quit' | 'togglefullscreen' | ...,  // optional Electron role instead of a click handler (no id handler needed)
  dynamic: 'recent',             // special: main fills the submenu from its recent-files list
  palette: true }                // default true
```

Top-level menu order is fixed in `main.js` (A1): `File, Edit, Search, View, Encoding, Tools, Macro` (+ `appMenu` on macOS). A menu path whose root is not in that list is ignored with a console warning. Submenus are created on demand from the path.

Main builds the menu at startup and rebuilds it (`Menu.setApplicationMenu`) on: settings change (keybinding overrides, `checkedSetting`), recent-list change. Click handler: `send('command', { id })`. The old `menu` channel and `menuActions` object are removed (replaced, not kept alongside); the current actions become commands `file.new`, `file.open`, `file.openAsText`, `file.openFolder`, `file.save`, `file.saveAs`, `file.saveAll`, `tabs.close`, `edit.palette`, `edit.gotoLine`, `edit.find`, `edit.replace`, `view.toggleSidebar`, `view.toggleMinimap`, `view.toggleWordWrap`, `view.toggleTheme`, `tabs.next`, `tabs.prev` in `core.commands.js`.

`commands:table` IPC returns the table after keybinding overrides (id, title, menu, accelerator, when) so the renderer can show shortcuts in the palette and the shortcut mapper.

### B.3 Renderer registry: `window.CodePadCommands` (A1, `renderer/core/commands.js`, loaded first)

```
CodePadCommands.register({ id, run(ctx, args) => void|Promise, enabled?(ctx) => boolean,
                           title?, category? })     // title/category only needed when the id is NOT in the static table (palette-only)
CodePadCommands.execute(id, args?)    // used by menu events, palette, context menus, macros; resolves, never throws (errors -> status bar)
CodePadCommands.list()                // [{id,title,category,accelerator,when}]
CodePadCommands.onExecute(cb)         // cb({id,args}) after a command ran; used by macro recorder
```
Rules: ids are unique (duplicate register throws); a `when:'text'` command runs only if `ctx.tabs.active()?.kind === 'text'`, otherwise the registry sets the status "Not available for this file type." Modules call `register` at script load (no ctx needed; `ctx` is injected on each run).

**Command palette:** the existing palette is Monaco's `editor.action.quickCommand`. The registry wires into it: when the editor exists (`editor:created` event) every registered, `palette !== false` command is added with `editor.addAction({ id: 'cp.' + id, label: `${category}: ${title}`, keybindings: [], run: () => execute(id) })`. No second palette UI is built. Commands registered later are added immediately. Non-text tabs keep today's behaviour (palette is a no-op with status message).

### B.4 Feature loader

```
CodePadFeatures.register(name, { init(ctx) })   // optional; init runs once after Monaco + the editor exist, before session restore
```
`app.js` calls every `init(ctx)` in registration (script) order inside try/catch: a throwing module is logged and shown once in the status bar; the rest keep working. Feature scripts call `register` at load. Panels, event subscriptions and decorations are created inside `init`.

### B.5 `ctx` (built in `app.js`, frozen, version 1) - the ONLY app surface features may use

```
ctx.monaco, ctx.editor                        // the namespace and the single editor; read ctx.editor on every call (never cache; see split view note)
ctx.tabs:
  list(): Tab[]    active(): Tab|null    byId(id): Tab|null
  activate(tab)    close(tab, {force}): Promise<boolean>    closeMany(tabs): Promise<boolean>   // honour pinned unless {force}
  move(tab, newIndex)                                       // pinned tabs stay in the left pinned block
  openPath(path, {line, col, asText}): Promise<Tab|null>    // path must be one main already allows (search results, recent, tree)
  openText({name, content, language}): Tab                  // untitled text tab
  openView(kind, {name, params}): Promise<Tab>              // non-file view tab (kind must be registered in CodePadEditors); params passed to create() as options.params
  reveal(tab, line, col, length?)                           // activate + select + scroll to center
  save(tab) / saveAs(tab) / saveAll(): Promise<boolean>
  reload(tab, {encoding}): Promise<boolean>                 // re-read from disk; asks first if dirty
  detectEol(content): 'lf'|'crlf'|'cr'
  changed(tab)                                              // call after mutating tab.persist or tab appearance fields: re-renders tabs + schedules a session save
ctx.text:                                                   // helpers over the active text tab (all no-ops with status message if none)
  selectionOrDocument(): {tab, model, ranges, isSelection}
  transformSelections(fn(text, info) => string, {scope:'selection'|'lines'|'document'|'wordOrSelection', label})   // one undo stop, keeps cursors sane
  transformLines(fn(lines: string[]) => string[], {scope:'selection'|'document'|'selectionOrDocument'})          // line-mode helper over transformSelections
  insertAtCursors(textOrFn)    replaceAll(model, edits, label)
ctx.files:
  readText(path, {encoding?}): Promise<ReadResult>   stat(path): Promise<Stat>   hashFile(path, algo): Promise<{hex,size}>
  reveal(path)   watch(path) / unwatch(path)   recent: {list(), add(path), clear(), approveAt(index)}
ctx.settings: get(key) / set(key, value) / patch(obj) / all() / onChange(cb({key,value}))   // validated by main; keys per section B.8
ctx.status:   set(text)    ctx.clipboard: write(text): Promise<void>
ctx.ui:       prompt({title, label, value, validate}) -> Promise<string|null>   confirm({title, message, buttons}) -> Promise<number>
              pick({title, items:[{label, detail, value}], multi?}) -> Promise<value|null>   (filterable list modal)
              contextMenu(x, y, items:[{label, accelerator?, checked?, disabled?, separator?, run}])    modal({title, body: HTMLElement, buttons}) -> {close()}
ctx.panels:   CodePadPanels (B.6)      ctx.commands: CodePadCommands      ctx.themes: CodePadThemes (B.9)
ctx.events:   on(name, cb) -> off()    emit(name, payload)     // names in B.7
ctx.session:  schedule()               snapshot(): Promise<Session>    restore(session, {replace}): Promise<void>
ctx.app:      version, platform ('win32'|'darwin'|'linux'), baseName(path), extensionOf(path)
```
`Tab` (documented, readable by features; writable only where marked):
```
{ id, kind: 'text'|'docx'|'sheet'|'pdf'|'diff', path|null, name, dirty,
  model?, encoding? (id from B.10), eol? ('lf'|'crlf'|'cr') [text only], language via model,
  diskStat? { mtimeMs, size } (set by app.js on every read/write; used by file watch),
  persist: { pinned:boolean, color:0..5, readOnly:boolean, bookmarks:number[], monitor:boolean }  // writable, then ctx.tabs.changed(tab)
}
```
Features keep private per-tab data in their own `WeakMap<Tab, ...>`; they never add ad-hoc fields to `tab`.

### B.6 Panels host: `window.CodePadPanels` (A1, `renderer/core/panels.js` + `panels.css`)

Layout (A1 edits `index.html`/`styles.css`): left `#sidebar` gets an icon/tab strip (`#sidebar-tabs`) above its body; `#main` gets `#bottom-panel` between `#editor/#views` and `#statusbar` with a tab strip, close button and a drag-resize handle.
```
CodePadPanels.register({ id, title, location: 'left'|'bottom', order,
                         render(container, ctx) -> { onShow?(), onHide?(), dispose?() } })   // render called lazily on first show
CodePadPanels.show(id, {focus}) / hide(id) / toggle(id) / isVisible(id) / active(location)
CodePadPanels.setBadge(id, text)       // e.g. result count
```
Built-in: left `explorer` (existing tree, A1 wraps it). Registered by features: left `search` (A2 Find form), left `documents` (A5), bottom `results` (A2), bottom `outline` (A4), bottom `clipboard` (A3), bottom `output` (A3, hashes/summary text with Copy button). Visible panel ids, active ids, bottom height and sidebar width persist in settings (`ui.*` keys). Panels use only CSS variables from `styles.css` and scope their classes with `.cp-<module>-`.

### B.7 Event names (`ctx.events`)

`editor:created(editor)`, `tab:created(tab)`, `tab:restored(tab)` (after session restore applied persist/bookmarks), `tab:activated(tab|null)`, `tab:closing(tab)` (sync, may read model), `tab:closed(tab)`, `tab:saved(tab)`, `tab:pathChanged(tab, oldPath)`, `tab:dirty(tab)`, `tab:reordered`, `tab:reloaded(tab)`, `session:beforeSnapshot()` (sync; modules flush state into `tab.persist`), `session:restored`, `settings:changed({key,value})`, `theme:changed(id)`, `folder:changed(rootPath|null)`, `file:changedOnDisk({path, kind})` (re-emitted watch events).

### B.8 Settings store (A1: `settingsStore.js` in main, `shared/settingsSchema.js`, `renderer/core/settings.js`)

Persisted at `userData/settings.json` (atomic temp+rename, mode 0o600). Replaces the `localStorage` keys `theme/minimap/wordWrap/sidebar`: at first start (file absent) the renderer sends the legacy values in one `settings:set`, then removes those localStorage keys. Main validation: unknown keys dropped, wrong type/range replaced by the default, strings length-capped, string lists capped. Schema entry: `{ type:'boolean'|'integer'|'enum'|'string'|'stringList'|'map', default, min?, max?, values?, maxLen?, maxItems?, monaco?: 'optionName' }`. Keys with `monaco` are applied generically by `app.js` to `editor.updateOptions({[monaco]: value})` (A1 implements the mapping; features and the settings panel never call `updateOptions` for them).

| Key | Type / default | Notes |
|---|---|---|
| ui.theme | enum of registered theme ids / `dark` | `CodePadThemes` ids; unknown id falls back to `dark` |
| ui.sidebar, ui.minimap (monaco `minimap.enabled`), ui.sidebarWidth(150-600, 260), ui.bottomPanel (bool), ui.bottomHeight(80-800, 240), ui.activeLeft, ui.activeBottom (string ids) | | |
| editor.wordWrap (bool, `wordWrap`: on/off), editor.fontFamily (string<=200), editor.fontSize (6-72, 14), editor.lineNumbers (on/off/relative), editor.tabSize (1-16, 4), editor.insertSpaces (bool true), editor.renderWhitespace (none/selection/boundary/all, selection), editor.renderControlCharacters (bool), editor.indentGuides (bool true; monaco `guides.indentation`), editor.cursorBlinking, editor.cursorStyle, editor.smoothScrolling, editor.scrollBeyondLastLine, editor.autoClosingBrackets, editor.autoIndent, editor.renderLineHighlight, editor.emptySelectionClipboard (copy line when no selection), editor.mouseWheelZoom, editor.wrapIndicator (`wrappingIndent`) | | all `monaco`-mapped |
| editor.showEol (bool false) | | implemented by view.js (A4), not a Monaco option |
| editor.tabSizeByLanguage | map<langId, 1..16> (<=60) | applied per model by view.js (A4) via `model.updateOptions` |
| files.fallbackEncoding | enum of encoding ids / `windows-1252` | used when a file is not valid UTF-8 and has no BOM |
| files.defaultEncoding | enum / `utf8` | new untitled tabs |
| files.defaultEol | enum lf/crlf/platform / `platform` | new untitled tabs |
| files.trimTrailingOnSave | bool false | |
| files.watch | bool true | external-change watching |
| autosave.mode | enum off/afterDelay/onFocusLoss / `off` | |
| autosave.delayMs | 1000-600000 / 30000 | |
| search.defaultExcludes | stringList <=50 x <=100 / `node_modules,.git,.svn,.hg,dist,build,out,.next` | Find in Files directory names to skip |
| search.maxResults | 100-20000 / 5000 | |
| search.maxFileKB | 64-20480 / 5120 | |
| clipboard.historyEnabled | bool true; clipboard.historySize 5-100 / 30 | memory only, never persisted |
| keybindings | map<commandId, accelerator or ''> (<=200) | validated: id exists in command table, accelerator matches `^(CmdOrCtrl\|Ctrl\|Cmd\|Alt\|Shift)(\+(CmdOrCtrl\|Ctrl\|Cmd\|Alt\|Shift))*\+([A-Za-z0-9,.\-=/\[\]\\;'`]\|F([1-9]\|1[0-9]\|2[0-4])\|PageUp\|PageDown\|Home\|End\|Insert\|Delete\|Tab\|Enter\|Space\|Up\|Down\|Left\|Right)$` or a bare F-key; `''` clears the accelerator |

---

## C. IPC and main-process contracts

All handlers use `handle()` (sender check). Preload exposes them as `window.codepad.*` (flat names kept for existing calls; new areas namespaced). Errors reject with a plain `Error` message (shown in the status bar); expected conditions are returned as data.

### C.1 Changed channels

| Channel (preload) | Args -> returns |
|---|---|
| `fs:read` (`readFile(path, opts?)`) | `opts.encoding?: string` (encoding id, forces decoding). Returns `{path, encoding, content, mtimeMs, size, replaced:boolean}` or `{path, binary:true, size}` / `{path, tooLarge:true, size}` as today. `replaced` = decoded text contains U+FFFD (wrong guess; UI offers Reopen with Encoding). |
| `fs:write` (`writeFile(path, content, encoding, opts?)`) | `opts.allowLossy?: boolean` (default false). Returns `{ok:true, mtimeMs, size}` or `{ok:false, lossy:true, firstBad:number, badChar:string}` when the target encoding cannot represent the text (nothing is written). Content over 64 MB or non-string -> reject. |
| `fs:writeBinary` | additionally returns `{mtimeMs, size}`. |
| `session:save` / `session:load` | shapes extended per C.6; `load` returns `{root, untitledCount, tabs, integrity:'ok'|'failed'|'none'}`. |
| `menu` event | REMOVED, replaced by `command` event (`onCommand(cb({id}))`). |

### C.2 New channels

| Channel (preload) | Args -> returns | Validation / caps |
|---|---|---|
| `encoding:list` (`encodings.list()`) | -> `[{id,label,group,bom:boolean}]` | static from `textCodec.js` |
| `encoding:check` (`encodings.check(content, id)`) | -> `{lossy, firstBad, badChar, count}` | id whitelist; content string <= 64 MB |
| `fs:stat` (`statFile(path)`) | -> `{exists, isFile, mtimeMs, size}` | `resolveAllowed`; never throws for ENOENT |
| `fs:hash` (`hashFile(path, algo)`) | -> `{hex, size}` | algo in md5/sha1/sha256/sha384/sha512; regular file; streamed; <= 2 GB |
| `shell:reveal` (`reveal(path)`) | -> void | `resolveAllowed`, then `shell.showItemInFolder(real)` only (never `openPath`) |
| `search:start` (`search.start(opts)`) | -> `{searchId}` | C.3 |
| `search:cancel` (`search.cancel(searchId)`) | -> boolean | |
| event `search:event` (`search.onEvent(cb)`) | `{searchId, type:'matches'|'progress'|'done'|'error', ...}` | C.3 |
| `watch:add` / `watch:remove` (`watch.add(path)`, `.remove(path)`) | -> `{ok}` | C.4 |
| event `watch:event` (`watch.onEvent(cb)`) | `{path, kind:'changed'|'deleted'|'renamed', mtimeMs, size}` | C.4 |
| `settings:get` / `settings:set` (`settings.get()`, `.patch(obj)`) | -> full validated object (+ `fresh:boolean` on first get) | <= 60 keys per patch; schema validation |
| `commands:table` (`commands.table()`) | -> table entries with effective accelerators | |
| `recent:list` / `recent:add` / `recent:approveAt` / `recent:clear` | list -> `[{path,name,openedAt}]`; add(path) -> void; approveAt(index) -> path; clear | C.5 |
| event `open-paths` (`onOpenPaths(cb({paths, line}))`) | from recent menu, command line, second-instance | paths approved by main before the event |
| `macros:get` / `macros:set` (`macros.get()`, `.set(list)`) | list of macros | C.5 |
| `sessions:list` / `save` / `load` / `delete` (`sessions.*`) | C.6 | |
| `window:setFullScreen(bool)`, `window:setAlwaysOnTop(bool)` | -> void | boolean check only |

### C.3 Find in Files (main process, A2 `findInFiles.js` + `findInFilesWorker.js`; A1 only wires the handler)

`search:start` options (all validated in `findInFiles.start`): 
```
{ query: string (1..1000), isRegex, matchCase, wholeWord, extended: boolean, dotAll: boolean,
  include: string[] (<=20 patterns, each <=100 chars, name globs "*.js", "*.{ts,tsx}" NOT supported => use two patterns; chars limited to [A-Za-z0-9_.*?-]),
  exclude: string[] (directory names, <=50),            // default = settings search.defaultExcludes
  subPath: string|null,        // relative to the approved root; resolved + realpath'd + must be inside root; no '..', no absolute, no drive letters
  includeHidden: boolean (default false),
  maxResults: 100..20000, maxFileKB: 64..20480 }       // clamped; main uses the lower of option and settings caps
```
The root is ALWAYS `fileAccess.getApprovedRoot()` (null => reject "Open a folder first"); the renderer never sends a root.

Execution: `findInFiles.start` spawns a `worker_threads` Worker (`findInFilesWorker.js`) with `workerData = {root, opts}`. A worker is used so a pathological regex cannot freeze the app and cancellation is a real `worker.terminate()`. Walk: `fs.opendir` iteration, depth limit 40, entry cap 200000, wall limit 120 s. Per entry: use `Dirent` + `lstat`; symlinks and Windows junctions/reparse points (`isSymbolicLink()` true) are NEVER followed or searched (policy: no follow-symlinks option in v1); every directory descended is additionally `realpath`-checked to equal `path.join(realParent, name)`; hidden (dot) entries skipped unless `includeHidden`; excluded directory names skipped; non-regular files skipped (FIFO/devices). File filters: include globs against the file name only; size > maxFileKB -> counted as `skippedLarge`; first 8 KB containing a NUL (unless UTF-16 BOM or UTF-16 NUL pattern per `textCodec.detect`) -> `skippedBinary`; the same `textCodec.decode` as fileAccess is used (so Find in Files sees what the editor sees), fallback encoding = setting. Matching uses `CodePadSearchCore` (shared). Preview = the matching line cut to 300 chars around the match.

Event stream (`search:event`, batched at most every 60 ms or 200 matches, whichever first):
```
{type:'matches', searchId, files:[{path (absolute, joined from real root), rel, matches:[{line, col, length, preview, previewStart}]}]}
{type:'progress', searchId, filesScanned, matchCount}
{type:'done',  searchId, totals:{filesScanned, filesMatched, matchCount, skippedBinary, skippedLarge, truncated:boolean, cancelled:boolean, elapsedMs}}
{type:'error', searchId, message}        // e.g. invalid regex, regex watchdog timeout
```
Hard caps: `maxResults` total (then `truncated:true`, worker terminated), at most one search at a time (a new `search:start` cancels the running one), watchdog: no message from the worker for 10 s -> terminate + `error: "Search stopped: the pattern is too slow."`. `path` values are produced by main and are inside the root; the renderer opens them with `tabs.openPath` which goes through `fs:read`/`resolveAllowed` again.

### C.4 File watching (A5 `fileWatcher.js`, wired by A1)

`fileWatcher.js` exports `createWatcher({ resolveAllowed, onEvent, maxWatches: 200 })` -> `{ add(path): Promise<boolean>, remove(path), dispose() }`. Implementation: `fs.watch(dirname(real), {persistent:false})` ONE watcher per directory (ref-counted), filtering on the file's basename (watching the directory survives the atomic temp+rename that `writeAtomic` and many editors use; watching the file inode would go blind). Events are debounced 250 ms per path, then `fs.stat` decides: ENOENT -> `deleted`; otherwise `changed` with fresh `mtimeMs,size`. The renderer compares to `tab.diskStat` and ignores events equal to it (this is how our own saves are not reported as external changes; `fs:write` returns the new stat). Paths are re-resolved through `fileAccess.resolveAllowed` on `add` (A1 exports `resolveAllowed`); watchers are closed on `remove`, on tab close, when the folder root changes, and in `dispose()` at quit. Errors from `fs.watch` (EPERM, ENOSPC) close that watcher and return `{ok:false}`; the feature then falls back to a stat check on window focus (also implemented by A5). Setting `files.watch=false` disables watching.

### C.5 Persistence: recent files, macros, settings

Common helper `userStore.js` (A1): `readJson(name)`, `writeJson(name, value)`; files in `userData/` (`recent.json`, `macros.json`, `settings.json`), atomic temp+rename, mode 0o600, whole-file cap 1 MB (macros 2 MB), signed with the integrity helper of C.7 where they contain paths (`recent.json`).

* **Recent files** (`recent.json`): `{version:1, items:[{path,openedAt}]}`, <= 30, newest first, de-duplicated by normalized real path. `recent:add(path)` requires `fileAccess.isAllowed(path)` (so only files the user opened/saved/dropped or inside the root). On load each path goes through `assertUsablePath`; entries are NOT re-approved until clicked. `recent:approveAt(index)` and the main-built File > Open Recent items call `fileAccess.approveFile(listPath)` for a path taken from main's own list (never a renderer string) and then emit `open-paths`. A missing file is removed from the list with a status message. `recent:clear` empties it and rebuilds the menu.
* **Macros** (`macros.json`): `{version:1, macros:[{name (<=60, control chars stripped), steps:[Step]}]}`, <= 100 macros, <= 5000 steps each. `Step` is exactly one of `{t:'type', text:string(<=10000)}`, `{t:'key', key:KeyName}` (KeyName from the closed list in D.9), `{t:'cmd', id:string (<=80, must exist in command table), args?: JSON-safe object <= 1 KB}`. Anything else is dropped. Main never executes macros.

### C.6 Session snapshot and named sessions

Per tab (text tabs): existing fields + `encoding` (id from the extended list, validated by `textCodec.isKnownEncoding`), plus `eol` ('lf'|'crlf'|'cr'), `pinned:boolean`, `color:0..5`, `readOnly:boolean`, `monitor:boolean`, `bookmarks:int[]` (<= 10000 entries, each 1..10,000,000, sorted unique). Document tabs: `pinned`, `color`. Tabs of kind `diff` are NOT persisted (app.js omits them; `KINDS` in sessionStore stays `text|docx|sheet|pdf`). `sessionStore.normalizeTab` drops everything not in this list. Caps added (see F): `content` <= 256 MB total per session, `viewState` JSON <= 64 KB per tab, at most 200 tabs (existing).

Restore (A1 `app.js` `restoreSnapshot(session, {replace})`, shared by startup and named sessions): create tabs as today with the extended encoding; set `tab.persist` from the snapshot; emit `tab:restored(tab)` for each so bookmarks (A2) re-create decorations (lines > lineCount are discarded), pins/colors re-render (A5), read-only applies (A3); text tabs whose saved encoding is not UTF-8/UTF-16 are re-read with that encoding id (`fs:read` with `opts.encoding`), so a Shift-JIS file stays Shift-JIS after restart; unsaved text still comes from the snapshot string.

Named sessions (A1 `sessionStore.js`, UI by A5 `sessions.js`): files `userData/sessions/<id>.json`, `id = crypto.randomBytes(8).toString('hex')` (validated `^[0-9a-f]{16}$` on every use; the renderer never supplies a file name). Content `{version:1, name, savedAt, session}` + integrity signature. 
* `sessions:list` -> `[{id,name,savedAt,tabCount}]` (reads headers only, <= 100 sessions).
* `sessions:save(name, snapshot)` -> `{id}`; the name (<= 60, control/bidi chars stripped, trimmed, non-empty) is display-only; saving the same name overwrites that session's id. The snapshot goes through the same `normalizeSession` + `authorizePath = fileAccess.isAllowed` as `session:save` (only already-allowed paths are stored).
* `sessions:load(id)` -> same result as `session:load` (re-approval of each tab path and the root through `fileAccess`, subject to integrity check C.7); the renderer then calls `restoreSnapshot(..., {replace:true})` after `confirmDiscard` on dirty tabs.
* `sessions:delete(id)`.

### C.7 Encoding contract (A1: new `textCodec.js` used by `fileAccess.js` and by `findInFilesWorker.js`)

`textCodec.js` exports:
```
ENCODINGS: [{id, label, group, bom}]       isKnownEncoding(id): boolean
detect(buffer, {fallback}) -> {encoding, offset}          // BOM, then NUL-pattern UTF-16, then strict UTF-8, else fallback
decode(buffer, encodingId|null, {fallback}) -> {encoding, content, replaced}   // null => detect
encode(content, encodingId) -> Buffer
checkEncodable(content, encodingId) -> {lossy:boolean, firstBad:number, badChar:string, count:number}
```
**Ids** (stable, lower-case; stored in sessions and settings): `utf8`, `utf8bom`, `utf16le`, `utf16be` (these two WITH BOM, as today), `latin1` (kept for old sessions; native Node), and via iconv-lite: `windows-1250..1258`, `windows-874`, `iso-8859-2,3,4,5,6,7,8,9,10,13,15,16`, `koi8-r`, `koi8-u`, `cp437`, `cp850`, `cp852`, `cp866`, `macintosh`, `shift_jis`, `euc-jp`, `gbk`, `gb18030`, `big5`, `euc-kr`. At module load every iconv id is filtered through `iconv.encodingExists`; `encoding:list` returns only the ones that exist, grouped (Unicode, Western European, Central European, Cyrillic, Greek/Turkish/Hebrew/Arabic/Baltic, Chinese, Japanese, Korean, Thai/Vietnamese, DOS/OEM).
**Detection** (open without explicit encoding): 1) BOM: UTF-8, UTF-16 LE/BE (UTF-32 BOMs are not supported, the file is reported binary as today); 2) no BOM but the first 4 KB has NUL in >= 90% of even (BE) or odd (LE) positions and almost none in the other positions -> `utf16le`/`utf16be` (written back WITH BOM; documented behaviour change); any other NUL -> binary as today; 3) strict UTF-8 (`TextDecoder` fatal) -> `utf8`; 4) otherwise `files.fallbackEncoding` (default `windows-1252`, "ANSI"). There is no automatic CJK/Cyrillic sniffing (unreliable); the status-bar picker and `replaced` flag cover it. Note: `windows-1252` replaces the old silent `latin1` fallback because Latin-1 maps 0x80-0x9F to control characters; existing `latin1` tabs/sessions still load.
**Round-trip safety**: `decode` of a legacy encoding sets `replaced` if U+FFFD appears. On write, `encode` for non-Unicode encodings is verified with `checkEncodable` (encode -> decode -> compare; first differing index reported). If lossy and `allowLossy` is false, `fs:write` returns `{ok:false, lossy:true,...}` and writes nothing; the UI offers "Save as UTF-8 instead" / "Save anyway (characters become ?)" / cancel. Unicode encodings are always lossless (lone surrogates are the one exception and are reported the same way). No silent substitution anywhere.

### C.8 fileAccess / sessionStore audit (Notepad++ 8.9.8 lessons): concrete fixes for Agent 1

| # | Gap found | Fix |
|---|---|---|
| F1 | `assertUsablePath` rejects `\\`/`//` UNC, but accepts Windows alternate data streams (`file.txt:hidden`), reserved device names (`CON`, `NUL`, `COM1`, `LPT1`..., with or without extension) and segments ending in `.` or space. | On `win32` reject: any `:` after index 1, segments matching `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i`, segments ending with `.` or space. |
| F2 | `isInside` uses `relative.startsWith('..')`, which wrongly rejects a legitimate child like `..foo` (and is the wrong shape of check). | `relative === '..' \|\| relative.startsWith('..' + path.sep)`. |
| F3 | `sessionStore.load` re-approves every path in `session.json` and the saved `root` without verification: a tampered/synced/crafted session file grants read+write to any file or a whole drive (the session path-traversal class). | (a) Sign `session.json`, named sessions and `recent.json` with HMAC-SHA256 using a random 32-byte key stored in `userData/store.key`, wrapped with `safeStorage.encryptString` when `isEncryptionAvailable()` (plain with mode 0o600 otherwise; documented as tamper-evident only). New `integrity.js` (A1): `sign(obj)`, `verify(obj)`. (b) On verification failure `load` returns `integrity:'failed'`: tabs with a `path` and the `root` are dropped, only untitled text is restored, and the status bar tells the user. (c) `approveRoot(p, {fromSession:true})` additionally refuses a filesystem root (`path.parse(real).root === real`) and the user's home directory itself. |
| F4 | Session content has no size caps except tab count; `viewState` is arbitrary JSON; `session.json` holds unsaved text with default permissions. | Caps per C.6; write session/store files with `{mode: 0o600}` (POSIX; harmless on Windows); `fs.mkdir(dir, {mode:0o700})`. |
| F5 | `approveFile` for a restored/dropped path accepts existing non-regular files (device/FIFO) and the approved set only grows. | `approveFile` stats and requires `isFile()` when the path exists; `approveRoot` clears `approvedFiles` entries that were session-restored only if the root changes (keep dialog-granted ones). Optional, cheap. |
| F6 | `writeAtomic` places the temp file next to the target (`<name>.codepad-<pid>-<ts>.tmp`) and `rename`s over it; a hard-linked target is silently unlinked from its siblings and the target's ownership/ACL/ADS are not carried. | Document the hard-link behaviour in README "known limits"; keep atomic write (data-loss protection outweighs it). No code change required beyond F1. |
| F7 | Renderer-supplied `fs:approveDropped` path relies on `webUtils.getPathForFile` in preload; main trusts the string. | Acceptable (renderer cannot call the channel directly; synthetic `File`s return `''`); main must additionally `assertUsablePath` and reject empty strings (already the case). No change. |
| F8 | TOCTOU between `stat` size check and `readFile` in `readTextFile` (file grows). | Read through a `FileHandle` with a hard `MAX_FILE_BYTES+1` read cap and fail if exceeded. |

Already good and to be preserved: UNC rejection incl. realpath result, symlink resolution before the allow-list check (`realpathOrParent`), approving only the real path, sender check in `handle()`, atomic writes.

### C.9 Window and menu extras (A1)

Command-line: `process.argv.slice(app.isPackaged ? 1 : 2)`: args not starting with `-` that are absolute or resolvable files -> `fileAccess.approveFile` then `open-paths {paths, line}` after the renderer finished restore (`app.js` calls `codepad.ready()` -> main flushes queued paths); `-n<digits>` sets `line` for the first path; `-nosession` skips `session:load` (main returns `null` once). Same handling for `second-instance` (its `argv`). `window:setFullScreen` and `window:setAlwaysOnTop` call the BrowserWindow methods with `=== true`.

---

## D. Per-module specifications

Conventions: modules are IIFEs; no globals except the ones named here; every public function documents params/returns in JSDoc; all DOM text via `textContent`; no inline handlers; CSS uses `.cp-<module>-*` classes and the variables in `styles.css`.

### D.1 Search (A2): `shared/searchCore.js`, `findInFiles.js`, `findInFilesWorker.js`, `search.js`, `search-results.js`, `bookmarks.js`, `search.css`, `shared/commands/search.commands.js`

`CodePadSearchCore` (pure, no DOM, no Node-only API):
```
expandExtended(str): string                       // \n \r \t \0 \\ \xHH \uHHHH -> literal; throws SyntaxError on a malformed escape
buildMatcher({query,isRegex,matchCase,wholeWord,extended,dotAll}) -> {regex: RegExp /gu(+i,+s), replaceText(rep): string} | {error: string}
   // non-regex: escape; wholeWord: (?<![\p{L}\p{N}_])...(?![\p{L}\p{N}_]); regex + replace supports $1 $& and \n \t when extended
findAll(text, matcher, {limit}) -> [{index, length, line, col, lineText}]    // line/col 1-based; zero-length matches advance lastIndex; stops at limit
replaceAll(text, matcher, replacement) -> {text, count}
```
Renderer (`search.js`): left panel `search` = form (query, replace, options Aa / word / .* / extended / dot-matches-newline, scope select `Folder | Open Tabs | Current Tab`, include filter, exclude dirs, subfolder picker limited to `tree` folders, buttons Find All / Replace All / Count / Mark All, Cancel while running). Commands: `search.findInFiles` (focus panel with scope Folder, prefill from selection), `search.findInTabs`, `search.findInCurrent`, `search.count`, `search.replaceInTabs`, `search.gotoOffset` (prompt: decimal offset or `0x..`; uses `model.getPositionAt`), `search.selectBetweenBrackets` (match `()[]{}` pair around cursor with a quote/string-unaware depth scan, select inside), `search.findNonAscii` (preset regex `[^\x00-\x7F]`).
* Folder scope: `window.codepad.search.start(opts)`; listens `search:event` for its own `searchId`; feeds the results panel incrementally; re-click cancels via `search.cancel`.
* Tab scope: for each text tab `findAll(model.getValue(), matcher, {limit: remaining})`; offsets -> `model.getPositionAt`. Replace in Open Tabs: per tab one `model.pushEditOperations` (edits sorted, applied as one undo group, label "Replace in tabs"), read-only tabs skipped and reported; confirm dialog showing counts first.
`search-results.js` (bottom panel `results`): exposes `window.CodePadSearchResults = { show(resultSet), clear(), next(), prev() }`. Data shape:
```
ResultSet { id, title, scope:'folder'|'tabs'|'tab', query, options, totals:{files,matches,filesScanned,skippedBinary,skippedLarge,truncated,cancelled,elapsedMs},
            files:[{ key, label, path|null, tabId|null, collapsed, matches:[{line,col,length,preview,previewStart}] }] }
```
Tree UI (file rows collapsible, "line:col  preview" rows with the match highlighted via `textContent` splits), up to 20 previous result sets kept as tabs of the panel, double-click or Enter opens via `ctx.tabs.openPath(path,{line,col})`/`ctx.tabs.reveal`; F4/Shift+F4 step through the active set; Delete removes a row; badge shows match count.
`bookmarks.js`: per tab bookmarks via `editor.createDecorationsCollection` (glyph margin class `cp-bookmark`, requires `glyphMargin:true` set by A1); source of truth = decoration ranges; `session:beforeSnapshot` writes `tab.persist.bookmarks` (sorted line numbers); `tab:restored`/`tab:created` re-creates from `persist.bookmarks`. Commands (all `bookmark.*`): toggle, next, prev (wrap), clearAll, cutLines, copyLines, pasteLines (replace bookmarked lines with clipboard text), deleteLines, deleteUnmarked, inverse; gutter click toggles. Marks: five decoration styles `cp-mark-1..5` (colors in `search.css`, theme-aware via variables), commands `mark.style1..5` (token = selection, else word under cursor; marks all occurrences, case-sensitive), `mark.clear` (selected style or all), `mark.next`/`mark.prev` (jump among marks of any style), `mark.fromFind` (current Find form query, optional "bookmark marked lines"). Mark state is per tab, not persisted.

### D.2 Text tools (A3): `text-tools.js`, `column-editor.js`, `clipboard-history.js`, `converters.js`, `hashes.js`, `text-tools.css`, `shared/commands/text.commands.js`

All line/blank/sort operations use `ctx.text.transformLines(fn, {scope:'selectionOrDocument'})`: the selection (expanded to whole lines) when non-empty, otherwise the whole document; result applied as one undo stop; trailing EOL preserved. Case ops use scope `wordOrSelection` (selection, else word at cursor, else document if empty doc line is not applicable: status "Nothing to convert").
* Line ops: `text.splitLines` (prompt width, default 80; hard-wrap at whitespace, never inside a word longer than width), `text.removeDuplicates` (keep first), `text.removeConsecutiveDuplicates`, `text.removeEmptyLines`, `text.removeBlankLines` (whitespace-only), `text.reverseLines`, `text.shuffleLines` (Fisher-Yates over `crypto.getRandomValues`), `text.eolToSpace`.
* Sorts: `text.sortAsc/Desc` (code-unit order, already also via Monaco but included for the menu symmetry), `sortCaseInsensitive[Desc]`, `sortByLength[Desc]` (stable), `sortInteger[Desc]` (leading `-?\d+`, lines without number sort first), `sortDecimalDot[Desc]`, `sortDecimalComma[Desc]`, `sortLocale[Desc]` (`localeCompare` with `numeric:true`). Sorting is stable.
* Case: `text.upper`, `lower`, `proper`, `sentence`, `invert`, `random`.
* Blank: `text.trimLeading`, `trimTrailing`, `trimBoth`, `tabsToSpaces` (tabSize from model), `spacesToTabsLeading`, `spacesToTabsAll`.
* `text.insertDateShort|Long|Custom` (short = `toLocaleDateString()+' '+toLocaleTimeString()`, long = `toLocaleString(undefined,{dateStyle:'full',timeStyle:'medium'})`, custom = prompt with tokens `yyyy MM dd HH mm ss`, remembered in `localStorage` as a per-viewer convenience).
* `text.toggleReadOnly` (tab) and `text.readOnlyAll`: sets `tab.persist.readOnly`, applies `editor.updateOptions({readOnly})` on `tab:activated`; tab shows the existing `.readonly` style; `text.redact` (replace selection with `█` per char).
* Column editor (`column-editor.js`): `ctx.ui.modal` with tabs Text / Number (initial, increment, repeat, zero pad toggle, base dec/hex/oct/bin, upper-case hex). Application: with several selections, insert at each selection start (replacing it) in document order; with one multi-line selection, insert at its start column on every line (short lines padded with spaces); with one cursor, insert on that line only. One undo stop.
* Clipboard history (`clipboard-history.js`): captures `copy`/`cut` on the editor DOM (capture phase; computes text from the model selections, or the current line when `emptySelectionClipboard` and no selection) and `ctx.clipboard.write` calls; memory only (never persisted, cleared on quit), de-duplicated, entries <= 100 KB, count per `clipboard.historySize`; bottom panel `clipboard` lists entries (first 120 chars), click inserts at cursors, button copies back, Clear all; disabled by `clipboard.historyEnabled=false`.
* Converters (`converters.js`; commands `conv.*`): Base64 encode/decode (UTF-8 aware, URL-safe variant, optional 76-column line breaks), URL encode/decode (`encodeURIComponent`/`decodeURIComponent`, malformed -> status error, no edit), ASCII->Hex / Hex->ASCII (space-separated `41 42`), JSON: `json.pretty` (indent = model tab settings, key order kept), `json.minify`, `json.validate` (error line/col from `JSON.parse` message; reveals the position), XML: `xml.pretty`, `xml.minify`, `xml.validate` (`DOMParser('application/xml')`, `parsererror` text -> line/col; pretty printer walks the DOM, keeps comments/CDATA/PI/doctype, trims whitespace-only text nodes, keeps inline mixed text). All operate on selection else whole document and only replace the text on success. Entity/DTD: DOMParser does not fetch external entities; documents are not rendered.
* Hashes (`hashes.js`; commands `hash.selection`, `hash.tab`, `hash.file`, `hash.currentFile`): text hashes use `crypto.subtle.digest` (SHA-1/256/384/512) over the UTF-8 bytes of the selection or tab text and an in-house MD5 (`md5(bytes: Uint8Array): string`, RFC 1321, < 80 lines, test vectors listed in the file header). Files use `ctx.files.hashFile(path, algo)` (main, streamed). Output goes to the bottom `output` panel (algo, value, Copy button); the algorithm list is a `ctx.ui.pick` multi-select. The `output` panel is registered by A3 and also used by A4's Summary.

### D.3 Encoding, EOL and view (A4): `encoding.js`, `view.js`, `themes.js`, `view.css`, `themes.css`, `shared/commands/view.commands.js`

* `encoding.js`: status-bar encoding label becomes a button (A1 changes the element to `<button id="status-encoding">`; A4 binds the click). Commands: `enc.reopenWith` (pick from `codepad.encodings.list()`, grouped; calls `ctx.tabs.reload(tab,{encoding})`; confirms if dirty because edits are discarded; warns if `replaced`), `enc.convertTo` (pick; first `encodings.check(model.getValue(), id)`; on lossy shows count/first bad char and asks to continue; sets `tab.encoding = id` and marks the tab dirty through `tab.persist`-independent flag `ctx.tabs.forceDirty(tab)`; saved bytes follow `tab.encoding`), `enc.setDefault` (writes `files.defaultEncoding`), `enc.eolLf|Crlf|Cr` (LF/CRLF: `model.pushEOL`; CR: `tab.eol='cr'` and model stays LF, conversion happens in `app.js` at write time), the default EOL for new tabs comes from `files.defaultEol`. Status bar EOL text shows LF/CRLF/CR; click opens the EOL menu.
* `view.js`: `view.toggleWhitespace` (`editor.renderWhitespace` all/selection), `view.toggleEol` (setting `editor.showEol`; implemented with `after` decorations "LF"/"CRLF"/"CR" restricted to the visible ranges +/- 200 lines, refreshed on scroll/content change, disabled above 200k lines), `view.toggleControlChars`, `view.showAllSymbols` (whitespace + EOL + control chars), `view.toggleIndentGuides`, `view.toggleWrapSymbol`, `view.zen` (adds `body.zen`: hides tabs, sidebar, status bar, bottom panel; calls `codepad.window.setFullScreen(true)`; Esc or the same command restores the exact previous visibility), `view.alwaysOnTop` (checkbox, `window:setAlwaysOnTop`), `view.summary` (chars, chars without EOL, words, lines, bytes in the tab's encoding via `TextEncoder`/size estimate, selection counts; shown in `output` panel), panel switches `view.showExplorer`, `view.showDocuments`, `view.toggleBottomPanel`.
* `themes.js`: registers via `ctx.themes.register({id,label,base:'vs'|'vs-dark',monaco:{colors,rules}, ui:{cssVar:value}})`: `monokai`, `solarized-dark`, `solarized-light`, `zenburn`, `obsidian`, `hc-black` (maps to Monaco's built-in). Own palettes only (no copying of Notepad++ theme files). `themes.css` holds `:root[data-theme='<id>']` variable blocks. Command `view.theme.<id>` per theme plus a picker `view.theme.pick`.
* Settings panel and outline: D.7 and D.8.

### D.4 Tabs (A5): `tabs.js`, `tabs.css`, `shared/commands/tabs.commands.js`

`app.js` (A1) provides three tab-bar extension points; A5 supplies the behaviour:
```
ctx.tabs.decorate(fn(tab, el, labelEl))        // called inside renderTabs for every tab (A5 adds pin icon, color bar, no close button when pinned, draggable attrs)
ctx.tabs.onContextMenu(fn(tab, event))         // A5 opens ctx.ui.contextMenu; app.js suppresses the default menu
ctx.tabs.interceptClose(fn(tab) => boolean)    // return false to veto (pinned tabs on middle-click / close buttons)
```
Features: pin/unpin (`tab.persist.pinned`; pinned tabs are kept contiguous at the left, `ctx.tabs.move` enforces it, Close Others/Left/Right/All skip pinned), colors 1..5 (class `cp-tabcolor-N`, palette in tabs.css, `tab.persist.color`), drag reorder (HTML5 drag within `#tabs`, same-block only), `tabs.moveLeft/Right`, `tabs.goto1..9`, close variants (`closeOthers|Left|Right|Unchanged|AllButPinned|All`, each uses `ctx.tabs.closeMany`, which runs `confirmDiscard` per dirty tab and stops on cancel), Copy Full Path / File Name / Directory (`ctx.clipboard.write`), Reveal in Folder (`ctx.files.reveal`), Reload, Save, Save As, Read-only toggle (via command from A3), Pin/Color submenu. Closed-tab stack (max 20, remembers path, encoding, language, viewState, and for untitled/dirty tabs the full text up to 1 MB; kept in memory, not persisted): `tabs.restoreClosed`. Document List panel (left `documents`): list of open tabs (pin/dirty/readonly markers), click activates, context menu = tab menu, drag reorder.

### D.5 Files: reload, watch, auto-save, recent (A5): `files.js`

* Reload: `files.reload` -> `ctx.tabs.reload(tab)`; asks (`ctx.ui.confirm`) when dirty; keeps encoding unless chosen; text tabs keep language/view state; document tabs are re-created.
* Watch: on `tab:created/restored/pathChanged` call `ctx.files.watch(path)` (text and document tabs with a path, only when `files.watch`); on `tab:closed` unwatch; on `file:changedOnDisk` compare to `tab.diskStat` (equal -> ignore). `changed`: if tab clean -> silent reload with status "reloaded <name>"; dirty -> non-modal banner row above the editor ("<name> changed on disk. [Reload] [Keep mine] [Compare]"; shown once per change, deduped by mtime; Compare opens the diff tab of D.6 against the disk text); `deleted`: banner "was deleted. [Keep open] [Close]" and the tab becomes dirty-marked so Save re-creates it. All pending banners are re-checked via `fs:stat` on window focus. Monitoring (`files.monitor`, checkbox, `tab.persist.monitor`): on `changed` reload silently and scroll to the last line if the cursor was at the end; read-only is forced while monitoring.
* Auto-save: timer per `autosave.mode`: `afterDelay` restarts on each edit and saves dirty text tabs with a path (never untitled, never document tabs, never tabs with a pending external-change banner or a lossy encoding); `onFocusLoss` saves on `window.blur`/tab switch. Uses `ctx.tabs.save`; session snapshots (unsaved text) keep working independently.
* Recent: `files.openRecent` (pick from `ctx.files.recent.list()`, then `approveAt(index)` + `openPath`), `files.openAllRecent`, `files.clearRecent`. `tab:saved` and successful opens call `recent.add(path)`. The File > Open Recent submenu is built by main.

### D.6 Compare (A5): `compare.js`, `compare.css`

Registers `CodePadEditors.register('diff', { extensions: [], create })` (binary-formats view interface; `readOnly:false`, `saveMode:'saveAs'`-irrelevant: the app treats `kind:'diff'` as non-saveable, `isDirty()` always false). `create({container, params, theme, callbacks})`, `params = {leftTabId, rightTabId}` or `{leftTabId, rightText, rightLabel}` (disk compare). It builds `monaco.editor.createDiffEditor(container, {automaticLayout:true, renderSideBySide:true, originalEditable:false, ignoreTrimWhitespace:false})`; models: tabs' real models when comparing tabs (edits stay live in both), a temporary model (`monaco.editor.createModel(text, language)`, disposed in `dispose()`) for disk text. Toolbar (own DOM): Previous/Next change (`diffEditor.goToDiff('previous'|'next')`), toggle side-by-side/inline, toggle ignore-trim-whitespace, swap sides. Commands: `compare.withTab` (pick open text tab), `compare.withDisk`, `compare.withClipboard` (temp model from clipboard text, size cap 5 MB). `getStatusText()` returns "N differences". Closing the diff tab never closes the compared tabs. `diff` tabs are skipped by session snapshot and by autosave/watch.

### D.7 Macros (A5): `macros.js`

Recorder (commands `macro.toggleRecord`, `macro.playback`, `macro.runMultiple`, `macro.runToEnd`, `macro.save` (name prompt), `macro.run.<n>` entries come from `ctx.ui.pick` of saved macros, `macro.delete`): while recording, status bar shows "REC". Captured steps: typed text -> `editor.onDidType(text)` coalesced into `{t:'type'}`; edit/navigation keys from a closed set (`left,right,up,down,home,end,pageUp,pageDown,backspace,delete,enter,tab` with optional `shift`/`ctrl` modifiers, KeyName `shift+ctrl+right` etc.) via `editor.onKeyDown` (keyCode mapping, no other key is recorded); CodePad commands via `CodePadCommands.onExecute` (only commands with `when:'text'`, args JSON-safe; the macro commands themselves, `file.*`, `tabs.*`, `search.findInFiles` are excluded). Find/Replace widget actions and mouse actions are not recordable (documented limit). Playback: executes steps in order on the active text tab: `type` -> `editor.trigger('macro','type',{text})`, `key` -> `editor.trigger('macro', <Monaco command id from a fixed map>, null)` (e.g. `cursorLeft`, `cursorWordLeftSelect`, `deleteLeft`, `lineBreakInsert` -> `type '\n'`, `tab`), `cmd` -> `CodePadCommands.execute`. Recording is disabled during playback; playback is wrapped in one undo stop; `runMultiple` prompts N (<= 100000), `runToEnd` repeats until the cursor stops moving or reaches the last line (iteration cap 1e6). Persistence: `macros:get/set` (C.5); the last recorded macro is `Current Macro` (memory).

### D.8 Outline (A4): `outline.js`

Bottom panel `outline`; `getSymbols(tab) -> Promise<Symbol[]>`, `Symbol = {name, kind:'function'|'class'|'method'|'heading'|'section'|'variable', line, level}`. Sources: (1) JavaScript/TypeScript tabs: the Monaco TS worker (`monaco.languages.typescript.getTypeScriptWorker()` -> `getNavigationTree(uri)`), flattened; (2) all other languages: an in-house regex table keyed by language id (python `def|class`, go `func`, rust `fn|struct|impl|trait`, java/c#/c/cpp/kotlin/swift function and type heads, php/ruby/lua/shell function forms, markdown headings (level = #count), ini `[section]`, yaml top-level keys, sql `CREATE ...`, batch labels); symbols are found with `matchAll` over lines, comments/strings are not parsed (documented heuristic). Refresh debounced 500 ms on content change and on `tab:activated` while the panel is visible; click -> `ctx.tabs.reveal`; filter box; sort toggle (position/alphabetical).

### D.9 Settings panel (A4): `settings-panel.js`

`ctx.ui.modal` full-size dialog opened by `settings.open`; left category list (Editor, Display, Files & Encoding, Auto-save, Search, Tabs, Shortcuts, Clipboard), right form generated from `CodePadSettingsSchema` entries plus a label/description table inside the module; every control writes through `ctx.settings.set` immediately (live apply, no Save button) with the validation error from main shown inline; Reset-to-default per row. Shortcuts page: table from `codepad.commands.table()`; click a row -> "Press keys" capture box (Esc cancel, Backspace clears) producing an Electron accelerator string; duplicates within the table are flagged (but allowed); stored in `keybindings`; main rebuilds the menu. A warning line states that Monaco's own editor shortcuts (Ctrl+D, Ctrl+K..., F2, F12) are not remappable here. Per-language tab size editor: list of `{language, size}` using the language picker data.

### D.10 Key names used by macros
`left,right,up,down,home,end,pageUp,pageDown,backspace,delete,enter,tab` optionally prefixed by `shift+`, `ctrl+` or `ctrl+shift+` (macOS: `ctrl` means the Option/Cmd-word-motion equivalent via the same Monaco command ids).

---

## E. File layout and ownership

### E.1 Ownership table (a file has exactly ONE owner; nobody edits another owner's file)

| Owner | Files |
|---|---|
| **A1 glue/infra** | `main.js`, `preload.js`, `fileAccess.js`, `sessionStore.js`, `package.json` (+ `package-lock.json` via the user), `renderer/index.html`, `renderer/styles.css`, `renderer/app.js`; NEW: `textCodec.js`, `settingsStore.js`, `userStore.js`, `integrity.js`, `menuBuilder.js` (table loader + native menu), `shared/settingsSchema.js`, `shared/commands/core.commands.js`, `renderer/core/{bus.js,commands.js,settings.js,ui.js,panels.js,themes.js,features.js}`, `renderer/core/core.css` (modal/context menu/quick pick/panels styles), the documentation files (G). |
| **A2 search** | `findInFiles.js`, `findInFilesWorker.js`, `shared/searchCore.js`, `shared/commands/search.commands.js`, `renderer/features/search.js`, `search-results.js`, `bookmarks.js`, `search.css` |
| **A3 text tools** | `shared/commands/text.commands.js`, `renderer/features/text-tools.js`, `column-editor.js`, `clipboard-history.js`, `converters.js`, `hashes.js`, `text-tools.css` |
| **A4 view/encoding/settings/outline** | `shared/commands/view.commands.js`, `renderer/features/view.js`, `encoding.js`, `themes.js`, `outline.js`, `settings-panel.js`, `view.css`, `themes.css` |
| **A5 tabs/files/sessions/compare/macros** | `fileWatcher.js`, `shared/commands/tabs.commands.js`, `renderer/features/tabs.js`, `files.js`, `sessions.js`, `compare.js`, `macros.js`, `tabs.css`, `compare.css` |

`renderer/core/themes.js` (A1) is the registry `CodePadThemes` (`register`, `list`, `apply(id)`, `get(id)`); built-ins `dark`, `light` are registered by A1; A4's `themes.js` adds the rest.

### E.2 Script/stylesheet load order (A1 writes `index.html` once, containing all tags below; a not-yet-existing feature file only logs one 404 in the console, which is harmless)

```
CSS:  styles.css, core/core.css, editors/{docx,sheet,pdf}-editor.css,
      features/{search,text-tools,view,themes,tabs,compare}.css
JS (all classic, in this order, before app.js):
  ../node_modules/monaco-editor/min/vs/loader.js
  ../shared/settingsSchema.js, ../shared/searchCore.js
  core/bus.js, core/commands.js, core/settings.js, core/themes.js, core/ui.js, core/panels.js, core/features.js
  editors/common.js, editors/docx-editor.js, editors/sheet-editor.js, editors/pdf-editor.js
  features/search.js, search-results.js, bookmarks.js,
  features/text-tools.js, column-editor.js, clipboard-history.js, converters.js, hashes.js,
  features/view.js, encoding.js, themes.js, outline.js, settings-panel.js,
  features/tabs.js, files.js, sessions.js, compare.js, macros.js
  app.js
```
Dependencies between features go only through `ctx`/events/commands, never through each other's globals, with two sanctioned exceptions: `window.CodePadSearchResults` (A2, used only by A2) and the bottom panel id `output` registered by A3 and used via `ctx.panels.show('output')` plus the helper `ctx.ui.output(title, text)` (A1 implements `ui.output` as "show panel `output` and set its content"; if A3's panel is absent it falls back to `ctx.ui.modal`). CSP stays: `script-src 'self' 'wasm-unsafe-eval'`; no inline scripts or handlers.

### E.3 Coding against the contract while A1 is unfinished

A2-A5 write against sections B and C verbatim. To test syntax independently they may use a throw-away shim OUTSIDE the repo tree (scratchpad), never committed: `{CodePadCommands:{register(){}}, CodePadFeatures:{register(){}}}`. Rules: (1) a feature script's top-level code only calls `CodePadCommands.register(...)`, `CodePadFeatures.register(...)` and `CodePadEditors.register(...)`; everything touching `ctx` lives inside `init(ctx)` or `run(ctx)`; (2) use only the `ctx` members listed in B.5 and the `window.codepad.*` names listed in C.2 (A1 must expose exactly these names; any naming ambiguity resolves to the preload names in C.2, e.g. `codepad.search.start`, `codepad.watch.add`, `codepad.encodings.list`, `codepad.window.setAlwaysOnTop`); (3) command ids and menu entries in each `*.commands.js` must be final before the module's JS is written (A1's `menuBuilder.js` only needs the table shape of B.2); (4) main-side helper files export the exact functions named in C.3/C.4 (`findInFiles.start(opts, {root, send})` returning `{searchId, cancel()}`; `createWatcher(...)`); A1 wires them with the signatures given here; (5) integration order after A1 finishes: A1 reports `ctx`/preload final names -> A2-A5 reconcile only their own files. The orchestrator (not an agent) runs the cross-check that every id in a `*.commands.js` has a registered `run`.

A1 delivers in this order so others unblock early: (1) `renderer/core/*`, table loader and `index.html` script/CSS tags, (2) `ctx` + preload names + IPC stubs returning the C.1/C.2 shapes, (3) fileAccess/textCodec/session/settings hardening, (4) menu builder, (5) the app.js refactor of `menuActions` into core commands.

### E.4 A1 changes inside `app.js` (checklist, no feature logic)

Replace `menuActions`/`api.onMenu` with registry `execute`; build `ctx` and run feature inits after `editor` creation (`glyphMargin:true`, options from settings schema, `editor:created`); move theme/minimap/wordWrap/sidebar to the settings store (with the one-time localStorage migration); generic `editor.*` setting applier; `Tab.persist`, `tab.eol` (detect on open, 'cr' converted at write), `tab.diskStat` (set from `fs:read/write` results), `tab.encoding` ids; `ctx.tabs.*` API, `decorate/onContextMenu/interceptClose`, `forceDirty`; `write` path handles `{ok:false,lossy:true}` (prompt: save as UTF-8 / save anyway / cancel); `trimTrailingOnSave`; extract `restoreSnapshot(session,{replace})`; emit events of B.7; `kind:'diff'` tabs (no path, excluded from snapshot, closing never prompts); `status-encoding` as button; `activateTab`/`removeTab` call `view.layout()` for panel resizes (`layoutActiveView` after panel show/hide and splitter drag); remove dead code replaced by the above (old `menuActions`, `localStorage` theme/minimap/wordWrap keys, `ENCODING_LABELS` replaced by the list from `encoding:list`).

---

## F. Security checklist and what only the user can verify

### F.1 Checklist (reviewer ticks against the code)

1. Every new IPC is registered with `handle()`; none accepts a root path; paths go through `resolveAllowed`/`isAllowed`; `recent`, `sessions`, command-line and drop paths are approved by main from main-originated data only.
2. Find in Files: root = `getApprovedRoot()`; `subPath` canonicalized and inside root; symlinks/junctions never followed or searched; per-directory realpath check; regular files only; binary and size skips; result, depth, entry and time caps; one search at a time; worker terminate on cancel/watchdog; user-supplied regex only runs in the worker; glob/exclude inputs validated and never turned into RegExp except via escaped literals.
3. File watch: allow-listed, <= 200 watchers, directory-level, debounced, closed on tab close/root change/quit; no path in events other than the one registered.
4. `fs:hash`: algo whitelist, streamed, regular files only; `shell:reveal` uses `showItemInFolder` only; `shell.openPath`/`openExternal` for files is NOT used anywhere new.
5. Encoding: ids whitelisted via `isKnownEncoding` at every boundary (IPC, session, settings); lossy writes never silent; iconv-lite only in main/worker; `build.files` contains `node_modules/iconv-lite/**` (+ `safer-buffer` and any dependency it needs; A1 checks with `npm ls iconv-lite --all` that the runtime closure is included) and `shared/**`, `textCodec.js`, `settingsStore.js`, `userStore.js`, `integrity.js`, `menuBuilder.js`, `findInFiles.js`, `findInFilesWorker.js`, `fileWatcher.js`.
6. Settings/keybindings/macros/recent/sessions: schema or step-grammar validation in main, size caps, atomic writes, mode 0o600, HMAC integrity for path-bearing files (C.8 F3); renderer data never used as a file name (session ids are generated hex).
7. Command table: main sends only ids from its own table; accelerators from `keybindings` are validated by regex and wrapped in try/catch when building the menu (an invalid accelerator is dropped, not fatal).
8. Renderer: every user/file-derived string is inserted with `textContent` (results previews, outline names, clipboard history, document list, banners); no `innerHTML` with dynamic data (the existing static close-button markup excepted); no inline scripts/handlers; no `eval`/`new Function`; clipboard history is memory-only and limited.
9. No new CSP relaxation; no new dependency except iconv-lite 0.7.3 (pinned exactly, MIT); `asar:false` unchanged; macOS/Linux: `CmdOrCtrl` accelerators only, `process.platform` guard for the Windows-only path rules (F1).
10. Diff/compare and Monitoring never write to disk; autosave writes only through `ctx.tabs.save`.

### F.2 Items only the user can verify by running

1. Native accelerator vs Monaco precedence on Windows: Ctrl+Shift+F, F4, F5, Shift+F5, F7, F9, Alt+F2/F3, Ctrl+J, Ctrl+, , Ctrl+Shift+U/H/M/Y/D/E fire the CodePad command and not a Monaco action; no Ctrl+Alt combination typed characters on a non-US layout.
2. Find in Files on a large repo (e.g. `node_modules` excluded and included): speed, cancel responsiveness, caps message, no UI freeze; a catastrophic regex such as `(a+)+$` is stopped by the watchdog; a symlink/junction to outside the root yields no results from outside.
3. Encoding: open files saved in Windows-1251, Shift-JIS, GBK, UTF-16 without BOM, UTF-8 with BOM; Reopen with Encoding shows correct text; Convert to Windows-1252 of text containing CJK triggers the lossy prompt and writes nothing until confirmed; round-trip save keeps bytes; old session with `latin1` still restores.
4. External change: edit the file in another editor (clean tab reloads silently, dirty tab shows banner); own Save does not trigger the banner; delete/rename the file; Monitor (tail -f) on a growing log; behaviour on network-synced folders (OneDrive) is acceptable.
5. Session: restart restores pins, colors, bookmarks, read-only, per-tab encoding; named session save/load/delete; hand-editing `session.json` or `recent.json` (add a path) causes the integrity failure notice and no access is granted.
6. Auto-save modes, Compare (tab vs tab, vs disk, vs clipboard), macros (record typing + commands, replay, run N times, persistence across restart), hashes against known vectors (`md5("abc") = 900150983cd24fb0d6963f7d28e17f72`, `sha256("abc") = ba7816bf...15ad`) and a file hash vs `certutil -hashfile`.
7. Cross-platform: macOS menu (app menu role, `Cmd` accelerators), Linux packaging includes `shared/` and iconv-lite; Windows reserved-name/ADS rejection (`C:\x\file.txt:s`, `CON`) gives a clean error.
8. Distraction-free/full-screen/always-on-top restore state exactly; theme switch re-themes the docx/sheet/pdf views and the diff view; panels persist size/visibility across restarts.
9. Existing behaviour intact: Monaco text tabs, session restore with unsaved text, docx/xlsx/pdf open/edit/save, file tree, drag-drop.
10. `npm audit` / packaged build (`dist:win`) contains iconv-lite and `shared/`; first-run localStorage-to-settings migration keeps the user's previous theme/minimap/wrap.

---

## G. Documentation updates (A1 owns all; update only what changed)

* `.claude/ARCHITECTURE.md`: new tree (shared/, renderer/core/, renderer/features/, new main-side files), one-line descriptions, module relationships (command table -> menuBuilder -> `command` event -> `CodePadCommands`; `ctx` surface; panels host; search worker; watcher), tab kinds incl. `diff`, new IPC overview, data stores in userData (`settings.json`, `recent.json`, `macros.json`, `sessions/`, `store.key`).
* `.claude/SETUP.md`: iconv-lite 0.7.3 in dependencies (note: main-process only), userData files and their reset (delete to reset), command-line arguments (`-n<line>`, `-nosession`), build.files additions, where logs/settings live.
* `.claude/CLAUDE.md` (durable decisions only): commands are declared in `shared/commands/*.commands.js` and registered with `CodePadCommands`; features only use `ctx`; only A1-type work edits `app.js`/main glue; path-bearing stores are HMAC-signed and re-approved through fileAccess; Find in Files runs in a worker in main, never follows symlinks; no `shell.openPath`; iconv-lite is the sole new dependency; `windows-1252` fallback; the split-view deferral and its constraint ("never cache `ctx.editor`"); settings schema is the single source for editor options.
* `README.md`: feature list additions, full shortcut table (A.2 plus existing), encodings supported, known limits (macros do not record find/replace or mouse; outline is heuristic for non-JS/TS; Find in Files skips symlinks, binary and files over 5 MB by default; encoding detection is not automatic for CJK; no Replace in Files; no split view yet), `-n`/`-nosession` arguments.
* `.claude/docs/SECURITY_ASSESSMENT.md`: add an "Additional features" section summarizing F.1 and the C.8 fixes (A1, after implementation).
