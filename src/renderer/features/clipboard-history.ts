'use strict';

// Clipboard history: remembers text copied or cut inside the editor (memory only,
// never persisted) and lists it in the bottom panel for re-insertion.
(() => {
  const MAX_ENTRY_CHARS = 100 * 1024;
  const PREVIEW_CHARS = 120;
  const DEFAULT_SIZE = 30;

  let entries: string[] = [];
  let render: (() => void) | null = null;

  const enabled = (ctx: CodePadCtx): boolean => ctx.settings.get('clipboard.historyEnabled') !== false;
  const capacity = (ctx: CodePadCtx): number => ctx.settings.get('clipboard.historySize') || DEFAULT_SIZE;

  function remember(ctx: CodePadCtx, text: string): void {
    if (!text || text.length > MAX_ENTRY_CHARS || !enabled(ctx)) return;
    entries = [text, ...entries.filter((entry) => entry !== text)].slice(0, capacity(ctx));
    if (render) render();
  }

  /** Text Monaco puts on the clipboard for the current selections. */
  function selectedText(ctx: CodePadCtx): string {
    const editor = ctx.editor;
    const model = editor && editor.getModel();
    if (!model) return '';
    const selections = editor.getSelections() || [];
    const eol = model.getEOL();
    if (selections.some((sel) => !sel.isEmpty())) {
      return selections
        .filter((sel) => !sel.isEmpty())
        .map((sel) => model.getValueInRange(sel))
        .join(eol);
    }
    if (!editor.getOption(ctx.monaco.editor.EditorOption.emptySelectionClipboard)) return '';
    const lines = [...new Set(selections.map((sel) => sel.positionLineNumber))];
    return lines.map((line) => model.getLineContent(line)).join(eol) + eol;
  }

  function previewOf(text: string): string {
    const flat = text.replace(/\s*\r?\n\s*/g, ' ↵ ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
  }

  function button(label: string, title: string, onClick: () => unknown): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cp-text-iconbtn';
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return el;
  }

  function createPanel(container: HTMLElement, ctx: CodePadCtx): CodePadPanelInstance {
    container.classList.add('cp-text-clip');
    const toolbar = document.createElement('div');
    toolbar.className = 'cp-text-toolbar';
    const clear = button('Clear all', 'Remove every entry from the clipboard history', () => {
      entries = [];
      draw();
    });
    toolbar.append(clear);
    const list = document.createElement('div');
    list.className = 'cp-text-cliplist';
    container.append(toolbar, list);

    function draw(): void {
      list.textContent = '';
      ctx.panels.setBadge('clipboard', entries.length ? String(entries.length) : '');
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cp-text-empty';
        empty.textContent = enabled(ctx)
          ? 'Nothing copied yet. Text copied or cut in the editor appears here.'
          : 'Clipboard history is turned off in Settings.';
        list.append(empty);
        return;
      }
      for (const text of entries) {
        const row = document.createElement('div');
        row.className = 'cp-text-clipitem';
        row.title = 'Click to insert at the cursor';
        const label = document.createElement('span');
        label.className = 'cp-text-clipitem-text';
        label.textContent = previewOf(text);
        row.append(
          label,
          button('Copy', 'Copy back to the clipboard', () => ctx.clipboard.write(text)),
        );
        row.addEventListener('click', () => {
          ctx.text.insertAtCursors(text);
          if (ctx.editor) ctx.editor.focus();
        });
        list.append(row);
      }
    }

    render = draw;
    draw();
    return {
      onShow: draw,
      dispose() {
        render = null;
      },
    };
  }

  CodePadCommands.register({
    id: 'clipboard.history',
    run: (ctx) => ctx.panels.toggle('clipboard'),
  });

  CodePadFeatures.register('clipboard-history', {
    init(ctx) {
      ctx.panels.register({
        id: 'clipboard',
        title: 'Clipboard',
        location: 'bottom',
        order: 30,
        render: (container) => createPanel(container, ctx),
      });

      // Capture phase so the text is read before Monaco handles the event.
      const onClip = (): void => remember(ctx, selectedText(ctx));
      const dom = ctx.editor.getContainerDomNode();
      dom.addEventListener('copy', onClip, true);
      dom.addEventListener('cut', onClip, true);

      ctx.events.on('settings:changed', ({ key }) => {
        if (key !== 'clipboard.historySize' && key !== 'clipboard.historyEnabled') return;
        if (!enabled(ctx)) entries = [];
        else entries = entries.slice(0, capacity(ctx));
        if (render) render();
      });
    },
  });
})();
