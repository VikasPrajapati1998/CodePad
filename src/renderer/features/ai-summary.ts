// AI summaries: gets the text of the current tab (text, docx, spreadsheet or PDF) through the existing view
// interfaces, asks the main process to summarize it (ctx.ai.summarize) and streams the result into a new untitled
// markdown tab "Summary of <file>" (no extension; the user picks the name when saving). The summary can be exported as .docx or .html. All document text is read
// with textContent only; nothing from a document is ever inserted as HTML.
(() => {
  const STREAM_INTERVAL_MS = 250;
  const MAX_PDF_PAGES = 3000;
  const MAX_SHEET_ROWS = 20000;
  const MAX_SHEET_COLUMNS = 50;
  const SLOW_CHUNK_COUNT = 40;
  const SECONDS_PER_CHUNK = 10;
  const CHARS_PER_TOKEN = 3.5;
  const MIN_PDF_CHARS = 20;
  const SCANNED_PDF = 'This PDF has no extractable text (scanned pages).';

  type SummaryEvent = Extract<CpAiEvent, { type: 'summary' }>;

  /** The floating progress box of a running summary. */
  interface Toast {
    root: HTMLElement;
    label: HTMLElement;
    bar: HTMLProgressElement;
  }

  /** A running summary. */
  interface SummaryJob {
    jobId: number;
    tab: CodePadTextTab;
    name: string;
    /** Latest streamed markdown not yet written to the tab. */
    latest: string | null;
    timer: number | null;
    cached: boolean;
    item: CodePadStatusItem;
    toast: Toast;
  }

  let appCtx: CodePadCtx | null = null;
  let job: SummaryJob | null = null;
  /** Set while a request is being prepared or sent, before the job id is known. */
  let starting: { events: SummaryEvent[]; cancelled: boolean } | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-summary feature is not initialized.');
    }
    return appCtx;
  }

  // ---- text acquisition -------------------------------------------------------

  const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const cellText = (value: unknown): string => String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();

  /** Reads converted docx HTML in an inert document (never attached to the page) and returns plain markdown-ish text. */
  function htmlToText(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks: string[] = [];
    const rowText = (row: Element): string => `| ${[...row.children].map((cell) => cellText(cell.textContent)).join(' | ')} |`;
    [...doc.body.children].forEach((node) => {
      const tag = node.tagName.toLowerCase();
      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        blocks.push(`${'#'.repeat(Number(heading[1]))} ${cellText(node.textContent)}`);
      } else if (tag === 'ul' || tag === 'ol') {
        blocks.push([...node.querySelectorAll('li')].map((li) => `- ${cellText(li.textContent)}`).join('\n'));
      } else if (tag === 'table') {
        blocks.push([...node.querySelectorAll('tr')].map(rowText).join('\n'));
      } else {
        blocks.push((node.textContent ?? '').trim());
      }
    });
    return blocks.filter((block) => block.length > 0).join('\n\n');
  }

  async function docxText(ctx: CodePadCtx, tab: CodePadTab): Promise<string> {
    const bytes = await ctx.tabs.exportBytes(tab, 'docx');
    window.CodePadEditors.util.checkZipLimits(bytes, tab.name);
    const mammoth = await ctx.libs.load('mammoth');
    const result = await mammoth.convertToHtml({ arrayBuffer: bytesToArrayBuffer(bytes) });
    return htmlToText(result.value);
  }

  async function sheetText(ctx: CodePadCtx, tab: CodePadTab): Promise<string> {
    const bytes = await ctx.tabs.exportBytes(tab, 'xlsx');
    window.CodePadEditors.util.checkZipLimits(bytes, tab.name);
    const xlsx = await ctx.libs.load('xlsx');
    const workbook = xlsx.read(bytes, { type: 'array', cellDates: true });
    return workbook.SheetNames.map((sheetName) => {
      const rows = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: false, blankrows: false });
      const lines = rows
        .slice(0, MAX_SHEET_ROWS)
        .map((row) => `| ${row.slice(0, MAX_SHEET_COLUMNS).map(cellText).join(' | ')} |`);
      return [`## Sheet: ${sheetName}`, ...lines].join('\n');
    }).join('\n\n');
  }

  async function pdfText(ctx: CodePadCtx, tab: CodePadTab): Promise<string> {
    let bytes: Uint8Array;
    try {
      bytes = await ctx.tabs.exportBytes(tab, 'pdf');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(/view-only/i.test(message) ? SCANNED_PDF : message, { cause: error });
    }
    const pdfjs = await ctx.libs.load('pdfjs');
    // pdfjs-dist 6.4 accepts these options but its typings omit some of them.
    const documentOptions = {
      data: bytes,
      isEvalSupported: false,
      enableScripting: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: ctx.libs.assetUrl('pdfjs-dist/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: ctx.libs.assetUrl('pdfjs-dist/standard_fonts/'),
      wasmUrl: ctx.libs.assetUrl('pdfjs-dist/wasm/'),
      iccUrl: ctx.libs.assetUrl('pdfjs-dist/iccs/'),
    };
    const task = pdfjs.getDocument(documentOptions);
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      const count = Math.min(doc.numPages, MAX_PDF_PAGES);
      for (let number = 1; number <= count; number += 1) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => ('str' in item && typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join(''));
        page.cleanup();
      }
      const text = pages.join('\n\n');
      if (text.replace(/\s/g, '').length < MIN_PDF_CHARS) {
        throw new Error(SCANNED_PDF);
      }
      return text;
    } finally {
      await task.destroy();
    }
  }

  /** Text and display name of a tab, or of the editor selection. Throws an Error with a user-facing message. */
  async function getSource(ctx: CodePadCtx, tab: CodePadTab, selection: boolean): Promise<{ text: string; name: string }> {
    if (tab.kind === 'text') {
      if (selection) {
        const ranges = (ctx.editor.getSelections() || []).filter((range) => !range.isEmpty());
        if (ranges.length === 0) {
          throw new Error('Select some text first.');
        }
        const lf = ctx.monaco.editor.EndOfLinePreference.LF;
        return { text: ranges.map((range) => tab.model.getValueInRange(range, lf)).join('\n\n'), name: `${tab.name} (selection)` };
      }
      return { text: tab.model.getValue(), name: tab.name };
    }
    if (selection) {
      throw new Error('Select some text first.');
    }
    if (tab.kind === 'docx') {
      return { text: await docxText(ctx, tab), name: tab.name };
    }
    if (tab.kind === 'sheet') {
      return { text: await sheetText(ctx, tab), name: tab.name };
    }
    if (tab.kind === 'pdf') {
      return { text: await pdfText(ctx, tab), name: tab.name };
    }
    throw new Error('Not available for this tab.');
  }

  // ---- readiness and pre-checks -----------------------------------------------

  const errorText = (error: unknown): string => (typeof error === 'string' ? error : (error instanceof Error && error.message) || 'unknown reason');

  async function notice(ctx: CodePadCtx, message: string, buttons: string[] = ['OK']): Promise<number> {
    return ctx.ui.confirm({ title: 'Summarize', message, buttons });
  }

  /** True when the model and engine can run a summary; otherwise explains why (and offers the download). */
  async function ensureReady(ctx: CodePadCtx): Promise<boolean> {
    const status = await ctx.ai.status();
    const { model, engine } = status;
    if (model.state === 'ready') {
      if (engine.state === 'error') {
        await notice(ctx, `The AI engine is not available on this computer: ${errorText(engine.error)}`);
        return false;
      }
      return true;
    }
    if (['downloading', 'paused', 'verifying', 'checking'].includes(model.state)) {
      const percent = model.total > 0 ? Math.floor((model.bytes / model.total) * 100) : 0;
      await notice(ctx, `The AI model is still downloading (${percent}%). Summaries work once it is ready.`);
      return false;
    }
    if (model.state === 'offline') {
      await notice(ctx, 'The AI model could not be downloaded because there is no internet connection. Use AI > Download AI Model when you are online.');
      return false;
    }
    const answer = await notice(
      ctx,
      'Summaries need the local AI model, which is not installed yet (523 MB, downloaded once).',
      ['Download AI model', 'Cancel'],
    );
    if (answer === 0) {
      ctx.commands.execute('ai.downloadModel');
    }
    return false;
  }

  /** Size limits and the long-run warning. Returns true to continue. */
  async function precheck(ctx: CodePadCtx, text: string): Promise<boolean> {
    const max = ctx.settings.get('ai.summaryMaxChars');
    if (text.length > max) {
      await notice(
        ctx,
        `This document has ${text.length.toLocaleString()} characters; the limit is ${max.toLocaleString()} (setting AI > Maximum characters to summarize).`,
      );
      return false;
    }
    const chunks = Math.ceil(text.length / (ctx.settings.get('ai.chunkTokens') * CHARS_PER_TOKEN));
    if (chunks > SLOW_CHUNK_COUNT) {
      const minutes = Math.round((chunks * SECONDS_PER_CHUNK) / 60);
      return (await notice(ctx, `This will take about ${minutes} minutes on this computer. Continue?`, ['Continue', 'Cancel'])) === 0;
    }
    return true;
  }

  // ---- running a job --------------------------------------------------------------

  function setReadOnly(tab: CodePadTextTab, value: boolean): void {
    if (!app().tabs.list().includes(tab)) {
      return;
    }
    tab.persist.readOnly = value;
    app().tabs.changed();
    if (app().tabs.active() === tab) {
      app().editor.updateOptions({ readOnly: value });
    }
  }

  function writeText(current: SummaryJob, text: string): void {
    if (app().tabs.list().includes(current.tab) && !current.tab.model.isDisposed()) {
      current.tab.model.setValue(text);
    }
  }

  const titleOf = (current: SummaryJob): string => `# Summary of ${current.name}\n\n`;

  function flush(current: SummaryJob): void {
    if (current.timer !== null) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    if (current.latest !== null) {
      writeText(current, titleOf(current) + current.latest);
      current.latest = null;
    }
  }

  function stream(current: SummaryJob, markdown: string): void {
    current.latest = markdown;
    if (current.timer === null) {
      current.timer = setTimeout(() => {
        current.timer = null;
        flush(current);
      }, STREAM_INTERVAL_MS);
    }
  }

  function createToast(): Toast {
    const root = document.createElement('div');
    root.className = 'cp-ai-toast';
    const label = document.createElement('div');
    label.className = 'cp-ai-toast-label';
    const bar = document.createElement('progress');
    bar.max = 100;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cp-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      cancelJob();
    });
    root.append(label, bar, cancel);
    document.body.appendChild(root);
    return { root, label, bar };
  }

  function showProgress(current: SummaryJob, text: string, done: number, total: number): void {
    current.item.set(`${text} - click to cancel`, { title: 'Click to cancel the summary', state: 'busy' });
    current.toast.label.textContent = text;
    if (total > 0) {
      current.toast.bar.max = total;
      current.toast.bar.value = done;
    } else {
      current.toast.bar.removeAttribute('value');
    }
  }

  function describePhase(ev: SummaryEvent): [string, number, number] {
    if (ev.phase === 'loading') {
      return ['Loading the AI model...', 0, 0];
    }
    if (ev.phase === 'map') {
      return [`Summarizing: part ${ev.current} of ${ev.total}`, ev.current ?? 0, ev.total ?? 0];
    }
    if (ev.phase === 'reduce') {
      return ['Summarizing: combining notes...', 0, 0];
    }
    if (ev.phase === 'final') {
      return ['Summarizing: writing overview...', 0, 0];
    }
    if (ev.phase === 'verify') {
      return ['Summarizing: checking facts...', 0, 0];
    }
    return ['Summarizing: preparing...', 0, 0];
  }

  function endJob(current: SummaryJob, appended: string | null): void {
    if (current.timer !== null) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    if (appended !== null) {
      const base = current.latest !== null ? titleOf(current) + current.latest : null;
      if (app().tabs.list().includes(current.tab) && !current.tab.model.isDisposed()) {
        writeText(current, (base !== null ? base : current.tab.model.getValue()) + appended);
      }
    }
    current.latest = null;
    setReadOnly(current.tab, false);
    current.toast.root.remove();
    current.item.dispose();
    job = null;
  }

  /** Consent: main shows the native confirmation (it names the real host); a refusal there ends the job. */
  async function askConsent(ev: SummaryEvent): Promise<void> {
    await app().ai.models.consent(ev.modelId ?? '');
  }

  /** Yes/No pop-up driven by main when the failed-model fallback is offered. */

  async function askModelFailed(current: SummaryJob): Promise<void> {
    const answer = await notice(app(), 'Your model failed. Would you like to use the default model?', ['Yes', 'No']);
    if (answer === 0) {
      await app().ai.retryDefault(current.jobId);
    } else {
      await app().ai.cancelSummary(current.jobId);
    }
  }

  function handleEvent(current: SummaryJob, ev: SummaryEvent): void {
    if (ev.phase === 'consentRequired' || ev.phase === 'modelFailed') {
      (ev.phase === 'consentRequired' ? askConsent(ev) : askModelFailed(current)).catch((error: unknown) => {
        app().status.set(errorText(error));
      });
    } else if (ev.phase === 'done') {
      const footer = ev.cached === true || current.cached ? '\n\n_(from cache)_\n' : '\n';
      endJob(current, null);
      writeText(current, titleOf(current) + (ev.markdown || '').trimEnd() + footer);
      app().status.set(`Summary of ${current.name} is ready.`);
    } else if (ev.phase === 'cancelled') {
      endJob(current, '\n\n_Cancelled._\n');
      app().status.set('Summary cancelled.');
    } else if (ev.phase === 'error') {
      const message = ev.message || 'unknown error';
      endJob(current, `\n\n_Summary failed: ${message}_\n`);
      app().status.set(`Summary failed: ${message}`);
    } else {
      const [text, done, total] = describePhase(ev);
      showProgress(current, text, done, total);
      if (typeof ev.markdown === 'string' && ev.markdown) {
        stream(current, ev.markdown);
      }
    }
  }

  function onAiEvent(ev: CpAiEvent): void {
    if (ev.type !== 'summary') {
      return;
    }
    if (job && ev.jobId === job.jobId) {
      handleEvent(job, ev);
    } else if (starting && !job) {
      starting.events.push(ev);
    }
  }

  async function cancelJob(): Promise<void> {
    try {
      if (job) {
        await app().ai.cancelSummary(job.jobId);
      } else if (starting) {
        starting.cancelled = true;
      }
    } catch (error) {
      app().status.set(error instanceof Error && error.message ? error.message : 'Could not cancel the summary.');
    }
  }

  async function askCancelRunning(ctx: CodePadCtx, jobId: number | null): Promise<void> {
    const answer = await notice(ctx, 'A summary is already running. Cancel it?', ['Cancel the running summary', 'Keep it running']);
    if (answer === 0 && jobId !== null && jobId !== undefined) {
      await ctx.ai.cancelSummary(jobId);
    }
  }

  function openSummaryTab(ctx: CodePadCtx, name: string): CodePadTextTab {
    const title = `Summary of ${name}`;
    const content = `# ${title}\n\n_Preparing..._\n`;
    const named = ctx.tabs.list().filter((entry) => entry.name === title || entry.name.startsWith(`${title} (`));
    // The summary of the same text goes into the same unsaved tab: its old content is replaced, no second tab appears.
    const previous = named.find((entry): entry is CodePadTextTab => entry.kind === 'text' && entry.name === title && !entry.path);
    if (previous && !previous.model.isDisposed()) {
      previous.persist.readOnly = false;
      previous.model.setValue(content);
      ctx.tabs.activate(previous);
      setReadOnly(previous, true);
      return previous;
    }
    // A name that a file already holds is never given to another tab.
    let unique = title;
    for (let number = 2; named.some((entry) => entry.name === unique); number += 1) {
      unique = `${title} (${number})`;
    }
    const tab = ctx.tabs.openText({ name: unique, content: unique === title ? content : content.replace(title, unique), language: 'markdown' });
    setReadOnly(tab, true);
    return tab;
  }

  async function summarize(ctx: CodePadCtx, tab: CodePadTab, selection: boolean): Promise<void> {
    if (job || starting) {
      await askCancelRunning(ctx, job ? job.jobId : null);
      return;
    }
    starting = { events: [], cancelled: false };
    try {
      if (tab.kind === 'diff') {
        ctx.status.set('Not available for this tab.');
        return;
      }
      if (!(await ensureReady(ctx))) {
        return;
      }
      ctx.status.set(`Reading ${tab.name}...`);
      let source: { text: string; name: string };
      try {
        source = await getSource(ctx, tab, selection);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.status.set(message);
        if (/scanned/.test(message)) {
          await notice(ctx, message);
        }
        return;
      }
      if (source.text.trim().length === 0) {
        ctx.status.set('There is no text to summarize.');
        return;
      }
      if (!(await precheck(ctx, source.text))) {
        ctx.status.set('');
        return;
      }
      const reply = await ctx.ai.summarize({ text: source.text, name: source.name, scope: selection ? 'selection' : 'file' });
      if ('busy' in reply) {
        starting = null;
        const current = (await ctx.ai.status()).summary;
        await askCancelRunning(ctx, current ? current.jobId : null);
        return;
      }
      if ('tooLarge' in reply) {
        await notice(ctx, `This document is too large to summarize (the limit is ${Number(reply.max).toLocaleString()} characters).`);
        return;
      }
      if ('empty' in reply) {
        ctx.status.set('There is no text to summarize.');
        return;
      }
      const summaryTab = openSummaryTab(ctx, source.name);
      const current: SummaryJob = {
        jobId: reply.jobId,
        tab: summaryTab,
        name: source.name,
        latest: null,
        timer: null,
        cached: reply.cached === true,
        item: ctx.status.addItem({ id: 'ai-summary', order: 1, onClick: () => cancelJob() }),
        toast: createToast(),
      };
      const early = starting.events;
      const cancelled = starting.cancelled;
      job = current;
      starting = null;
      showProgress(current, 'Summarizing: preparing...', 0, 0);
      if (cancelled) {
        await ctx.ai.cancelSummary(current.jobId);
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

  // ---- commands ----------------------------------------------------------------------

  function activeTabOrMessage(ctx: CodePadCtx): CodePadTab | null {
    const tab = ctx.tabs.active();
    if (!tab) {
      ctx.status.set('Open a document first.');
    }
    return tab;
  }

  CodePadCommands.register({
    id: 'ai.summarizeFile',
    async run(ctx) {
      const tab = activeTabOrMessage(ctx);
      if (tab) {
        await summarize(ctx, tab, false);
      }
    },
  });

  CodePadCommands.register({
    id: 'ai.summarizeSelection',
    async run(ctx) {
      const tab = activeTabOrMessage(ctx);
      if (tab) {
        await summarize(ctx, tab, true);
      }
    },
  });

  CodePadCommands.register({
    id: 'ai.cancelSummary',
    async run(ctx) {
      if (!job && !starting) {
        ctx.status.set('No summary is running.');
        return;
      }
      await cancelJob();
    },
  });

  CodePadCommands.register({
    id: 'ai.clearSummaryCache',
    async run(ctx) {
      const { removed } = await ctx.ai.clearSummaryCache();
      ctx.status.set(`Summary cache cleared (${removed} ${removed === 1 ? 'entry' : 'entries'}).`);
    },
  });

  CodePadFeatures.register('ai-summary', {
    init(ctx) {
      appCtx = ctx;
      ctx.ai.onEvent(onAiEvent);
      ctx.events.on('tab:closed', (tab) => {
        if (job && job.tab === tab) {
          cancelJob();
        }
      });
      ctx.tabs.contributeMenu((tab) => {
        const items: CodePadContextMenuItem[] = [];
        if (tab.kind !== 'diff') {
          items.push({
            label: 'Summarize',
            run: () => {
              ctx.tabs.activate(tab);
              summarize(ctx, tab, false).catch((error: unknown) => ctx.status.set(errorText(error)));
            },
          });
        }
        return items;
      });
    },
  });
})();
