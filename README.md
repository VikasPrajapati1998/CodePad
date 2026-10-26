# CodePad

A fast, lightweight code and text editor for all kinds of files, powered by the Monaco editor. Runs on Windows, macOS and Linux.

## Features

- Tabs, file/folder open, folder tree sidebar, drag-and-drop
- Syntax highlighting for 80+ languages with auto-detection and manual override
- Find/replace, multi-cursor, minimap, bracket colorization, go to line
- Command palette (`Ctrl/Cmd+Shift+P`)
- Dark and light themes, word wrap, LF/CRLF switching
- Unsaved-changes protection

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
| Close tab | `Ctrl+W` |
| Command palette | `Ctrl+Shift+P` |
| Find / Replace / Go to line | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Toggle sidebar / word wrap | `Ctrl+B` / `Alt+Z` |

(`Cmd` replaces `Ctrl` on macOS.)
