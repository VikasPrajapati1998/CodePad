import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { isErrnoCode } from './errorUtils';
import * as integrity from './integrity';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MACROS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECENT = 30;
const MAX_MACROS = 100;
const MAX_MACRO_STEPS = 5000;
const MAX_MACRO_NAME = 60;
const MAX_TYPE_TEXT = 10000;
const MAX_STEP_ARGS_BYTES = 1024;
const MAX_COMMAND_ID = 80;
const STORE_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?\.json$/;
const MACRO_KEY = /^(?:(?:ctrl|shift)\+){0,2}(?:left|right|up|down|home|end|pageUp|pageDown|backspace|delete|enter|tab)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Serializes writes per file so overlapping saves never share a temp file. */
const writeQueues = new Map<string, Promise<void>>();

/** Options of `readJson` and `writeJson`. */
export interface StoreOptions {
  /** Signs on write and verifies the HMAC signature on read. */
  signed?: boolean;
  maxBytes?: number;
}

/** Result of `readJson`. */
export interface StoredJson {
  data: Record<string, unknown> | null;
  integrity: 'ok' | 'failed' | 'none';
}

function resolveName(name: unknown): string {
  if (typeof name !== 'string' || !STORE_NAME.test(name)) {
    throw new Error('Invalid store name.');
  }
  return path.join(app.getPath('userData'), ...name.split('/'));
}

/**
 * Reads a JSON file from userData.
 * @param name File name, optionally inside one sub-folder (e.g. `sessions/<id>.json`).
 * @param options `signed` verifies the HMAC signature.
 * @returns `none`: no file; `failed`: unreadable, oversized or corrupt (data null) or badly signed
 *   (data is the unverified content: use it only for non-path data).
 */
async function readJson(
  name: string,
  { signed = false, maxBytes = DEFAULT_MAX_BYTES }: StoreOptions = {},
): Promise<StoredJson> {
  const file = resolveName(name);
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > maxBytes) {
      return { data: null, integrity: 'failed' };
    }
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { data: null, integrity: isErrnoCode(error, 'ENOENT') ? 'none' : 'failed' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { data: null, integrity: 'failed' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data: null, integrity: 'failed' };
  }
  const record = data as Record<string, unknown>;
  if (!signed || integrity.verify(record, name)) {
    return { data: record, integrity: 'ok' };
  }
  if (integrity.verifyLegacy(record)) {
    // Signed before signatures were bound to a store: valid once, re-signed right away. If the rewrite fails the
    // legacy signature is simply accepted again on the next run.
    const { sig: _legacySig, ...body } = record;
    writeJson(name, body, { signed: true, maxBytes }).catch(() => {});
    return { data: record, integrity: 'ok' };
  }
  return { data: record, integrity: 'failed' };
}

async function writeNow(name: string, value: object, { signed, maxBytes }: Required<StoreOptions>): Promise<void> {
  const file = resolveName(name);
  const text = JSON.stringify(signed ? integrity.sign(value, name) : value);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`${name} is too large to store.`);
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Atomically writes a JSON file into userData (temp file + rename, mode 0o600).
 * @param name File name as for `readJson`.
 * @param value Serializable object.
 */
function writeJson(
  name: string,
  value: object,
  { signed = false, maxBytes = DEFAULT_MAX_BYTES }: StoreOptions = {},
): Promise<void> {
  const previous = writeQueues.get(name) || Promise.resolve();
  const run = previous.then(() => writeNow(name, value, { signed, maxBytes }));
  const tail = run.catch(() => {});
  writeQueues.set(name, tail);
  tail.then(() => {
    if (writeQueues.get(name) === tail) {
      writeQueues.delete(name);
    }
  });
  return run;
}

