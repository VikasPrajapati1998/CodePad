// Version History (File menu): save a named version of the active text tab, list its versions newest first, restore
// one as a single undo step (a "Before restore" version is taken first) or compare it in the diff view. The versions
// themselves live in renderer/core/versions.ts (memory only, per tab).
(() => {
  /** The active text tab, or null after saying why in the status bar. */
  function activeText(ctx: CodePadCtx): CodePadTextTab | null {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text' || tab.model.isDisposed()) {
      ctx.status.set('Versions need an active text tab.');
      return null;
    }
    return tab;
  }

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

  /** Replaces the whole text of the tab as one undo step, after keeping the current text as a version. */
  function restore(ctx: CodePadCtx, tab: CodePadTextTab, entry: CodePadVersionEntry): void {
    if (!ctx.tabs.list().includes(tab) || tab.model.isDisposed()) {
      ctx.status.set('The tab was closed; nothing was restored.');
      return;
    }
    CodePadVersions.snapshot(tab, 'Before restore');
    ctx.tabs.activate(tab);
    ctx.text.replaceAll(tab.model, [{ range: tab.model.getFullModelRange(), text: entry.text }], 'Restore version');
    ctx.status.set(`Restored "${entry.label}". Undo (Ctrl+Z) takes it back.`);
  }

  async function compare(ctx: CodePadCtx, tab: CodePadTextTab, entry: CodePadVersionEntry): Promise<void> {
    const time = new Date(entry.time).toLocaleTimeString();
    await ctx.tabs.openView('diff', {
      name: `Compare: ${tab.name} / ${entry.label}`,
      params: { leftTabId: tab.id, rightText: entry.text, rightLabel: `${entry.label} (${time})` },
    });
  }

  function show(ctx: CodePadCtx): void {
    const tab = activeText(ctx);
    if (!tab) {
      return;
    }
    const entries = CodePadVersions.list(tab).reverse();
    const body = element('div', 'cp-versions');
    if (entries.length === 0) {
      body.appendChild(element('p', 'cp-versions-note', `${tab.name} has no saved versions yet. Use File > Save Version, or apply an AI change: a version is taken before each one.`));
    } else {
      body.appendChild(element('p', 'cp-versions-note', 'Versions are kept in memory for this session (at most 30 per tab). Restore replaces the whole text in one undo step.'));
    }
    let handle: CodePadModalHandle | null = null;
    entries.forEach((entry) => {
      const row = element('div', 'cp-versions-item');
      const info = element('div', 'cp-versions-info');
      info.appendChild(element('div', 'cp-versions-label', entry.label));
      info.appendChild(element('div', 'cp-versions-meta', `${new Date(entry.time).toLocaleString()} · ${lineCount(entry.text)} lines · ${entry.text.length} characters`));
      row.appendChild(info);
      const restoreButton = element('button', 'cp-button', 'Restore');
      restoreButton.type = 'button';
      restoreButton.addEventListener('click', () => {
        restore(ctx, tab, entry);
        handle?.close();
      });
      const compareButton = element('button', 'cp-button', 'Compare');
      compareButton.type = 'button';
      compareButton.addEventListener('click', () => {
        handle?.close();
        compare(ctx, tab, entry).catch((error: unknown) => ctx.status.set(`Compare failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      const actions = element('div', 'cp-versions-actions');
      actions.appendChild(restoreButton);
      actions.appendChild(compareButton);
      row.appendChild(actions);
      body.appendChild(row);
    });
    handle = ctx.ui.modal({ title: `Version History: ${tab.name}`, body, buttons: [{ label: 'Close', primary: true }] });
  }

  async function save(ctx: CodePadCtx): Promise<void> {
    const tab = activeText(ctx);
    if (!tab) {
      return;
    }
    const label = await ctx.ui.prompt({
      title: 'Save Version',
      label: `A name for this version of ${tab.name}`,
      value: `Version ${new Date().toLocaleTimeString()}`,
      validate: (value) => (value.trim() === '' ? 'Enter a name.' : null),
    });
    if (label === null) {
      return;
    }
    const newest = CodePadVersions.list(tab).pop();
    if (newest && newest.text === tab.model.getLinesContent().join('\n')) {
      ctx.status.set(`The text equals the newest version ("${newest.label}"), so no new version was saved.`);
      return;
    }
    CodePadVersions.snapshot(tab, label);
    ctx.status.set(`Saved version "${label.trim()}".`);
  }

  CodePadCommands.register({ id: 'versions.save', run: (ctx) => save(ctx) });
  CodePadCommands.register({ id: 'versions.show', run: (ctx) => show(ctx) });
})();
