import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { FileFilter, IpcMainInvokeEvent, WebContents } from 'electron';
import fs from 'fs';
import path from 'path';
import * as chatFiles from './chatFiles';
import { errorCode, errorMessage } from './errorUtils';
import * as fileAccess from './fileAccess';
import type { FileWatcher } from './fileWatcher';
import * as menuBuilder from './menuBuilder';
import * as sessionStore from './sessionStore';
import * as settingsStore from './settingsStore';
import * as textCodec from './textCodec';
import * as userStore from './userStore';

/** Loads an optional main-side module; a missing or broken one is logged and its features stay off. */
function optionalRequire<T>(name: string): T | null {
  try {
    return require(name) as T;
  } catch (error) {
    console.error(`${name} could not be loaded: ${errorMessage(error)}`);
    return null;
  }
}

const findInFiles = optionalRequire<typeof import('./findInFiles')>('./findInFiles');
const fileWatcher = optionalRequire<typeof import('./fileWatcher')>('./fileWatcher');
const aiIpc = optionalRequire<typeof import('./aiIpc')>('./aiIpc');
const spellcheck = optionalRequire<typeof import('./spellcheck')>('./spellcheck');

/** The object `registerAiIpc` returns: settings/window hooks and `dispose`. */
type AiComposition = ReturnType<typeof import('./aiIpc').registerAiIpc>;

/** A handler for a channel that is not part of the typed contract (the ai:* stubs and the AI composition root). */
type UntypedHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** The handler of one invoke channel, typed by CpIpcChannels. */
type ChannelHandler<C extends keyof CpIpcChannels> = (
  event: IpcMainInvokeEvent,
  ...args: CpIpcChannels[C]['args']
) => CpIpcChannels[C]['result'] | Promise<CpIpcChannels[C]['result']>;

/** Paths from the command line or a second instance, with the optional `-n` line. */
interface OpenRequest {
  paths: string[];
  line?: number;
}

// `--install-model [--silent]` (run by the Windows installer) only downloads the AI model and exits.
const INSTALL_MODE = process.argv.includes('--install-model');
const INSTALL_SILENT = process.argv.includes('--silent');
const INSTALL_EXIT = Object.freeze({ OK: 0, OTHER: 1, CANCELLED: 2, OFFLINE: 3, INTEGRITY: 4, DISK: 5, LOCKED: 6 });
const INSTALL_EXIT_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  cancelled: INSTALL_EXIT.CANCELLED,
  offline: INSTALL_EXIT.OFFLINE,
  integrity: INSTALL_EXIT.INTEGRITY,
  disk: INSTALL_EXIT.DISK,
  locked: INSTALL_EXIT.LOCKED,
});
const INSTALL_LOCK_WAIT_MS = 30 * 60 * 1000;
const INSTALL_WATCHDOG_MS = 15 * 1000;
const AI_DISPOSE_TIMEOUT_MS = 5000;
const AI_UNAVAILABLE = Object.freeze({ ok: false, code: 'unavailable', message: 'The AI features are not available in this build.' });

const MAX_DIALOG_NAME = 60;
const MAX_SAVE_FILTERS = 6;
const DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'pdf'];

let mainWindow: BrowserWindow | null = null;
let closeRequested = false;
let closeApproved = false;
let rendererReady = false;
let skipSession = false;
let watcher: FileWatcher | null = null;
/** The AI composition root from aiIpc.ts, or null when the module is missing or failed to register. */
let ai: AiComposition | null = null;
let aiDisposed = false;
let aiDisposing = false;
/** Paths from the command line or a second instance that arrived before the renderer finished restoring. */
let pendingOpen: OpenRequest | null = null;

