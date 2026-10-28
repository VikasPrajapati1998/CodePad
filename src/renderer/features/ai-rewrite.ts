// AI writing tools: "Check Grammar and Spelling" and "Rewrite / Restructure". The selection (or the whole file) of the
// active text tab goes to main (ctx.ai.rewrite); the result is shown as a diff (original vs proposed) with a docked
// Apply / Discard dialog that lists warnings. Nothing changes before Apply, and Apply is one undoable edit.
// All dynamic text is set with textContent.
(() => {
  const MAX_INSTRUCTION_CHARS = 500;
  const NOTICE_KEY = 'cp.ai.rewrite.qwenNotice';

  type RewriteEvent = Extract<CpAiEvent, { type: 'rewrite' }>;
  type RewriteMode = CpAiRewriteRequest['mode'];

  /** The text being rewritten: its tab, range in the model and the model text at the time of the request. */
  interface RewriteSource {
    tab: CodePadTextTab;
    range: monaco.Range;
    text: string;
    isSelection: boolean;
    /** Whole model text (LF) when the request was made; Apply refuses if it changed. */
    fullBefore: string;
  }

  /** A running rewrite. */
  interface RewriteJob {
    jobId: number;
    mode: RewriteMode;
    source: RewriteSource;
    item: CodePadStatusItem;
    toast: { root: HTMLElement; label: HTMLElement; bar: HTMLProgressElement };
  }

  let appCtx: CodePadCtx | null = null;
  let job: RewriteJob | null = null;
  /** Set while a request is prepared or sent, before the job id is known. */
  let starting: { events: RewriteEvent[]; cancelled: boolean } | null = null;
  /** True while a review (diff + Apply/Discard) is open. */
  let reviewing = false;
  let noticeShown = false;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-rewrite feature is not initialized.');
    }
    return appCtx;
  }

  const errorText = (error: unknown): string => (typeof error === 'string' ? error : (error instanceof Error && error.message) || 'unknown reason');
  const verb = (mode: RewriteMode): string => (mode === 'grammar' ? 'Grammar check' : 'Rewrite');

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  async function notice(ctx: CodePadCtx, title: string, message: string, buttons: string[] = ['OK']): Promise<number> {
    return ctx.ui.confirm({ title, message, buttons });
  }

  // ---- preparation ---------------------------------------------------------------

  /** True when the built-in model is the active one (also when the list cannot be read). */
  async function builtinActive(ctx: CodePadCtx): Promise<boolean> {
    try {
      const result = await ctx.ai.models.list();
      const active = result.models.find((entry) => entry.active);
      return active ? active.builtin : true;
    } catch {
      return true;
    }
  }

  /** The built-in model must be installed and its engine usable; other models report their own problems. */
  async function ensureBuiltinReady(ctx: CodePadCtx, title: string): Promise<boolean> {
    const { model, engine } = await ctx.ai.status();
    if (model.state === 'ready') {
      if (engine.state === 'error') {
        await notice(ctx, title, `The AI engine is not available on this computer: ${engine.error || 'unknown reason'}`);
        return false;
      }
      return true;
    }
    if (['downloading', 'paused', 'verifying', 'checking'].includes(model.state)) {
      await notice(ctx, title, 'The AI model is still downloading. This works once it is ready.');
      return false;
    }
    if (model.state === 'offline') {
      await notice(ctx, title, 'The AI model could not be downloaded because there is no internet connection. Use AI > Download AI Model when you are online.');
      return false;
    }
    const answer = await notice(ctx, title, 'This needs the local AI model, which is not installed yet (523 MB, downloaded once).', ['Download AI model', 'Cancel']);
    if (answer === 0) {
      ctx.commands.execute('ai.downloadModel');
    }
    return false;
  }

  /** One-time notice about the quality limits of the small built-in model. Returns false when the user cancels. */
  async function qwenNotice(ctx: CodePadCtx, title: string): Promise<boolean> {
    let seen = noticeShown;
    try {
      seen = seen || window.localStorage.getItem(NOTICE_KEY) === '1';
    } catch {
      // Storage unavailable: the notice is shown once per session instead.
    }
    if (seen) {
      return true;
    }
    noticeShown = true;
    try {
      window.localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      // Ignored: see above.
    }
    const answer = await notice(
      ctx,
      title,
      'The built-in Qwen3 model is small, so quality is limited for long text. Review the changes carefully before applying them, or choose a larger model in AI > Manage Models.',
      ['Continue', 'Cancel'],
    );
    return answer === 0;
  }

  /** The text to send: the single selection, or the whole file. Null (with a status message) when impossible. */
  function readSource(ctx: CodePadCtx, wholeFile: boolean): RewriteSource | null {
    const tab = ctx.tabs.active();
    if (!tab || tab.kind !== 'text') {
      ctx.status.set('This works on text tabs only.');
      return null;
    }
    if (tab.persist.readOnly) {
      ctx.status.set('This file is read-only.');
      return null;
    }
    const lf = ctx.monaco.editor.EndOfLinePreference.LF;
    const selected = (ctx.editor.getSelections() || []).filter((range) => !range.isEmpty());
    if (selected.length > 1 && !wholeFile) {
      ctx.status.set('Select one block of text (or clear the selection to use the whole file).');
      return null;
    }
    const range = !wholeFile && selected.length === 1 ? selected[0] : tab.model.getFullModelRange();
    const text = tab.model.getValueInRange(range, lf);
    if (text.trim().length === 0) {
      ctx.status.set('There is no text to check.');
      return null;
    }
    return { tab, range, text, isSelection: !wholeFile && selected.length === 1, fullBefore: tab.model.getValue(lf) };
  }

  /** Asks for the restructure options. Null when cancelled; `wholeFile` only matters when a selection exists. */
  function askOptions(ctx: CodePadCtx, hasSelection: boolean): Promise<{ instruction: string; wholeFile: boolean } | null> {
    return new Promise((resolve) => {
      const body = el('div', 'cp-ai-rewrite-form');
      body.appendChild(
        el('div', 'cp-ai-hint', 'The AI improves the structure and ordering of the text and keeps every fact, number, name and code line. You review the result before anything changes.'),
      );
      const label = el('label', 'cp-prompt-label', 'Instruction (optional), for example "turn this into a bullet list" or "make it more formal"');
      const input = el('textarea', 'cp-input');
      input.rows = 3;
      input.maxLength = MAX_INSTRUCTION_CHARS;
      label.appendChild(input);
      body.appendChild(label);
      const counter = el('div', 'cp-ai-hint', `0 / ${MAX_INSTRUCTION_CHARS}`);
      input.addEventListener('input', () => {
        counter.textContent = `${input.value.length} / ${MAX_INSTRUCTION_CHARS}`;
      });
      body.appendChild(counter);
      let scope: HTMLSelectElement | null = null;
      if (hasSelection) {
        scope = el('select', 'cp-input');
        scope.append(new Option('Selected text only', 'selection'), new Option('Whole file', 'file'));
        const scopeLabel = el('label', 'cp-prompt-label', 'Scope');
        scopeLabel.appendChild(scope);
        body.appendChild(scopeLabel);
      }
      let done = false;
      const finish = (value: { instruction: string; wholeFile: boolean } | null): void => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      ctx.ui.modal({
        title: 'Rewrite / Restructure with AI',
        body,
        buttons: [
          { label: 'Cancel', onClick: () => finish(null) },
          {
            label: 'Start',
            primary: true,
            onClick: () => finish({ instruction: input.value.trim().slice(0, MAX_INSTRUCTION_CHARS), wholeFile: scope ? scope.value === 'file' : false }),
          },
        ],
        onClose: () => finish(null),
      });
    });
  }

  // ---- running a job ----------------------------------------------------------------

  function createToast(): RewriteJob['toast'] {
    const root = el('div', 'cp-ai-toast');
    const label = el('div', 'cp-ai-toast-label');
    const bar = el('progress');
    bar.max = 100;
    const cancel = el('button', 'cp-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      cancelJob().catch(() => undefined);
    });
    root.append(label, bar, cancel);
    document.body.appendChild(root);
    return { root, label, bar };
  }

  function showProgress(current: RewriteJob, text: string, done: number, total: number): void {
    current.item.set(`${text} - click to cancel`, { title: 'Click to cancel', state: 'busy' });
    current.toast.label.textContent = text;
    if (total > 0) {
      current.toast.bar.max = total;
      current.toast.bar.value = done;
    } else {
      current.toast.bar.removeAttribute('value');
    }
  }

  function endJob(current: RewriteJob): void {
    current.toast.root.remove();
    current.item.dispose();
    job = null;
  }

  async function cancelJob(): Promise<void> {
    try {
      if (job) {
        await app().ai.cancelRewrite(job.jobId);
      } else if (starting) {
        starting.cancelled = true;
      }
    } catch (error) {
      app().status.set(errorText(error));
    }
  }

  /** Main shows the native confirmation (it names the real host); a refusal there ends the job. */
  async function askConsent(ev: RewriteEvent): Promise<void> {
    await app().ai.models.consent(ev.modelId ?? '');
  }

  async function askModelFailed(current: RewriteJob): Promise<void> {
    const answer = await notice(app(), verb(current.mode), 'Your model failed. Would you like to use the default model?', ['Yes', 'No']);
    if (answer === 0) {
      await app().ai.retryDefault(current.jobId);
    } else {
      await app().ai.cancelRewrite(current.jobId);
    }
  }

  /** The source text with the rewritten part in place, as LF text of the whole model. */
  function proposedFull(source: RewriteSource, text: string): string {
    const { monaco } = app();
    const { model } = source.tab;
    const lf = monaco.editor.EndOfLinePreference.LF;
    const end = model.getFullModelRange().getEndPosition();
    const prefix = model.getValueInRange(new monaco.Range(1, 1, source.range.startLineNumber, source.range.startColumn), lf);
    const suffix = model.getValueInRange(new monaco.Range(source.range.endLineNumber, source.range.endColumn, end.lineNumber, end.column), lf);
    return prefix + text + suffix;
  }

  /** Shows the diff and the Apply / Discard dialog for a finished rewrite. */
  async function review(current: RewriteJob, ev: RewriteEvent): Promise<void> {
    const ctx = app();
    const { source } = current;
    const trailing = /\s*$/.exec(source.text)?.[0] ?? '';
    const proposed = (ev.text ?? '').replace(/\s+$/, '') + trailing;
    if (!ctx.tabs.list().includes(source.tab) || source.tab.model.isDisposed()) {
      ctx.status.set('The file was closed before the result arrived.');
      return;
    }
    if (proposed === source.text) {
      // Say why: a silent status line looked like a broken command, and the warnings explain a kept-original result.
      ctx.status.set(`${verb(current.mode)}: no changes suggested.`);
      const reasons = (ev.warnings ?? []).length > 0
        ? `Why:\n- ${(ev.warnings ?? []).join('\n- ')}`
        : 'The model returned the text as it was. The built-in Qwen3 model is very small and often ignores instructions such as "bullet points"; a larger model added in AI > Manage Models follows them much better.';
      await ctx.ui.confirm({ title: verb(current.mode), message: `The AI proposed no changes to the text.\n\n${reasons}`, buttons: ['OK'] });
      return;
    }
    const diffTab = await ctx.tabs.openView('diff', {
      name: `${verb(current.mode)}: ${source.tab.name}`,
      params: { leftTabId: source.tab.id, rightText: proposedFull(source, proposed), rightLabel: 'Proposed by AI' },
    });
    reviewing = true;
    const warnings = ev.warnings ?? [];
    const body = el('div', 'cp-ai-review');
    const changes = typeof ev.changes === 'number' ? `${ev.changes} change${ev.changes === 1 ? '' : 's'} proposed` : 'Changes proposed';
    body.appendChild(el('div', undefined, `${changes} for ${source.isSelection ? 'the selection' : 'the whole file'}. Nothing is changed until you apply.`));
    if (warnings.length > 0) {
      body.appendChild(el('div', undefined, 'Warnings:'));
      const list = el('ul');
      warnings.forEach((warning) => list.appendChild(el('li', undefined, warning)));
      body.appendChild(list);
    }
    const finish = async (apply: boolean): Promise<void> => {
      reviewing = false;
      try {
        await ctx.tabs.close(diffTab, { force: true });
      } catch {
        // The diff tab is already gone.
      }
      if (!apply) {
        ctx.status.set(`${verb(current.mode)} discarded.`);
        return;
      }
      applyResult(current, proposed);
    };
    ctx.ui.modal({
      title: `${verb(current.mode)}: review the changes`,
      body,
      buttons: [
        { label: 'Discard', onClick: () => void finish(false) },
        { label: 'Apply', primary: true, onClick: () => void finish(true) },
      ],
      onClose: () => {
        if (reviewing) {
          void finish(false);
        }
      },
    });
  }

  /** Writes the result into the source range as ONE undoable edit. */
  function applyResult(current: RewriteJob, proposed: string): void {
    const ctx = app();
    const { source } = current;
    const { model } = source.tab;
    if (!ctx.tabs.list().includes(source.tab) || model.isDisposed()) {
      ctx.status.set('The file was closed; nothing was applied.');
      return;
    }
    if (model.getValue(ctx.monaco.editor.EndOfLinePreference.LF) !== source.fullBefore) {
      ctx.status.set('The text changed while the AI was working; nothing was applied. Run the command again.');
      return;
    }
    ctx.tabs.activate(source.tab);
    ctx.text.replaceAll(model, [{ range: source.range, text: proposed }], current.mode === 'grammar' ? 'AI grammar check' : 'AI rewrite');
    ctx.status.set(`${verb(current.mode)} applied. Undo (Ctrl+Z) restores the original.`);
  }

  function handleEvent(current: RewriteJob, ev: RewriteEvent): void {
    const ctx = app();
    if (ev.phase === 'consentRequired') {
      askConsent(ev).catch((error: unknown) => ctx.status.set(errorText(error)));
    } else if (ev.phase === 'modelFailed') {
      askModelFailed(current).catch((error: unknown) => ctx.status.set(errorText(error)));
    } else if (ev.phase === 'done') {
      endJob(current);
      review(current, ev).catch((error: unknown) => {
        reviewing = false;
        ctx.status.set(`${verb(current.mode)} failed: ${errorText(error)}`);
      });
    } else if (ev.phase === 'cancelled') {
      endJob(current);
      ctx.status.set(`${verb(current.mode)} cancelled.`);
    } else if (ev.phase === 'error') {
      endJob(current);
      ctx.status.set(`${verb(current.mode)} failed: ${ev.message || 'unknown error'}`);
    } else if (ev.phase === 'loading') {
      showProgress(current, 'Loading the AI model...', 0, 0);
    } else {
      const total = ev.total ?? 0;
      showProgress(current, total > 1 ? `${verb(current.mode)}: part ${ev.current ?? 0} of ${total}` : `${verb(current.mode)}: working...`, ev.current ?? 0, total > 1 ? total : 0);
    }
  }

  function onAiEvent(ev: CpAiEvent): void {
    if (ev.type !== 'rewrite') {
      return;
    }
    if (job && ev.jobId === job.jobId) {
      handleEvent(job, ev);
    } else if (starting && !job) {
      starting.events.push(ev);
    }
  }

  async function start(ctx: CodePadCtx, mode: RewriteMode): Promise<void> {
    const title = mode === 'grammar' ? 'Check Grammar' : 'Rewrite / Restructure';
    if (job || starting || reviewing) {
      ctx.status.set(reviewing ? 'Apply or discard the pending AI changes first.' : 'An AI rewrite is already running.');
      return;
    }
    starting = { events: [], cancelled: false };
    try {
      let instruction = '';
      let wholeFile = false;
      if (mode === 'restructure') {
        const probe = readSource(ctx, false);
        if (!probe) {
          return;
        }
        const options = await askOptions(ctx, probe.isSelection);
        if (!options) {
          return;
        }
        ({ instruction, wholeFile } = options);
      }
      const builtin = await builtinActive(ctx);
      if (builtin && (!(await ensureBuiltinReady(ctx, title)) || !(await qwenNotice(ctx, title)))) {
        return;
      }
      // Read after the dialogs so the text is the latest one.
      const source = readSource(ctx, wholeFile);
      if (!source) {
        return;
      }
      ctx.status.set(`${verb(mode)}: sending ${source.isSelection ? 'the selection' : source.tab.name}...`);
      const reply = await ctx.ai.rewrite({
        text: source.text,
        name: source.isSelection ? `${source.tab.name} (selection)` : source.tab.name,
        mode,
        ...(mode === 'restructure' && instruction ? { instruction } : {}),
        languageId: source.tab.model.getLanguageId(),
      });
      if (!reply.ok) {
        ctx.status.set('');
        await notice(ctx, title, reply.message || 'The request was not accepted.');
        return;
      }
      const current: RewriteJob = {
        jobId: reply.jobId,
        mode,
        source,
        item: ctx.status.addItem({ id: 'ai-rewrite', order: 1, onClick: () => cancelJob() }),
        toast: createToast(),
      };
      const early = starting.events;
      const cancelled = starting.cancelled;
      job = current;
      starting = null;
      showProgress(current, `${verb(mode)}: preparing...`, 0, 0);
      if (cancelled) {
        await ctx.ai.cancelRewrite(current.jobId);
      }
      early.filter((ev) => ev.jobId === current.jobId).forEach((ev) => {
        if (job === current) {
          handleEvent(current, ev);
        }
      });
    } finally {
      starting = null;
    }
  }

  function guarded(mode: RewriteMode): (ctx: CodePadCtx) => Promise<void> {
    return async (ctx) => {
      try {
        await start(ctx, mode);
      } catch (error) {
        ctx.status.set(`${verb(mode)} failed: ${errorText(error)}`);
      }
    };
  }

  CodePadCommands.register({ id: 'ai.checkGrammar', run: guarded('grammar') });
  CodePadCommands.register({ id: 'ai.rewrite', run: guarded('restructure') });

  CodePadFeatures.register('ai-rewrite', {
    init(ctx) {
      appCtx = ctx;
      ctx.ai.onEvent(onAiEvent);
      ctx.events.on('tab:closed', (tab) => {
        if (job && job.source.tab === tab) {
          cancelJob().catch(() => undefined);
        }
      });
    },
  });
})();
