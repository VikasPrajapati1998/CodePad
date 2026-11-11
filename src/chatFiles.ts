/*
 * File operations of the chat assistant (create, rename, move, new folder, move to the trash). Main owns the trust:
 * every path is resolved and checked by fileAccess (allow-list, no UNC, no alternate data streams, no reserved device
 * names), create, move and new folders are limited to the opened folder, nothing is ever overwritten, and a delete only happens after a native
 * Yes/No box that main shows (the `confirmTrash` callback). Failures are returned as `{ok:false, code, message}`
 * with text the user can read; nothing about the file content is logged.
 */
import fs from 'fs/promises';
import path from 'path';
import { errorCode, isErrnoCode } from './errorUtils';
import * as fileAccess from './fileAccess';

/** Hooks main supplies for the parts that need Electron (dialog and trash). */
export interface ChatFilesHooks {
  /** Shows the native Yes/No box; true when the user confirmed. */
  confirmTrash(name: string, folder: string): Promise<boolean>;
  /** Moves a file to the OS trash (`shell.trashItem`). */
  trashItem(realPath: string): Promise<void>;
}

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_NAME_CHARS = 255;
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Extensions the assistant may not create or rename a file to: they run or launch something when opened. */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.com', '.scr', '.msi', '.pif', '.cpl', '.hta', '.msc', '.scf',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.reg',
  '.lnk', '.url', '.desktop', '.app',
]);
/** Files in `.vscode` that make the editor run commands. */
const BLOCKED_VSCODE_FILES = new Set(['tasks.json', 'launch.json', 'settings.json']);

/** A refusal with a code and a message that is shown to the user as is. */
class FileOpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function refuse(code: string, message: string): never {
  throw new FileOpError(code, message);
}

/** Turns a caught value into a user-presentable failure. */
function toFailure(error: unknown): CpFileOpFailure {
  if (error instanceof FileOpError) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Access to this path')) {
    return { ok: false, code: 'outsideFolder', message: 'That file is outside the opened folder.' };
  }
  if (isErrnoCode(error, 'ENOENT')) {
    return { ok: false, code: 'notFound', message: 'The file or its folder does not exist.' };
  }
  if (isErrnoCode(error, 'EACCES') || isErrnoCode(error, 'EPERM')) {
    return { ok: false, code: 'denied', message: 'The system did not allow this change.' };
  }
  if (error instanceof Error && errorCode(error) === undefined && /path|device|stream|dot|space/i.test(message)) {
    return { ok: false, code: 'invalid', message };
  }
  return { ok: false, code: 'io', message: 'The file operation failed.' };
}

/** Runs an operation and converts any thrown value into a failure result. */
async function guarded<T extends object>(operation: () => Promise<T>): Promise<({ ok: true } & T) | CpFileOpFailure> {
  try {
    return { ok: true, ...(await operation()) };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Throws unless `name` is a bare, portable file or folder name (no separators, ADS, reserved device name, trailing
 * dot or space). `what` only changes the wording of the refusal.
 */
function assertValidName(name: unknown, what: 'file' | 'folder' = 'file'): asserts name is string {
  if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_CHARS) {
    refuse('invalidName', `Enter a ${what} name of 1 to 255 characters.`);
  }
  if (name === '.' || name === '..' || name !== name.trim()) {
    refuse('invalidName', `The ${what} name cannot be "." or "..", or start or end with a space.`);
  }
  if (INVALID_NAME_CHARS.test(name)) {
    refuse('invalidName', `The ${what} name cannot contain / \\ : * ? " < > | or control characters.`);
  }
  try {
    fileAccess.assertWindowsSafe(`/${name}`);
  } catch (error) {
    refuse('invalidName', error instanceof Error ? error.message : `This ${what} name is not supported.`);
  }
}

/** The opened folder; refuses when none is open. */
function requireRoot(action: string): string {
  const root = fileAccess.getApprovedRoot();
  if (root === null) {
    return refuse('noFolder', `Open a folder first, then the assistant can ${action}.`);
  }
  return root;
}

/** True when `target` is the opened folder itself or lies inside it. */
const isRootOrInside = (root: string, target: string): boolean =>
  path.relative(root, target) === '' || fileAccess.isInside(root, target);

/**
 * Real path of an existing folder inside the opened folder (the opened folder itself counts).
 * @param dirPath Renderer-supplied absolute folder path.
 * @param root The opened folder.
 * @param missing Refusal message when the folder does not exist.
 */
async function resolveFolderInRoot(dirPath: unknown, root: string, missing: string): Promise<string> {
  const real = await fileAccess.resolveAllowed(dirPath);
  if (!isRootOrInside(root, real)) {
    refuse('outsideFolder', 'That folder is outside the opened folder.');
  }
  try {
    if (!(await fs.stat(real)).isDirectory()) {
      refuse('notFolder', 'That path is a file, not a folder.');
    }
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      refuse('noParent', missing);
    }
    throw error;
  }
  return real;
}

