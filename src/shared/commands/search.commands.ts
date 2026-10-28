/* Search menu commands (A2). Table format: see the design, section B.2. Handlers live in renderer/features/. */
const commands: CommandEntry[] = [
  { id: 'search.findInFiles', title: 'Find in Files...', menu: 'Search', order: 10, accelerator: 'CmdOrCtrl+Shift+F', when: 'any' },
  { id: 'search.findInTabs', title: 'Find All in Open Tabs', menu: 'Search', order: 20, when: 'any' },
  { id: 'search.findInCurrent', title: 'Find All in Current Tab', menu: 'Search', order: 30 },
  { id: 'search.count', title: 'Count Matches in Current Tab', menu: 'Search', order: 40 },
  { id: 'search.replaceInTabs', title: 'Replace in Open Tabs...', menu: 'Search', order: 50, when: 'any' },
  { id: 'search.toggleResults', title: 'Toggle Search Results', menu: 'Search', order: 60, separatorBefore: true, accelerator: 'F7', when: 'any' },
  { id: 'search.nextResult', title: 'Next Search Result', menu: 'Search', order: 70, accelerator: 'F4', when: 'any' },
  { id: 'search.prevResult', title: 'Previous Search Result', menu: 'Search', order: 80, accelerator: 'Shift+F4', when: 'any' },
  { id: 'search.gotoOffset', title: 'Go to Offset...', menu: 'Search', order: 90, separatorBefore: true },
  { id: 'search.selectBetweenBrackets', title: 'Select Between Brackets', menu: 'Search', order: 100 },
  { id: 'search.findNonAscii', title: 'Find Non-ASCII Characters', menu: 'Search', order: 110 },

  { id: 'mark.style1', title: 'Mark Selection or Word (Style 1)', menu: 'Search/Mark', order: 10, accelerator: 'CmdOrCtrl+Shift+M' },
  { id: 'mark.style2', title: 'Mark Selection or Word (Style 2)', menu: 'Search/Mark', order: 20 },
  { id: 'mark.style3', title: 'Mark Selection or Word (Style 3)', menu: 'Search/Mark', order: 30 },
  { id: 'mark.style4', title: 'Mark Selection or Word (Style 4)', menu: 'Search/Mark', order: 40 },
  { id: 'mark.style5', title: 'Mark Selection or Word (Style 5)', menu: 'Search/Mark', order: 50 },
  { id: 'mark.fromFind', title: 'Mark All Matches of Find Text', menu: 'Search/Mark', order: 60, separatorBefore: true },
  { id: 'mark.next', title: 'Next Mark', menu: 'Search/Mark', order: 70, separatorBefore: true },
  { id: 'mark.prev', title: 'Previous Mark', menu: 'Search/Mark', order: 80 },
  { id: 'mark.clear', title: 'Clear All Marks', menu: 'Search/Mark', order: 90, separatorBefore: true },

  { id: 'bookmark.toggle', title: 'Toggle Bookmark', menu: 'Search/Bookmark', order: 10, accelerator: 'Alt+F2' },
  { id: 'bookmark.next', title: 'Next Bookmark', menu: 'Search/Bookmark', order: 20, accelerator: 'Alt+F3' },
  { id: 'bookmark.prev', title: 'Previous Bookmark', menu: 'Search/Bookmark', order: 30, accelerator: 'Alt+Shift+F3' },
  { id: 'bookmark.clearAll', title: 'Clear All Bookmarks', menu: 'Search/Bookmark', order: 40 },
  { id: 'bookmark.cutLines', title: 'Cut Bookmarked Lines', menu: 'Search/Bookmark', order: 50, separatorBefore: true },
  { id: 'bookmark.copyLines', title: 'Copy Bookmarked Lines', menu: 'Search/Bookmark', order: 60 },
  { id: 'bookmark.pasteLines', title: 'Replace Bookmarked Lines with Clipboard', menu: 'Search/Bookmark', order: 70 },
  { id: 'bookmark.deleteLines', title: 'Delete Bookmarked Lines', menu: 'Search/Bookmark', order: 80 },
  { id: 'bookmark.deleteUnmarked', title: 'Delete Unbookmarked Lines', menu: 'Search/Bookmark', order: 90 },
  { id: 'bookmark.inverse', title: 'Inverse Bookmarks', menu: 'Search/Bookmark', order: 100 }
];

export = commands;
