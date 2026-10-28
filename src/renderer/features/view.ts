(function () {
  'use strict';

  // View commands: show-symbol toggles, end-of-line markers, font size,
  // distraction-free mode, always-on-top, summary, panel switches and the
  // per-language tab size. Editor options themselves are applied by app.ts
  // from the settings schema; this module only flips the settings.

  const EOL_MARKER_MAX_LINES = 200000;
  const EOL_MARKER_MARGIN_LINES = 200;
  const EOL_REFRESH_DELAY_MS = 50;
  const FONT_SIZE_MIN = 6;
  const FONT_SIZE_MAX = 72;
  const FONT_SIZE_DEFAULT = 14;
  const CJK_ENCODINGS = new Set(['shift_jis', 'euc-jp', 'gbk', 'gb18030', 'big5', 'euc-kr']);

  type BooleanSettingKey = { [K in SettingKey]: SettingsValues[K] extends boolean ? K : never }[SettingKey];

  interface ByteEstimate {
    bytes: number;
    exact: boolean;
  }

  let appCtx: CodePadCtx | null = null;
  let eolCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  let eolTimer: number | undefined;
  let zenState: { wasFullScreen: boolean } | null = null;
  let alwaysOnTop = false;
  const sizedModels = new WeakSet<monaco.editor.ITextModel>();
  const watchedModels = new WeakSet<monaco.editor.ITextModel>();

  function setting<K extends SettingKey>(ctx: CodePadCtx, key: K): SettingsValues[K] {
    return ctx.settings.get(key);
  }

  function toggleSetting(ctx: CodePadCtx, key: BooleanSettingKey): void {
    ctx.settings.set(key, !setting(ctx, key));
  }

  // ---- End-of-line markers ----

  function eolLabel(tab: CodePadTextTab | null, model: monaco.editor.ITextModel): string {
    if (tab && tab.eol === 'cr') {
      return 'CR';
    }
    return model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  }

  function clearEolMarkers(): void {
    if (eolCollection) {
      eolCollection.clear();
    }
  }

  function refreshEolMarkers(): void {
    const ctx = appCtx;
    if (!ctx) {
      return;
    }
    const editor = ctx.editor;
    const model = editor.getModel();
    const tab = ctx.tabs.active();
    if (!setting(ctx, 'editor.showEol') || !model || !tab || tab.kind !== 'text'
        || model.getLineCount() > EOL_MARKER_MAX_LINES) {
      clearEolMarkers();
      return;
    }
    if (!eolCollection) {
      eolCollection = editor.createDecorationsCollection([]);
    }
    const lineCount = model.getLineCount();
    const label = eolLabel(tab, model);
    const lines = new Set<number>();
    editor.getVisibleRanges().forEach((range) => {
      const first = Math.max(1, range.startLineNumber - EOL_MARKER_MARGIN_LINES);
      const last = Math.min(lineCount - 1, range.endLineNumber + EOL_MARKER_MARGIN_LINES);
      for (let line = first; line <= last; line++) {
        lines.add(line);
      }
    });
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    lines.forEach((line) => {
      const column = model.getLineMaxColumn(line);
      decorations.push({
        range: new ctx.monaco.Range(line, column, line, column),
        options: { after: { content: label, inlineClassName: 'cp-view-eol' } }
      });
    });
    eolCollection.set(decorations);
  }

  function scheduleEolRefresh(): void {
    clearTimeout(eolTimer);
    eolTimer = setTimeout(refreshEolMarkers, EOL_REFRESH_DELAY_MS);
  }

  // ---- Per-language tab size ----

  function applyTabSize(ctx: CodePadCtx, model: monaco.editor.ITextModel): void {
    const overrides = setting(ctx, 'editor.tabSizeByLanguage') || {};
    const size = overrides[model.getLanguageId()];
    if (size) {
      model.updateOptions({ tabSize: size });
      sizedModels.add(model);
    } else if (sizedModels.has(model)) {
      model.updateOptions({ tabSize: setting(ctx, 'editor.tabSize') });
      sizedModels.delete(model);
    }
  }

  function watchModel(ctx: CodePadCtx, model: monaco.editor.ITextModel): void {
    if (watchedModels.has(model)) {
      return;
    }
    watchedModels.add(model);
    model.onDidChangeLanguage(() => applyTabSize(ctx, model));
  }

  function applyTabSizeToTab(ctx: CodePadCtx, tab: CodePadTab | null): void {
    if (tab && tab.kind === 'text') {
      watchModel(ctx, tab.model);
      applyTabSize(ctx, tab.model);
    }
  }

  // ---- Summary ----

  function estimateBytes(text: string, encoding: string): ByteEstimate {
    if (encoding === 'utf8') {
      return { bytes: new TextEncoder().encode(text).length, exact: true };
    }
    if (encoding === 'utf8bom') {
      return { bytes: new TextEncoder().encode(text).length + 3, exact: true };
    }
    if (encoding === 'utf16le' || encoding === 'utf16be') {
      return { bytes: text.length * 2 + 2, exact: true };
    }
    const wide = CJK_ENCODINGS.has(encoding) ? 2 : 1;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      bytes += text.charCodeAt(i) < 128 ? 1 : wide;
    }
    return { bytes, exact: false };
  }

  function countWords(text: string): number {
    const matches = text.match(/\S+/g);
    return matches ? matches.length : 0;
  }

  function summaryText(ctx: CodePadCtx, tab: CodePadTextTab): string {
    const model = tab.model;
    const text = model.getValue();
    const eolLength = model.getEOL().length;
    const lines = model.getLineCount();
    const noEol = text.length - (lines - 1) * eolLength;
    const size = estimateBytes(text, tab.encoding || 'utf8');
    const rows: [string, string][] = [
      ['File', tab.path || tab.name],
      ['Encoding', tab.encoding || 'utf8'],
      ['Line ending', eolLabel(tab, model)],
      ['Characters', String(text.length)],
      ['Characters (no line endings)', String(noEol)],
      ['Words', String(countWords(text))],
      ['Lines', String(lines)],
      ['Bytes', `${size.bytes}${size.exact ? '' : ' (estimated)'}`]
    ];
    const selected = (ctx.editor.getSelections() || [])
      .map((selection) => model.getValueInRange(selection))
      .filter((part) => part.length > 0);
    if (selected.length > 0) {
      const joined = selected.join('');
      rows.push(['Selection characters', String(joined.length)]);
      rows.push(['Selection words', String(countWords(joined))]);
      rows.push(['Selection lines', String(selected.reduce((sum, part) => sum + part.split(/\r\n|\r|\n/).length, 0))]);
    }
    return rows.map(([name, value]) => `${name}: ${value}`).join('\n');
  }

  function showSummary(ctx: CodePadCtx): void {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text') {
      return;
    }
    const title = `Summary - ${tab.name}`;
    const text = summaryText(ctx, tab);
    if (typeof ctx.ui.output === 'function') {
      ctx.ui.output(title, text);
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'cp-view-summary';
    pre.textContent = text;
    ctx.ui.modal({ title, body: pre, buttons: [{ label: 'Close' }] });
  }

  // ---- Distraction free, always on top ----

  function onZenKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && zenState && !event.defaultPrevented) {
      exitZen();
    }
  }

  function enterZen(ctx: CodePadCtx): void {
    zenState = { wasFullScreen: window.outerHeight >= window.screen.height && window.outerWidth >= window.screen.width };
    document.body.classList.add('zen');
    window.codepad.window.setFullScreen(true);
    document.addEventListener('keydown', onZenKey);
    ctx.editor.layout();
  }

  function exitZen(): void {
    const state = zenState;
    zenState = null;
    document.removeEventListener('keydown', onZenKey);
    document.body.classList.remove('zen');
    if (state && !state.wasFullScreen) {
      window.codepad.window.setFullScreen(false);
    }
    if (appCtx) {
      appCtx.editor.layout();
    }
  }

  function toggleZen(ctx: CodePadCtx): void {
    if (zenState) {
      exitZen();
    } else {
      enterZen(ctx);
    }
  }

  function toggleAlwaysOnTop(ctx: CodePadCtx): void {
    alwaysOnTop = !alwaysOnTop;
    window.codepad.window.setAlwaysOnTop(alwaysOnTop);
    ctx.status.set(alwaysOnTop ? 'Always on top: on' : 'Always on top: off');
  }

  // ---- Panels ----

  function toggleBottomPanel(ctx: CodePadCtx): void {
    const id = setting(ctx, 'ui.activeBottom') || 'results';
    if (setting(ctx, 'ui.bottomPanel')) {
      ctx.panels.hide(id);
    } else {
      ctx.panels.show(id, { focus: true });
    }
  }

  // ---- Font size ----

  function changeFontSize(ctx: CodePadCtx, delta: number): void {
    const current = setting(ctx, 'editor.fontSize');
    const next = delta === 0 ? FONT_SIZE_DEFAULT : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + delta));
    ctx.settings.set('editor.fontSize', next);
    ctx.status.set(`Editor font size: ${next}`);
  }

  // ---- Show-symbol toggles ----

  function toggleWhitespace(ctx: CodePadCtx): void {
    ctx.settings.set('editor.renderWhitespace', setting(ctx, 'editor.renderWhitespace') === 'all' ? 'selection' : 'all');
  }

  function toggleAllSymbols(ctx: CodePadCtx): void {
    const allOn = setting(ctx, 'editor.renderWhitespace') === 'all'
      && setting(ctx, 'editor.showEol')
      && setting(ctx, 'editor.renderControlCharacters');
    ctx.settings.patch({
      'editor.renderWhitespace': allOn ? 'selection' : 'all',
      'editor.showEol': !allOn,
      'editor.renderControlCharacters': !allOn
    });
  }

  function toggleWrapIndentation(ctx: CodePadCtx): void {
    ctx.settings.set('editor.wrapIndicator', setting(ctx, 'editor.wrapIndicator') === 'indent' ? 'same' : 'indent');
  }

  const COMMANDS: Record<string, (ctx: CodePadCtx) => void> = {
    'view.toggleWhitespace': toggleWhitespace,
    'view.toggleEol': (ctx) => toggleSetting(ctx, 'editor.showEol'),
    'view.toggleControlChars': (ctx) => toggleSetting(ctx, 'editor.renderControlCharacters'),
    'view.showAllSymbols': toggleAllSymbols,
    'view.toggleIndentGuides': (ctx) => toggleSetting(ctx, 'editor.indentGuides'),
    'view.toggleWrapSymbol': toggleWrapIndentation,
    'view.zoomIn': (ctx) => changeFontSize(ctx, 1),
    'view.zoomOut': (ctx) => changeFontSize(ctx, -1),
    'view.zoomReset': (ctx) => changeFontSize(ctx, 0),
    'view.showExplorer': (ctx) => ctx.panels.show('explorer', { focus: true }),
    'view.showDocuments': (ctx) => ctx.panels.show('documents', { focus: true }),
    'view.toggleBottomPanel': toggleBottomPanel,
    'view.summary': showSummary,
    'view.zen': toggleZen,
    'view.alwaysOnTop': toggleAlwaysOnTop
  };

  Object.keys(COMMANDS).forEach((id) => {
    CodePadCommands.register({ id, run: COMMANDS[id] });
  });

  CodePadFeatures.register('view', {
    init(ctx) {
      appCtx = ctx;
      const editor = ctx.editor;
      editor.onDidScrollChange(scheduleEolRefresh);
      editor.onDidChangeModelContent(scheduleEolRefresh);
      ctx.events.on('tab:activated', (tab) => {
        applyTabSizeToTab(ctx, tab);
        scheduleEolRefresh();
      });
      ctx.events.on('tab:created', (tab) => applyTabSizeToTab(ctx, tab));
      ctx.events.on('tab:restored', (tab) => applyTabSizeToTab(ctx, tab));
      ctx.events.on('tab:reloaded', scheduleEolRefresh);
      ctx.settings.onChange(({ key }) => {
        if (key === 'editor.showEol') {
          scheduleEolRefresh();
        } else if (key === 'editor.tabSizeByLanguage' || key === 'editor.tabSize') {
          ctx.tabs.list().forEach((tab) => applyTabSizeToTab(ctx, tab));
        }
      });
      ctx.tabs.list().forEach((tab) => applyTabSizeToTab(ctx, tab));
      scheduleEolRefresh();
    }
  });
})();
