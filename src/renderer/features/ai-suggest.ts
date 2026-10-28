// AI ghost text: a Monaco inline-completions provider for every language. The continuation comes from the local
// model through ctx.ai.suggest (the main process owns the model and builds the prompt). Tab, Ctrl+Right and Escape
// are Monaco's own keys; Right Arrow accepts only at the end of a line while a suggestion is visible and the
// dropdown is closed (context key cpAiGhostAtEol), so ordinary Right Arrow movement is never changed.
(() => {
  const MAX_MODEL_CHARS = 2000000;
  const MAX_LINE_CHARS = 1000;
  const MIN_PREFIX_CHARS = 8;
  const WINDOW_STEP = 1024;
  const MAX_SUFFIX_CHARS = 400;
  const LANGUAGE_ID = /^[A-Za-z0-9_.+-]{1,40}$/;
  const WORD_CHAR = /[\p{L}\p{N}_]/u;
  const ONLY_CLOSERS = /^[\s)\]}'"`>;,]*$/;
  const RIGHT_ARROW_WHEN =
    'inlineSuggestionVisible && cpAiGhostAtEol && !suggestWidgetVisible && !editorHasSelection && !editorHasMultipleSelections';

  type Monaco = CodePadCtx['monaco'];

  let appCtx: CodePadCtx | null = null;
  let modelState = 'missing';
  let engineState = 'off';
  let seq = 0;
  const configured = new WeakSet<object>();

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-suggest feature is not initialized.');
    }
    return appCtx;
  }

  /** The `state` field of a model/engine status in an `ai:state` event (the bus declares those as unknown). */
  function stateField(status: unknown): string {
    if (typeof status === 'object' && status !== null && 'state' in status && typeof status.state === 'string') {
      return status.state;
    }
    return '';
  }

  /** Resolves true after `ms`, or false as soon as the token is cancelled. */
  function wait(ms: number, token: monaco.CancellationToken): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        resolve(true);
      }, ms);
      const subscription = token.onCancellationRequested(() => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(false);
      });
    });
  }

  function isReady(): boolean {
    return modelState === 'ready' && engineState !== 'error';
  }

  /** The text window before the cursor: starts at a stable multiple of 1024 chars, on a line start (KV reuse). */
  function prefixWindow(monaco: Monaco, model: monaco.editor.ITextModel, position: monaco.Position): { text: string; startLine: number } {
    const offset = model.getOffsetAt(position);
    const wanted = Math.max(0, offset - app().settings.get('ai.contextChars'));
    const start = Math.floor(wanted / WINDOW_STEP) * WINDOW_STEP;
    const startPosition = model.getPositionAt(start);
    const startLine = Math.min(startPosition.column > 1 ? startPosition.lineNumber + 1 : startPosition.lineNumber, position.lineNumber);
    const range = new monaco.Range(startLine, 1, position.lineNumber, position.column);
    return { text: model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF), startLine };
  }

  /** Request fields for the cursor position, or null when no suggestion should be made here. */
  function buildRequest(
    monaco: Monaco,
    editor: monaco.editor.IStandaloneCodeEditor,
    tab: CodePadTextTab,
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Omit<CpAiSuggestRequest, 'reqId'> | null {
    if (tab.persist && tab.persist.readOnly) {
      return null;
    }
    const selections = editor.getSelections() || [];
    if (selections.length !== 1 || !selections[0].isEmpty()) {
      return null;
    }
    if (model.getValueLength() > MAX_MODEL_CHARS || model.getLineLength(position.lineNumber) > MAX_LINE_CHARS) {
      return null;
    }
    const line = model.getLineContent(position.lineNumber);
    const rest = line.slice(position.column - 1);
    if ((rest.length > 0 && WORD_CHAR.test(rest[0])) || !ONLY_CLOSERS.test(rest)) {
      return null;
    }
    const span = prefixWindow(monaco, model, position);
    if (span.text.replace(/\s/g, '').length < MIN_PREFIX_CHARS) {
      return null;
    }
    const modelLanguage = model.getLanguageId();
    const languageId = LANGUAGE_ID.test(modelLanguage) ? modelLanguage : 'plaintext';
    const parts = CodePadSuggestText.extractContext({
      languageId,
      lineCount: model.getLineCount(),
      getLine: (n) => model.getLineContent(n),
      cursorLine: position.lineNumber,
      windowStartLine: span.startLine,
    });
    return {
      prefix: span.text,
      suffixLine: rest.slice(0, MAX_SUFFIX_CHARS),
      suffix: parts.suffix,
      header: parts.header,
      scope: parts.scope,
      languageId,
      multiline: app().settings.get('ai.multiline') === true,
    };
  }

  async function provide(
    monaco: Monaco,
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.InlineCompletionContext,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.InlineCompletions> {
    const none: monaco.languages.InlineCompletions = { items: [] };
    try {
      const editor = app().editor;
      const tab = app().tabs.active();
      if (
        app().settings.get('ai.enabled') === false ||
        !isReady() ||
        context.selectedSuggestionInfo ||
        !editor ||
        !tab ||
        tab.kind !== 'text' ||
        tab.model !== model ||
        editor.getModel() !== model ||
        editor.getOption(monaco.editor.EditorOption.readOnly)
      ) {
        return none;
      }
      const request = buildRequest(monaco, editor, tab, model, position);
      if (!request) {
        return none;
      }
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (!explicit && !(await wait(app().settings.get('ai.suggestDelayMs'), token))) {
        return none;
      }
      seq += 1;
      const reqId = seq;
      const subscription = token.onCancellationRequested(() => {
        app().ai.cancelSuggest(reqId).catch(() => {});
      });
      let answer: CpAiSuggestResult;
      try {
        answer = await app().ai.suggest({ reqId, ...request });
      } finally {
        subscription.dispose();
      }
      if (token.isCancellationRequested || !answer || answer.reqId !== reqId || typeof answer.text !== 'string' || !answer.text) {
        return none;
      }
      return {
        items: [{ insertText: answer.text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
      };
    } catch {
      // A failed request only means no ghost text; the engine state is shown in the status bar.
      return none;
    }
  }

  /** Editor options, the end-of-line context key and the Right Arrow accept command for one editor. */
  function setup(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (!editor || configured.has(editor)) {
      return;
    }
    configured.add(editor);
    const { monaco } = app();
    editor.updateOptions({
      inlineSuggest: { enabled: true, mode: 'prefix', showToolbar: 'never', suppressSuggestions: false },
      suggest: { preview: false },
    });
    const atEol = editor.createContextKey<boolean>('cpAiGhostAtEol', false);
    const update = () => {
      const position = editor.getPosition();
      const model = editor.getModel();
      atEol.set(Boolean(position && model && position.column === model.getLineMaxColumn(position.lineNumber)));
    };
    editor.onDidChangeCursorPosition(update);
    editor.onDidChangeModel(update);
    update();
    editor.addCommand(
      monaco.KeyCode.RightArrow,
      () => editor.trigger('ai', 'editor.action.inlineSuggest.commit', {}),
      RIGHT_ARROW_WHEN,
    );
  }

  function notReadyMessage(): string {
    if (modelState === 'missing') {
      return 'The AI model is not installed. Use AI > Download AI Model.';
    }
    if (modelState !== 'ready') {
      return 'The AI model is not ready yet.';
    }
    return 'The AI engine is not available on this computer.';
  }

  CodePadCommands.register({
    id: 'ai.toggleSuggestions',
    run(ctx) {
      const next = ctx.settings.get('ai.enabled') === false;
      ctx.settings.set('ai.enabled', next);
      ctx.status.set(next ? 'AI suggestions: on' : 'AI suggestions: off');
    },
  });

  CodePadCommands.register({
    id: 'ai.suggestNow',
    run(ctx) {
      if (ctx.settings.get('ai.enabled') === false) {
        ctx.status.set('AI suggestions are off. Turn them on in the AI menu.');
        return;
      }
      if (!isReady()) {
        ctx.status.set(notReadyMessage());
        return;
      }
      ctx.editor.trigger('ai', 'editor.action.inlineSuggest.trigger', {});
    },
  });

  CodePadFeatures.register('ai-suggest', {
    init(ctx) {
      appCtx = ctx;
      const { monaco } = ctx;
      monaco.languages.registerInlineCompletionsProvider('*', {
        provideInlineCompletions: (model, position, context, token) => provide(monaco, model, position, context, token),
        freeInlineCompletions() {},
      });
      setup(ctx.editor);
      ctx.events.on('editor:created', setup);
      ctx.events.on('ai:state', (state) => {
        modelState = stateField(state.model);
        engineState = stateField(state.engine);
      });
      ctx.ai.status()
        .then((status) => {
          modelState = status.model.state;
          engineState = status.engine.state;
        })
        .catch((error: unknown) => console.error('AI status failed:', error));
      ctx.settings.onChange(({ key, value }) => {
        if (key === 'ai.enabled' && value === false && ctx.editor) {
          ctx.editor.trigger('ai', 'editor.action.inlineSuggest.hide', {});
        }
      });
    },
  });
})();
