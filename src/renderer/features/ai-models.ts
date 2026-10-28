// AI Models: the "Manage Models" dialog (list, enable, choose the summary model, delete), the Add Model wizard and
// the status-bar badge of the active summary model. Suggestions always use the built-in local model; only summaries
// use the selected model. API keys are only ever sent to main (never read back); every dynamic text is set with
// textContent. All work happens in the main process behind ctx.ai.models.
(() => {
  const KIND_LABELS: Record<CpAiModelKind, string> = {
    builtin: 'Built-in Qwen3 (default)',
    'gguf-file': 'Local file (.gguf)',
    'ollama-registry': 'Ollama registry (name:tag)',
    huggingface: 'Hugging Face free API',
    anthropic: 'Anthropic (Claude)',
    'openai-compatible': 'OpenAI-compatible (GPT, Groq, custom URL)',
  };
  const REMOTE_KINDS = new Set<string>(['anthropic', 'openai-compatible', 'huggingface']);
  const KEY_KINDS = new Set<string>(['anthropic', 'openai-compatible', 'huggingface']);
  const KNOWN_IDS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
    'openai-compatible': ['gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
    huggingface: ['meta-llama/Llama-3.1-8B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'],
    'ollama-registry': ['llama3.1:8b', 'qwen2.5:7b', 'mistral:7b', 'gemma2:9b'],
  };
  const NO_STORAGE = 'E_NO_SECURE_STORAGE';

  /** Progress of a running model download. */
  interface PullState {
    fraction: number;
    text: string;
    error: string | null;
  }

  /** The Add Model form as read from its inputs. `modelName` is set for every kind but 'gguf-file'. */
  interface WizardSpec {
    kind: CpAiModelKind;
    label: string;
    modelName?: string;
    baseUrl?: string;
    contextTokens?: number;
  }

  /** Mirrors MAX_MODELS of modelRegistry.ts (main enforces it). */
  const MAX_ADDED_MODELS = 10;

  let appCtx: CodePadCtx | null = null;
  let models: CpAiModelEntry[] = [];
  let manager: { render(): void } | null = null;
  let badge: CodePadStatusItem | null = null;
  /** Pull progress by model id. */
  const pulls = new Map<string, PullState>();
  /** The Add Model dialog's reaction to progress of the download it started. */
  let pullView: { id: string; update(): void } | null = null;

  /** The context given to `init`; commands only run after it. */
  function app(): CodePadCtx {
    if (!appCtx) {
      throw new Error('The ai-models feature is not initialized.');
    }
    return appCtx;
  }

  const isRemote = (entry: CpAiModelEntry): boolean => REMOTE_KINDS.has(entry.kind);
  const typeLabel = (entry: CpAiModelEntry): string => (entry.builtin ? 'Default' : isRemote(entry) ? 'Cloud' : 'Local');

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

  function button(label: string, onClick: () => unknown, className = 'cp-button'): HTMLButtonElement {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function errorText(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return typeof error === 'string' ? error : 'The request failed.';
  }

  /** Message of a `{ok:false}` answer, or '' for success. */
  function failure(result: CpAiResult | null | undefined): string {
    if (result && result.ok === false) {
      return result.message || 'The request failed.';
    }
    return '';
  }

  /** Runs an IPC call; failures (rejected or `{ok:false}`) go to the status bar. Returns the result or null. */
  async function run<T extends CpAiResult>(promise: Promise<T>): Promise<Exclude<T, CpAiFailure> | null> {
    try {
      const result = await promise;
      const problem = failure(result);
      if (problem) {
        app().status.set(problem);
        return null;
      }
      return result as Exclude<T, CpAiFailure>;
    } catch (error) {
      app().status.set(errorText(error));
      return null;
    }
  }

  function applyList(list: CpAiModelEntry[] | null): void {
    if (list) {
      models = list;
      refresh();
    }
  }

  async function reload(): Promise<void> {
    const result = await run(app().ai.models.list());
    applyList(result ? result.models : null);
  }

  // ---- status badge --------------------------------------------------------

  function refreshBadge(): void {
    const active = models.find((entry) => entry.active && !entry.builtin && entry.enabled !== false);
    if (!active) {
      if (badge) {
        badge.dispose();
        badge = null;
      }
      return;
    }
    if (!badge) {
      badge = app().status.addItem({ id: 'ai-model-active', order: 2, onClick: () => app().commands.execute('ai.manageModels') });
    }
    const cloud = isRemote(active);
    badge.set(`${cloud ? 'Cloud: ' : 'Model: '}${active.label}`, {
      title: cloud
        ? `Summaries are sent to ${active.label} (cloud). Click to manage models.`
        : `Summaries use ${active.label}. Click to manage models.`,
      state: cloud ? 'cloud' : 'ready',
    });
  }

  function refresh(): void {
    refreshBadge();
    if (manager) {
      manager.render();
    }
  }

  // ---- pull progress -------------------------------------------------------

  function pullState(p: CpAiPullProgress): PullState {
    if (p.state === 'error') {
      return { fraction: 0, text: '', error: errorText(p.message || 'The download failed.') };
    }
    let fraction = 0;
    if (p.total !== undefined && p.total > 0) {
      fraction = (p.bytes ?? 0) / p.total;
    }
    fraction = Math.max(0, Math.min(1, fraction));
    return { fraction, text: p.state ? `${p.state} ${Math.round(fraction * 100)}%` : `${Math.round(fraction * 100)}%`, error: null };
  }

  function onAiEvent(event: CpAiEvent): void {
    if (event.type === 'models') {
      applyList(event.models);
    } else if (event.type === 'pull') {
      const state = pullState(event.progress);
      if (event.progress.state === 'done' || event.progress.state === 'cancelled') {
        pulls.delete(event.id);
      } else {
        pulls.set(event.id, state);
      }
      refresh();
      if (pullView && pullView.id === event.id) {
        pullView.update();
      }
    }
  }

  // ---- key handling --------------------------------------------------------

  /** Saves a key; explains the env-var option when secure storage is unavailable. Returns true when saved. */
  async function saveKey(entryId: string, key: string): Promise<boolean> {
    let result: CpAiResult;
    try {
      result = await app().ai.models.setKey(entryId, key);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
      result = { ok: false, code, message: errorText(error) };
    }
    const problem = failure(result);
    if (!problem) {
      return true;
    }
    const noStorage = (!result.ok && result.code === NO_STORAGE) || problem.includes(NO_STORAGE);
    await app().ui.confirm({
      title: 'API key not saved',
      message: noStorage
        ? 'This computer has no secure storage, so CodePad will not save the key (it is never stored as plain text). ' +
          'Instead set the environment variable CODEPAD_<MODEL-ID>_API_KEY before starting CodePad; the key is then ' +
          `read by the app and never shown. (${entryId})`
        : problem,
      buttons: ['OK'],
    });
    return false;
  }

  function replaceKey(entry: CpAiModelEntry): void {
    const body = el('div', 'cp-ai-form');
    const input = el('input', 'cp-input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    body.append(el('label', 'cp-ai-field-label', `New API key for ${entry.label}`), input);
    app().ui.modal({
      title: 'Replace API key',
      body,
      buttons: [
        {
          label: 'Save key',
          primary: true,
          onClick: () => {
            const key = input.value.trim();
            input.value = '';
            if (key) {
              saveKey(entry.id, key).then((saved) => {
                if (saved) {
                  app().status.set('API key saved.');
                  return reload();
                }
                return null;
              });
            }
          },
        },
        { label: 'Cancel' },
      ],
    });
  }

  // ---- Add Model wizard ----------------------------------------------------

  function openWizard(): void {
    const added = models.filter((entry) => !entry.builtin).length;
    if (added >= MAX_ADDED_MODELS) {
      app().status.set(`You can add at most ${MAX_ADDED_MODELS} models. Remove one before adding another.`);
      return;
    }
    const body = el('div', 'cp-ai-form');
    const kindSelect = el('select', 'cp-input');
    Object.entries(KIND_LABELS)
      .filter(([kind]) => kind !== 'builtin')
      .forEach(([kind, label]) => {
        const option = el('option', '', label);
        option.value = kind;
        kindSelect.appendChild(option);
      });
    const fields = el('div', 'cp-ai-fields');
    const message = el('div', 'cp-ai-message');
    const progress = el('progress');
    progress.max = 100;
    progress.hidden = true;
    body.append(el('label', 'cp-ai-field-label', 'Model type'), kindSelect, fields, message, progress);

    const inputs: Record<string, HTMLInputElement> = {};
    const field = (name: string, labelText: string, type: string, hint?: string): HTMLInputElement => {
      const row = el('div', 'cp-ai-field');
      row.appendChild(el('label', 'cp-ai-field-label', labelText));
      const input = el('input', 'cp-input');
      input.type = type;
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (hint) {
        input.placeholder = hint;
      }
      row.appendChild(input);
      fields.appendChild(row);
      inputs[name] = input;
      return input;
    };

    function buildFields(): void {
      const kind = kindSelect.value;
      fields.replaceChildren();
      Object.keys(inputs).forEach((name) => delete inputs[name]);
      message.textContent = '';
      field('label', 'Name shown in CodePad', 'text', 'My model');
      if (kind === 'gguf-file') {
        fields.appendChild(el('p', 'cp-ai-hint', 'Saving opens a file dialog to choose the .gguf file. It runs on this computer.'));
      } else {
        const id = field('modelName', kind === 'ollama-registry' ? 'Model (name:tag)' : 'Model id', 'text');
        const list = el('datalist');
        list.id = 'cp-ai-known-ids';
        (KNOWN_IDS[kind] ?? []).forEach((value) => {
          const option = el('option');
          option.value = value;
          list.appendChild(option);
        });
        id.setAttribute('list', list.id);
        fields.appendChild(list);
        if (kind === 'ollama-registry') {
          fields.appendChild(el('p', 'cp-ai-hint', 'The model file is downloaded from registry.ollama.ai and checked with its SHA-256. It then runs on this computer.'));
        }
      }
      if (kind === 'openai-compatible') {
        field('baseUrl', 'Base URL', 'text', 'https://api.openai.com/v1');
      }
      if (kind !== 'gguf-file' && kind !== 'ollama-registry') {
        field('contextTokens', 'Context tokens (optional)', 'number', 'default');
      }
      if (KEY_KINDS.has(kind)) {
        field('key', kind === 'huggingface' ? 'Access token (optional)' : 'API key', 'password');
        fields.appendChild(el('p', 'cp-ai-hint', 'The key is encrypted and cannot be shown again after saving. Summaries then send your document text to this provider.'));
      }
    }
    kindSelect.addEventListener('change', buildFields);
    buildFields();

    function spec(): WizardSpec {
      const kind = kindSelect.value as CpAiModelKind;
      const value = (name: string): string => (inputs[name] ? inputs[name].value.trim() : '');
      const result: WizardSpec = { kind, label: value('label') };
      if (value('modelName')) {
        result.modelName = value('modelName');
      }
      if (value('baseUrl')) {
        result.baseUrl = value('baseUrl');
      }
      if (value('contextTokens')) {
        result.contextTokens = Number(value('contextTokens'));
      }
      return result;
    }

    function validate(model: WizardSpec): string {
      if (!model.label) {
        return 'Enter a name.';
      }
      if (model.kind !== 'gguf-file' && !model.modelName) {
        return 'Enter a model id.';
      }
      if (model.kind === 'openai-compatible' && !model.baseUrl) {
        return 'Enter the base URL.';
      }
      if (model.contextTokens !== undefined && !(Number.isInteger(model.contextTokens) && model.contextTokens > 0)) {
        return 'Context tokens must be a positive whole number.';
      }
      if (['anthropic', 'openai-compatible'].includes(model.kind) && !inputs.key.value.trim()) {
        return 'Enter the API key.';
      }
      return '';
    }

    let handle: CodePadModalHandle | null = null;
    let saving = false;
    let pullingId: string | null = null;

    const testButton = button('Test connection', async () => {
      const problem = validate(spec());
      if (problem && !(KEY_KINDS.has(kindSelect.value) && problem === 'Enter the API key.')) {
        message.textContent = problem;
        return;
      }
      message.textContent = 'Testing...';
      const added = await addEntry(spec());
      if (!added) {
        message.textContent = '';
        return;
      }
      const key = inputs.key ? inputs.key.value.trim() : '';
      if (key) {
        await saveKey(added.id, key);
      }
      let result: CpAiResult;
      try {
        result = await app().ai.models.test(added.id);
      } catch (error) {
        result = { ok: false, code: '', message: errorText(error) };
      }
      message.textContent = failure(result) || 'Connection works.';
      // The test entry is removed again so that only "Save" creates a model.
      await run(app().ai.models.remove(added.id));
    });

    async function save(): Promise<void> {
      if (saving) {
        return;
      }
      const model = spec();
      const problem = validate(model);
      if (problem) {
        message.textContent = problem;
        return;
      }
      saving = true;
      message.textContent = 'Saving...';
      if (model.kind === 'ollama-registry') {
        await startPull(model);
        return;
      }
      const added = await addEntry(model);
      if (!added) {
        saving = false;
        message.textContent = '';
        return;
      }
      const key = inputs.key ? inputs.key.value.trim() : '';
      if (inputs.key) {
        inputs.key.value = '';
      }
      if (key && !(await saveKey(added.id, key))) {
        await run(app().ai.models.remove(added.id));
        saving = false;
        message.textContent = 'The model was not added because its key could not be saved.';
        return;
      }
      await reload();
      handle?.close();
    }

    /** Downloads an Ollama-registry model; main adds the entry itself once the verified file is in place. */
    async function startPull(model: WizardSpec): Promise<void> {
      const ref = model.modelName ?? '';
      pullingId = ref;
      progress.hidden = false;
      progress.removeAttribute('value');
      message.textContent = 'Downloading the model...';
      pullView = {
        id: ref,
        update() {
          const state = pulls.get(ref);
          if (state && state.error) {
            message.textContent = state.error;
            progress.hidden = true;
            saving = false;
          } else if (state) {
            progress.value = state.fraction * 100;
            message.textContent = `Downloading ${ref}: ${state.text}`;
          } else {
            handle?.close();
          }
        },
      };
      const request: CpAiPullRequest = { modelName: ref, label: model.label };
      if (model.contextTokens) {
        request.contextTokens = model.contextTokens;
      }
      let reason = '';
      try {
        reason = failure(await app().ai.models.pull(request));
      } catch (error) {
        reason = errorText(error);
      }
      if (reason) {
        pullView = null;
        pullingId = null;
        saving = false;
        progress.hidden = true;
        message.textContent = `The download could not be started: ${reason}`;
      }
    }

    handle = app().ui.modal({
      title: 'Add Model',
      body,
      buttons: [
        { label: 'Save', primary: true, onClick: () => { save(); return false; } },
        { label: 'Cancel' },
      ],
      onClose: () => {
        if (pullingId !== null && pulls.has(pullingId)) {
          app().ai.models.cancelPull(pullingId).catch((error: unknown) => app().status.set(errorText(error)));
        }
        pullView = null;
        reload();
      },
    });
    // The Test button is not part of the modal's closing buttons, so it is inserted into the button row.
    const row = handle.element.querySelector<HTMLElement>('.cp-modal-buttons');
    if (row) {
      row.insertBefore(testButton, row.lastChild);
    }
    const syncTest = () => {
      testButton.hidden = kindSelect.value === 'gguf-file' || kindSelect.value === 'ollama-registry';
    };
    kindSelect.addEventListener('change', syncTest);
    syncTest();
  }

  /** Adds a model entry (main opens the file dialog for local files). Returns `{id}` or null. */
  async function addEntry(model: WizardSpec): Promise<{ id: string } | null> {
    // 'ollama-registry' specs go through startPull, never here.
    const result = await run(app().ai.models.add(model as CpAiModelSpec));
    if (!result) {
      return null;
    }
    const id = result.model.id;
    return id ? { id } : null;
  }

  // ---- Manage Models dialog ------------------------------------------------

  async function removeEntry(entry: CpAiModelEntry): Promise<void> {
    const answer = await app().ui.confirm({
      title: 'Delete model',
      message: `Delete "${entry.label}"? ${isRemote(entry) ? 'Its saved key is deleted too.' : ''}`.trim(),
      buttons: ['Delete', 'Cancel'],
    });
    if (answer === 0) {
      await run(app().ai.models.remove(entry.id));
      await reload();
    }
  }

  function renderRow(entry: CpAiModelEntry): HTMLElement {
    const row = el('div', `cp-ai-model${entry.active ? ' active' : ''}`);
    const head = el('div', 'cp-ai-model-head');
    head.appendChild(el('span', 'cp-ai-model-name', entry.label));
    head.appendChild(el('span', `cp-ai-badge ${typeLabel(entry).toLowerCase()}`, typeLabel(entry)));
    if (entry.active) {
      head.appendChild(el('span', 'cp-ai-badge used', 'Used for summaries'));
    }
    row.appendChild(head);

    const detail: string[] = [KIND_LABELS[entry.kind] || entry.kind];
    if (entry.modelName) {
      detail.push(entry.modelName);
    }
    if (entry.state) {
      detail.push(`state: ${entry.state}`);
    }
    row.appendChild(el('div', 'cp-ai-model-detail', detail.join(' - ')));

    const actions = el('div', 'cp-ai-actions');
    if (!entry.builtin) {
      const toggle = el('label', 'cp-ai-toggle');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = entry.enabled !== false;
      box.addEventListener('change', async () => {
        await run(app().ai.models.setEnabled(entry.id, box.checked));
        await reload();
      });
      toggle.append(box, el('span', '', 'Enabled'));
      actions.appendChild(toggle);
    }
    const use = el('label', 'cp-ai-toggle');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'cp-ai-active';
    radio.checked = Boolean(entry.active);
    radio.disabled = !entry.builtin && entry.enabled === false;
    radio.addEventListener('change', async () => {
      await run(app().ai.models.setActive(entry.builtin ? null : entry.id));
      await reload();
    });
    use.append(radio, el('span', '', 'Use for summaries'));
    actions.appendChild(use);

    if (KEY_KINDS.has(entry.kind)) {
      actions.appendChild(el('span', 'cp-ai-model-detail', entry.hasKey ? `Key saved (...${entry.keyHint || ''})` : 'No key saved'));
      actions.appendChild(button(entry.hasKey ? 'Replace key' : 'Set key', () => replaceKey(entry)));
    }
    if (!entry.builtin) {
      // The result is shown on the row itself: a status-bar message alone went unnoticed.
      const outcome = el('div', 'cp-ai-model-detail');
      const testButton = button('Test', async () => {
        testButton.disabled = true;
        outcome.textContent = 'Testing...';
        try {
          const result = await app().ai.models.test(entry.id);
          const problem = failure(result);
          outcome.textContent = problem ? `Test failed: ${problem}` : `Test passed: ${entry.label} is working.`;
        } catch (error) {
          outcome.textContent = `Test failed: ${errorText(error)}`;
        } finally {
          testButton.disabled = false;
        }
        app().status.set(outcome.textContent ?? '');
      });
      actions.appendChild(testButton);
      row.appendChild(outcome);
      actions.appendChild(button('Delete', () => removeEntry(entry)));
    }
    row.appendChild(actions);
    return row;
  }

  function openManager(): void {
    if (manager) {
      return;
    }
    const body = el('div', 'cp-ai-manager');
    body.appendChild(el('p', 'cp-ai-hint', 'Suggestions always use the built-in local model. Only summaries use the model selected here.'));
    const list = el('div', 'cp-ai-model-list');
    body.appendChild(list);

    app().ui.modal({
      title: 'AI Models',
      body,
      buttons: [
        { label: 'Add Model...', primary: true, onClick: () => { openWizard(); return false; } },
        {
          label: 'Use default model',
          onClick: () => {
            run(app().ai.models.setActive(null)).then(reload);
            return false;
          },
        },
        { label: 'Close' },
      ],
      onClose: () => {
        manager = null;
      },
    });
    manager = {
      render() {
        list.replaceChildren(...models.map(renderRow));
      },
    };
    manager.render();
    reload();
  }

  CodePadCommands.register({
    id: 'ai.manageModels',
    run() {
      openManager();
    },
  });

  CodePadFeatures.register('ai-models', {
    init(ctx) {
      appCtx = ctx;
      ctx.ai.onEvent(onAiEvent);
      reload();
    },
  });
})();