const CLIPBOARD_PERMISSIONS = new Set<string>(['clipboard-read', 'clipboard-sanitized-write']);
const MAX_ENCODING_CHECK_CHARS = 64 * 1024 * 1024;
const MAX_ARG_LENGTH = 4096;
const MAX_EXTERNAL_URL_LENGTH = 2048;
const EXTERNAL_PROTOCOLS = new Set<string>(['http:', 'https:', 'mailto:']);
const EXTERNAL_LINK_MIN_INTERVAL_MS = 1000;
const DROP_INTENT_TTL_MS = 10 * 1000;
const MAX_CONFIRM_FILES = 5;
const MAX_DROP_INTENTS = 100;
const MAX_DIALOG_URL = 200;
/** Same policy as the meta tag in renderer/index.html, enforced again as a response header. */
const APP_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; worker-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';";

/** Paths of a genuine user drop, reported by the preload; each can be approved once within a short time. */
const dropIntents = new Map<string, number>();
let lastExternalLinkAt = 0;
let externalLinkPromptOpen = false;

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

/** Logger handed to the AI modules; they log codes and messages only, never prompts, outputs or file names. */
const aiLog = Object.freeze({
  debug: () => {},
  info: (message: string) => console.log(`[ai] ${message}`),
  warn: (message: string) => console.warn(`[ai] ${message}`),
  error: (message: string) => console.error(`[ai] ${message}`),
});

/** Settings handed to the AI modules: nothing downloads on its own until the first-launch gate was answered. */
function aiSettingsView(): SettingsValues {
  const values = settingsStore.get();
  return { ...values, 'ai.autoDownload': values['ai.autoDownload'] && values['ai.setupPrompted'] };
}

/** Runs after every validated settings patch: refreshes the native menu and tells the AI modules. */
function onSettingsChanged(): void {
  rebuildMenu();
  if (ai) {
    ai.onSettingsChanged(aiSettingsView());
  }
}

/** Rebuilds the native menu from the command tables, the keybinding overrides and the recent-files list. */
function rebuildMenu(): void {
  const values = settingsStore.get();
  menuBuilder.buildMenu({
    keybindings: values.keybindings,
    values,
    recent: userStore.recent.list(),
    sendCommand: (id) => send('command', { id }),
    openRecent: (index) =>
      approveRecentAt(index)
        .then((real) => openPaths([real]))
        .catch((error: unknown) => dialog.showErrorBox('Open Recent', errorMessage(error))),
  });
}

/** Approves the file at a position of main's own recent list (never a renderer-supplied path). */
async function approveRecentAt(index: number): Promise<string> {
  const item = Number.isInteger(index) ? userStore.recent.list()[index] : undefined;
  if (!item) {
    throw new Error('That recent file is no longer in the list.');
  }
  const real = await fileAccess.approveFile(item.path);
  if (!(await fileAccess.statFile(real)).exists) {
    await userStore.recent.remove(item.path);
    rebuildMenu();
    throw new Error(`${item.name} no longer exists.`);
  }
  return real;
}

/** Sends already-approved paths to the renderer, or queues them until it finished restoring the session. */
function openPaths(paths: string[], line?: number): void {
  if (paths.length === 0) {
    return;
  }
  if (!rendererReady) {
    pendingOpen = {
      paths: [...(pendingOpen ? pendingOpen.paths : []), ...paths],
      line: pendingOpen ? pendingOpen.line : line,
    };
    return;
  }
  send('open-paths', { paths, line });
}

/** Splits command-line arguments into files, `-n<line>` and `-nosession`. */
function parseArgs(args: string[], cwd: string): { paths: string[]; line: number | undefined; noSession: boolean } {
  const parsed: { paths: string[]; line: number | undefined; noSession: boolean } = {
    paths: [],
    line: undefined,
    noSession: false,
  };
  args.forEach((arg) => {
    if (arg === '-nosession') {
      parsed.noSession = true;
    } else if (/^-n\d{1,9}$/.test(arg)) {
      parsed.line = Number(arg.slice(2));
    } else if (!arg.startsWith('-') && arg.length <= MAX_ARG_LENGTH) {
      parsed.paths.push(path.resolve(cwd, arg));
    }
  });
  return parsed;
}