/**
 * Throws unless the new file may be created at `target`: no executable/launcher extension and no tool-config location
 * that runs code later (git hooks and config, editor tasks/launch/settings, IDE run configurations, husky hooks).
 */
function assertSafeTarget(target: string): void {
  const ext = path.extname(target).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    refuse('blockedName', `Files of type "${ext}" can be run by the system, so the assistant cannot create them.`);
  }
  const root = fileAccess.getApprovedRoot();
  const location = root !== null && fileAccess.isInside(root, target) ? path.relative(root, target) : target;
  const segments = location.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? '';
  const folders = segments.slice(0, -1);
  const blocked =
    segments.includes('.git') ||
    segments.includes('.husky') ||
    (folders.includes('.vscode') && BLOCKED_VSCODE_FILES.has(name)) ||
    (folders.includes('.idea') && (folders.includes('runconfigurations') || name === 'workspace.xml'));
  if (blocked) {
    refuse('blockedName', 'The assistant cannot create or rename files in tool configuration locations such as .git or .vscode.');
  }
}

/** True when something exists at the path (a dangling symlink counts). */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

/**
 * Moves a file without ever replacing the target: a hard link fails with EEXIST if anything is there, then the
 * old name is removed. Where the filesystem has no hard links the plain rename is used after the exists check.
 */
async function renameNoReplace(from: string, to: string, displayName: string): Promise<void> {
  try {
    await fs.link(from, to);
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      refuse('exists', `A file named "${displayName}" already exists.`);
    }
    if (isErrnoCode(error, 'EPERM') || isErrnoCode(error, 'ENOSYS') || isErrnoCode(error, 'ENOTSUP') || isErrnoCode(error, 'EXDEV')) {
      await fs.rename(from, to);
      return;
    }
    throw error;
  }
  await fs.unlink(from);
}

/** Real path of an existing regular file the user may access. */
async function resolveExistingFile(filePath: unknown): Promise<string> {
  const real = await fileAccess.resolveAllowed(filePath);
  const root = fileAccess.getApprovedRoot();
  if (root !== null && path.normalize(real) === path.normalize(root)) {
    refuse('notFile', 'The opened folder itself cannot be changed.');
  }
  if (!(await fs.stat(real)).isFile()) {
    refuse('notFile', 'Only files can be changed, not folders.');
  }
  return real;
}

/**
 * Creates a new file inside the opened folder. The file must not exist and its folder must.
 * @param filePath Absolute path of the new file.
 * @param content Text to write (UTF-8, at most 5 MB).
 * @returns The real path of the new file, which is approved afterwards.
 */
export function createFile(filePath: unknown, content: unknown): Promise<CpFileOpResult<{ path: string }>> {
  return guarded(async () => {
    if (typeof content !== 'string') {
      refuse('invalid', 'The file content must be text.');
    }
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length > MAX_CONTENT_BYTES) {
      refuse('tooLarge', 'The new file would be larger than 5 MB.');
    }
    const root = fileAccess.getApprovedRoot();
    if (root === null) {
      refuse('noFolder', 'Open a folder first, then the assistant can create files in it.');
    }
    const real = await fileAccess.resolveAllowed(filePath);
    if (!fileAccess.isInside(root, real)) {
      refuse('outsideFolder', 'New files can only be created inside the opened folder.');
    }
    assertValidName(path.basename(real));
    assertSafeTarget(real);
    try {
      if (!(await fs.stat(path.dirname(real))).isDirectory()) {
        refuse('noParent', 'The folder for the new file does not exist.');
      }
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        refuse('noParent', 'The folder for the new file does not exist.');
      }
      throw error;
    }
    try {
      await fileAccess.writeAtomic(real, buffer, { exclusive: true });
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) {
        refuse('exists', `A file named "${path.basename(real)}" already exists.`);
      }
      throw error;
    }
    await fileAccess.approveFile(real);
    return { path: real };
  });
}

