# AI chat assistant (floating, draggable)

Goal: a floating chat icon (bottom-right, draggable, double-click toggles a draggable pop-up) where the user types
natural-language requests about files: rewrite/restructure/reformat the current file, create a file, extract key points
into a new file, rename, save, delete, read. It uses the same model as summaries (`pickTarget()` in `aiIpc.ts`), so
built-in Qwen3, a local GGUF or a remote provider all work, with the same consent / fallback flow.

## Decisions (defaults; the user did not answer the open questions)
- Scope: files in the opened Explorer folder and files already open as tabs. Main enforces it with `fileAccess`.
- Safety: the AI never writes by itself. Every change is a *proposal card* (before/after) with Apply / Discard.
  Edits are applied to the tab's Monaco model (one undo step) and saved only by the normal Save. Delete moves the file
  to the OS trash (`shell.trashItem`, recoverable) after a native Yes/No box shown by **main**. Rename and create never
  overwrite an existing file.
- Small-model reliability: the *intent* (create / rename / delete / save / open / edit / extract / chat) is found by
  deterministic rules in the renderer (`chatIntent.ts`, pure, no IPC); the AI is used only to write text. If no rule
  matches the request is a plain edit of the current file when it names a change, otherwise a normal chat answer.
- The window position of the icon is kept in memory only (no new setting).

## Contract

### Main -> new job kind `chat` (reuses `textJob`, `runOnTarget`, `runWithFallback`, `pickTarget`)
- `ai:chat:start` raw `{ instruction: string(1..2000), fileName?: string(<=120), fileText?: string(<=60000),
  history?: {role:'user'|'assistant', content: string(<=4000)}[] (<=8), output: 'answer'|'file' }`
  -> `{ok:true, jobId}` or `{ok:false, code, message}` (`busy`, `empty`, `tooLarge`, `invalid`).
- `ai:chat:cancel(jobId)`.
- Events on `ai:event`: `{type:'chat', jobId, phase:'loading'|'progress'|'done'|'error'|'consent'|'modelFailed'...}`
  exactly like rewrite events (reuse `JobEventFields`); `phase:'done'` carries `text` (the whole answer).
  `output:'file'` means the answer is the complete new file content and nothing else (no commentary, no code fence).
- Worker: one chat completion with a small system prompt (`aiPrompts.ts`), the file text inside a delimited block,
  `/no_think`, prefilled empty think block (same template as rewrite), `maxTokens` clamp 1..1024 locally. Inputs longer
  than the local context are cut to a head+tail excerpt with a note. Providers use `createSummaryCompleter`.
- Never logged: instruction, file text, answer.

### Main -> file operations (new `chatFiles.ts`, registered in `main.ts` with `handle()`)
- `files:create(filePath, content)` -> `{ok:true, path}`; path must resolve (fileAccess) inside the approved root, parent
  must exist, file must not exist, content <= 5 MB, written atomically; path is approved afterwards.
- `files:rename(filePath, newName)` -> `{ok:true, path}`; `newName` is a bare file name (no separators, no ADS,
  no reserved names, no trailing dot/space); same folder; target must not exist; the old path must be allowed.
- `files:trash(filePath)` -> `{ok:true}` | `{ok:false, cancelled:true}`; allowed regular file only (no directory, no
  root); main shows a native Yes/No message box (file name + folder) and then `shell.trashItem`.
- Return `{ok:false, code, message}` with user-presentable text for every failure (exists, outsideFolder, noFolder...).
- Reading and saving existing files keeps using `fs:read` / `fs:write` through tabs.

### Renderer
- `features/ai-chat.ts` + `ai-chat.css` (+ `chatIntent.ts` in `src/shared/` as a UMD/pure script if shared, otherwise
  inside the feature): FAB, popup, transcript, input (Enter sends, Shift+Enter newline), Stop button, proposal cards.
- Command `ai.chat` (AI menu, "AI Chat Assistant...") toggles the popup.
- Only `ctx` is used (tabs, files, ai, ui, status, events, commands). All text is inserted with `textContent`.
