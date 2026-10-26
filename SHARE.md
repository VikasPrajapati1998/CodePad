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
| Windows | `CodePad Setup 1.0.0.exe` | Installer (choose install folder, Start Menu shortcut, uninstaller) |
| Windows | `CodePad 1.0.0.exe` | Portable: runs without installing |
| macOS | `CodePad-1.0.0.dmg` | Drag-to-Applications disk image |
| macOS | `CodePad-1.0.0-mac.zip` | Same app, zipped |
| Linux | `CodePad-1.0.0.AppImage` | Runs on most distros, no install |
| Linux | `codepad_1.0.0_amd64.deb` | For Debian, Ubuntu and Mint |

Mac note: `dist:mac` builds both Intel (x64) and Apple Silicon (arm64) versions, so the folder holds one `.dmg` per CPU type.

Share the installer files only (not the whole project folder) through a shared drive, a cloud link, or a GitHub Release.

### No Mac or Linux machine? Build in the cloud
The project includes `.github/workflows/build.yml`. Once the project is on GitHub:
- **Manual build:** open the repo's **Actions** tab, choose **Build installers**, click **Run workflow**, then download the `codepad-windows`, `codepad-macos` and `codepad-linux` artifacts from the finished run.
- **Release build:** push a tag such as `v1.0.0`. The workflow builds all three installers and attaches them to a GitHub Release, which gives your users a single download page.

The workflow needs `package-lock.json` to be committed (`npm ci` requires it). The macOS job builds both Intel and Apple Silicon.

### Optional: publish checksums
So people can confirm their download wasn't altered:

```text
certutil -hashfile "installers\Windows\CodePad Setup 1.0.0.exe" SHA256   (Windows)
shasum -a 256 installers/MacOS/CodePad-1.0.0.dmg                         (macOS)
sha256sum installers/Linux/CodePad-1.0.0.AppImage                        (Linux)
```

Send the hash along with the file.

## 2. Install instructions (copy these to your users)

### Windows
1. Download `CodePad Setup 1.0.0.exe` and double-click it.
2. If a blue **"Windows protected your PC"** box appears, click **More info**, then **Run anyway**. This appears because the app isn't code-signed.
3. Pick an install folder, finish the wizard, and open **CodePad** from the Start Menu.

No install wanted? Use `CodePad 1.0.0.exe` (portable) and double-click it.

To uninstall: Settings > Apps > CodePad > Uninstall.

### macOS
1. Download `CodePad-1.0.0.dmg`, open it, and drag **CodePad** into **Applications**.
2. The first time, macOS may say the app can't be verified or is damaged. Fix: in **Applications**, **right-click CodePad > Open > Open**. If that doesn't work, run this in Terminal and open it again:
   ```text
   xattr -cr /Applications/CodePad.app
   ```
3. To uninstall, drag CodePad from Applications to the Trash.

### Linux
**AppImage (any distro):**
```text
chmod +x CodePad-1.0.0.AppImage
./CodePad-1.0.0.AppImage
```
On Ubuntu 22.04 and later, if it fails to start, install FUSE (`sudo apt install libfuse2`).

**Debian / Ubuntu / Mint (.deb):**
```text
sudo apt install ./codepad_1.0.0_amd64.deb
```
Then launch **CodePad** from the app menu. Uninstall with `sudo apt remove codepad`.

## 3. Removing the security warnings

The warnings in section 2 appear because the installers are unsigned. To remove them you need:
- **Windows:** a code-signing certificate. Set `CSC_LINK` and `CSC_KEY_PASSWORD` before building.
- **macOS:** an Apple Developer account (paid). Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to sign and notarize.
- **Linux:** no warning, nothing needed.

Never commit these values to the project.

## 4. Releasing a new version

1. Raise `version` in `package.json`.
2. Rebuild on each OS (section 1).
3. Share the new files. Users install over the old version: Windows installer and macOS replace it in place, and a `.deb` upgrades with the same `apt install` command. The AppImage and portable versions are replaced by swapping the file.

CodePad has no auto-update, so users have to install new versions themselves.
