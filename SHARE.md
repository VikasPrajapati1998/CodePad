# Sharing CodePad

This guide covers two jobs: **building** the installer for each OS (you), and **installing** it (the people you share it with).

## 1. Build the installers (you)

Run in the CodePad folder after `npm install`. Each installer must be built **on its own OS**, because Windows, macOS and Linux installers need native tooling.

| Target OS | Build on | Command |
|---|---|---|
| Windows | Windows | `npm run dist:win` |
| macOS | a Mac | `npm run dist:mac` |
| Linux | Linux (or WSL/VM) | `npm run dist:linux` |

Output goes to `installers/Windows`, `installers/MacOS` and `installers/Linux` respectively. The file names are roughly these, and the version number comes from `package.json`:

| OS | File to share | Notes |
|---|---|---|
| Windows | `CodePad Setup 1.3.0.exe` | Installer (choose install folder, Start Menu shortcut, uninstaller) |
| Windows | `CodePad 1.3.0.exe` | Portable: runs without installing |
| macOS | `CodePad-1.3.0.dmg` | Drag-to-Applications disk image |
| macOS | `CodePad-1.3.0-mac.zip` | Same app, zipped |
| Linux | `CodePad-1.3.0.AppImage` | Runs on most distros, no install |
| Linux | `codepad_1.3.0_amd64.deb` | For Debian, Ubuntu and Mint |

Installer size: the local AI engine adds about 13-18 MB per installer (about 40-45 MB installed). The AI model itself (523 MB) is **not** in any installer; it is downloaded once (see section 2).

Mac note: `dist:mac` builds both Intel (x64) and Apple Silicon (arm64) versions, so the folder holds one `.dmg` per CPU type.
On an Apple Silicon Mac, `npm install` skips the Intel AI engine package (`@node-llama-cpp/mac-x64`). Before `dist:mac` run `npm install --no-save --ignore-scripts --os=darwin --cpu=x64 @node-llama-cpp/mac-x64@3.22.1`; the build fails with a clear message if it is missing.

Share the installer files only (not the whole project folder) through a shared drive, a cloud link, or a GitHub Release.

### No Mac or Linux machine? Build in the cloud
The project includes `.github/workflows/build.yml`. Once the project is on GitHub:
- **Manual build:** open the repo's **Actions** tab, choose **Build installers**, click **Run workflow**, then download the `codepad-windows`, `codepad-macos` and `codepad-linux` artifacts from the finished run.
- **Release build:** push a tag such as `v1.3.0`. The workflow builds all three installers and attaches them to a GitHub Release, which gives your users a single download page.

The workflow needs `package-lock.json` to be committed (`npm ci` requires it). The macOS job builds both Intel and Apple Silicon.

### Optional: publish checksums
So people can confirm their download wasn't altered:

```text
certutil -hashfile "installers\Windows\CodePad Setup 1.3.0.exe" SHA256   (Windows)
shasum -a 256 installers/MacOS/CodePad-1.3.0.dmg                         (macOS)
sha256sum installers/Linux/CodePad-1.3.0.AppImage                        (Linux)
```

Send the hash along with the file.

## 2. Install instructions (copy these to your users)

### Internet access (all platforms)
CodePad's suggestions and summaries use a small AI model that runs on the user's computer. The model file (523 MB) is downloaded **once** from registry.ollama.ai (Hugging Face as a backup), checked against a fixed SHA-256 fingerprint, and then works offline. Nothing the user types or opens is ever sent anywhere. Without the download the editor works fully; only the AI features stay off.

- **Windows installer:** needs internet during installation. It checks the connection first (Retry/Cancel if offline; nothing is installed on Cancel), then shows a download window. If the download fails: Retry, Ignore (finish without AI; CodePad downloads it on first start) or Abort. Silent installs (`/S`) exit with error level 5 (no internet), 6 (model failed, installation cancelled) or 7 (installed, model missing).
- **Windows portable, macOS and Linux AppImage:** no install step, so CodePad offers the download on first launch.
- **Linux .deb:** the package checks internet access before installing and refuses to install without it; the model itself downloads on first launch.
- **Offline installation is not supported.** To prepare an offline PC, copy the folder `%APPDATA%CodePadmodels` (both the `.gguf` file and `model.json`) from a computer where it was downloaded into the same place on the other computer (`~/.config/CodePad/models` on Linux, `~/Library/Application Support/CodePad/models` on macOS).

### Windows
1. Download `CodePad Setup 1.3.0.exe` and double-click it.
2. If a blue **"Windows protected your PC"** box appears, click **More info**, then **Run anyway**. This appears because the app isn't code-signed.
3. Pick an install folder, finish the wizard, and open **CodePad** from the Start Menu.

No install wanted? Use `CodePad 1.3.0.exe` (portable) and double-click it.

To uninstall: Settings > Apps > CodePad > Uninstall. This also removes the downloaded AI model; settings and sessions are kept.

### macOS
1. Download `CodePad-1.3.0.dmg`, open it, and drag **CodePad** into **Applications**.
2. The first time, macOS may say the app can't be verified or is damaged. Fix: in **Applications**, **right-click CodePad > Open > Open**. If that doesn't work, run this in Terminal and open it again:
   ```text
   xattr -cr /Applications/CodePad.app
   ```
3. To uninstall, drag CodePad from Applications to the Trash. To also remove the AI model, delete `~/Library/Application Support/CodePad/models`.

### Linux
**AppImage (any distro):**
```text
chmod +x CodePad-1.3.0.AppImage
./CodePad-1.3.0.AppImage
```
On Ubuntu 22.04 and later, if it fails to start, install FUSE (`sudo apt install libfuse2`).

**Debian / Ubuntu / Mint (.deb):**
```text
sudo apt install ./codepad_1.3.0_amd64.deb
```
Then launch **CodePad** from the app menu. Uninstall with `sudo apt remove codepad`. The AI model stays in `~/.config/CodePad/models`; delete that folder to reclaim 523 MB.

## 3. Removing the security warnings

The warnings in section 2 appear because the installers are unsigned. To remove them you need:
- **Windows:** a code-signing certificate. Set `CSC_LINK` and `CSC_KEY_PASSWORD` before building. The `.dll` and `.node` files of the AI engine are signed too.
- **macOS:** an Apple Developer account (paid). The build uses `build/entitlements.mac.plist` (JIT and unsigned-memory entitlements the AI engine needs). Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to sign and notarize.
- **Linux:** no warning, nothing needed.

Never commit these values to the project.

## 4. Releasing a new version

1. Raise `version` in `package.json`.
2. Rebuild on each OS (section 1).
3. Share the new files. Users install over the old version: Windows installer and macOS replace it in place, and a `.deb` upgrades with the same `apt install` command. The AppImage and portable versions are replaced by swapping the file.

CodePad has no auto-update, so users have to install new versions themselves.
