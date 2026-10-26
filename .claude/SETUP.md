# CodePad Setup

Requires Node.js 18+ and npm.

```text
npm install        # installs electron, monaco-editor, electron-builder
npm start          # run in development
npm run dist:win   # installers/Windows: NSIS installer + portable .exe
npm run dist:mac   # installers/MacOS: .dmg + .zip, Intel + Apple Silicon (must be built on macOS)
npm run dist:linux # installers/Linux: AppImage + .deb (best built on Linux)
```

Dependency versions are pinned exactly; `npm install` creates `package-lock.json` (keep it committed) and `npm audit` checks for known vulnerabilities. Packaged builds have DevTools disabled and Electron fuses flipped by `scripts/afterPack.js`.

Code signing (recommended before distribution): set `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows/macOS certificates, and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for macOS notarization (read by electron-builder from the environment; never commit them).

Installers should be built on their target OS. No environment variables are required. `asar` is disabled so Monaco web workers can load from `file://`.
