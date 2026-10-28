import crypto from 'crypto';
import * as fileAccess from './fileAccess';
import * as textCodec from './textCodec';
import * as userStore from './userStore';

const SESSION_FILE = 'session.json';
const NAMED_FOLDER = 'sessions';
const SESSION_ID = /^[0-9a-f]{16}$/;
const MAX_TABS = 200;
const MAX_NAMED_SESSIONS = 100;
const MAX_SESSION_NAME = 60;
const MAX_NAME_LENGTH = 255;
const MAX_LANGUAGE_LENGTH = 64;
const EOLS = new Set(['lf', 'crlf', 'cr']);
const KINDS = new Set(['text', 'docx', 'sheet', 'pdf']);

type Eol = 'lf' | 'crlf' | 'cr';
type JsonObject = Record<string, unknown>;

/** A normalized tab plus the serialized size of its document state (used for the session budget). */
interface NormalizedTab extends CpSessionTab {
  stateSize: number;
}

/** A validated session as stored and restored. */
interface NormalizedSession {
  tabs: CpSessionTab[];
  /** Indexes (in the raw tabs) of non-text tabs whose unsaved state was dropped for size. */
  lostState: number[];
}

const isRecord = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isEol = (value: unknown): value is Eol => typeof value === 'string' && EOLS.has(value);
const isKind = (value: unknown): value is CpTabKind => typeof value === 'string' && KINDS.has(value);
const MAX_BOOKMARKS = 10000;
const MAX_BOOKMARK_LINE = 10000000;
const MAX_COLOR = 5;
const MB = 1024 * 1024;
// Unsaved edits of non-text tabs (opaque, module-defined JSON): per-tab and whole-session caps in serialized bytes.
const MAX_STATE_BYTES = 16 * MB;
const MAX_TOTAL_STATE_BYTES = 64 * MB;
const MAX_TOTAL_CONTENT_CHARS = 256 * MB;
const MAX_VIEW_STATE_CHARS = 64 * 1024;
const SESSION_MAX_BYTES = 400 * MB;

/** Validates a non-text tab's state; returns the plain object (or null) and its serialized size. */
function normalizeState(raw: unknown): { state: JsonObject | null; size: number; tooLarge: boolean } {
  if (!isRecord(raw)) {
    return { state: null, size: 0, tooLarge: false };
  }
  const size = JSON.stringify(raw).length;
  return size <= MAX_STATE_BYTES ? { state: raw, size, tooLarge: false } : { state: null, size: 0, tooLarge: true };
}

function normalizeViewState(raw: unknown): JsonObject | null {
  if (!isRecord(raw)) {
    return null;
  }
  return JSON.stringify(raw).length <= MAX_VIEW_STATE_CHARS ? raw : null;
}

function normalizeBookmarks(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const lines = raw.filter(
    (line): line is number => Number.isInteger(line) && line >= 1 && line <= MAX_BOOKMARK_LINE,
  );
  return [...new Set(lines)].sort((a, b) => a - b).slice(0, MAX_BOOKMARKS);
}

const normalizeColor = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COLOR ? value : 0);

function normalizeTab(value: unknown): NormalizedTab | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as JsonObject;
  const filePath = typeof raw.path === 'string' && raw.path.length > 0 ? raw.path : null;
  const kind: CpTabKind = isKind(raw.kind) ? raw.kind : 'text';
  const isText = kind === 'text';
  const { state, size, tooLarge } = isText ? { state: null, size: 0, tooLarge: false } : normalizeState(raw.state);
  const tab: NormalizedTab = {
    kind,
    state,
    stateSize: size,
    stateTooLarge: !isText && (tooLarge || raw.stateTooLarge === true),
    path: filePath,
    name: typeof raw.name === 'string' ? raw.name.slice(0, MAX_NAME_LENGTH) : 'Untitled',
    pinned: raw.pinned === true,
    color: normalizeColor(raw.color),
    active: raw.active === true,
  };
  if (isText) {
    Object.assign(tab, {
      encoding: textCodec.isKnownEncoding(raw.encoding) ? raw.encoding : 'utf8',
      eol: isEol(raw.eol) ? raw.eol : null,
      language: typeof raw.language === 'string' ? raw.language.slice(0, MAX_LANGUAGE_LENGTH) : null,
      autoDetect: raw.autoDetect === true,
      // null = the tab matches the file on disk; a string = unsaved text to restore.
      content: typeof raw.content === 'string' ? raw.content : null,
      viewState: normalizeViewState(raw.viewState),
      readOnly: raw.readOnly === true,
      monitor: raw.monitor === true,
      bookmarks: normalizeBookmarks(raw.bookmarks),
    });
  }
  return tab;
}

/**
 * Validates a session and keeps only the tabs whose file path passes `authorizePath`.
 * @param raw Untrusted session data (from the renderer or from disk).
 * @param authorizePath Decides whether a tab's path may be kept.
 * @returns `lostState` lists the indexes (in `raw.tabs`) of non-text tabs whose unsaved state was dropped for size.
 * @throws {Error} when the data is not a session or its unsaved text exceeds the session cap.
 */
