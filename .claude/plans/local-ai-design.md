# Design: Local AI for CodePad v1.3 (ghost-text suggestions + document summaries)

Status: DESIGN ONLY, nothing implemented. Builds on `notepad-features-design.md` (command tables, `ctx`, features, panels, settings, `handle()` IPC) and `binary-formats-design.md` (document kinds, view interface). Facts below were checked on 2026-10-27 against the current tree, Monaco 0.52.2 in `node_modules`, npm metadata, the packed tarballs and live HEAD/Range requests (section A.4).

Decisions taken here (all later sections follow from them):

1. **Engine:** `node-llama-cpp` **3.22.1** (exact), CPU-only prebuilt packages on Windows/Linux, Metal prebuilt on Apple Silicon, running in **one Electron `utilityProcess`** (`aiWorker.js`). Never builds or downloads anything at runtime.
2. **Model:** Qwen3-0.6B **Q4_K_M** from the Ollama registry blob (522,640,096 bytes, SHA-256 `7f40...e1fa`) into `userData/models/`. Fallback mirror: the official Hugging Face `Qwen/Qwen3-0.6B-GGUF` repo, which only publishes **Q8_0** (639,446,688 bytes, its own pinned SHA-256). The download runs in the **main process** with Electron `net` (system proxy), one implementation for the in-app downloader and the Windows installer (`CodePad.exe --install-model`).
3. **Suggestions:** raw prefix continuation (no chat template, no FIM), single line by default, KV reuse through a stable prompt window. The non-AI dropdown is a separate CodePad completion provider (words of all open tabs + snippets).
4. **Summaries:** a deterministic extraction step (no AI) builds sections and facts; map/reduce with a chat prompt that has thinking turned off; every number in model output is checked against the source; a "Key facts" list is copied straight from the extraction. The pipeline runs **inside the AI utility process**, so the 2 MB of regex work and the prompt building never block the main process.
5. **Ownership:** four agents with disjoint files (section G). `aiIpc.js` is the composition root on the main side. The renderer reaches AI only through `ctx.ai` (and three small new `ctx` helpers).

---

## A. Engine and download source (evidence)

### A.1 Pinned packages

| Package | Version | License | Use | Size (npm unpacked / tgz) |
|---|---|---|---|---|
| `node-llama-cpp` | **3.22.1** (published 2026-09-28; 3.22.2 is 10 days old, so it is skipped) | MIT | engine API (ESM-only, `"type":"module"`, `engines.node >=20`) | 40.4 MB / 35.7 MB (35.3 MB of that is `llama/gitRelease.bundle`, source only, **not shipped**) |
| `@node-llama-cpp/win-x64` | 3.22.1 | MIT | Windows x64 CPU (`llama-addon.node` + `ggml-cpu-{sse42,x64,sandybridge,ivybridge,haswell,skylakex,icelake,alderlake,zen4,...}.dll`, picked at runtime per CPU) | 32.9 MB / 10.7 MB |
| `@node-llama-cpp/mac-arm64-metal` | 3.22.1 | MIT | Apple Silicon, Metal + CPU (`libggml-metal.so`, `libggml-cpu-apple_m1/m2_m3/m4.so`) | 18.7 MB / 4.9 MB |
| `@node-llama-cpp/mac-x64` | 3.22.1 | MIT | Intel Mac, CPU | 30.5 MB |
| `@node-llama-cpp/linux-x64` | 3.22.1 | MIT | Linux x64 CPU (same CPU variant set as Windows, `.so`) | 33.3 MB / 10.8 MB |
| `@node-llama-cpp/linux-arm64` | 3.22.1 | MIT | only if a Linux arm64 target is added later (not a target today) | 20.3 MB |
| NOT shipped | | | `win-x64-vulkan` (74 MB), `win-x64-cuda` (176 MB), `win-x64-cuda-ext` (368 MB), `linux-x64-vulkan/cuda/cuda-ext`, `win-arm64`, `linux-armv7l`, `linux-riscv64` | |

All binaries are **Node-API** addons (`llama-addon.node`), so they work with Electron 44 without an ABI rebuild. Bundled llama.cpp: `llama/llama.cpp.info.json` = `{"tag":"v0.5.0","llamaCppGithubRepo":"ggml-org/llama.cpp"}` (the node-llama-cpp release tag). `qwen3` is a supported architecture.

**No runtime build or download, enforced four ways:** (1) `getLlama({ build: 'never', usePrebuiltBinaries: true, skipDownload: true, progressLogs: false, logLevel: 'error', gpu })` (the `getLlama.d.ts` docs say `build` already defaults to `"never"` on Electron; we set it anyway); (2) the worker env sets `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` and `NODE_LLAMA_CPP_LOG_LEVEL=error`; (3) the worker never calls `resolveModelFile`/`createModelDownloader`/`LlamaChatSession` model URLs; (4) **network kill-switch** at the top of `aiWorker.js`, before `import('node-llama-cpp')`: `globalThis.fetch`, `WebSocket`, `http(s).request/get`, `net.connect/createConnection`, `tls.connect` and `dns.lookup` are replaced with functions that throw `Error('Network is disabled in the AI engine')`, then `require('module').syncBuiltinESMExports()` so ESM named imports see the stubs too.

**Install-time postinstall:** the package runs `node ./dist/cli/cli.js postinstall` (it test-loads or, failing that, tries to build llama.cpp). A new project `.npmrc` gets `node-llama-cpp-postinstall=skip` (read through `npm_config_node_llama_cpp_postinstall`), and CI sets `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true`. `npm install` then only unpacks tarballs.

**Keeping GPU packages off dev and CI machines:** npm installs every optional package whose `os`/`cpu` matches, which on Windows means about 650 MB of CUDA and Vulkan packages. The fix is package.json `overrides` that map each unused optional package to a local empty stub, `vendor/nlc-stub/` (a `package.json` with name `nlc-stub` and version `1.0.0`, nothing else): `"overrides": { "node-llama-cpp": { "@node-llama-cpp/win-x64-cuda": "file:vendor/nlc-stub", "@node-llama-cpp/win-x64-cuda-ext": "file:vendor/nlc-stub", "@node-llama-cpp/win-x64-vulkan": "file:vendor/nlc-stub", "@node-llama-cpp/win-arm64": "file:vendor/nlc-stub", "@node-llama-cpp/linux-x64-cuda": "file:vendor/nlc-stub", "@node-llama-cpp/linux-x64-cuda-ext": "file:vendor/nlc-stub", "@node-llama-cpp/linux-x64-vulkan": "file:vendor/nlc-stub", "@node-llama-cpp/linux-armv7l": "file:vendor/nlc-stub", "@node-llama-cpp/linux-riscv64": "file:vendor/nlc-stub" } }`. This saves disk space only; packaging (F.1) does not depend on it. If npm rejects the override, drop it and accept the larger `node_modules`.

### A.2 Model sources (pinned in `modelDownloader.js`, never configurable)

| Id | File on disk | Size (bytes) | SHA-256 | URL (start of every attempt) | Allowed hosts (every hop, HTTPS only) |
|---|---|---|---|---|---|
| `qwen3-0.6b-q4_k_m` (primary) | `qwen3-0.6b-q4_k_m.gguf` | **522640096** | `7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa` | `https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa` | `registry.ollama.ai`, `*.r2.cloudflarestorage.com` |
| `qwen3-0.6b-q8_0` (fallback mirror) | `qwen3-0.6b-q8_0.gguf` | **639446688** | `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` | `https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf` (pinned commit) | `huggingface.co`, `*.hf.co` |

Fallback policy: the primary is tried up to 5 times with backoff. The Q8_0 mirror is used only when the primary keeps failing with a *source* error (HTTP 4xx/5xx other than 416, or a hash mismatch). It is never used for a *connectivity* error, because then the mirror is unreachable too. A `.part` file always resumes against its own source. Only one model file is kept, and the engine loads whichever verified file exists (primary preferred). The Q8_0 file is about 117 MB larger and uses about 120 MB more RAM. Wildcard hosts are acceptable because integrity rests on the pinned SHA-256 and size, not on the host.

### A.3 Model file facts (GGUF header parsed from the first 9 MB via Range; parser script lived in the scratchpad)

GGUF v3, 311 tensors, 28 KV pairs: `general.architecture=qwen3`, `general.name="Qwen3 0.6B"`, `general.license=apache-2.0`, `general.file_type=15` (Q4_K_M), `qwen3.context_length=40960`, `block_count=28`, `embedding_length=1024`, `attention.head_count=16`, `head_count_kv=8`, `key_length=value_length=128`, `tokenizer.ggml.model=gpt2`, `pre=qwen2`, 151,936 tokens, `eos_token_id=151645` (`<|im_end|>`), `bos=pad=151643`, `add_bos_token=false`, and `tokenizer.chat_template` (4,116 chars) containing `enable_thinking is defined and enable_thinking is false` (the official Qwen3 template). The file is a plain GGUF that llama.cpp loads directly; the Ollama blob has no wrapper. The vocabulary contains `<|fim_prefix|>` and its siblings, but this instruct model is not trained for FIM, so they are **not used**. node-llama-cpp ships a `QwenChatWrapper` (`thoughts: "discourage"` injects `<think>\n\n</think>\n\n`); we render that format ourselves (D.1) for exact control.

**KV-cache cost** = 28 layers x 2 x 8 heads x 128 x 2 bytes = **112 KiB per token** (f16).

### A.4 Evidence (commands run 2026-10-27)