/** Approves the existing regular files named on a command line; others are skipped. */
async function approveCommandLinePaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      const real = await fileAccess.approveFile(candidate);
      if ((await fileAccess.statFile(real)).exists) {
        existing.push(real);
      }
    } catch {
      // Unusable or not a file: skip it.
    }
  }
  return existing;
}

/** Asks the user before files named by another CodePad launch are approved; true when there is nothing to ask. */
async function confirmSecondInstanceOpen(paths: string[]): Promise<boolean> {
  if (paths.length === 0) {
    return true;
  }
  const listed = paths.slice(0, MAX_CONFIRM_FILES).map((item) => sanitizeForDialog(item, MAX_DIALOG_URL));
  const more = paths.length > MAX_CONFIRM_FILES ? `\n…and ${paths.length - MAX_CONFIRM_FILES} more` : '';
  const options = {
    type: 'question' as const,
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Another CodePad launch asks to open these files.',
    detail: `${listed.join('\n')}${more}`,
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** Only the app's own window may use the clipboard; every other permission is denied. */
function isAppClipboardRequest(webContents: WebContents | null, permission: string, url: string | undefined): boolean {
  return (
    CLIPBOARD_PERMISSIONS.has(permission) &&
    mainWindow !== null &&
    webContents === mainWindow.webContents &&
    typeof url === 'string' &&
    url.startsWith('file://')
  );
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(isAppClipboardRequest(webContents, permission, details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    isAppClipboardRequest(webContents, permission, details.requestingUrl),
  );
  session.defaultSession.setDevicePermissionHandler(() => false);
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['file://*'] }, (details, callback) => {
    const isAppPage = details.resourceType === 'mainFrame' && /\/renderer\/index\.html(?:[?#]|$)/.test(details.url);
    callback(
      isAppPage
        ? { responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [APP_CSP] } }
        : { responseHeaders: details.responseHeaders },
    );
  });
}

/** Whether a URL from the renderer may be offered to the user: short, http(s)/mailto, no embedded credentials. */
function parseExternalUrl(url: string): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_EXTERNAL_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Opens a link from the renderer only after the user confirmed the full address in a native dialog. */
async function openExternalWithConsent(url: string): Promise<void> {
  const parsed = parseExternalUrl(url);
  const now = Date.now();
  if (!parsed || externalLinkPromptOpen || now - lastExternalLinkAt < EXTERNAL_LINK_MIN_INTERVAL_MS) {
    return;
  }
  lastExternalLinkAt = now;
  externalLinkPromptOpen = true;
  try {
    const options = {
      type: 'question' as const,
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open this link?',
      detail: sanitizeForDialog(parsed.href, MAX_DIALOG_URL),
    };
    const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (response === 0) {
      await shell.openExternal(parsed.href);
    }
  } catch (error) {
    console.error(`Could not open the link: ${errorMessage(error)}`);
  } finally {
    externalLinkPromptOpen = false;
  }
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalWithConsent(url).catch((error: unknown) => console.error(`Could not open the link: ${errorMessage(error)}`));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    title: 'CodePad',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (closeApproved) {
      closeApproved = false;
      closeRequested = false;
      return;
    }
    event.preventDefault();
    closeRequested = true;
    send('request-close');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    if (findInFiles) {
      findInFiles.cancelAll();
    }
    if (ai) {
      ai.onWindowClosed();
    }
  });
}

