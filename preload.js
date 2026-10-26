'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('codepad', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  saveAsDialog: (defaultPath) => ipcRenderer.invoke('dialog:saveAs', defaultPath),
  confirmClose: (name) => ipcRenderer.invoke('dialog:confirmClose', name),
  readFile: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  writeFile: (filePath, content, encoding) => ipcRenderer.invoke('fs:write', filePath, content, encoding),
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  /** Grants access to a dropped File object (only real, user-dropped files have a path). */
  approveDropped: async (file) => {
    const filePath = webUtils.getPathForFile(file);
    await ipcRenderer.invoke('fs:approveDropped', filePath);
    return filePath;
  },
  approveClose: () => ipcRenderer.send('app:closeApproved'),
  onMenu: (callback) => ipcRenderer.on('menu', (_event, action) => callback(action)),
  onRequestClose: (callback) => ipcRenderer.on('request-close', () => callback()),
});
