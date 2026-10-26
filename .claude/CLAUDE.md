# CodePad Project Knowledge

- Stack: Electron + Monaco editor, plain JavaScript (no bundler, no framework). Architecture in ARCHITECTURE.md, setup in SETUP.md.
- Renderer is sandboxed (`sandbox: true`, `contextIsolation`, no `nodeIntegration`); all fs/dialog access goes through `preload.js` -> IPC handlers in `main.js` -> `fileAccess.js`.
- Security rules (see docs/SECURITY_ASSESSMENT.md): the main process owns trust. Never accept arbitrary paths from the renderer; new IPC must use `handle()` (sender check) and `fileAccess` (allow-list). No `'unsafe-inline'` scripts in the CSP. Pin exact dependency versions.
- Monaco is pinned to 0.52.2: 0.57+ changed worker bootstrapping, so upgrading requires reworking `MonacoEnvironment` in `renderer/app.js`.
- Must stay cross-platform (Windows/macOS/Linux): use `CmdOrCtrl` accelerators, `path` helpers, no OS-specific code without a `process.platform` guard.
- `asar: false` is deliberate: Monaco workers are loaded via `importScripts` from `file://`.
- Packaging via electron-builder config in `package.json`; installers are built per-OS.
