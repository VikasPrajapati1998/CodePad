(() => {
  /*
   * Markdown Read Mode: a markdown text tab in Read Mode (persist.readOnly) shows a rendered preview in place of the
   * Monaco editor; Edit Mode shows the source as before. The tree comes from shared/markdown.ts and is turned into DOM
   * with createElement and textContent only, never innerHTML. Links are limited to http, https and mailto and open
   * through the window-open handler of main (native confirmation). CSS: markdown-preview.css (body[data-md-preview]).
   */
  const RENDER_DELAY_MS = 150;
  const NOTE_TRUNCATED = 'The preview shows only the first part of this large file. Switch to Edit Mode to see all of it.';

  function appendInline(nodes: readonly CodePadMdInline[], parent: Node): void {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          parent.appendChild(document.createTextNode(node.value));
          break;
        case 'em':
        case 'strong':
        case 'del': {
          const element = document.createElement(node.type);
          appendInline(node.children, element);
          parent.appendChild(element);
          break;
        }
        case 'code': {
          const code = document.createElement('code');
          code.textContent = node.value;
          parent.appendChild(code);
          break;
        }
        case 'link': {
          const href = CodePadMarkdown.safeHref(node.href);
          if (href === null) {
            appendInline(node.children, parent);
            break;
          }
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.rel = 'noreferrer noopener';
          anchor.target = '_blank';
          anchor.title = href;
          appendInline(node.children, anchor);
          parent.appendChild(anchor);
          break;
        }
        case 'image': {
          const alt = document.createElement('span');
          alt.className = 'cp-md-image';
          alt.textContent = node.alt;
          parent.appendChild(alt);
          break;
        }
        case 'br':
          parent.appendChild(document.createElement('br'));
          break;
      }
    }
  }

  function tableCell(tag: 'th' | 'td', content: readonly CodePadMdInline[], align: CodePadMdAlign): HTMLElement {
    const cell = document.createElement(tag);
    if (align !== null) {
      cell.style.textAlign = align;
    }
    appendInline(content, cell);
    return cell;
  }

  function appendBlocks(blocks: readonly CodePadMdBlock[], parent: Node): void {
    for (const block of blocks) {
      switch (block.type) {
        case 'heading': {
          const heading = document.createElement(`h${Math.min(Math.max(block.level, 1), 6)}`);
          appendInline(block.children, heading);
          parent.appendChild(heading);
          break;
        }
        case 'paragraph': {
          const paragraph = document.createElement('p');
          appendInline(block.children, paragraph);
          parent.appendChild(paragraph);
          break;
        }
        case 'code': {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = block.value;
          if (block.lang !== '') {
            pre.dataset.lang = block.lang;
          }
          pre.appendChild(code);
          parent.appendChild(pre);
          break;
        }
        case 'quote': {
          const quote = document.createElement('blockquote');
          appendBlocks(block.children, quote);
          parent.appendChild(quote);
          break;
        }
        case 'list': {
          const list = block.ordered ? document.createElement('ol') : document.createElement('ul');
          if (list instanceof HTMLOListElement && block.start !== 1) {
            list.start = block.start;
          }
          for (const item of block.items) {
            const entry = document.createElement('li');
            if (item.checked !== null) {
              const box = document.createElement('input');
              box.type = 'checkbox';
              box.checked = item.checked;
              box.disabled = true;
              entry.className = 'cp-md-task';
              entry.appendChild(box);
            }
            appendBlocks(item.children, entry);
            list.appendChild(entry);
          }
          parent.appendChild(list);
          break;
        }
        case 'table': {
          const wrap = document.createElement('div');
          wrap.className = 'cp-md-table-wrap';
          const table = document.createElement('table');
          const headRow = table.createTHead().insertRow();
          block.header.forEach((cell, column) => headRow.appendChild(tableCell('th', cell, block.align[column])));
          const body = table.createTBody();
          for (const row of block.rows) {
            const bodyRow = body.insertRow();
            row.forEach((cell, column) => bodyRow.appendChild(tableCell('td', cell, block.align[column])));
          }
          wrap.appendChild(table);
          parent.appendChild(wrap);
          break;
        }
        case 'rule':
          parent.appendChild(document.createElement('hr'));
          break;
      }
    }
  }

  CodePadFeatures.register('markdown-preview', {
    init(ctx) {
      const editorEl = document.getElementById('editor');
      if (!editorEl) {
        throw new Error('The editor container is missing.');
      }
      const preview = document.createElement('div');
      preview.id = 'md-preview';
      preview.tabIndex = 0;
      preview.setAttribute('role', 'document');
      preview.setAttribute('aria-label', 'Markdown preview');
      editorEl.after(preview);

      /** The tab whose preview is on screen. */
      let shown: CodePadTextTab | null = null;
      /** The tab whose model is being watched for content and language changes. */
      let tracked: { tab: CodePadTextTab; subscriptions: monaco.IDisposable[] } | null = null;
      let timer: number | undefined;
      const scrolls = new WeakMap<CodePadTab, number>();

      const wanted = (tab: CodePadTab | null): tab is CodePadTextTab =>
        tab !== null
        && tab.kind === 'text'
        && tab.persist.readOnly
        && !tab.model.isDisposed()
        && tab.model.getLanguageId() === 'markdown';

      function render(tab: CodePadTextTab, scrollTop: number): void {
        const source = tab.model.getValue();
        const fragment = document.createDocumentFragment();
        appendBlocks(CodePadMarkdown.parse(source), fragment);
        if (source.length > CodePadMarkdown.MAX_INPUT) {
          const note = document.createElement('p');
          note.className = 'cp-md-note';
          note.textContent = NOTE_TRUNCATED;
          fragment.appendChild(note);
        }
        preview.replaceChildren(fragment);
        preview.scrollTop = scrollTop;
      }

      /** Shows, refreshes or hides the preview according to the active tab and its mode. */
      function update(): void {
        const tab = ctx.tabs.active();
        if (shown && shown !== tab) {
          scrolls.set(shown, preview.scrollTop);
        }
        if (wanted(tab)) {
          render(tab, shown === tab ? preview.scrollTop : (scrolls.get(tab) ?? 0));
          shown = tab;
          document.body.dataset.mdPreview = 'on';
        } else if (shown) {
          shown = null;
          delete document.body.dataset.mdPreview;
          preview.replaceChildren();
          ctx.editor.layout();
        }
      }

      function schedule(): void {
        window.clearTimeout(timer);
        timer = window.setTimeout(update, RENDER_DELAY_MS);
      }

      /** Follows the content and language of the active text tab. */
      function track(tab: CodePadTab | null): void {
        const target = tab !== null && tab.kind === 'text' ? tab : null;
        if (tracked && tracked.tab === target) {
          return;
        }
        tracked?.subscriptions.forEach((subscription) => subscription.dispose());
        tracked = target
          ? { tab: target, subscriptions: [target.model.onDidChangeContent(schedule), target.model.onDidChangeLanguage(schedule)] }
          : null;
      }

      function refresh(): void {
        window.clearTimeout(timer);
        track(ctx.tabs.active());
        update();
      }

      ctx.events.on('tab:activated', refresh);
      ctx.events.on('tab:modeChanged', refresh);
      refresh();
    },
  });
})();
