# CodePad Architecture

Electron desktop editor built on Monaco (the VS Code editor engine). Cross-platform: Windows, macOS, Linux.

All application code is TypeScript (strict, no `any`) under `src/` and is compiled by `npm run build` (`scripts/build.mts`, run by Node directly with type stripping (Node 22.18+)) into `dist/`, which mirrors `src/`; `package.json` `main` is `dist/main.js`. HTML/CSS are copied unchanged and `assets/icon.png` goes to `dist/assets/`. Two projects: `tsconfig.main.json` (CommonJS, node types; main process, workers, preload, `shared/`, `providers/`) and `tsconfig.renderer.json` (classic scripts, DOM lib, `module: none`). Renderer files cannot import each other; their cross-file types are ambient declarations in `src/types/*.d.ts` (`renderer-globals.d.ts` for `CodePadCtx` and the window globals, `codepad-api.d.ts` for the `window.codepad` IPC API and `CpIpcChannels`, `shared-globals.d.ts`, `third-party-globals.d.ts`, plus per-area files). The paths below are relative to `src/` (e.g. `main.js` is `src/main.ts`, emitted as `dist/main.js`).

```text
CodePad/
├── package.json        # Scripts, dependencies, electron-builder packaging config (build.files lists every shipped file)
├── main.js             # Electron main process: window, sender-checked IPC, command-line args, navigation/permission lockdown, close flow; wires the modules below
├── fileAccess.js       # Main-side file layer: path allow-list (user-approved files/root), UNC/ADS/reserved-name/symlink checks, capped reads, atomic writes, stat, hash, folder listing that omits directory links/junctions, same-file check for tab dedupe
├── textCodec.js        # Encoding layer (iconv-lite): detect (BOM, UTF-16 NUL pattern, strict UTF-8, fallback), decode, encode, checkEncodable; also used by the search worker
├── sessionStore.js     # Session persistence: HMAC-signed userData/session.json and named sessions in userData/sessions/<id>.json; re-approves saved paths only when the signature is valid
├── settingsStore.js    # userData/settings.json: loads, validates against the shared schema, applies validated patches, notifies main to rebuild the menu
├── userStore.js        # Atomic JSON files in userData (mode 0o600, size caps): generic read/write, recent files list (signed), macros (step grammar validated)
├── integrity.js        # HMAC-SHA256 sign/verify with a random key in userData/store.key (wrapped by safeStorage when available)
├── menuBuilder.js      # Loads the static command tables, applies keybinding overrides, builds the native menu (checkbox settings, recent files submenu, roles)
├── findInFiles.js      # Find in Files driver: validates options, runs findInFilesWorker.js in a worker thread, watchdog, cancel
├── findInFilesWorker.js# Worker thread that walks the opened folder (never follows symlinks) and matches with shared/searchCore.js
├── fileWatcher.js      # Per-directory fs.watch manager for "changed on disk" (debounced, allow-listed, ref-counted)
├── preload.js          # contextBridge API (window.codepad, incl. window.codepad.ai) exposed to the sandboxed renderer
├── preloadInstall.js   # Preload of the model-install window only (progress in, cancel out)
├── aiIpc.js            # AI composition root: registers the ai:* channels, wires downloader, engine, summary cache; loaded defensively by main.js (stub handlers if missing)
├── modelDownloader.js  # Only network code: pinned model catalog (URLs, sizes, SHA-256), resumable download via Electron net, verification, userData/models, connectivity check
├── aiEngine.js         # Supervises the AI utility process (lazy start, idle unload, crash recovery, suggestion cache)
├── aiWorker.js         # Utility-process entry: node-llama-cpp (network kill-switch), suggestions and the summary pipeline
├── spellcheck.js       # Custom English spell checker (main): word list lookup, contraction/hyphen rules, Damerau-Levenshtein suggestions, personal words; no AI, no library
├── dictionaries/       # en.txt (SCOWL word list, most common first) + LICENSE-SCOWL.txt, copied to dist/ by the build
├── chat.js             # Chat assistant job: prompt/excerpt/answer cleaning for the active summary model (never logged)
├── chatFiles.js        # files:create / files:rename / files:trash inside the approved folder; native Yes/No before trashing
├── rewriter.js         # Pure grammar/restructure pipeline: chunking, strict prompts, output cleaning, content-preservation check with fallback to the original chunk
├── modelRegistry.js    # Signed userData/models.json: model entries, enable/active/consent, runtime(id) for main only
├── secretStore.js      # API keys encrypted with safeStorage in userData/secrets.json (write-only from the renderer, env-var fallback)
├── ggufHeader.js       # Bounded structural validation of a GGUF header before any native parsing
├── ollamaPull.js       # Pulls a GGUF blob from registry.ollama.ai (manifest digest = SHA-256, resumable, verified)
├── providers/          # Remote summary providers: http.js (https/host/redirect/size/retry rules), anthropic.js, openai.js (OpenAI-compatible), huggingface.js, index.js
├── aiPrompts.js        # Pure prompt builders, output cleaning and loop guard
├── docExtract.js       # Pure, non-AI document extraction: sections, facts (dates, numbers, links), chunking, number verification
├── summarizer.js       # Map/reduce summary pipeline with an injected complete() and number verification
├── summaryCache.js     # LRU cache of finished summaries in userData/summary-cache.json
├── NOTICE              # Shipped third-party notices (model, engine, dependencies)
├── build/
│   ├── installer.nsh           # NSIS hooks: internet probe before install, CodePad.exe --install-model, model removal on uninstall
│   ├── entitlements.mac.plist  # macOS hardened-runtime entitlements for the AI engine
│   └── linux/deb-preinst.sh    # .deb pre-install internet check
├── assets/
│   └── icon.png        # App icon (1024x1024); window icon and electron-builder source for .ico/.icns/Linux icons
├── scripts/
│   └── afterPack.js    # electron-builder hook: asserts the packaged AI engine files, flips Electron fuses (RunAsNode, NODE_OPTIONS, --inspect off)
├── shared/             # UMD files loaded by main (require) and by the renderer (script tag)
│   ├── settingsSchema.js   # Settings keys, types, ranges, defaults and the Monaco option each maps to; validate/sanitize
│   ├── suggestText.js      # Pure UMD (main + renderer): ghost-text context extraction (header, enclosing scope, paragraph, suffix) and deterministic sentence/statement-complete trimming
│   ├── chatIntent.js       # Pure UMD: deterministic intent parser of the AI chat (edit/create/extract/rename/delete/save/read/chat)
│   ├── searchCore.js       # Pure search/replace engine (extended mode, whole word, regex) shared by Find in Files and tab search
│   └── commands/           # Static command tables: id, title, menu path, order, accelerator, when. Main builds the menu from them
│       ├── core.commands.js    # File/Edit/View items of the shell, Window and Help roles
│       ├── search.commands.js  # Search menu: Find in Files, results, bookmarks, marks, go to offset
│       ├── text.commands.js    # Edit/Tools: line ops, sorts, case, blanks, date/time, column editor, converters, hashes, clipboard history
│       ├── view.commands.js    # View/Encoding: symbols, themes, zen, summary, outline, panels, encodings, settings
│       ├── tabs.commands.js    # Tabs, files (reload, monitor, recent), sessions, compare, macros
│       └── ai.commands.js      # AI menu: ghost text, word suggestions, summaries, export, model download/delete/status
├── renderer/
│   ├── index.html      # UI shell (sidebar + tab strip, tabs, editor, bottom panel, status bar), CSP, all script/stylesheet tags in load order
│   ├── styles.css      # Theme variables and shell layout (sidebar, tabs, panels, status bar)
│   ├── app.js          # Monaco setup, tabs (text/document/diff kinds), file tree, open/save/reload, session snapshot/restore, status bar, settings applier, core commands, builds ctx and starts the features
│   ├── core/           # Infrastructure for the feature modules (owned with app.js)
│   │   ├── bus.js          # window.CodePadBus: event bus (ctx.events)
│   │   ├── commands.js     # window.CodePadCommands: register/execute/list/onExecute; adds every command to Monaco's palette
│   │   ├── settings.js     # window.CodePadSettings: synchronous cache over the main-owned settings store
│   │   ├── themes.js       # window.CodePadThemes: theme registry (dark/light built in; others defined in Monaco as cp-<id>)
│   │   ├── ui.js           # window.CodePadUI: modal, prompt, confirm, pick, contextMenu, output
│   │   ├── panels.js       # window.CodePadPanels: left sidebar tab strip + bottom panel host, resizers, badges
│   │   ├── features.js     # window.CodePadFeatures: register/initAll for the feature modules
│   │   └── core.css        # Styles for modals, pick lists, context menus, buttons
│   ├── editors/
│   │   ├── common.js        # window.CodePadEditors: registry (register/get) + util (lazy script/module loading, bytes, base64)
│   │   ├── docx-editor.js/.css   # Rich-text .docx editor
│   │   ├── sheet-editor.js/.css  # Spreadsheet grid for .xlsx/.xls/.ods/.csv/.tsv
│   │   └── pdf-editor.js/.css    # PDF viewer + text-layer editor
│   ├── install/        # model-install.html/.js/.css: progress window of --install-model (own preload and CSP)
│   └── features/       # Self-contained feature modules; they use only ctx, events and commands
│       ├── search.js, search-results.js, bookmarks.js, search.css     # Find panel, Find in Files, results panel, bookmarks and marks
│       ├── text-tools.js, column-editor.js, clipboard-history.js, converters.js, hashes.js, text-tools.css   # Text tools, converters, hashes, output panel
│       ├── view.js, encoding.js, themes.js, outline.js, settings-panel.js, view.css, themes.css   # View toggles, encoding/EOL pickers, extra themes, outline, settings dialog
│       ├── tabs.js, files.js, sessions.js, compare.js, macros.js, tabs.css, compare.css   # Tab menu/pins/colors, reload/watch/autosave/recent, named sessions, diff view, macros
│       └── ai-model.js, ai-models.js (Manage Models dialog), ai-rewrite.js (Check Grammar / Rewrite with diff preview and Apply), ai-chat.js + ai-chat.css (floating draggable chat icon and pop-up, AI job plumbing, dispatch), ai-chat-tools.js (the chat tool registry `CodePadChatTools`: edit-file, create-file, extract-to-file, answer, append-content, find-replace, remove-tags, transform-content, write-content, summarize-content, cancel-summary, clear-summary-cache, rename-file, delete-file, save-file, read-file, duplicate-file, list-files, open-file, close-file), spellcheck.js (squiggles and quick fixes), autosuggest.js, ai-suggest.js, ai-summary.js, ai.css   # AI status/download/gate, word dropdown, ghost text, summaries (load in this order)
├── vendor/
│   ├── xlsx-0.20.3.tgz # Official SheetJS CE release, installed as a file: dependency
│   └── nlc-stub/       # Empty package that npm overrides substitute for unused node-llama-cpp GPU/arch packages
├── .github/workflows/build.yml  # CI: builds Windows/macOS/Linux installers
├── SHARE.md            # How to build, distribute and install CodePad per OS
└── .claude/            # Project docs for Claude (CLAUDE.md, ARCHITECTURE.md, SETUP.md, .claudeignore, plans/, research/, docs/)
```

