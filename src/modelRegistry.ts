/**
 * Model registry (main process). Owns the list of selectable AI models, which one is active and the per-model
 * consent, persisted in the HMAC-signed `userData/models.json`. API keys live in secretStore.ts, never here.
 * The built-in Qwen3 entry is fixed; a file that fails its signature drops every user model (builtin only).
 * Local file paths are supplied by main as a separate trusted argument to `add`, never by the renderer.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isUsablePath } from './fileAccess';
import { parseModelRef } from './ollamaPull';
import { errorCode, errorMessage, type ModelLog } from './modelDownloader';
import type { SecretStore } from './secretStore';

const MODELS_FILE = 'models.json';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MODELS = 10;
const MAX_LABEL = 60;
const MAX_MODEL_NAME = 200;
const MAX_URL = 300;
const MIN_CONTEXT = 1024;
const MAX_CONTEXT = 2000000;
export const BUILTIN_ID = 'builtin-qwen3';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const OLLAMA_FILE = /^[0-9a-f]{64}\.gguf$/;
const NO_LOG: ModelLog = Object.freeze({ info() {}, warn() {}, error() {} });

/** Kind of a selectable model. */
export type ModelKind = 'builtin' | 'gguf-file' | 'ollama-registry' | 'huggingface' | 'anthropic' | 'openai-compatible';

/** Readiness of a model as shown in the model list. */
export type ModelState = 'ready' | 'disabled' | 'needsKey' | 'needsConsent' | 'missingFile';

interface KindRules {
  remote: boolean;
  path: boolean;
  fixedUrl?: string;
  urlRequired?: boolean;
  contextTokens: number;
}

/** Internal registry entry (includes the local file path; never sent to the renderer). */
export interface ModelEntry {
  id: string;
  kind: ModelKind;
  label: string;
  modelName: string;
  baseUrl: string;
  enabled: boolean;
  addedAt: number;
  contextTokens: number;
  consent: boolean;
  path: string;
}

/** Renderer-safe model entry (an element of the models list). */
export interface PublicModel {
  id: string;
  kind: ModelKind;
  label: string;
  modelName: string;
  baseUrl: string;
  enabled: boolean;
  builtin: boolean;
  active: boolean;
  hasKey: boolean;
  keyHint: string;
  consent: boolean;
  contextTokens: number;
  state: ModelState;
}

/** Renderer-supplied fields of a new model, strictly validated by `add`. */
export interface ModelSpec {
  kind: string;
  label?: string;
  modelName?: string;
  baseUrl?: string;
  contextTokens?: number;
  enabled?: boolean;
}

/** Editable fields of an existing model (renderer-supplied; the registry validates every value). */
export interface ModelPatch {
  label?: unknown;
  modelName?: unknown;
  baseUrl?: unknown;
  contextTokens?: unknown;
}

/** Everything a provider needs to call the model (main only: contains the API key and the file path). */
export interface RuntimeModel extends ModelEntry {
  apiKey: string | null;
  state: ModelState;
}

/** The parts of the integrity module the registry uses. */
export interface RegistryIntegrity {
  sign(obj: object, purpose: string): object;
  verify(obj: unknown, purpose: string): boolean;
  /** Pre-purpose signatures, accepted once so the file can be migrated. */
  verifyLegacy(obj: unknown): boolean;
}

/** Options of {@link createModelRegistry}. */
export interface ModelRegistryOptions {
  /** Electron userData directory. */
  userDataDir: string;
  secretStore: Pick<SecretStore, 'has' | 'hint' | 'get' | 'remove' | 'bindHost'>;
  integrity: RegistryIntegrity;
  log?: ModelLog;
}

/** The model registry. */
export interface ModelRegistry {
  list(): PublicModel[];
  add(spec: ModelSpec, trusted?: { path?: string }): PublicModel;
  ensureRoom(): void;
  update(id: string, patch: ModelPatch): PublicModel;
  remove(id: string): { kind: ModelKind; path: string };
  setEnabled(id: string, enabled: boolean): void;
  setActive(id: string | null | undefined): void;
  getActive(): PublicModel;
  giveConsent(id: string): void;
  runtime(id: string): RuntimeModel;
  onChange(callback: (models: PublicModel[]) => void): () => boolean;
}