/**
 * Renames a file inside its folder. The target must not exist (only a change of letter case is allowed on the same file).
 * @param filePath Absolute path of the existing file.
 * @param newName Bare new file name.
 * @returns The real path of the renamed file, which is approved afterwards.
 */
export function renameFile(filePath: unknown, newName: unknown): Promise<CpFileOpResult<{ path: string }>> {
  return guarded(async () => {
    assertValidName(newName);
    const real = await resolveExistingFile(filePath);
    const target = path.join(path.dirname(real), newName);
    if (target === real) {
      refuse('unchanged', 'The file already has this name.');
    }
    assertSafeTarget(target);
    const sameFile = (await exists(target)) && (await fileAccess.isSameFile(real, target));
    if (!sameFile && (await exists(target))) {
      refuse('exists', `A file named "${newName}" already exists.`);
    }
    if (sameFile) {
      await fs.rename(real, target);
    } else {
      await renameNoReplace(real, target, newName);
    }
    fileAccess.revokeFile(real);
    await fileAccess.approveFile(target);
    return { path: target };
  });
}

/**
 * Moves a file into another folder inside the opened folder, keeping its name. The destination folder must exist and
 * nothing may be at the target path; like a rename, the old path loses its approval and the new one gets it.
 * @param filePath Absolute path of the existing file (inside the opened folder).
 * @param destDir Absolute path of the destination folder (the opened folder or a folder inside it).
 * @returns The real path of the moved file, which is approved afterwards.
 */
export function moveFile(filePath: unknown, destDir: unknown): Promise<CpFileOpResult<{ path: string }>> {
  return guarded(async () => {
    const root = requireRoot('move files in it');
    const real = await resolveExistingFile(filePath);
    if (!fileAccess.isInside(root, real)) {
      refuse('outsideFolder', 'Only files inside the opened folder can be moved.');
    }
    const folder = await resolveFolderInRoot(destDir, root, 'The destination folder does not exist.');
    const name = path.basename(real);
    const target = path.join(folder, name);
    if (path.relative(path.dirname(real), folder) === '') {
      refuse('unchanged', 'The file is already in this folder.');
    }
    assertSafeTarget(target);
    if (await exists(target)) {
      refuse('exists', `A file named "${name}" already exists in that folder.`);
    }
    await renameNoReplace(real, target, name);
    fileAccess.revokeFile(real);
    await fileAccess.approveFile(target);
    return { path: target };
  });
}

/**
 * Creates a new, empty folder inside the opened folder. Nothing may exist at the path yet and its parent must exist.
 * @param parentDir Absolute path of the parent folder (the opened folder or a folder inside it).
 * @param name Bare folder name.
 * @returns The real path of the new folder (reachable through the opened folder; no file approval is needed).
 */
export function makeFolder(parentDir: unknown, name: unknown): Promise<CpFileOpResult<{ path: string }>> {
  return guarded(async () => {
    assertValidName(name, 'folder');
    const root = requireRoot('create folders in it');
    const parent = await resolveFolderInRoot(parentDir, root, 'The folder for the new folder does not exist.');
    const target = path.join(parent, name);
    assertSafeTarget(target);
    try {
      await fs.mkdir(target);
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) {
        refuse('exists', `A file or folder named "${name}" already exists.`);
      }
      throw error;
    }
    return { path: target };
  });
}

/**
 * Moves a file to the OS trash after a native Yes/No confirmation.
 * @param filePath Absolute path of the file (a regular, allowed file; never a folder).
 * @param hooks Main's confirm box and trash call.
 * @returns `{ok:true}`, or `{ok:false, cancelled:true}` when the user said No.
 */
export function trashFile(filePath: unknown, hooks: ChatFilesHooks): Promise<CpFileOpResult<object>> {
  return guarded(async () => {
    const real = await resolveExistingFile(filePath);
    if (!(await hooks.confirmTrash(path.basename(real), path.dirname(real)))) {
      refuse('cancelled', 'Nothing was deleted.');
    }
    await hooks.trashItem(real);
    fileAccess.revokeFile(real);
    return {};
  }).then((result) => (!result.ok && result.code === 'cancelled' ? { ...result, cancelled: true } : result));
}
