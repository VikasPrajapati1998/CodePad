import { contextBridge, ipcRenderer } from 'electron';

// Preload of the model-install window only (`CodePad --install-model`): progress in, cancel out.
const api: CodePadInstallApi = {
  onProgress: (callback) => {
    ipcRenderer.on('install:progress', (_event, payload: Omit<CpAiModelStatus, 'modelId'>) => callback(payload));
  },
  cancel: () => ipcRenderer.send('install:cancel'),
};

contextBridge.exposeInMainWorld('codepadInstall', api);
