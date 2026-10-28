// View, encoding, theme, outline and settings commands. Loaded by the main
// process (menuBuilder.ts) only; the matching run() handlers are registered by
// renderer/features/{view,encoding,themes,outline,settings-panel}.ts.
const THEMES: Array<[string, string]> = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['monokai', 'Monokai'],
  ['solarized-dark', 'Solarized Dark'],
  ['solarized-light', 'Solarized Light'],
  ['zenburn', 'Zenburn'],
  ['obsidian', 'Obsidian'],
  ['hc-black', 'High Contrast']
];

const themeCommands: CommandEntry[] = THEMES.map(([id, label], index): CommandEntry => ({
  id: `view.theme.${id}`,
  title: `Theme: ${label}`,
  menu: 'View/Theme',
  order: 20 + index,
  when: 'any'
}));

const commands: CommandEntry[] = [
  { id: 'view.toggleWhitespace', title: 'Show White Space and Tab', menu: 'View/Show Symbol', order: 10 },
  { id: 'view.toggleEol', title: 'Show End of Line', menu: 'View/Show Symbol', order: 20, checkedSetting: 'editor.showEol' },
  { id: 'view.toggleControlChars', title: 'Show Control Characters', menu: 'View/Show Symbol', order: 30, checkedSetting: 'editor.renderControlCharacters' },
  { id: 'view.showAllSymbols', title: 'Show All Characters', menu: 'View/Show Symbol', order: 40 },
  { id: 'view.toggleIndentGuides', title: 'Show Indent Guides', menu: 'View/Show Symbol', order: 50, separatorBefore: true, checkedSetting: 'editor.indentGuides' },
  { id: 'view.toggleWrapSymbol', title: 'Show Wrap Indentation', menu: 'View/Show Symbol', order: 60 },

  { id: 'view.zoomIn', title: 'Increase Editor Font Size', menu: 'View/Font Size', order: 10, when: 'any' },
  { id: 'view.zoomOut', title: 'Decrease Editor Font Size', menu: 'View/Font Size', order: 20, when: 'any' },
  { id: 'view.zoomReset', title: 'Reset Editor Font Size', menu: 'View/Font Size', order: 30, when: 'any' },

  // Panels live in a submenu so the View menu stays short enough to open below the menu bar.
  { id: 'view.showExplorer', title: 'Show Explorer', menu: 'View/Panels', order: 100, accelerator: 'CmdOrCtrl+Shift+E', when: 'any' },
  { id: 'view.showDocuments', title: 'Show Documents', menu: 'View/Panels', order: 110, accelerator: 'CmdOrCtrl+Shift+D', when: 'any' },
  { id: 'view.outline', title: 'Outline', menu: 'View/Panels', order: 120, accelerator: 'CmdOrCtrl+Shift+Y', when: 'any' },
  { id: 'view.toggleBottomPanel', title: 'Toggle Bottom Panel', menu: 'View/Panels', order: 130, accelerator: 'CmdOrCtrl+J', when: 'any' },
  { id: 'view.summary', title: 'Summary...', menu: 'View/Panels', order: 140, separatorBefore: true },
  { id: 'view.zen', title: 'Distraction Free Mode', menu: 'View', order: 150, separatorBefore: true, accelerator: 'CmdOrCtrl+Shift+F11', when: 'any' },
  { id: 'view.toggleSpellcheck', title: 'Check Spelling While Typing', menu: 'View', order: 170, when: 'any', checkedSetting: 'spell.enabled' },
  { id: 'view.alwaysOnTop', title: 'Always on Top', menu: 'View', order: 160, when: 'any' },

  { id: 'view.theme.pick', title: 'Choose Theme...', menu: 'View/Theme', order: 10, when: 'any' },
  ...themeCommands,

  { id: 'settings.open', title: 'Settings...', menu: 'File', order: 900, separatorBefore: true, accelerator: 'CmdOrCtrl+,', when: 'any' },

  { id: 'enc.reopenWith', title: 'Reopen with Encoding...', menu: 'Encoding', order: 10 },
  { id: 'enc.convertTo', title: 'Convert to Encoding...', menu: 'Encoding', order: 20 },
  { id: 'enc.setDefault', title: 'Set Default Encoding...', menu: 'Encoding', order: 30, when: 'any' },
  { id: 'enc.eolLf', title: 'Convert to LF (Unix)', menu: 'Encoding/End of Line', order: 10 },
  { id: 'enc.eolCrlf', title: 'Convert to CRLF (Windows)', menu: 'Encoding/End of Line', order: 20 },
  { id: 'enc.eolCr', title: 'Convert to CR (Classic Mac)', menu: 'Encoding/End of Line', order: 30 }
];

export = commands;