/** Unvalidated entry as read from disk or supplied by the renderer. */
interface RawEntry {
  id?: unknown;
  kind?: unknown;
  label?: unknown;
  modelName?: unknown;
  baseUrl?: unknown;
  enabled?: unknown;
  addedAt?: unknown;
  contextTokens?: unknown;
  consent?: unknown;
  path?: unknown;
}
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/**
 * Per-kind rules. `remote`: sends document text to a third party (consent, key); `fixedUrl`: base URL is not
 * user-editable; `path`: needs a main-supplied file path; `urlRequired`: the user must give a base URL.
 */
const KINDS: Readonly<Record<ModelKind, KindRules>> = Object.freeze({
  builtin: { remote: false, path: false, contextTokens: 4096 },
  'gguf-file': { remote: false, path: true, contextTokens: 4096 },
  'ollama-registry': { remote: false, path: true, contextTokens: 4096 },
  huggingface: { remote: true, path: false, fixedUrl: 'https://router.huggingface.co/v1', contextTokens: 32000 },
  anthropic: { remote: true, path: false, fixedUrl: 'https://api.anthropic.com', contextTokens: 200000 },
  'openai-compatible': { remote: true, path: false, urlRequired: true, contextTokens: 128000 },
});

const BUILTIN: Readonly<ModelEntry> = Object.freeze({
  id: BUILTIN_ID,
  kind: 'builtin',
  label: 'Qwen3-0.6B (built-in)',
  modelName: 'qwen3-0.6b',
  baseUrl: '',
  enabled: true,
  addedAt: 0,
  contextTokens: KINDS.builtin.contextTokens,
  consent: true,
  path: '',
});

/** Registry failure with a machine-readable code (`E_INVALID | E_NOT_FOUND | E_BUILTIN | E_DISABLED | E_LIMIT | E_IO`). */
export class ModelRegistryError extends Error {
  code: string;

  /**
   * @param code Error code.
   * @param message Human-readable message.
   * @param options Original error.
   */
  constructor(code: string, message: string, { cause }: { cause?: unknown } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModelRegistryError';
    this.code = code;
  }
}

const invalid = (message: string): ModelRegistryError => new ModelRegistryError('E_INVALID', message);

