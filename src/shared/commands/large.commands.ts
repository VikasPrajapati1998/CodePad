// Commands for large files (opened in large-file mode). Loaded by the main process (menuBuilder.ts) only; the
// handlers of goTo* are registered by renderer/app.ts, those of find/count by renderer/features/large-find.ts. Every
// entry is allowed on a large tab and reports "Only for large files." on a normal one.
const commands: CommandEntry[] = [
  // Reached through Ctrl+F on a large tab, so it has no menu item.
  { id: 'large.find', title: 'Find in Large File...', when: 'text', large: 'ok' },
  { id: 'large.findNext', title: 'Find Next', menu: 'Search/Large File', order: 10, accelerator: 'F3', when: 'text', large: 'ok' },
  { id: 'large.findPrev', title: 'Find Previous', menu: 'Search/Large File', order: 20, accelerator: 'Shift+F3', when: 'text', large: 'ok' },
  { id: 'large.count', title: 'Count Matches in Whole File', menu: 'Search/Large File', order: 30, when: 'text', large: 'ok' },
  { id: 'large.goToPercent', title: 'Go to Percent...', menu: 'Search/Large File', order: 40, separatorBefore: true, when: 'text', large: 'ok' },
  { id: 'large.goToStart', title: 'Go to Start of File', menu: 'Search/Large File', order: 50, when: 'text', large: 'ok' },
  { id: 'large.goToEnd', title: 'Go to End of File', menu: 'Search/Large File', order: 60, when: 'text', large: 'ok' }
];

export = commands;
