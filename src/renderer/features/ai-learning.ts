// Personal learning of the AI: the commands to turn it on or off, to manage what was learned (switches per feature, your
// own prompt sentences, remembered phrases and wishes, reset) and to erase it. The data is collected and used in the main
// process only (aiLearning.ts); this feature only asks main for it and sends back the user's edits.
(() => {
  type CustomKey = keyof CpAiLearnDetails['custom'];

  const FEATURE_SWITCHES: Array<{ key: 'ai.learning.suggest' | 'ai.learning.chat' | 'ai.learning.rewrite' | 'ai.learning.summary'; label: string }> = [
    { key: 'ai.learning.suggest', label: 'Ghost text (accepted phrases, ignored suggestions, suggestion length)' },
    { key: 'ai.learning.chat', label: 'Chat answers (thumbs up/down)' },
    { key: 'ai.learning.rewrite', label: 'Grammar check and restructure (Apply/discard, wishes)' },
    { key: 'ai.learning.summary', label: 'Summaries (format "auto")' },
  ];

  const CUSTOM_PROMPTS: Array<{ key: CustomKey; label: string; example: string }> = [
    { key: 'chat', label: 'Chat answers', example: 'Always answer in a formal tone.' },
    { key: 'grammar', label: 'Grammar check', example: 'Use British spelling.' },
    { key: 'restructure', label: 'Restructure', example: 'Prefer short paragraphs.' },
  ];

  const MAX_CUSTOM_CHARS = 150;
  const MAX_PHRASES_SHOWN = 100;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string | null, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function heading(text: string): HTMLElement {
    return element('h4', 'cp-learn-heading', text);
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const node = element('button', 'cp-button', label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  /** Visible form of a remembered context: line breaks and tabs shown as spaces. */
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

  function switchesSection(ctx: CodePadCtx, details: CpAiLearnDetails, refresh: () => void): HTMLElement {
    const section = element('div', 'cp-learn-section');
    section.appendChild(heading('What the AI may learn from'));
    FEATURE_SWITCHES.forEach(({ key, label }) => {
      const row = element('label', 'cp-learn-row');
      const box = element('input', null);
      box.type = 'checkbox';
      box.checked = ctx.settings.get(key) !== false;
      box.disabled = !details.enabled;
      box.addEventListener('change', () => {
        ctx.settings.set(key, box.checked).then(refresh, () => {});
      });
      row.append(box, element('span', null, label));
      section.appendChild(row);
    });
    return section;
  }

  function promptsSection(ctx: CodePadCtx, details: CpAiLearnDetails): HTMLElement {
    const section = element('div', 'cp-learn-section');
    section.appendChild(heading('Prompt sentences'));
    section.appendChild(element('p', 'cp-learn-note', 'Your own sentence is added to the prompt first, followed by the learned one. Leave it empty for none.'));
    CUSTOM_PROMPTS.forEach(({ key, label, example }) => {
      const block = element('div', 'cp-learn-prompt');
      block.appendChild(element('div', 'cp-learn-label', label));
      const input = element('input', 'cp-learn-input');
      input.type = 'text';
      input.maxLength = MAX_CUSTOM_CHARS;
      input.placeholder = example;
      input.value = details.custom[key];
      block.appendChild(input);
      const saved = element('span', 'cp-learn-note');
      block.appendChild(button('Save', () => {
        ctx.ai.learn.setCustom(key, input.value).then(
          (ok) => {
            saved.textContent = ok ? 'Saved.' : 'Not saved.';
          },
          () => {
            saved.textContent = 'Not saved.';
          },
        );
      }));
      block.appendChild(saved);
      const learned = details.learned[key];
      block.appendChild(element('div', 'cp-learn-note', learned ? `Learned: ${learned}` : 'Learned: nothing yet.'));
      section.appendChild(block);
    });
    return section;
  }

  function listSection(
    title: string,
    empty: string,
    rows: Array<{ text: string; detail: string; onDelete: () => void }>,
  ): HTMLElement {
    const section = element('div', 'cp-learn-section');
    section.appendChild(heading(title));
    if (rows.length === 0) {
      section.appendChild(element('p', 'cp-learn-note', empty));
    }
    rows.forEach((row) => {
      const line = element('div', 'cp-learn-item');
      const text = element('div', 'cp-learn-item-text');
      text.appendChild(element('div', null, row.text));
      text.appendChild(element('div', 'cp-learn-note', row.detail));
      line.appendChild(text);
      line.appendChild(button('Delete', row.onDelete));
      section.appendChild(line);
    });
    return section;
  }

  async function render(ctx: CodePadCtx, body: HTMLElement): Promise<void> {
    const [info, details] = await Promise.all([ctx.ai.learn.info(), ctx.ai.learn.details()]);
    const refresh = (): void => {
      render(ctx, body).catch(() => {});
    };
    body.replaceChildren();
    body.appendChild(
      element('p', null, details.enabled ? 'AI learning is on.' : 'AI learning is off: nothing new is remembered and nothing learned is used. Turn it on in AI > Learn From My Usage.'),
    );
    const summary = element('div', 'cp-learn-section');
    summary.appendChild(heading('Summary'));
    info.lines.forEach((line) => summary.appendChild(element('p', 'cp-learn-note', line)));
    body.appendChild(summary);
    body.appendChild(switchesSection(ctx, details, refresh));
    body.appendChild(promptsSection(ctx, details));
    body.appendChild(
      listSection(
        `Remembered ghost-text phrases (${details.phrases.length})`,
        'Nothing remembered yet.',
        details.phrases.slice(0, MAX_PHRASES_SHOWN).map((phrase, index) => ({
          text: oneLine(phrase.text),
          detail: `after "...${oneLine(phrase.context)}" (${phrase.language}), accepted ${phrase.accepted} of ${phrase.shown} times`,
          onDelete: () => {
            ctx.ai.learn.remove('phrase', index, phrase.text).then(refresh, refresh);
          },
        })),
      ),
    );
    body.appendChild(
      listSection(
        `Restructure wishes (${details.wishes.length})`,
        'No wishes remembered yet.',
        details.wishes.map((wish, index) => ({
          text: wish.text,
          detail: `applied ${wish.count} ${wish.count === 1 ? 'time' : 'times'}`,
          onDelete: () => {
            ctx.ai.learn.remove('wish', index, wish.text).then(refresh, refresh);
          },
        })),
      ),
    );
    const actions = element('div', 'cp-learn-section');
    actions.appendChild(heading('Reset'));
    actions.appendChild(
      button('Reset learned hints...', () => {
        ctx.ai.learn.resetHints().then(refresh, refresh);
      }),
    );
    actions.appendChild(element('p', 'cp-learn-note', 'Forgets ratings and Apply/discard counts; phrases, wishes and your own sentences stay. AI > Erase Learned Data deletes everything.'));
    body.appendChild(actions);
  }

  CodePadCommands.register({
    id: 'ai.learning.toggle',
    run(ctx) {
      const next = ctx.settings.get('ai.learning') !== true;
      ctx.settings.set('ai.learning', next);
      ctx.status.set(next ? 'AI learning: on' : 'AI learning: off (what was learned is kept until you erase it)');
    },
  });

  CodePadCommands.register({
    id: 'ai.learning.manage',
    async run(ctx) {
      const body = element('div', 'cp-learn');
      await render(ctx, body);
      ctx.ui.modal({ title: 'Manage learned AI data', body, buttons: [{ label: 'Close', primary: true }] });
    },
  });

  CodePadCommands.register({
    id: 'ai.learning.clear',
    async run(ctx) {
      const { cleared } = await ctx.ai.learn.clear();
      if (cleared) {
        ctx.status.set('Learned AI data erased.');
      }
    },
  });
})();