function cleanText(value: unknown, field: string, max: number, { required = true }: { required?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw invalid(`${field} must be text.`);
  }
  const text = value.trim();
  if (CONTROL_CHARS.test(text)) {
    throw invalid(`${field} contains invalid characters.`);
  }
  if (required && !text) {
    throw invalid(`${field} is required.`);
  }
  if (text.length > max) {
    throw invalid(`${field} must be at most ${max} characters.`);
  }
  return text;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates and normalizes a base URL: http(s), no credentials, query or fragment; https unless loopback.
 * @param value Candidate URL.
 * @returns Normalized URL without a trailing slash.
 * @throws {ModelRegistryError} `E_INVALID`.
 */
function normalizeBaseUrl(value: unknown): string {
  const text = cleanText(value, 'Base URL', MAX_URL);
  let url: URL;
  try {
    url = new URL(text);
  } catch (error) {
    throw new ModelRegistryError('E_INVALID', 'Base URL is not a valid address.', { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('Base URL must start with https:// (or http:// for this computer).');
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw invalid('Base URL must use https:// unless it points to this computer.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw invalid('Base URL must not contain credentials, a query or a fragment.');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Host (with port) of a validated base URL; the value an API key is sealed to. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function validateContext(value: unknown, kind: ModelKind): number {
  if (value === undefined || value === null || value === '') {
    return KINDS[kind].contextTokens;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_CONTEXT || value > MAX_CONTEXT) {
    throw invalid(`Context size must be a whole number from ${MIN_CONTEXT} to ${MAX_CONTEXT} tokens.`);
  }
  return value;
}

function validateModelName(value: unknown, kind: ModelKind): string {
  const name = cleanText(value, 'Model name', MAX_MODEL_NAME);
  if (kind === 'ollama-registry' && !parseModelRef(name)) {
    throw invalid('Enter an Ollama model as name:tag, for example llama3.1:8b.');
  }
  return name;
}

const normalizeCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * A local model path must be absolute and pass the same syntactic checks as editor files (no UNC/network, device
 * or alternate-data-stream paths), so a forged entry cannot trigger SMB access or open a device. Pulled
 * Ollama models must be exactly `<64-hex>.gguf` inside the models directory.
 */
function validateLocalPath(value: unknown, kind: ModelKind, modelsDir: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.length > 1024 ||
    CONTROL_CHARS.test(value) ||
    !isUsablePath(value)
  ) {
    throw invalid('A local model needs a file path chosen by the application.');
  }
  if (
    kind === 'ollama-registry' &&
    (!OLLAMA_FILE.test(path.basename(value)) || normalizeCase(path.dirname(path.resolve(value))) !== normalizeCase(path.resolve(modelsDir)))
  ) {
    throw invalid('A pulled model must be a downloaded blob inside the models folder.');
  }
  return value;
}

function validateBaseUrl(kind: ModelKind, value: unknown): string {
  const rules = KINDS[kind];
  if (rules.fixedUrl) {
    if (value !== undefined && value !== null && value !== '' && normalizeBaseUrl(value) !== rules.fixedUrl) {
      throw invalid('The address of this provider cannot be changed.');
    }
    return rules.fixedUrl;
  }
  if (rules.urlRequired) {
    return normalizeBaseUrl(value);
  }
  return '';
}

/** Validates a full entry (spec fields plus trusted/internal ones) and returns a clean copy. */
function validateEntry(raw: RawEntry | null | undefined, trustedPath: unknown, modelsDir: string): ModelEntry {
  if (!raw || typeof raw !== 'object') {
    throw invalid('Invalid model.');
  }
  const rawKind = raw.kind;
  if (typeof rawKind !== 'string' || rawKind === 'builtin' || !Object.hasOwn(KINDS, rawKind)) {
    throw invalid('Unknown model type.');
  }
  const kind = rawKind as ModelKind;
  const rules = KINDS[kind];
  const id = raw.id;
  const entry: ModelEntry = {
    id: typeof id === 'string' ? id : '',
    kind,
    label: cleanText(raw.label, 'Name', MAX_LABEL),
    modelName: validateModelName(raw.modelName, kind),
    baseUrl: validateBaseUrl(kind, raw.baseUrl),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    contextTokens: validateContext(raw.contextTokens, kind),
    consent: rules.remote ? raw.consent === true : true,
    path: rules.path ? validateLocalPath(trustedPath, kind, modelsDir) : '',
  };
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id === BUILTIN_ID) {
    throw invalid('Invalid model id.');
  }
  return entry;
}

function slug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'model';
}

/**
 * Creates the registry for one userData directory and loads `models.json` synchronously.
 * @param options `secretStore` and `integrity` come from secretStore.ts and integrity.ts.
 * @returns Registry.
 */
export function createModelRegistry({ userDataDir, secretStore, integrity, log = NO_LOG }: ModelRegistryOptions): ModelRegistry {
  const file = path.join(userDataDir, MODELS_FILE);
  const modelsDir = path.join(userDataDir, 'models');
  const listeners = new Set<(models: PublicModel[]) => void>();
  /** user entries (internal shape, including `path`) */
  let entries: ModelEntry[] = [];
  /** id of the active user entry; null = builtin */
  let activeId: string | null = null;

  function load(): void {
    let data: { models?: unknown; activeId?: unknown } | null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error('not a usable models file');
      }
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown; activeId?: unknown } | null;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        log.warn(`Could not read the models file; only the built-in model is available (${errorCode(error) ?? errorMessage(error)}).`);
      }
      return;
    }
    if (!data || typeof data !== 'object') {
      log.warn('The models file failed its integrity check; added models were dropped.');
      return;
    }
    const current = integrity.verify(data, MODELS_FILE);
    if (!current && !integrity.verifyLegacy(data)) {
      log.warn('The models file failed its integrity check; added models were dropped.');
      return;
    }
    const seen = new Set<string>();
    for (const raw of ((Array.isArray(data.models) ? data.models : []) as (RawEntry | null)[]).slice(0, MAX_MODELS)) {
      try {
        const entry = validateEntry(raw, raw?.path, modelsDir);
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      } catch (error) {
        log.warn(`A stored model was ignored: ${errorMessage(error)}`);
      }
    }
    const stored = entries.find((entry) => entry.id === data.activeId);
    activeId = stored && stored.enabled ? stored.id : null;
    // A stored key sealed to another host than the entry's current one (changed baseUrl) is wiped, and consent
    // is withdrawn, exactly as an edit through `update` would do.
    for (const entry of entries) {
      if (KINDS[entry.kind].remote && !secretStore.bindHost(entry.id, hostOf(entry.baseUrl))) {
        entry.consent = false;
      }
    }
    if (!current) {
      // Signed before signatures were bound to a store: re-sign once.
      try {
        persist();
      } catch (error) {
        log.warn(`Could not re-sign the models file: ${errorMessage(error)}`);
      }
    }
  }

  function persist(): void {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      const text = JSON.stringify(integrity.sign({ version: 1, activeId, models: entries }, MODELS_FILE));
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw new ModelRegistryError('E_IO', `Could not save the model list (${errorCode(error) ?? 'error'}).`, { cause: error });
    }
  }

  function stateOf(entry: ModelEntry): ModelState {
    if (entry.kind === 'builtin') {
      return 'ready';
    }
    if (!entry.enabled) {
      return 'disabled';
    }
    if (KINDS[entry.kind].remote) {
      if (!secretStore.has(entry.id)) {
        return 'needsKey';
      }
      return entry.consent ? 'ready' : 'needsConsent';
    }
    return fs.existsSync(entry.path) ? 'ready' : 'missingFile';
  }

  function publicView(entry: ModelEntry): PublicModel {
    const remote = KINDS[entry.kind].remote;
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      modelName: entry.modelName,
      baseUrl: entry.baseUrl,
      enabled: entry.enabled,
      builtin: entry.kind === 'builtin',
      active: entry.kind === 'builtin' ? activeId === null : entry.id === activeId,
      hasKey: remote ? secretStore.has(entry.id) : false,
      keyHint: remote ? secretStore.hint(entry.id) : '',
      consent: entry.consent,
      contextTokens: entry.contextTokens,
      state: stateOf(entry),
    };
  }

  function find(id: string): ModelEntry {
    if (id === BUILTIN_ID) {
      return BUILTIN;
    }
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
      throw new ModelRegistryError('E_NOT_FOUND', 'That model does not exist.');
    }
    return entry;
  }

  function findUser(id: string): ModelEntry {
    if (id === BUILTIN_ID) {
      throw new ModelRegistryError('E_BUILTIN', 'The built-in model cannot be changed.');
    }
    return find(id);
  }

  const list = (): PublicModel[] => [BUILTIN, ...entries].map(publicView);

  function emit(): void {
    const snapshot = list();
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn(`Model list listener failed: ${errorMessage(error)}`);
      }
    });
  }

  /** Applies `mutate` to the state, saves, and rolls back when saving fails. */
  function commit(mutate: () => void): void {
    const before = { entries, activeId };
    try {
      mutate();
      persist();
    } catch (error) {
      ({ entries, activeId } = before);
      throw error;
    }
    emit();
  }

  function newId(label: string): string {
    for (;;) {
      const id = `${slug(label)}-${crypto.randomBytes(3).toString('hex')}`;
      if (id !== BUILTIN_ID && !entries.some((entry) => entry.id === id)) {
        return id;
      }
    }
  }

  load();

  return {
    /** Renderer-safe list: builtin first, no secrets and no paths. `state`: ready | disabled | needsKey | needsConsent | missingFile. */
    list,

    /**
     * Checks that another model can be added (the built-in one does not count), so callers can refuse before a download.
     * @throws {ModelRegistryError} `E_LIMIT` when MAX_MODELS added models exist.
     */
    ensureRoom(): void {
      if (entries.length >= MAX_MODELS) {
        throw new ModelRegistryError('E_LIMIT', `At most ${MAX_MODELS} models can be added. Remove one first.`);
      }
    },

    /**
     * Adds a model.
     * @param spec Renderer-supplied fields, strictly validated. `kind` is any kind except `builtin`.
     * @param trusted Main-supplied data: the absolute file path of `gguf-file` / `ollama-registry` models.
     * @returns The new entry as in `list()`. The key is stored separately with secretStore.set(id, key).
     * @throws {ModelRegistryError} `E_INVALID`, `E_LIMIT`, `E_IO`.
     */
    add(spec: ModelSpec, trusted: { path?: string } = {}): PublicModel {
      if (!spec || typeof spec !== 'object') {
        throw invalid('Invalid model.');
      }
      this.ensureRoom();
      const label = cleanText(spec.label, 'Name', MAX_LABEL);
      const entry = validateEntry(
        { ...spec, label, id: newId(label), addedAt: Date.now(), consent: false },
        trusted?.path,
        modelsDir,
      );
      commit(() => {
        entries = [...entries, entry];
      });
      return publicView(entry);
    },

    /**
     * Edits label, contextTokens and (remote kinds) modelName / baseUrl. Changing the base URL resets consent and
     * deletes the stored key, so a key is never sent to an address the user did not enter it for.
     * @param id Model id.
     * @param patch Fields to change.
     * @returns The updated entry as in `list()`.
     * @throws {ModelRegistryError} `E_INVALID`, `E_NOT_FOUND`, `E_BUILTIN`, `E_IO`.
     */
    update(id: string, patch: ModelPatch): PublicModel {
      const current = findUser(id);
      if (!patch || typeof patch !== 'object') {
        throw invalid('Invalid changes.');
      }
      const rules = KINDS[current.kind];
      const allowed = rules.remote ? ['label', 'modelName', 'baseUrl', 'contextTokens'] : ['label', 'contextTokens'];
      if (Object.keys(patch).some((field) => !allowed.includes(field))) {
        throw invalid('Some of those fields cannot be changed.');
      }
      const next = validateEntry({ ...current, ...patch }, current.path, modelsDir);
      const urlChanged = next.baseUrl !== current.baseUrl;
      if (urlChanged) {
        next.consent = false;
      }
      commit(() => {
        entries = entries.map((entry) => (entry.id === id ? next : entry));
      });
      if (urlChanged) {
        secretStore.remove(id);
        emit();
      }
      return publicView(next);
    },

    /**
     * Removes a model and deletes its stored key. If it was active, the builtin becomes active.
     * @param id Model id.
     * @returns Kind and local file path of the removed entry, so main can delete a pulled `ollama-registry` file
     *   (never a user's own `gguf-file`).
     * @throws {ModelRegistryError} `E_NOT_FOUND`, `E_BUILTIN`, `E_IO`.
     */
    remove(id: string): { kind: ModelKind; path: string } {
      const current = findUser(id);
      commit(() => {
        entries = entries.filter((entry) => entry.id !== id);
        if (activeId === id) {
          activeId = null;
        }
      });
      secretStore.remove(id);
      return { kind: current.kind, path: current.path };
    },

    /**
     * Enables or disables a model. Disabling the active model reverts to the builtin.
     * @param id Model id (not the builtin).
     * @param enabled New state.
     * @throws {ModelRegistryError} `E_NOT_FOUND`, `E_BUILTIN`, `E_IO`.
     */
    setEnabled(id: string, enabled: boolean): void {
      const current = findUser(id);
      const value = enabled === true;
      commit(() => {
        entries = entries.map((entry) => (entry.id === id ? { ...current, enabled: value } : entry));
        if (!value && activeId === id) {
          activeId = null;
        }
      });
    },

    /**
     * Selects the model used for summaries.
     * @param id Model id; null (or the builtin id) selects the builtin.
     * @throws {ModelRegistryError} `E_NOT_FOUND`, `E_DISABLED`, `E_IO`.
     */
    setActive(id: string | null | undefined): void {
      const target = id === null || id === undefined || id === BUILTIN_ID ? null : find(id);
      if (target && !target.enabled) {
        throw new ModelRegistryError('E_DISABLED', 'Enable this model before using it.');
      }
      commit(() => {
        activeId = target ? target.id : null;
      });
    },

    /** The active model as in `list()` (the builtin when no added model is active). */
    getActive(): PublicModel {
      return publicView(activeId ? find(activeId) : BUILTIN);
    },

    /**
     * Records the user's consent to send document text to a remote model.
     * @param id Model id; a no-op for local kinds.
     * @throws {ModelRegistryError} `E_NOT_FOUND`, `E_BUILTIN`, `E_IO`.
     */
    giveConsent(id: string): void {
      const current = findUser(id);
      if (!KINDS[current.kind].remote || current.consent) {
        return;
      }
      commit(() => {
        entries = entries.map((entry) => (entry.id === id ? { ...current, consent: true } : entry));
      });
    },

    /**
     * Everything a provider needs to call the model. MAIN ONLY: contains the API key and the file path.
     * @param id Model id (the builtin is accepted).
     * @returns Entry plus key.
     * @throws {ModelRegistryError} `E_NOT_FOUND`.
     */
    runtime(id: string): RuntimeModel {
      const entry = find(id);
      const remote = KINDS[entry.kind].remote;
      return { ...entry, apiKey: remote ? secretStore.get(entry.id, hostOf(entry.baseUrl)) : null, state: stateOf(entry) };
    },

    /**
     * Subscribes to changes.
     * @param callback Called with `list()` after every change.
     * @returns Unsubscribe function.
     */
    onChange(callback: (models: PublicModel[]) => void): () => boolean {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
