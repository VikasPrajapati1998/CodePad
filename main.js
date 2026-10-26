'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const path = require('path');
const fileAccess = require('./fileAccess');

const MAX_DIALOG_NAME = 60;

let mainWindow = null;
let closeRequested = false;
let closeApproved = false;

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function menuItem(label, action, accelerator) {
  return { label, accelerator, click: () => send('menu', action) };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        menuItem('New File', 'new', 'CmdOrCtrl+N'),
        menuItem('Open File...', 'open', 'CmdOrCtrl+O'),
        menuItem('Open Folder...', 'openFolder', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        menuItem('Save', 'save', 'CmdOrCtrl+S'),
        menuItem('Save As...', 'saveAs', 'CmdOrCtrl+Shift+S'),
        menuItem('Save All', 'saveAll', 'CmdOrCtrl+Alt+S'),
        { type: 'separator' },
        menuItem('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        menuItem('Command Palette...', 'palette', 'CmdOrCtrl+Shift+P'),
        menuItem('Go to Line...', 'gotoLine', 'CmdOrCtrl+G'),
        menuItem('Find', 'find', 'CmdOrCtrl+F'),
        menuItem('Replace', 'replace', 'CmdOrCtrl+H'),
      ],
    },
    {
      label: '&View',
      submenu: [
        menuItem('Toggle Sidebar', 'toggleSidebar', 'CmdOrCtrl+B'),
        menuItem('Toggle Minimap', 'toggleMinimap'),
        menuItem('Toggle Word Wrap', 'toggleWordWrap', 'Alt+Z'),
        menuItem('Toggle Theme', 'toggleTheme'),
        { type: 'separator' },
        menuItem('Next Tab', 'nextTab', 'Ctrl+Tab'),
        menuItem('Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'https:' || protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch {
      // Malformed URL: ignore.
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    title: 'CodePad',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (closeApproved) {
      return;
    }
    event.preventDefault();
    closeRequested = true;
    send('request-close');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Removes control/bidi characters and truncates a name before it is shown in a native dialog. */
function sanitizeForDialog(name) {
  const clean = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .trim();
  return clean.length > MAX_DIALOG_NAME ? `${clean.slice(0, MAX_DIALOG_NAME)}…` : clean;
}

/** Registers an IPC handler that only answers the app's own main frame. */
function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error(`Rejected IPC call to ${channel} from an untrusted frame.`);
    }
    return handler(event, ...args);
  });
}

function registerIpc() {
  handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) {
      return [];
    }
    const approved = [];
    for (const filePath of result.filePaths) {
      try {
        await fileAccess.approveFile(filePath);
        approved.push(filePath);
      } catch {
        // Unusable path (e.g. UNC): skip it.
      }
    }
    return approved;
  });

  handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled) {
      return null;
    }
    await fileAccess.approveRoot(result.filePaths[0]);
    return result.filePaths[0];
  });

  handle('dialog:saveAs', async (_event, defaultPath) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    });
    if (result.canceled) {
      return null;
    }
    await fileAccess.approveFile(result.filePath);
    return result.filePath;
  });

  handle('dialog:confirmClose', async (_event, name) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${sanitizeForDialog(name)}?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    return response;
  });

  handle('fs:approveDropped', (_event, filePath) => fileAccess.approveFile(filePath));
  handle('fs:read', (_event, filePath) => fileAccess.readTextFile(filePath));
  handle('fs:write', (_event, filePath, content, encoding) =>
    fileAccess.writeTextFile(filePath, String(content), encoding),
  );
  handle('fs:readDir', (_event, dirPath) => fileAccess.readDirectory(dirPath));

  ipcMain.on('app:closeApproved', (event) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || !closeRequested) {
      return;
    }
    closeApproved = true;
    mainWindow.close();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

  app.whenReady().then(() => {
    hardenSession();
    registerIpc();
    buildMenu();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
