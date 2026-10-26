'use strict';

const fs = require('fs/promises');
const path = require('path');

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Real paths of individual files the user chose (open dialog, save dialog, drop). */
const approvedFiles = new Set();
/** Real path of the folder the user opened; everything beneath it is accessible. */
let approvedRoot = null;

const normalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isUncPath(p) {
  return /^[\\/]{2}/.test(p);
}

function assertUsablePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new Error('Invalid path.');
  }
  if (!path.isAbsolute(p)) {
    throw new Error('Path must be absolute.');
  }
  if (isUncPath(p)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
}

/** Resolves symlinks; for a file that does not exist yet, resolves its parent directory. */
async function realpathOrParent(p) {
  try {
    return await fs.realpath(p);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return path.join(await fs.realpath(path.dirname(p)), path.basename(p));
  }
}

function isInside(root, target) {
  const relative = path.relative(normalize(root), normalize(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolves a renderer-supplied path and rejects it unless the user granted access to it. */
async function resolveAllowed(p) {
  assertUsablePath(p);
  const real = await realpathOrParent(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  const allowed =
    approvedFiles.has(normalize(real)) ||
    (approvedRoot !== null && (normalize(real) === normalize(approvedRoot) || isInside(approvedRoot, real)));
  if (!allowed) {
    throw new Error('Access to this path has not been granted.');
  }
  return real;
}

/** Records a user-chosen file (from a dialog or drop) as accessible. */
async function approveFile(p) {
  assertUsablePath(p);
  const real = await realpathOrParent(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  try {
    if ((await fs.stat(real)).isDirectory()) {
      throw new Error('Folders cannot be opened as files.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  approvedFiles.add(normalize(real));
}

/** Records the user-chosen workspace folder, replacing any previous one. */
async function approveRoot(p) {
  assertUsablePath(p);
  const real = await fs.realpath(p);
  if (isUncPath(real)) {
    throw new Error('Network (UNC) paths are not supported.');
  }
  approvedRoot = real;
}

// ---------- Encodings ----------

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function swapBytes(buffer) {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    [out[i], out[i + 1]] = [out[i + 1], out[i]];
  }
  return out;
}

function decode(buffer) {
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf8bom', content: buffer.subarray(3).toString('utf8') };
  }
  if (buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    return { encoding: 'utf16le', content: buffer.subarray(2).toString('utf16le') };
  }
  if (buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    return { encoding: 'utf16be', content: swapBytes(buffer.subarray(2)).toString('utf16le') };
  }
  try {
    return { encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch {
    return { encoding: 'latin1', content: buffer.toString('latin1') };
  }
}

function encode(content, encoding) {
  switch (encoding) {
    case 'utf8bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([UTF16LE_BOM, Buffer.from(content, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([UTF16BE_BOM, swapBytes(Buffer.from(content, 'utf16le'))]);
    case 'latin1':
      return Buffer.from(content, 'latin1');
    default:
      return Buffer.from(content, 'utf8');
  }
}

// ---------- File operations ----------

async function readTextFile(p) {
  const real = await resolveAllowed(p);
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new Error('Not a regular file.');
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { path: p, tooLarge: true, size: stat.size };
  }
  const buffer = await fs.readFile(real);
  const isUtf16 = buffer.subarray(0, 2).equals(UTF16LE_BOM) || buffer.subarray(0, 2).equals(UTF16BE_BOM);
  if (!isUtf16 && buffer.includes(0)) {
    return { path: p, binary: true, size: stat.size };
  }
  return { path: p, ...decode(buffer) };
}

/** Writes via a temp file and rename so an interrupted save cannot truncate the original. */
async function writeTextFile(p, content, encoding) {
  const real = await resolveAllowed(p);
  const temp = `${real}.codepad-${process.pid}.tmp`;
  try {
    let mode;
    try {
      mode = (await fs.stat(real)).mode;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await fs.writeFile(temp, encode(content, encoding), mode === undefined ? undefined : { mode });
    await fs.rename(temp, real);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function readDirectory(p) {
  const real = await resolveAllowed(p);
  const entries = await fs.readdir(real, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: path.join(p, entry.name),
      isDirectory: entry.isDirectory(),
    }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : a.isDirectory ? -1 : 1,
    );
}

module.exports = { approveFile, approveRoot, readTextFile, writeTextFile, readDirectory };
