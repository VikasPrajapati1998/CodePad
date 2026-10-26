# CodePad Security Assessment

Scope: static review of `main.js`, `preload.js`, `renderer/app.js`, `renderer/index.html`, `package.json` (CodePad 1.0.0, Electron ^33.2.0, Monaco 0.52.2).
Method: source reading only. Nothing was run, so every finding is **unverified until you reproduce it**.

## 1. Threat model and the honest summary

CodePad is a local desktop editor. There is no network server, no login and no remote input channel. The renderer builds all file names and contents with `textContent`/`createElement`, so I found **no direct DOM-injection (XSS) sink** in the app code.

The real weakness is **what happens once any code runs in the renderer**. That could be an XSS bug in Monaco, a malicious opened file, or DevTools. The main process then hands that code full read/write access to the user's disk, which gives code execution. Most findings below are "force multipliers" of that kind, not standalone remote exploits.

| # | Finding | Severity | Needs foothold? |
|---|---|---|---|
| 1 | Unrestricted file read/write/list over IPC | **High** | Renderer JS |
| 2 | IPC handlers don't validate the sender | Medium | Renderer JS |
| 3 | `sandbox: false` | Medium | Renderer JS |
| 4 | CSP allows `'unsafe-inline'` scripts | Medium | DOM injection |
| 5 | No navigation / `window.open` / permission restrictions | Medium | Content or link click |
| 6 | DevTools exposed in the shipped menu | Medium (shared machine) / Low | Local user |
| 7 | App files are plain, writable files (`asar: false`, no fuses) | Medium | Local write access |
| 8 | Outdated Electron and Monaco, caret range | Medium | Known CVEs |
| 9 | UNC path access causes NTLM credential leak (Windows) | Medium | User opens or drops a path |
| 10 | DoS via special files (FIFO, device, huge single-line file) | Low-Medium | User opens a path |
| 11 | Symlink following when opening or saving | Low-Medium | Untrusted folder |
| 12 | Unsaved-changes prompt bypass via `app:closeApproved` | Low | Renderer JS |
| 13 | Dialog text spoofing through file names | Low | Crafted file name |
| 14 | Data worker URL built by string interpolation | Low | Odd install path |
| 15 | Non-atomic saves, forced UTF-8, binary sniff limited to 8000 bytes | Low (integrity) | None |
| 16 | No code signing or update integrity configured | Low-Medium | Distribution |
| 17 | localStorage settings are tamperable | Info | Local user |

## 2. Findings

### 1. Unrestricted file read/write/list over IPC (High)
**Where:** `main.js:148-167` (`fs:read`, `fs:write`, `fs:readDir`), exposed by `preload.js:10-12`.

The handlers take any path string from the renderer. They don't check it against the user's chosen file, an allow-list or a workspace root. The read handler also reads any file under 20 MB.

**Impact if renderer JS runs:**
- Read any file the user can read: SSH keys, `.env` files, browser profiles, `~/.aws/credentials`.
- Overwrite any file the user can write. Examples are a Startup-folder script, `.bashrc`/PowerShell profile, a shortcut, or CodePad's own `main.js` (see #7). That gives persistent code execution.
- Walk the whole disk with `readDir`.

**Exploit sketch (run in DevTools console to see the primitive):**
```js
await window.codepad.readFile('C:\\Users\\<you>\\.ssh\\id_rsa');
await window.codepad.writeFile('C:\\Users\\<you>\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat', 'calc');
```

**Fix:** the main process should own the trust decision. Keep an in-memory set of paths the user picked through a dialog, drag-drop or the opened folder root. Reject any `fs:*` call outside that set (after `fs.realpath`). Stop accepting arbitrary paths from the renderer.

### 2. IPC handlers don't validate the sender (Medium)
**Where:** `main.js:117-174`. Every `ipcMain.handle`/`on` ignores `event.senderFrame`.

