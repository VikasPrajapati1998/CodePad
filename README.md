# CodePad

A fast, lightweight code and text editor for all kinds of files, powered by the Monaco editor. Runs on Windows, macOS and Linux.

## Features

- Tabs, file/folder open, folder tree sidebar, drag-and-drop
- Syntax highlighting for 80+ languages with auto-detection (by file name, or by content for untitled/unknown files) and manual override
- Find/replace, multi-cursor, minimap, bracket colorization, go to line
- Command palette (`Ctrl/Cmd+Shift+P`) listing every command with its shortcut
- Find in Files (folder search with include/exclude filters, regex, extended mode), Search Results panel, find in open tabs, replace in open tabs, bookmarks and five mark styles
- Text tools: line operations, sorts, case conversion, blank trimming, tab/space conversion, date/time insertion, column editor, clipboard history, read-only toggle, JSON/XML pretty/minify/validate, Base64/URL/hex conversion, MD5/SHA hashes
- Encoding picker (Unicode, Western/Central European, Cyrillic, Greek/Turkish/Hebrew/Arabic/Baltic, Chinese, Japanese, Korean, Thai/Vietnamese, DOS), reopen/convert with a lossy-save warning, LF/CRLF/CR line endings
- View: show whitespace/EOL/control characters, indent guides, extra themes (Monokai, Solarized, Zenburn, Obsidian, High Contrast), distraction-free and always-on-top, summary, code outline, settings dialog with shortcut mapper
- Tabs: pin, colors, drag to reorder, tab context menu, close variants, reopen closed tab, document list, recent files, reload from disk, changed-on-disk detection, tail -f monitoring, auto-save, compare two files or a file with disk/clipboard
- Macros (record, play back, run N times, save by name) and named sessions
- Dark and light themes, word wrap
- Open and edit more than text: `.docx` in a rich-text editor, `.xlsx`/`.xls`/`.ods`/`.csv`/`.tsv` in a spreadsheet grid, `.pdf` with in-place text editing (scanned/image-only PDFs open view-only; PDFs are always saved as a new file)
- Local AI (runs on your computer): grey "ghost text" suggestions while you type and one-click summaries of text, Word, Excel/CSV and PDF documents (see AI features below)
- Word suggestions while typing (words from all open tabs plus code snippets), always available with `Ctrl+Space`
- Session restore: open tabs, unsaved edits and the opened folder come back after you close and reopen the app
- Unsaved-changes protection when closing a single tab

## AI features

- **Ghost text:** a grey suggestion appears after you pause typing. Accept it with `Tab`, `Ctrl/Cmd+Right` (one word) or `Right Arrow` at the end of a line (press `Esc` first to move normally); `Esc` dismisses it. AI > Suggest Now asks for one immediately.
- **Summaries:** `Ctrl/Cmd+Shift+J` (AI > Summarize Current File, or the tab menu) writes an overview, key points and a "Key facts" list into a new Markdown tab. Dates, numbers, e-mails and links in Key facts are copied from the document, and statements whose numbers are not in the source are removed. Save it like any other file with Save As.
- **Switches:** AI > AI Suggestions (Ghost Text) turns the AI suggestions on or off; AI > Word Suggestions While Typing controls the normal dropdown. More options are under Settings > AI.
- **First run:** the AI uses a small model (Qwen3-0.6B, 523 MB) that is downloaded once, by the Windows installer or on first launch (macOS, Linux, portable). The editor works fully without it; an offline start just shows "AI: not installed". The download resumes after interruptions.
- **Choose the summary model:** AI > Manage Models... lets you add other models for summaries: a local `.gguf` file, a model pulled from the Ollama registry by name (for example `llama3.1:8b`, no Ollama install needed), the free Hugging Face hosted API, Claude (Anthropic), or any OpenAI-compatible API (GPT, Groq, OpenRouter, a custom URL). Pick one with "Use for summaries", disable it, or return to the built-in Qwen3 any time. Suggestions always use the built-in model. API keys are stored encrypted and can never be shown again. Cloud models send the text you summarize to that provider; CodePad asks once per model before the first use, and if a model fails it asks whether to use the default model instead.
- **AI chat assistant:** a round icon at the bottom-right (drag it anywhere, double-click to open or close; also AI > AI Chat Assistant...) takes plain requests: rewrite, restructure or reformat the current file, create a file, extract key points into a new file, rename, duplicate, save, read, open, close, list or delete files, append text, or find and replace. Each operation is a separate tool in the chat. It uses the same model as summaries. Nothing changes until you click Apply on the proposal card; edits are one undo step, new files and renames never overwrite, and delete moves the file to the trash after a Yes/No question. Files are limited to the opened folder and open tabs.
- **Better writing:** suggestions use the whole surrounding context and end on a complete sentence or statement. Spelling mistakes in plain-text and Markdown files are underlined (offline dictionary, no AI) with quick fixes. AI > Check Grammar and Spelling with AI... and AI > Rewrite / Restructure with AI... send the file or selection to the model chosen in Manage Models, show a before/after diff and change nothing until you click Apply. The built-in model is small; long texts give much better results with an added Claude or GPT model.
- **Privacy:** By default CodePad's AI runs entirely on your computer (summaries only leave it if you add and select a cloud model, see above). The only other network use is the one-time download of the AI model file from registry.ollama.ai (or Hugging Face as a backup) when you install CodePad or first use AI; the file is checked against a fixed SHA-256 fingerprint. Nothing you type or open is ever sent anywhere. No usage data is collected. Summaries are cached locally (summary text only) and can be cleared (AI > Clear Summary Cache) or turned off (Settings > AI > Cache summaries).