async function normalizeSession(
  raw: unknown,
  authorizePath: (filePath: string) => Promise<boolean>,
): Promise<NormalizedSession> {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as JsonObject).tabs)) {
    throw new Error('Invalid session data.');
  }
  const tabs: CpSessionTab[] = [];
  const lostState: number[] = [];
  let stateBudget = MAX_TOTAL_STATE_BYTES;
  let contentChars = 0;
  const rawTabs = ((raw as JsonObject).tabs as unknown[]).slice(0, MAX_TABS);
  for (let index = 0; index < rawTabs.length; index += 1) {
    const normalized = normalizeTab(rawTabs[index]);
    if (!normalized) {
      continue;
    }
    const { stateSize, ...tab } = normalized;
    // Documents are restored from disk, so a non-text tab without a path cannot be rebuilt.
    const valid = tab.kind === 'text' || tab.path !== null;
    if (valid && (tab.path === null || (await authorizePath(tab.path)))) {
      contentChars += typeof tab.content === 'string' ? tab.content.length : 0;
      if (contentChars > MAX_TOTAL_CONTENT_CHARS) {
        throw new Error('The unsaved text is too large to store in the session.');
      }
      if (stateSize > stateBudget) {
        tab.state = null;
        tab.stateTooLarge = true;
      } else {
        stateBudget -= stateSize;
      }
      if (tab.stateTooLarge) {
        lostState.push(index);
      }
      tabs.push(tab);
    }
  }
  return { tabs, lostState };
}

const approvePath = async (tabPath: string): Promise<boolean> => {
  try {
    await fileAccess.approveFile(tabPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Persists the open tabs (including unsaved text and document edits) and the workspace folder.
 * Only paths the user already granted access to are stored, so a restart cannot widen access.
 * @returns Indexes of tabs whose unsaved document state could not be stored.
 */
async function save(session: unknown): Promise<number[]> {
  const { lostState, ...clean } = await normalizeSession(session, fileAccess.isAllowed);
  await userStore.writeJson(
    SESSION_FILE,
    { version: 1, root: fileAccess.getApprovedRoot(), ...clean },
    { signed: true, maxBytes: SESSION_MAX_BYTES },
  );
  return lostState;
}

/**
 * Turns stored session data into a restorable session, re-granting access to its files and folder only when the
 * signature was valid; otherwise paths and the folder are dropped and just untitled text survives.
 */
async function reapprove(raw: unknown, integrityState: 'ok' | 'failed'): Promise<CpSessionRestore> {
  const trusted = integrityState === 'ok';
  const { lostState: _lostState, ...session } = await normalizeSession(
    raw,
    async (tabPath) => trusted && (await approvePath(tabPath)),
  );
  let root: string | null = null;
  const savedRoot = (raw as JsonObject).root;
  if (trusted && typeof savedRoot === 'string') {
    try {
      await fileAccess.approveRoot(savedRoot, { fromSession: true });
      root = fileAccess.getApprovedRoot();
    } catch {
      // The folder was moved or deleted: restore the tabs without it.
    }
  }
  return { root, ...session, integrity: integrityState };
}

/**
 * Reads the saved session and re-grants access to the files and folder it lists.
 * @returns null when none was saved.
 */
async function load(): Promise<CpSessionRestore | null> {
  const { data, integrity } = await userStore.readJson(SESSION_FILE, { signed: true, maxBytes: SESSION_MAX_BYTES });
  if (integrity === 'none') {
    return null;
  }
  if (!data) {
    throw new Error('The saved session file is corrupted.');
  }
  return reapprove(data, integrity);
}

// ---------- Named sessions ----------

const namedFile = (id: string): string => `${NAMED_FOLDER}/${id}.json`;

function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    throw new Error('Invalid session.');
  }
}

/** Headers of the saved named sessions whose signature is valid. */
async function listNamed(): Promise<CpNamedSession[]> {
  const names = (await userStore.listNames(NAMED_FOLDER))
    .filter((name) => SESSION_ID.test(name.slice(0, -'.json'.length)))
    .slice(0, MAX_NAMED_SESSIONS);
  const out: CpNamedSession[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    const { data, integrity } = await userStore.readJson(namedFile(id), { signed: true, maxBytes: SESSION_MAX_BYTES });
    if (integrity === 'ok' && data && typeof data.name === 'string' && isRecord(data.session) && Array.isArray(data.session.tabs)) {
      out.push({
        id,
        name: data.name,
        savedAt: typeof data.savedAt === 'number' && Number.isFinite(data.savedAt) ? data.savedAt : 0,
        tabCount: data.session.tabs.length,
      });
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Saves a snapshot under a display name (same name overwrites); returns the generated id. */
async function saveNamed(name: unknown, session: unknown): Promise<{ id: string }> {
  const clean = userStore.cleanText(typeof name === 'string' ? name : '', MAX_SESSION_NAME);
  if (!clean) {
    throw new Error('A session needs a name.');
  }
  const existing = (await listNamed()).find((item) => item.name === clean);
  if (!existing && (await listNamed()).length >= MAX_NAMED_SESSIONS) {
    throw new Error('Too many saved sessions. Delete one first.');
  }
  const id = existing ? existing.id : crypto.randomBytes(8).toString('hex');
  const { lostState: _lostState, ...stored } = await normalizeSession(session, fileAccess.isAllowed);
  await userStore.writeJson(
    namedFile(id),
    { version: 1, name: clean, savedAt: Date.now(), session: { root: fileAccess.getApprovedRoot(), ...stored } },
    { signed: true, maxBytes: SESSION_MAX_BYTES },
  );
  return { id };
}

/** Loads a named session like `load` does; null when it does not exist. */
async function loadNamed(id: unknown): Promise<CpSessionRestore | null> {
  assertSessionId(id);
  const { data, integrity } = await userStore.readJson(namedFile(id), { signed: true, maxBytes: SESSION_MAX_BYTES });
  if (integrity === 'none') {
    return null;
  }
  if (!data || !data.session) {
    throw new Error('The saved session file is corrupted.');
  }
  return reapprove(data.session, integrity);
}

async function deleteNamed(id: unknown): Promise<void> {
  assertSessionId(id);
  await userStore.remove(namedFile(id));
}

export { save, load, listNamed, saveNamed, loadNamed, deleteNamed };
