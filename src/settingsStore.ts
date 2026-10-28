import * as userStore from './userStore';

// The shared schema is a UMD script (also loaded by the renderer), so main loads it with require.
const schema: CodePadSettingsSchemaApi = require('./shared/settingsSchema');

const SETTINGS_FILE = 'settings.json';
const MAX_PATCH_KEYS = 60;

let values: SettingsValues = schema.defaults();
let fresh = false;
let hooks: SettingsValidateHooks = {};
let onChange: () => void = () => {};

/** Options of `load`. */
export interface SettingsLoadOptions {
  isKnownCommand: (id: string) => boolean;
  /** Runs after every applied patch. */
  onChange: () => void;
}

/**
 * Loads settings.json (unknown keys dropped, invalid values reset to their default).
 * @param options `onChange` runs after a patch.
 */
async function load(options: SettingsLoadOptions): Promise<void> {
  hooks = { isKnownCommand: options.isKnownCommand };
  onChange = options.onChange;
  // A file that fails its signature (or predates signing) is ignored: defaults apply until the next patch re-signs it.
  const { data, integrity } = await userStore.readJson(SETTINGS_FILE, { signed: true });
  fresh = integrity === 'none';
  values = schema.sanitize(integrity === 'ok' ? data : null, hooks);
}

/** The full validated settings object (a copy). */
function get(): SettingsValues {
  return { ...values };
}

/** True until the first successful patch when no settings file existed (drives the localStorage migration). */
function isFresh(): boolean {
  return fresh;
}

/**
 * Validates and applies a partial update; unknown keys are ignored and invalid values fall back to the default.
 * @param raw Key/value pairs (at most 60).
 * @returns The full settings object after the update.
 */
async function patch(raw: unknown): Promise<SettingsValues> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid settings update.');
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_PATCH_KEYS) {
    throw new Error('Too many settings in one update.');
  }
  const next: Record<string, SettingValue> = { ...values };
  for (const [key, value] of entries) {
    if (Object.hasOwn(schema.SCHEMA, key)) {
      const result = schema.validate(key, value, hooks);
      next[key] = result.ok ? result.value : (schema.defaults() as Record<string, SettingValue>)[key];
    }
  }
  values = next as SettingsValues;
  fresh = false;
  await userStore.writeJson(SETTINGS_FILE, values, { signed: true });
  onChange();
  return get();
}

export { load, get, isFresh, patch };