- `npm view node-llama-cpp` -> latest 3.22.2 (2026-10-17), 3.22.1 (2026-09-28); MIT; 14 optional `@node-llama-cpp/*` packages pinned to the same version. Every prebuilt package: `license: MIT`, with the `os`/`cpu` values above (`mac-arm64-metal` and `linux-arm64` declare `cpu: [arm64, x64]`; `mac-x64` declares only `x64`).
- `npm pack` of `node-llama-cpp@3.22.1`, `win-x64`, `mac-arm64-metal` and `linux-x64` into the scratchpad. Tarball listings are as in A.1. Main package `files`: `dist/ templates/packed/ llama/ bins/`. `scripts.postinstall = node ./dist/cli/cli.js postinstall`, which exits early on `NODE_LLAMA_CPP_SKIP_DOWNLOAD` or a `skip` config.
- `GET https://registry.ollama.ai/v2/library/qwen3/manifests/0.6b` (Accept: docker manifest v2) -> model layer `sha256:7f40...e1fa`, size 522640096, plus template, license and params layers.
- `HEAD <ollama blob>` -> `200 OK`, `Content-Length: 522640096`, Cloudflare, **no auth**.
- `GET <ollama blob>` with `Range: bytes=0-1023`, no follow -> `307`, `location: https://dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com/ollama/docker/registry/v2/blobs/sha256/7f/7f40.../data?X-Amz-...&X-Amz-Expires=86400...` (a presigned URL valid for 24 h, so every attempt and resume restarts from the registry URL). Following it -> `206 Partial Content`, `Content-Range: bytes 0-1023/522640096`, `Accept-Ranges: bytes`, `ETag` is a multipart etag, **not** the SHA-256.
- Bytes 0-3 = `GGUF`, version 3 (A.3).
- `GET https://huggingface.co/api/models/Qwen/Qwen3-0.6B-GGUF/tree/main` -> the only GGUF is `Qwen3-0.6B-Q8_0.gguf`, size 639446688, LFS oid (SHA-256) `9465e63a...b031`. `HEAD` -> `302` to `us.aws.cdn.hf.co` (xet bridge, signed), `X-Repo-Commit: 23749fefcc72300e3a2ad315e1317431b06b590a`, `X-Linked-Size: 639446688`, `X-Linked-ETag: "9465e63a..."`. Range on the pinned-commit URL -> `206`, `content-range: bytes 0-1023/639446688`.
- `https://registry.ollama.ai/v2/` returns 404, so it is **not** a valid probe; the connectivity probe is a HEAD of the blob URL (expect 200 and the exact Content-Length).
- Monaco 0.52.2 (`esm/.../inlineCompletions/browser/controller/commands.js`): `editor.action.inlineSuggest.commit` is bound to Tab when `inlineSuggestionVisible && !tabMovesFocus && inlineSuggestionHasIndentationLessThanTabSize && !suggestWidgetVisible`; `acceptNextWord` is bound to CtrlCmd+Right when `inlineSuggestionVisible`; Escape hides. `editor.action.inlineSuggest.trigger` has no default key. The `IGlobalEditorOptions.wordBasedSuggestions` option exists (`'off'|'currentDocument'|'matchingDocuments'|'allDocuments'`). `InlineCompletionsProvider` requires `freeInlineCompletions`. Neither Ctrl+Shift+J nor Alt+Shift+S has a Monaco binding.
- electron-builder 26.18.0: NSIS hooks `customHeader`, `preInit`, `customInit` (in `.onInit` after `initMultiUser`), `customInstall` (after extraction), `customUnInstall`; `include/UAC.nsh` defines `UAC_AsUser_Call` and `UAC_SYNC*`. The cached `nsis-resources-3.4.1` contains `INetC.dll` (x86-unicode). The default `templates/entitlements.mac.plist` already holds allow-jit, allow-unsigned-executable-memory and disable-library-validation.

---

## B. Process architecture and lifecycle

```
Renderer (sandboxed)                Main process                                  AI utilityProcess (aiWorker.js)
features/ai-*.js, autosuggest.js    aiIpc.js (composition root, handle())         node-llama-cpp (dynamic import)
  ctx.ai.*  --IPC-->                 |- modelDownloader.js  (net, fs, hash)        |- model (mmap), suggest ctx (n_ctx 1024)
  <-- 'ai:event' ----                |- aiEngine.js  (spawns/supervises worker) --> |- summary ctx (n_ctx 4096, lazy)
                                     |- summaryCache.js (userStore)                 |- summarizer.js -> docExtract.js, aiPrompts.js
                                     '- install mode: main.js --install-model       '- network kill-switch
```

**Why a utility process, not a worker thread or main.** llama.cpp is native code that can crash or run out of memory, and a crash in a `worker_thread` kills the whole app. A utility process is a separate OS process, so a crash costs only the AI and is restarted on demand. Killing it frees *all* model RAM at once (idle unload). Its CPU-heavy eval threads never contend with the main event loop that serves file IPC. `utilityProcess` supports N-API addons and ESM `import()`, and it is unaffected by the `RunAsNode` fuse. Inference never touches the renderer.

### B.1 Model state machine (`modelDownloader.js`, main)

`missing -> checking -> downloading <-> paused -> verifying -> ready`; `downloading -> offline` (connectivity lost: waits for retry), `-> error{code}`; `ready -> missing` (Delete). Error codes: `offline | http | integrity | disk | io | locked | cancelled`.

- **Start triggers:** `ai:model:download`; app start when `ai.autoDownload` is on and `ai.setupPrompted` is true (the gate in D.8 runs first); the renderer's `online` event (forwarded as `download()`); a 10-minute timer while in `offline`; `--install-model`.
- **Request:** `net.request({ url, method: 'GET', session: session.fromPartition('codepad-model'), redirect: 'manual', useSessionCookies: false, cache: 'no-store' })`. The partition is non-persistent, so there are no cookies and no cache shared with the app, and it uses the system proxy (PAC/WPAD/manual) just as the OS does. Headers: `User-Agent: CodePad/<version>`, `Accept-Encoding: identity`, and `Range: bytes=<partSize>-` when resuming. On `redirect`, parse the URL; it must be `https:` and its host must match the source allow-list (exact or `*.suffix`), else abort with `http`. Maximum 5 redirects. No other headers, no query additions, no telemetry.
- **Response checks:** `206` with a `Content-Range` start equal to `partSize` and a total equal to the pinned size, or `200` with a `Content-Length` equal to the pinned size (then truncate the `.part` and restart the hash). Anything else is `http`. More bytes than the pinned size means abort and delete the `.part`.
- **Resume and hash:** on start, an existing `.part` is streamed through `crypto.createHash('sha256')` first (about 1-2 s for 500 MB), then appended. Writes use `fs.createWriteStream(part, { flags: 'a', mode: 0o600 })`. Progress events are throttled to 250 ms: `{bytes, total, bytesPerSec, etaSec}`.
- **Retry:** connect timeout 20 s; stall timeout 30 s without bytes -> abort and retry; backoff 2, 4, 8, 16, 32 s (+-20 % jitter), 5 attempts per source. A connectivity failure (DNS, ECONNREFUSED/RESET, timeout before the first byte, `net::ERR_INTERNET_DISCONNECTED`) moves to `offline`, not to the fallback.
- **Disk space:** before each attempt, `fs.statfs(modelsDir)`: `bavail*bsize >= size - partSize + 64 MiB`, else `disk` with a message naming the MB needed.
- **Verify and commit:** when bytes equal the size, compare the digest with the pinned SHA-256. A mismatch deletes the `.part` and raises `integrity` (counts as a source error). On a match: `fsync`, `rename(part, final)` (atomic, same directory), then write `models/model.json` = `{version:1, id, file, size, sha256, verifiedAt, mtimeMs}` atomically.
- **Load-time check:** `resolve()` returns `{id, path, size}` only when `model.json` matches the catalog entry *and* `stat` size and mtime equal the stored values. Otherwise the file is re-hashed once (about 2 s, off the critical path) and the marker rewritten, or the file is deleted on mismatch.
- **Lock (second instance or installer):** `models/download.lock` is created with `fs.open(path, 'wx')` and holds `{pid, startedAt}`. It is stale when `process.kill(pid, 0)` throws or the `.part` mtime is older than 10 min. If another live process holds it (for example the installer), the state is `downloading` with `external: true`, and progress comes from polling the `.part` size every 2 s until `model.json` appears. The GUI app keeps Electron's single-instance lock as today. `--install-model` does **not** take the single-instance lock.
- **Pause** aborts the request and keeps the `.part`. **Resume** restarts from the `.part`. **Cancel** aborts and deletes the `.part`. **Delete** (`remove`) requires no running engine use (`aiEngine.unload()` first) and deletes the `.gguf`, `.part` and `model.json`.

### B.2 Engine lifecycle (`aiEngine.js` main + `aiWorker.js`)

States: `off -> loading -> ready <-> busy -> off` (idle unload), `error{message}`.

- **Lazy start:** the first `suggest`/`summarize` call with the model `ready` spawns the worker: `utilityProcess.fork(path.join(__dirname, 'aiWorker.js'), [], { serviceName: 'CodePad AI', stdio: 'ignore', env: { NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true', NODE_LLAMA_CPP_LOG_LEVEL: 'error', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })`. A minimal env means no proxies and no `NODE_OPTIONS`. `stdio: 'ignore'` means no content can reach logs. It then sends `init`.
- **init in the worker:** `const { getLlama, LlamaCompletion, LlamaText, SpecialTokensText } = await import('node-llama-cpp')`. On Apple Silicon (`process.platform === 'darwin' && process.arch === 'arm64'`): `getLlama({..., gpu: 'metal'})` and `loadModel({ modelPath, gpuLayers: 'max', useMmap: true })`; on any error, retry once with `gpuLayers: 0` (CPU). On every other OS/arch: `gpu: false`, `gpuLayers: 0`. Threads: `ai.threads || max(1, min(8, floor(os.availableParallelism() / 2)))` (half the logical CPUs keeps the UI and typing smooth). The suggest context is `model.createContext({ contextSize: 1024, threads, sequences: 1, flashAttention: false })`. The summary context is `contextSize: 4096`, created on the first summary and disposed when the job ends (frees about 450 MB). A warm-up `evaluate` of one token makes the first real request skip the one-time graph build. Reply: `{type:'ready', info:{gpu, threads, modelId}}`.
- **RAM:** model mmap is about 0.50 GB (Q8_0: 0.61 GB). The suggest context (1,024 tokens) is about 112 MiB KV plus about 80 MB compute. The summary context (4,096) is about 448 MiB KV plus about 150 MB. Peak is **about 0.75 GB while suggesting and about 1.3 GB while summarizing**. Gate before spawn: `os.totalmem() < 3 GiB` refuses with "Not enough memory for the AI model (needs about 1.5 GB)". `os.freemem() < 1 GiB` only warns once in the status bar; macOS under-reports free memory, so it is not a hard gate.
- **Concurrency:** one worker and one queue per purpose. Suggest: at most one in flight; a new request aborts the previous one (`AbortController`). Summary: one job at a time (a second request gets `{busy:true}`). While a summary job runs, `suggest` returns `null` immediately: CPU priority goes to the explicit user action.
- **Cancellation:** main sends `{type:'cancel', id}`; the worker calls `abortController.abort()` on that generation (`signal`, with `stopOnAbortSignal: false`, so it throws `AbortError`). Generation stops within one token.
- **Idle unload:** a timer of `ai.unloadAfterMinutes` (0 = never) after the last request sends `dispose`, then kills after 3 s. `ai.enabled` true -> false also unloads, unless a summary job is running (it unloads after the job). Summaries work when `ai.enabled` is off (explicit command; the model loads for the job and unloads when it finishes).
- **Crash recovery:** on worker `exit` with a non-zero code or while busy, every pending request rejects with `E_ENGINE_CRASHED` ("The AI engine stopped unexpectedly."); state -> `error`. The next request respawns, at most 3 respawns per 10 minutes; after that the state stays `error` until the user toggles AI or restarts. If loading fails (missing binary, `NoBinaryFoundError`, model load error), the state is `error` with message "The AI engine could not start on this computer: <message>". AI features turn off and everything else is unaffected (H.4).

