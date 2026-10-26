# CodePad Architecture

Electron desktop editor built on Monaco (the VS Code editor engine). Cross-platform: Windows, macOS, Linux.

```text
CodePad/
├── package.json        # Scripts, dependencies, electron-builder packaging config
├── main.js             # Electron main process: window, native menu, dialogs, sender-checked IPC, navigation/permission lockdown, close flow
├── fileAccess.js       # Main-side file layer: path allow-list (user-approved files/root), UNC/symlink checks, encodings, atomic writes
├── preload.js          # contextBridge API (window.codepad) exposed to the sandboxed renderer
├── assets/
│   └── icon.png        # App icon (1024x1024); used for the window icon and as the electron-builder source for .ico/.icns/Linux icons
├── scripts/
│   └── afterPack.js    # electron-builder hook: flips Electron fuses (RunAsNode, NODE_OPTIONS, --inspect off)
├── renderer/
│   ├── index.html      # UI shell (sidebar, tabs, editor, status bar) + CSP
│   ├── styles.css      # Dark/light theme variables and layout
│   └── app.js          # Monaco setup, tabs, file tree, save/open logic, status bar, view settings
├── .github/workflows/build.yml  # CI: builds Windows/macOS/Linux installers; attaches them to a GitHub Release on `v*` tags
├── SHARE.md            # How to build, distribute and install CodePad per OS
└── .claude/            # Project docs for Claude (CLAUDE.md, ARCHITECTURE.md, SETUP.md, .claudeignore)
```

Flow: menu click (main) -> `menu` IPC -> `menuActions` in `renderer/app.js`. File access only via IPC handlers in `main.js` (`fs:*`, `dialog:*`), which delegate to `fileAccess.js`; paths are only usable after the user picks them (dialog/drop) or they sit inside the opened folder. Window close is intercepted: main sends `request-close`, renderer prompts for dirty tabs, then calls `approveClose`.
