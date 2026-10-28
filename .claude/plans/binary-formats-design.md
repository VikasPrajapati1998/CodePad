# Design: DOCX, spreadsheet and PDF editing in CodePad

Status: design only, nothing implemented. Decisions from the user are fixed (docx WYSIWYG, xlsx/csv grid, PDF text-layer editing with Save-As-only, view-only for scanned PDFs, local pinned permissive libs). The Sejda UX research file (`.claude/research/sejda-pdf-editor-ux.md`) did not exist when this was written; section F uses the generic click-a-text-run model and should be reconciled with it if it appears.

All library facts below were verified on 2026-10-27 by `npm view` / `npm pack` into the scratchpad and by listing the tarball contents (and grepping the built files). SheetJS was downloaded from `cdn.sheetjs.com` (the CDN connection resets intermittently; a resumed download worked).

---

## A. Library choices

| Purpose | Package | EXACT version | License | File used (inside node_modules) | Size | How loaded | CSP impact |
|---|---|---|---|---|---|---|---|
| PDF render + text extraction | `pdfjs-dist` | 6.4.299 | Apache-2.0 | `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`; assets `cmaps/`, `standard_fonts/`, `iccs/`, `wasm/{jbig2,openjpeg,qcms_bg}.wasm`, `wasm/{jbig2,openjpeg}_nowasm_fallback.js` | 459 KB + 1.26 MB; assets ~2.8 MB | ESM only (no UMD exists since v4). Lazy `await import(url)` from the classic `pdf-editor.js` (dynamic `import()` works in classic scripts, no `<script type="module">` needed). Worker: `GlobalWorkerOptions.workerSrc = <file URL of pdf.worker.min.mjs>` (pdf.js creates a module Worker) | `worker-src` must add `'self'`; `script-src` must add `'wasm-unsafe-eval'` (qcms colour-management has no JS fallback; jbig2/openjpeg do) |
| PDF writing | `@cantoo/pdf-lib` | 2.11.1 | MIT | `dist/pdf-lib.min.js` (UMD, global `PDFLib`) | 617 KB | `util.loadScript` classic `<script>` injected on first PDF save | none |
| PDF custom font embedding | `@pdf-lib/fontkit` | 1.1.1 | MIT | `dist/fontkit.umd.min.js` (global `fontkit`) | 758 KB | same, loaded only when a non-WinAnsi glyph is needed | none |
| DOCX read (to HTML) | `mammoth` | 1.13.0 | BSD-2-Clause | `mammoth.browser.min.js` (UMD, global `mammoth`) | 405 KB | lazy classic script | none (contains underscore `_.template` -> `new Function`, only reached if `template()` is called, which mammoth's conversion path does not) |
| DOCX write | `docx` | 9.14.0 | MIT | `dist/index.iife.js` (global `docx`; bundles jszip, hash.js, nanoid; not minified) | 1.37 MB | lazy classic script | none (contains one `eval`/`new Function` site in bundled helpers; not on the Packer path; user must confirm no CSP EvalError on save) |
| XLSX/XLS/ODS/CSV read+write | `xlsx` (SheetJS Community Edition) | 0.20.3 | Apache-2.0 | `dist/xlsx.full.min.js` (global `XLSX`) | 952 KB | lazy classic script | none |
| Rich-text UI | in-house (`contenteditable` + `document.execCommand`) | n/a | n/a | `renderer/editors/docx-editor.js` | ~900 lines | n/a | none |
| Spreadsheet grid UI | in-house virtualized grid | n/a | n/a | `renderer/editors/sheet-editor.js` | ~1,200 lines | n/a | none |

Total shipped addition: about 8.5 MB (pdf.js 4.5 MB incl. assets, docx 1.4, xlsx 1.0, pdf-lib+fontkit 1.4, mammoth 0.4).

### A.1 Evidence and reasoning per choice

- **pdfjs-dist 6.4.299** (latest, 2026-10-03): tarball has only `.mjs` builds under `build/` and `legacy/build/`; confirmed no UMD file. Apache-2.0. Chosen over 3.11.174 (last UMD) because 3.x predates the CVE-2024-4367 fix (font-handling arbitrary JS; fixed in 4.2.67). With 6.x we still pass `isEvalSupported:false`. Electron 44's Chromium supports ESM and module workers; the ESM-from-`file://` + module-worker combination is the single biggest "must be verified by the user" item (section H). Documented fallback if it fails: pin `pdfjs-dist@3.11.174`, load `build/pdf.min.js` as a classic script and `build/pdf.worker.min.js` as workerSrc, keep `isEvalSupported:false`; the PDF module hides this behind `loadPdfJs()` so only that one function changes. `enableScripting` stays false, so `quickjs-eval.*` (469 KB wasm) is NOT bundled. The `legacy/` builds are not needed (modern Chromium).
- **@cantoo/pdf-lib 2.11.1** vs `pdf-lib 1.17.1`: both MIT, both ship `dist/pdf-lib.min.js` UMD (`PDFLib`). `pdf-lib` was last published 2022-05; `@cantoo/pdf-lib` is a maintained API-compatible fork (published 2026-09), adds encrypted-PDF loading with a password, and its dist bundles its dependencies (no extra files). Fontkit registration (`pdfDoc.registerFontkit(fontkit)`) is present in the fork. Fallback if the fork misbehaves: `pdf-lib@1.17.1` (same API, swap path and global).
- **mammoth 1.13.0** (BSD-2): ships `mammoth.browser.min.js` UMD, `convertToHtml({arrayBuffer})`, images returned as `data:` URIs (allowed by `img-src data:`). Chosen over hand-parsing OOXML.
- **docx 9.14.0** (MIT): `dist/index.iife.js` exposes `docx.Document/Paragraph/TextRun/Table/ImageRun/ExternalHyperlink/Packer`. `Packer.toBlob()` works in browsers. Chosen over `html-docx-js` (abandoned, altChunk-based so Word-only). Nothing in the library needs network.
- **SheetJS CE 0.20.3**: the npm package `xlsx` is frozen at 0.18.5 (`npm view xlsx dist-tags` -> latest 0.18.5), which has known high-severity advisories (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363), fixed only in releases SheetJS distributes from its own CDN. We install the official tarball: `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` (downloaded and verified: 2,409,319 bytes, `package.json` version 0.20.3, license Apache-2.0, contains `dist/xlsx.full.min.js`). The version is encoded in the URL and `package-lock.json` records the tarball integrity hash, which satisfies "pin exact". `xlsx.full` (not `mini`) because it bundles the codepage tables needed for .xls and CSV and the ODS/FODS parsers (this gives .xls and .ods reading for free). Rejected alternative: ExcelJS 4.4.0 (MIT, `dist/exceljs.min.js`, 948 KB) preserves cell styles better but cannot read .xls/.ods, has an old transitive tree (archiver/unzipper/tmp, mostly unused in the browser bundle) and has not been released since 2024-12. Trade-off accepted: SheetJS CE does not write cell styling (fonts, fills, borders) back to .xlsx; see H.
- **Papaparse not added**: SheetJS handles CSV/TSV, so no extra dependency.
- **Rich-text component**: rejected TinyMCE (GPL/commercial since v7), CKEditor 5 (GPL/commercial), ProseMirror/Tiptap/Lexical (npm modules, require a bundler), Quill 2.0.3 (BSD-3, UMD ok, but no table support, which is a hard requirement). Summernote needs jQuery+Bootstrap. Therefore an in-house editor on `contenteditable` (Chromium-only target, so `execCommand` is reliable; deprecated but stable in Chromium and Electron).
- **Grid component**: rejected Handsontable (non-commercial license), Jspreadsheet CE 5.0.4 (no license field on npm, upsell-oriented, jsuites dependency), x-spreadsheet (stale, canvas, no clipboard model), AG Grid (heavy, tied to its own data model). In-house virtualized DOM grid over the SheetJS worksheet object.
- **Fonts for PDF re-drawing**: the 14 standard PDF fonts (no embedding, WinAnsi only) plus Liberation Sans Regular/Bold/Italic/BoldItalic, which already ships inside `pdfjs-dist/standard_fonts/` (SIL OFL 1.1, includes `LICENSE_LIBERATION`), embedded through fontkit with `subset:true` for non-WinAnsi Latin/Greek/Cyrillic text. No extra dependency.

### A.2 package.json changes (agent 1)

`dependencies` (exact, no carets):
```
"@cantoo/pdf-lib": "2.11.1",
"@pdf-lib/fontkit": "1.1.1",
"docx": "9.14.0",
"mammoth": "1.13.0",
"monaco-editor": "0.52.2",
"pdfjs-dist": "6.4.299",
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```
`build.files` additions (explicit paths so the Electron build does not pull the Node/legacy/map/types content):
```
"renderer/**",                                   (already present; covers renderer/editors/**)
"node_modules/pdfjs-dist/build/pdf.min.mjs",
"node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
"node_modules/pdfjs-dist/cmaps/**",
"node_modules/pdfjs-dist/standard_fonts/**",
"node_modules/pdfjs-dist/iccs/**",
"node_modules/pdfjs-dist/wasm/jbig2.wasm",
"node_modules/pdfjs-dist/wasm/jbig2_nowasm_fallback.js",
"node_modules/pdfjs-dist/wasm/openjpeg.wasm",
"node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js",
"node_modules/pdfjs-dist/wasm/qcms_bg.wasm",
"node_modules/pdfjs-dist/wasm/LICENSE*",
"node_modules/pdfjs-dist/LICENSE",
"node_modules/@cantoo/pdf-lib/dist/pdf-lib.min.js",
"node_modules/@cantoo/pdf-lib/LICENSE.md",
"node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js",
"node_modules/mammoth/mammoth.browser.min.js",
"node_modules/mammoth/LICENSE",
"node_modules/docx/dist/index.iife.js",
"node_modules/docx/LICENSE",
"node_modules/xlsx/dist/xlsx.full.min.js",
"node_modules/xlsx/LICENSE"                       (SheetJS ships it at dist/LICENSE too; include "node_modules/xlsx/dist/LICENSE")
```
`asar: false` stays (file:// worker and fetch of assets). Keep the pin comment in CLAUDE.md: pdf.js 6.x is ESM-only; downgrade path is 3.11.174.

---

## B. Tab model generalization

### B.1 Kinds
`kind` in `'text' | 'docx' | 'sheet' | 'pdf'`, chosen in `renderer/app.js` by `kindForPath(filePath)` using a lowercase extension table:

```
.docx -> docx          .xlsx .xls .ods .csv .tsv -> sheet          .pdf -> pdf          anything else -> text
```
Unknown extension keeps today's behavior (text; binary content still rejected by `fs:read`). `.doc`, `.xlsm`, `.xlsb`, `.odt` are NOT routed (opened as text -> "binary file" message). A dropped/opened `.csv` can be re-opened as text through File > "Open as Text Editor" (new menu action `openAsText`, applies to `csv/tsv` and any kind; asks to discard if dirty).

The kind routing table lives in app.js; each editor module also declares its `extensions` in its registration (used only for the file-dialog filter list built in main; main has its own static copy, see C).

### B.2 Tab object
```
{ id, kind, path, name, dirty,
  // text only (null for other kinds): model, encoding, viewState, savedVersion, autoDetect, detectTimer
  // non-text only: view (the View object), host (div element), restoredFrom ('disk'|'session'|'missing') }
```
`tabs`, `activeTab`, `renderTabs` (title, `.dirty` class, close), `closeTab`, `confirmDiscard`, `saveAll`, `cycleTab`, tree highlighting, session scheduling are kind-agnostic. Every use of `tab.model`, `tab.encoding`, `tab.viewState`, `editor.*` must be guarded by `tab.kind === 'text'` (the glue agent audits all of: `activateTab`, `closeTab`, `createTab`, `writeTab`, `saveTabAs`, `snapshotSession`, `restoreTab`, `updateStatusForModel`, `updateCursorStatus`, `scheduleLanguageDetect`, `els.lang` change handler, `els.eol` click handler, `runEditorAction`, `menuActions.find/replace/gotoLine/palette`, `applyTheme`, `setSidebarVisible` (`editor.layout()`), `toggleSetting`).

### B.3 View interface (implemented by docx, sheet and pdf modules)
A module registers itself on load:
```js
CodePadEditors.register('docx', { extensions: ['.docx'], create })   // create(options) -> Promise<View>
```
`options`:
```
{ container: HTMLElement,          // empty div owned by the glue; the view builds all DOM inside it, scoped under class .cp-<kind>
  bytes: Uint8Array | null,        // file bytes from disk; null only when restoring from session with the file missing (docx, sheet)
  fileName: string,                // display name only, never trusted as a path
  filePath: string | null,         // for display/extension (e.g. sheet needs .csv vs .xlsx); the module must never use it for I/O
  restoredState: object | null,    // the object previously returned by getSessionState(); applied on top of bytes
  theme: 'dark' | 'light',
  callbacks: { onChange(): void,   // call after every user mutation (cheap, may be called often)
               onStatus(text: string): void } }  // transient message for the status bar (#status-message)
```
`View` (all methods required unless marked optional):
```
kind:            'docx' | 'sheet' | 'pdf'
readOnly:        boolean                       // true => app disables Save/Save As entries (pdf scanned mode)
saveMode:        'overwrite' | 'saveAs'        // overwrite: Ctrl+S writes tab.path (allow-listed); saveAs: Ctrl+S always opens the Save dialog
saveFilters:     [{name:string, extensions:string[]}]   // for the Save As dialog, e.g. [{name:'Word Document',extensions:['docx']}]
defaultSaveName: string                        // suggested file name for Save As (pdf: "<base> (edited).pdf"; xls/ods: "<base>.xlsx")
getBytes(ext: string): Promise<Uint8Array>     // serialize current state for the target extension (lowercase, no dot: 'docx','xlsx','csv','tsv','pdf'). Throws Error with a user-presentable message on failure
isDirty(): boolean                             // true when state differs from the last markSaved()/load baseline
markSaved(): void                              // called by the glue after a successful write
getSessionState(): Promise<object|null>       // JSON-serializable snapshot of UNSAVED edits only (see D). null => nothing to persist OR too large (view returns null and sets view.sessionStateTooLarge = true)
getStatusText(): string                        // text for #status-info (page 2/9, "Sheet1 · A1", "words: 412")
layout(): void                                 // called when the host becomes visible or the window/sidebar resizes
focus(): void
dispose(): void                                // remove listeners, terminate workers, release pdf.js documents/canvases
find?(): void                                  // optional; Ctrl+F while this tab is active
setTheme?(theme): void                         // optional; modules style themselves with the CSS variables, so rarely needed
```
`create()` rejects with an `Error` (message shown in the status bar) for unreadable files; the glue then does not create a tab.

### B.4 Behaviour per kind in app.js

- **Containers**: `index.html` gets `<div id="views"></div>` after `#editor`. Each non-text tab owns `<div class="view-host hidden" data-kind="..">` inside `#views`, created at open time, never destroyed until the tab closes (so scroll/selection/undo survive tab switches). `activateTab`: save Monaco view state if the outgoing tab is text; hide `#editor` and all hosts; show the incoming host or `#editor`; call `view.layout()` and `view.focus()`, or `editor.setModel/restoreViewState/focus` for text. `updateEditorVisibility` also hides `#views` when no tabs.
- **closeTab**: `confirmDiscard` unchanged (uses `tab.dirty`); then for non-text `view.dispose()` and remove `host`; text path unchanged (`model.dispose()`).
- **Dirty tracking**: for non-text tabs `callbacks.onChange` -> `tab.dirty = view.isDirty(); renderTabs()` (only re-render when the flag flips) + `scheduleSessionSave()`. Title uses the existing `document.title` logic.
- **Status bar**: add `<span id="status-info"></span>` before `#status-pos`. `document.body.dataset.kind = activeTab ? activeTab.kind : 'none'`; CSS `body:not([data-kind="text"]) #status-pos, ... #status-eol, #status-encoding, #status-lang { display:none }` and `body[data-kind="text"] #status-info { display:none }`. `updateStatusForModel` sets `els.info.textContent = view.getStatusText()` for non-text tabs (refreshed from `onChange`/`onStatus` and on activate). The language picker, EOL toggle and encoding label are hidden for non-text kinds (they have no meaning there); `els.lang` change/`els.eol` click handlers already no-op because they are not reachable, but still check `activeTab.kind === 'text'`.
- **Menu actions**: `find` -> `view.find?.()` for non-text, otherwise Monaco; `replace`, `gotoLine`, `palette`: Monaco for text; for non-text `palette` is a no-op (status "Not available for this file type"), `gotoLine` no-op. Zoom (`resetZoom` etc. are Electron roles) works for all views. `toggleWordWrap/Minimap` only touch Monaco.
- **Save routing** (section E): `saveTab(tab)`: text unchanged; non-text -> if `view.readOnly` do nothing with status "This PDF is view-only"; if `view.saveMode==='overwrite' && tab.path` -> `writeBinaryTab(tab, tab.path)`; else `saveTabAs(tab)`.
- **Open**: `openPath` does `kindForPath`; for non-text: duplicate check by `tab.path` (same path + same kind), `api.readBinary(path)`, create host + view, `addViewTab`. `handleOpenFiles` and drop are unchanged (they already feed `openPath`).
- **Tab icon/label**: none. A read-only PDF tab shows "(view only)" suffix in `tab.name` rendering (class `readonly`), and the tab tooltip states why.

---

## C. Binary I/O contract

### C.1 New IPC channels (all registered with `handle()` in `main.js`, sender-checked)

| Channel | preload name | Args | Returns | Notes |
|---|---|---|---|---|
| `fs:readBinary` | `readBinary(filePath)` | path string | `{ path, size, bytes: Uint8Array }` or `{ path, size, tooLarge: true }` | Path must be allow-listed (`resolveAllowed`). Extension must be in the binary table, else rejects "Unsupported file type". Size caps: docx 50 MB, xlsx/xls/ods 50 MB, pdf 100 MB, csv/tsv 50 MB |
| `fs:writeBinary` | `writeBinary(filePath, bytes)` | path, `Uint8Array` | `void` | Allow-listed path; extension must be in the write table (`.docx .xlsx .csv .tsv .pdf`); `bytes` must be `Uint8Array`/`ArrayBuffer` <= 200 MB; magic-byte check (`PK\x03\x04` for docx/xlsx, `%PDF-` for pdf); writes via temp file + rename |
| `dialog:saveAs` (extended) | `saveAsDialog(defaultPath, options?)` | `options = { filters?: [{name, extensions}], avoidPath?: string }` | path or `null` | Main sanitizes filters (name via `sanitizeForDialog`, extensions must match `/^[a-z0-9]{1,8}$/`, max 6 filters). `avoidPath`: if the chosen path resolves (realpath) to the same file, main shows a message box "Choose a different file name; the original PDF is never overwritten" and re-opens the dialog (loop; cancel returns `null`) |
| `dialog:confirmClose` (extended) | `confirmClose(name, kind?)` | name, optional kind | button index | `kind==='pdf'` -> detail "Saving creates a new copy. The original PDF is never modified." |
| `dialog:openFiles` (changed) | unchanged | - | approved paths | Adds `filters`: "All Files" (`*`, first), "Documents and Spreadsheets" (`docx xlsx xls ods csv tsv pdf`) |

Everything else (`fs:read`, `fs:write`, `fs:approveDropped`, `fs:readDir`, `session:*`) is unchanged. IPC structured clone carries `Uint8Array` without base64.

Renderer -> main `bytes` must be validated in the handler: `if (!(bytes instanceof Uint8Array)) throw`; then `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)`.

### C.2 fileAccess.js additions (agent 1)
- Constants: `BINARY_READ_LIMITS = { '.docx': 50MB, '.xlsx': 50MB, '.xls': 50MB, '.ods': 50MB, '.csv': 50MB, '.tsv': 50MB, '.pdf': 100MB }`, `BINARY_WRITE_EXTENSIONS = new Set(['.docx','.xlsx','.csv','.tsv','.pdf'])`, `MAX_WRITE_BYTES = 200MB`.
- `readBinaryFile(p)`: `resolveAllowed(p)` -> extension (lowercased from the REAL path) in table -> `stat` must be a regular file -> size > limit => `{path, size, tooLarge:true}` -> `fs.readFile` -> return `{ path: p, size, bytes: new Uint8Array(buffer) }` (Buffer is a Uint8Array subclass; return a plain copy-free `Uint8Array` view).
- `writeBinaryFile(p, bytes)`: `resolveAllowed(p)` -> extension check on the real path -> size/magic check -> shared `writeAtomic(real, buffer)`.
- Refactor: extract the existing temp-file+rename body of `writeTextFile` into `writeAtomic(real, buffer)` (same mode preservation, same cleanup) and have both writers call it (CLAUDE.md rule 15: no duplicate logic). Temp name already includes pid; for the extra safety against collisions append `Date.now()`.
- Export `readBinaryFile`, `writeBinaryFile`. No other export changes. `approveFile` already accepts a new (non-existent) path from the Save dialog and resolves its parent.
- Network paths stay rejected (UNC). Never accept a path from the renderer that was not approved: `Save As` approves the dialog result in main (`approveFile`) before returning it, exactly like today.

### C.3 preload.js additions (agent 1)
```js
readBinary: (filePath) => ipcRenderer.invoke('fs:readBinary', filePath),
writeBinary: (filePath, bytes) => ipcRenderer.invoke('fs:writeBinary', filePath, bytes),
saveAsDialog: (defaultPath, options) => ipcRenderer.invoke('dialog:saveAs', defaultPath, options),
confirmClose: (name, kind) => ipcRenderer.invoke('dialog:confirmClose', name, kind),
```
(the last two replace the existing definitions.) Nothing else is exposed; editor modules receive no `window.codepad` access and never call IPC (they only get bytes in, bytes out through the View contract).

### C.4 Security considerations
- **Paths**: the renderer never supplies an unapproved path; the PDF "avoid original" check is in main; dialog titles/names pass through `sanitizeForDialog`.
- **No network**: all libs and assets are local; pdf.js is configured with local `cMapUrl`, `standardFontDataUrl`, `iccUrl`, `wasmUrl`; `connect-src` is not widened (falls under `default-src 'self'`). Hyperlink targets in docx/PDF are never navigated by the app (`will-navigate` is already blocked; `setWindowOpenHandler` opens http/https externally; docx editor links are inert in the editing surface: clicks are `preventDefault`ed).
- **docx -> HTML injection**: mammoth output is NEVER assigned to `innerHTML` directly. Pipeline: `new DOMParser().parseFromString(html,'text/html')` (inert document, no script execution, no resource loads) -> allow-list walk that rebuilds nodes with `createElement`/`textContent` into the editor. Allowed elements: `p h1-h6 br strong b em i u s strike sub sup ul ol li a img table thead tbody tr td th blockquote pre code span div`; allowed attributes: `a[href]` (scheme http/https/mailto only, `rel=noopener noreferrer`, `target` dropped), `img[src]` (must match `^data:image/(png|jpe?g|gif);base64,`), `img[alt]`, `td/th[colspan|rowspan]`, `p/h*/li[style]` reduced to a parsed `text-align` value. All `on*`, `style` (otherwise), `class`, `id`, `srcdoc`, unknown tags are dropped; unknown elements are unwrapped (children kept). The same sanitizer runs on paste (`text/html` clipboard data) and on session-restore HTML.
- **xlsx**: cell strings are inserted with `textContent` only; hyperlinks and rich-text runs in cells are not rendered as HTML; sheet names validated (<=31 chars, none of `\ / ? * [ ] :`). Size guard: refuse to open when the used range exceeds 2,000,000 cells or 16,384 columns (message) to avoid UI hangs; zip bombs are bounded only by the 50 MB compressed cap and are a documented residual risk.
- **PDF**: `getDocument({ isEvalSupported:false, enableScripting:false, disableAutoFetch:true, disableStream:true, stopAtErrors:false, ... })`; annotation layer and XFA are not rendered (no clickable links, no form scripts); the pdf.js worker is a module worker from `'self'`. Passwords are asked in an in-view DOM form (not `prompt()`), never logged or persisted.
- **CSP** (exact new value, `renderer/index.html`, agent 1):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';`
  Only two relaxations: (1) `worker-src 'self'` so pdf.js can start `pdf.worker.min.mjs` (a packaged file; Monaco's `data:` workers remain); (2) `'wasm-unsafe-eval'` which allows compiling WebAssembly only, NOT `eval`/`new Function` (needed by pdf.js qcms for ICC colour; jbig2/openjpeg would fall back to JS). `'unsafe-inline'` for scripts stays absent. `style-src 'unsafe-inline'` already exists (Monaco) and is used by the editors for `element.style` (no `<style>` injection needed). If the user later confirms PDFs render without wasm, drop `'wasm-unsafe-eval'`. No `blob:` for img-src is needed (pdf.js draws on canvas; docx images are `data:`).

### C.5 Shared renderer helpers (`renderer/editors/common.js`, agent 1)
Classic script, defines `window.CodePadEditors`:
```
CodePadEditors.register(kind, def)          // store; app.js reads CodePadEditors.get(kind)
CodePadEditors.get(kind) -> def | undefined
CodePadEditors.util = {
  nodeModulesUrl(relPath): string,           // file URL of <app>/node_modules/<relPath> (same derivation as monacoBase in app.js)
  loadScript(url): Promise<void>,            // injects <script src>, resolves on load, caches by URL, rejects on error
  loadModule(url): Promise<object>,          // dynamic import(url), cached
  fetchBytes(url): Promise<Uint8Array>,      // fetch -> arrayBuffer; fallback to XMLHttpRequest on file://
  bytesToBase64(u8): string, base64ToBytes(s): Uint8Array,   // chunked, safe for multi-MB
  textToBytes(s): Uint8Array, bytesToText(u8): string
}
```
Editor modules must only use these helpers for I/O-ish needs and must not define globals other than `CodePadEditors.register(...)` side effects.

---

## D. Session restore for non-text tabs

### D.1 What is persisted
`snapshotSession()` adds, per non-text tab: `kind`, `path`, `name`, `state` (the object from `await view.getSessionState()`, or `null` when the tab is clean or the state is too large) and `stateTooLarge: boolean`. Text tabs keep `content`. `content` is `null` for non-text tabs. No bytes of unchanged files are ever stored (the file on disk is re-read).

Per-kind state (owned by each module, opaque to the glue):
- **docx**: `{ html: string }` = sanitized editor innerHTML (images are inline `data:` URIs inside it). Smaller and faster than re-zipping a docx.
- **sheet**: `{ ext: 'xlsx'|'csv'|..., sheets: [{ name, rows: (string|number|boolean|null)[][], formulas: {"r,c": "=A1+B1"}, merges: string[], colWidths: number[] }], activeSheet: number }` (cells stored as display/raw values, no SheetJS objects).
- **pdf**: `{ edits: Edit[], page: number, zoom: number }` where `Edit` is the JSON edit record from section F (new text, rects in PDF points, font keys); the PDF itself is re-read from disk.

### D.2 Size caps and sessionStore.js normalization (agent 1)
- `normalizeTab` adds: `kind` (must be in `{'text','docx','sheet','pdf'}`, default `'text'`), `state` (plain object or null; `JSON.stringify(state).length <= MAX_STATE_BYTES = 16 * 1024 * 1024`, else null and `stateTooLarge:true`), and forces `content = null` for non-text kinds. Text kinds ignore `state`.
- `normalizeSession` additionally enforces a total budget `MAX_TOTAL_STATE_BYTES = 64 MB` (tabs beyond it lose `state` and get `stateTooLarge:true`) and `MAX_TABS` stays 200. The renderer `session:save` payload can therefore still be ~64 MB: acceptable because it is written only on edit idle (800 ms debounce) and the sessionStore queue serializes writes; keep the existing temp+rename write.
- Authorization is unchanged: tabs with a `path` are kept only if the path is allow-listed on save / `approveFile` succeeds on load. `state` values are treated as untrusted data on load: every module validates its own state (types, array lengths, string lengths) and sanitizes HTML before use.
- The close flow: `requestClose` saves the session and then closes without prompting. For any tab with `dirty && stateTooLarge` (cannot be restored) the renderer must fall back to the `confirmDiscard` prompt for that tab before `approveClose()`. For read-only/clean tabs nothing is stored.

### D.3 Restore (`restoreTab` in app.js, agent 1)
1. Non-text, `path` present: `api.readBinary(path)`. If it succeeds: `create({bytes, restoredState: saved.state})`; the view applies the state on top and reports `isDirty()===true` when `state !== null` (so the dirty dot and later save prompts are right). `restoredFrom='disk'`.
2. File missing/unreadable/too large:
   - docx and sheet with a non-null `state`: `create({bytes:null, restoredState: state})`; the tab is dirty, keeps `path` (Save recreates the file; Save As is also available); status "X was not found on disk; restored your unsaved edits".
   - pdf (needs the original) or any tab with `state === null`: tab is skipped and counted in the existing "no longer exist" message.
3. `stateTooLarge` tab with the file present: opens clean from disk and status says "Unsaved changes in X could not be restored".
4. Failures inside a module's `create` during restore are caught per tab (one bad tab must not block the others) and reported in the status bar.
5. Active tab and tab order restore as today (`active` flag).

---

## E. Save semantics

| Kind | Ctrl+S | Save As | Write path | Prompt on close/discard |
|---|---|---|---|---|
| docx | overwrite `tab.path` | dialog, filter docx, then tab.path = new path | `view.getBytes('docx')` -> `writeBinary` | standard "Save / Don't Save / Cancel" |
| xlsx | overwrite `tab.path` | dialog, filters xlsx/csv | `getBytes('xlsx')` | standard |
| csv/tsv | overwrite `tab.path` | dialog, filters csv/tsv/xlsx | `getBytes('csv'|'tsv')`; single sheet only. Saving a multi-sheet context never happens for csv (a csv has one sheet) | standard |
| xls / ods | forced Save As (`saveMode:'saveAs'`, default name `<base>.xlsx`) because legacy writers are not offered | dialog, filter xlsx | `getBytes('xlsx')` | standard |
| pdf (editable) | alias of Save As, menu label stays "Save"; every save opens the dialog | dialog, filter pdf, `avoidPath = tab.path`, default name "<base> (edited).pdf" | `getBytes('pdf')` -> `writeBinary` | "Save changes to X?" with detail "Saving creates a new copy. The original PDF is never modified." |
| pdf (view-only) | no-op + status "This PDF is view-only." | same no-op | none | never dirty, never prompts |

Details (agent 1):
- `writeBinaryTab(tab, path)`: `bytes = await tab.view.getBytes(extOf(path))` -> `api.writeBinary(path, bytes)` -> `tab.view.markSaved()`; `tab.dirty = false`; status "Saved <name>". Failure: status "Could not save ...", dirty stays, returns false (so `confirmDiscard` does not close).
- After a successful Save As (any kind) the tab adopts the new path/name; the kind is re-derived from the new extension only when it differs (e.g. xlsx saved as csv): the tab keeps its view and kind `sheet`, but `view.getBytes` already took the target extension. PDF: after the copy is written, the tab switches to the saved copy: path/name updated, dirty false, and the view keeps its in-memory state (rendered edits flattened into the baseline by `markSaved()`: the pdf module treats `getBytes()`'s output as the new base document and clears its edit list). The original file is not touched at any point, and `avoidPath` ensures the next save cannot overwrite the copy that is now the current file either.
- `saveAll` skips read-only views and processes dirty non-text tabs through `saveTab` (pdf tabs each open a Save dialog; acceptable and documented).
- CSV encoding: the sheet module detects BOM (UTF-8 BOM preserved on save) and line endings (CRLF preserved); everything else UTF-8. Decoding of non-UTF-8 CSV falls back to Windows-1252 via `TextDecoder('windows-1252')` and writes back as UTF-8 (status note on first save).
- The "unsaved changes" prompt is unchanged for docx/sheet; PDF gets the extra detail line described in C.1.

---

## F. PDF editor design (`renderer/editors/pdf-editor.js`)

### F.1 Opening and mode detection
1. `loadPdfJs()` -> `util.loadModule(nodeModulesUrl('pdfjs-dist/build/pdf.min.mjs'))`; set `GlobalWorkerOptions.workerSrc`.
2. `getDocument({ data: bytes.slice(), cMapUrl, cMapPacked:true, standardFontDataUrl, wasmUrl, iccUrl, isEvalSupported:false, enableScripting:false, useWorkerFetch:false })` (URLs end with `/`; `useWorkerFetch:false` makes the main thread fetch assets so we only depend on `file://` fetch in the page context; to be verified by the user, H). Encrypted: `onPassword` callback drives an in-view password form; on wrong password re-ask.
3. **Text-layer detection**: iterate pages 1..N calling `page.getTextContent()`; the document is EDITABLE as soon as one page yields an item whose `str.trim().length > 0`; if all pages (cap: scan at most 500 pages, then assume view-only for the rest) yield none -> `readOnly = true` (scanned/image-only). Mixed documents are editable; pages without text simply have no selectable runs but still accept Add Text and Whiteout. A banner in view-only mode: "This PDF has no text layer (scanned/image). It opens view-only. Use an OCR tool first to make it editable."
4. Rendering: continuous vertical scroll, one `<canvas>` + overlay `<div>` per page, created lazily with `IntersectionObserver` (render ±1 page around the viewport, release canvases of far pages), device-pixel-ratio aware, zoom 50%-300% with fit-width default (Ctrl+wheel and toolbar). The text-layer overlay is OUR OWN absolutely positioned elements built from `getTextContent()` data (not `pdfjsLib.TextLayer`), so each run is a focusable edit target.

### F.2 Run model
`getTextContent()` items (`str`, `transform [a,b,c,d,e,f]`, `width`, `height`, `fontName`, `hasEOL`) are merged into **runs**: consecutive items on the same baseline (|Δf| < 0.2·fontSize), same `fontName` and same font size, with horizontal gap < 0.35·fontSize become one run (so a visual "line fragment" is one editable unit). Each run stores: `pageIndex`, `str`, `rect` in PDF user space `[x, y, w, h]` (`x=e`, baseline `y=f`, `h≈fontSize·1.2`, descent offset 0.2·fontSize), `fontSize = hypot(a,b)`, `fontName`, `styleFamily` (from `textContent.styles[fontName].fontFamily` -> serif / sans-serif / monospace), `bold`/`italic` inferred from the font name regex (`/bold|black|heavy|semibold|demi/i`, `/italic|oblique/i`), rotation = `atan2(b,a)` (non-zero rotation runs are shown but flagged "rotated text cannot be edited" and get no edit handle).
Colour and background are sampled from the rendered canvas inside the run rect: background = the most frequent colour at the rect's border pixels; text colour = the pixel in the rect farthest from the background (falls back to black on a white background).

### F.3 Tools (toolbar in the view, Sejda-style minimal)
- **Edit text** (default): click a run -> it becomes an in-place `<input>`/`contenteditable` box exactly over the run (same position, size, CSS `font-size = fontSize·zoom`, `font-family` from the style family, weight/style, sampled colour, background = sampled background), Enter/blur commits, Esc cancels, empty text deletes the run (whiteout only). A committed edit stays rendered as an HTML overlay (new text on a background-coloured patch) so what-you-see matches the output; clicking it re-opens it. Undo/redo (Ctrl+Z/Ctrl+Y) stack over the edit list.
- **Add text**: click empty area -> new text box (font family Helvetica/Times/Courier choice, size 6-96, bold/italic, colour picker); drag to move, handles to resize width (single-line; wraps by explicit newline only).
- **Whiteout**: drag a rectangle; filled with a chosen colour (default sampled page background / white). Can be combined with Add text to "redraw".
- **Delete edit**: select an overlay and press Delete (removes the pending edit, not original content).
- Toolbar also has zoom and page jump. It has no Save button: the glue owns saving (Ctrl+S / Ctrl+Shift+S / File menu).

Edit record (JSON, also the session state, see D):
```
{ id, page, type: 'replace'|'add'|'whiteout',
  rect: [x,y,w,h],            // PDF points, origin bottom-left, the area to cover
  origRect?: [x,y,w,h],       // replace only: original run rect (cover area)
  text?: string, fontSize?: number, fontKey: 'Helvetica'|'Times'|'Courier'|'Liberation',
  bold?: boolean, italic?: boolean, color?: [r,g,b] (0-1), bg?: [r,g,b] }
```

### F.4 Writing (`getBytes('pdf')`)
1. `util.loadScript` pdf-lib (+ fontkit lazily) -> `PDFDocument.load(originalBytes, { password?, ignoreEncryption:false, updateMetadata:false })` (original bytes kept in memory; the file on disk is never written).
2. For each edit in page order (pdf-lib page index = `edit.page`):
   - `replace`/`whiteout`: `page.drawRectangle({ x, y, width, height, color: rgb(bg), borderWidth:0 })` over `origRect` padded by 0.5 pt (account for page rotation and `CropBox` origin offsets: use `page.getCropBox()` offset and `page.getRotation()` to transform rects; if rotation != 0, rects are rotated accordingly).
   - `replace`/`add` with non-empty text: choose font:
     1. map `fontKey` + bold/italic to a StandardFont (`Helvetica[Bold][Oblique]`, `TimesRoman[Bold][Italic]`, `Courier[Bold][Oblique]`);
     2. try `font.encodeText(text)` (WinAnsi); on failure (non-Latin-1 characters such as Cyrillic, Greek, many punctuation) register fontkit once and embed the matching Liberation Sans TTF (`fetchBytes(nodeModulesUrl('pdfjs-dist/standard_fonts/LiberationSans-<Style>.ttf'))`, `subset:true`);
     3. if a glyph is still missing (CJK, Arabic, Devanagari, emoji, ligature/complex-script shaping): the edit is marked **unsupported**; the box shows a red outline and the editor refuses to save until the user removes those characters (message lists them). We never silently substitute `?`.
   - `page.drawText(text, { x, y: baselineY, size, font, color: rgb(color) })`. Baseline `y` = `rect.y` (the sampled run baseline). Multiple lines are split on `\n` with line height `1.2·size`.
3. `await pdfDoc.save({ useObjectStreams:true })` -> `Uint8Array`. Output is a full rewrite with a new trailer; a timestamp is not forced into metadata.
4. Original embedded fonts are not reused (a PDF subset font cannot be extended reliably), so edited text visually differs slightly from the original face; widths are not matched (text may be shorter/longer than the original run; long text may overflow into neighbouring content; we show the live width in the overlay and the user adjusts).

### F.5 Not supported (disclose)
Editing images or vector art, reflowing paragraphs, changing existing text's original font or kerning, editing form fields/annotations/bookmarks/links, page add/delete/rotate/reorder, digital signatures (a signed PDF loses its signature validity after saving), PDF/A conformance, tagged-PDF structure, JavaScript actions, XFA forms, redaction security: **whiteout/replace only paints over the old text; the original text remains in the content stream and is still selectable/searchable in the saved file, so this must NOT be used to remove confidential data**. Rotated text editing, vertical writing, complex scripts, bidi. Password-protected PDFs open if the password is supplied; the saved copy is written without encryption (stated in the password dialog).

---

## G. File layout and agent ownership

```
renderer/
  index.html                       [agent 1]  CSP, <div id="views">, #status-info, link CSS, script order
  styles.css                       [agent 1]  #views/.view-host layout, body[data-kind] status rules, .tab.readonly
  app.js                           [agent 1]  kind routing, tab model, save/open/session glue
  editors/
    common.js                      [agent 1]  CodePadEditors registry + util
    docx-editor.js  docx-editor.css      [agent 2]
    sheet-editor.js sheet-editor.css     [agent 3]
    pdf-editor.js   pdf-editor.css       [agent 4]
main.js, preload.js, fileAccess.js, sessionStore.js, package.json  [agent 1]
package-lock.json                  [user: `npm install` generates; no agent edits it]
```
No file is shared between agents. Documentation files are updated by the orchestrator after the four modules land (section I), not by implementation agents.

### G.1 index.html load order (agent 1)
```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="editors/docx-editor.css">
<link rel="stylesheet" href="editors/sheet-editor.css">
<link rel="stylesheet" href="editors/pdf-editor.css">
...
<script src="../node_modules/monaco-editor/min/vs/loader.js"></script>
<script src="editors/common.js"></script>
<script src="editors/docx-editor.js"></script>
<script src="editors/sheet-editor.js"></script>
<script src="editors/pdf-editor.js"></script>
<script src="app.js"></script>
```
Editor scripts are classic scripts that only call `CodePadEditors.register(...)` at load (no DOM work, no library loading) so a defect in one module cannot stop startup. The heavy libraries load lazily inside `create()` / `getBytes()`.

### G.2 Module rules (all editor agents)
- Wrap in an IIFE with `'use strict'`; the only global touched is `CodePadEditors`. Use `window.codepad` NEVER.
- CSS: every selector is prefixed `.cp-docx`, `.cp-sheet` or `.cp-pdf`; use only the theme variables from `styles.css` (`--bg --bg-side --bg-tab --bg-hover --fg --fg-dim --accent --border`) so dark/light follows `html[data-theme]` automatically. No inline `<style>` creation; element `style` properties are allowed (CSP has `style-src 'unsafe-inline'`).
- No `innerHTML` with untrusted data; no `eval`/`new Function`; no network; no `alert/confirm/prompt` (use in-view dialogs).
- Python-style standards from the global CLAUDE.md apply as JS equivalents: JSDoc on every public function, descriptive `Error` messages, no swallowed exceptions, no `console.log` leftovers (use `callbacks.onStatus` for user-facing messages; `console.error` only inside catch blocks that rethrow or report).
- The view must tolerate `layout()` being called while hidden (zero size) and must not assume focus.
- All library usage goes through one `loadLibs()` function per module so a swap (pdf.js 3.x fallback, pdf-lib 1.17.1) touches one place.

### G.3 Module-specific contracts

**docx (`CodePadEditors.register('docx', {extensions:['.docx'], create})`)** `readOnly:false`, `saveMode:'overwrite'`, `saveFilters:[{name:'Word Document',extensions:['docx']}]`, `defaultSaveName: base+'.docx'`.
- Libs: `mammoth.browser.min.js` on open, `docx/dist/index.iife.js` on first `getBytes`.
- Open: `mammoth.convertToHtml({arrayBuffer}, {styleMap:["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => h2:fresh"]})` -> sanitize -> editor. `bytes:null` + `restoredState.html` starts from the HTML. A dismissible banner at the top: "CodePad re-creates the document on save. Headers, footers, text boxes, comments, tracked changes, page layout, fonts and colours may be simplified or removed." plus a count of mammoth warnings.
- Toolbar: Undo, Redo, block style (Paragraph, Heading 1-6, Quote), Bold, Italic, Underline, Strikethrough, Bulleted list, Numbered list, Indent/Outdent (nested lists), Align left/center/right/justify (stored as `text-align`), Link (in-view URL form; http/https/mailto only; Ctrl+K), Image (hidden `<input type=file accept="image/png,image/jpeg,image/gif">` + FileReader -> data URI; <= 10 MB; no filesystem access granted), Table (insert rows x cols; context toolbar: add/remove row/column, delete table), Clear formatting. Shortcuts Ctrl+B/I/U/K, Ctrl+Z/Y via the browser. Status text: `"<N> words"`.
- Editing surface: a white page-like column (`.cp-docx-page`, max-width 816 px) with `contenteditable=true`, `spellcheck=true`; paste intercepted (sanitize `text/html`, else `text/plain` via `insertText`); drop of files into the surface is blocked; links are inert (`click` preventDefault).
- `getBytes('docx')`: walk the sanitized DOM -> `docx.Document` with: `Paragraph` + `HeadingLevel`, `TextRun {bold, italics, underline, strike, superScript/subScript}`, `ExternalHyperlink`, bullet/decimal numbering configs with levels from list nesting (max 8), `Table/TableRow/TableCell` (single-border grid, column widths from percentages, colspan/rowspan), `ImageRun` from data URIs with `type` png/jpg/gif and `transformation` from the displayed size (capped to page width 624 px), `alignment`. Packer: `new Uint8Array(await (await docx.Packer.toBlob(doc)).arrayBuffer())`. Default font Calibri 11pt, page Letter/A4 by `navigator.language` region (en-US/CA -> Letter else A4), 1-inch margins.
- Dirty: editor `input` events increment a version; `isDirty()` compares with the saved version; restored state => dirty.
- `getSessionState()` -> `{html}` when dirty and `html.length <= 14 MB`, else null + `sessionStateTooLarge=true`.

**sheet (`register('sheet', {extensions:['.xlsx','.xls','.ods','.csv','.tsv'], create})`)**
- `saveMode`: 'overwrite' for xlsx/csv/tsv, 'saveAs' for xls/ods; `saveFilters`: xlsx -> `[xlsx, csv]`; csv -> `[csv, xlsx]`; tsv -> `[tsv, xlsx]`; xls/ods -> `[xlsx]`.
- Lib: `xlsx.full.min.js`. Open: `XLSX.read(bytes, {type:'array', cellDates:true, cellFormula:true, cellNF:true, dense:true})` (dense mode arrays for speed). CSV/TSV: decode with `TextDecoder` (BOM aware, fallback windows-1252), `XLSX.read(text, {type:'string', raw:true, FS})`, with FS = `\t` for .tsv, otherwise the most frequent of `, ; \t` in the first non-empty line. Cap 2,000,000 cells.
- Model: the SheetJS dense worksheet objects stay the source of truth; the grid edits cells with `{t, v, f?, z?}`: text typed as a number/boolean becomes `n`/`b`, text beginning `=` becomes `f` (no formula engine: the cached value is blank until opened in Excel; `wb.Workbook.CalcPr.fullCalcOnLoad = true` is set so Excel/LibreOffice recompute), everything else `s`. Existing formulas display their cached value; the formula bar and in-cell editor show the formula text.
- UI: virtualized grid (22 px rows, default 100 px columns or `!cols` widths, column letter / row number headers, up to 1,048,576 rows x 16,384 columns), single and range selection (mouse, Shift+arrows), arrow/Tab/Enter navigation, F2 / double-click / typing to edit, Esc/Enter commit semantics like Excel, Delete clears, Ctrl+C/X/V as TSV through the clipboard events (range paste), fill-down (Ctrl+D), own undo/redo stack of cell patches (Ctrl+Z/Y), column resize by dragging, insert/delete row/column from a context menu (cells shift; merges and `!ref` adjusted), sort selection by column (asc/desc), Ctrl+F find in sheet, formula bar showing the active cell address and raw value, sheet tab strip at the bottom (switch, add, rename by double-click, delete with confirm, reorder not supported; CSV has no strip). Merged cells render merged (read from `!merges`, editable only via top-left cell). Number formats: displayed via `XLSX.SSF.format(cell.z, cell.v)` when present; dates edited as ISO text.
- `getBytes(ext)`: `xlsx` -> `XLSX.write(wb, {bookType:'xlsx', type:'array', compression:true, cellDates:true})`; `csv`/`tsv` -> `XLSX.utils.sheet_to_csv(ws, {FS, blankrows:true, strip:false})` of the active sheet (status warns if other sheets exist: "CSV holds one sheet; the active sheet was saved"), prepend BOM when the source had one, CRLF when the source used CRLF. Returns `Uint8Array`.
- `getSessionState()` as in D.1; null when serialized size > 14 MB.
- `getStatusText()`: `"<Sheet> · <A1>  ·  Sum: x  Count: n"` for numeric range selections.

**pdf (`register('pdf', {extensions:['.pdf'], create})`)** `readOnly` set per section F.1; `saveMode:'saveAs'`; `saveFilters:[{name:'PDF',extensions:['pdf']}]`; `defaultSaveName: base + ' (edited).pdf'`.
- Everything in section F. `getBytes('pdf')` throws `Error('This PDF is view-only.')` when `readOnly`. `markSaved()` replaces the base document bytes with the last output of `getBytes()` and clears the edit list/undo stack. `isDirty()` is true while the edit list is non-empty or differs from the last saved marker.
- `getSessionState()` -> `{edits, page, zoom}` when edits exist (always small), else null.
- `dispose()`: `pdfDocument.destroy()`, terminate the loading task, drop canvases.
- Keyboard: Ctrl+Z/Y, Delete, Esc, +/- zoom. Status text: `"Page 3 / 12 · 125%"`.

### G.4 Glue contract summary (agent 1 must provide exactly this to the modules)
- `window.CodePadEditors.register/get/util` (C.5) defined before any module script runs.
- Containers: `options.container` is an empty block element with `position:relative; overflow:hidden; width/height 100%` (class `view-host`); the module's root element should fill it (`.cp-<kind>{position:absolute; inset:0; display:flex; flex-direction:column}`).
- The glue calls `view.layout()` on every activation, window resize, sidebar toggle.
- The glue never reads module internals; it only calls the View methods listed in B.3.

---

## H. Risks, limitations to disclose, items only the user can verify

### H.1 Limitations to state in the README/UI
- DOCX: opened by conversion, re-created on save. Preserved: headings, paragraphs, bold/italic/underline/strike, lists (including nesting), tables (simple), images (inline), hyperlinks, basic alignment. Simplified or lost: headers/footers, footnotes/endnotes, comments, tracked changes, text boxes/shapes, columns, section/page setup, custom styles and fonts, text colours/highlight, line spacing, table cell shading/widths, equations, fields (TOC), embedded objects. Keep a backup of important documents; use Save As to keep the original.
- XLSX: values, formulas (as stored text; no recalculation in CodePad), merged cells, column widths, multiple sheets preserved. Lost: cell styling (fonts, fills, borders; number formats are kept where SheetJS reads them), charts, images, pivot tables, conditional formatting, data validation, macros (xlsm is not opened), defined names UI, frozen panes, comments. New/edited formulas show no result until the file is opened in Excel/LibreOffice. CSV: one sheet, UTF-8 (non-UTF-8 files are converted to UTF-8 on save).
- XLS/ODS: read; saving always asks for a new `.xlsx` (the original is untouched).
- PDF: see F.5 (whiteout is not redaction, fonts replaced by standard/Liberation fonts, signatures invalidated, no scanned-PDF editing, no OCR).
- Large files: docx/xlsx/csv 50 MB, pdf 100 MB; editing multi-million-cell sheets will be slow; the UI thread is used for parsing (no workers for SheetJS/mammoth).
- `document.execCommand` is deprecated; if Chromium ever removes it the docx editor needs a rewrite of its formatting commands (Electron 44 still ships it).
- Spell check is Chromium's built-in (offline, language packs depend on the OS).

### H.2 Technical risks
1. pdf.js 6.x as ESM + module Worker from `file://` in a `sandbox:true` renderer with CSP `worker-src 'self'` (fallback: pdf.js 3.11.174 UMD).
2. `fetch()` of `file://` assets (cmaps, standard fonts, wasm, Liberation TTF) from the renderer (fallback: XHR in `util.fetchBytes`, already specified).
3. Libraries containing `new Function`/`eval` strings (mammoth's underscore template, docx's bundled helper) under a CSP without `unsafe-eval`: expected to be unreachable on our paths.
4. SheetJS tarball dependency: reproducibility depends on `cdn.sheetjs.com` at install time (lockfile pins integrity; the CDN connection reset several times while verifying). If it is unreachable on CI, vendor the tarball in the repo (`vendor/xlsx-0.20.3.tgz`) and point the dependency to `file:`.
5. UI-thread jank on 50 MB files; memory duplication of bytes (renderer copy + main copy).
6. Session file growth (up to 64 MB) rewritten on each edit pause.
7. `@cantoo/pdf-lib` is a fork (the original is unmaintained); pinned and API-compatible fallback exists.
8. Colour/background sampling for PDF edits is heuristic (gradients/patterned backgrounds give a visible patch).
9. The Sejda UX document was unavailable: tool set and interactions are minimal and may need alignment.

### H.3 Verify by running the app (the user runs all validation)
- App starts, Monaco still works (CSP change: nothing regressed; DevTools console has no CSP violations when opening each type).
- Open a `.docx` with headings/lists/table/image: renders; edit; Ctrl+S; reopen in Word/LibreOffice; check the banner; Save As path; dirty dot, close prompt, session restore of an unsaved docx edit (quit with unsaved edits, relaunch).
- Open `.xlsx` (multi-sheet, formulas, merged cells), `.csv` (comma, semicolon, quoted newlines, BOM, CRLF), `.tsv`, `.xls`, `.ods`: edit, paste a range from Excel, undo/redo, save, reopen in Excel; xls/ods force Save As xlsx; confirm CSV round-trip is byte-faithful for untouched content.
- Open a text PDF: pages render with correct fonts (cmaps/standard fonts load), click-edit a run, add text, whiteout, Save As new file, original unchanged (timestamp/hash), the new file opens in a normal PDF reader; Cyrillic/Greek text embedding works; CJK edit is blocked with a clear message; a scanned PDF opens view-only; an encrypted PDF asks for a password; JPEG2000/JBIG2/ICC-heavy PDFs render (wasm path, `'wasm-unsafe-eval'` needed or not).
- Session restore with unsaved PDF edits; restore when the file was deleted; restore of dirty docx with a missing file.
- Packaged build (`dist:win` and others): total size, that all `node_modules` assets listed in `build.files` are present and the editors work from the installed (non-asar) app on each OS; fonts folder licensing files included.
- Drag-and-drop of each type from Explorer/Finder/Nautilus; Open dialog filters; opening a file whose extension is uppercase (`.DOCX`).
- Cross-platform shortcut behaviour (Cmd on macOS), clipboard paste between Excel and the grid.
- Security spot checks: a docx containing `<script>`-like text and a hyperlink with `javascript:`; a CSV containing `<img src=x onerror=...>` strings (must show as text); a PDF with JavaScript actions (must be inert).

---

## I. Documentation updates (done by the orchestrator after implementation)

- **`.claude/ARCHITECTURE.md`**: add `renderer/editors/` (common.js registry/util, docx-editor, sheet-editor, pdf-editor with their CSS files and one-line roles), the new IPC channels (`fs:readBinary`, `fs:writeBinary`, extended `dialog:saveAs`/`confirmClose`), `fileAccess.readBinaryFile/writeBinaryFile/writeAtomic`, the tab-kind model (`kind`, `view`, `#views`), the session `kind/state` fields and caps, the lazy library loading flow, and the updated "Flow" paragraph. Update the file tree comments for `fileAccess.js`, `sessionStore.js`, `preload.js`.
- **`.claude/SETUP.md`**: new dependencies and exact versions (including the SheetJS tarball install, network needed at `npm install` only), the fact that `npm install` generates `package-lock.json` with the tarball integrity, the `build.files` additions and the expected size increase, and the pdf.js ESM / Electron 44 requirement.
- **`.claude/CLAUDE.md`**: conventions: tab kinds and the View interface; "editor modules never call IPC"; binary I/O only through `readBinary/writeBinary` with extension tables and magic-byte checks; untrusted document HTML is sanitized with the allow-list before reaching the DOM; PDF is Save-As-only and original never overwritten; pins and why (`pdfjs-dist` 6.x ESM-only, downgrade path 3.11.174; `xlsx` must come from the SheetJS CDN tarball, never `npm install xlsx`); CSP deltas and their justification (`worker-src 'self'`, `'wasm-unsafe-eval'`); known simplifications (docx regenerate, SheetJS CE no styles, PDF whiteout is not redaction).
- **`.claude/docs/SECURITY_ASSESSMENT.md`**: add a short addendum for the CSP changes, the new IPC surface, and the document-parsing attack surface (docx/xlsx/pdf parsers and zip bombs).
- **`README.md`**: features (docx WYSIWYG, spreadsheet grid, PDF text editing and view-only mode), supported extensions, the limitations list from H.1, new dependencies/credits (Apache-2.0 / MIT / BSD-2 notices for pdf.js, pdf-lib, fontkit, mammoth, docx, SheetJS; Liberation fonts under SIL OFL 1.1), and the Save-As-only behaviour for PDFs. Consider a `THIRD_PARTY_NOTICES` mention if installers bundle the licence files (they do via `build.files`).