Any frame or window that gets the preload API can call them. That includes child windows (see #5) and any iframe.

**Fix:** in each handler, check that `event.senderFrame.url` is the app's own `file://.../renderer/index.html`.

### 3. `sandbox: false` (Medium)
**Where:** `main.js:84`.

With the sandbox off, the preload script runs with full Node access and the renderer process loses Chromium's OS-level sandbox. A Chromium renderer exploit then lands outside a sandbox. The preload only needs `contextBridge`, `ipcRenderer` and `webUtils`, which all work in a sandboxed preload.

**Fix:** set `sandbox: true`. Re-test `webUtils.getPathForFile`, which is supported in sandboxed preloads.

### 4. CSP allows `'unsafe-inline'` scripts (Medium)
**Where:** `renderer/index.html:5-6`: `script-src 'self' 'unsafe-inline'`.

This negates the main protection a CSP gives against injected `<script>`/event-handler markup. Today nothing dynamic reaches `innerHTML` (the only `innerHTML` is the static `'<span>×</span>'` at `app.js:105`). Any future or third-party injection bug would run directly.

`worker-src blob: data:` lets any script start an arbitrary-code worker from a `data:` URL.

**Fix:** drop `'unsafe-inline'` for scripts (there are no inline scripts today). Add `object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`. Narrow the `data:` workers if Monaco can be loaded differently.

### 5. No navigation, `window.open` or permission restrictions (Medium)
**Where:** `main.js:72-101`. There is no `setWindowOpenHandler`, no `will-navigate` handler and no `setPermissionRequestHandler`.

- Monaco turns URLs in a file into clickable links. A click may call `window.open`. In Electron a child window created this way **inherits the parent's `webPreferences`, including the preload**. That would put `window.codepad` into a window showing attacker content. This is the "verify first" item of the list, because it depends on how Monaco opens links in this Electron build.
- `file://` links in an opened file could navigate the main window to a local page.
- Without a permission handler, Electron's default grants most permission requests to loaded content.

**Fix:** `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`, and route `http(s)` links to `shell.openExternal` after a scheme check. Add `will-navigate` that cancels everything except the app page. Add `setPermissionRequestHandler((_, __, cb) => cb(false))`.

### 6. DevTools exposed in the shipped menu (Medium on a shared machine, otherwise Low)
**Where:** `main.js:65` (`{ role: 'toggleDevTools' }`).

Anyone at the keyboard can open DevTools (Ctrl+Shift+I) and use the full `window.codepad` API from the console. On a kiosk or locked-down account that bypasses file-access policy. On a normal desktop it adds nothing beyond what the user could already do.

**Fix:** include the menu item only when `!app.isPackaged`.

### 7. App files are plain and writable; no Electron fuses (Medium)
**Where:** `package.json` (`"asar": false`, no `@electron/fuses`).

- With `asar: false`, `main.js`, `preload.js` and `renderer/app.js` are ordinary text files. For per-user installs (NSIS or portable under `%LOCALAPPDATA%`) the user, or malware running as the user, can edit them. That is a clean **persistence** route: tamper with `main.js` and it runs every launch.
- No fuses are flipped. By default, `ELECTRON_RUN_AS_NODE`, `--inspect` and `NODE_OPTIONS` are honoured. A local attacker who can set environment variables or start the binary can run arbitrary Node (`ELECTRON_RUN_AS_NODE=1`) or attach a debugger to the main process.
- `CLAUDE.md` says `asar: false` is deliberate for Monaco workers, so changing it means testing the workers (asar integrity plus `asarUnpack` for Monaco).

**Fix:** use `@electron/fuses` (disable `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`; enable `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` if asar is adopted).

### 8. Outdated, loosely pinned dependencies (Medium)
**Where:** `package.json`: `electron ^33.2.0`, `electron-builder ^25.1.8`, `monaco-editor 0.52.2`.

Electron 33 is no longer a supported release line, so Chromium fixes stop reaching it. A bundled Chromium with known, public renderer bugs is the most realistic way to reach the "renderer foothold" that findings 1-3 amplify. The caret ranges also let a fresh install pull different versions.

**Fix:** move to a supported Electron major, pin exact versions, commit a lockfile and run `npm audit`.

### 9. UNC path access leaks NTLM hashes on Windows (Medium)
**Where:** `app.js:227-234` and `main.js:103-114` (`fs.stat` / `fs.readFile` on any string).

Opening or dropping a path like `\\attacker-host\share\x.txt` makes Windows try to authenticate over SMB, sending the user's NTLMv2 challenge response to the remote host. Via the file dialog this needs the user to pick the path. Via the IPC primitive (#1) a script can trigger it silently.

**Fix:** reject UNC paths (`\\\\` / `//` prefix) in the main process unless the user typed them in a dialog.

### 10. DoS through special files and huge single-line files (Low-Medium)
**Where:** `main.js:103-114`.

- The 20 MB limit uses `stat.size`. For FIFOs, `/dev/zero`, `/dev/random` and Windows device paths, size is 0 and `readFile` never finishes. This hangs a main-process handler and can exhaust memory.
- A 20 MB file with a few very long lines passes every check and then freezes Monaco's tokenizer.
- The binary check sniffs only the first 8000 bytes (`BINARY_SNIFF_BYTES`). A file with its first NUL byte later is accepted as text and shows as garbage.

**Fix:** require `stat.isFile()`, read with a bounded stream, and cap line length or disable tokenization for very long lines.

### 11. Symlink following (Low-Medium)
**Where:** `main.js:148-167`.

Opening an untrusted folder or archive extraction can include a symlink to a sensitive file. The tree lists it and one click reads it. Saving through a symlink in an untrusted folder writes to the target.

**Fix:** `fs.realpath` and confirm the result stays inside the opened root. Optionally warn before writing through a symlink.

### 12. Unsaved-changes prompt bypass (Low)
**Where:** `main.js:169-174` and `preload.js:14`. `app:closeApproved` is a plain event with no check that the user approved anything, so injected script can set `closeApproved = true` and close the window, discarding unsaved edits.

**Fix:** track dirty state in the main process, or confirm in the main process before honouring the close.

### 13. Dialog text spoofing (Low)
**Where:** `main.js:136-146`. The tab name goes straight into the message. A file named with a very long string or look-alike text can make the "Save changes to ..." box read as something else.

**Fix:** truncate and strip control characters from the name.

### 14. Worker URL built by string interpolation (Low)
**Where:** `app.js:10-16`. `monacoBase` is derived from the page URL and placed inside a single-quoted JS string in the worker source. `encodeURIComponent` does not escape `'`. An install path containing `'` can break the string, and a crafted path could inject code into the worker bootstrap.

**Fix:** build the worker source with `JSON.stringify(monacoBase)`.

### 15. Data-integrity issues (Low)
- `fs:write` (`main.js:150`) writes in place. A crash or power cut mid-save truncates the user's file. Write to a temp file and rename instead.
- Saves are always UTF-8. Opening a UTF-16 or Latin-1 file and saving rewrites it differently. The BOM is not preserved. The status bar shows "UTF-8" as if that were always right.

### 16. No code signing or update integrity (Low-Medium)
**Where:** `package.json` `build` block. No `win.certificateFile` / signing, no notarization config for macOS. Unsigned installers can be swapped in transit without any warning beyond SmartScreen. There is no auto-updater, which avoids an update-channel attack but means users stay on vulnerable versions.

### 17. Settings in localStorage (Info)
`app.js:26-31`. Theme, minimap, wrap and sidebar values are user-tamperable. They don't affect security.

## 3. What is done well
- `contextIsolation: true` and `nodeIntegration: false`.
- `webSecurity` is left at its default (enabled).
- All dynamic DOM uses `textContent`/`createElement`.
- A single-instance lock is set, and second-instance arguments are ignored.
- The preload exposes narrow named functions, not raw `ipcRenderer`.

## 4. Suggested order of attack (for testing) and fix priority
1. Confirm #1 in DevTools (read and write arbitrary paths).
2. Test #5: put `https://example.com` and a `file:///` URL in a file, click the link, and check whether a new window gets `window.codepad`.
3. Test #9 and #10: UNC path, then a FIFO or `/dev/zero`.
4. Test #7: tamper `main.js`, relaunch, and try `ELECTRON_RUN_AS_NODE=1`.
5. Fix in this order: #1 and #2 together (path allow-list plus sender check), then #3, #4, #5, then #7 and #8.

## 5. Remediation status (code changes made, not yet run)

| # | Status | How |
|---|---|---|
| 1, 11 | Fixed | `fileAccess.js` allow-list: only dialog/drop-approved files or the opened folder; `realpath` check blocks symlink escapes |
| 2 | Fixed | `handle()` in `main.js` rejects any sender other than the main frame |
| 3 | Fixed | `sandbox: true` |
| 4 | Fixed | `script-src 'self'`, plus `object-src/base-uri/form-action/frame-src` locked. `worker-src data: blob:` kept (Monaco needs it; unverified whether it can be narrowed) |
| 5 | Fixed | `setWindowOpenHandler` denies (http/https go to the OS browser), `will-navigate` cancelled, permissions denied |
| 6 | Fixed | DevTools menu item and `devTools` option only when unpackaged |
| 7 | Partly fixed | Fuses flipped in `scripts/afterPack.js`. `asar: false` remains (Monaco workers), so installed files are still editable by whoever can write to the install dir |
| 8 | Partly fixed | Electron 44.9.3, electron-builder 26.18.0, exact pins. Monaco stays at 0.52.2 (0.57 changed worker bootstrapping). Lockfile is created by your `npm install` |
| 9 | Fixed | UNC paths rejected (also means network shares via `\\host\share` can't be opened; mapped drive letters still work) |
| 10 | Mostly fixed | `isFile()` required, whole-file NUL scan. Very long lines rely on Monaco's built-in limits (tokenization skips lines over 20,000 chars) |
| 12 | Mostly fixed | Close is only honoured after the main process requested it, from the main frame. Dirty state is still tracked in the renderer |
| 13 | Fixed | Control/bidi characters stripped, name truncated to 60 chars |
| 14 | Fixed | `JSON.stringify` for the worker bootstrap |
| 15 | Fixed | Atomic temp-file + rename saves; UTF-8/UTF-8 BOM/UTF-16/Latin-1 detected, preserved and shown in the status bar |
| 16 | Not fixed | Needs your signing certificates; setup is documented in SETUP.md, `hardenedRuntime` enabled for macOS |
| 17 | Accepted | No security impact |

## 6. Not covered
- Third-party code inside `node_modules` (Monaco internals, Electron).
- A dynamic test. No code was executed and no network capture was made.
- `styles.css` was not reviewed (no security impact expected).