### B.3 Main-side modules and exact exports

```js
// modelDownloader.js  (Agent Y)  CommonJS, main process only
const CATALOG;   // frozen [{id, file, size, sha256, url, hosts:[...], label}] exactly as A.2, primary first
function createModelManager({ modelsDir, appVersion, log }) -> {
  status(): ModelStatus,         // {state, modelId|null, bytes, total, bytesPerSec, etaSec, external:boolean, error:{code,message}|null}
  onStatus(cb): () => void,      // every state change + throttled progress
  resolve(): Promise<{id, path, size}|null>,   // verified model or null (B.1 load-time check)
  start(): Promise<void>,        // idempotent; resolves when ready, rejects with {code}
  pause(): void, resume(): Promise<void>, cancel(): Promise<void>, remove(): Promise<void>,
  checkConnection({ timeoutMs = 15000 } = {}): Promise<{online:boolean, source?:string, error?:string}>,  // HEAD of the primary, then the mirror (no follow for Ollama: expects 200 + exact length; HF: 302/200)
  dispose(): Promise<void>       // aborts, keeps .part, releases lock
}
// aiEngine.js  (Agent Y)
function createEngine({ workerPath, getModel /* () => Promise<{id,path}|null> */, getSettings, log }) -> {
  state(): {state, error|null, gpu|null, threads|null, modelId|null},
  onState(cb): () => void,
  suggest(req /* see C.1 ai:suggest after validation */, signal): Promise<{text:string|null, cached:boolean}>,
  summarize(job /* {jobId, text, name, style, chunkTokens} */, { signal, onProgress }): Promise<{markdown, stats}>,
  busy(): {suggest:boolean, summary:boolean},
  unload(): Promise<void>, dispose(): Promise<void>
}
// aiWorker.js  (Agent Y): utility process entry, CommonJS + dynamic import; message protocol B.4
// aiPrompts.js (Agent Y): pure, no I/O, required by aiWorker.js and summarizer.js (exports D.1-D.3)
// docExtract.js (Agent W): pure (D.4)   summarizer.js (Agent W): pure orchestration with injected complete() (D.5)
// summaryCache.js (Agent W)
function createSummaryCache({ userStore, maxEntries = 50, maxEntryChars = 32000, maxFileBytes = 2 * 1024 * 1024 }) -> {
  keyFor({ text, modelId, style, chunkTokens, scope }): string,   // sha256 hex of `${PIPELINE_VERSION}\0${modelId}\0${style}\0${chunkTokens}\0${scope}\0` + text
  get(key): Promise<string|null>,      // markdown body; updates lastUsedAt (written lazily, debounced 2 s)
  set(key, markdown): Promise<void>,   // LRU eviction by lastUsedAt beyond maxEntries / maxFileBytes
  clear(): Promise<number>             // number removed; deletes the file
}
// aiIpc.js (Agent W): composition root
function registerAiIpc({ handle, send, getSettings, patchSettings, userDataDir, appVersion, userStore, log }) -> {
  onSettingsChanged(values): void,     // ai.enabled false -> engine.unload(); ai.autoDownload true + missing -> start()
  onWindowClosed(): void,              // cancel summary/suggest, keep download running
  dispose(): Promise<void>             // before-quit: cancel jobs, engine.dispose(), downloader.dispose()
}
```

### B.4 Main <-> worker protocol (`process.parentPort` messages, structured clone)

| Direction | Message |
|---|---|
| main -> worker | `{type:'init', modelPath, modelId, threads, platform, arch}` |
| | `{type:'suggest', id, prompt:{kind:'raw', text}, gen}` (prompt built in main with aiPrompts; `gen` = D.1 options) |
| | `{type:'summarize', id, text, name, style, chunkTokens}` (the worker runs `summarizer.summarize` with its local `complete`) |
| | `{type:'cancel', id}`, `{type:'dispose'}` |
| worker -> main | `{type:'ready', info}`, `{type:'initError', message}` |
| | `{type:'suggestResult', id, text, stopReason}` |
| | `{type:'progress', id, phase, current, total, markdown}` (B.2 throttles to 250 ms) |
| | `{type:'summaryResult', id, markdown, stats}`, `{type:'error', id, code, message}` (codes: `E_ABORTED`, `E_PROMPT_TOO_LONG`, `E_ENGINE`) |

The worker's `complete(spec, gen)` (used by both purposes): it renders `spec` to `LlamaText` (D.1), tokenizes it, and if `tokens + gen.maxTokens + 16 > contextSize` throws `E_PROMPT_TOO_LONG`. It then runs `new LlamaCompletion({ contextSequence }).generateCompletion(tokens, { maxTokens, temperature, topK, topP, minP, seed, repeatPenalty, customStopTriggers: gen.stop, signal, stopOnAbortSignal: false, onTextChunk })`, with `aiPrompts.loopGuard` applied in `onTextChunk` (abort and keep the text before the loop). Each context keeps **one long-lived sequence**: node-llama-cpp re-evaluates only the tokens after the longest common prefix with the sequence's current state, which is the KV reuse D.1 relies on.

---

## C. IPC, preload, settings, commands, ctx

### C.1 Channels (all `handle()`, i.e. main-frame sender check; registered by `aiIpc.js`)

| Channel | Args -> returns | Validation |
|---|---|---|
| `ai:getStatus` | -> `{model: ModelStatus, engine: EngineState, enabled, summary:{running:boolean, jobId|null}}` | |
| `ai:model:download` / `:pause` / `:resume` / `:cancel` / `:delete` | -> `{ok:true}` or `{ok:false, code, message}` | no args. Delete refuses while a summary runs |
| `ai:model:checkConnection` | -> `{online, error?}` | no args; one probe in flight at a time |
| `ai:suggest` | `{reqId:int, prefix:string, suffixLine:string, nextText:string, languageId:string, multiline:boolean}` -> `{reqId, text:string|null}` | `reqId` safe integer; `prefix` <= 8000 chars; `suffixLine` <= 400; `nextText` <= 400; `languageId` `^[A-Za-z0-9_.+-]{1,40}$`; anything else rejects. Returns `{text:null}` when the AI is disabled, the model is not ready, a summary is running or the request was superseded |
| `ai:suggest:cancel` | `reqId` -> `true` | |
| `ai:summarize` | `{text:string, name:string, scope:'file'|'selection'}` -> `{jobId, cached:boolean}` or `{busy:true}` / `{tooLarge:true, max}` / `{empty:true}` | `text` string, 1..`ai.summaryMaxChars` (hard max 2,000,000); `name` stripped of control/bidi characters and cut to 120; scope enum. Style and chunk size come from **main's** settings, never from the renderer |
| `ai:summarize:cancel` | `jobId` -> `true` | |
| `ai:summaryCache:clear` | -> `{removed:int}` | |
| event `ai:event` | `{type:'model', status}` / `{type:'engine', state}` / `{type:'summary', jobId, phase:'extract'|'map'|'reduce'|'final'|'verify'|'done'|'error'|'cancelled', current, total, markdown?, message?, cached?}` | |

There is no URL, path, model id or file name in any request. Main resolves `userData/models` itself. The renderer never gets network access and the CSP is unchanged. On a cache hit `ai:summarize` returns `{cached:true}` and immediately emits one `done` event with the markdown.

### C.2 Preload additions (`preload.js`, Agent X)

```js
ai: {
  status: invoke('ai:getStatus'), onEvent: subscribe('ai:event'),
  model: { download: invoke('ai:model:download'), pause: invoke('ai:model:pause'), resume: invoke('ai:model:resume'),
           cancel: invoke('ai:model:cancel'), remove: invoke('ai:model:delete'), checkConnection: invoke('ai:model:checkConnection') },
  suggest: invoke('ai:suggest'), cancelSuggest: invoke('ai:suggest:cancel'),
  summarize: invoke('ai:summarize'), cancelSummary: invoke('ai:summarize:cancel'),
  clearSummaryCache: invoke('ai:summaryCache:clear'),
},
```

### C.3 New `ctx` surface (Agent X, `renderer/app.js`; features use nothing else)

```
ctx.ai              = the frozen preload `ai` object above (same shape)
ctx.status.addItem({ id, order, onClick(event) }) -> { set(text, { title, state }), dispose() }
                      // a <button class="cp-status-item" data-state=..> inserted before #status-pos; text via textContent
ctx.tabs.contributeMenu(fn(tab) -> items[])   // extra tab context-menu items (tabs.js appends them after a separator)
ctx.tabs.exportBytes(tab, ext) -> Promise<Uint8Array>   // = tab.view.getBytes(ext) for docx/sheet/pdf tabs (view interface B.3), rejects for text/diff
ctx.files.saveBytesAs({ defaultName, filters, bytes }) -> Promise<string|null>   // dialog:saveAs (approves) + fs:writeBinary; null on cancel
ctx.libs.load(name) -> Promise<lib>   // 'mammoth'|'xlsx'|'docx'|'pdfjs' via CodePadEditors.util with the editors' own paths;
                                      // pdfjs also sets GlobalWorkerOptions.workerSrc
ctx.libs.assetUrl(rel) -> string      // CodePadEditors.util.nodeModulesUrl (pdf.js cMap/standard_fonts/wasm/iccs dirs)
```

### C.4 Settings (`shared/settingsSchema.js`, Agent X)