/** Removes control/bidi characters and truncates a name before it is shown in a native dialog. */
function sanitizeForDialog(name: unknown, maxLength: number = MAX_DIALOG_NAME): string {
  const clean = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/** Keeps only well-formed Save dialog filters and the optional path the chosen file must differ from. */
function sanitizeSaveOptions(options: unknown): { filters: FileFilter[] | undefined; avoidPath: string | null } {
  const raw: Partial<Record<keyof CpSaveAsOptions, unknown>> =
    options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const filters: FileFilter[] = [];
  if (Array.isArray(raw.filters)) {
    for (const filter of (raw.filters as unknown[]).slice(0, MAX_SAVE_FILTERS) as Array<Partial<CpSaveAsFilter> | null>) {
      if (!filter || typeof filter !== 'object' || !Array.isArray(filter.extensions)) {
        continue;
      }
      const extensions = (filter.extensions as unknown[]).filter(
        (ext): ext is string => typeof ext === 'string' && /^[a-z0-9]{1,8}$/.test(ext),
      );
      if (extensions.length > 0) {
        filters.push({ name: sanitizeForDialog(filter.name ?? '') || 'Files', extensions: extensions.slice(0, 8) });
      }
    }
  }
  return {
    filters: filters.length > 0 ? filters : undefined,
    avoidPath: typeof raw.avoidPath === 'string' ? raw.avoidPath : null,
  };
}

/** Registers an IPC handler that only answers the app's own main frame. */
function handleUntyped(channel: string, handler: UntypedHandler): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error(`Rejected IPC call to ${channel} from an untrusted frame.`);
    }
    return handler(event, ...args);
  });
}

/** Registers a channel of the typed contract (CpIpcChannels) behind the same sender check. */
function handle<C extends keyof CpIpcChannels>(channel: C, handler: ChannelHandler<C>): void {
  handleUntyped(channel, handler as UntypedHandler);
}

/** The main window; `handle()` has already checked that it exists whenever a handler runs. */
function appWindow(): BrowserWindow {
  if (!mainWindow) {
    throw new Error('The main window is not available.');
  }
  return mainWindow;
}

