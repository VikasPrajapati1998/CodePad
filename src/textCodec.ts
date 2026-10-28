import iconv from 'iconv-lite';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const SNIFF_BYTES = 65536;
const UTF16_PATTERN_RATIO = 0.9;
const UTF16_OTHER_RATIO = 0.02;
const REPLACEMENT_CHAR = '�';
const LONE_SURROGATE = /[\ud800-\udfff]/u;

const GROUPS: Record<string, string> = {
  unicode: 'Unicode',
  western: 'Western European',
  central: 'Central European',
  cyrillic: 'Cyrillic',
  other: 'Greek, Turkish, Hebrew, Arabic, Baltic',
  chinese: 'Chinese',
  japanese: 'Japanese',
  korean: 'Korean',
  thai: 'Thai, Vietnamese',
  dos: 'DOS / OEM',
};

const NATIVE: CpEncodingInfo[] = [
  { id: 'utf8', label: 'UTF-8', group: GROUPS.unicode, bom: false },
  { id: 'utf8bom', label: 'UTF-8 with BOM', group: GROUPS.unicode, bom: true },
  { id: 'utf16le', label: 'UTF-16 LE (BOM)', group: GROUPS.unicode, bom: true },
  { id: 'utf16be', label: 'UTF-16 BE (BOM)', group: GROUPS.unicode, bom: true },
  { id: 'latin1', label: 'Latin-1 (ISO-8859-1)', group: GROUPS.western, bom: false },
];

const ICONV: Array<[id: string, label: string, group: string]> = [
  ['windows-1252', 'Windows-1252 (ANSI)', GROUPS.western],
  ['iso-8859-15', 'ISO-8859-15 (Latin-9)', GROUPS.western],
  ['macintosh', 'Mac Roman', GROUPS.western],
  ['windows-1250', 'Windows-1250', GROUPS.central],
  ['iso-8859-2', 'ISO-8859-2 (Latin-2)', GROUPS.central],
  ['iso-8859-16', 'ISO-8859-16', GROUPS.central],
  ['windows-1251', 'Windows-1251', GROUPS.cyrillic],
  ['iso-8859-5', 'ISO-8859-5', GROUPS.cyrillic],
  ['koi8-r', 'KOI8-R', GROUPS.cyrillic],
  ['koi8-u', 'KOI8-U', GROUPS.cyrillic],
  ['windows-1253', 'Windows-1253 (Greek)', GROUPS.other],
  ['windows-1254', 'Windows-1254 (Turkish)', GROUPS.other],
  ['windows-1255', 'Windows-1255 (Hebrew)', GROUPS.other],
  ['windows-1256', 'Windows-1256 (Arabic)', GROUPS.other],
  ['windows-1257', 'Windows-1257 (Baltic)', GROUPS.other],
  ['iso-8859-3', 'ISO-8859-3', GROUPS.other],
  ['iso-8859-4', 'ISO-8859-4', GROUPS.other],
  ['iso-8859-6', 'ISO-8859-6 (Arabic)', GROUPS.other],
  ['iso-8859-7', 'ISO-8859-7 (Greek)', GROUPS.other],
  ['iso-8859-8', 'ISO-8859-8 (Hebrew)', GROUPS.other],
  ['iso-8859-9', 'ISO-8859-9 (Turkish)', GROUPS.other],
  ['iso-8859-10', 'ISO-8859-10', GROUPS.other],
  ['iso-8859-13', 'ISO-8859-13 (Baltic)', GROUPS.other],
  ['gbk', 'GBK (Simplified Chinese)', GROUPS.chinese],
  ['gb18030', 'GB18030', GROUPS.chinese],
  ['big5', 'Big5 (Traditional Chinese)', GROUPS.chinese],
  ['shift_jis', 'Shift_JIS', GROUPS.japanese],
  ['euc-jp', 'EUC-JP', GROUPS.japanese],
  ['euc-kr', 'EUC-KR', GROUPS.korean],
  ['windows-874', 'Windows-874 (Thai)', GROUPS.thai],
  ['windows-1258', 'Windows-1258 (Vietnamese)', GROUPS.thai],
  ['cp437', 'DOS 437 (US)', GROUPS.dos],
  ['cp850', 'DOS 850 (Western European)', GROUPS.dos],
  ['cp852', 'DOS 852 (Central European)', GROUPS.dos],
  ['cp866', 'DOS 866 (Cyrillic)', GROUPS.dos],
];

