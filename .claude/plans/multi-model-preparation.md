# Preparation plan: selectable AI models (v1.4 draft)

Status: PREPARATION ONLY. Open points (section 8) must be answered before implementation starts.

## 1. Requirements (from the user)

1. Qwen3-0.6B stays the built-in default.
2. Users can add cloud models with API keys/credentials: Anthropic (Sonnet, Haiku, Opus), OpenAI GPT, Groq, others.
3. Users can use local models from other vendors, e.g. after `ollama pull llama3.1:8b` the model becomes selectable.
4. Users can enable/disable each model and switch back to the default at any time.
5. The selected model drives BOTH ghost-text suggestions and summaries.
6. Secrets (API keys) are stored encrypted.

## 2. What exists today (constraints)

- `aiEngine.js` = supervisor of one utility process (`aiWorker.js`, node-llama-cpp). `aiIpc.js` calls `engine.suggest(req, signal)` and `engine.summarize(job, {signal,onProgress})`; the summary pipeline (`summarizer.js`, `docExtract.js`, `aiPrompts.js`) runs INSIDE the worker with a `complete()` injected from node-llama-cpp.
- Project rule: "Network only in `modelDownloader.js`; worker has a kill-switch; CSP unchanged; renderer never names URLs/paths". Cloud providers break the first rule by design, so it must be amended deliberately (section 5).
- `integrity.js` already wraps a key with Electron `safeStorage` (fallback: plaintext key file when unavailable) - reusable pattern.
- Settings are schema-validated in main (`shared/settingsSchema.js`, `settingsStore.js`); settings.json is plain text, so no secrets there.

## 3. Proposed architecture

Introduce a provider abstraction in main with one interface and several adapters:

```text
aiIpc.js  --> modelRegistry.js (list, enable/disable, active id, secrets)
          --> providers/index.js  getProvider(entry) ->
                local.js      (wraps today's aiEngine: Qwen3 and any user GGUF later)
                ollama.js     (HTTP to localhost:11434 /api/tags, /api/chat)
                anthropic.js  (HTTPS Messages API)
                openai.js     (HTTPS chat/completions; also Groq, OpenRouter, LM Studio, custom base URL)
```

Provider interface (all adapters): `complete({system, prompt, maxTokens, stop, signal}) -> {text, stopReason}`, `testConnection()`, `listModels()` (where supported), `dispose()`.

Key design decision: move the summary map/reduce loop from the worker to main (or make `summarizer.js` run in main with an injected `complete()` that delegates to the active provider). `summarizer.js` and `docExtract.js` are already pure, so only the call site changes. The local provider keeps a thin `complete()` that posts to the worker. Suggestions go through the same `complete()`.

Prompting differences: Qwen3-0.6B prompts are completion-style (ghost text). Chat APIs need a system+user chat prompt. `aiPrompts.js` gets a chat variant for suggestions ("continue this text/code, output only the continuation"), reusing `cleanSuggestion` for post-processing.

## 4. Data model

`userData/models.json` (non-secret, schema-validated in main, mode 0600):

```text
{ activeId: "builtin-qwen3",
  models: [ { id, kind: "local-gguf"|"ollama"|"anthropic"|"openai-compatible",
              label, modelName, baseUrl?, enabled, addedAt } ] }
```

- The built-in entry is fixed, cannot be deleted, is the fallback whenever the active model is disabled or fails.
- Secrets in `userData/secrets.json`: `{ [modelId]: base64(safeStorage.encryptString(key)) }`. Renderer can only write a key (`ai:models:setKey`) and later sees only `hasKey` + last 4 characters; it can never read a key back. If `safeStorage.isEncryptionAvailable()` is false (some Linux setups), refuse to store keys and offer the environment-variable alternative instead of falling back to plaintext.
- `models.json` is HMAC-signed through `integrity.js` so a tampered base URL cannot redirect a stored key elsewhere.

## 5. Security changes (needs explicit approval)

- New network code lives only in `providers/*.js` in main, using Electron `net`/`fetch` with: https required for cloud (http allowed only for loopback/Ollama), host check per provider (fixed hosts for Anthropic/OpenAI/Groq; custom base URL only for the "OpenAI-compatible" kind and shown to the user), no redirects to other hosts, timeouts, response size caps, keys sent only in the Authorization header.
- Renderer never receives keys, never names URLs: it sends a model id and the add/edit form values once (validated in main: URL parse, length caps, id charset).
- Privacy: selecting a cloud model sends document text to a third party. Need an explicit one-time consent dialog per cloud model, a persistent status-bar badge ("Cloud: Claude Sonnet") and a README/SECURITY_ASSESSMENT update. Suggestions would send the text before the cursor on every pause.
- Update `.claude/CLAUDE.md` "Network only in modelDownloader.js" rule to "network only in modelDownloader.js and providers/*.js".
- CSP stays unchanged (all calls are from main).
- Prompt-injection note: summarised documents are untrusted; model output is only inserted as text (existing behaviour), no tool use.