/** Names of the `.json` files in a userData sub-folder (empty when it does not exist). */
async function listNames(folder: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(folder)) {
    throw new Error('Invalid store folder.');
  }
  try {
    const entries = await fs.readdir(path.join(app.getPath('userData'), folder), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

/** Deletes a stored file; a missing file is not an error. */
async function remove(name: string): Promise<void> {
  await fs.rm(resolveName(name), { force: true });
}

const cleanText = (value: unknown, max: number): string => String(value).replace(CONTROL_CHARS, '').trim().slice(0, max);

// ---------- Recent files ----------

interface RecentEntry {
  path: string;
  openedAt: number;
}

const RECENT_FILE = 'recent.json';
let recentItems: RecentEntry[] = [];
let recentUsable: (p: string) => boolean = () => true;
const normalizeKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Loads the signed recent list; a list that fails verification is discarded. */
async function loadRecent(isUsablePath: (p: string) => boolean): Promise<void> {
  recentUsable = isUsablePath;
  const { data, integrity: state } = await readJson(RECENT_FILE, { signed: true });
  recentItems = [];
  if (state === 'ok' && data && Array.isArray(data.items)) {
    for (const item of data.items.slice(0, MAX_RECENT) as Array<{ path?: unknown; openedAt?: unknown } | null>) {
      if (item && typeof item.path === 'string' && recentUsable(item.path)) {
        recentItems.push({
          path: item.path,
          openedAt: typeof item.openedAt === 'number' && Number.isFinite(item.openedAt) ? item.openedAt : 0,
        });
      }
    }
  }
}

function persistRecent(): Promise<void> {
  return writeJson(RECENT_FILE, { version: 1, items: recentItems }, { signed: true });
}

const recent = {
  load: loadRecent,
  list: (): CpRecentItem[] => recentItems.map((item) => ({ ...item, name: path.basename(item.path) })),
  /** Puts a main-verified real path first in the list. */
  async add(realPath: string): Promise<void> {
    const key = normalizeKey(realPath);
    recentItems = [
      { path: realPath, openedAt: Date.now() },
      ...recentItems.filter((item) => normalizeKey(item.path) !== key),
    ].slice(0, MAX_RECENT);
    await persistRecent();
  },
  async remove(realPath: string): Promise<void> {
    const key = normalizeKey(realPath);
    recentItems = recentItems.filter((item) => normalizeKey(item.path) !== key);
    await persistRecent();
  },
  async clear(): Promise<void> {
    recentItems = [];
    await persistRecent();
  },
};

// ---------- Macros ----------

const MACROS_FILE = 'macros.json';

type KnownCommandCheck = (id: string) => boolean;

function normalizeStep(value: unknown, isKnownCommand: KnownCommandCheck): CpMacroStep | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.t === 'type' && typeof raw.text === 'string' && raw.text.length > 0) {
    return { t: 'type', text: raw.text.slice(0, MAX_TYPE_TEXT) };
  }
  if (raw.t === 'key' && typeof raw.key === 'string' && MACRO_KEY.test(raw.key)) {
    const modifiers = raw.key.split('+').slice(0, -1);
    return new Set(modifiers).size === modifiers.length ? { t: 'key', key: raw.key } : null;
  }
  if (raw.t === 'cmd' && typeof raw.id === 'string' && raw.id.length <= MAX_COMMAND_ID && isKnownCommand(raw.id)) {
    const step: { t: 'cmd'; id: string; args?: Record<string, unknown> } = { t: 'cmd', id: raw.id };
    if (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) {
      try {
        const text = JSON.stringify(raw.args);
        if (text.length <= MAX_STEP_ARGS_BYTES) {
          step.args = JSON.parse(text) as Record<string, unknown>;
        }
      } catch {
        // Not JSON-safe: the command runs without arguments.
      }
    }
    return step;
  }
  return null;
}

/** Validates a macro list against the step grammar; invalid macros and steps are dropped. */
function normalizeMacros(raw: unknown, isKnownCommand: KnownCommandCheck): CpMacro[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const macros: CpMacro[] = [];
  for (const item of raw.slice(0, MAX_MACROS) as Array<{ name?: unknown; steps?: unknown } | null>) {
    const name = item && typeof item.name === 'string' ? cleanText(item.name, MAX_MACRO_NAME) : '';
    if (item && name && Array.isArray(item.steps)) {
      const steps = (item.steps as unknown[])
        .slice(0, MAX_MACRO_STEPS)
        .map((step) => normalizeStep(step, isKnownCommand))
        .filter((step): step is CpMacroStep => step !== null);
      macros.push({ name, steps });
    }
  }
  return macros;
}

const macros = {
  async get(isKnownCommand: KnownCommandCheck): Promise<CpMacro[]> {
    const { data, integrity: state } = await readJson(MACROS_FILE, { signed: true, maxBytes: MACROS_MAX_BYTES });
    return state === 'ok' && data ? normalizeMacros(data.macros, isKnownCommand) : [];
  },
  async set(list: unknown, isKnownCommand: KnownCommandCheck): Promise<CpMacro[]> {
    const clean = normalizeMacros(list, isKnownCommand);
    await writeJson(MACROS_FILE, { version: 1, macros: clean }, { signed: true, maxBytes: MACROS_MAX_BYTES });
    return clean;
  },
};

export { readJson, writeJson, listNames, remove, cleanText, recent, macros };
