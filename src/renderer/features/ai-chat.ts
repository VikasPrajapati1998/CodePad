// AI chat assistant: a draggable round icon at the bottom-right opens a draggable, resizable chat pop-up. The user types
// what to do with files in plain words; a deterministic parser (shared/chatIntent.ts) picks the action and the matching
// tool (features/ai-chat-tools.ts) does the work. This file is the window only: icon, pop-up (minimize, maximize, new
// chat, model selector, quick actions), transcript with the streamed draft, input and the AI job plumbing (ctx.ai.chat). Every change is a proposal card created by a tool. All dynamic text is set with
// textContent.
(() => {
  const MAX_INSTRUCTION_CHARS = 2000;
  const MAX_FILE_CHARS = 60000;
  const MAX_HISTORY = 8;
  const MAX_HISTORY_CHARS = 4000;
  const MAX_DIFF_LINES = 200;
  const DRAG_THRESHOLD = 5;
  const EDGE_GAP = 8;
  const KEY_STEP = 12;

  type ChatEvent = Extract<CpAiEvent, { type: 'chat' }>;

  /** A running chat request: what to do with the model's text when it arrives. */
  interface ChatJob {
    jobId: number;
    onDone(text: string, warnings: string[]): void;
    onFail?(): void;
  }

  let appCtx: CodePadCtx | null = null;
  let job: ChatJob | null = null;
  /** Set while a request is prepared or sent, before the job id is known. */
  let starting: { events: ChatEvent[]; cancelled: boolean } | null = null;
  let folder: string | null = null;
  let history: { role: 'user' | 'assistant'; content: string }[] = [];

  let fab: HTMLButtonElement | null = null;
  let popup: HTMLElement | null = null;
  let transcript: HTMLElement | null = null;
  let input: HTMLTextAreaElement | null = null;
  let sendButton: HTMLButtonElement | null = null;
  let stopButton: HTMLButtonElement | null = null;
  let statusLine: HTMLElement | null = null;
  let modelSelect: HTMLSelectElement | null = null;
  let minimizeButton: HTMLButtonElement | null = null;
  let maximizeButton: HTMLButtonElement | null = null;
  /** The live answer while partial events stream in; removed when the job ends. */
  let draft: HTMLElement | null = null;
  /** True while a request is prepared, sent or running (the model selector is disabled then). */
  let busyNow = false;
  /** Bumped by New chat; a request started in an older conversation is dropped. */
  let conversation = 0;
  /** Size and position before Maximize (inline styles, so an unresized pop-up returns to its CSS size); null when not maximized. */
  let maximized: { x: number; y: number; width: string; height: string } | null = null;
  /** Window positions (top-left, px); null until moved or first opened. Kept in memory only. */
  let fabPos: { x: number; y: number } | null = null;
  let popupPos: { x: number; y: number } | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-chat feature is not initialized.');
    }
    return appCtx;
  }

  /** A DOM element created by `init`. */
  function need<T extends HTMLElement>(node: T | null): T {
    if (!node) {
      throw new Error('The ai-chat feature is not initialized.');
    }
    return node;
  }

  const errorText = (error: unknown): string => (typeof error === 'string' ? error : (error instanceof Error && error.message) || 'unknown reason');
  const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

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

  // ---- transcript -----------------------------------------------------------------

  function scrollDown(): void {
    const box = need(transcript);
    box.scrollTop = box.scrollHeight;
  }

  function addMessage(role: 'user' | 'bot', text: string): HTMLElement {
    const node = el('div', `cp-chat-msg ${role}`, text);
    need(transcript).appendChild(node);
    scrollDown();
    return node;
  }

  const bot = (text: string): HTMLElement => addMessage('bot', text);

  /** Shows a short state text under the transcript (empty hides it). */
  function setWorking(text: string): void {
    const line = need(statusLine);
    line.textContent = text;
    line.hidden = text.length === 0;
  }

  function setBusy(busy: boolean): void {
    busyNow = busy;
    need(sendButton).hidden = busy;
    need(stopButton).hidden = !busy;
    need(modelSelect).disabled = busy;
    if (!busy) {
      setWorking('');
      removeDraft();
    }
  }

  /** Shows the answer generated so far in one live message at the end of the transcript. */
  function showDraft(text: string): void {
    if (!draft) {
      draft = el('div', 'cp-chat-msg bot cp-chat-draft');
      draft.setAttribute('aria-live', 'off');
      need(transcript).appendChild(draft);
    }
    draft.textContent = text;
    scrollDown();
  }

  function removeDraft(): void {
    draft?.remove();
    draft = null;
  }

  /** A proposal card in the transcript: a title, body nodes and buttons. Buttons are disabled once one has run, unless the card is `reusable` (then its buttons work any number of times). */
  function addCard(title: string, body: HTMLElement[], actions: CodePadChatCardAction[], reusable = false): HTMLElement {
    const card = el('div', 'cp-chat-card');
    card.appendChild(el('div', 'cp-chat-card-title', title));
    body.forEach((node) => card.appendChild(node));
    const row = el('div', 'cp-chat-card-actions');
    const buttons: HTMLButtonElement[] = [];
    actions.forEach((action) => {
      const button = el('button', action.primary ? 'cp-button primary' : 'cp-button', action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (!reusable) {
          buttons.forEach((entry) => {
            entry.disabled = true;
          });
          card.classList.add('done');
        }
        // A handler that throws before returning must still end in a visible message, not in dead buttons.
        new Promise<void>((resolve) => {
          resolve(action.run());
        }).catch((error: unknown) => bot(`That did not work: ${errorText(error)}`));
      });
      buttons.push(button);
      row.appendChild(button);
    });
    card.appendChild(row);
    need(transcript).appendChild(card);
    scrollDown();
    return card;
  }

  /** Adds thumbs up / down under an answer card, only while personal learning is on (checked per answer, so new answers follow the setting). One rating per answer. */
  function addRating(card: HTMLElement, answer: string): void {
    const ctx = app();
    if (ctx.settings.get('ai.learning') !== true) {
      return;
    }
    const row = el('div', 'cp-chat-rating');
    row.appendChild(el('span', 'cp-chat-note', 'Was this helpful?'));
    const buttons: HTMLButtonElement[] = [];
    const choices: { rating: 'up' | 'down'; symbol: string; label: string }[] = [
      { rating: 'up', symbol: '\u{1F44D}', label: 'Helpful' },
      { rating: 'down', symbol: '\u{1F44E}', label: 'Not helpful' },
    ];
    choices.forEach((choice) => {
      const button = el('button', 'cp-chat-rate', choice.symbol);
      button.type = 'button';
      button.title = choice.label;
      button.setAttribute('aria-label', choice.label);
      button.addEventListener('click', () => {
        buttons.forEach((entry) => {
          entry.disabled = true;
        });
        button.classList.add('chosen');
        button.setAttribute('aria-pressed', 'true');
        ctx.ai.learn.record({ kind: 'chat', rating: choice.rating, answerChars: answer.length }).catch(() => {});
      });
      buttons.push(button);
      row.appendChild(button);
    });
    card.appendChild(row);
  }

  /** Marks a card as handled by replacing its buttons with a note. */
  const doneNote = (text: string): void => {
    bot(text);
  };

  // ---- file helpers ------------------------------------------------------------------

  /** The open tab the user means: the named one, else the active one. Says why when there is none. */
  function resolveTab(intent: CodePadChatIntent): CodePadTab | null {
    const ctx = app();
    if (intent.target) {
      const wanted = intent.target.toLowerCase();
      const tab = ctx.tabs.list().find((entry) => entry.name.toLowerCase() === wanted);
      if (!tab) {
        bot(`${intent.target} is not open. Open it first and ask again.`);
      }
      return tab ?? null;
    }
    const active = ctx.tabs.active();
    if (!active) {
      bot('There is no open file. Open or create one first.');
    }
    return active;
  }

  /** Like resolveTab, but only plain text tabs (the ones the AI can read and edit). */
  function resolveTextTab(intent: CodePadChatIntent, forEdit: boolean): CodePadTextTab | null {
    const tab = resolveTab(intent);
    if (!tab) {
      return null;
    }
    if (tab.kind !== 'text') {
      bot(`${tab.name} is not a plain text tab, so I cannot ${forEdit ? 'edit' : 'read'} it here.`);
      return null;
    }
    if (forEdit && tab.persist.readOnly) {
      readModeNotice(tab);
      return null;
    }
    return tab;
  }

  /** Tells that a tab is in Read Mode and offers one click to switch it to Edit Mode (the tab's own command does the switch). */
  function readModeNotice(tab: CodePadTextTab): void {
    const ctx = app();
    const note = el(
      'div',
      'cp-chat-note',
      `${tab.name} is in Read Mode, so I cannot change its content. Summaries, analysis, answers and file operations (rename, move, save...) still work. ` +
        'To change text: switch to Edit Mode, select the text and ask again.',
    );
    addCard('Read Mode', [note], [
      {
        label: 'Switch to Edit Mode',
        primary: true,
        run: async () => {
          if (!ctx.tabs.list().includes(tab)) {
            bot('The file was closed.');
            return;
          }
          if (!tab.persist.readOnly) {
            bot(`${tab.name} is already in Edit Mode. Select the text to change and ask again.`);
            return;
          }
          ctx.tabs.activate(tab);
          await ctx.commands.execute('tab.toggleEditMode');
          bot(`${tab.name} is in Edit Mode now. Select the text to change and ask again.`);
        },
      },
    ]);
  }

  /** The text tab an answer / new file may use as context when the intent asks for it; `aborted` when a named file is not open. */
  function contextTab(intent: CodePadChatIntent): { aborted: boolean; tab: CodePadTextTab | null } {
    if (!intent.useCurrent) {
      return { aborted: false, tab: null };
    }
    const candidate = intent.target ? resolveTab(intent) : app().tabs.active();
    if (intent.target && !candidate) {
      return { aborted: true, tab: null };
    }
    return { aborted: false, tab: candidate && candidate.kind === 'text' ? candidate : null };
  }

  const lfText = (tab: CodePadTextTab): string => tab.model.getValue(app().monaco.editor.EndOfLinePreference.LF);

  /** The lines that differ (common head and tail removed) as a compact diff block. */
  function diffBlock(before: string, after: string): HTMLElement {
    const a = before.split('\n');
    const b = after.split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) {
      head += 1;
    }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
      tail += 1;
    }
    const removed = a.slice(head, a.length - tail);
    const added = b.slice(head, b.length - tail);
    const box = el('div', 'cp-chat-diff');
    const push = (lines: string[], sign: string, className: string, budget: { left: number }): void => {
      for (const line of lines) {
        if (budget.left <= 0) {
          return;
        }
        budget.left -= 1;
        box.appendChild(el('div', `cp-chat-diff-line ${className}`, `${sign} ${line}`));
      }
    };
    const budget = { left: MAX_DIFF_LINES };
    push(removed, '-', 'removed', budget);
    push(added, '+', 'added', budget);
    if (removed.length + added.length > MAX_DIFF_LINES) {
      box.appendChild(el('div', 'cp-chat-diff-line more', `... ${removed.length + added.length - MAX_DIFF_LINES} more lines`));
    }
    return box;
  }

  function collapsible(summary: string, text: string): HTMLElement {
    const details = el('details', 'cp-chat-details');
    details.appendChild(el('summary', undefined, summary));
    details.appendChild(el('pre', 'cp-chat-pre', text));
    return details;
  }

  /** Prominent warning lines of a proposal card (for example that only an excerpt of the file was used). */
  const warningNodes = (warnings: string[]): HTMLElement[] => warnings.map((warning) => el('div', 'cp-chat-warn', `Warning: ${warning}`));

  // ---- AI preparation (same checks and dialogs as the rewrite tools) ---------------------

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

  /** A readable problem with the built-in model, or null when it is usable (or another model is active). */
  async function modelProblem(ctx: CodePadCtx): Promise<string | null> {
    if (!(await builtinActive(ctx))) {
      return null;
    }
    const { model, engine } = await ctx.ai.status();
    if (model.state === 'ready') {
      return engine.state === 'error' ? `The AI engine is not available on this computer: ${engine.error || 'unknown reason'}` : null;
    }
    if (['downloading', 'paused', 'verifying', 'checking'].includes(model.state)) {
      return 'The AI model is still downloading. Ask again once it is ready.';
    }
    if (model.state === 'offline') {
      return 'The AI model could not be downloaded because there is no internet connection. Use AI > Download AI Model when you are online.';
    }
    return 'The local AI model is not installed yet. Use AI > Download AI Model (523 MB, downloaded once), or choose another model in AI > Manage Models.';
  }

  /** Fills the model selector with the enabled models (the active one selected); hidden when the list cannot be read. */
  async function refreshModelLine(): Promise<void> {
    const select = need(modelSelect);
    let models: CpAiModelEntry[] = [];
    try {
      const result = await app().ai.models.list();
      models = result.models.filter((entry) => entry.builtin || entry.enabled);
    } catch {
      models = [];
    }
    select.replaceChildren();
    models.forEach((entry) => {
      const option = el('option', undefined, entry.label);
      option.value = entry.id;
      option.selected = entry.active;
      select.appendChild(option);
    });
    const active = models.find((entry) => entry.active);
    if (active) {
      select.value = active.id;
      select.title = `Model used by the chat: ${active.label}`;
    }
    select.disabled = busyNow;
    select.hidden = models.length === 0;
  }

  /** Makes the chosen model the active one; main confirms remote models with its own dialog. */
  async function chooseModel(): Promise<void> {
    const select = need(modelSelect);
    const chosen = select.selectedOptions[0];
    if (!chosen) {
      return;
    }
    const entry = (await app().ai.models.list()).models.find((item) => item.id === chosen.value);
    if (!entry) {
      bot('That model is no longer available.');
      return;
    }
    try {
      const result = await app().ai.models.setActive(entry.builtin ? null : entry.id);
      if (!result.ok) {
        bot(result.message || 'The model could not be selected.');
      }
    } catch (error) {
      bot(`The model could not be selected: ${errorText(error)}`);
    }
  }

  // ---- running a request ----------------------------------------------------------------

  async function cancelJob(): Promise<void> {
    try {
      if (job) {
        await app().ai.cancelChat(job.jobId);
      } else if (starting) {
        starting.cancelled = true;
      }
    } catch (error) {
      bot(`Could not cancel: ${errorText(error)}`);
    }
  }

  /** Main shows the native confirmation (it names the real host); a refusal there ends the job. */
  async function askConsent(ev: ChatEvent): Promise<void> {
    await app().ai.models.consent(ev.modelId ?? '');
  }

  function endJob(): void {
    job = null;
    setBusy(false);
  }

  function handleEvent(current: ChatJob, ev: ChatEvent): void {
    if (ev.phase === 'consentRequired') {
      askConsent(ev).catch((error: unknown) => bot(errorText(error)));
    } else if (ev.phase === 'done') {
      endJob();
      current.onDone(ev.text ?? '', ev.warnings ?? []);
    } else if (ev.phase === 'cancelled') {
      endJob();
      bot('Cancelled.');
      current.onFail?.();
    } else if (ev.phase === 'error') {
      endJob();
      bot(`The AI request failed: ${ev.message || 'unknown error'}`);
      current.onFail?.();
    } else if (ev.phase === 'loading') {
      setWorking('Loading the AI model...');
    } else if (ev.phase === 'partial') {
      setWorking('Writing...');
      if (ev.text) {
        showDraft(ev.text);
      }
    } else {
      setWorking('Working...');
    }
  }

  function onAiEvent(ev: CpAiEvent): void {
    if (ev.type === 'models') {
      refreshModelLine().catch(() => undefined);
    } else if (ev.type === 'chat') {
      if (job && ev.jobId === job.jobId) {
        handleEvent(job, ev);
      } else if (starting && !job) {
        starting.events.push(ev);
      }
    }
  }

  /** Sends the request to main; the answer arrives as events and ends in `options.onDone`. */
  async function runAi(options: CodePadChatAiOptions): Promise<void> {
    const ctx = app();
    const { tab, output } = options;
    const fileText = (options.text ?? (tab ? lfText(tab) : '')).slice(0, MAX_FILE_CHARS);

    const startedIn = conversation;
    const problem = await modelProblem(ctx);
    if (startedIn !== conversation) {
      options.onFail?.();
      return;
    }
    if (problem) {
      bot(problem);
      options.onFail?.();
      return;
    }
    const mine: { events: ChatEvent[]; cancelled: boolean } = { events: [], cancelled: false };
    starting = mine;
    setBusy(true);
    setWorking('Sending...');
    try {
      const reply = await ctx.ai.chat({
        instruction: options.instruction.slice(0, MAX_INSTRUCTION_CHARS),
        ...(tab ? { fileName: tab.name.slice(0, 120), fileText } : options.text !== undefined ? { fileName: 'text', fileText } : {}),
        ...(options.withHistory && history.length > 0 ? { history: history.slice(-MAX_HISTORY) } : {}),
        output,
      });
      if (startedIn !== conversation) {
        // New chat was pressed while the request was sent: stop it and drop its events.
        if (reply.ok) {
          await ctx.ai.cancelChat(reply.jobId);
        }
        options.onFail?.();
        return;
      }
      if (!reply.ok) {
        setBusy(false);
        bot(reply.message || 'The request was not accepted.');
        options.onFail?.();
        return;
      }
      const current: ChatJob = { jobId: reply.jobId, onDone: options.onDone, onFail: options.onFail };
      const early = mine.events;
      const cancelled = mine.cancelled;
      job = current;
      starting = null;
      setWorking('Working...');
      if (cancelled) {
        await ctx.ai.cancelChat(current.jobId);
      }
      early.filter((ev) => ev.jobId === current.jobId).forEach((ev) => {
        if (job === current) {
          handleEvent(current, ev);
        }
      });
    } catch (error) {
      if (startedIn === conversation) {
        setBusy(false);
      }
      throw error;
    } finally {
      // A request of an older conversation must not clear the state of a newer one.
      if (starting === mine) {
        starting = null;
      }
    }
  }

  /** New chat: stops a running request, forgets the conversation and shows the welcome message again. */
  function newConversation(): void {
    conversation += 1;
    const running = job;
    if (starting) {
      starting.cancelled = true;
    }
    job = null;
    starting = null;
    setBusy(false);
    if (running) {
      app().ai.cancelChat(running.jobId).catch(() => undefined);
      // A tool waiting on this request (a multi-part edit) ends quietly instead of waiting forever.
      running.onFail?.();
    }
    history = [];
    window.CodePadChatTools.reset();
    need(transcript).replaceChildren();
    welcome();
    need(input).focus();
  }

  // ---- sending -------------------------------------------------------------------------------

  /** What the tools may use of this window. */
  const services: CodePadChatServices = {
    get ctx() {
      return app();
    },
    folder: () => folder,
    maxFileChars: MAX_FILE_CHARS,
    el,
    bot,
    doneNote,
    showNode: (node) => {
      need(transcript).appendChild(node);
      scrollDown();
    },
    addCard,
    diffBlock,
    collapsible,
    warningNodes,
    resolveTab,
    resolveTextTab,
    readModeNotice,
    contextTab,
    lfText,
    runAi,
    runPart: (options) =>
      new Promise((resolve, reject) => {
        runAi({ ...options, onDone: (text, warnings) => resolve({ text, warnings }), onFail: () => resolve(null) }).catch(reject);
      }),
    scope: () => (app().settings.get('ai.chatScope') === 'all' ? 'all' : 'visible'),
    addRating,
    remember: (question, answer) => {
      history.push({ role: 'user', content: question.slice(0, MAX_HISTORY_CHARS) });
      history.push({ role: 'assistant', content: answer.slice(0, MAX_HISTORY_CHARS) });
      history = history.slice(-MAX_HISTORY);
    },
  };

  /** Runs the tool of the parsed action; an action without a tool is answered as a normal chat question. */
  async function handle(text: string): Promise<void> {
    const intent = CodePadChatIntent.parseIntent(text, app().tabs.list().map((tab) => tab.name));
    const tool = window.CodePadChatTools.get(intent.action) ?? window.CodePadChatTools.get('answer');
    if (!tool) {
      bot('The chat tools are not available.');
      return;
    }
    await tool.execute({ intent, question: text }, services);
  }

  async function send(): Promise<void> {
    const box = need(input);
    const text = box.value.trim();
    if (!text || job || starting) {
      return;
    }
    box.value = '';
    addMessage('user', text);
    try {
      await handle(text);
    } catch (error) {
      bot(`Something went wrong: ${errorText(error)}`);
    }
  }

  // ---- window: icon and pop-up ---------------------------------------------------------------

  function viewport(): { width: number; height: number } {
    return { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  }

  /** Keeps an element fully inside the window. */
  function placeInside(node: HTMLElement, pos: { x: number; y: number }): { x: number; y: number } {
    const view = viewport();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const next = { x: clamp(pos.x, EDGE_GAP, view.width - width - EDGE_GAP), y: clamp(pos.y, EDGE_GAP, view.height - height - EDGE_GAP) };
    node.style.left = `${next.x}px`;
    node.style.top = `${next.y}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    return next;
  }

  /** Where an element is placed and what to do with its new position. */
  interface DragTarget {
    node: HTMLElement;
    onMove: (pos: { x: number; y: number }) => void;
  }

  /**
   * Makes `target.node` draggable by `handle` with pointer events; a movement below the threshold stays a click.
   * The `partner` (the open pop-up for the icon, the icon for the pop-up) moves by the same distance, so the two
   * stay attached; both are kept inside the window.
   */
  function makeDraggable(handle: HTMLElement, target: DragTarget, partner: () => DragTarget | null): void {
    handle.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || (down.target instanceof HTMLElement && down.target.closest('button, select') && down.target !== handle)) {
        return;
      }
      const group = [target, partner()].filter((item): item is DragTarget => item !== null);
      const starts = group.map((item) => item.node.getBoundingClientRect());
      let dragged = false;
      const move = (event: PointerEvent): void => {
        if (!dragged && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
          return;
        }
        dragged = true;
        const view = viewport();
        const deltaX = clamp(
          event.clientX - down.clientX,
          Math.max(...starts.map((rect) => EDGE_GAP - rect.left)),
          Math.min(...starts.map((rect) => view.width - rect.width - EDGE_GAP - rect.left)),
        );
        const deltaY = clamp(
          event.clientY - down.clientY,
          Math.max(...starts.map((rect) => EDGE_GAP - rect.top)),
          Math.min(...starts.map((rect) => view.height - rect.height - EDGE_GAP - rect.top)),
        );
        group.forEach((item, index) => {
          item.onMove(placeInside(item.node, { x: starts[index].left + deltaX, y: starts[index].top + deltaY }));
        });
      };
      const end = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        if (handle.hasPointerCapture(down.pointerId)) {
          handle.releasePointerCapture(down.pointerId);
        }
      };
      handle.setPointerCapture(down.pointerId);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }

  const fabTarget = (): DragTarget | null =>
    fab ? { node: fab, onMove: (pos) => { fabPos = pos; } } : null;
  const popupTarget = (): DragTarget | null =>
    popup && !popup.hidden ? { node: popup, onMove: (pos) => { popupPos = pos; } } : null;

  function popupOpen(): boolean {
    return popup !== null && !popup.hidden;
  }

  function openPopup(): void {
    const box = need(popup);
    box.hidden = false;
    // Always opens attached to the icon: above it, or below it when there is no room above.
    const icon = need(fab).getBoundingClientRect();
    const above = icon.top - box.offsetHeight - EDGE_GAP;
    popupPos = placeInside(box, { x: icon.right - box.offsetWidth, y: above >= EDGE_GAP ? above : icon.bottom + EDGE_GAP });
    need(fab).setAttribute('aria-expanded', 'true');
    refreshModelLine().catch(() => undefined);
    need(input).focus();
  }

  function closePopup(): void {
    need(popup).hidden = true;
    const icon = need(fab);
    icon.setAttribute('aria-expanded', 'false');
    icon.focus();
  }

  function togglePopup(): void {
    if (popupOpen()) {
      closePopup();
    } else {
      openPopup();
    }
  }

  /** Chatbot icon (robot head) drawn with SVG elements; it takes its colour from the button. */
  function robotIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const shapes: Array<[string, Record<string, string>]> = [
      ['rect', { x: '4', y: '8', width: '16', height: '11', rx: '3' }],
      ['path', { d: 'M12 8V5' }],
      ['circle', { cx: '12', cy: '4', r: '1' }],
      ['path', { d: 'M2 13v2M22 13v2' }],
      ['circle', { cx: '9', cy: '13', r: '1', fill: 'currentColor' }],
      ['circle', { cx: '15', cy: '13', r: '1', fill: 'currentColor' }],
      ['path', { d: 'M9.5 16.5h5' }],
    ];
    shapes.forEach(([tag, attributes]) => {
      const shape = document.createElementNS(ns, tag);
      Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, value));
      svg.appendChild(shape);
    });
    return svg;
  }

  function buildFab(): HTMLButtonElement {
    const icon = el('button', 'cp-chat-fab');
    icon.appendChild(robotIcon());
    icon.type = 'button';
    icon.title = 'AI chat assistant (double-click or press Enter to open, drag to move)';
    icon.setAttribute('aria-label', 'AI chat assistant');
    icon.setAttribute('aria-haspopup', 'dialog');
    icon.setAttribute('aria-expanded', 'false');
    makeDraggable(icon, { node: icon, onMove: (pos) => { fabPos = pos; } }, popupTarget);
    icon.addEventListener('dblclick', togglePopup);
    icon.addEventListener('keydown', (event) => {
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePopup();
      } else if (arrows[event.key]) {
        event.preventDefault();
        const rect = icon.getBoundingClientRect();
        fabPos = placeInside(icon, { x: rect.left + arrows[event.key][0], y: rect.top + arrows[event.key][1] });
        if (popupOpen()) {
          openPopup();
        }
      }
    });
    return icon;
  }

  /** The reading scope of the header: the visible part of a long file or all of it (the `ai.chatScope` setting). Edits always work on the selection. */
  function buildScopeSelect(): HTMLElement {
    const select = el('select', 'cp-chat-scope');
    select.title = 'Reading scope: what the chat reads of a long file for answers and analysis when nothing is selected. Edits only ever change the selected text.';
    select.setAttribute('aria-label', 'Reading scope');
    [['visible', 'Visible part'], ['all', 'Whole file']].forEach(([value, label]) => {
      const option = el('option', undefined, label);
      option.value = value;
      select.appendChild(option);
    });
    const sync = (): void => {
      select.value = services.scope();
    };
    select.addEventListener('change', () => {
      app().settings.set('ai.chatScope', select.value).catch(() => undefined);
    });
    app().settings.onChange(({ key }) => {
      if (key === 'ai.chatScope') {
        sync();
      }
    });
    sync();
    return select;
  }

  /** The model selector: the enabled models, the active one selected (filled by refreshModelLine). */
  function buildModelSelect(): HTMLSelectElement {
    const select = el('select', 'cp-chat-model');
    select.title = 'Model used by the chat';
    select.setAttribute('aria-label', 'Chat model');
    select.hidden = true;
    select.addEventListener('change', () => {
      chooseModel()
        .catch((error: unknown) => bot(`The model could not be selected: ${errorText(error)}`))
        .finally(() => {
          // Shows the real active model again (also after a refusal in main).
          refreshModelLine().catch(() => undefined);
        });
    });
    return select;
  }

  /** A small header button with a symbol, a tooltip and an accessible name. */
  function headerButton(symbol: string, label: string, run: () => void, extraClass = ''): HTMLButtonElement {
    const button = el('button', `cp-chat-hbtn${extraClass ? ` ${extraClass}` : ''}`, symbol);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', run);
    return button;
  }

  function setButtonLabel(button: HTMLButtonElement, symbol: string, label: string, pressed: boolean): void {
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  /** Sizes the pop-up to 80% of the window and centres it. */
  function applyMaximized(): void {
    const box = need(popup);
    const view = viewport();
    const width = Math.round(view.width * 0.8);
    const height = Math.round(view.height * 0.8);
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    popupPos = placeInside(box, { x: Math.round((view.width - width) / 2), y: Math.round((view.height - height) / 2) });
  }

  /** Toggles a large pop-up; restoring returns to the size and position from before. */
  function toggleMaximize(): void {
    const box = need(popup);
    if (maximized) {
      const saved = maximized;
      maximized = null;
      box.style.width = saved.width;
      box.style.height = saved.height;
      popupPos = placeInside(box, { x: saved.x, y: saved.y });
    } else {
      const rect = box.getBoundingClientRect();
      maximized = { x: rect.left, y: rect.top, width: box.style.width, height: box.style.height };
      applyMaximized();
    }
    const on = maximized !== null;
    setButtonLabel(need(maximizeButton), on ? '❐' : '□', on ? 'Restore the chat size' : 'Maximize the chat', on);
  }

  /** Puts an editable template into the input and focuses it with the caret at the end (nothing is sent). */
  function fillInput(text: string): void {
    const box = need(input);
    box.value = text;
    box.focus();
    box.setSelectionRange(text.length, text.length);
  }

  /** The quick action row under the header: each button fills the input with a template. */
  function buildQuickActions(): HTMLElement {
    const row = el('div', 'cp-chat-quick');
    row.setAttribute('role', 'toolbar');
    row.setAttribute('aria-label', 'Quick actions');
    // The third entry marks the actions that change content: they need Edit Mode and a selection.
    const actions: Array<[string, string, boolean]> = [
      ['Write', 'Write a paragraph about ', true],
      ['Rewrite', 'Rewrite the selected text in a professional tone', true],
      ['Append', 'Append a paragraph about ', true],
      ['Insert', 'Insert after the second paragraph: ', true],
      ['Summarize', 'Summarize this file', false],
      ['Analyze', 'Analyze this document', false],
      ['Expand', 'Expand the selected text with more detail', true],
      ['Proofread', 'Proofread the selected text', true],
      ['Translate', 'Translate the selected text to Hindi', true],
      ['Find & Replace', 'Replace "old" with "new" in the selected text', true],
      ['Format', 'Format the selected text as Markdown with headings and lists', true],
      ['Continue Writing', 'Continue writing the selected text', true],
    ];
    actions.forEach(([label, template, edits]) => {
      const button = el('button', 'cp-chat-quick-btn', label);
      button.type = 'button';
      button.title = `${template.trim()} (fills the message box${edits ? '; changes only the selected text, in Edit Mode' : '; uses the selection if there is one'})`;
      button.setAttribute('aria-label', `${label}: fill the message box`);
      button.addEventListener('click', () => fillInput(template));
      row.appendChild(button);
    });
    return row;
  }

  function buildPopup(): HTMLElement {
    const box = el('div', 'cp-chat-popup');
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'AI chat assistant');

    const header = el('div', 'cp-chat-header');
    header.appendChild(el('span', 'cp-chat-title', 'AI Chat Assistant'));
    header.appendChild(headerButton('New chat', 'New chat (clears the conversation)', newConversation, 'text'));
    // Minimize hides the pop-up; the conversation stays and a double-click on the icon brings it back.
    minimizeButton = headerButton('–', 'Minimize the chat (double-click the chat icon to reopen)', closePopup);
    maximizeButton = headerButton('□', 'Maximize the chat', toggleMaximize);
    maximizeButton.setAttribute('aria-pressed', 'false');
    const close = headerButton('×', 'Close the chat', closePopup, 'cp-chat-close');
    header.append(minimizeButton, maximizeButton, close);
    makeDraggable(header, { node: box, onMove: (pos) => { popupPos = pos; } }, fabTarget);

    const toolbar = el('div', 'cp-chat-toolbar');
    modelSelect = buildModelSelect();
    toolbar.append(modelSelect, buildScopeSelect());

    transcript = el('div', 'cp-chat-transcript');
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    statusLine = el('div', 'cp-chat-working');
    statusLine.hidden = true;

    const composer = el('div', 'cp-chat-composer');
    input = el('textarea', 'cp-input cp-chat-input');
    input.rows = 2;
    input.maxLength = MAX_INSTRUCTION_CHARS;
    input.placeholder = 'Ask or tell me what to do with a file (Enter sends, Shift+Enter adds a line)';
    input.setAttribute('aria-label', 'Message');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send().catch(() => undefined);
      }
    });
    sendButton = el('button', 'cp-button primary', 'Send');
    sendButton.type = 'button';
    sendButton.addEventListener('click', () => {
      send().catch(() => undefined);
    });
    stopButton = el('button', 'cp-button', 'Stop');
    stopButton.type = 'button';
    stopButton.hidden = true;
    stopButton.addEventListener('click', () => {
      cancelJob().catch(() => undefined);
    });
    composer.append(input, sendButton, stopButton);

    box.append(header, toolbar, buildQuickActions(), transcript, statusLine, composer);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePopup();
      }
    });

    welcome();
    return box;
  }

  /** The first message: what the assistant can do, with example prompts that fill the input. */
  function welcome(): void {
    const node = bot('Hi! Tell me in plain words what to do with your files. I can read, summarize and analyze in both modes. I change text only in Edit Mode, only the selected text, and only after you press Apply. I can (click one to try it):');
    const list = el('div', 'cp-chat-examples');
    window.CodePadChatTools.list().forEach((tool) => {
      const chip = el('button', 'cp-chat-example', tool.description);
      chip.type = 'button';
      chip.title = tool.example;
      chip.addEventListener('click', () => fillInput(tool.example));
      list.appendChild(chip);
    });
    node.appendChild(list);
  }

  function onWindowResize(): void {
    if (fab && fabPos) {
      fabPos = placeInside(fab, fabPos);
    }
    if (popup && maximized) {
      applyMaximized();
    } else if (popup && !popup.hidden && popupPos) {
      popupPos = placeInside(popup, popupPos);
    }
  }

  CodePadCommands.register({
    id: 'ai.chat',
    run: () => {
      togglePopup();
    },
  });

  CodePadFeatures.register('ai-chat', {
    init(ctx) {
      appCtx = ctx;
      fab = buildFab();
      popup = buildPopup();
      document.body.append(fab, popup);
      // The icon starts at its CSS corner position (bottom-right) until it is moved; moved positions are re-clamped.
      window.addEventListener('resize', onWindowResize);
      new ResizeObserver(() => {
        if (popup && !popup.hidden && popupPos) {
          popupPos = placeInside(popup, popupPos);
        }
      }).observe(popup);
      ctx.ai.onEvent(onAiEvent);
      ctx.events.on('folder:changed', (dirPath) => {
        folder = dirPath;
      });
    },
  });
})();