## Run / Install

```text
npm install
npm start
```

Build an installer with `npm run dist:win`, `dist:mac` or `dist:linux`. Results are in `installers/Windows`, `installers/MacOS` and `installers/Linux`; share those files with others (see SHARE.md). Installers must be built on their target OS (macOS builds on a Mac). Unsigned builds may show an OS security warning on first launch.

## Shortcuts

| Action | Shortcut |
|---|---|
| New / Open / Open folder | `Ctrl+N` / `Ctrl+O` / `Ctrl+Shift+O` |
| Save / Save As / Save All | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+Alt+S` |
| Close tab / Close all / Reopen closed tab | `Ctrl+W` / `Ctrl+Shift+W` / `Ctrl+Shift+T` |
| Command palette | `Ctrl+Shift+P` |
| Find / Replace / Go to line | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Find in Files | `Ctrl+Shift+F` |
| Toggle search results / next / previous result | `F7` / `F4` / `Shift+F4` |
| Toggle bookmark / next / previous | `Alt+F2` / `Alt+F3` / `Alt+Shift+F3` |
| Mark selection (style 1) | `Ctrl+Shift+M` |
| Insert date/time (short / long) | `F5` / `Shift+F5` |
| UPPER CASE | `Ctrl+Shift+U` |
| Column editor | `Alt+Shift+C` |
| Clipboard history | `Ctrl+Shift+H` |
| Record / stop macro, play back | `Ctrl+Shift+R`, `F9` |
| Go to tab 1..8 / last tab | `Ctrl+1`..`Ctrl+8` / `Ctrl+9` |
| Move tab left / right | `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Explorer / Documents / Outline | `Ctrl+Shift+E` / `Ctrl+Shift+D` / `Ctrl+Shift+Y` |
| Toggle bottom panel | `Ctrl+J` |
| Distraction-free mode | `Ctrl+Shift+F11` |
| Settings | `Ctrl+,` |
| Toggle sidebar / word wrap | `Ctrl+B` / `Alt+Z` |

(`Cmd` replaces `Ctrl` on macOS.) Every menu shortcut can be changed in Settings > Shortcuts; Monaco's own editor shortcuts (Ctrl+D, Ctrl+K chords, F2, F12) cannot.

## Command line

`CodePad --install-model [--silent]` only downloads the AI model and exits (used by the Windows installer; exit codes 0 ready, 2 cancelled, 3 offline, 4 integrity, 5 disk space, 6 locked, 1 other).

`CodePad [files...] [-n<line>] [-nosession]`: open the files (also in a running instance), jump to a line in the first one, or start without restoring the previous session.

## Known limits

- Macros record typing, editing keys and CodePad commands; Find/Replace widget actions and mouse actions are not recorded.
- The outline is exact for JavaScript/TypeScript and heuristic (regex) for other languages.
- The folder tree hides symlinks/junctions that point to folders, and a file opened under another spelling or link (different case, `.` segments, symlink) reuses its existing tab.
- Find in Files skips symlinks/junctions, binary files and files over 5 MB (configurable); there is no Replace in Files and no split view yet.
- Encoding detection is automatic for BOM, UTF-16 and UTF-8; other encodings (Shift-JIS, GBK, Windows-1251, ...) are chosen with Reopen with Encoding. Files without a BOM that are not valid UTF-8 open as Windows-1252.
- Saving replaces the file atomically (temp file + rename), so hard links to the file are not kept.

## AI limits

- The model is very small. Code suggestions are often plausible but wrong; it is better at finishing prose and common boilerplate. Summaries of long or technical documents can miss the point or merge sections.
- Expect about 0.5-1.5 s for a suggestion on an ordinary CPU, and 1-2 minutes for a 20-page summary. Apple Silicon is several times faster.
- Memory: about 0.75 GB while suggesting and about 1.3 GB while summarizing; the model unloads after 10 idle minutes (configurable).
- The one-time download needs about 600 MB of free disk (a 640 MB backup file is used if the main source fails). Ollama's registry and Hugging Face are third-party hosts that could move or remove files.
- Scanned (image-only) PDFs have no text to summarize. The summary cache holds summary text, which can contain facts from your documents.

## Document editing limits

- **.docx** is regenerated on save: headers/footers, footnotes, comments, tracked changes, text boxes, page setup and custom styles are not preserved.
- **.xlsx/.csv**: cell styling, charts, images and macros are not written; formulas are kept but not recalculated (Excel/LibreOffice recompute them on open). `.xls`/`.ods` are saved as `.xlsx`.
- **.pdf**: Save As only, the original is never changed. Whiteout hides text but is not redaction. Signatures become invalid on save, and scanned/image-only pages cannot be edited.
