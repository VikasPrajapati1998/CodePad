/**
 * Main-process file watching for the "changed on disk" feature.
 *
 * One fs.watch per parent directory (ref-counted), filtered by file name: watching the directory
 * survives the temp-file + rename that atomic writes use, which a watcher on the file itself would not.
 * Only paths accepted by `resolveAllowed` are watched, and events only ever carry the exact path that
 * was registered with add(). Events are debounced per path and then decided by fs.stat.
 */

import fs from 'fs';
import path from 'path';
import { isErrnoCode } from './errorUtils';

const DEBOUNCE_MS = 250;
const DEFAULT_MAX_WATCHES = 200;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Key used to compare file names on the current platform. */
function nameKey(name: string): string {
  return CASE_INSENSITIVE ? name.toLowerCase() : name;
}

/** Options of `createWatcher`. */
export interface WatcherOptions {
  /** Returns the real, allow-listed path or throws. */
  resolveAllowed: (p: string) => string | Promise<string>;
  onEvent: (event: CpWatchEvent) => void;
  /** Maximum number of watched files. */
  maxWatches?: number;
}

/** The manager returned by `createWatcher`. */
export interface FileWatcher {
  add: (p: string) => Promise<boolean>;
  remove: (p: string) => void;
  dispose: () => void;
}

interface WatchEntry {
  real: string;
  dir: string;
  key: string;
  timer: NodeJS.Timeout | null;
}

interface SharedWatcher {
  watcher: fs.FSWatcher;
  files: Map<string, Set<string>>;
}

/** Creates a watcher manager. */
function createWatcher({ resolveAllowed, onEvent, maxWatches = DEFAULT_MAX_WATCHES }: WatcherOptions): FileWatcher {
  /** registered path -> entry */
  const entries = new Map<string, WatchEntry>();
  /** directory -> shared watcher */
  const directories = new Map<string, SharedWatcher>();

  /** Reports the current state of one watched file after the debounce. */
  async function settle(registered: string): Promise<void> {
    const entry = entries.get(registered);
    if (!entry) {
      return;
    }
    entry.timer = null;
    let event: CpWatchEvent;
    try {
      const stat = await fs.promises.stat(entry.real);
      event = { path: registered, kind: 'changed', mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        event = { path: registered, kind: 'deleted', mtimeMs: 0, size: 0 };
      } else {
        return;
      }
    }
    if (entries.get(registered) === entry) {
      onEvent(event);
    }
  }

  function schedule(registered: string): void {
    const entry = entries.get(registered);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      settle(registered).catch(() => {});
    }, DEBOUNCE_MS);
  }

  /** Drops a registered path from its directory watcher and closes the watcher when it is the last one. */
  function detach(registered: string): void {
    const entry = entries.get(registered);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entries.delete(registered);
    const shared = directories.get(entry.dir);
    if (!shared) {
      return;
    }
    const owners = shared.files.get(entry.key);
    if (owners) {
      owners.delete(registered);
      if (owners.size === 0) {
        shared.files.delete(entry.key);
      }
    }
    if (shared.files.size === 0) {
      shared.watcher.close();
      directories.delete(entry.dir);
    }
  }

  /** Closes a directory watcher that failed and forgets every path that depended on it. */
  function failDirectory(dir: string): void {
    const shared = directories.get(dir);
    if (!shared) {
      return;
    }
    const owners = [...shared.files.values()].flatMap((set) => [...set]);
    owners.forEach(detach);
  }

  function openDirectory(dir: string): SharedWatcher {
    const existing = directories.get(dir);
    if (existing) {
      return existing;
    }
    const files = new Map<string, Set<string>>();
    const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (!filename) {
        files.forEach((owners) => owners.forEach(schedule));
        return;
      }
      const owners = files.get(nameKey(String(filename)));
      if (owners) {
        owners.forEach(schedule);
      }
    });
    watcher.on('error', () => failDirectory(dir));
    const shared = { watcher, files };
    directories.set(dir, shared);
    return shared;
  }

  /**
   * Starts watching a file.
   * @param filePath Path that is already approved by the main process.
   * @returns false when the path is not allowed, the limit is reached or the OS refused the watch.
   */
  async function add(filePath: string): Promise<boolean> {
    if (typeof filePath !== 'string' || !filePath) {
      return false;
    }
    if (entries.has(filePath)) {
      return true;
    }
    if (entries.size >= maxWatches) {
      return false;
    }
    let real: string;
    try {
      real = await resolveAllowed(filePath);
    } catch {
      return false;
    }
    if (typeof real !== 'string' || entries.has(filePath) || entries.size >= maxWatches) {
      return entries.has(filePath);
    }
    const dir = path.dirname(real);
    const key = nameKey(path.basename(real));
    try {
      const shared = openDirectory(dir);
      entries.set(filePath, { real, dir, key, timer: null });
      if (!shared.files.has(key)) {
        shared.files.set(key, new Set());
      }
      shared.files.get(key)?.add(filePath);
      return true;
    } catch {
      // EPERM, ENOENT, ENOSPC and similar: the renderer falls back to stat checks on window focus.
      entries.delete(filePath);
      return false;
    }
  }

  /** Stops watching a file; a no-op for unknown paths. */
  function remove(filePath: string): void {
    detach(filePath);
  }

  /** Closes every watcher (folder change or quit). */
  function dispose(): void {
    [...entries.keys()].forEach(detach);
  }

  return { add, remove, dispose };
}

export { createWatcher };
