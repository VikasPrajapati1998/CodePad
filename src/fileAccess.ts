import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { errorCode, isErrnoCode } from './errorUtils';
import * as textCodec from './textCodec';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_WRITE_CHARS = 64 * 1024 * 1024;
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
const HASH_ALGORITHMS = new Set(['md5', 'sha1', 'sha256', 'sha384', 'sha512']);

const MB = 1024 * 1024;
/** Extensions the binary reader accepts, with their size caps. */
const BINARY_READ_LIMITS: Record<string, number> = {
  '.docx': 50 * MB,
  '.xlsx': 50 * MB,
  '.xls': 50 * MB,
  '.ods': 50 * MB,
  '.csv': 50 * MB,
  '.tsv': 50 * MB,
  '.pdf': 100 * MB,
};
/** Formats the editors can write back (legacy .xls/.ods are read-only). */
const BINARY_WRITE_EXTENSIONS = new Set(['.docx', '.xlsx', '.csv', '.tsv', '.pdf']);
const MAX_WRITE_BYTES = 200 * MB;
const ZIP_SIGNATURE = Buffer.from('PK\x03\x04', 'latin1');
const BINARY_SIGNATURES: Record<string, Buffer> = {
  '.docx': ZIP_SIGNATURE,
  '.xlsx': ZIP_SIGNATURE,
  '.pdf': Buffer.from('%PDF-', 'latin1'),
};

/** Windows device names, which open hardware instead of a file (with or without an extension). */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Real paths of individual files the user chose (open dialog, save dialog, drop). */
const approvedFiles = new Set<string>();
/** Lexical (as chosen, normalized) path of each approved file -> its real path, for the pre-check before any disk access. */
const lexicalFiles = new Map<string, string>();
/** Real path of the folder the user opened; everything beneath it is accessible. */
let approvedRoot: string | null = null;
/** The folder as the user chose it (before symlink resolution), for the lexical pre-check. */
let lexicalRoot: string | null = null;

const NOT_GRANTED = 'Access to this path has not been granted.';