| Key | Type / default / range | Applied by |
|---|---|---|
| `editor.autoSuggest` | bool / **true** | autosuggest.js: `quickSuggestions`, `suggestOnTriggerCharacters` (not monaco-mapped: one key maps to two options) |
| `ai.enabled` | bool / **true** | ghost text on/off (effective only when the model is ready); main unloads on false |
| `ai.autoDownload` | bool / **true** | main: start/retry the download without asking |
| `ai.setupPrompted` | bool / false (hidden) | set true once the first-launch gate was answered |
| `ai.suggestDelayMs` | int / 350 / 150-2000 | ai-suggest.js debounce |
| `ai.maxSuggestionTokens` | int / 24 / 8-64 | main (prompt `gen.maxTokens`); multiline uses min(3x, 64) |
| `ai.contextChars` | int / 2000 / 500-6000 | ai-suggest.js prefix window |
| `ai.threads` | int / 0 / 0-32 (0 = auto) | worker init (applies on next load) |
| `ai.unloadAfterMinutes` | int / 10 / 0-240 (0 = never) | aiEngine idle timer |
| `ai.multiline` | bool / false | suggest stop rules |
| `ai.summaryStyle` | enum both/paragraph/bullets / both | main summarize |
| `ai.summaryMaxChars` | int / 2000000 / 10000-2000000 | renderer pre-check + main validation |
| `ai.chunkTokens` | int / 1500 / 600-2400 | summarizer |
| `ai.summaryCache` | bool / true | aiIpc (off: no read/write; turning it off also clears the file) |

`settings-panel.js` (X) gets the section `ai: 'AI'`, labels for each key and `ai.setupPrompted` in `HIDDEN_KEYS`. The `editor.autoSuggest` label is "Show word suggestions while typing (Ctrl+Space always works)".

### C.5 Command table `shared/commands/ai.commands.js` (Agent Z) + menu wiring (Agent X)

X adds `'ai'` to `TABLE_MODULES` and `['AI', '&AI']` to `ROOTS` between Tools and Macro (Alt+A mnemonic is unused).

| id | Title | Menu / order | Accelerator | when | checkedSetting |
|---|---|---|---|---|---|
| `ai.toggleSuggestions` | AI Suggestions (Ghost Text) | AI / 10 | none | any | `ai.enabled` |
| `suggest.toggleDropdown` | Word Suggestions While Typing | AI / 20 | none | any | `editor.autoSuggest` |
| `ai.suggestNow` | Suggest Now | AI / 30 | none | text | |
| `ai.summarizeFile` | Summarize Current File | AI / 100, separatorBefore | **CmdOrCtrl+Shift+J** | any | |
| `ai.summarizeSelection` | Summarize Selection | AI / 110 | none | text | |
| `ai.cancelSummary` | Cancel Summary | AI / 120 | none | any | |
| `ai.clearSummaryCache` | Clear Summary Cache | AI / 140 | none | any | |
| `ai.downloadModel` | Download AI Model | AI / 200, separatorBefore | none | any | |
| `ai.deleteModel` | Delete AI Model... | AI / 210 | none | any | |
| `ai.showStatus` | AI Model Status... | AI / 220 | none | any | |

Accelerator check: CmdOrCtrl+Shift+J is not in any table (Ctrl+J = bottom panel) and not a Monaco default (A.4). It is not Ctrl+Alt+letter and not Alt+letter (Alt+Shift+S was rejected because Option+Shift+S types "Í" on macOS). Tab, Right and Ctrl+Right are **editor** keybindings (D.2), not menu accelerators. All entries are palette-visible and user-overridable through `keybindings`.

---

## D. Prompts and renderer modules

### D.1 Suggestion prompt (aiPrompts.js, Agent Y)

