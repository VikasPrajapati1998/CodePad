(function () {
  'use strict';

  // Encoding picker, reopen/convert, default encoding and line-ending
  // conversion, plus the status bar encoding and EOL buttons.

  const EOL_LABELS: Record<CodePadEol, string> = { lf: 'LF', crlf: 'CRLF', cr: 'CR' };
  const EOL_CHOICES: CodePadEol[] = ['lf', 'crlf', 'cr'];

  let encodingList: readonly CpEncodingInfo[] | null = null;

  /**
   * Load (once) the encodings supported by the main process.
   */
  async function loadEncodings(): Promise<readonly CpEncodingInfo[]> {
    if (!encodingList) {
      encodingList = await window.codepad.encodings.list();
    }
    return encodingList;
  }

  function encodingLabel(id: string): string {
    const entry = (encodingList || []).find((item) => item.id === id);
    return entry ? entry.label : id;
  }

  /**
   * Let the user choose an encoding. Items are grouped by label detail.
   * @param ctx Feature context.
   * @param title Dialog title.
   * @param current Encoding id to flag as current.
   * @returns Chosen id, or null if cancelled.
   */
  async function pickEncoding(ctx: CodePadCtx, title: string, current: string | undefined): Promise<string | null> {
    const list = await loadEncodings();
    return ctx.ui.pick({
      title,
      items: list.map((item) => ({
        label: item.label,
        detail: item.id === current ? `${item.group} (current)` : item.group,
        value: item.id
      }))
    });
  }

  function activeTextTab(ctx: CodePadCtx): CodePadTextTab | null {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text') {
      ctx.status.set('Not available for this file type.');
      return null;
    }
    return tab;
  }

  function statusElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing status bar element #${id}`);
    }
    return element;
  }

  function refreshStatus(tab: CodePadTextTab): void {
    const model = tab.model;
    const eol = tab.eol || (model.getEOL() === '\r\n' ? 'crlf' : 'lf');
    statusElement('status-eol').textContent = EOL_LABELS[eol];
    statusElement('status-encoding').textContent = encodingLabel(tab.encoding);
  }

  // ---- Reopen / convert ----

  async function reopenWith(ctx: CodePadCtx): Promise<void> {
    const tab = activeTextTab(ctx);
    if (!tab) {
      return;
    }
    if (!tab.path) {
      ctx.status.set('Save the file first: only files on disk can be reopened with another encoding.');
      return;
    }
    const encoding = await pickEncoding(ctx, 'Reopen with Encoding', tab.encoding);
    if (!encoding) {
      return;
    }
    const probe = await ctx.files.readText(tab.path, { encoding });
    if (probe.binary || probe.tooLarge) {
      ctx.status.set('This file cannot be reopened as text.');
      return;
    }
    if (probe.replaced) {
      const choice = await ctx.ui.confirm({
        title: 'Reopen with Encoding',
        message: `Some bytes are not valid ${encodingLabel(encoding)}; they would be shown as replacement characters (U+FFFD). Reopen anyway?`,
        buttons: ['Reopen', 'Cancel']
      });
      if (choice !== 0) {
        return;
      }
    }
    if (await ctx.tabs.reload(tab, { encoding })) {
      refreshStatus(tab);
      ctx.status.set(`Reopened ${tab.name} as ${encodingLabel(encoding)}`);
    }
  }

  async function convertTo(ctx: CodePadCtx): Promise<void> {
    const tab = activeTextTab(ctx);
    if (!tab) {
      return;
    }
    const encoding = await pickEncoding(ctx, 'Convert to Encoding', tab.encoding);
    if (!encoding || encoding === tab.encoding) {
      return;
    }
    const check = await window.codepad.encodings.check(tab.model.getValue(), encoding);
    if (check.lossy) {
      const shown = check.badChar ? ` (first: "${check.badChar}")` : '';
      const choice = await ctx.ui.confirm({
        title: 'Convert to Encoding',
        message: `${encodingLabel(encoding)} cannot represent ${check.count} character(s)${shown}. `
          + 'Saving will ask before replacing them with "?". Convert anyway?',
        buttons: ['Convert', 'Cancel']
      });
      if (choice !== 0) {
        return;
      }
    }
    tab.encoding = encoding;
    ctx.tabs.forceDirty(tab);
    ctx.tabs.changed();
    refreshStatus(tab);
    ctx.status.set(`Encoding set to ${encodingLabel(encoding)}; save to write the file.`);
  }

  async function setDefault(ctx: CodePadCtx): Promise<void> {
    const encoding = await pickEncoding(ctx, 'Default Encoding for New Files', ctx.settings.get('files.defaultEncoding'));
    if (encoding) {
      ctx.settings.set('files.defaultEncoding', encoding);
      ctx.status.set(`Default encoding: ${encodingLabel(encoding)}`);
    }
  }

  // ---- End of line ----

  function convertEol(ctx: CodePadCtx, target: CodePadEol): void {
    const tab = activeTextTab(ctx);
    if (!tab) {
      return;
    }
    if (tab.persist && tab.persist.readOnly) {
      ctx.status.set('This tab is read-only.');
      return;
    }
    const sequence = target === 'crlf'
      ? ctx.monaco.editor.EndOfLineSequence.CRLF
      : ctx.monaco.editor.EndOfLineSequence.LF;
    const before = tab.eol || (tab.model.getEOL() === '\r\n' ? 'crlf' : 'lf');
    tab.model.pushEOL(sequence);
    tab.eol = target;
    if (before !== target) {
      ctx.tabs.forceDirty(tab);
    }
    ctx.tabs.changed();
    refreshStatus(tab);
    ctx.status.set(`Line endings: ${EOL_LABELS[target]}`);
  }

  // ---- Status bar buttons ----

  function openEolMenu(ctx: CodePadCtx, event: MouseEvent): void {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text') {
      return;
    }
    const current = tab.eol || (tab.model.getEOL() === '\r\n' ? 'crlf' : 'lf');
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    ctx.ui.contextMenu(rect.left, rect.top, EOL_CHOICES.map((eol) => ({
      label: EOL_LABELS[eol],
      checked: eol === current,
      run: () => convertEol(ctx, eol)
    })));
  }

  function openEncodingMenu(ctx: CodePadCtx, event: MouseEvent): void {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text') {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    ctx.ui.contextMenu(rect.left, rect.top, [
      { label: 'Reopen with Encoding...', run: () => reopenWith(ctx) },
      { label: 'Convert to Encoding...', run: () => convertTo(ctx) },
      { separator: true },
      { label: 'Set Default Encoding...', run: () => setDefault(ctx) }
    ]);
  }

  CodePadCommands.register({ id: 'enc.reopenWith', run: reopenWith });
  CodePadCommands.register({ id: 'enc.convertTo', run: convertTo });
  CodePadCommands.register({ id: 'enc.setDefault', run: setDefault });
  CodePadCommands.register({ id: 'enc.eolLf', run: (ctx) => convertEol(ctx, 'lf') });
  CodePadCommands.register({ id: 'enc.eolCrlf', run: (ctx) => convertEol(ctx, 'crlf') });
  CodePadCommands.register({ id: 'enc.eolCr', run: (ctx) => convertEol(ctx, 'cr') });

  CodePadFeatures.register('encoding', {
    init(ctx) {
      loadEncodings().catch((error: Error) => ctx.status.set(`Could not load encodings: ${error.message}`));
      statusElement('status-encoding').addEventListener('click', (event) => openEncodingMenu(ctx, event));
      statusElement('status-eol').addEventListener('click', (event) => openEolMenu(ctx, event));
    }
  });
})();