const normalize = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** A link target that leaves the local disk: UNC, device namespace or NT object path (a `\\?\C:\` drive path is local). */
function isRemoteLinkTarget(target: string): boolean {
  if (/^[\\/]{2}[?.][\\/][a-z]:/i.test(target) || /^[\\/]\?\?[\\/][a-z]:/i.test(target)) {
    return false;
  }
  return /^[\\/]{2}/.test(target) || /^[\\/]\?\?[\\/]/.test(target);
}

/**
 * Windows-only: walks the components of `p` with lstat/readlink (never realpath) and refuses any symlink or junction
 * whose target is a UNC/device path, so resolving the path can never send an SMB request. Local links are followed
 * lexically (they are resolved for real afterwards). Missing components end the walk; realpath reports those.
 */
async function assertNoRemoteLinks(p: string, budget = { hops: 40 }): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const { root } = path.parse(p);
  const parts = p.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    const next = path.join(current, parts[i]);
    let target: string;
    try {
      if (!(await fs.lstat(next)).isSymbolicLink()) {
        current = next;
        continue;
      }
      target = await fs.readlink(next);
    } catch {
      return;
    }
    budget.hops -= 1;
    if (budget.hops < 0) {
      throw new Error('Too many levels of symbolic links.');
    }
    if (isRemoteLinkTarget(target)) {
      throw new Error('Network (UNC) paths are not supported.');
    }
    await assertNoRemoteLinks(path.join(path.resolve(current, target), ...parts.slice(i + 1)), budget);
    return;
  }
}

/** A filesystem failure reduced to a fixed errno-style code and a message that names no path. */
class BoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause: unknown) {
    super(message, { cause });
    this.code = code;
  }
}

/** Maps a raw filesystem error to a fixed code and a message without any path. */
function toBoundaryError(error: unknown): unknown {
  const code = errorCode(error);
  if (code === undefined || error instanceof BoundaryError) {
    return error;
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new BoundaryError('ENOENT', 'The file or folder does not exist.', error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new BoundaryError(code, 'The system denied access.', error);
  }
  if (code === 'EEXIST') {
    return new BoundaryError(code, 'The file already exists.', error);
  }
  return new BoundaryError('EIO', 'The file operation failed.', error);
}

/** Wraps an async operation so raw fs errors (full paths, errno text) never leave fileAccess. */
function bounded<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await operation(...args);
    } catch (error) {
      throw toBoundaryError(error);
    }
  };
}

/** Windows-only: alternate data streams, reserved device names and segments Windows silently rewrites. */
function assertWindowsSafe(p: string): void {
  if (p.indexOf(':', 2) !== -1) {
    throw new Error('Alternate data streams are not supported.');
  }
  p.split(/[\\/]/)
    .slice(1)
    .forEach((segment) => {
      if (RESERVED_NAME.test(segment)) {
        throw new Error('Reserved device names are not supported.');
      }
      if (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) {
        throw new Error('Names ending with a dot or a space are not supported.');
      }
    });
}

function assertUsablePath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new Error('Invalid path.');
  }
  if (!path.isAbsolute(p)) {
    throw new Error('Path must be absolute.');
  }
  if (isUncPath(p)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  if (process.platform === 'win32') {
    assertWindowsSafe(p);
  }
}

/** True when the path passes the syntactic checks (does not touch the disk or the allow-list). */
function isUsablePath(p: unknown): boolean {
  try {
    assertUsablePath(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolves symlinks; for a file that does not exist yet, resolves its parent directory. */
async function realpathOrParent(p: string): Promise<string> {
  await assertNoRemoteLinks(p);
  try {
    return await fs.realpath(p);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) {
      throw error;
    }
    return path.join(await fs.realpath(path.dirname(p)), path.basename(p));
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(normalize(root), normalize(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** True when the path, taken as written (no disk access), is an approved file or lies in an approved folder. */
function isLexicallyAllowed(p: string): boolean {
  const key = normalize(path.resolve(p));
  const inside = (root: string | null): boolean => root !== null && (key === normalize(root) || isInside(root, key));
  return approvedFiles.has(key) || lexicalFiles.has(key) || inside(lexicalRoot) || inside(approvedRoot);
}

/**
 * Resolves a renderer-supplied path and rejects it unless the user granted access to it. The allow-list is checked
 * on the written path before the disk is touched, so a path outside it never reveals whether it exists.
 */
async function resolveAllowedImpl(p: unknown): Promise<string> {
  assertUsablePath(p);
  if (!isLexicallyAllowed(p)) {
    throw new Error(NOT_GRANTED);
  }
  const real = await realpathOrParent(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  const allowed =
    approvedFiles.has(normalize(real)) ||
    (approvedRoot !== null && (normalize(real) === normalize(approvedRoot) || isInside(approvedRoot, real)));
  if (!allowed) {
    throw new Error(NOT_GRANTED);
  }
  return real;
}
const resolveAllowed = bounded(resolveAllowedImpl);

/** True when the user has granted access to the path. Never throws. */
async function isAllowed(p: unknown): Promise<boolean> {
  try {
    await resolveAllowed(p);
    return true;
  } catch {
    return false;
  }
}

/** The currently opened workspace folder (real path), or null. */
function getApprovedRoot(): string | null {
  return approvedRoot;
}

/** Records a user-chosen file (from a dialog, drop or main-held list) as accessible; returns its real path. */
async function approveFileImpl(p: unknown): Promise<string> {
  assertUsablePath(p);
  const real = await realpathOrParent(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  try {
    if (!(await fs.stat(real)).isFile()) {
      throw new Error('Only regular files can be opened.');
    }
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) {
      throw error;
    }
  }
  approvedFiles.add(normalize(real));
  lexicalFiles.set(normalize(path.resolve(p)), normalize(real));
  return real;
}
const approveFile = bounded(approveFileImpl);

/** Withdraws the approval of one file (after it was renamed or moved to the trash); a path under the opened folder stays reachable through the folder. */
function revokeFile(p: unknown): void {
  if (typeof p !== 'string' || !path.isAbsolute(p)) {
    return;
  }
  const key = normalize(path.resolve(p));
  const real = lexicalFiles.get(key) ?? key;
  approvedFiles.delete(real);
  approvedFiles.delete(key);
  lexicalFiles.forEach((target, lexical) => {
    if (target === real || lexical === key) {
      lexicalFiles.delete(lexical);
    }
  });
}

/**
 * Records the user-chosen workspace folder, replacing any previous one. A filesystem root is never accepted;
 * a folder restored from a saved session may not be the home directory itself either.
 */
async function approveRootImpl(p: unknown, { fromSession = false }: { fromSession?: boolean } = {}): Promise<void> {
  assertUsablePath(p);
  await assertNoRemoteLinks(p);
  const real = await fs.realpath(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  if (!(await fs.stat(real)).isDirectory()) {
    throw new Error('Not a folder.');
  }
  if (path.parse(real).root === real) {
    throw new Error('A drive or filesystem root cannot be opened as a folder.');
  }
  if (fromSession && normalize(real) === normalize(await fs.realpath(os.homedir()))) {
    throw new Error('The home folder cannot be restored as the workspace.');
  }
  approvedRoot = real;
  lexicalRoot = path.resolve(p);
}
const approveRoot = bounded(approveRootImpl);

// ---------- File operations ----------

/**
 * Reads a text file through a handle with a hard size cap (the file may grow after the stat).
 * @param p Renderer-supplied path (must be allowed).
 * @param options `encoding` forces decoding with that id.
 */
async function readTextFileImpl(
  p: string,
  { encoding = null, fallback }: { encoding?: string | null; fallback?: string } = {},
): Promise<CpReadTextResult> {
  const real = await resolveAllowed(p);
  if (encoding !== null && !textCodec.isKnownEncoding(encoding)) {
    throw new Error('Unknown encoding.');
  }
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Not a regular file.');
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { path: p, tooLarge: true, size: stat.size };
    }
    // One byte more than the stat said: if it is filled, the file grew after the size check.
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) {
      throw new Error('The file changed while it was being read.');
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (encoding === null && textCodec.detect(bytes, { fallback }).binary) {
      return { path: p, binary: true, size: bytesRead };
    }
    const decoded = textCodec.decode(bytes, encoding, { fallback });
    return { path: p, ...decoded, mtimeMs: stat.mtimeMs, size: bytesRead };
  } finally {
    await handle.close();
  }
}

/**
 * Writes via a temp file and rename so an interrupted save cannot truncate the original; returns the new stat.
 * With `exclusive` the target must not exist: it is created with the `wx` flag (fails with EEXIST instead of
 * replacing anything) and a failed write removes only the file this call created.
 */
async function writeAtomicImpl(
  real: string,
  buffer: Buffer,
  { exclusive = false }: { exclusive?: boolean } = {},
): Promise<CpFileStamp> {
  if (exclusive) {
    const handle = await fs.open(real, 'wx');
    try {
      await handle.writeFile(buffer);
    } catch (error) {
      await handle.close();
      await fs.rm(real, { force: true });
      throw error;
    }
    await handle.close();
  } else {
    const temp = `${real}.codepad-${process.pid}-${Date.now()}.tmp`;
    try {
      let mode: number | undefined;
      try {
        mode = (await fs.stat(real)).mode;
      } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) {
          throw error;
        }
      }
      await fs.writeFile(temp, buffer, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
      await fs.rename(temp, real);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }
  const stat = await fs.stat(real);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}
const writeAtomic = bounded(writeAtomicImpl);

/**
 * Encodes and writes text.
 * @returns The lossy result means nothing was written.
 */
async function writeTextFileImpl(
  p: string,
  content: unknown,
  encoding = 'utf8',
  { allowLossy = false }: CpWriteOptions = {},
): Promise<CpWriteTextResult> {
  if (typeof content !== 'string' || content.length > MAX_TEXT_WRITE_CHARS) {
    throw new Error('Invalid or oversized file content.');
  }
  if (!textCodec.isKnownEncoding(encoding)) {
    throw new Error('Unknown encoding.');
  }
  const real = await resolveAllowed(p);
  if (!allowLossy) {
    const check = textCodec.checkEncodable(content, encoding);
    if (check.lossy) {
      return { ok: false, lossy: true, firstBad: check.firstBad, badChar: check.badChar };
    }
  }
  const stat = await writeAtomic(real, textCodec.encode(content, encoding));
  return { ok: true, ...stat };
}

/** Reads a document/spreadsheet/PDF as raw bytes; the extension decides the size cap. */
async function readBinaryFileImpl(p: string): Promise<CpReadBinaryResult> {
  const real = await resolveAllowed(p);
  const limit = BINARY_READ_LIMITS[path.extname(real).toLowerCase()];
  if (limit === undefined) {
    throw new Error('Unsupported file type.');
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new Error('Not a regular file.');
  }
  if (stat.size > limit) {
    return { path: p, size: stat.size, tooLarge: true };
  }
  const buffer = await fs.readFile(real);
  return {
    path: p,
    size: buffer.length,
    mtimeMs: stat.mtimeMs,
    bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
  };
}

/** Writes bytes produced by an editor view; only known formats are accepted and their signature is checked. */
async function writeBinaryFileImpl(p: string, buffer: Buffer): Promise<CpFileStamp> {
  const real = await resolveAllowed(p);
  const ext = path.extname(real).toLowerCase();
  if (!BINARY_WRITE_EXTENSIONS.has(ext)) {
    throw new Error('Unsupported file type.');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_WRITE_BYTES) {
    throw new Error('Invalid or oversized file data.');
  }
  const signature = BINARY_SIGNATURES[ext];
  if (signature && !buffer.subarray(0, signature.length).equals(signature)) {
    throw new Error(`The data is not a valid ${ext.slice(1).toUpperCase()} file.`);
  }
  return writeAtomic(real, buffer);
}

/** Stat of an allowed path; a missing file is reported as data, not an error. */
async function statFileImpl(p: string): Promise<CpStatResult> {
  const real = await resolveAllowed(p);
  try {
    const stat = await fs.stat(real);
    return { exists: true, isFile: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { exists: false, isFile: false, mtimeMs: 0, size: 0 };
    }
    throw error;
  }
}

/** Streams a regular file through a hash. */
async function hashFileImpl(p: string, algo: string): Promise<CpHashResult> {
  if (!HASH_ALGORITHMS.has(algo)) {
    throw new Error('Unsupported hash algorithm.');
  }
  const real = await resolveAllowed(p);
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new Error('Not a regular file.');
  }
  if (stat.size > MAX_HASH_BYTES) {
    throw new Error('The file is too large to hash.');
  }
  const hash = crypto.createHash(algo);
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(real);
    stream.on('data', (chunk: string | Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return { hex: hash.digest('hex'), size };
}

/** True when both paths resolve to the same file (the second may not exist yet). Never throws. */
async function isSameFile(a: unknown, b: unknown): Promise<boolean> {
  try {
    assertUsablePath(a);
    assertUsablePath(b);
    return normalize(await realpathOrParent(a)) === normalize(await realpathOrParent(b));
  } catch {
    return false;
  }
}

/**
 * True when both paths resolve to the same file and the first is already approved. Never throws.
 * Used by the renderer to open one tab per file even when the paths differ in case, `.` segments or links.
 */
async function isSameApprovedFile(a: unknown, b: unknown): Promise<boolean> {
  return (await isAllowed(a)) && (await isSameFile(a, b));
}

/**
 * Builds one listing entry. Symlinks and junctions to directories are dropped, so the tree can neither leave the
 * opened folder nor loop; links to files are kept only when the target is inside the approved area.
 * Windows reports junctions as plain directories, so every directory is lstat-ed.
 */
async function toDirEntry(real: string, p: string, entry: fsSync.Dirent): Promise<CpDirEntry | null> {
  const full = path.join(real, entry.name);
  const listed = { name: entry.name, path: path.join(p, entry.name) };
  try {
    const isLink = entry.isSymbolicLink() || (entry.isDirectory() && (await fs.lstat(full)).isSymbolicLink());
    if (!isLink) {
      return { ...listed, isDirectory: entry.isDirectory() };
    }
    const target = await resolveAllowed(full);
    return (await fs.stat(target)).isFile() ? { ...listed, isDirectory: false } : null;
  } catch {
    // Vanished, broken link, outside the approved area or a network target: not listed.
    return null;
  }
}

async function readDirectoryImpl(p: string): Promise<CpDirEntry[]> {
  const real = await resolveAllowed(p);
  const entries = await fs.readdir(real, { withFileTypes: true });
  const listed = await Promise.all(entries.map((entry) => toDirEntry(real, p, entry)));
  return listed
    .filter((entry): entry is CpDirEntry => entry !== null)
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : a.isDirectory ? -1 : 1,
    );
}

const readTextFile = bounded(readTextFileImpl);
const writeTextFile = bounded(writeTextFileImpl);
const readBinaryFile = bounded(readBinaryFileImpl);
const writeBinaryFile = bounded(writeBinaryFileImpl);
const statFile = bounded(statFileImpl);
const hashFile = bounded(hashFileImpl);
const readDirectory = bounded(readDirectoryImpl);

export {
  approveFile,
  revokeFile,
  approveRoot,
  isAllowed,
  isUsablePath,
  isSameFile,
  isSameApprovedFile,
  resolveAllowed,
  getApprovedRoot,
  assertWindowsSafe,
  isInside,
  writeAtomic,
  readTextFile,
  writeTextFile,
  readBinaryFile,
  writeBinaryFile,
  statFile,
  hashFile,
  readDirectory,
};
