/**
 * API key store (main process). Keys are encrypted with Electron safeStorage into `userData/secrets.json`
 * (mode 0600, atomic write). There is no plaintext fallback: without OS encryption `set` refuses to store a key.
 * `get` is for main only; the renderer can learn just whether a key exists and its last four characters.
 * Environment variable `CODEPAD_<ID>_API_KEY` is read as a fallback source (stored keys win).
 */

import * as fs from 'fs';
import * as path from 'path';

const SECRETS_FILE = 'secrets.json';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SECRETS = 200;
const KEY_MIN = 8;
const KEY_MAX = 512;
const HINT_LENGTH = 4;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[\x21-\x7e]+$/; // printable ASCII without whitespace
/** Minimal logger the store needs. */
export interface SecretStoreLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The parts of Electron's `safeStorage` the store uses (injected so the store can be tested). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Options of {@link createSecretStore}. */
export interface SecretStoreOptions {
  userDataDir: string;
  safeStorage: SafeStorageLike;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  log?: SecretStoreLog;
}

/** The API key store. */
export interface SecretStore {
  isAvailable(): boolean;
  envVarName(id: string): string;
  /** `host` seals the key to that host; without it the key stays unbound until `bindHost`/`get` binds it. */
  set(id: string, key: string, host?: string): void;
  has(id: string): boolean;
  hint(id: string): string;
  /** With `host`, a stored key sealed to another host is refused (and wiped) instead of returned. */
  get(id: string, host?: string): string | null;
  /** Seals an unbound stored key to `host`; wipes it and returns false when it is sealed to a different host. */
  bindHost(id: string, host: string): boolean;
  remove(id: string): void;
}

/** Marks a stored secret that carries its host (`cps2\n<host>\n<key>`); older entries are the bare key (unbound). */
const SEAL_PREFIX = 'cps2\n';

interface Unsealed {
  host: string;
  key: string;
}

function unseal(plain: string): Unsealed | null {
  if (!plain.startsWith(SEAL_PREFIX)) {
    return { host: '', key: plain };
  }
  const rest = plain.slice(SEAL_PREFIX.length);
  const split = rest.indexOf('\n');
  return split < 0 ? null : { host: rest.slice(0, split), key: rest.slice(split + 1) };
}

const NO_LOG: SecretStoreLog = Object.freeze({ info() {}, warn() {}, error() {} });

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Secret store failure with a machine-readable code (`E_NO_SECURE_STORAGE | E_INVALID_ID | E_INVALID_KEY | E_IO`). */
export class SecretStoreError extends Error {
  code: string;

