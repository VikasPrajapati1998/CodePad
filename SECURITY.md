# Security

## Supported versions

Only the latest release receives security fixes. CodePad has no auto-updater: install new releases yourself to get new Electron/Chromium patches.

## Reporting a vulnerability

Do not open a public issue. Report privately to the maintainers (GitHub private security advisory on this repository, or the contact listed in the repository profile) with the version, platform and reproduction steps.

## Threat model

CodePad trusts the OS account it runs in. **Local app tampering is out of scope: anyone who can write as the same user (to the install directory, `userData`, or to a process of that user) already has the user's rights, so that is game over and not something the app can defend against.** The defended boundaries are: documents and folders opened in the app, the renderer (sandboxed, main process owns trust), the network (pinned hosts, hashed model downloads) and other users on the same machine.

## Install directory and ACLs

The app ships unpacked (`asar: false`): `dist/main.js`, `preload.js`, bundled `node_modules` and native `.node`/DLL files are plain files. Whoever can write the install directory can run code as every user who launches CodePad. Therefore the install directory must be writable only by its installer/administrators.

- The Windows installer is **per-user only** (`perMachine: false`, `allowElevation: false`, no directory chooser). It installs to `%LOCALAPPDATA%\Programs\CodePad`, which only the installing user can write.
- **All-users installs into weak-ACL folders (drive roots such as `C:\CodePad`, `D:\Tools`, any folder with Authenticated Users: Modify) are unsupported.** The same applies to extracting the portable exe, the macOS zip or the AppImage into a shared writable location. Keep copies in a directory only you or administrators can write.
- Linux `.deb` installs under `/opt` as root; keep it root-owned.

## Known limits

- **Unsigned builds.** Installers are not Authenticode-signed or notarized. SmartScreen/Gatekeeper will warn. Release assets carry `SHA256SUMS` and a GitHub build-provenance attestation (`gh attestation verify <file> --repo <owner>/<repo>`); verify them before running. Signing is a prerequisite for a trusted release: provide a certificate to electron-builder through `CSC_LINK` / `CSC_KEY_PASSWORD` (Windows) and Apple credentials (macOS notarization) as repository secrets. This is not wired in the workflow because no certificates exist yet.
- **`asar: false`** (deliberate: Monaco workers load via `importScripts` from `file://`, node-llama-cpp loads native files). Consequently the Electron fuses `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation` and `GrantFileProtocolExtraPrivileges=false` stay off. Enabled fuses: `RunAsNode`, `NODE_OPTIONS` and inspect arguments off, cookie encryption on.
- **Third-party GGUF models** (Ollama registry pulls, user-chosen `.gguf`, Hugging Face) are parsed by native llama.cpp code in an unsandboxed utility process. Only use models you trust.
- **macOS entitlements** keep `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation`. It could not be verified without running a signed build whether the unsigned-memory and library-validation exemptions can be removed (node-llama-cpp loads its prebuilt `.node`/dylib files from the app bundle; the Metal backend may need executable memory). Risk: a process that can write the bundle can load dylibs. Remediation: sign all llama binaries with the team ID, then try removing both entitlements on a notarized test build.
- **`@node-llama-cpp/mac-x64` outside the lockfile (tracked, accepted).** The macOS CI job runs `npm install --no-save @node-llama-cpp/mac-x64@3.22.1` because the arm64 runner skips cpu-x64-only packages; it is exact-version but has no committed integrity. Remediation: add it to `optionalDependencies` and regenerate the lockfile (adds sha512 integrity), or build the x64 target on an x64 runner.

## Follow-ups (not done)

1. Pin every third-party action by full commit SHA (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `actions/attest-build-provenance`, `softprops/action-gh-release`). They are on version tags now; resolve each tag to its SHA from the action's releases page and keep the tag as a comment.
2. `npm ci --ignore-scripts` plus explicit `node node_modules/electron/install.js` (and any other required postinstall) once that can be validated in CI; currently `npm ci` runs all install scripts, with `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` set.
3. Trim `build.files`: `cmake-js`, `simple-git` (+ `@simple-git/*`, `@kwsites/*`), `tar`, `ipull`, `cross-spawn`, `yargs` are statically imported by node-llama-cpp `dist` modules (CLI, `createModelDownloader`, `spawnCommand`, repo-clone helpers), so removing them can break module loading. Trim only after tracing the import graph from the entry point actually used by `aiWorker` and testing a packaged build.
4. Code signing (Authenticode/Azure Trusted Signing, macOS notarization) as described above.
5. Longer term: move the renderer to an `app://` protocol and ship an asar (`asarUnpack` for native files) so the asar fuses can be enabled.