## Local AI

```text
Renderer (ctx.ai)  --ai:* IPC-->  main: aiIpc.js --> modelDownloader.js (net, fs, SHA-256)
   <-- ai:event ----                              --> aiEngine.js --spawn--> utilityProcess aiWorker.js
                                                  --> summaryCache.js         node-llama-cpp, summarizer.js, no network
```

All model downloading is in main (`modelDownloader.js`); the worker has a network kill-switch and the renderer has no network. `main.js --install-model [--silent]` runs only the downloader (optional progress window `renderer/install/`, `preloadInstall.js`, channels `install:progress`/`install:cancel`) and exits with a code for the installer. The settings `ai.*` and `editor.autoSuggest` are in the shared schema; main gives aiIpc a settings view where `ai.autoDownload` is false until `ai.setupPrompted` is true (first-launch gate answered).

## Tab kinds

`text` (Monaco model), document kinds `docx`/`sheet`/`pdf` (chosen by extension) and `diff` (compare view, no file, never saved or put in a session). A non-text tab owns a view created by its module (`create({container, bytes | params, ...})`). Every tab has `persist` (pinned, color, readOnly, bookmarks, monitor; not on `diff`) and `diskStat` (mtime/size of the last read or write, used by file watching).

## Commands and menu

Command tables in `shared/commands/*.commands.js` -> `menuBuilder.js` (main) builds the native menu and applies `keybindings` overrides -> a click sends `command {id}` -> `app.js` calls `CodePadCommands.execute(id)` -> the `run(ctx)` registered by `app.js` or a feature module. `commands:table` returns the table with effective accelerators for the palette and shortcut mapper. The menu is rebuilt when settings or the recent-files list change.

