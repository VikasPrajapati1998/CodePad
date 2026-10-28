/**
 * Structural validation of a GGUF file header (main process). A non-built-in model is third-party data that
 * llama.cpp parses in native code, so before such a file is handed to the AI worker the magic, the version, the
 * tensor and metadata counts, every metadata key/value and every tensor description are walked with bounded
 * reads. Nothing is allocated from a count read out of the file, and every length must fit inside the file.
 * This rejects malformed or hostile headers cheaply; it is not a guarantee that the weights are benign (the file
 * could also change after the check), so the worker's own limits remain defence in depth.
 */
import * as fs from 'fs/promises';

const MAGIC = 'GGUF';
const SUPPORTED_VERSIONS = new Set([2, 3]);
const MAX_TENSORS = 200000;
const MAX_METADATA_ENTRIES = 8192;
const MAX_KEY_BYTES = 65535;
const MAX_TENSOR_NAME_BYTES = 64;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 16 * 1024 * 1024;
const MAX_ARRAY_DEPTH = 2;
const MAX_DIMENSIONS = 4;
const MAX_TENSOR_TYPE = 64;
const READ_WINDOW = 256 * 1024;
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;
// Byte size of the fixed-size metadata value types (u8 i8 u16 i16 u32 i32 f32 bool - u64 i64 f64).
const FIXED_SIZES: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** The file is not a structurally valid GGUF file. */
export class GgufError extends Error {
  /** @param reason Short, content-free description of what is wrong. */
  constructor(reason: string) {
    super(`Not a valid GGUF file (${reason}).`);
    this.name = 'GgufError';
  }
}

/**
 * Walks the header of a GGUF file.
 * @param file Absolute path of the file.
 * @returns Resolves when the header is structurally sane.
 * @throws {GgufError} The header is malformed, truncated or has implausible sizes.
 */
export async function validateGgufHeader(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let pos = 0;
    let window = Buffer.alloc(0);
    let windowStart = 0;

    const skip = (count: number): void => {
      if (!Number.isSafeInteger(count) || count < 0 || pos + count > size) {
        throw new GgufError('truncated or oversized field');
      }
      pos += count;
    };
    const take = async (count: number): Promise<Buffer> => {
      if (count > READ_WINDOW || pos + count > size) {
        throw new GgufError('truncated or oversized field');
      }
      if (pos < windowStart || pos + count > windowStart + window.length) {
        const length = Math.min(READ_WINDOW, size - pos);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, pos);
        if (bytesRead !== length) {
          throw new GgufError('short read');
        }
        window = buffer;
        windowStart = pos;
      }
      const out = window.subarray(pos - windowStart, pos - windowStart + count);
      pos += count;
      return out;
    };
    const u32 = async (): Promise<number> => (await take(4)).readUInt32LE(0);
    const u64 = async (): Promise<number> => {
      const value = (await take(8)).readBigUInt64LE(0);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new GgufError('implausible number');
      }
      return Number(value);
    };
    const string = async (max: number): Promise<void> => {
      const length = await u64();
      if (length > max) {
        throw new GgufError('string too long');
      }
      skip(length);
    };
    const value = async (type: number, depth: number): Promise<void> => {
      if (type === TYPE_STRING) {
        await string(MAX_STRING_BYTES);
      } else if (type === TYPE_ARRAY) {
        if (depth >= MAX_ARRAY_DEPTH) {
          throw new GgufError('arrays nested too deeply');
        }
        const itemType = await u32();
        const count = await u64();
        if (count > MAX_ARRAY_ITEMS) {
          throw new GgufError('array too long');
        }
        const itemSize = FIXED_SIZES[itemType];
        if (itemSize !== undefined) {
          skip(count * itemSize);
        } else if (itemType === TYPE_STRING || itemType === TYPE_ARRAY) {
          for (let index = 0; index < count; index += 1) {
            await value(itemType, depth + 1);
          }
        } else {
          throw new GgufError('unknown value type');
        }
      } else {
        const fixed = FIXED_SIZES[type];
        if (fixed === undefined) {
          throw new GgufError('unknown value type');
        }
        skip(fixed);
      }
    };

    if ((await take(MAGIC.length)).toString('latin1') !== MAGIC) {
      throw new GgufError('bad magic');
    }
    if (!SUPPORTED_VERSIONS.has(await u32())) {
      throw new GgufError('unsupported version');
    }
    const tensorCount = await u64();
    const metadataCount = await u64();
    if (tensorCount > MAX_TENSORS || metadataCount > MAX_METADATA_ENTRIES) {
      throw new GgufError('implausible counts');
    }
    for (let index = 0; index < metadataCount; index += 1) {
      await string(MAX_KEY_BYTES);
      await value(await u32(), 0);
    }
    for (let index = 0; index < tensorCount; index += 1) {
      await string(MAX_TENSOR_NAME_BYTES);
      const dimensions = await u32();
      if (dimensions > MAX_DIMENSIONS) {
        throw new GgufError('too many tensor dimensions');
      }
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        await u64();
      }
      if ((await u32()) > MAX_TENSOR_TYPE) {
        throw new GgufError('unknown tensor type');
      }
      if ((await u64()) > size) {
        throw new GgufError('tensor outside the file');
      }
    }
  } finally {
    await handle.close();
  }
}
