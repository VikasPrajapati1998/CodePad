'use strict';

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** electron-builder hook: disables Electron features CodePad does not need in packaged builds. */
exports.default = async (context) => {
  const { electronPlatformName, appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;

  let executable;
  if (electronPlatformName === 'darwin') {
    executable = path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  } else if (electronPlatformName === 'win32') {
    executable = path.join(appOutDir, `${productName}.exe`);
  } else {
    executable = path.join(appOutDir, packager.executableName);
  }

  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
};