function registerIpc(): void {
  handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(appWindow(), {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Documents and Spreadsheets', extensions: DOCUMENT_EXTENSIONS },
      ],
    });
    if (result.canceled) {
      return [];
    }
    const approved = [];
    for (const filePath of result.filePaths) {
      try {
        await fileAccess.approveFile(filePath);
        approved.push(filePath);
      } catch {
        // Unusable path (e.g. UNC): skip it.
      }
    }
    return approved;
  });

  handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(appWindow(), { properties: ['openDirectory'] });
    if (result.canceled) {
      return null;
    }
    await fileAccess.approveRoot(result.filePaths[0]);
    return result.filePaths[0];
  });

  handle('dialog:saveAs', async (_event, defaultPath, options) => {
    const { filters, avoidPath } = sanitizeSaveOptions(options);
    for (;;) {
      const result = await dialog.showSaveDialog(appWindow(), {
        defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
        filters,
      });
      if (result.canceled) {
        return null;
      }
      if (avoidPath && (await fileAccess.isSameFile(result.filePath, avoidPath))) {
        await dialog.showMessageBox(appWindow(), {
          type: 'info',
          buttons: ['OK'],
          message: 'Choose a different file name.',
          detail: 'The original PDF is never overwritten.',
        });
        continue;
      }
      await fileAccess.approveFile(result.filePath);
      return result.filePath;
    }
  });

  handle('dialog:confirmClose', async (_event, name, kind) => {
    const { response } = await dialog.showMessageBox(appWindow(), {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${sanitizeForDialog(name)}?`,
      detail:
        kind === 'pdf'
          ? 'Saving creates a new copy. The original PDF is never modified.'
          : "Your changes will be lost if you don't save them.",
    });
    return response;
  });

  handle('fs:approveDropped', async (_event, filePath) => {
    const expires = dropIntents.get(filePath);
    dropIntents.delete(filePath);
    if (expires === undefined || expires < Date.now()) {
      throw new Error('That file was not dropped on the window.');
    }
    await fileAccess.approveFile(filePath);
  });
  handle('fs:read', (_event, filePath, options) =>
    fileAccess.readTextFile(filePath, {
      encoding: options && typeof options.encoding === 'string' ? options.encoding : null,
      fallback: settingsStore.get()['files.fallbackEncoding'],
    }),
  );
  handle('fs:readBinary', (_event, filePath) => fileAccess.readBinaryFile(filePath));
  handle('fs:writeBinary', (_event, filePath, bytes) => {
    if (!ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) {
      throw new Error('Invalid file data.');
    }
    const buffer = ArrayBuffer.isView(bytes)
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Buffer.from(bytes);
    return fileAccess.writeBinaryFile(filePath, buffer);
  });
  handle('fs:write', (_event, filePath, content, encoding, options) =>
    fileAccess.writeTextFile(filePath, content, typeof encoding === 'string' ? encoding : 'utf8', {
      allowLossy: options?.allowLossy === true,
    }),
  );
  handle('fs:readDir', (_event, dirPath) => fileAccess.readDirectory(dirPath));
  handle('fs:stat', (_event, filePath) => fileAccess.statFile(filePath));
  handle('fs:isSameFile', (_event, approvedPath, otherPath) => fileAccess.isSameApprovedFile(approvedPath, otherPath));
  handle('fs:hash', (_event, filePath, algo) => fileAccess.hashFile(filePath, algo));
  handle('shell:reveal', async (_event, filePath) => {
    shell.showItemInFolder(await fileAccess.resolveAllowed(filePath));
  });

  handle('files:create', (_event, filePath, content) => chatFiles.createFile(filePath, content));
  handle('files:rename', (_event, filePath, newName) => chatFiles.renameFile(filePath, newName));
  handle('files:trash', (_event, filePath) =>
    chatFiles.trashFile(filePath, {
      confirmTrash: async (name, folder) => {
        const { response } = await dialog.showMessageBox(appWindow(), {
          type: 'warning',
          buttons: ['Yes', 'No'],
          defaultId: 1,
          cancelId: 1,
          message: `Move ${sanitizeForDialog(name)} to the trash?`,
          detail: `Folder: ${sanitizeForDialog(folder)}\nYou can restore it from the trash.`,
        });
        return response === 0;
      },
      trashItem: (realPath) => shell.trashItem(realPath),
    }),
  );
  handle('app:info', () => ({ version: app.getVersion() }));
  handle('encoding:list', () => textCodec.ENCODINGS);
  handle('encoding:check', (_event, content, encodingId) => {
    if (typeof content !== 'string' || content.length > MAX_ENCODING_CHECK_CHARS || !textCodec.isKnownEncoding(encodingId)) {
      throw new Error('Invalid encoding check.');
    }
    return textCodec.checkEncodable(content, encodingId);
  });

  handle('settings:get', () => ({ values: settingsStore.get(), fresh: settingsStore.isFresh() }));
  handle('settings:set', (_event, patch) => {
    console.info(`[settings] patch from the window: ${patch && typeof patch === 'object' ? Object.keys(patch).join(', ') : '?'}`);
    return settingsStore.patch(patch);
  });
  handle('commands:table', () => menuBuilder.effectiveTable(settingsStore.get().keybindings));

  handle('recent:list', () => userStore.recent.list());
  handle('recent:add', async (_event, filePath) => {
    await userStore.recent.add(await fileAccess.resolveAllowed(filePath));
    rebuildMenu();
  });
  handle('recent:approveAt', (_event, index) => approveRecentAt(index));
  handle('recent:clear', async () => {
    await userStore.recent.clear();
    rebuildMenu();
  });

  handle('macros:get', () => userStore.macros.get(menuBuilder.isKnownCommand));
  handle('macros:set', (_event, list) => userStore.macros.set(list, menuBuilder.isKnownCommand));

  handle('session:save', (_event, snapshot) => sessionStore.save(snapshot));
  handle('session:load', () => {
    if (skipSession) {
      skipSession = false;
      return null;
    }
    return sessionStore.load();
  });
  handle('sessions:list', () => sessionStore.listNamed());
  handle('sessions:save', (_event, name, snapshot) => sessionStore.saveNamed(name, snapshot));
  handle('sessions:load', (_event, id) => sessionStore.loadNamed(id));
  handle('sessions:delete', (_event, id) => sessionStore.deleteNamed(id));

  handle('window:setFullScreen', (_event, value) => mainWindow?.setFullScreen(value === true));
  handle('window:setAlwaysOnTop', (_event, value) => mainWindow?.setAlwaysOnTop(value === true));

  handle('search:start', (_event, options) => {
    if (!findInFiles) {
      throw new Error('Find in Files is not available.');
    }
    const values = settingsStore.get();
    const { searchId } = findInFiles.start(options, {
      root: fileAccess.getApprovedRoot(),
      send: (searchEvent: CpSearchEvent) => send('search:event', searchEvent),
      limits: { maxResults: values['search.maxResults'], maxFileKB: values['search.maxFileKB'] },
      fallbackEncoding: values['files.fallbackEncoding'],
    });
    return { searchId };
  });
  handle('search:cancel', (_event, searchId) => findInFiles !== null && findInFiles.cancel(searchId));

  handle('watch:add', async (_event, filePath) => {
    if (!watcher || !settingsStore.get()['files.watch']) {
      return { ok: false };
    }
    try {
      return { ok: await watcher.add(filePath) };
    } catch {
      return { ok: false };
    }
  });
  handle('watch:remove', (_event, filePath) => {
    if (watcher) {
      watcher.remove(filePath);
    }
    return { ok: true };
  });

  handle('spell:check', (_event, words) => (spellcheck ? spellcheck.check(words) : { misspelled: [] }));
  handle('spell:addWord', (_event, word) => (spellcheck ? spellcheck.addWord(word) : { ok: false }));

  ipcMain.on('app:ready', (event) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || rendererReady) {
      return;
    }
    rendererReady = true;
    if (pendingOpen) {
      send('open-paths', pendingOpen);
      pendingOpen = null;
    }
  });

  ipcMain.on('app:closeCancelled', (event) => {
    if (mainWindow && event.senderFrame === mainWindow.webContents.mainFrame) {
      closeRequested = false;
    }
  });

  ipcMain.on('fs:dropIntent', (event, paths: unknown) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || !Array.isArray(paths)) {
      return;
    }
    const expires = Date.now() + DROP_INTENT_TTL_MS;
    (paths as unknown[])
      .slice(0, MAX_DROP_INTENTS)
      .forEach((item) => typeof item === 'string' && item.length <= MAX_ARG_LENGTH && dropIntents.set(item, expires));
  });

  ipcMain.on('app:closeApproved', (event) => {
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || !closeRequested) {
      return;
    }
    closeRequested = false;
    closeApproved = true;
    mainWindow.close();
  });
}

/** Answers every `ai:*` channel with an "unavailable" result, so the renderer never hits a missing channel. */
function registerAiStubs(): void {
  const unavailableModel = { code: 'unavailable', message: AI_UNAVAILABLE.message };
  const stubs: Record<string, UntypedHandler> = {
    'ai:getStatus': () => ({
      model: { state: 'error', modelId: null, bytes: 0, total: 0, bytesPerSec: 0, etaSec: 0, external: false, error: unavailableModel },
      engine: { state: 'error', error: AI_UNAVAILABLE.message, gpu: null, threads: null, modelId: null },
      enabled: false,
      summary: { running: false, jobId: null },
    }),
    'ai:model:download': () => AI_UNAVAILABLE,
    'ai:model:pause': () => AI_UNAVAILABLE,
    'ai:model:resume': () => AI_UNAVAILABLE,
    'ai:model:cancel': () => AI_UNAVAILABLE,
    'ai:model:delete': () => AI_UNAVAILABLE,
    'ai:model:checkConnection': () => ({ online: false, error: 'unavailable' }),
    'ai:suggest': (_event, request) => ({ reqId: request && (request as { reqId?: unknown }).reqId, text: null }),
    'ai:suggest:cancel': () => true,
    'ai:summarize': () => AI_UNAVAILABLE,
    'ai:summarize:cancel': () => true,
    'ai:rewrite:start': () => AI_UNAVAILABLE,
    'ai:rewrite:cancel': () => true,
    'ai:summaryCache:clear': () => ({ removed: 0 }),
    'ai:summarize:retryDefault': () => ({ ok: false, ...unavailableModel }),
    'ai:models:list': () => ({ ok: true, models: [] }),
    'ai:models:pull:cancel': () => true,
  };
  ['add', 'update', 'remove', 'setEnabled', 'setActive', 'setKey', 'test', 'consent', 'pull'].forEach((name) => {
    stubs[`ai:models:${name}`] = () => ({ ok: false, ...unavailableModel });
  });
  Object.entries(stubs).forEach(([channel, handler]) => {
    ipcMain.removeHandler(channel);
    handleUntyped(channel, handler);
  });
}

/** Registers the ai:* IPC through aiIpc.ts; falls back to the stub handlers when it is missing or broken. */
function registerAi(): void {
  if (aiIpc && typeof aiIpc.registerAiIpc === 'function') {
    try {
      const registered = aiIpc.registerAiIpc({
        handle: handleUntyped,
        send,
        getSettings: aiSettingsView,
        patchSettings: (patch: unknown) => settingsStore.patch(patch),
        userDataDir: app.getPath('userData'),
        appVersion: app.getVersion(),
        userStore,
        log: aiLog,
      });
      ai = registered;
      return;
    } catch (error) {
      console.error(`The AI features could not start: ${errorMessage(error)}`);
    }
  }
  registerAiStubs();
}

/** Disposes the AI modules once (jobs cancelled, worker killed, download paused); never blocks quitting for long. */
function disposeAi(): void {
  if (!ai || aiDisposed || aiDisposing) {
    return;
  }
  aiDisposing = true;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, AI_DISPOSE_TIMEOUT_MS));
  Promise.race([ai.dispose(), timeout])
    .catch((error: unknown) => console.error(`The AI features did not shut down cleanly: ${errorMessage(error)}`))
    .finally(() => {
      aiDisposed = true;
      app.quit();
    });
}

/** Window shown by `--install-model` (not silent): a small progress dialog with its own preload. */
function createInstallWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'CodePad',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preloadInstall.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, 'renderer', 'install', 'model-install.html'));
  return window;
}

/** The install-mode fields of a model status that the progress window needs. */
function installProgress(status: CpAiModelStatus): Omit<CpAiModelStatus, 'modelId'> {
  const { state, bytes, total, bytesPerSec, etaSec, external, error } = status;
  return { state, bytes, total, bytesPerSec, etaSec, external, error };
}

/**
 * Downloads the AI model for the installer. Resolves with the process exit code:
 * 0 ready, 2 cancelled, 3 offline, 4 integrity, 5 disk space, 6 locked by another process for too long, 1 other.
 */
async function installModel(): Promise<number> {
  const modelDownloader = optionalRequire<typeof import('./modelDownloader')>('./modelDownloader');
  if (!modelDownloader) {
    return INSTALL_EXIT.OTHER;
  }
  const modelsDir = path.join(app.getPath('userData'), 'models');
  await fs.promises.mkdir(modelsDir, { recursive: true, mode: 0o700 });
  const manager = modelDownloader.createModelManager({ modelsDir, appVersion: app.getVersion(), log: aiLog });
  let installWindow: BrowserWindow | null = null;
  let cancelled = false;
  let finished = false;
  let externalSince = 0;
  let watchdog: NodeJS.Timeout | null = null;
  const isAlive = (): boolean => installWindow !== null && !installWindow.isDestroyed();
  const cancel = (): void => {
    cancelled = true;
    manager.cancel().catch((error: unknown) => console.error(`Could not cancel the model download: ${errorMessage(error)}`));
  };
  const onCancelMessage = (event: Electron.IpcMainEvent): void => {
    if (installWindow && isAlive() && event.senderFrame === installWindow.webContents.mainFrame) {
      cancel();
    }
  };
  try {
    if (await manager.resolve()) {
      return INSTALL_EXIT.OK;
    }
    if (!INSTALL_SILENT) {
      const created = createInstallWindow();
      installWindow = created;
      created.webContents.on('did-finish-load', () => created.webContents.send('install:progress', installProgress(manager.status())));
      created.on('closed', () => {
        if (!finished) {
          cancel();
        }
      });
      ipcMain.on('install:cancel', onCancelMessage);
      manager.onStatus((status) => {
        if (installWindow && isAlive()) {
          installWindow.webContents.send('install:progress', installProgress(status));
        }
      });
    }
    // Another process (the app itself) may hold the download; give up after 30 minutes of waiting on it.
    const lockedTooLong = new Promise<number>((resolve) => {
      watchdog = setInterval(() => {
        if (!manager.status().external) {
          externalSince = 0;
        } else if (externalSince === 0) {
          externalSince = Date.now();
        } else if (Date.now() - externalSince >= INSTALL_LOCK_WAIT_MS) {
          resolve(INSTALL_EXIT.LOCKED);
        }
      }, INSTALL_WATCHDOG_MS);
    });
    const download = manager.start().then(
      () => INSTALL_EXIT.OK,
      (error: unknown) => {
        const code = errorCode(error);
        console.error(`The model download failed (${code ? code : 'unknown'}).`);
        return (code && INSTALL_EXIT_BY_CODE[code]) || INSTALL_EXIT.OTHER;
      },
    );
    const code = await Promise.race([download, lockedTooLong]);
    return cancelled && code !== INSTALL_EXIT.OK ? INSTALL_EXIT.CANCELLED : code;
  } finally {
    finished = true;
    if (watchdog) {
      clearInterval(watchdog);
    }
    ipcMain.removeListener('install:cancel', onCancelMessage);
    await manager.dispose().catch(() => {});
    if (installWindow && isAlive()) {
      installWindow.destroy();
    }
  }
}

/** `--install-model`: no single-instance lock, no main window, no other IPC; exits with the code from installModel. */
function runInstallMode(): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.whenReady().then(async () => {
    hardenSession();
    let code: number = INSTALL_EXIT.OTHER;
    try {
      code = await installModel();
    } catch (error) {
      console.error(`The model installation failed: ${errorMessage(error)}`);
    }
    app.exit(code);
  });
}

if (INSTALL_MODE) {
  runInstallMode();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
    const { paths, line } = parseArgs(argv.slice(app.isPackaged ? 1 : 2), workingDirectory);
    confirmSecondInstanceOpen(paths)
      .then((confirmed) => (confirmed ? approveCommandLinePaths(paths) : []))
      .then((approved) => openPaths(approved, line))
      .catch((error: unknown) => console.error(`Could not open the files from the second instance: ${errorMessage(error)}`));
  });

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.on('before-quit', (event) => {
    if (findInFiles) {
      findInFiles.cancelAll();
    }
    if (watcher) {
      watcher.dispose();
    }
    if (ai && !aiDisposed) {
      // Quitting resumes once the AI worker and download have shut down.
      event.preventDefault();
      disposeAi();
    }
  });

  app.whenReady().then(async () => {
    hardenSession();
    try {
      await settingsStore.load({ isKnownCommand: menuBuilder.isKnownCommand, onChange: onSettingsChanged });
      await userStore.recent.load(fileAccess.isUsablePath);
    } catch (error) {
      console.error(`Could not load the saved settings: ${errorMessage(error)}`);
    }
    if (fileWatcher) {
      watcher = fileWatcher.createWatcher({
        resolveAllowed: fileAccess.resolveAllowed,
        onEvent: (watchEvent) => send('watch:event', watchEvent),
      });
    }
    registerIpc();
    registerAi();
    rebuildMenu();
    createWindow();
    const { paths, line, noSession } = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
    skipSession = noSession;
    openPaths(await approveCommandLinePaths(paths), line);
  });

  app.on('window-all-closed', () => app.quit());
}
