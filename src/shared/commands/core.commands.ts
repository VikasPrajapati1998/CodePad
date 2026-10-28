// File, Edit and View commands of the app shell, plus the Window and Help menus. Loaded by the main process
// (menuBuilder.ts) only; the matching run() handlers are registered by renderer/app.ts.
const commands: CommandEntry[] = [
  { id: 'file.new', title: 'New File', menu: 'File', order: 1, accelerator: 'CmdOrCtrl+N', when: 'any' },
  { id: 'file.open', title: 'Open File...', menu: 'File', order: 2, accelerator: 'CmdOrCtrl+O', when: 'any' },
  { id: 'file.openAsText', title: 'Open as Text Editor', menu: 'File', order: 3, when: 'any' },
  { id: 'file.openFolder', title: 'Open Folder...', menu: 'File', order: 4, accelerator: 'CmdOrCtrl+Shift+O', when: 'any' },
  { id: 'file.save', title: 'Save', menu: 'File', order: 5, separatorBefore: true, accelerator: 'CmdOrCtrl+S', when: 'any' },
  { id: 'file.saveAs', title: 'Save As...', menu: 'File', order: 6, accelerator: 'CmdOrCtrl+Shift+S', when: 'any' },
  { id: 'file.saveAll', title: 'Save All', menu: 'File', order: 7, accelerator: 'CmdOrCtrl+Alt+S', when: 'any' },
  { id: 'tabs.close', title: 'Close Tab', menu: 'File', order: 8, separatorBefore: true, accelerator: 'CmdOrCtrl+W', when: 'any' },
  { id: 'app.quit', title: 'Quit', menu: 'File', order: 1000, separatorBefore: true, role: 'quit', platforms: ['win32', 'linux'], palette: false },

  { id: 'edit.palette', title: 'Command Palette...', menu: 'Edit', order: 1, accelerator: 'CmdOrCtrl+Shift+P', palette: false },
  { id: 'edit.gotoLine', title: 'Go to Line...', menu: 'Edit', order: 2, accelerator: 'CmdOrCtrl+G' },
  { id: 'edit.find', title: 'Find', menu: 'Edit', order: 3, accelerator: 'CmdOrCtrl+F', when: 'any' },
  { id: 'edit.replace', title: 'Replace', menu: 'Edit', order: 4, accelerator: 'CmdOrCtrl+H' },

  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', menu: 'View', order: 1, accelerator: 'CmdOrCtrl+B', checkedSetting: 'ui.sidebar', when: 'any' },
  { id: 'view.toggleMinimap', title: 'Toggle Minimap', menu: 'View', order: 2, checkedSetting: 'ui.minimap', when: 'any' },
  { id: 'view.toggleWordWrap', title: 'Toggle Word Wrap', menu: 'View', order: 3, accelerator: 'Alt+Z', checkedSetting: 'editor.wordWrap', when: 'any' },
  { id: 'view.toggleTheme', title: 'Toggle Theme', menu: 'View', order: 4, when: 'any' },
  { id: 'tabs.next', title: 'Next Tab', menu: 'View', order: 5, separatorBefore: true, accelerator: 'Ctrl+Tab', when: 'any' },
  { id: 'tabs.prev', title: 'Previous Tab', menu: 'View', order: 6, accelerator: 'Ctrl+Shift+Tab', when: 'any' },
  { id: 'app.resetZoom', title: 'Reset Zoom', menu: 'View', order: 200, separatorBefore: true, role: 'resetZoom', palette: false },
  { id: 'app.zoomIn', title: 'Zoom In', menu: 'View', order: 201, role: 'zoomIn', palette: false },
  { id: 'app.zoomOut', title: 'Zoom Out', menu: 'View', order: 202, role: 'zoomOut', palette: false },
  { id: 'app.fullscreen', title: 'Toggle Full Screen', menu: 'View', order: 203, role: 'togglefullscreen', palette: false },

  { id: 'app.minimize', title: 'Minimize', menu: 'Window', order: 1, role: 'minimize', palette: false },

  { id: 'app.devTools', title: 'Toggle Developer Tools', menu: 'Help', order: 1, role: 'toggleDevTools', devOnly: true, palette: false },
];

export = commands;