/** Every encoding id the app accepts (iconv ids are kept only when the installed iconv-lite knows them). */
const ENCODINGS: readonly CpEncodingInfo[] = Object.freeze([
  ...NATIVE,
  ...ICONV.filter(([id]) => iconv.encodingExists(id)).map(([id, label, group]) => ({ id, label, group, bom: false })),
]);
const KNOWN = new Set(ENCODINGS.map((item) => item.id));
const ICONV_IDS = new Set(ICONV.map(([id]) => id));

/** True for an id this module can decode and encode. */
function isKnownEncoding(id: unknown): id is string {
  return typeof id === 'string' && KNOWN.has(id);
}

const isUtf16 = (id: string): boolean => id === 'utf16le' || id === 'utf16be';

function swapBytes(buffer: Buffer): Buffer {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    [out[i], out[i + 1]] = [out[i + 1], out[i]];
  }
  return out;
}

/** Detects UTF-16 without a BOM from the NUL pattern of the first bytes; null when the sample does not look like it. */
function sniffUtf16(buffer: Buffer): 'utf16le' | 'utf16be' | null {
  const sample = buffer.subarray(0, SNIFF_BYTES - (SNIFF_BYTES % 2));
  const pairs = Math.floor(sample.length / 2);
  if (pairs < 2) {
    return null;
  }
  let nulEven = 0;
  let nulOdd = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    nulEven += sample[i] === 0 ? 1 : 0;
    nulOdd += sample[i + 1] === 0 ? 1 : 0;
  }
  if (nulOdd >= pairs * UTF16_PATTERN_RATIO && nulEven <= pairs * UTF16_OTHER_RATIO) {
    return 'utf16le';
  }
  if (nulEven >= pairs * UTF16_PATTERN_RATIO && nulOdd <= pairs * UTF16_OTHER_RATIO) {
    return 'utf16be';
  }
  return null;
}

/** True when a BOM-prefixed UTF-16 sample contains a NUL code unit (text never does; binary data after a BOM does). */
function hasNulCodeUnit(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES) - 1;
  for (let i = 2; i < end; i += 2) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      return true;
    }
  }
  return false;
}

/** Result of `detect`. */
export interface DetectedEncoding {
  encoding: string;
  /** BOM length. */
  offset: number;
  /** Set when the bytes contain NULs that do not fit UTF-16. */
  binary: boolean;
}

/** Options of `detect` and `decode`. */
export interface CodecOptions {
  /** Encoding used when the bytes are not valid UTF-8; defaults to windows-1252. */
  fallback?: string;
}

/**
 * Picks an encoding for a buffer: BOM, then NUL-pattern UTF-16, then strict UTF-8, else `fallback`.
 * @param buffer File bytes.
 */
function detect(buffer: Buffer, { fallback = 'windows-1252' }: CodecOptions = {}): DetectedEncoding {
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf8bom', offset: 3, binary: buffer.subarray(3, SNIFF_BYTES).includes(0) };
  }
  if (buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    return { encoding: 'utf16le', offset: 2, binary: hasNulCodeUnit(buffer) };
  }
  if (buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    return { encoding: 'utf16be', offset: 2, binary: hasNulCodeUnit(buffer) };
  }
  const utf16 = sniffUtf16(buffer);
  if (utf16) {
    return { encoding: utf16, offset: 0, binary: false };
  }
  if (buffer.includes(0)) {
    return { encoding: 'utf8', offset: 0, binary: true };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf8', offset: 0, binary: false };
  } catch {
    return { encoding: isKnownEncoding(fallback) ? fallback : 'windows-1252', offset: 0, binary: false };
  }
}

function stripBom(buffer: Buffer, bom: Buffer): Buffer {
  return buffer.subarray(0, bom.length).equals(bom) ? buffer.subarray(bom.length) : buffer;
}

function decodeWith(buffer: Buffer, id: string): string {
  switch (id) {
    case 'utf8':
    case 'utf8bom':
      return new TextDecoder('utf-8').decode(buffer);
    case 'utf16le':
      return stripBom(buffer, UTF16LE_BOM).toString('utf16le');
    case 'utf16be':
      return swapBytes(stripBom(buffer, UTF16BE_BOM)).toString('utf16le');
    case 'latin1':
      return buffer.toString('latin1');
    default:
      return iconv.decode(buffer, id);
  }
}