  /**
   * @param code Error code.
   * @param message Human-readable message (never contains key material).
   * @param options Original error.
   */
  constructor(code: string, message: string, { cause }: { cause?: unknown } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

/**
 * Name of the environment variable that supplies the key of a model id.
 * @param id Model id.
 * @returns `CODEPAD_<ID>_API_KEY` with the id upper-cased and every non-alphanumeric character as `_`.
 */
export function envVarName(id: string): string {
  return `CODEPAD_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new SecretStoreError('E_INVALID_ID', 'Invalid model id.');
  }
}

/**
 * Checks an API key: a string of 8..512 printable ASCII characters without whitespace.
 * @param key Candidate key.
 * @returns The key.
 * @throws {SecretStoreError} `E_INVALID_KEY`.
 */
export function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < KEY_MIN || key.length > KEY_MAX || !KEY_PATTERN.test(key)) {
    throw new SecretStoreError(
      'E_INVALID_KEY',
      `An API key must be ${KEY_MIN} to ${KEY_MAX} characters long, without spaces or non-ASCII characters.`,
    );
  }
  return key;
}

/**
 * Creates the secret store for one userData directory.
 * @param options `safeStorage` is Electron's module (injected so the store can be tested); `env` defaults to
 *   `process.env`.
 * @returns Store.
 */
export function createSecretStore({ userDataDir, safeStorage, env = process.env, log = NO_LOG }: SecretStoreOptions): SecretStore {
  const file = path.join(userDataDir, SECRETS_FILE);
  /** id -> base64 ciphertext */
  let items: Record<string, string> = Object.create(null) as Record<string, string>;

  function load() {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error('not a usable secrets file');
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { items?: unknown } | null;
      const raw: Record<string, unknown> =
        data && typeof data === 'object' && data.items && typeof data.items === 'object' ? (data.items as Record<string, unknown>) : {};
      for (const [id, value] of Object.entries(raw).slice(0, MAX_SECRETS)) {
        if (ID_PATTERN.test(id) && typeof value === 'string' && /^[A-Za-z0-9+/=]+$/.test(value)) {
          items[id] = value;
        }
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        log.warn(`Could not read the secrets file; stored API keys are ignored (${errorCode(error) ?? errorMessage(error)}).`);
      }
      items = Object.create(null) as Record<string, string>;
    }
  }

  function save() {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, items }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw new SecretStoreError('E_IO', `Could not save the API key (${errorCode(error) ?? 'error'}).`, { cause: error });
    }
  }

  function seal(key: string, host: string): string {
    return safeStorage.encryptString(`${SEAL_PREFIX}${host}\n${key}`).toString('base64');
  }

  function decryptStored(id: string): Unsealed | null {
    const value = items[id];
    if (!value || !safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      return unseal(safeStorage.decryptString(Buffer.from(value, 'base64')));
    } catch (error) {
      // Encrypted for another user or machine: unusable here, the user has to enter the key again.
      log.warn(`A stored API key could not be decrypted (${errorMessage(error)}).`);
      return null;
    }
  }

  function fromEnv(id: string): string | null {
    const value = env[envVarName(id)];
    return typeof value === 'string' && value.trim() && KEY_PATTERN.test(value.trim()) ? value.trim() : null;
  }

  function remove(id: string): void {
    if (typeof id === 'string' && id in items) {
      const previous = items[id];
      delete items[id];
      try {
        save();
      } catch (error) {
        items[id] = previous;
        throw error;
      }
    }
  }

  function bindHost(id: string, host: string): boolean {
    const stored = decryptStored(id);
    if (!stored || stored.host === host) {
      return true;
    }
    if (stored.host !== '') {
      log.warn(`The API key of a model was sealed to another host and has been removed (${id}).`);
      try {
        remove(id);
      } catch (error) {
        log.warn(`Could not remove the API key (${errorMessage(error)}).`);
      }
      return false;
    }
    const previous = items[id];
    items[id] = seal(stored.key, host);
    try {
      save();
    } catch (error) {
      // The key stays unbound; binding is retried on the next use.
      items[id] = previous;
      log.warn(`Could not bind an API key to its host (${errorMessage(error)}).`);
    }
    return true;
  }

  load();

  return {
    /** True when keys can be stored (OS encryption exists). Environment variables work regardless. */
    isAvailable: (): boolean => safeStorage.isEncryptionAvailable(),

    envVarName,

    /**
     * Encrypts and stores the key of a model.
     * @param {string} id Model id.
     * @param {string} key API key.
     * @throws {SecretStoreError} `E_NO_SECURE_STORAGE` (nothing is stored), `E_INVALID_ID`, `E_INVALID_KEY`, `E_IO`.
     */
    set(id: string, key: string, host = ''): void {
      assertId(id);
      validateKey(key);
      if (!safeStorage.isEncryptionAvailable()) {
        throw new SecretStoreError(
          'E_NO_SECURE_STORAGE',
          `Secure storage is not available on this system, so the key cannot be saved. Set the environment variable ${envVarName(id)} instead.`,
        );
      }
      if (!(id in items) && Object.keys(items).length >= MAX_SECRETS) {
        throw new SecretStoreError('E_IO', 'Too many stored API keys.');
      }
      const previous = items[id];
      items[id] = seal(key, host);
      try {
        save();
      } catch (error) {
        if (previous === undefined) {
          delete items[id];
        } else {
          items[id] = previous;
        }
        throw error;
      }
    },

    /** True when a stored or environment key exists for the id. */
    has(id: string): boolean {
      return typeof id === 'string' && ID_PATTERN.test(id) && (id in items || fromEnv(id) !== null);
    },

    /** Last four characters of the key ('' when there is none); never more. */
    hint(id: string): string {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        return '';
      }
      const key = decryptStored(id)?.key ?? fromEnv(id);
      return key ? key.slice(-HINT_LENGTH) : '';
    },

    /**
     * The key, for main only (provider calls). Stored key first, then the environment variable; null when none.
     * With `host`, a stored key sealed to a different host is wiped and null is returned (no environment fallback).
     */
    get(id: string, host?: string): string | null {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        return null;
      }
      if (host !== undefined && id in items && !bindHost(id, host)) {
        return null;
      }
      return decryptStored(id)?.key ?? fromEnv(id);
    },

    bindHost(id: string, host: string): boolean {
      return typeof id === 'string' && ID_PATTERN.test(id) ? bindHost(id, host) : true;
    },

    /** Deletes the stored key (the environment variable is untouched). A missing key is not an error. */
    remove,
  };
}
