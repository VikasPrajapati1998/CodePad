// AI model UI: the status-bar item, the download dialog, the first-launch gate and the commands that download or
// delete the local model. It is the only subscriber to the model/engine events of ctx.ai and republishes them as
// `ai:state` ({model, engine}) on the event bus for ai-suggest.ts. All network work happens in the main process.
(() => {
  const PRIVACY =
    'CodePad\'s AI runs entirely on your computer. The only network use is the one-time download of the AI model ' +
    'file from registry.ollama.ai (or Hugging Face as a backup); the file is checked against a fixed SHA-256 ' +
    'fingerprint. Nothing you type or open is ever sent anywhere. No usage data is collected. Summaries are cached ' +
    'locally (summary text only) and can be cleared or turned off.';
  const IN_PROGRESS = new Set(['checking', 'downloading', 'paused', 'verifying']);
  const MB = 1000 * 1000;

  /** Text, state and tooltip of the status-bar item. */
  interface StatusShown {
    text: string;
    state: string;
    title: string;
  }

  let appCtx: CodePadCtx | null = null;
  let item: CodePadStatusItem | null = null;
  let model: CpAiModelStatus = { state: 'missing', modelId: null, bytes: 0, total: 0, bytesPerSec: 0, etaSec: 0, external: false, error: null };
  let engine: CpAiEngineState = { state: 'off', error: null, gpu: null, threads: null, modelId: null };
  let dialog: { update(): void } | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-model feature is not initialized.');
    }
    return appCtx;
  }

  const formatMB = (bytes: number): string => `${Math.round((bytes || 0) / MB)} MB`;

  function formatEta(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      return '';
    }
    return seconds < 90 ? 'less than a minute left' : `about ${Math.round(seconds / 60)} min left`;
  }

  const percent = (): number => (model.total > 0 ? Math.min(100, Math.floor((model.bytes / model.total) * 100)) : 0);

  function errorText(error: CpAiModelError | string | null): string {
    if (!error) {
      return '';
    }
    return typeof error === 'string' ? error : error.message || '';
  }

  function describe(): StatusShown {
    const enabled = app().settings.get('ai.enabled') !== false;
    const detail: string[] = [];
    if (IN_PROGRESS.has(model.state)) {
      if (model.state === 'verifying') {
        return { text: 'AI: verifying', state: 'downloading', title: 'Checking the downloaded AI model' };
      }
      if (model.state === 'checking') {
        return { text: 'AI: checking', state: 'downloading', title: 'Checking the AI model' };
      }
      detail.push(`${formatMB(model.bytes)} of ${formatMB(model.total)}`);
      if (model.state === 'downloading' && model.bytesPerSec > 0) {
        detail.push(`${(model.bytesPerSec / MB).toFixed(1)} MB/s`, formatEta(model.etaSec));
      }
      return {
        text: model.state === 'paused' ? `AI: paused ${percent()}%` : `AI: downloading ${percent()}%`,
        state: 'downloading',
        title: detail.filter(Boolean).join(' - '),
      };
    }
    if (model.state === 'offline') {
      return { text: 'AI: offline', state: 'offline', title: 'No internet connection. Click to retry the model download.' };
    }
    if (model.state === 'error') {
      return { text: 'AI: error', state: 'error', title: errorText(model.error) || 'The AI model download failed.' };
    }
    if (model.state === 'missing') {
      return { text: 'AI: not installed', state: 'missing', title: 'The AI model is not installed. Click to download it.' };
    }
    if (engine.state === 'error') {
      return { text: 'AI: error', state: 'error', title: errorText(engine.error) || 'The AI engine could not start.' };
    }
    if (!enabled) {
      return { text: 'AI: off', state: 'off', title: 'AI suggestions are off. Click to turn them on.' };
    }
    if (engine.state === 'loading') {
      return { text: 'AI: loading', state: 'loading', title: 'Loading the AI model' };
    }
    if (engine.gpu !== null && engine.gpu !== undefined) {
      detail.push(engine.gpu ? `GPU: ${engine.gpu}` : 'CPU');
    }
    if (engine.threads) {
      detail.push(`${engine.threads} threads`);
    }
    return { text: 'AI: ready', state: 'ready', title: ['AI is ready. Click to turn it off.', ...detail].join(' - ') };
  }

  function refresh(): void {
    if (!appCtx) {
      return;
    }
    const shown = describe();
    if (item) {
      item.set(shown.text, { title: shown.title, state: shown.state });
    }
    if (dialog) {
      dialog.update();
    }
    app().events.emit('ai:state', { model, engine });
  }

  /** Runs an IPC call and reports `{ok:false}` answers and failures in the status bar. */
  function report(promise: Promise<CpAiResult>): Promise<CpAiResult | void> {
    return Promise.resolve(promise)
      .then((result) => {
        if (result && result.ok === false && result.message) {
          app().status.set(result.message);
        }
        return result;
      })
      .catch((error: unknown) => {
        app().status.set(error instanceof Error && error.message ? error.message : 'The AI model request failed.');
      });
  }

  function paragraph(text: string): HTMLParagraphElement {
    const node = document.createElement('p');
    node.textContent = text;
    return node;
  }

  /** Shows a dialog made of paragraphs; resolves with the clicked button index or -1 when dismissed. */
  function ask(title: string, paragraphs: string[], labels: string[]): Promise<number> {
    return new Promise<number>((resolve) => {
      let answer = -1;
      const body = document.createElement('div');
      body.className = 'cp-ai-text';
      paragraphs.forEach((text) => body.appendChild(paragraph(text)));
      app().ui.modal({
        title,
        body,
        buttons: labels.map((label, index) => ({
          label,
          primary: index === 0,
          onClick: () => {
            answer = index;
          },
        })),
        onClose: () => resolve(answer),
      });
    });
  }

  // ---- download dialog ------------------------------------------------------

  function openProgress(): void {
    if (dialog) {
      return;
    }
    const body = document.createElement('div');
    body.className = 'cp-ai-progress';
    const line = document.createElement('div');
    line.className = 'cp-ai-progress-line';
    const bar = document.createElement('progress');
    bar.max = 100;
    const note = document.createElement('div');
    note.className = 'cp-ai-progress-note';
    const actions = document.createElement('div');
    actions.className = 'cp-ai-actions';

    const makeButton = (label: string, action: () => Promise<CpAiResult>): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cp-button';
      button.textContent = label;
      button.addEventListener('click', () => report(action()));
      actions.appendChild(button);
      return button;
    };
    const pauseButton = makeButton('Pause', () => app().ai.model.pause());
    const resumeButton = makeButton('Resume', () => app().ai.model.resume());
    const cancelButton = makeButton('Cancel', () => app().ai.model.cancel());
    const retryButton = makeButton('Retry', () => app().ai.model.download());
    body.append(line, bar, note, actions);

    const handle = app().ui.modal({
      title: 'AI model download',
      body,
      buttons: [{ label: 'Hide' }],
      onClose: () => {
        dialog = null;
      },
    });

    function update(): void {
      const state = model.state;
      const active = state === 'downloading' || state === 'paused';
      line.textContent = '';
      note.textContent = '';
      bar.value = percent();
      if (state === 'downloading') {
        line.textContent = [
          `${formatMB(model.bytes)} of ${formatMB(model.total)}`,
          model.bytesPerSec > 0 ? `${(model.bytesPerSec / MB).toFixed(1)} MB/s` : '',
          formatEta(model.etaSec),
        ].filter(Boolean).join(' - ');
        if (model.external) {
          note.textContent = 'Another CodePad process (the installer) is downloading the model.';
        }
      } else if (state === 'paused') {
        line.textContent = `Paused at ${formatMB(model.bytes)} of ${formatMB(model.total)}`;
      } else if (state === 'verifying' || state === 'checking') {
        bar.removeAttribute('value');
        line.textContent = 'Checking the downloaded file...';
      } else if (state === 'offline') {
        line.textContent = 'No internet connection. CodePad retries automatically when the connection returns.';
      } else if (state === 'error') {
        line.textContent = errorText(model.error) || 'The download failed.';
      } else if (state === 'ready') {
        handle.close();
        return;
      } else {
        line.textContent = 'The AI model is not installed.';
      }
      pauseButton.hidden = state !== 'downloading' || model.external;
      resumeButton.hidden = state !== 'paused';
      cancelButton.hidden = !active || model.external;
      retryButton.hidden = !(state === 'offline' || state === 'error' || state === 'missing');
      retryButton.textContent = state === 'missing' ? 'Download' : 'Retry';
    }
    dialog = { update };
    update();
  }

  function startDownload(): void {
    const settings: Partial<SettingsValues> = {};
    if (app().settings.get('ai.setupPrompted') !== true) {
      settings['ai.setupPrompted'] = true;
    }
    if (app().settings.get('ai.autoDownload') !== true) {
      settings['ai.autoDownload'] = true;
    }
    if (Object.keys(settings).length > 0) {
      app().settings.patch(settings);
    }
    report(model.state === 'paused' ? app().ai.model.resume() : app().ai.model.download());
    openProgress();
  }

  // ---- first-launch gate ----------------------------------------------------

  async function runGate(): Promise<void> {
    if (model.state !== 'missing' || model.external || app().settings.get('ai.setupPrompted') === true) {
      return;
    }
    let answer = -1;
    for (;;) {
      let online = false;
      try {
        online = Boolean((await app().ai.model.checkConnection()).online);
      } catch (error) {
        console.error('AI connection check failed:', error);
      }
      if (online) {
        answer = await ask(
          'AI features',
          [
            'CodePad can suggest text and summarize documents with a small AI model that runs on this computer. ' +
              'It needs to be downloaded once (523 MB) and then works offline.',
            PRIVACY,
          ],
          ['Download now', 'Continue without AI'],
        );
        if (answer === 0) {
          startDownload();
        }
        break;
      }
      answer = await ask(
        'AI features',
        ['CodePad needs internet once to download its AI model.'],
        ['Retry', 'Continue without AI'],
      );
      if (answer !== 0) {
        answer = answer === 1 ? 1 : -1;
        break;
      }
    }
    if (answer === 1) {
      await app().settings.patch({ 'ai.setupPrompted': true, 'ai.autoDownload': false });
    }
  }

  // ---- status item ----------------------------------------------------------

  function retryEngine(): void {
    app().settings.set('ai.enabled', false).then(() => app().settings.set('ai.enabled', true));
  }

  function showError(message: string, retry: () => void): void {
    ask('AI error', [message || 'The AI feature could not start.'], ['Retry', 'Close']).then((answer) => {
      if (answer === 0) {
        retry();
      }
    });
  }

  function onItemClick(event: MouseEvent): void {
    const { state } = describe();
    if (state === 'off') {
      app().settings.set('ai.enabled', true);
    } else if (state === 'ready') {
      app().settings.set('ai.enabled', false);
    } else if (state === 'missing') {
      app().commands.execute('ai.downloadModel');
    } else if (state === 'offline') {
      report(app().ai.model.download());
    } else if (state === 'downloading') {
      const paused = model.state === 'paused';
      app().ui.contextMenu(event.clientX, event.clientY, [
        paused
          ? { label: 'Resume download', run: () => report(app().ai.model.resume()) }
          : { label: 'Pause download', disabled: model.state !== 'downloading', run: () => report(app().ai.model.pause()) },
        { label: 'Cancel download', disabled: model.external, run: () => report(app().ai.model.cancel()) },
        { label: 'Show progress', run: openProgress },
      ]);
    } else if (state === 'error') {
      if (model.state === 'error') {
        showError(errorText(model.error), () => report(app().ai.model.download()));
      } else {
        showError(`The AI engine is not available on this computer: ${errorText(engine.error)}`, retryEngine);
      }
    } else {
      app().commands.execute('ai.showStatus');
    }
  }

  function applyStatus(status: CpAiStatus): void {
    if (status && status.model) {
      model = { ...model, ...status.model };
    }
    if (status && status.engine) {
      engine = { ...engine, ...status.engine };
    }
  }

  function onAiEvent(event: CpAiEvent): void {
    if (event.type === 'model') {
      model = { ...model, ...event.status };
      refresh();
    } else if (event.type === 'engine') {
      engine = { ...engine, ...event.state };
      refresh();
    }
  }

  // ---- commands ---------------------------------------------------------------

  CodePadCommands.register({
    id: 'ai.downloadModel',
    run(ctx) {
      if (model.state === 'ready') {
        ctx.status.set('The AI model is already installed.');
        return;
      }
      startDownload();
    },
  });

  CodePadCommands.register({
    id: 'ai.deleteModel',
    async run(ctx) {
      if (model.state !== 'ready') {
        ctx.status.set('The AI model is not installed.');
        return;
      }
      const answer = await ask(
        'Delete AI model',
        ['Delete the AI model (523 MB)? AI features stop until you download it again.'],
        ['Delete', 'Cancel'],
      );
      if (answer === 0) {
        const result = await report(ctx.ai.model.remove());
        if (result && result.ok) {
          ctx.status.set('The AI model was deleted.');
        }
      }
    },
  });

  CodePadCommands.register({
    id: 'ai.showStatus',
    async run(ctx) {
      try {
        applyStatus(await ctx.ai.status());
      } catch (error) {
        console.error('AI status failed:', error);
      }
      const modelLine = `Model: ${model.modelId || 'none'} (${model.total ? formatMB(model.total) : 'size unknown'}), ` +
        `state: ${model.state}${model.error ? ` (${errorText(model.error)})` : ''}`;
      const engineLine = `Engine: ${engine.state}${engine.error ? ` (${errorText(engine.error)})` : ''}` +
        `${engine.gpu !== null && engine.gpu !== undefined ? `, ${engine.gpu ? `GPU ${engine.gpu}` : 'CPU'}` : ''}` +
        `${engine.threads ? `, ${engine.threads} threads` : ''}`;
      const cacheLine = `Summary cache: ${ctx.settings.get('ai.summaryCache') === false ? 'off' : 'on'}. ` +
        'It stores only summary text on this computer, never the documents.';
      await ask('AI model status', [modelLine, engineLine, cacheLine, PRIVACY], ['Close']);
      refresh();
    },
  });

  CodePadFeatures.register('ai-model', {
    init(ctx) {
      appCtx = ctx;
      item = ctx.status.addItem({ id: 'ai', order: 0, onClick: onItemClick });
      refresh();
      ctx.settings.onChange(({ key }) => {
        if (key === 'ai.enabled') {
          refresh();
        }
      });
      ctx.ai.onEvent(onAiEvent);
      window.addEventListener('online', () => {
        if (model.state === 'offline') {
          report(ctx.ai.model.download());
        }
      });
      ctx.ai.status()
        .then((status) => {
          applyStatus(status);
          refresh();
          return runGate();
        })
        .catch((error: unknown) => console.error('AI status failed:', error));
    },
  });
})();
