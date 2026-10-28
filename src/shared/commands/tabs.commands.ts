// Tab, file, session, compare and macro commands. Loaded by the main process
// (menuBuilder.ts) only; the matching run() handlers are registered by
// renderer/features/{tabs,files,sessions,compare,macros}.ts.
const gotoCommands: CommandEntry[] = Array.from({ length: 9 }, (_, index): CommandEntry => ({
  id: `tabs.goto${index + 1}`,
  title: index === 8 ? 'Go to Last Tab' : `Go to Tab ${index + 1}`,
  menu: 'View/Tab/Go to Tab',
  order: index + 1,
  accelerator: `CmdOrCtrl+${index + 1}`,
  when: 'any'
}));

const colorCommands: CommandEntry[] = ([
  ['Orange', 1],
  ['Green', 2],
  ['Blue', 3],
  ['Pink', 4],
  ['Yellow', 5]
] as Array<[string, number]>).map(([label, value]): CommandEntry => ({
  id: `tabs.color${value}`,
  title: `Tab Color: ${label}`,
  menu: 'View/Tab/Tab Color',
  order: value,
  when: 'any'
}));

const commands: CommandEntry[] = [
  // Close variants and tab ordering.
  { id: 'tabs.closeOthers', title: 'Close All But Active Document', menu: 'File/Close', order: 10, when: 'any' },
  { id: 'tabs.closeLeft', title: 'Close All to the Left', menu: 'File/Close', order: 20, when: 'any' },
  { id: 'tabs.closeRight', title: 'Close All to the Right', menu: 'File/Close', order: 30, when: 'any' },
  { id: 'tabs.closeUnchanged', title: 'Close All Unchanged', menu: 'File/Close', order: 40, when: 'any' },
  { id: 'tabs.closeAllButPinned', title: 'Close All But Pinned', menu: 'File/Close', order: 50, when: 'any' },
  { id: 'tabs.closeAll', title: 'Close All', menu: 'File/Close', order: 60, accelerator: 'CmdOrCtrl+Shift+W', when: 'any' },
  { id: 'tabs.restoreClosed', title: 'Reopen Closed Tab', menu: 'File', order: 55, accelerator: 'CmdOrCtrl+Shift+T', when: 'any' },

  { id: 'tabs.pin', title: 'Pin / Unpin Tab', menu: 'View/Tab', order: 10, when: 'any' },
  { id: 'tabs.colorNone', title: 'Tab Color: None', menu: 'View/Tab/Tab Color', order: 0, when: 'any' },
  ...colorCommands,
  { id: 'tabs.moveLeft', title: 'Move Tab Left', menu: 'View/Tab', order: 30, separatorBefore: true, accelerator: 'CmdOrCtrl+Shift+PageUp', when: 'any' },
  { id: 'tabs.moveRight', title: 'Move Tab Right', menu: 'View/Tab', order: 40, accelerator: 'CmdOrCtrl+Shift+PageDown', when: 'any' },
  { id: 'tabs.moveStart', title: 'Move Tab to Start', menu: 'View/Tab', order: 50, when: 'any' },
  { id: 'tabs.moveEnd', title: 'Move Tab to End', menu: 'View/Tab', order: 60, when: 'any' },
  ...gotoCommands,

  // Clipboard and shell helpers for the active tab.
  { id: 'tabs.copyPath', title: 'Copy Current Full File Path', menu: 'Edit/Copy to Clipboard', order: 10, when: 'any' },
  { id: 'tabs.copyName', title: 'Copy Current File Name', menu: 'Edit/Copy to Clipboard', order: 20, when: 'any' },
  { id: 'tabs.copyDir', title: 'Copy Current Directory Path', menu: 'Edit/Copy to Clipboard', order: 30, when: 'any' },
  { id: 'tabs.reveal', title: 'Reveal in File Explorer', menu: 'File', order: 56, when: 'any' },

  // Files: reload, monitoring, recent files.
  { id: 'files.reload', title: 'Reload from Disk', menu: 'File', order: 57, when: 'any' },
  { id: 'files.monitor', title: 'Monitor (tail -f)', menu: 'File', order: 58, when: 'any' },
  { id: 'files.recentMenu', title: 'Open Recent', menu: 'File', order: 52, dynamic: 'recent', palette: false },
  { id: 'files.openRecent', title: 'Open Recent File...', when: 'any' },
  { id: 'files.openAllRecent', title: 'Open All Recent Files', when: 'any' },
  { id: 'files.clearRecent', title: 'Clear Recent Files List', when: 'any' },

  // Named sessions.
  { id: 'sessions.save', title: 'Save Session...', menu: 'File/Sessions', order: 10, when: 'any' },
  { id: 'sessions.load', title: 'Load Session...', menu: 'File/Sessions', order: 20, when: 'any' },
  { id: 'sessions.delete', title: 'Delete Session...', menu: 'File/Sessions', order: 30, when: 'any' },

  // Compare (Monaco diff editor in a 'diff' tab).
  { id: 'compare.withTab', title: 'Compare with Open Tab...', menu: 'Tools/Compare', order: 10 },
  { id: 'compare.withDisk', title: 'Compare with Saved File on Disk', menu: 'Tools/Compare', order: 20 },
  { id: 'compare.withClipboard', title: 'Compare with Clipboard', menu: 'Tools/Compare', order: 30 },
  { id: 'compare.next', title: 'Next Difference', menu: 'Tools/Compare', order: 40, separatorBefore: true, when: 'any' },
  { id: 'compare.prev', title: 'Previous Difference', menu: 'Tools/Compare', order: 50, when: 'any' },
  { id: 'compare.clear', title: 'Clear Compare (Close Diff Tab)', menu: 'Tools/Compare', order: 60, when: 'any' },

  // Macros.
  { id: 'macro.toggleRecord', title: 'Start / Stop Recording', menu: 'Macro', order: 10, accelerator: 'CmdOrCtrl+Shift+R', when: 'any' },
  { id: 'macro.playback', title: 'Playback', menu: 'Macro', order: 20, accelerator: 'F9' },
  { id: 'macro.runMultiple', title: 'Run a Macro Multiple Times...', menu: 'Macro', order: 30 },
  { id: 'macro.runToEnd', title: 'Run Macro Until End of File', menu: 'Macro', order: 40 },
  { id: 'macro.run', title: 'Run Saved Macro...', menu: 'Macro', order: 50, separatorBefore: true },
  { id: 'macro.save', title: 'Save Current Recorded Macro...', menu: 'Macro', order: 60, when: 'any' },
  { id: 'macro.delete', title: 'Delete Saved Macro...', menu: 'Macro', order: 70, when: 'any' }
];

export = commands;
