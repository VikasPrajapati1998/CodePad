// Tools of the AI chat assistant. Each kind of operation is one self-contained tool registered in
// window.CodePadChatTools; features/ai-chat.ts (the window) parses the sentence and runs the tool whose id equals the
// parsed action, handing it a `services` object (messages, cards, tab lookup, the AI request). A tool that changes
// anything first shows a proposal card (before/after or the exact file name) and acts only when the user clicks Apply;
// nothing is overwritten. All dynamic text is set with textContent.
(() => {
  const READ_LINES = 40;
  const LIST_LINES = 200;
  const FIND_DEPTH = 3;
  const FIND_MAX_DIRS = 300;
  const NO_CHANGE_HINT =
    'The AI proposed no changes. The built-in Qwen3 model is small and often ignores such instructions; a larger model in AI > Manage Models follows them better.';

  const registry = new Map<string, CodePadChatTool>();

  // ---- helpers ------------------------------------------------------------------------------

  /** A file name without path characters; adds `fallbackExt` when it has no extension. */
  function cleanName(name: string, fallbackExt: string): string {
    const base = CodePadSearchCore.displayName(name).replace(/[\\/:*?"<>|\r\n]+/g, '').trim().replace(/[. ]+$/, '');
    if (!base) {
      return '';
    }
    return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${base}${fallbackExt}`;
  }

  const extensionOf = (name: string): string => /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  const stemOf = (name: string): string => name.replace(/\.[^.]*$/, '');
  const dirOf = (filePath: string): string => filePath.replace(/[\\/][^\\/]*$/, '');

  function joinPath(dir: string, name: string): string {
    const separator = dir.includes('\\') ? '\\' : '/';
    return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${separator}${name}`;
  }

  /** Strips a code fence the model may have wrapped around the whole answer. */
  function unfence(text: string): string {
    const match = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);
    return match ? match[1] : text;
  }

  /** The tab text with the file's own line breaks (what a copy of the file should contain). */
  function textWithEol(s: CodePadChatServices, tab: CodePadTextTab): string {
    const text = s.lfText(tab);
    if (tab.eol === 'crlf') {
      return text.replace(/\n/g, '\r\n');
    }
    return tab.eol === 'cr' ? text.replace(/\n/g, '\r') : text;
  }

  /** A file called `name` in the opened folder (up to a few levels deep, hidden folders and node_modules skipped). */
  async function findInFolder(root: string, name: string): Promise<string | null> {
    const wanted = name.toLowerCase();
    let level = [root];
    let visited = 0;
    for (let depth = 0; depth <= FIND_DEPTH && level.length > 0 && visited < FIND_MAX_DIRS; depth += 1) {
      const next: string[] = [];
      for (const dir of level) {
        visited += 1;
        let entries: CpDirEntry[];
        try {
          entries = await window.codepad.readDir(dir);
        } catch {
          continue;
        }
        const hit = entries.find((entry) => !entry.isDirectory && entry.name.toLowerCase() === wanted);
        if (hit) {
          return hit.path;
        }
        entries.forEach((entry) => {
          if (entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            next.push(entry.path);
          }
        });
      }
      level = next;
    }
    return null;
  }

  // ---- shared cards ---------------------------------------------------------------------------

  /** Card with the changed lines; Apply writes the model text as ONE undoable edit (also after Ctrl+Z), Revert takes the original back. */
  function proposeEdit(s: CodePadChatServices, tab: CodePadTextTab, fullBefore: string, rawProposed: string, warnings: string[], summary?: string): void {
    const { ctx, el } = s;
    if (!ctx.tabs.list().includes(tab) || tab.model.isDisposed()) {
      s.bot('The file was closed before the result arrived.');
      return;
    }
    const trailing = /\s*$/.exec(fullBefore)?.[0] ?? '';
    const proposed = rawProposed.trim() === '' ? '' : rawProposed.replace(/\s+$/, '') + trailing;
    if (proposed === fullBefore) {
      s.bot(NO_CHANGE_HINT);
      return;
    }
    const lines = (text: string): number => text.split('\n').length;
    const body = [
      ...s.warningNodes(warnings),
      ...(summary ? [el('div', 'cp-chat-note', summary)] : []),
      el('div', 'cp-chat-note', `${CodePadSearchCore.displayName(tab.name)}: ${lines(fullBefore)} lines before, ${lines(proposed)} after. Nothing changes until you apply.`),
      s.diffBlock(fullBefore, proposed),
      s.collapsible('Full text before', fullBefore),
      s.collapsible('Full text after', proposed),
    ];
    const replaceText = (text: string): void => {
      ctx.tabs.activate(tab);
      ctx.text.replaceAll(tab.model, [{ range: tab.model.getFullModelRange(), text }], 'AI chat edit');
    };
    const usable = (): boolean => ctx.tabs.list().includes(tab) && !tab.model.isDisposed();
    const card = s.addCard(
      `Proposed edit of ${CodePadSearchCore.displayName(tab.name)}`,
      body,
      [
        {
          label: 'Apply',
          primary: true,
          run: () => {
            if (!usable()) {
              s.doneNote('The file was closed; nothing was applied.');
            } else if (s.lfText(tab) !== proposed) {
              replaceText(proposed);
            }
            card.classList.remove('discarded');
            card.classList.toggle('applied', usable() && s.lfText(tab) === proposed);
          },
        },
        {
          label: 'Discard',
          run: () => {
            card.classList.add('discarded');
          },
        },
        {
          label: 'Revert',
          run: () => {
            if (usable() && s.lfText(tab) === proposed) {
              replaceText(fullBefore);
            }
            card.classList.remove('applied');
          },
        },
      ],
      true,
    );
  }

  /** Options of a new-file card. */
  interface NewFileProposal {
    title: string;
    suggested: string;
    fallbackExt: string;
    content: string;
    warnings: string[];
    /** Folder the file is created in; null opens an untitled tab instead. */
    dir: string | null;
  }

  /** Card for a new file (create / extract / duplicate): editable name, content preview, Create never overwrites. */
  function proposeNewFile(s: CodePadChatServices, proposal: NewFileProposal): void {
    const { ctx, el } = s;
    const nameInput = el('input', 'cp-input');
    nameInput.type = 'text';
    nameInput.value = proposal.suggested;
    nameInput.maxLength = 120;
    nameInput.setAttribute('aria-label', 'File name');
    const label = el('label', 'cp-chat-field', 'File name');
    label.appendChild(nameInput);
    const where = proposal.dir ? `It will be created in ${proposal.dir}.` : 'No folder is open, so it opens as an untitled tab that you can save anywhere.';
    const body = [...s.warningNodes(proposal.warnings), el('div', 'cp-chat-note', `${where} An existing file is never overwritten.`), label, el('pre', 'cp-chat-pre', proposal.content)];
    s.addCard(proposal.title, body, [
      {
        label: 'Create',
        primary: true,
        run: async () => {
          const name = cleanName(nameInput.value, proposal.fallbackExt);
          if (!name) {
            s.doneNote('Give the file a valid name and ask again.');
            return;
          }
          if (!proposal.dir) {
            ctx.tabs.openText({ name, content: proposal.content });
            s.doneNote(`Opened ${name} as an untitled tab. Save it where you like.`);
            return;
          }
          const created = await ctx.files.create(joinPath(proposal.dir, name), proposal.content);
          if (!created.ok) {
            s.doneNote(created.message || 'The file could not be created.');
            return;
          }
          await ctx.tabs.openPath(created.path);
          s.doneNote(`Created ${name}.`);
        },
      },
      { label: 'Discard', run: () => s.doneNote('Discarded. No file was created.') },
    ]);
  }

  /**
   * Shows an answer with Apply / Discard / Revert. Apply puts the text into the active text file (over the selection,
   * else at the cursor) as one undo step; without such a file it opens the text in a new untitled tab.
   */
  function proposeInsert(s: CodePadChatServices, answer: string, warnings: string[]): void {
    const { ctx, el } = s;
    const body = [
      ...s.warningNodes(warnings),
      el('div', 'cp-chat-answer', answer),
      el('div', 'cp-chat-note', 'Nothing changes until you apply. Apply inserts this text into the current file at the cursor (or over the selection).'),
    ];
    // Where the text went, so Revert can take it out again; Apply after an undo inserts it afresh.
    let placed: { tab: CodePadTextTab; start: number; original: string } | null = null;
    // Positions are model offsets, which count line breaks in the model's own line ending (CRLF is two characters).
    const placedRange = (model: monaco.editor.ITextModel, start: number): monaco.IRange => {
      const length = answer.replace(/\r?\n/g, model.getEOL()).length;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(start + length);
      return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
    };
    const stillThere = (): boolean => {
      if (!placed || placed.tab.model.isDisposed()) {
        return false;
      }
      const { model } = placed.tab;
      return model.getValueInRange(placedRange(model, placed.start)).replace(/\r\n/g, '\n') === answer;
    };
    const card = s.addCard(
      'Answer',
      body,
      [
        {
          label: 'Apply',
          primary: true,
          run: () => {
            if (stillThere()) {
              return;
            }
            const tab = ctx.tabs.active();
            if (!tab || tab.kind !== 'text' || tab.model.isDisposed()) {
              ctx.tabs.openText({ content: answer });
              s.doneNote('There was no open text file, so the text was opened in a new tab.');
              return;
            }
            if (tab.persist.readOnly) {
              s.doneNote(`${tab.name} is read-only; nothing was applied.`);
              return;
            }
            const selection = ctx.editor.getModel() === tab.model ? ctx.editor.getSelection() : null;
            const range = selection ?? tab.model.getFullModelRange().collapseToEnd();
            const start = tab.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
            const original = tab.model.getValueInRange(range);
            ctx.tabs.activate(tab);
            ctx.text.replaceAll(tab.model, [{ range, text: answer }], 'AI chat insert');
            placed = { tab, start, original };
            card.classList.remove('discarded');
            card.classList.add('applied');
          },
        },
        {
          label: 'Discard',
          run: () => {
            card.classList.add('discarded');
          },
        },
        {
          label: 'Revert',
          run: () => {
            if (placed && stillThere()) {
              const { model } = placed.tab;
              ctx.tabs.activate(placed.tab);
              ctx.text.replaceAll(model, [{ range: placedRange(model, placed.start), text: placed.original }], 'AI chat insert');
            }
            placed = null;
            card.classList.remove('applied');
          },
        },
      ],
      true,
    );
    pending = { text: answer, card, applied: () => placed !== null && stillThere() };
  }

  /** The newest answer card that is neither applied nor discarded: "break it into paragraphs" revises this text. */
  let pending: { text: string; card: HTMLElement; applied: () => boolean } | null = null;

  /** The text of the pending answer card, or null when there is none to revise. */
  function pendingText(): string | null {
    return pending && !pending.applied() && !pending.card.classList.contains('discarded') && pending.card.isConnected ? pending.text : null;
  }

  /** Groups the sentences of a text into 2 to 5 paragraphs. */
  function splitParagraphs(text: string): string {
    const sentences = text.replace(/\s*\n+\s*/g, ' ').split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== '');
    const count = Math.min(5, Math.max(2, Math.ceil(sentences.length / 3)));
    const size = Math.ceil(sentences.length / count);
    const paragraphs: string[] = [];
    for (let index = 0; index < sentences.length; index += size) {
      paragraphs.push(sentences.slice(index, index + size).join(' '));
    }
    return paragraphs.join('\n\n');
  }

  /** Revises the pending answer card (not the file): a new card replaces the old one. */
  async function revisePending(s: CodePadChatServices, instruction: string, source: string): Promise<void> {
    const old = pending ? pending.card : null;
    const show = (text: string, warnings: string[]): void => {
      old?.classList.add('discarded');
      proposeInsert(s, text, warnings);
    };
    if (/\bparagraphs?\b/i.test(instruction) && /\b(?:break|split|divide|separate|multiple|several|more)\b/i.test(instruction)) {
      const split = splitParagraphs(source);
      if (split === source) {
        s.bot('The text is too short to split into paragraphs.');
      } else {
        show(split, []);
      }
      return;
    }
    await s.runAi({
      instruction,
      tab: null,
      text: source,
      output: 'file',
      onDone: (raw, warnings) => {
        const text = modelText(s, raw);
        if (text !== null) {
          show(text.trim(), warnings);
        }
      },
    });
  }

  /** The AI's whole answer as a trimmed text without a code fence, or null (after saying so) when it is empty. */
  function modelText(s: CodePadChatServices, raw: string): string | null {
    const text = unfence(raw);
    if (text.trim().length === 0) {
      s.bot('The model returned no text, so there is nothing to propose.');
      return null;
    }
    return text;
  }

  // ---- tools that write text with the AI -------------------------------------------------------

  const editFile: CodePadChatTool = {
    id: 'edit-file',
    title: 'Edit',
    description: 'Rewrite or reformat this file',
    example: 'Rewrite this file in a more formal tone',
    needsAi: true,
    async execute({ intent }, s) {
      // "break it into paragraphs" right after an answer (not yet applied) means that answer, not the file.
      const source = pendingText();
      if (source !== null && intent.target === null && !/\b(?:file|tab|document|doc)\b/i.test(intent.instruction)) {
        await revisePending(s, intent.instruction, source);
        return;
      }
      const tab = s.resolveTextTab(intent, true);
      if (!tab) {
        return;
      }
      const before = s.lfText(tab);
      if (before.length > s.maxFileChars) {
        s.bot(`${tab.name} is too long to rewrite in one go (limit ${s.maxFileChars} characters). Split it or work on a smaller file.`);
        return;
      }
      if (before.trim().length === 0) {
        s.bot(`${tab.name} is empty, so there is nothing to change.`);
        return;
      }
      await s.runAi({
        instruction: intent.instruction,
        tab,
        output: 'file',
        onDone: (raw, warnings) => {
          const text = modelText(s, raw);
          if (text !== null) {
            proposeEdit(s, tab, before, text, warnings);
          }
        },
      });
    },
  };

  const createFile: CodePadChatTool = {
    id: 'create-file',
    title: 'Create file',
    description: 'Create a new file',
    example: 'Create a file called notes.txt with a to-do list for the week',
    needsAi: true,
    async execute({ intent }, s) {
      const { aborted, tab } = s.contextTab(intent);
      if (aborted) {
        return;
      }
      await s.runAi({
        instruction: intent.instruction,
        tab,
        output: 'file',
        onDone: (raw, warnings) => {
          const content = modelText(s, raw);
          if (content !== null) {
            proposeNewFile(s, {
              title: 'Proposed new file',
              suggested: cleanName(intent.newName ?? '', '.txt') || 'new-file.txt',
              fallbackExt: '.txt',
              content,
              warnings,
              dir: s.folder(),
            });
          }
        },
      });
    },
  };

  const extractToFile: CodePadChatTool = {
    id: 'extract-to-file',
    title: 'Extract',
    description: 'Extract key points into a new file',
    example: 'Extract the key points from this email into key-points.txt',
    needsAi: true,
    async execute({ intent }, s) {
      const tab = s.resolveTextTab(intent, false);
      if (!tab) {
        return;
      }
      const stem = stemOf(tab.name);
      await s.runAi({
        instruction: intent.instruction,
        tab,
        output: 'file',
        onDone: (raw, warnings) => {
          const content = modelText(s, raw);
          if (content !== null) {
            proposeNewFile(s, {
              title: 'Proposed extract',
              suggested: cleanName(intent.newName ?? '', '.txt') || (stem ? `${stem}-notes.txt` : 'new-file.txt'),
              fallbackExt: '.txt',
              content,
              warnings,
              dir: s.folder(),
            });
          }
        },
      });
    },
  };

  const answer: CodePadChatTool = {
    id: 'answer',
    title: 'Ask',
    description: 'Ask anything; insert the answer into the file',
    example: 'What does this file do?',
    needsAi: true,
    async execute({ intent, question }, s) {
      const { aborted, tab } = s.contextTab(intent);
      if (aborted) {
        return;
      }
      await s.runAi({
        instruction: intent.instruction,
        tab,
        output: 'answer',
        withHistory: true,
        onDone: (raw, warnings) => {
          const text = raw.trim();
          if (text === '') {
            s.bot('The model returned no answer. Try rephrasing your question.');
            return;
          }
          if (echoesRequest(text, intent.instruction)) {
            s.bot('The model only repeated your message. Ask again with more detail, for example the topic or the file you mean.');
            return;
          }
          proposeInsert(s, text, warnings);
          s.remember(question, text);
        },
      });
    },
  };

  /** "no more than 100 words" in a request: the limit, or null. */
  function wordLimit(request: string): number | null {
    const match = /\b(?:not\s+(?:cross|exceed|go over|more than)|no more than|at most|max(?:imum)?(?: of)?|within|under|up to|limit(?:ed)? to|only)\s+(\d{1,4})\s+words?\b|\b(\d{1,4})\s+words?\s+(?:max|maximum|or (?:less|fewer))\b/i.exec(request);
    const value = match ? Number(match[1] ?? match[2]) : 0;
    return value > 0 ? value : null;
  }

  /** Cuts text to `limit` words, ending at the last full sentence when there is one. */
  function capWords(text: string, limit: number): string {
    const words = text.trim().split(/\s+/);
    if (words.length <= limit) {
      return text.trim();
    }
    const cut = words.slice(0, limit).join(' ');
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), /[.!?]$/.test(cut) ? cut.length - 1 : -1);
    return end > cut.length / 2 ? cut.slice(0, end + 1) : cut;
  }

  /** Format rule for the model, by the language of the file the content goes into. */
  function contentRule(languageId: string): { label: string; rule: string; prose: boolean } {
    if (languageId === 'json') {
      return { label: 'JSON', rule: 'Output valid JSON only (double-quoted keys and strings, no comments, no trailing commas).', prose: false };
    }
    if (languageId === 'plaintext') {
      return { label: 'plain text', rule: 'Output plain paragraphs only: no Markdown and no title.', prose: true };
    }
    if (languageId === 'markdown') {
      return { label: 'Markdown', rule: 'Output Markdown only.', prose: true };
    }
    if (languageId === 'html' || languageId === 'xml' || languageId === 'yaml' || languageId === 'ini' || languageId === 'csv') {
      return { label: languageId.toUpperCase(), rule: `Output only valid ${languageId.toUpperCase()} content.`, prose: false };
    }
    return { label: languageId, rule: `Output only ${languageId} source code that is valid in that language. Comments only where they help.`, prose: false };
  }

  /** The topic of a "write something about X" request ("related to / about / on X"), without the word limit and file words. */
  function contentTopic(request: string): string {
    const cleaned = request.replace(/\s*[.,;]?\s*\b(?:do not|don't|not more than|no more than|max(?:imum)?|within|under|up to|at most|limit(?:ed)?)\b.*$/i, '').trim();
    const marked = /\b(?:related to|relating to|about|regarding|on the topic of|on)\s+(.+)$/i.exec(cleaned);
    return (marked ? marked[1] : '')
      .replace(/\b(?:in|into|to|inside|within)\s+(?:this|the|current|that|my)\s+(?:file|document|doc|tab|text)\b/gi, '')
      .replace(/[.\s]+$/, '')
      .trim();
  }

  /** The request without its leading "insert / write ..." verb and file words (what to write, for code and data). */
  function contentTask(request: string): string {
    return request
      .replace(/\s*[.,;]?\s*\b(?:do not|don't|not more than|no more than|max(?:imum)?|within|under|up to|at most|limit(?:ed)?)\b.*$/i, '')
      .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+)*(?:insert|write|add|generate|compose|draft|produce|put|type)\s+/i, '')
      .replace(/\b(?:in|into|to|inside)\s+(?:this|the|current|that|my)\s+(?:file|document|doc|tab|text)\b/gi, '')
      .replace(/[.\s]+$/, '')
      .trim();
  }

  const writeContent: CodePadChatTool = {
    id: 'write-content',
    title: 'Write content',
    description: 'Generate new content (text, JSON, code...) and insert it into the file',
    example: 'Insert content about the stock market in this file, max 100 words',
    needsAi: true,
    async execute({ intent }, s) {
      const active = s.ctx.tabs.active();
      const tab = intent.target ? s.resolveTextTab(intent, true) : active && active.kind === 'text' ? active : null;
      if (intent.target && !tab) {
        return;
      }
      // The file's own text is not sent: the request is to write NEW content, and the model would judge the file instead.
      const { label, rule, prose } = contentRule(tab ? tab.model.getLanguageId() : 'plaintext');
      const limit = wordLimit(intent.instruction);
      const topic = contentTopic(intent.instruction);
      const task = contentTask(intent.instruction);
      if (prose && topic === '') {
        s.bot('What should the content be about? For example: insert some content about the stock market in this file.');
        return;
      }
      // A small model copies a vague task back, so text gets a plain writing prompt on the topic and one more try with another wording.
      const prompts = prose
        ? [
            `Write a short informative text about ${topic}${limit ? ` in at most ${limit} words` : ''}. ${rule}`,
            `Explain ${topic} in simple words${limit ? `, using at most ${limit} words` : ''}.`,
          ]
        : [`Write ${task} for the file "${tab ? tab.name : 'new file'}" (${label}). ${rule}`];
      const attempt = async (index: number): Promise<void> => {
        await s.runAi({
          instruction: prompts[index],
          tab: null,
          output: 'write',
          onDone: (raw, warnings) => {
            const text = modelText(s, raw);
            if (text === null) {
              return;
            }
            if (echoesRequest(text, intent.instruction)) {
              if (index + 1 < prompts.length) {
                attempt(index + 1).catch((error: unknown) => s.bot(`That did not work: ${error instanceof Error ? error.message : String(error)}`));
              } else {
                s.bot('The model did not write new content. Try a more specific request, or pick a larger model in AI > Manage Models.');
              }
              return;
            }
            const notes = [...warnings];
            if (label === 'JSON') {
              try {
                JSON.parse(text);
              } catch {
                notes.push('The generated text is not valid JSON; check it before you apply it.');
              }
            }
            proposeInsert(s, limit && prose ? capWords(text, limit) : text.trim(), notes);
          },
        });
      };
      await attempt(0);
    },
  };

  /** True when the model only gave the request back (a small model does this with vague requests). */
  function echoesRequest(text: string, request: string): boolean {
    const words = (value: string): string[] => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const out = words(text);
    const asked = new Set(words(request));
    return out.length > 0 && out.length <= asked.size + 3 && out.every((word) => asked.has(word));
  }

  const appendText: CodePadChatTool = {
    id: 'append-content',
    title: 'Append',
    description: 'Add text at the end of a file',
    example: 'Add a closing line at the end of this file',
    needsAi: true,
    async execute({ intent }, s) {
      const tab = s.resolveTextTab(intent, true);
      if (!tab) {
        return;
      }
      const before = s.lfText(tab);
      const propose = (added: string, warnings: string[]): void => {
        const base = before === '' || before.endsWith('\n') ? before : `${before}\n`;
        proposeEdit(s, tab, before, base + added, warnings, 'The text is added at the end of the file.');
      };
      if (intent.literal !== null) {
        propose(intent.literal, []);
        return;
      }
      if (before.length > s.maxFileChars) {
        s.bot(`${tab.name} is too long to send to the model (limit ${s.maxFileChars} characters). Quote the text to add instead, for example: append "the end" to this file.`);
        return;
      }
      await s.runAi({
        instruction: `Write ONLY the new text to add at the end of the file, not the existing text. ${intent.instruction}`,
        tab,
        output: 'file',
        onDone: (raw, warnings) => {
          const text = modelText(s, raw);
          if (text !== null) {
            propose(text.replace(/^\n+/, ''), warnings);
          }
        },
      });
    },
  };

  // ---- rule-based text tools (no AI) -----------------------------------------------------------

  const removeTags: CodePadChatTool = {
    id: 'remove-tags',
    title: 'Remove tags',
    description: 'Remove HTML tags and comments',
    example: 'Remove the html tags from this file',
    needsAi: false,
    execute({ intent }, s) {
      // Removing markup is exact work: a rule does it, so a small model cannot misread it.
      const tab = s.resolveTextTab(intent, true);
      if (!tab) {
        return;
      }
      const before = s.lfText(tab);
      const stripped = before.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g, '');
      if (stripped === before) {
        s.bot(`${tab.name} has no HTML tags to remove.`);
        return;
      }
      proposeEdit(s, tab, before, stripped, []);
    },
  };

  /** The whole-text operations of transform-content: label for the card and the function that does the work. */
  const TRANSFORMS: Record<CodePadChatTransform, { label: string; apply: (text: string, descending: boolean) => string }> = {
    clear: { label: 'All content is removed.', apply: () => '' },
    uppercase: { label: 'All text is changed to upper case.', apply: (text) => text.toUpperCase() },
    lowercase: { label: 'All text is changed to lower case.', apply: (text) => text.toLowerCase() },
    'sort-lines': {
      label: 'The lines are sorted.',
      apply: (text, descending) => {
        const sorted = text.replace(/\n+$/, '').split('\n').sort((a, b) => a.localeCompare(b));
        return `${(descending ? sorted.reverse() : sorted).join('\n')}\n`;
      },
    },
    'dedupe-lines': {
      label: 'Repeated lines are removed (the first of each is kept).',
      apply: (text) => {
        const seen = new Set<string>();
        return text
          .split('\n')
          .filter((line) => line.trim() === '' || !seen.has(line) && seen.add(line))
          .join('\n');
      },
    },
    'remove-blank-lines': { label: 'Blank lines are removed.', apply: (text) => text.split('\n').filter((line) => line.trim() !== '').join('\n') },
    'trim-spaces': { label: 'Spaces at the start and end of every line are removed.', apply: (text) => text.split('\n').map((line) => line.trim()).join('\n') },
  };

  const transformText: CodePadChatTool = {
    id: 'transform-content',
    title: 'Change text',
    description: 'Clear the file, change case, sort lines, remove duplicate or blank lines',
    example: 'Remove all content of this file',
    needsAi: false,
    execute({ intent }, s) {
      const tab = s.resolveTextTab(intent, true);
      if (!tab || intent.transform === null) {
        return;
      }
      const before = s.lfText(tab);
      const { label, apply } = TRANSFORMS[intent.transform];
      const after = apply(before, intent.descending);
      if (after === before || (intent.transform === 'clear' && before.trim() === '')) {
        s.bot(intent.transform === 'clear' ? `${tab.name} is already empty.` : `Nothing to change in ${tab.name}.`);
        return;
      }
      proposeEdit(s, tab, before, after, [], label);
    },
  };

  const findReplace: CodePadChatTool = {
    id: 'find-replace',
    title: 'Replace',
    description: 'Replace text in a file',
    example: 'Replace "foo" with "bar" in this file',
    needsAi: false,
    execute({ intent }, s) {
      const tab = s.resolveTextTab(intent, true);
      if (!tab) {
        return;
      }
      const { find, replaceWith } = intent;
      if (!find || replaceWith === null || find === replaceWith) {
        s.bot('Tell me what to replace, for example: replace "foo" with "bar" in this file.');
        return;
      }
      const before = s.lfText(tab);
      const count = before.split(find).length - 1;
      if (count === 0) {
        s.bot(`"${find}" does not occur in ${tab.name} (the search is case-sensitive).`);
        return;
      }
      proposeEdit(s, tab, before, before.split(find).join(replaceWith), [], `Replace "${find}" with "${replaceWith}": ${count} match${count === 1 ? '' : 'es'} (case-sensitive).`);
    },
  };

  // ---- file operations -------------------------------------------------------------------------

  const renameFile: CodePadChatTool = {
    id: 'rename-file',
    title: 'Rename',
    description: 'Rename a file',
    example: 'Rename this file to report.md',
    needsAi: false,
    execute({ intent }, s) {
      const { ctx, el } = s;
      const tab = s.resolveTab(intent);
      if (!tab) {
        return;
      }
      if (!tab.path) {
        s.bot(`${tab.name} is not saved yet, so it has no file to rename. Use Save As first.`);
        return;
      }
      const oldPath = tab.path;
      const newName = cleanName(intent.newName ?? '', extensionOf(tab.name));
      if (!newName) {
        s.bot('Tell me the new name, for example "rename this file to report.md".');
        return;
      }
      if (newName.toLowerCase() === tab.name.toLowerCase()) {
        s.bot(`${tab.name} already has that name.`);
        return;
      }
      s.addCard(
        'Proposed rename',
        [el('div', 'cp-chat-note', `${CodePadSearchCore.displayName(tab.name)}  ->  ${newName}`), el('div', 'cp-chat-note', 'The file stays in its folder. An existing file is never replaced.')],
        [
          {
            label: 'Rename',
            primary: true,
            run: async () => {
              if (!ctx.tabs.list().includes(tab)) {
                s.doneNote('The file was closed; nothing was renamed.');
                return;
              }
              if (tab.dirty && !(await ctx.tabs.save(tab))) {
                s.doneNote('The file has unsaved changes and could not be saved, so it was not renamed.');
                return;
              }
              const renamed = await ctx.files.rename(oldPath, newName);
              if (!renamed.ok) {
                s.doneNote(renamed.message || 'The file could not be renamed.');
                return;
              }
              // There is no path-change call for tabs: reopen the file under its new name.
              await ctx.tabs.close(tab, { force: true });
              await ctx.tabs.openPath(renamed.path);
              s.doneNote(`Renamed to ${newName}.`);
            },
          },
          { label: 'Discard', run: () => s.doneNote('Discarded. Nothing was renamed.') },
        ],
      );
    },
  };

  const deleteFile: CodePadChatTool = {
    id: 'delete-file',
    title: 'Delete',
    description: 'Move a file to the trash',
    example: 'Delete notes.txt',
    needsAi: false,
    execute({ intent }, s) {
      const { ctx, el } = s;
      const tab = s.resolveTab(intent);
      if (!tab) {
        return;
      }
      const filePath = tab.path;
      if (!filePath) {
        s.bot(`${tab.name} is not saved, so it has no file to delete. Close the tab to discard it.`);
        return;
      }
      const note = tab.dirty ? ' Its unsaved changes will be lost.' : '';
      s.addCard(
        `Delete ${CodePadSearchCore.displayName(tab.name)}?`,
        [el('div', 'cp-chat-note', `The file is moved to the trash, so you can restore it from there. You are asked once more before it happens.${note}`)],
        [
          {
            label: 'Move to trash',
            primary: true,
            run: async () => {
              const trashed = await ctx.files.trash(filePath);
              if (!trashed.ok) {
                s.doneNote('cancelled' in trashed && trashed.cancelled ? 'Cancelled. The file was not deleted.' : trashed.message || 'The file could not be deleted.');
                return;
              }
              if (ctx.tabs.list().includes(tab)) {
                // The file is gone, so the save prompt of a modified tab is pointless.
                tab.dirty = false;
                await ctx.tabs.close(tab, { force: true });
              }
              s.doneNote(`${CodePadSearchCore.displayName(tab.name)} was moved to the trash.`);
            },
          },
          { label: 'Discard', run: () => s.doneNote('Discarded. The file was not deleted.') },
        ],
      );
    },
  };

  const saveFile: CodePadChatTool = {
    id: 'save-file',
    title: 'Save',
    description: 'Save a file',
    example: 'Save this file',
    needsAi: false,
    async execute({ intent }, s) {
      const tab = s.resolveTab(intent);
      if (!tab) {
        return;
      }
      const saved = await s.ctx.tabs.save(tab);
      s.bot(saved ? `Saved ${tab.name}.` : `${tab.name} was not saved.`);
    },
  };

  // ---- summary (the same commands as the AI menu) ---------------------------------------------

  const summarizeContent: CodePadChatTool = {
    id: 'summarize-content',
    title: 'Summarize',
    description: 'Summarize a file or the selection into its own Summary tab',
    example: 'Summarize this file',
    needsAi: true,
    async execute({ intent }, s) {
      const tab = s.resolveTab(intent);
      if (!tab) {
        return;
      }
      s.ctx.tabs.activate(tab);
      s.bot(`Summarizing ${intent.selectionOnly ? 'the selection of ' : ''}${tab.name}. The summary opens in its own "Summary of ..." tab; ${tab.name} is not changed.`);
      await s.ctx.commands.execute(intent.selectionOnly ? 'ai.summarizeSelection' : 'ai.summarizeFile');
    },
  };

  const cancelSummary: CodePadChatTool = {
    id: 'cancel-summary',
    title: 'Cancel summary',
    description: 'Stop a running summary',
    example: 'Cancel the summary',
    needsAi: false,
    async execute(_request, s) {
      await s.ctx.commands.execute('ai.cancelSummary');
    },
  };

  const clearSummaryCache: CodePadChatTool = {
    id: 'clear-summary-cache',
    title: 'Clear summary cache',
    description: 'Forget the saved summaries',
    example: 'Clear the summary cache',
    needsAi: false,
    async execute(_request, s) {
      await s.ctx.commands.execute('ai.clearSummaryCache');
    },
  };

  const duplicateFile: CodePadChatTool = {
    id: 'duplicate-file',
    title: 'Duplicate',
    description: 'Copy a file to a new name',
    example: 'Duplicate this file as report-copy.md',
    needsAi: false,
    async execute({ intent }, s) {
      const { ctx } = s;
      const wanted = intent.target?.toLowerCase() ?? null;
      let source: { name: string; dir: string | null; content: string } | null = null;
      if (wanted !== null && !ctx.tabs.list().some((entry) => entry.name.toLowerCase() === wanted)) {
        // Not open: read it from the opened folder.
        const root = s.folder();
        const found = root && intent.target ? await findInFolder(root, intent.target) : null;
        if (!found) {
          s.bot(`${intent.target ?? 'That file'} is not open and was not found in the opened folder.`);
          return;
        }
        const read = await ctx.files.readText(found);
        if (read.tooLarge || read.binary) {
          s.bot(`${intent.target ?? 'That file'} is not a plain text file that fits in memory, so it cannot be copied here.`);
          return;
        }
        source = { name: intent.target ?? found, dir: dirOf(found), content: read.content };
      } else {
        const tab = s.resolveTextTab(intent, false);
        if (!tab) {
          return;
        }
        source = { name: tab.name, dir: tab.path ? dirOf(tab.path) : s.folder(), content: textWithEol(s, tab) };
      }
      const ext = extensionOf(source.name);
      const fallback = `${stemOf(source.name)}-copy${ext}`;
      const requested = cleanName(intent.newName ?? '', ext);
      proposeNewFile(s, {
        title: `Proposed copy of ${CodePadSearchCore.displayName(source.name)}`,
        suggested: requested && requested.toLowerCase() !== source.name.toLowerCase() ? requested : fallback,
        fallbackExt: ext,
        content: source.content,
        warnings: [],
        dir: source.dir,
      });
    },
  };

  // ---- reading and navigating ------------------------------------------------------------------

  const readFile: CodePadChatTool = {
    id: 'read-file',
    title: 'Show',
    description: 'Show the first lines of a file',
    example: 'Show the first lines of this file',
    needsAi: false,
    execute({ intent }, s) {
      const tab = s.resolveTextTab(intent, false);
      if (!tab) {
        return;
      }
      const lines = s.lfText(tab).split('\n');
      const shown = lines.slice(0, READ_LINES).join('\n');
      s.bot(`${tab.name} (${lines.length} line${lines.length === 1 ? '' : 's'}):`);
      s.showNode(s.el('pre', 'cp-chat-pre cp-chat-read', shown || '(empty)'));
      if (lines.length > READ_LINES) {
        s.bot(`... ${lines.length - READ_LINES} more lines.`);
      }
    },
  };

  const listFiles: CodePadChatTool = {
    id: 'list-files',
    title: 'List',
    description: 'List the files of the folder or the open tabs',
    example: 'List the files in the folder',
    needsAi: false,
    async execute(_request, s) {
      const root = s.folder();
      let names: string[];
      let heading: string;
      if (root) {
        const entries = await window.codepad.readDir(root);
        names = [...entries]
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
          .map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name));
        heading = `${root} (${names.length} item${names.length === 1 ? '' : 's'}):`;
      } else {
        names = s.ctx.tabs.list().map((tab) => tab.name);
        heading = `No folder is open. Open tabs (${names.length}):`;
      }
      if (names.length === 0) {
        s.bot(root ? `${root} is empty.` : 'No folder is open and no file is open.');
        return;
      }
      s.bot(heading);
      s.showNode(s.el('pre', 'cp-chat-pre cp-chat-read', names.slice(0, LIST_LINES).join('\n')));
      if (names.length > LIST_LINES) {
        s.bot(`... ${names.length - LIST_LINES} more.`);
      }
    },
  };

  const openFile: CodePadChatTool = {
    id: 'open-file',
    title: 'Open',
    description: 'Open a file from the folder as a tab',
    example: 'Open notes.txt',
    needsAi: false,
    async execute({ intent }, s) {
      const { ctx } = s;
      const name = intent.target;
      if (!name) {
        s.bot('Tell me which file to open, for example "open notes.txt".');
        return;
      }
      const existing = ctx.tabs.list().find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        ctx.tabs.activate(existing);
        s.bot(`${existing.name} is already open; switched to it.`);
        return;
      }
      const root = s.folder();
      if (!root) {
        s.bot('No folder is open, so I cannot look for files. Open a folder first.');
        return;
      }
      const found = await findInFolder(root, name);
      if (!found) {
        s.bot(`${name} was not found in ${root}.`);
        return;
      }
      const tab = await ctx.tabs.openPath(found);
      s.bot(tab ? `Opened ${tab.name}.` : `${name} could not be opened.`);
    },
  };

  const closeFile: CodePadChatTool = {
    id: 'close-file',
    title: 'Close',
    description: 'Close a tab (asks about unsaved changes)',
    example: 'Close this tab',
    needsAi: false,
    execute({ intent }, s) {
      const { ctx, el } = s;
      const tab = s.resolveTab(intent);
      if (!tab) {
        return;
      }
      const note = tab.dirty ? ' It has unsaved changes, so you are asked whether to save them.' : '';
      s.addCard(
        `Close ${tab.name}?`,
        [el('div', 'cp-chat-note', `Only the tab is closed; the file is not deleted.${note}`)],
        [
          {
            label: 'Close tab',
            primary: true,
            run: async () => {
              if (!ctx.tabs.list().includes(tab)) {
                s.doneNote('The tab was already closed.');
                return;
              }
              const closed = await ctx.tabs.close(tab);
              s.doneNote(closed ? `Closed ${tab.name}.` : `${tab.name} was not closed (pinned, or you cancelled).`);
            },
          },
          { label: 'Discard', run: () => s.doneNote('Discarded. The tab stays open.') },
        ],
      );
    },
  };

  // ---- registry ---------------------------------------------------------------------------------

  function register(tool: CodePadChatTool): void {
    if (registry.has(tool.id)) {
      throw new Error(`Chat tool already registered: ${tool.id}`);
    }
    registry.set(tool.id, tool);
  }

  window.CodePadChatTools = Object.freeze({
    register,
    get: (id: string) => registry.get(id),
    list: () => [...registry.values()],
  });

  [
    editFile,
    createFile,
    extractToFile,
    appendText,
    findReplace,
    removeTags,
    transformText,
    writeContent,
    summarizeContent,
    cancelSummary,
    clearSummaryCache,
    renameFile,
    duplicateFile,
    deleteFile,
    saveFile,
    readFile,
    listFiles,
    openFile,
    closeFile,
    answer,
  ].forEach(register);
})();