## 6. UI

- New "AI Models" dialog (extends `ai-model.js` + `ai.css`, new menu command in `ai.commands.js`): list with badges (Default, Local, Cloud), enable toggle, "Use this model" radio, Add Model wizard (provider type -> fields -> Test connection -> Save), Delete, "Use default model" button.
- Ollama flow: "Detect Ollama" button calls `/api/tags`, shows pulled models as checkboxes; message "run `ollama pull <name>` then Refresh".
- Status bar item shows the active model; failure of a non-default model shows an error with a one-click "Switch to default".
- Settings schema: add `ai.activeModel` is NOT a setting (lives in models.json); only behavioural keys (e.g. `ai.cloudSuggestions`) if we want a toggle.

## 7. Work breakdown (after approval; subagents per CLAUDE.md 1.6)

| Unit | Files | Notes |
|---|---|---|
| A. Registry + secrets | modelRegistry.js, secretStore.js | signed models.json, safeStorage, validation |
| B. Provider adapters | providers/{index,local,ollama,anthropic,openai}.js | pure Node, unit-testable with a mock HTTP server |
| C. Move summary loop to main | summarizer wiring in aiIpc/aiEngine, aiWorker.js slimmed | keep behaviour identical for the default model |
| D. Chat prompts for suggestions | aiPrompts.js | plus per-provider token limits |
| E. IPC + preload | aiIpc.js, preload.js, ctx in renderer/app.js | new `ai:models:*` channels |
| F. UI | ai-model.js, ai.css, ai.commands.js, consent dialog | |
| G. Docs | CLAUDE.md, ARCHITECTURE.md, README, SECURITY_ASSESSMENT.md, SETUP.md | |

Verification is run by the user (CLAUDE.md section 10); adapters can be checked with the user starting a local mock or a real key.

## 7b. Decisions made (user, latest message)

- Suggestions/ghost text ALWAYS use the built-in local Qwen3-0.6B plus the existing non-AI logic (word dropdown). They never use cloud or other models, so no document text leaves the machine while typing. This resolves open points 1 and 6 and removes requirement 5's suggestion half.
- Summaries use the selected added model (cloud API, or Ollama if added). If none is added/enabled, summaries use the built-in Qwen3 as today.
- Consequence: the engine process and the pipeline for the default model stay untouched; only summaries gain a provider hook, and `aiPrompts.js` needs only a chat-style summary prompt (no chat suggestion prompt). Unit D shrinks, unit C becomes "route summaries to the active provider".

- No Ollama adapter. Other local models also run through node-llama-cpp, i.e. as GGUF model files (see questions on how a user adds one). Providers are: built-in local (GGUF), Anthropic, OpenAI-compatible.
- Failure of a user-added model: pop-up "Your model failed. Use the default model?" with Yes/No (Yes = run this summary with built-in Qwen3 and keep the added model enabled; No = stop).
- Secrets: encrypted with safeStorage; never readable again by anyone, including the same user (only "key set" + last 4 chars); no plaintext fallback; without safeStorage keys cannot be saved, environment variables are offered. Everything else in models.json is signed.
- Custom model entry (any name/base URL/model id) is always possible in the Add dialog.

## 7c. FINAL decisions and build contract (supersedes anything above that conflicts)

Model kinds (`entry.kind`): `builtin` (Qwen3, fixed, undeletable), `gguf-file` (A: file chosen with a native open dialog in main; the renderer never types or sends a path), `ollama-registry` (B: GGUF blob pulled from registry.ollama.ai by name:tag, e.g. `llama3.1:8b`; manifest digest is the SHA-256 and is verified; never Hugging Face), `huggingface` (C: Hugging Face public/free hosted inference API, OpenAI-compatible router, optional token, fixed host), `anthropic`, `openai-compatible` (GPT, Groq, OpenRouter, custom base URL). Local kinds run through node-llama-cpp in their own utility process (a second `createEngine` instance used for summaries only). No Ollama daemon is used.
Suggestions always use the builtin engine. Summaries use the active model, else builtin.
Consent: once per remote model (anthropic, openai-compatible, huggingface); stored in models.json (signed). Local kinds need none.
Failure of the active non-builtin model during a summary: main emits `{type:'summary', phase:'modelFailed', ...}`; renderer shows Yes/No pop-up "Your model failed. Use the default model?"; Yes calls `ai:summarize:retryDefault`, No ends the job.
Chunking: automatic. `entry.contextTokens` (default per kind, editable) decides: if the extracted text fits (with safety margin) send one call, else map/reduce chunking sized to the context. builtin always chunks.
Secrets: `secretStore.js`, safeStorage only, no plaintext fallback; `set(id,key)`, `has(id)`, `hint(id)` (last 4), `get(id)` main-only; renderer can never read a key back. Without safeStorage, remote kinds refuse to save and the dialog explains the env-var option (`CODEPAD_<ID>_API_KEY` is read by main only).