/** Result of `decode`. */
export interface DecodedText {
  encoding: string;
  content: string;
  replaced: boolean;
}

/**
 * Decodes file bytes. `replaced` is true when the result contains U+FFFD (a wrong guess or damaged bytes).
 * @param buffer File bytes.
 * @param encodingId Forced encoding, or null to detect.
 */
function decode(buffer: Buffer, encodingId: string | null | undefined, options: CodecOptions = {}): DecodedText {
  if (encodingId !== null && encodingId !== undefined && !isKnownEncoding(encodingId)) {
    throw new Error(`Unknown encoding: ${String(encodingId).slice(0, 40)}`);
  }
  const encoding = encodingId || detect(buffer, options).encoding;
  const content = decodeWith(buffer, encoding);
  return { encoding, content, replaced: content.includes(REPLACEMENT_CHAR) };
}

/** Index of the first lone surrogate, or -1. */
function firstLoneSurrogate(content: string): number {
  const match = LONE_SURROGATE.exec(content);
  return match ? match.index : -1;
}

function replaceUnrepresentableLatin1(content: string): string {
  let out = '';
  for (const char of content) {
    out += (char.codePointAt(0) ?? 0) > 0xff ? '?' : char;
  }
  return out;
}

/**
 * Encodes text. Characters the target cannot represent are substituted (use `checkEncodable` first to refuse);
 * Unicode encodings that need a BOM get one.
 * @param content Text to encode.
 * @param encodingId A known encoding id.
 */
function encode(content: string, encodingId: string): Buffer {
  if (!isKnownEncoding(encodingId)) {
    throw new Error(`Unknown encoding: ${String(encodingId).slice(0, 40)}`);
  }
  switch (encodingId) {
    case 'utf8':
      return Buffer.from(content, 'utf8');
    case 'utf8bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([UTF16LE_BOM, Buffer.from(content, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([UTF16BE_BOM, swapBytes(Buffer.from(content, 'utf16le'))]);
    case 'latin1':
      return Buffer.from(replaceUnrepresentableLatin1(content), 'latin1');
    default:
      return iconv.encode(content, encodingId);
  }
}

function describeBad(content: string, index: number): string {
  const code = content.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}

/**
 * Tells whether text survives a round trip through an encoding.
 * @param content Text to check.
 * @param encodingId A known encoding id.
 * @returns `firstBad` is a UTF-16 index (-1 when lossless) and `count` the number of unrepresentable characters.
 */
function checkEncodable(content: string, encodingId: string): CpEncodableCheck {
  if (!isKnownEncoding(encodingId)) {
    throw new Error(`Unknown encoding: ${String(encodingId).slice(0, 40)}`);
  }
  const ok: CpEncodableCheck = { lossy: false, firstBad: -1, badChar: '', count: 0 };
  if (encodingId.startsWith('utf')) {
    const index = firstLoneSurrogate(content);
    return index < 0 ? ok : { lossy: true, firstBad: index, badChar: describeBad(content, index), count: 1 };
  }
  let firstBad = -1;
  let count = 0;
  if (encodingId === 'latin1') {
    for (let i = 0; i < content.length; ) {
      const code = content.codePointAt(i) ?? 0;
      if (code > 0xff) {
        firstBad = firstBad < 0 ? i : firstBad;
        count += 1;
      }
      i += code > 0xffff ? 2 : 1;
    }
  } else {
    const roundTrip = iconv.decode(iconv.encode(content, encodingId), encodingId);
    let i = 0;
    let j = 0;
    while (i < content.length) {
      const a = content.codePointAt(i) ?? 0;
      const b = roundTrip.codePointAt(j);
      if (a !== b) {
        firstBad = firstBad < 0 ? i : firstBad;
        count += 1;
      }
      i += a > 0xffff ? 2 : 1;
      j += b === undefined ? 1 : b > 0xffff ? 2 : 1;
    }
  }
  return count === 0
    ? ok
    : { lossy: true, firstBad, badChar: describeBad(content, firstBad), count };
}

/** True for ids decoded through iconv-lite (everything except the native Unicode and Latin-1 ids). */
const isLegacyEncoding = (id: string): boolean => ICONV_IDS.has(id);

export {
  ENCODINGS,
  isKnownEncoding,
  isLegacyEncoding,
  isUtf16,
  detect,
  decode,
  encode,
  checkEncodable,
};