## Feature context

`app.js` builds the frozen `ctx` (tabs, text helpers, files, settings, status (set, addItem), clipboard, ui, panels, commands, themes, events, session, app, ai, libs; tabs also has contributeMenu/exportBytes) and calls every feature's `init(ctx)` once after Monaco exists. Events (`tab:*`, `session:*`, `settings:changed`, `theme:changed`, `folder:changed`, `file:changedOnDisk`, `editor:created`, `layout:changed`) flow through `CodePadBus`. Panels (explorer, search, documents on the left; results, outline, clipboard, output at the bottom) are registered with `CodePadPanels`; visibility, active panel and sizes live in `ui.*` settings.

## IPC overview

File access only via `handle()`-guarded IPC in `main.js` (sender check), delegating to `fileAccess.js`: `fs:read/write/readBinary/writeBinary/readDir/stat/isSameFile/hash`, `shell:reveal`, `dialog:*`, `encoding:list/check`, `settings:get/set`, `commands:table`, `recent:*`, `macros:*`, `session:*`, `sessions:*`, `search:start/cancel`, `watch:add/remove`, `window:*`, `app:info`, `ai:*` (registered by aiIpc.js: getStatus, model:download/pause/resume/cancel/delete/checkConnection, suggest, suggest:cancel, summarize, summarize:cancel, summaryCache:clear). Events to the renderer: `command`, `open-paths`, `search:event`, `watch:event`, `ai:event`, `request-close`. The renderer calls `ready()` after session restore so command-line files open last.

## Data in userData

`settings.json`, `recent.json` (signed), `macros.json`, `session.json` (signed), `sessions/<id>.json` (signed), `store.key` (HMAC key), `summary-cache.json` (summary text only), `models.json` (signed model list), `secrets.json` (encrypted API keys), `models/` (AI model, `model.json`, `.part`, `download.lock`). Delete a file to reset it.

## Flow notes

Window close is intercepted: main sends `request-close`, the renderer saves the session snapshot (`session:save`) and calls `approveClose`; it only falls back to per-tab "Save changes?" prompts if the snapshot cannot be written. On startup the renderer loads settings, builds Monaco and ctx, initializes the features, then calls `session:load` and rebuilds the tabs. `renderer/app.js` also holds the content-based language sniffer (`CONTENT_RULES`).
