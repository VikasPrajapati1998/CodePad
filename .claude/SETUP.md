# CodePad Setup

Requires Node.js 22.18+ (the build script is TypeScript run directly by Node) and npm.

```text
npm install        # installs electron, monaco-editor, document-editor libraries, electron-builder
npm start          # compiles TypeScript (src/ -> dist/) and runs in development
npm run build      # compile only (tsc for the main and renderer projects, then copy html/css/icon into dist/)
npm run typecheck  # tsc --noEmit for both projects
npm run dist:win   # installers/Windows: NSIS installer + portable .exe
npm run dist:mac   # installers/MacOS: .dmg + .zip, Intel + Apple Silicon (must be built on macOS)
npm run dist:linux # installers/Linux: AppImage + .deb (best built on Linux)
```

Dependency versions are pinned exactly; `npm install` creates `package-lock.json` (keep it committed) and `npm audit` checks for known vulnerabilities. Packaged builds have DevTools disabled and Electron fuses flipped by `src/scripts/afterPack.ts` (compiled to `dist/scripts/afterPack.js`).

Document editing libraries (all pinned): `pdfjs-dist` 6.4.299 (ESM + module worker, loaded locally), `@cantoo/pdf-lib` 2.11.1, `@pdf-lib/fontkit` 1.1.1, `mammoth` 1.13.0, `docx` 9.14.0 and SheetJS `xlsx` 0.20.3. SheetJS is installed from the vendored `vendor/xlsx-0.20.3.tgz` (`file:` dependency) because npm's `xlsx` package is stuck at a vulnerable 0.18.5 and remote tarballs are disabled in this npm config. Packaging picks the needed library files through `build.files`; the installer grows by roughly 8 MB.

Encodings: `iconv-lite` 0.7.3 (pinned) powers the non-Unicode encodings. It is used only by the main process and the search worker, and it needs `node_modules/iconv-lite/**` and `node_modules/safer-buffer/**` in `build.files` (already listed, together with `shared/**` and the main-side modules).

Local AI: `node-llama-cpp` 3.22.1 (pinned) runs Qwen3-0.6B in an Electron utility process. Its prebuilt engine packages (`@node-llama-cpp/win-x64`, `mac-arm64-metal`, `mac-x64`, `linux-x64`; CPU, plus Metal on Apple Silicon) are N-API addons, so no Electron rebuild is needed (`build.npmRebuild: false`). Nothing is built or downloaded at install or run time:
- Project `.npmrc` sets `node-llama-cpp-postinstall=skip`; CI sets `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true`.
- `package.json` `overrides` map the unused GPU/other-arch engine packages to the empty `vendor/nlc-stub` (saves about 650 MB of CUDA/Vulkan downloads; if npm rejects it, remove those entries). The override `"simple-git": "4.0.2"` replaces a transitive dependency of node-llama-cpp that has an `npm audit` advisory (`npm audit` reports 0 vulnerabilities).
- `build.files` lists node-llama-cpp's production dependency closure explicitly (one `node_modules/<pkg>/**` line each); recompute it when node-llama-cpp is upgraded. Per-OS `files` ship only the engine package of the target (the `${arch}` macro); `scripts/afterPack.js` fails the build unless exactly that package, with its `llama-addon.node`, is present and `llama/gitRelease.bundle` is absent.
- macOS x64 builds on an Apple Silicon machine (and the CI macOS job) need `npm install --no-save --ignore-scripts --os=darwin --cpu=x64 @node-llama-cpp/mac-x64@3.22.1` after `npm install`, because npm skips it on arm64. `build/entitlements.mac.plist` (JIT, unsigned memory, no library validation) is used for signing.
- Installers grow by about 13-18 MB (installed about 40-45 MB). The model is not in any installer.

AI model: the model manager (main process, `modelDownloader.js`) downloads `qwen3-0.6b-q4_k_m.gguf` (522,640,096 bytes, pinned SHA-256) into `userData/models/` (backup: Hugging Face Q8_0, 639,446,688 bytes), with `model.json` marking a verified file. It needs about 600 MB free. To remove it, use AI > Delete AI Model or delete the `models` folder; copying the folder (`.gguf` + `model.json`) to another computer installs it offline.

Installer behaviour: the Windows NSIS installer (`build/installer.nsh`, INetC plugin) probes the model server before writing any file (Retry/Cancel), then runs `CodePad.exe --install-model [--silent]` as the real user (Abort/Retry/Ignore on failure) and removes `models/` on uninstall. `--install-model` exit codes: 0 ready, 2 cancelled, 3 offline, 4 integrity, 5 disk space, 6 locked by another process for 30 min, 1 other; silent installer error levels: 5 no internet, 6 aborted after model failure, 7 installed without the model. The .deb pre-install script (`build/linux/deb-preinst.sh`) checks internet access with curl/wget and aborts without it. macOS, AppImage and the Windows portable build download on first launch. `NOTICE` (shipped) lists the model and engine licenses.

User data lives in Electron's userData folder: `settings.json`, `recent.json`, `macros.json`, `session.json`, `sessions/`, `store.key`, `summary-cache.json` (AI summaries) and `models/` (AI model). Delete a file (or the folder) to reset it. An old unsigned `session.json` from an earlier version fails the integrity check once; only untitled text is restored from it.

Command line: `CodePad file1 file2` opens files (also from a second instance), `-n<line>` jumps to a line in the first file (`-n42`), `-nosession` skips restoring the previous session once.

Code signing (recommended before distribution): set `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows/macOS certificates, and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for macOS notarization (read by electron-builder from the environment; never commit them).

Installers should be built on their target OS. No environment variables are required. `asar` is disabled so Monaco web workers can load from `file://`.