- **Mode:** raw prefix continuation. The text right before the cursor is fed with **no chat template**: the instruct model then behaves like a base LM and continues the text. Chat-style prompting makes a 0.6B model answer or explain instead of continue, so it is rejected. No FIM (A.3).
- `buildSuggestPrompt({ prefix, languageId, multiline, maxTokens })` returns `{ spec: { kind: 'raw', text: prefix }, gen }` with `gen = { maxTokens: multiline ? min(3*maxTokens, 64) : maxTokens, temperature: 0.2, topK: 20, topP: 0.9, minP: 0.05, seed: 7, repeatPenalty: { penalty: 1.15, lastTokens: 48 }, stop: [...ALWAYS_STOP, ...(multiline ? ['\n\n'] : ['\n'])] }`, where `ALWAYS_STOP = ['<|im_end|>', '<|endoftext|>', '<|im_start|>', '<think>', '</think>', '```']`. Raw text is tokenized as **plain text** (special-token parsing off), so a document containing `<|im_end|>` cannot inject control tokens.
- **Prompt window (renderer, for KV reuse):** `start = max(0, cursorOffset - contextChars)`, rounded **down to a multiple of 1024**, then moved forward to the next line start. The window start is therefore stable while the user types within the block, and the worker re-evaluates only the new tokens (about 0.3-0.8 s on CPU instead of about 2 s cold). `prefix = text[start..cursor]`.
- `cleanSuggestion(raw, { prefix, suffixLine, nextText, multiline })` returns `string|null`:
  1. remove any `SPECIAL_TOKENS` text and everything after it; cut at the first `\n` (single-line) or keep at most 3 lines (multiline);
  2. `trimEnd()`; if the cursor is at line start, keep the model's indentation, otherwise drop a leading space only when the prefix already ends with a space;
  3. reject if empty or only whitespace/punctuation; if it equals or starts the remainder of the line (`suffixLine.trim()` non-empty and the text starts with it); if it repeats the last non-empty prefix line verbatim; if `nextText` starts with it (it would duplicate the next line); if `loopGuard` finds a repetition; if it is longer than 300 chars;
  4. if `suffixLine` is only closers (`)]}'"`>;,` and whitespace), strip a matching trailing closer from the suggestion.
- `loopGuard(text) -> {loop:boolean, cutAt}`: true when the same substring of 8-60 chars occurs 3 times in a row at the end, or one line repeats twice.
- **Main-side cache** (aiEngine): an LRU of 64 entries, key = SHA-1 of the last 600 prefix chars + language + multiline -> cleaned text.

### D.2 Ghost text renderer module `renderer/features/ai-suggest.js` (Agent Z)

- `init(ctx)`: `monaco.languages.registerInlineCompletionsProvider('*', provider)`. On `editor:created`, and once for the current `ctx.editor`: `updateOptions({ inlineSuggest: { enabled: true, mode: 'prefix', showToolbar: 'never', suppressSuggestions: false }, suggest: { preview: false } })`, create the context key `cpAiGhostAtEol = editor.createContextKey('cpAiGhostAtEol', false)` and update it on `onDidChangeCursorPosition` (`column === model.getLineMaxColumn(line)`). Register the **Right Arrow** command: `editor.addCommand(monaco.KeyCode.RightArrow, () => editor.trigger('ai', 'editor.action.inlineSuggest.commit', {}), 'inlineSuggestionVisible && cpAiGhostAtEol && !suggestWidgetVisible && !editorHasSelection && !editorHasMultipleSelections')`. Because Right Arrow accepts only at the end of a line, where it would otherwise just wrap to the next line, normal Right Arrow movement inside a line is untouched. Tab (Monaco default), Ctrl/Cmd+Right (Monaco `acceptNextWord`) and Escape (hide) are the built-ins.
- `provideInlineCompletions(model, position, context, token)` returns `{ items: [] }` (never throws) when: `!ctx.settings.get('ai.enabled')`; engine/model state is not `ready`; `context.selectedSuggestionInfo` is set (the dropdown is open and takes priority); the active tab is not the model's text tab, is read-only, or is a summary tab still streaming; the editor has a selection or multiple cursors; the model exceeds 2,000,000 chars or the line exceeds 1,000 chars; the char after the cursor is a letter/digit/underscore (**mid-word**); the rest of the line contains anything other than whitespace and closers; or the prefix window has fewer than 8 non-whitespace chars.
- **Flow:** wait `ai.suggestDelayMs` (a promise that resolves on the timer or rejects on `token.onCancellationRequested`) -> `reqId = ++seq` -> `ctx.ai.suggest({...})`. `token.onCancellationRequested(() => ctx.ai.cancelSuggest(reqId))`. If the token is cancelled or the result is stale, return `[]`. Else `items: [{ insertText: text, range: new monaco.Range(line, col, line, col) }]`. `freeInlineCompletions() {}`. `handleItemDidShow` does nothing (no telemetry).
- Command `ai.suggestNow` triggers `editor.action.inlineSuggest.trigger` (an explicit trigger skips the debounce through a module flag). `ai.toggleSuggestions` flips `ai.enabled`, and the provider's first check honours it immediately. On `settings:changed` for `ai.enabled=false`, it runs `editor.trigger('ai', 'editor.action.inlineSuggest.hide')`.

### D.3 Word dropdown `renderer/features/autosuggest.js` (Agent Z), independent of AI

- Applies `editor.autoSuggest` on init, `editor:created` and `settings:changed`: on = `{ quickSuggestions: { other: 'on', comments: 'on', strings: 'on' }, suggestOnTriggerCharacters: true }`; off = `{ quickSuggestions: false, suggestOnTriggerCharacters: false }`. Always `wordBasedSuggestions: 'off'` (replaced by our provider to avoid duplicates). Ctrl+Space (`editor.action.triggerSuggest`) works in both states.
- `monaco.languages.registerCompletionItemProvider(monaco.languages.getLanguages().map((l) => l.id), provider)`. Registering by explicit ids, not `'*'`, puts it in the same score group as the built-in JS/TS/CSS/HTML/JSON providers, so the items merge with theirs.
- **Word index:** for every text tab model (`ctx.tabs.list()`, kind `text`), words matching `/[\p{L}_$][\p{L}\p{N}_$]{2,39}/gu` from at most the first 300,000 chars, re-scanned 1 s after the model's last change (`onDidChangeContent`, debounced per model) and dropped on `tab:closed`. Global cap of 20,000 words, with frequency counts.
- **Provider:** the word at the cursor (`model.getWordUntilPosition`), then case-insensitive prefix matches, excluding the word itself, sorted by frequency, at most 50. `kind: Text`, `detail: 'word'`, `range` = the current word range.
- **Snippets** (`kind: Snippet`, `insertTextRules: InsertAsSnippet`): C-like (`javascript typescript java c cpp csharp php go rust swift kotlin dart`): `for`, `fori`, `if`, `ifelse`, `while`, `try`, `function`/`fn`. Python: `for`, `if`, `ifelse`, `while`, `try`, `def`, `class`, `with`. Shell: `if`, `for`, `while`, `function`. Plaintext/markdown: none.

### D.4 Extraction without AI: `docExtract.js` (Agent W, pure, unit-testable)

```js
normalize(text) -> string                // CRLF/CR -> LF, NBSP -> space, strip C0/C1 controls except \t\n, collapse 3+ blank lines to 2
estimateTokens(text) -> int              // CJK/kana/hangul chars count 1 each + ceil(other chars / 3.5); deliberately pessimistic
splitSections(text) -> [{ title, level, text }]   // see rules below; never empty; text keeps paragraphs
extractFacts(text, { maxPerKind }) -> { dates[], numbers[], emails[], urls[], tableRows[], tableCount, nameHints[] }
chunkSections(sections, { maxTokens, overlapTokens = 80 }) -> [{ index, sectionIndex, title, text, tokens, facts }]
digitIndex(text) -> Set<string>          // normalized digit runs for verification
unverifiedNumbers(sentence, index) -> string[]    // runs in sentence not present in index
```

- **Headings** (a line, trimmed, at most 120 chars, not ending with `.`, `,` or `;`): markdown `^(#{1,6})\s+(.+?)\s*#*$` (level = number of #); setext (the next line is `===` -> 1, `---` -> 2); numbered `^(\d{1,3}(?:\.\d{1,3}){0,3})[.)]?\s+\p{Lu}.{0,100}$` with at most 12 words (level = depth + 1); keyword `^(chapter|section|part|article|appendix|annex)\s+[\dIVXLC]+\b` (case-insensitive, level 1); ALL CAPS: at least 3 letters, at least 80 % of letters uppercase, at most 10 words, not a table row (level 2). Text before the first heading forms the untitled section `(Beginning)`. **Fallback:** fewer than 2 headings, or one section holding 90 % of the text -> paragraph blocks (split on blank lines) grouped greedily into sections `Part k`.
- **Facts** (regexes run per line, lines cut at 10,000 chars; all patterns linear with no nested quantifiers; unique, at most 300 per kind per document, at most 12 per kind per chunk):
  - dates: `\b\d{4}-\d{2}-\d{2}\b`, `\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b`, `\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b`, `\b(?:Jan|...|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`, `\b(?:Jan|...|Dec)[a-z]*\.?\s+\d{4}\b` (case-insensitive).
  - numbers with units or currency: `(?:[$€£¥₹]\s?)\d[\d,.'  ]*\d|\b\d[\d,.' ]*(?:\s?(?:%|percent|per cent|kg|g|mg|t|km|m|cm|mm|mi|ft|in|lb|lbs|°C|°F|kWh|MWh|kW|MW|W|V|A|Hz|GB|MB|KB|TB|ms|s|sec|min|h|hrs?|hours?|days?|weeks?|months?|years?|USD|EUR|GBP|INR|JPY|CNY|million|billion|trillion|thousand|bn|mn|k)\b|%)`. Bare numbers are not facts (too noisy) but are in `digitIndex`.
  - emails `[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}`; URLs `\bhttps?://[^\s<>"'\x60)\]]{1,500}` and `\bwww\.[^\s<>"'\x60)\]]{1,500}`.
  - table rows: lines with 2 or more `|` or 2 or more tabs. Kept verbatim (cut to 200 chars); the first row of each table is its header; `tableCount` = number of runs of consecutive rows.
  - name hints: `\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Dame)\.?\s+\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?` and runs of 2-3 Capitalized words that are not at sentence start and not in a stop list (months, weekdays, heading words, common capitalized function words), kept only when seen at least twice. **Hints only**, labelled as such and never fed to the model as fact.
- **Chunking:** sections under 25 % of `maxTokens` merge into the following section (or the previous one at the end) while the sum is at most `maxTokens`, keeping the first title + " / " + next title (cut to 80 chars). Oversized sections split at blank lines, then lines, then sentence ends (`(?<=[.!?。！？])\s+`), then hard char split. Each piece after the first in a section is prefixed with the last paragraph(s) of the previous piece up to `overlapTokens` and titled `<title> (continued)`. `facts = extractFacts(chunk.text, {maxPerKind: 12})`.
- **Verification index:** `digitIndex` normalizes thousands separators (`(?<=\d)[,'  _](?=\d{3}\b)` removed), maps a decimal comma to a dot (`(?<=\d),(?=\d{1,2}\b)`), then adds every `\d+(?:\.\d+)?` run and its integer part. `unverifiedNumbers` applies the same normalization to the model sentence.

### D.5 Summarizer `summarizer.js` (Agent W, pure with injected model)

```js
const PIPELINE_VERSION = 1;
async function summarize({ text, name, style, chunkTokens, contextTokens = 4096, complete, signal, onProgress, prompts = require('./aiPrompts') })
  -> { markdown /* body without the H1 title */, stats: { chunks, calls, dropped, elapsedMs } }
// complete(spec, gen) -> Promise<string>; throws {code:'E_PROMPT_TOO_LONG'} or AbortError
```

1. `normalize` -> `splitSections` -> `extractFacts(all)` -> `chunkSections(maxTokens = min(chunkTokens, contextTokens - 900))`. `onProgress({phase:'extract'})`.
2. **Short document** (one chunk): skip map. `material = chunk text`, `isRawText = true`, go to 4.
3. **MAP** for each chunk i (`onProgress({phase:'map', current:i+1, total:N, markdown: partial})`): `prompts.buildMapPrompt({title, chunk: text, facts})`, then `complete`, then `prompts.parseBullets(out, {max: 4})`. Every bullet goes through `verifyStatement`; a bullet with any unverified number is **dropped** (`stats.dropped++`). On `E_PROMPT_TOO_LONG`, split the chunk in half at a paragraph boundary and recurse once. The partial markdown streams as `## Sections` with the bullets gathered so far.
4. **REDUCE** (only when N > 1): `groups` = per-section bullet lists in order. While `estimateTokens(render(groups)) > REDUCE_INPUT = contextTokens - 1100` (about 3000): pack consecutive groups into batches at most `REDUCE_INPUT`, then `buildReducePrompt({groups: batch})` -> at most 6 verified bullets per batch -> those become the new groups (`phase:'reduce'`). `material` = the rendered groups.
5. **FINAL** (`phase:'final'`): if style is `both` or `paragraph`: `buildOverviewPrompt({name, material, isRawText})` -> one paragraph. Each sentence is verified, unverified sentences are removed, and if every sentence fails, the text becomes "_(The overview could not be verified against the source and was omitted.)_". If style is `both` or `bullets`: `buildKeyPointsPrompt` -> 4-8 verified bullets. A long document (N >= 4 chunks and at least 3 distinct section titles) also gets `## Sections`: up to 12 sections x at most 3 map bullets (dedupe by lower-cased text; titles cut to 80).
6. **VERIFY plus Key facts** (`phase:'verify'`): the final markdown body is

```
_Generated on this computer by Qwen3-0.6B. AI text can be wrong or incomplete; the Key facts are copied from the document. <dropped> statements with numbers not found in the source were removed._
## Overview            (both/paragraph)
## Key points          (both/bullets)
## Sections            (long documents; both/bullets)
### <title>
- ...
## Key facts (copied from the document, not AI)
- **Dates:** a; b; c                       (at most 20 each, in order of first appearance)
- **Numbers:** ...
- **Emails:** ... / **Links:** ...
- **Tables:** N tables; header rows: `...`
- **Possible names (automatic guess):** ...
```

Empty fact kinds are omitted. Markdown special characters in fact values are escaped (`\*_[]\``). The Key facts are built only from `extractFacts`, so exact data never depends on the model. Nothing about chunks is persisted.

### D.6 Summary and map/reduce prompts (aiPrompts.js, Agent Y): exact templates

Chat spec `{kind:'chat', system, user, assistantPrefix}`, rendered by the worker as `LlamaText([SpecialTokensText('<|im_start|>system\n'), system, SpecialTokensText('<|im_end|>\n<|im_start|>user\n'), user, SpecialTokensText('<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'), assistantPrefix])`. Document text is a plain segment (special tokens are never parsed from it). The empty think block and the trailing ` /no_think` in `user` turn thinking off two ways (the template's `enable_thinking=false` form plus Qwen3's soft switch). Common `gen`: `temperature: 0.3, topK: 20, topP: 0.8, minP: 0, seed: 42` (fixed seed: deterministic output for the same input, which the cache relies on), `repeatPenalty: { penalty: 1.1, lastTokens: 96 }`, `stop: ['<|im_end|>', '<|im_start|>', '<think>', '\n\n\n']`.

- `SYSTEM` = `You summarize documents. Use only information that appears in the provided text. Never invent names, numbers, dates or facts. Write in the same language as the text. Be brief.`
- **Map** (`maxTokens: 160`, `assistantPrefix: '- '`):
```
Part title: {title}
Exact facts found in this part (copy them exactly if you mention them): {facts as "; "-joined values, at most 150 tokens, or "none"}

Text:
<<<
{chunk}
>>>

Write 2 to 4 bullet points with the most important information in this text. Each bullet starts with "- " and is one short sentence. Output only the bullets. /no_think
```
- **Reduce** (`maxTokens: 260`, `assistantPrefix: '- '`): `Notes from consecutive parts of one document:\n\n{for each group: "### {title}\n{bullets}"}\n\nCombine these notes into at most 6 bullet points that keep the most important information. Do not repeat yourself. Each bullet starts with "- ". Output only the bullets. /no_think`
- **Overview** (`maxTokens: 220`, `assistantPrefix: ''`): `{isRawText ? "Document" : "Notes about the document"} "{name}":\n<<<\n{material}\n>>>\n\nWrite one paragraph of 3 to 5 sentences that summarizes the document. Output only the paragraph. /no_think`
- **Key points** (`maxTokens: 260`, `assistantPrefix: '- '`): same header, then `Write 4 to 8 bullet points with the key points of the document. Each bullet starts with "- ". Output only the bullets. /no_think`
- `parseBullets(text, {max})`: lines starting with `-`, `*`, `•` or `\d+[.)]` -> stripped, trimmed, de-duplicated, without special tokens, each at most 300 chars, at most `max`.
- **Token budget** at `n_ctx = 4096`: map = about 120 overhead + at most 150 facts + chunk (<= `chunkTokens` <= 2400) + 160 out, which fits up to the 3,196 maximum; reduce input is at most about 3,000 + 260 out; final material is at most about 3,000 (reduce guarantees it) + 260.

### D.7 Summary renderer `renderer/features/ai-summary.js` (Agent Z)

- **Text acquisition** (`getSource(tab, {selection})` -> `{text, name}`):
  - `text` tab: `tab.model.getValue()`, or the selections joined with `\n\n` for `ai.summarizeSelection` (an empty selection gives "Select some text first.").
  - `docx`: `bytes = await ctx.tabs.exportBytes(tab, 'docx')` (current edits included) -> `(await ctx.libs.load('mammoth')).convertToHtml({ arrayBuffer: bytes.buffer })` -> `new DOMParser().parseFromString(html, 'text/html')` (inert, never attached to the page, no scripts run) -> walk `body` children: `h1-h6` -> `#`x level + textContent; `p` -> textContent; `ul/ol > li` -> `- ` + text; `table` rows -> `| c1 | c2 |`. Only `textContent` is read.
  - `sheet` (xlsx/xls/ods/csv/tsv): `bytes = await ctx.tabs.exportBytes(tab, 'xlsx')` -> `X = await ctx.libs.load('xlsx')` -> `X.read(bytes, { type: 'array', cellDates: true })` -> per sheet `## Sheet: <name>` + `X.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false })` rows rendered as `| a | b |`, capped at 20,000 rows x 50 columns per sheet.
  - `pdf`: `bytes = await ctx.tabs.exportBytes(tab, 'pdf')`. It throws for view-only (image-only) PDFs, which yields "This PDF has no extractable text (scanned pages)." Then `pdfjs = await ctx.libs.load('pdfjs')` -> `getDocument({ data: bytes, isEvalSupported: false, enableScripting: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, cMapUrl: ctx.libs.assetUrl('pdfjs-dist/cmaps/'), cMapPacked: true, standardFontDataUrl: ctx.libs.assetUrl('pdfjs-dist/standard_fonts/'), wasmUrl: ctx.libs.assetUrl('pdfjs-dist/wasm/'), iccUrl: ctx.libs.assetUrl('pdfjs-dist/iccs/') })` -> for pages 1..min(n, 3000): `getTextContent()` -> `items.map(i => i.str + (i.hasEOL ? '\n' : ' '))`, pages separated by `\n\n`, then `doc.destroy()`. Fewer than 20 non-space chars gives the same message as above.
  - `diff`: "Not available for this tab."
- **Pre-checks:** `text.length > ai.summaryMaxChars` -> modal "This document has N characters; the limit is M (setting AI > Maximum characters to summarize)." `estimateChunks = ceil(len / (chunkTokens * 3.5))`; more than 40 chunks -> confirm "This will take about X minutes on this computer. Continue?" (X = chunks x 10 s / 60). Model not ready -> offer "Download AI model" (ai-model.js flow).
- **Run:** `const { jobId, cached, busy } = await ctx.ai.summarize({ text, name, scope })`. `busy` -> confirm "Cancel the running summary?". Otherwise open `ctx.tabs.openText({ name: 'Summary of ' + name + '.md', content: '# Summary of ' + name + '\n\n_Preparing..._\n', language: 'markdown' })`, add it to a private `WeakSet` of summary tabs and set `tab.persist.readOnly = true` + `ctx.tabs.changed(tab)` while streaming. On each `summary` event for `jobId`, if `markdown` is present, `tab.model.setValue('# Summary of ' + name + '\n\n' + markdown)`, at most once per 250 ms; the status item shows `Summarizing: part i of N - Cancel` (map/reduce) or `Summarizing: writing overview...`. On `done`, write the final text and restore `readOnly`. On `cancelled`, append `\n\n_Cancelled._`. On `error`, append `\n\n_Summary failed: <message>_` and set the status.
- `ai.cancelSummary` and a click on the status item call `ctx.ai.cancelSummary(jobId)`. The tab context menu (`ctx.tabs.contributeMenu`) gets **Summarize** (any non-diff tab: activate the tab, run `ai.summarizeFile`) and **Export Summary As...** (markdown text tabs).
- **Export** (`ai.exportSummary`, active text tab with language `markdown`): `ctx.ui.pick` among **Word document (.docx)** and **Web page (.html)**. `.md`/`.txt` use the normal Save As (`ctx.tabs.saveAs`), which the picker lists as a third item that runs it. A small markdown subset parser handles `#`/`##`/`###` headings, `- ` bullets, paragraphs, `**bold**`, `_italic_`/`*italic*` and `` `code` ``, giving blocks `{type:'h1'|'h2'|'h3'|'li'|'p', runs:[{text,bold,italic,code}]}`.
  - **docx:** `D = await ctx.libs.load('docx')` (the same pinned `docx` 9.14.0 the docx editor's writer uses; no new dependency) -> `new D.Document({ sections: [{ children: blocks.map(b => new D.Paragraph({ heading: D.HeadingLevel.HEADING_1/2/3, bullet: b.type === 'li' ? { level: 0 } : undefined, children: b.runs.map(r => new D.TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined })) })) }] })` -> `new Uint8Array(await (await D.Packer.toBlob(doc)).arrayBuffer())` -> `ctx.files.saveBytesAs({ defaultName: base + '.docx', filters: [{ name: 'Word Document', extensions: ['docx'] }], bytes })`.
  - **html:** a string built with an `escapeHtml` helper only (no DOM): `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc title}</title><style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.55}</style></head><body>{blocks}</body></html>` -> UTF-8 bytes -> `saveBytesAs` (`html` filter).

### D.8 Model UI `renderer/features/ai-model.js` (Agent Z) + `ai.css`

- **Status bar item** (`ctx.status.addItem({ id: 'ai', order: 0 })`), text and `data-state`: `AI: off` (`ai.enabled` false; click enables), `AI: not installed` (click opens the download dialog), `AI: downloading 43%` (click: context menu Pause/Resume/Cancel/Show progress), `AI: offline` (click: retry), `AI: loading`, `AI: ready` (click disables `ai.enabled`, which unloads), `AI: error` (click: modal with the message + Retry). Tooltip = the detail (bytes, speed, ETA, GPU/CPU, threads).
- **Download dialog** (`ctx.ui.modal`): progress bar (`<progress>`), "225 MB of 523 MB - 4.1 MB/s - about 1 min left", and the buttons Pause/Resume, Cancel, Retry (in error/offline) and Hide (keeps downloading).
- **First-launch gate** (on init, after `ctx.ai.status()`): if the model is `missing`, `ai.setupPrompted` is false and nothing is downloading externally, then `checkConnection()`. Online -> modal "CodePad can suggest text and summarize documents with a small AI model that runs on this computer. It needs to be downloaded once (523 MB) and then works offline. [Download now] [Continue without AI]". Offline -> "CodePad needs internet once to download its AI model. [Retry] [Continue without AI]". Either answer sets `ai.setupPrompted = true`; "Continue without AI" also sets `ai.autoDownload = false` (the status shows `AI: not installed`, and the AI > Download AI Model command remains).
- `window.addEventListener('online', ...)`: when the model state is `offline`, call `ctx.ai.model.download()`.
- `ai.deleteModel`: confirm "Delete the AI model (523 MB)? AI features stop until you download it again." -> `remove()`. `ai.showStatus` shows a modal with model id/size/state, engine state/GPU/threads, cache info and the privacy statement (I.2).

### D.9 Honest quality and latency

Qwen3-0.6B is a very small model. Code completions are often plausible-looking but wrong; it is better at finishing prose phrases and common boilerplate than at project-specific logic. Summaries of long or technical documents can miss the point or merge sections, which is why the numbers are verified and the Key facts are copied. Expected on an ordinary 4-8-core CPU without GPU: **ghost text about 0.5-1.5 s after the pause** (warm KV), 2-3 s for the first one after load; model load 1-3 s; summaries about 8-15 s per 1,500-token chunk (a 20-page document is about 1-2 min). Apple Silicon with Metal is 3-5x faster.

---

## E. Summary output and export flow (end to end)

1. The user runs `ai.summarizeFile` (CmdOrCtrl+Shift+J / AI menu / palette / tab menu) or `ai.summarizeSelection`.
2. The renderer extracts the text (D.7) and runs the pre-checks; `ctx.ai.summarize` follows.
3. Main (`aiIpc`) validates, reads `ai.summaryStyle`, `ai.chunkTokens` and `ai.summaryCache` from its own settings, and computes `key = cache.keyFor({ text, modelId, style, chunkTokens, scope })`. On a hit it returns `{cached:true}` and emits `done` with the cached body (the tab footer adds "_(from cache)_").
4. On a miss it calls `engine.summarize` (loading the model if needed, `phase:'loading'` shown as "Loading the AI model..."). The worker runs `summarizer.summarize` and progress streams to the tab.
5. On `done` (with the cache enabled) it runs `cache.set(key, markdown)`. The cache file `userData/summary-cache.json` is written through `userStore.writeJson` (atomic, mode 0o600, `maxBytes` 2 MB, not signed since it holds no paths) and holds `{version:1, entries:[{key, markdown, createdAt, lastUsedAt}]}`: at most 50 entries, each body at most 32,000 chars (larger bodies are not cached), LRU eviction. **Never the source text, the chunks, the file name or the path.** `ai.clearSummaryCache` and turning `ai.summaryCache` off delete the file.
6. Summary tab: an untitled markdown tab `Summary of <name>.md`. It persists in the session like any unsaved tab and saves through the normal Save/Save As (.md/.txt). Export: `.docx` and `.html` via `ai.exportSummary`.
7. **Privacy tradeoff (stated in Settings, README and AI Model Status):** "Summaries are cached on this computer so re-summarizing an unchanged document is instant. The cache stores only the summary text (which can contain facts from your documents), never the documents. Turn off AI > Cache summaries or use Clear Summary Cache to remove it."

Formats: **.md**, **.txt** (Save As), **.docx**, **.html** (Export Summary As...).

---

## F. Packaging, installers, CI, signing

### F.1 package.json (Agent X), exact changes

- `"version": "1.3.0"`; `"dependencies"` + `"node-llama-cpp": "3.22.1"`. The `@node-llama-cpp/*` packages come in as its pinned optional dependencies, so they are not added directly. Add `overrides` (A.1) and `vendor/nlc-stub/package.json`.
- `build.npmRebuild: false` (no package needs `@electron/rebuild`; the prebuilt addons are N-API).
- `build.files` (common) **add**: `"aiIpc.js"`, `"aiEngine.js"`, `"aiWorker.js"`, `"aiPrompts.js"`, `"modelDownloader.js"`, `"docExtract.js"`, `"summarizer.js"`, `"summaryCache.js"`, `"preloadInstall.js"`, `"NOTICE"`, `"node_modules/node-llama-cpp/package.json"`, `"node_modules/node-llama-cpp/LICENSE"`, `"node_modules/node-llama-cpp/dist/**"`, `"node_modules/node-llama-cpp/llama/*.json"`, `"!node_modules/node-llama-cpp/dist/**/*.map"`, `"!**/*.d.ts"` (scoped to the node-llama-cpp tree), plus **one `node_modules/<pkg>/**` line for every package in the production dependency closure of node-llama-cpp**. X computes the list after the user's `npm install` with the read-only `npm ls --omit=dev --all --parseable node-llama-cpp` (about 60 small packages: `chalk`, `env-var`, `lifecycle-utils`, `@huggingface/jinja`, `semver`, `nanoid`, `ipull`, `ora` and so on). Every line is listed explicitly, following the existing whitelist convention (iconv-lite/safer-buffer). **Not shipped:** `llama/gitRelease.bundle`, `llama/addon/**`, `llama/cmake/**`, `llama/toolchains/**`, `templates/**`, `bins/**/*.lib`.
- Per-platform engine files (electron-builder `${arch}` macro):
  - `"win": { "target": ["nsis","portable"], "files": ["node_modules/@node-llama-cpp/win-${arch}/**", "!node_modules/@node-llama-cpp/**/*.lib"], "signExts": [".dll", ".node"] }`
  - `"mac": { ..., "files": ["node_modules/@node-llama-cpp/mac-${arch}*/**"], "entitlements": "build/entitlements.mac.plist", "entitlementsInherit": "build/entitlements.mac.plist" }` (`mac-arm64*` matches `mac-arm64-metal`; `mac-x64*` matches only `mac-x64`)
  - `"linux": { ..., "files": ["node_modules/@node-llama-cpp/linux-${arch}/**"] }`, `"deb": { "fpm": ["--before-install", "build/linux/deb-preinst.sh"] }`
  - `"nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "include": "build/installer.nsh" }`
- `asar` stays `false`, so native libraries are plain files on disk (no `asarUnpack` needed). On Linux and macOS, `.node`/`.so`/`.dylib` need only read permission (`dlopen`); the AppImage and deb keep the tarball modes.
- **Size:** CPU engine about 31 MB (win/linux) / 19 MB (mac arm64) unpacked + about 5 MB JS (dist without maps) + about 5 MB deps. **Installed +40-45 MB; installers +13-18 MB** (7z/xz compression of the DLL set is about 3:1). No model in any installer.

### F.2 `scripts/afterPack.js` (Agent X)

The fuses are unchanged (the utility process does not need RunAsNode). **Add an assertion:** the expected engine directory for `context.electronPlatformName`/`context.arch` (`win-x64`, `mac-arm64-metal`, `mac-x64`, `linux-x64`) exists under `<resources/app>/node_modules/@node-llama-cpp/`, contains `bins/<dir>/llama-addon.node`, and is the **only** `@node-llama-cpp/*` directory; otherwise throw (the build fails instead of shipping a broken AI). Also assert that `node_modules/node-llama-cpp/llama/gitRelease.bundle` is absent.

### F.3 Windows NSIS: `build/installer.nsh` (Agent X)

**Recommendation: the installer runs the app's own downloader (`CodePad.exe --install-model`) and NSIS does only the connectivity check.** One implementation covers resume, the redirect host allow-list, SHA-256 verification, atomic rename, the lock and proxy handling; NSIS has no SHA-256 primitive, and INetC cannot validate redirect hosts. The app also knows its own `userData` path, which NSIS would have to duplicate (and get wrong for a portable or renamed product). INetC is used only for a HEAD probe, *before any file is written*.

```nsis
!include LogicLib.nsh
!define CP_PROBE1 "https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa"
!define CP_PROBE2 "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf"

!macro customInit                                  ; .onInit, after initMultiUser, before ANY file is written
  ${IfNot} ${UAC_IsInnerInstance}                  ; per-machine: only the outer (user) instance probes, once
    InitPluginsDir
    cp_net_retry:
    inetc::head /SILENT /CONNECTTIMEOUT 15 /RECEIVETIMEOUT 20 "${CP_PROBE1}" "$PLUGINSDIR\cp-net.txt" /END
    Pop $0
    ${If} $0 != "OK"
      inetc::head /SILENT /CONNECTTIMEOUT 15 /RECEIVETIMEOUT 20 "${CP_PROBE2}" "$PLUGINSDIR\cp-net.txt" /END
      Pop $0
    ${EndIf}
    ${If} $0 != "OK"
      ${If} ${Silent}
        SetErrorLevel 5
        Quit
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "CodePad needs an internet connection to install.$\r$\n$\r$\nThe installer downloads CodePad's AI model (523 MB) once; after that CodePad works offline.$\r$\n$\r$\nCould not reach the download server ($0). Check your connection or proxy, then click Retry." IDRETRY cp_net_retry
      Quit                                          ; Cancel: nothing was installed ($PLUGINSDIR is temp and auto-removed)
    ${EndIf}
  ${EndIf}
!macroend

Function cpRunModelInstall                         ; runs as the real user (outer instance) so the model lands in THEIR userData
  ${If} ${Silent}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-model --silent' $0
  ${Else}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-model' $0
  ${EndIf}
FunctionEnd

!macro customInstall                               ; after files are extracted
  cp_model_retry:
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function cpRunModelInstall ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
  ${Else}
    Call cpRunModelInstall
  ${EndIf}
  ${If} $0 != 0
    ${If} ${Silent}
      SetErrorLevel 7                               ; installed, model missing: the app retries on first launch
    ${Else}
      MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "The AI model could not be downloaded (code $0).$\r$\n$\r$\nRetry: try again.$\r$\nIgnore: finish without AI (CodePad downloads it on first start).$\r$\nAbort: cancel the installation." IDRETRY cp_model_retry IDIGNORE cp_model_done
      ExecWait '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /S _?=$INSTDIR'
      SetErrorLevel 6
      Quit
    ${EndIf}
  ${EndIf}
  cp_model_done:
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    RMDir /r "$APPDATA\${PRODUCT_NAME}\models"      ; the 520 MB model; settings/sessions are kept as before
  ${EndIf}
!macroend
```

- **`--install-model` mode (main.js, X):** detected from `process.argv` **before** `requestSingleInstanceLock` (it does not take the lock). After `app.whenReady`: create the model manager. If `resolve()` succeeds, exit 0 at once (covers updates and reinstalls). Otherwise open a 460x200 non-resizable window `renderer/install/model-install.html` (sandboxed, `preloadInstall.js`, same CSP) showing "Downloading the CodePad AI model... 43% (225 of 523 MB)" with a **Cancel** button. With `--silent` there is no window. Exit codes: `0` ready, `2` cancelled by the user, `3` offline, `4` integrity, `5` disk space, `6` locked by another process that did not finish within 30 min, `1` other. Auto-retry and the mirror fallback happen inside the downloader before it gives up. The install window IPC uses `ipcMain.on('install:cancel')` with a sender check against the install window; progress arrives through the `install:progress` event. No other channel is registered in this mode.
- **Per-user vs per-machine:** both deliver the model to the installing user's `%APPDATA%\CodePad\models` (per-machine through `UAC_AsUser_Call`, so the download runs unelevated as the real user). Other Windows users on a per-machine install get the first-launch gate. **Portable target:** no install hook; first launch shows the gate, and the model goes to `%APPDATA%\CodePad\models` (`userData` is unchanged by the portable wrapper).
- The uninstaller keeps settings as before; it removes only `models/`. X must confirm the macros `isUpdated` and `PRODUCT_NAME`/`PRODUCT_FILENAME`/`APP_EXECUTABLE_FILENAME` and the uninstaller file name in `app-builder-lib/templates/nsis` while implementing.

### F.4 macOS and Linux

- **macOS (.dmg/.zip):** there is no install-time hook (drag-to-Applications), so the **first-launch gate** (D.8) applies. `build/entitlements.mac.plist` (used for both `entitlements` and `entitlementsInherit`, so the Helper running the utility process inherits it): `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation`, all `<true/>`. electron-builder signs every Mach-O in the bundle, including `llama-addon.node`, `*.dylib` and the Mach-O files named `*.so`. If notarization reports unsigned `.so` files, list them in `mac.binaries`. Metal needs no entitlement. A non-signed local build runs after the usual right-click Open.
- **Linux AppImage:** first-launch gate only.
- **Linux .deb:** `build/linux/deb-preinst.sh` (runs as root, before files are unpacked, only for `$1 = install`): probe `CP_PROBE1` with `curl -fsSI --max-time 20`, else `wget -q --spider --timeout=20`. On failure print "CodePad needs an internet connection to install (it downloads its AI model on first start)." and `exit 1` (dpkg aborts and nothing is installed). If neither tool exists, print a warning and `exit 0`. The model itself is downloaded on **first launch** by the user (postinst runs as root and does not know which user's home to use).

### F.5 CI `.github/workflows/build.yml` (Agent X)

- Job-level `env: { NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true' }` (postinstall is a no-op; nothing built or downloaded).
- macOS (the runner is arm64; `npm ci` skips `mac-x64` because its `cpu` is `x64` only): after `npm ci` add `npm install --no-save --ignore-scripts --os=darwin --cpu=x64 @node-llama-cpp/mac-x64@3.22.1`. The afterPack assertion (F.2) fails the x64 build if it is missing.
- No model download in CI; artifact size grows by about 15 MB per installer. Signing secrets are unchanged; Windows signing now also covers `.dll`/`.node` (`signExts`).

### F.6 Repository hygiene

`.gitignore` + `*.gguf`, `*.gguf.part` (the model is never committed). `.npmrc` (new): `node-llama-cpp-postinstall=skip`.

---

## G. File layout and ownership (four parallel agents; no file is edited by two agents)

| Agent | Files (N = new, E = edit) | Must provide |
|---|---|---|
| **X** glue / packaging / infra | E `main.js` (requireOptional `./aiIpc`, call `registerAiIpc` after `registerIpc`, settings `onChange` -> `ai.onSettingsChanged`, `before-quit` -> `ai.dispose()`, `closed` -> `ai.onWindowClosed()`, `--install-model` mode); E `preload.js` (C.2); N `preloadInstall.js`; N `renderer/install/model-install.html/.js/.css`; E `shared/settingsSchema.js` (C.4); `settingsStore.js` (no change expected); E `menuBuilder.js` (`'ai'` table, `AI` root); E `renderer/app.js` (C.3 ctx additions only); E `renderer/index.html` (after `macros.js`: `features/ai-model.js`, `features/autosuggest.js`, `features/ai-suggest.js`, `features/ai-summary.js`; `<link rel="stylesheet" href="features/ai.css">`); E `renderer/features/tabs.js` (append `contributeMenu` items after a separator in `menuItems`); E `renderer/features/settings-panel.js` (AI section, labels, hidden key); E `package.json`, N `vendor/nlc-stub/package.json`, N `.npmrc`, E `.gitignore`; E `scripts/afterPack.js`; N `build/installer.nsh`, N `build/entitlements.mac.plist`, N `build/linux/deb-preinst.sh`; E `.github/workflows/build.yml`; N `NOTICE`; docs (I) | everything in C.2/C.3/C.4, F |
| **Y** model + engine + prompts | N `modelDownloader.js`, N `aiEngine.js`, N `aiWorker.js`, N `aiPrompts.js` | exports B.3; protocol B.4; aiPrompts: `SPECIAL_TOKENS, ALWAYS_STOP, buildSuggestPrompt, cleanSuggestion, loopGuard, SYSTEM, buildMapPrompt, buildReducePrompt, buildOverviewPrompt, buildKeyPointsPrompt, parseBullets` (each `build*` returns `{spec, gen}` per D.1/D.6) |
| **W** extraction + summary + cache + IPC | N `docExtract.js`, N `summarizer.js`, N `summaryCache.js`, N `aiIpc.js` | D.4, D.5, `createSummaryCache` (B.3), `registerAiIpc` (B.3) implementing C.1 exactly; unit-testable with a fake `complete` and fake engine/manager |
| **Z** renderer features | N `renderer/features/ai-suggest.js`, `ai-summary.js`, `ai-model.js`, `autosuggest.js`, `ai.css`; N `shared/commands/ai.commands.js` | D.2, D.3, D.7, D.8, C.5; each file follows the feature rules (top-level only `CodePadCommands.register`/`CodePadFeatures.register`; everything else in `init(ctx)`/`run(ctx)`; never cache `ctx.editor`; text only through `textContent`) |

Integration contracts that need no coordination: the `ctx.ai` shape equals C.2; status/event payloads are C.1; aiIpc depends only on `createModelManager`/`createEngine` (B.3) and `createSummaryCache`; the worker requires `./summarizer` (W) and `./aiPrompts` (Y); summarizer requires `./docExtract` and `./aiPrompts` (overridable through `prompts`). The command ids in `ai.commands.js` (Z) are the ones handled by Z's `run()` functions. X's `index.html` load order: `ai-model.js` before `ai-suggest.js` and `ai-summary.js` (they read the state it publishes on the bus as `ai:state` events; `ctx.events.emit('ai:state', {model, engine})` is emitted by ai-model.js, the only subscriber to `ctx.ai.onEvent` for model/engine events; ai-summary.js subscribes to `ctx.ai.onEvent` for `summary` events itself).

---

## H. Security checklist, risks, user verification, fallback

### H.1 Security checklist

- [ ] The renderer never sends URLs, hosts, paths, model ids or file names for I/O; main holds the catalog (A.2) and `userData/models`.
- [ ] Network only in `modelDownloader.js` (main): HTTPS only, every redirect hop checked against the host allow-list, at most 5 redirects, pinned size and SHA-256 verified before an atomic rename, dedicated non-persistent session, no cookies, no telemetry, no other endpoints. The utility process has the network kill-switch (A.1); the renderer has no new network capability; the **CSP is unchanged**.
- [ ] Every new channel uses `handle()` (sender = main frame); args are type/length/enum-validated (C.1); `ai.*` settings are validated by the schema in main; style and chunk size are read by main.
- [ ] Prompt caps: suggest prefix at most 8,000 chars; summary input at most 2,000,000 chars; the worker rejects prompts exceeding the context (`E_PROMPT_TOO_LONG`); document text is never parsed for special tokens (no prompt-control injection); model output reaches the page only through Monaco models and `textContent`.
- [ ] One suggest generation and one summary job at a time; every request is cancellable; worker crash isolation and a respawn cap; idle unload.
- [ ] No content logging: worker `stdio: 'ignore'`; main logs only codes and messages, never prompts, outputs or file names.
- [ ] Document text stays in memory: no chunks or vectors persisted; only the final summary is cached (E.5, opt-out, clearable); the model file has mode 0o600 and the directory 0o700.
- [ ] DOMParser documents (docx HTML) are never attached to the live DOM; only `textContent` is read.
- [ ] The install window gets its own preload and channels, with a sender check against that window; `hardenWebContents` applies to it as well.
- [ ] Packaging: afterPack assertion; only CPU/Metal engine packages; no build toolchain or llama.cpp sources shipped; `signExts` covers the DLLs.

### H.2 Risks and limits to disclose (README + AI Model Status)

0.6B quality (D.9); CPU latency about 0.5-1.5 s per suggestion and minutes for long summaries; RAM about 0.75 GB (suggest) / 1.3 GB (summary); **a one-time 523 MB download** (640 MB from the mirror) needs about 600 MB of free disk; **no AI until the download completes** (offline first run: the editor works fully, AI shows "not installed"); Ollama's registry and Hugging Face are third-party hosts that could move or remove files (the pinned hash prevents tampering, not disappearance; a new release would update the catalog); `.r2.cloudflarestorage.com` presigned redirects; Intel Macs and older CPUs are slower (the `sse42`/`x64` CPU variants are the fallback); Right Arrow at end of line accepts ghost text when one is visible (Escape first to move normally); the summary cache holds summary text.

### H.3 What only the user can verify by running

1. Windows NSIS, clean VM: (a) offline -> the Retry/Cancel dialog appears before any page writes files, and Cancel leaves no install directory; (b) online -> the model window shows progress and the app starts with `AI: ready`; (c) unplug the network mid-download -> Abort/Retry/Ignore, Retry resumes from the `.part`; (d) per-machine install from a standard account elevating with a different admin -> the model lands in the **standard user's** `%APPDATA%`; (e) `/S` silent install with and without network (error levels 5/7); (f) portable exe first launch -> gate.
2. Behind an authenticating corporate proxy: INetC HEAD and Electron `net` both use the system proxy (Electron may prompt via `login`; aiIpc should answer `app.on('login')` only by cancelling, so no stored credentials are used: verify the UX).
3. Kill the app during download -> next start resumes; run `--install-model` while the app is open -> the lock is honoured.
4. macOS signed and notarized build: utility process loads Metal; the `.so` files are signed; Gatekeeper accepts. Linux deb on a machine without network -> preinst aborts cleanly.
5. Right Arrow: inside a line it moves normally; at end of line with ghost text it accepts; with the dropdown open it navigates or closes the dropdown; Tab/Ctrl+Right/Escape behave.
6. Packaged contents per OS: only one `@node-llama-cpp/*` directory, no `gitRelease.bundle`; the app loads the engine with **no network** (unplug the network after the model is downloaded and restart).
7. Real latency/RAM on your machines; the `overrides` stub install works with your npm version.

### H.4 Fallback when the engine fails to load

`engine.state = error` with a message; the status shows `AI: error` (click: details + Retry); the ghost-text provider returns nothing; summary commands show "The AI engine is not available on this computer: <reason>"; the dropdown, the editor and every other feature are unaffected. If `optionalRequire('./aiIpc')` fails, main registers **stub handlers** for the `ai:*` channels returning `{ok:false, code:'unavailable'}` / `null`, so the renderer modules never hit a missing channel.

---

## I. Documentation updates (Agent X, after implementation)

- `.claude/ARCHITECTURE.md`: new files (B.3 list + `preloadInstall.js`, `renderer/install/`, `build/`, `NOTICE`, `vendor/nlc-stub`), the AI process diagram (B), the `ai:*` IPC row, `userData/models/` + `summary-cache.json` in "Data in userData", the `AI` menu, and the new ctx members.
- `.claude/SETUP.md`: the node-llama-cpp 3.22.1 pin + prebuilt packages per OS, the `.npmrc` postinstall skip, `NODE_LLAMA_CPP_SKIP_DOWNLOAD` in CI, the mac-x64 extra install step, `--install-model [--silent]` and its exit codes, the model location and manual deletion, installer size growth, and the per-OS installer behaviour (F.3/F.4).
- `.claude/CLAUDE.md`: one bullet each for the AI architecture (utility process, main-owned downloader with pinned hashes, no renderer network, the summarizer runs in the worker), the rule "network only in modelDownloader.js; never add model URLs from the renderer", and "Right Arrow acceptance relies on context key `cpAiGhostAtEol`".
- `README.md`: AI features, the shortcuts (CmdOrCtrl+Shift+J, Tab/Right/Ctrl+Right), the two switches, the first-run download, the **privacy statement** (below), the known limits (H.2).
- `SHARE.md`: Windows installer needs internet; macOS/Linux download on first launch; the deb preinst; offline installation is not supported (copy `%APPDATA%\CodePad\models` from another machine works: same file + `model.json`).
- `NOTICE` (new, shipped): Qwen3-0.6B (c) Alibaba Cloud Qwen team, Apache License 2.0 (downloaded at install/first run, not redistributed in the installer; link to the license text); node-llama-cpp (c) Gilad S., MIT; llama.cpp / ggml (c) the ggml authors, MIT; the transitive npm licenses (MIT/ISC/Apache-2.0) listed by package name.
- **Privacy statement (README, AI Model Status dialog, first-launch gate):** "CodePad's AI runs entirely on your computer. The only network use is the one-time download of the AI model file from registry.ollama.ai (or Hugging Face as a backup) when you install CodePad or first use AI; the file is checked against a fixed SHA-256 fingerprint. Nothing you type or open is ever sent anywhere. No usage data is collected. Summaries are cached locally (summary text only) and can be cleared or turned off."