Module ownership (no file edited by two agents):
- Agent A (data layer): `modelRegistry.js`, `secretStore.js`, `ollamaPull.js` (manifest + resumable verified blob download; reuse the downloader's host allow-list/hash helpers from modelDownloader.js, extending it only if unavoidable).
- Agent B (runtime): `providers/{index,anthropic,openai,huggingface}.js`, `aiIpc.js`, `aiEngine.js`/`aiWorker.js` (only if needed), `summarizer.js`/`aiPrompts.js` (chat prompt + single-pass), `preload.js`, `shared/settingsSchema.js` only if needed.
- Agent C (UI): `renderer/features/ai-models.js` (new), `ai.css`, `shared/commands/ai.commands.js`, `renderer/index.html` script tag, ctx exposure in `renderer/app.js`.

Registry API (A -> B): `createModelRegistry({userDataDir, secretStore, integrity, log})` returns `list()` -> `[{id,kind,label,modelName,baseUrl,enabled,builtin,active,hasKey,keyHint,consent,contextTokens,state}]` (no secrets), `add(spec)`, `update(id,patch)`, `remove(id)`, `setEnabled(id,bool)`, `setActive(id)` (null = builtin), `getActive()`, `giveConsent(id)`, `runtime(id)` (main-only: entry + key), `onChange(cb)`.
IPC (B -> C), all via `handle()`: `ai:models:list`, `ai:models:add` (spec; for gguf-file main opens the dialog), `ai:models:update`, `ai:models:remove`, `ai:models:setEnabled`, `ai:models:setActive`, `ai:models:setKey`, `ai:models:test`, `ai:models:consent`, `ai:models:pull` / `ai:models:pull:cancel` (ollama-registry), `ai:summarize:retryDefault`. Events on `ai:event`: `{type:'models', models}`, `{type:'pull', id, progress}`, summary `phase:'consentRequired'|'modelFailed'`.

## 8. Open points to discuss (all now answered, see 7c)

1. **Suggestions on cloud models**: they fire on every typing pause (cost, latency, privacy). Options: (a) allowed with a larger default delay (e.g. 800 ms) and a clear cost warning; (b) summaries on cloud, suggestions stay on a local model by default with an opt-in. The requirement says both use the chosen model; which default do you want?
2. **Secrets without safeStorage** (some Linux): refuse and require environment variables (recommended), or allow a user-entered passphrase-encrypted store?
3. **Provider list for v1.4**: Anthropic, OpenAI-compatible (covers GPT, Groq, OpenRouter, LM Studio, custom URL), Ollama - enough, or also Google Gemini / Azure OpenAI / AWS Bedrock (each needs its own adapter)?
4. **Local GGUF import** (vendor-neutral, no Ollama): add "Add a .gguf file" using the existing node-llama-cpp engine? Needs path approval via the file dialog and chat-template handling. Include now or later?
5. **Model catalog**: ship a small known-model list per provider (e.g. claude-sonnet/haiku/opus ids) or let the user type the model id freely? Free text is future-proof; a list is friendlier. Suggest: dropdown of known ids plus "custom".
6. **Per-feature selection**: one active model for everything (as written) or later allow a separate model for suggestions vs summaries?
7. **Large documents on cloud models**: keep the current map/reduce chunking for all models (consistent, cheaper per call) or let big-context models take the whole text in one call?
8. **Fallback behaviour**: on cloud/Ollama failure auto-fall back to the built-in model, or only show an error?
9. **Consent**: one-time per model (recommended) vs every session.
10. **Installer/model size**: unchanged (default model still downloaded at install). Agree?

## 9. Risks

- Moving the summary loop out of the worker touches working code; mitigate by keeping the worker path for the local provider and verifying the default flow first.
- Cloud API changes and rate limits (429): needs retry/backoff and clear errors.
- Output quality differs per model; the number-verification step stays on for all models.
- Cost is the user's; show token estimates before large cloud summaries.
