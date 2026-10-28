import type { AfterPackContext } from 'electron-builder';
import type { LinuxPackager } from 'app-builder-lib/out/linuxPackager';
import fs from 'fs';
import path from 'path';

// electron-builder's Arch enum values (builder-util): 0 ia32, 1 x64, 2 armv7l, 3 arm64, 4 universal.
const ARCH_NAMES: Record<number, string> = { 1: 'x64', 3: 'arm64' };
// The one prebuilt node-llama-cpp engine package each target ships (CPU everywhere, Metal on Apple Silicon).
const ENGINE_DIRS: Record<string, string> = {
  'win32-x64': 'win-x64',
  'darwin-arm64': 'mac-arm64-metal',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
};

/** Directory that holds the packaged app files (node_modules, dist/main.js, ...). */
function appDirOf(electronPlatformName: string, appOutDir: string, productName: string): string {
  return electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources', 'app')
    : path.join(appOutDir, 'resources', 'app');
}

/**
 * Removes what must never ship, whatever electron-builder copied: build.files include patterns do not limit
 * node_modules (only exclusions do), so the nlc-stub packages, other-platform engines and the llama.cpp source
 * bundle can land in the app depending on how npm linked them.
 */
function pruneEngineFiles(appDir: string, engineDir: string): void {
  const packages = path.join(appDir, 'node_modules', '@node-llama-cpp');
  if (fs.existsSync(packages)) {
    for (const name of fs.readdirSync(packages)) {
      if (name !== engineDir) {
        fs.rmSync(path.join(packages, name), { recursive: true, force: true });
      }
    }
  }
  fs.rmSync(path.join(appDir, 'node_modules', 'node-llama-cpp', 'llama', 'gitRelease.bundle'), { force: true });
}

/**
 * Fails the build instead of shipping an app whose local AI engine cannot load: exactly one engine package for
 * the target must be present with its llama-addon.node, and the llama.cpp source bundle must not be.
 */
function assertEngineFiles(appDir: string, target: string): void {
  const engineDir = ENGINE_DIRS[target];
  if (!engineDir) {
    throw new Error(`No node-llama-cpp engine package is defined for ${target}.`);
  }
  pruneEngineFiles(appDir, engineDir);
  const packages = path.join(appDir, 'node_modules', '@node-llama-cpp');
  const found = fs.existsSync(packages) ? fs.readdirSync(packages) : [];
  if (found.length !== 1 || found[0] !== engineDir) {
    throw new Error(`Expected only @node-llama-cpp/${engineDir} in the package for ${target}, found: ${found.join(', ') || 'none'}.`);
  }
  const addon = path.join(packages, engineDir, 'bins', engineDir, 'llama-addon.node');
  if (!fs.existsSync(addon)) {
    throw new Error(`The AI engine is missing from the package: ${addon} does not exist.`);
  }
  const bundle = path.join(appDir, 'node_modules', 'node-llama-cpp', 'llama', 'gitRelease.bundle');
  if (fs.existsSync(bundle)) {
    throw new Error('llama/gitRelease.bundle (llama.cpp sources) must not be packaged.');
  }
}

/** electron-builder hook: checks the AI engine files and disables Electron features CodePad does not need. */
export default async function afterPack(context: AfterPackContext): Promise<void> {
  // @electron/fuses is an ES module, so the CommonJS build loads it with a dynamic import.
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const { electronPlatformName, appOutDir, packager, arch } = context;
  const productName = packager.appInfo.productFilename;

  assertEngineFiles(
    appDirOf(electronPlatformName, appOutDir, productName),
    `${electronPlatformName}-${ARCH_NAMES[arch] || arch}`,
  );

  let executable: string;
  if (electronPlatformName === 'darwin') {
    executable = path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  } else if (electronPlatformName === 'win32') {
    executable = path.join(appOutDir, `${productName}.exe`);
  } else {
    executable = path.join(appOutDir, (packager as LinuxPackager).executableName);
  }

  // Deliberately NOT flipped: OnlyLoadAppFromAsar and EnableEmbeddedAsarIntegrityValidation (the app ships with
  // asar:false because Monaco workers use importScripts from file:// and node-llama-cpp loads native files), and
  // GrantFileProtocolExtraPrivileges=false (the renderer is loaded from file://). Turning any of them off/on would
  // break startup; the install directory ACL is the protection instead (see SECURITY.md).
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
}
