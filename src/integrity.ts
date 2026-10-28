import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

const KEY_FILE = 'store.key';
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/** JSON with sorted keys and without undefined values, so a signature does not depend on property order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeKeyFile(keyPath: string, key: Buffer): void {
  const hex = key.toString('hex');
  const body = safeStorage.isEncryptionAvailable()
    ? { version: 1, wrapped: true, data: safeStorage.encryptString(hex).toString('base64') }
    : { version: 1, wrapped: false, data: hex };
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, JSON.stringify(body), { mode: 0o600 });
}

interface KeyFileBody {
  version: number;
  wrapped: boolean;
  data: string;
}

/** Outcome of reading the key file: a usable key, no file, a file to set aside, or a file to leave untouched. */
type KeyRead =
  | { state: 'ok'; key: Buffer }
  | { state: 'missing' }
  | { state: 'reject'; reason: string }
  | { state: 'unavailable'; reason: string };

function readKeyFile(keyPath: string): KeyRead {
  let text: string;
  try {
    text = fs.readFileSync(keyPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unavailable', reason: 'the key file could not be read' };
  }
  let body: KeyFileBody | null;
  try {
    body = JSON.parse(text) as KeyFileBody | null;
  } catch {
    return { state: 'reject', reason: 'the key file is corrupt' };
  }
  if (!body || typeof body.data !== 'string') {
    return { state: 'reject', reason: 'the key file is malformed' };
  }
  const encryption = safeStorage.isEncryptionAvailable();
  let hex: string;
  if (body.wrapped === true) {
    if (!encryption) {
      // Possibly a locked keyring: leave the file alone rather than destroy a valid key.
      return { state: 'unavailable', reason: 'the key file is wrapped but OS encryption is not available' };
    }
    try {
      hex = safeStorage.decryptString(Buffer.from(body.data, 'base64'));
    } catch {
      return { state: 'reject', reason: 'the key file cannot be decrypted by this user or machine' };
    }
  } else if (encryption) {
    // A plaintext key where the OS keystore exists is a downgrade: never trusted.
    return { state: 'reject', reason: 'the key file is not wrapped although OS encryption is available' };
  } else {
    hex = body.data;
  }
  return /^[0-9a-f]{64}$/.test(hex)
    ? { state: 'ok', key: Buffer.from(hex, 'hex') }
    : { state: 'reject', reason: 'the key file holds an invalid key' };
}

/** Moves an untrusted key file aside (never deletes it); false when that failed. */
function setAside(keyPath: string): boolean {
  try {
    fs.renameSync(keyPath, `${keyPath}.rejected-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The signing key: random, stored in userData wrapped by the OS keystore when available (tamper-evident only otherwise).
 * Fails closed: an untrusted key file is renamed aside and replaced, so every signed store fails its check and
 * tampering stays visible. If the file cannot be handled safely, a temporary in-memory key is used and nothing is
 * written, which also fails every signed store for this run.
 */
function getKey(): Buffer {
  if (!cachedKey) {
    const keyPath = path.join(app.getPath('userData'), KEY_FILE);
    const read = readKeyFile(keyPath);
    if (read.state === 'ok') {
      cachedKey = read.key;
    } else {
      cachedKey = crypto.randomBytes(KEY_BYTES);
      if (read.state === 'missing') {
        writeKeyFile(keyPath, cachedKey);
      } else if (read.state === 'reject' && setAside(keyPath)) {
        console.warn(`Signing key rejected (${read.reason}); it was set aside and a new one created. Signed stores fail their integrity check.`);
        writeKeyFile(keyPath, cachedKey);
      } else {
        console.warn(`Signing key not trusted (${read.reason}); a temporary key is used. Signed stores fail their integrity check this run.`);
      }
    }
  }
  return cachedKey;
}

/** HMAC over the body bound to a purpose (one per store), so a blob signed for one store is useless in another. */
function mac(value: unknown, purpose: string): string {
  return crypto.createHmac('sha256', getKey()).update(`codepad-store-v2\0${purpose}\0${stableStringify(value)}`).digest('hex');
}

/** The signature used before purposes existed; accepted only to migrate existing stores. */
function legacyMac(value: unknown): string {
  return crypto.createHmac('sha256', getKey()).update(stableStringify(value)).digest('hex');
}

/**
 * Returns a copy of `obj` carrying an HMAC-SHA256 signature in `sig`.
 * @param obj Plain JSON-serializable object.
 * @param purpose Identifier of the store the signature is bound to (e.g. its file name).
 */
function sign<T extends object>(obj: T, purpose: string): T & { sig: string } {
  const { sig: _ignored, ...body } = obj as T & { sig?: unknown };
  return { ...(body as T), sig: mac(body, purpose) };
}

function checkSig(obj: unknown, compute: (body: Record<string, unknown>) => string): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const { sig, ...body } = obj as Record<string, unknown>;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(compute(body), 'hex'));
}

/**
 * Checks the `sig` of an object produced by `sign` for the same purpose (after a JSON round trip).
 * @returns False for a missing, malformed or wrong signature, or one made for another purpose.
 */
function verify(obj: unknown, purpose: string): boolean {
  return checkSig(obj, (body) => mac(body, purpose));
}

/**
 * Checks a signature made before purposes existed. Callers use it once to migrate a store and must re-sign it
 * with `sign` right away.
 */
function verifyLegacy(obj: unknown): boolean {
  return checkSig(obj, legacyMac);
}

export { sign, verify, verifyLegacy };
