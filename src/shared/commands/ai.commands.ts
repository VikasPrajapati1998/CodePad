// AI menu: ghost-text suggestions, word suggestions, summaries and the local model. Loaded by the main process
// (menuBuilder.ts) only; the matching run() handlers are registered by renderer/features/{ai-suggest,autosuggest,
// ai-summary,ai-model}.ts.
const commands: CommandEntry[] = [
  { id: 'ai.toggleSuggestions', title: 'AI Suggestions (Ghost Text)', menu: 'AI', order: 10, when: 'any', checkedSetting: 'ai.enabled' },
  { id: 'suggest.toggleDropdown', title: 'Word Suggestions While Typing', menu: 'AI', order: 20, when: 'any', checkedSetting: 'editor.autoSuggest' },
  { id: 'ai.suggestNow', title: 'Suggest Now', menu: 'AI', order: 30, when: 'text' },

  { id: 'ai.summarizeFile', title: 'Summarize Current File', menu: 'AI', order: 100, separatorBefore: true, accelerator: 'CmdOrCtrl+Shift+J', when: 'any' },
  { id: 'ai.summarizeSelection', title: 'Summarize Selection', menu: 'AI', order: 110, when: 'text' },
  { id: 'ai.cancelSummary', title: 'Cancel Summary', menu: 'AI', order: 120, when: 'any' },
  { id: 'ai.clearSummaryCache', title: 'Clear Summary Cache', menu: 'AI', order: 140, when: 'any' },

  { id: 'ai.checkGrammar', title: 'Check Grammar and Spelling with AI...', menu: 'AI', order: 145, separatorBefore: true, when: 'text' },
  { id: 'ai.rewrite', title: 'Rewrite / Restructure with AI...', menu: 'AI', order: 146, when: 'text' },

  { id: 'ai.chat', title: 'AI Chat Assistant...', menu: 'AI', order: 147, when: 'any' },

  { id: 'ai.manageModels', title: 'Manage Models...', menu: 'AI', order: 150, when: 'any' },

  { id: 'ai.downloadModel', title: 'Download AI Model', menu: 'AI', order: 200, separatorBefore: true, when: 'any' },
  { id: 'ai.deleteModel', title: 'Delete AI Model...', menu: 'AI', order: 210, when: 'any' },
  { id: 'ai.showStatus', title: 'AI Model Status...', menu: 'AI', order: 220, when: 'any' }
];

export = commands;
