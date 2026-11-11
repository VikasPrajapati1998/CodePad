/**
 * Version history of text tabs, kept in memory for the session. Snapshots hold the LF text, the time and a label;
 * each tab keeps at most MAX_VERSIONS (oldest dropped first), and a snapshot equal to the newest one is skipped.
 * Every AI apply in the chat takes one first ("Before AI: ..."); features/versions.ts shows and restores them.
 * Keyed by the tab's Monaco model, so a closed tab's versions are garbage collected with it.
 */
(() => {
  const MAX_VERSIONS = 30;
  const MAX_LABEL_CHARS = 120;

  const store = new WeakMap<monaco.editor.ITextModel, CodePadVersionEntry[]>();
  let nextId = 1;

  /** The model text with LF line breaks (no Monaco namespace needed). */
  const lfText = (model: monaco.editor.ITextModel): string => model.getLinesContent().join('\n');

  /**
   * Stores the current text of a tab as a version.
   * @param tab The text tab.
   * @param label What the version is ("Before AI: shorten", "Before restore", a name the user typed).
   */
  function snapshot(tab: CodePadTextTab, label: string): void {
    if (tab.model.isDisposed()) {
      return;
    }
    const text = lfText(tab.model);
    const entries = store.get(tab.model) ?? [];
    const newest = entries[entries.length - 1];
    if (newest && newest.text === text) {
      return;
    }
    entries.push({ id: nextId, label: (label.trim() || 'Version').slice(0, MAX_LABEL_CHARS), time: Date.now(), text });
    nextId += 1;
    if (entries.length > MAX_VERSIONS) {
      entries.splice(0, entries.length - MAX_VERSIONS);
    }
    store.set(tab.model, entries);
  }

  /** The versions of a tab, oldest first (copies, so callers cannot change the history). */
  function list(tab: CodePadTextTab): CodePadVersionEntry[] {
    return (store.get(tab.model) ?? []).map((entry) => ({ ...entry }));
  }

  window.CodePadVersions = Object.freeze({ snapshot, list });
})();
