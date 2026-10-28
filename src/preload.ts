import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Argument and result types of every channel come from CpIpcChannels in src/types/codepad-api.d.ts.
const invoke =
  <C extends keyof CpIpcChannels>(channel: C): CpInvoke<C> =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

/** Subscribes to a main-process event; the callback receives the payload only. */
const subscribe =
  <T>(channel: string): CpSubscribe<T> =>
  (callback) => {
    ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
  };

/** The part of the DOM drop event used below (this project is compiled without the DOM lib). */
interface DropEventLike {
  readonly isTrusted: boolean;
  readonly dataTransfer: { readonly files: ArrayLike<File> } | null;
}

declare const window: {
  addEventListener(type: 'drop', listener: (event: DropEventLike) => void, useCapture: boolean): void;
};

// Main only approves dropped paths it was told about here: a trusted (user-made) drop event cannot be forged by page script.
window.addEventListener(
  'drop',
  (event) => {
    if (!event.isTrusted || !event.dataTransfer) {
      return;
    }
    const paths = Array.from(event.dataTransfer.files, (file) => webUtils.getPathForFile(file)).filter((p) => p.length > 0);
    if (paths.length > 0) {
      ipcRenderer.send('fs:dropIntent', paths);
    }
  },
  true,
);

const api: CodePadApi = {
  openFiles: invoke('dialog:openFiles'),
  openFolder: invoke('dialog:openFolder'),
  saveAsDialog: invoke('dialog:saveAs'),
  confirmClose: invoke('dialog:confirmClose'),
  readFile: invoke('fs:read'),
  readBinary: invoke('fs:readBinary'),
  writeBinary: invoke('fs:writeBinary'),
  writeFile: invoke('fs:write'),
  readDir: invoke('fs:readDir'),
  appInfo: invoke('app:info'),
  statFile: invoke('fs:stat'),
  isSameFile: invoke('fs:isSameFile'),
  hashFile: invoke('fs:hash'),
  reveal: invoke('shell:reveal'),
  saveSession: invoke('session:save'),
  loadSession: invoke('session:load'),
  /** Grants access to a dropped File object (only real, user-dropped files have a path). */
  approveDropped: async (file: File) => {
    const filePath = webUtils.getPathForFile(file);
    await ipcRenderer.invoke('fs:approveDropped', filePath);
    return filePath;
  },
  approveClose: () => ipcRenderer.send('app:closeApproved'),
  cancelClose: () => ipcRenderer.send('app:closeCancelled'),
  /** Tells main the session restore finished, so queued command-line files can be opened. */
  ready: () => ipcRenderer.send('app:ready'),
  encodings: { list: invoke('encoding:list'), check: invoke('encoding:check') },
  search: {
    start: invoke('search:start'),
    cancel: invoke('search:cancel'),
    onEvent: subscribe('search:event'),
  },
  watch: {
    add: invoke('watch:add'),
    remove: invoke('watch:remove'),
    onEvent: subscribe('watch:event'),
  },
  files: { create: invoke('files:create'), rename: invoke('files:rename'), trash: invoke('files:trash') },
  spell: { check: invoke('spell:check'), addWord: invoke('spell:addWord') },
  settings: { get: invoke('settings:get'), patch: invoke('settings:set') },
  commands: { table: invoke('commands:table') },
  recent: {
    list: invoke('recent:list'),
    add: invoke('recent:add'),
    approveAt: invoke('recent:approveAt'),
    clear: invoke('recent:clear'),
  },
  macros: { get: invoke('macros:get'), set: invoke('macros:set') },
  sessions: {
    list: invoke('sessions:list'),
    save: invoke('sessions:save'),
    load: invoke('sessions:load'),
    delete: invoke('sessions:delete'),
  },
  window: {
    setFullScreen: invoke('window:setFullScreen'),
    setAlwaysOnTop: invoke('window:setAlwaysOnTop'),
  },
  ai: {
    status: invoke('ai:getStatus'),
    onEvent: subscribe('ai:event'),
    model: {
      download: invoke('ai:model:download'),
      pause: invoke('ai:model:pause'),
      resume: invoke('ai:model:resume'),
      cancel: invoke('ai:model:cancel'),
      remove: invoke('ai:model:delete'),
      checkConnection: invoke('ai:model:checkConnection'),
    },
    suggest: invoke('ai:suggest'),
    cancelSuggest: invoke('ai:suggest:cancel'),
    summarize: invoke('ai:summarize'),
    cancelSummary: invoke('ai:summarize:cancel'),
    clearSummaryCache: invoke('ai:summaryCache:clear'),
    retryDefault: invoke('ai:summarize:retryDefault'),
    rewrite: invoke('ai:rewrite:start'),
    cancelRewrite: invoke('ai:rewrite:cancel'),
    chat: invoke('ai:chat:start'),
    cancelChat: invoke('ai:chat:cancel'),
    models: {
      list: invoke('ai:models:list'),
      add: invoke('ai:models:add'),
      update: invoke('ai:models:update'),
      remove: invoke('ai:models:remove'),
      setEnabled: invoke('ai:models:setEnabled'),
      setActive: invoke('ai:models:setActive'),
      setKey: invoke('ai:models:setKey'),
      test: invoke('ai:models:test'),
      consent: invoke('ai:models:consent'),
      pull: invoke('ai:models:pull'),
      cancelPull: invoke('ai:models:pull:cancel'),
    },
  },
  onCommand: subscribe('command'),
  onOpenPaths: subscribe('open-paths'),
  onRequestClose: (callback) => {
    ipcRenderer.on('request-close', () => callback());
  },
};

contextBridge.exposeInMainWorld('codepad', api);
