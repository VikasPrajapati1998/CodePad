/*
 * Spreadsheet editor (kind 'sheet'): .xlsx .xls .ods .csv .tsv.
 *
 * In-house virtualized DOM grid over an in-memory cell model; SheetJS (window.XLSX, loaded lazily)
 * is used only to read/write xlsx/xls/ods. CSV/TSV are parsed and written by this module.
 * The module never touches IPC: bytes in (create), bytes out (getBytes).
 *
 * Known limits:
 *  - Formulas are kept as text ('=...') and never recalculated. Edited/new formula cells have no
 *    cached result; the workbook is flagged so Excel/LibreOffice recompute on open (a formula
 *    typed in CodePad is stored with a cached value of 0 until then). Copying a formula does not
 *    adjust its references.
 *  - Cell styling (fonts, fills, borders), charts, images, comments, hyperlinks, data validation
 *    and conditional formatting are not preserved (SheetJS Community Edition does not write them).
 *  - Number formats are kept and displayed where SheetJS reads them; dates are edited as ISO text.
 *  - Hard caps: 1,048,576 rows, 16,384 columns, 2,000,000 non-empty cells, 255 sheets.
 *  - CSV holds one sheet (the active one is written); non-UTF-8 CSV is saved back as UTF-8.
 */
(() => {
  type XlsxWorkBook = import('../../../node_modules/xlsx/types/index').WorkBook;
  type XlsxWorkSheet = import('../../../node_modules/xlsx/types/index').WorkSheet;
  type XlsxCellObject = import('../../../node_modules/xlsx/types/index').CellObject;
  type XlsxColInfo = import('../../../node_modules/xlsx/types/index').ColInfo;

  /** Properties shared by every cell kind. `w` is the cached display text. */
  interface CellBase { f?: string; z?: string; w?: string }
  interface NumCell extends CellBase { t: 'n'; v: number }
  interface StrCell extends CellBase { t: 's'; v: string }
  interface BoolCell extends CellBase { t: 'b'; v: boolean }
  interface DateCell extends CellBase { t: 'd'; v: Date }
  /** Error cell: `v` is the error code, `w` the text (e.g. #DIV/0!). */
  interface ErrCell extends CellBase { t: 'e'; v: number }
  type Cell = NumCell | StrCell | BoolCell | DateCell | ErrCell;
  type CellRow = (Cell | undefined)[];

  interface CellPos { r: number; c: number }
  interface MergeRange { s: CellPos; e: CellPos }
  /** Anchor (ar, ac) and focus (fr, fc) of the selection. */
  interface Selection4 { ar: number; ac: number; fr: number; fc: number }
  interface CellRange { r1: number; c1: number; r2: number; c2: number }
  interface Rect { x1: number; y1: number; x2: number; y2: number }

  interface Sheet {
    name: string;
    rows: (CellRow | undefined)[];
    merges: MergeRange[];
    colW: number[];
    nRows: number;
    nCols: number;
    /** Cached used-column count; null when stale. */
    cc: number | null;
    /** Cached column x offsets; null when stale. */
    colX: number[] | null;
    scrollTop: number;
    scrollLeft: number;
    sel: Selection4;
  }

  interface CsvInfo { fs: string; bom: boolean; eol: string; trailing: boolean }

  interface DecodedCsv { text: string; bom: boolean; fallback: boolean }

  interface CellChange { r: number; c: number; cell: Cell | null | undefined }

  /** One undo/redo step. */
  interface HistoryEntry {
    sheet: Sheet;
    redo(): void;
    undo(): void;
  }

  interface EditState { r: number; c: number; mode: 'edit' | 'enter'; sheet: Sheet; prev: Cell | undefined }

  type DragState =
    | { type: 'cell' }
    | { type: 'col' }
    | { type: 'row' }
    | { type: 'resize'; c: number; startX: number; startW: number; hadWidth: boolean };

  interface FormulaBarState {
    dirty: boolean;
    target: { sheet: Sheet; r: number; c: number } | null;
  }

  interface CopyBuffer { text: string; cells: CellRow[] }

  type MenuItem = '-' | { label: string; action: () => void; disabled?: boolean };

  type SortKey = { k: 0; v: number } | { k: 1 | 2; v: string };

  /** JSON-serializable state of one sheet in the session snapshot. */
  interface SheetState {
    name: string;
    rows: (string | number | boolean | null)[][];
    formulas: Record<string, string>;
    dates: Record<string, number>;
    fmts: Record<string, string>;
    errs: Record<string, [number, string]>;
    merges: string[];
    colWidths: number[];
  }

  /** Accumulators filled while converting a sheet to its session state. */
  interface StateMaps {
    formulas: Record<string, string>;
    dates: Record<string, number>;
    fmts: Record<string, string>;
    errs: Record<string, [number, string]>;
  }

  interface SessionState {
    ext: string;
    sheets: SheetState[];
    activeSheet: number;
    csv: CsvInfo;
  }

  /** The untrusted shape of restoredState: validated field by field. */
  interface RestoredState { sheets?: unknown; csv?: unknown; activeSheet?: unknown }

  const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const asNode = (t: EventTarget | null): Node | null => (t instanceof Node ? t : null);
  const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const LIB_PATH = 'xlsx/dist/xlsx.full.min.js';
  const ROW_H = 22;
  const HEADER_H = 24;
  const DEF_COL_W = 100;
  const MIN_COL_W = 24;
  const MAX_COL_W = 1000;
  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;
  const MAX_CELLS = 2000000;
  const MAX_SHEETS = 255;
  const MAX_MERGES = 100000;
  const MAX_TEXT = 32767;
  const MAX_HISTORY = 200;
  const MAX_STATE_BYTES = 14 * 1024 * 1024;
  const MAX_PASTE_CELLS = 1000000;
  const MAX_INSERT = 10000;
  const DISPLAY_CHARS = 256;
  const SUPPORTED = ['xlsx', 'xls', 'ods', 'csv', 'tsv'];
  const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const KEY_RE = /^(\d{1,7}),(\d{1,5})$/;
  const BAD_SHEET_CHARS = /[\\/?*[\]:]/g;
  const BAD_SHEET_TEST = /[\\/?*[\]:]/;

  // ---------------------------------------------------------------- pure helpers

  /**
   * Converts a zero-based column index to its letters (0 -> A, 26 -> AA).
   * @param index Zero-based column index.
   * @returns Column letters.
   */
  function colName(index: number): string {
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /**
   * Converts column letters to a zero-based index.
   * @param letters Column letters (case-insensitive).
   * @returns Zero-based index.
   */
  function colIndex(letters: string): number {
    let n = 0;
    const up = letters.toUpperCase();
    for (let i = 0; i < up.length; i += 1) n = n * 26 + (up.charCodeAt(i) - 64);
    return n - 1;
  }

  function addrOf(r: number, c: number): string { return colName(c) + String(r + 1); }

  function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : (v > hi ? hi : v); }

  function extOf(name: string | null | undefined): string {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function baseOf(name: string | null | undefined): string {
    return String(name || 'Sheet').replace(/\.[^.\\/]*$/, '') || 'Sheet';
  }

  function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

  function formatIso(d: Date): string {
    let s = String(d.getFullYear()).padStart(4, '0') + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (d.getHours() || d.getMinutes() || d.getSeconds()) {
      s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }
    return s;
  }

  function parseIso(text: string): Date | null {
    const m = ISO_RE.exec(text);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = m[4] ? Number(m[4]) : 0;
    const mi = m[5] ? Number(m[5]) : 0;
    const s = m[6] ? Number(m[6]) : 0;
    const date = new Date(y, mo - 1, d, h, mi, s);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d
      || h > 23 || mi > 59 || s > 59) return null;
    return date;
  }

  /** Excel serial number of a Date using its local fields (matches how SheetJS reads dates). */
  function toSerial(d: Date): number {
    const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(),
      d.getSeconds(), d.getMilliseconds());
    return (utc - Date.UTC(1899, 11, 30)) / 86400000;
  }

  /**
   * Text shown in the grid for a cell (cached on the immutable cell object).
   * @param cell Cell.
   * @returns Display text.
   */
  function displayText(cell: Cell | undefined): string {
    if (!cell) return '';
    if (cell.w !== undefined) return cell.w;
    const X = window.XLSX;
    const useFmt = cell.z && cell.z !== 'General' && X && X.SSF;
    let w: string | null;
    switch (cell.t) {
      case 's': w = cell.v; break;
      case 'b': w = cell.v ? 'TRUE' : 'FALSE'; break;
      case 'n':
        w = null;
        if (useFmt) {
          try {
            w = String(X.SSF.format(cell.z, cell.v));
          } catch (err) {
            w = null; // unsupported number format: fall back to the plain number below
          }
        }
        if (w === null) w = String(Number(cell.v.toPrecision(15)));
        break;
      case 'd':
        w = null;
        if (useFmt) {
          try {
            w = String(X.SSF.format(cell.z, toSerial(cell.v)));
          } catch (err) {
            w = null; // unsupported date format: fall back to ISO below
          }
        }
        if (w === null) w = formatIso(cell.v);
        break;
      default: w = '';
    }
    cell.w = w;
    return w;
  }

  /** Text shown in the formula bar / in-cell editor (formula source for formula cells). */
  function rawText(cell: Cell | undefined): string {
    if (!cell) return '';
    if (typeof cell.f === 'string') return '=' + cell.f;
    switch (cell.t) {
      case 's': return cell.v;
      case 'n': return String(cell.v);
      case 'b': return cell.v ? 'TRUE' : 'FALSE';
      case 'd': return formatIso(cell.v);
      default: return displayText(cell);
    }
  }

  /**
   * Turns text typed by the user into a cell.
   * @param text Typed text.
   * @param prev Previous cell (number format is inherited).
   * @param textOnly True for CSV/TSV documents (everything stays text).
   * @returns New cell, or null for an empty cell.
   */
  function parseInput(text: string, prev: Cell | undefined, textOnly: boolean): Cell | null {
    if (text === '') return null;
    const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
    if (textOnly) return { t: 's', v: t };
    if (t.charAt(0) === "'") return t.length > 1 ? { t: 's', v: t.slice(1) } : null;
    if (t.charAt(0) === '=' && t.length > 1) return { t: 'n', v: 0, f: t.slice(1), w: t };
    const trimmed = t.trim();
    if (/^(?:true|false)$/i.test(trimmed)) return { t: 'b', v: trimmed.toLowerCase() === 'true' };
    if (NUM_RE.test(trimmed)) {
      const v = Number(trimmed);
      if (Number.isFinite(v)) {
        const cell: NumCell = { t: 'n', v };
        if (prev && prev.z && prev.t === 'n') cell.z = prev.z;
        return cell;
      }
    }
    const d = parseIso(trimmed);
    if (d) {
      const cell: DateCell = { t: 'd', v: d };
      if (prev && prev.z && prev.t === 'd') cell.z = prev.z;
      return cell;
    }
    return { t: 's', v: t };
  }

  function numericValue(cell: Cell | undefined, textOnly: boolean): number {
    if (!cell) return NaN;
    if (cell.t === 'n') return cell.v;
    if (textOnly && cell.t === 's' && NUM_RE.test(cell.v.trim())) return Number(cell.v);
    return NaN;
  }

  function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.t !== b.t || a.f !== b.f || a.z !== b.z) return false;
    if (a.t === 'd' && b.t === 'd') return a.v.getTime() === b.v.getTime();
    return a.v === b.v;
  }

  function cloneCell(cell: Cell): Cell;
  function cloneCell(cell: Cell | undefined): Cell | undefined;
  function cloneCell(cell: Cell | undefined): Cell | undefined {
    if (!cell) return cell;
    let copy: Cell;
    switch (cell.t) {
      case 'd': copy = { t: 'd', v: new Date(cell.v.getTime()) }; break;
      case 'n': copy = { t: 'n', v: cell.v }; break;
      case 's': copy = { t: 's', v: cell.v }; break;
      case 'b': copy = { t: 'b', v: cell.v }; break;
      case 'e': copy = { t: 'e', v: cell.v }; break;
    }
    if (cell.f !== undefined) copy.f = cell.f;
    if (cell.z !== undefined) copy.z = cell.z;
    if (cell.w !== undefined && (cell.t === 'e' || typeof cell.f === 'string')) copy.w = cell.w;
    return copy;
  }

  function sanitizeSheetName(name: unknown, taken: Set<string>): string {
    let n = String(name == null ? '' : name).replace(BAD_SHEET_CHARS, '_').replace(/^'+|'+$/g, '').trim();
    if (n === '' || n === '__proto__') n = 'Sheet';
    n = n.slice(0, 31);
    let candidate = n;
    let i = 2;
    while (taken.has(candidate.toLowerCase())) {
      const suffix = ' (' + i + ')';
      candidate = n.slice(0, 31 - suffix.length) + suffix;
      i += 1;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  }

  /** Grows/shrinks an array in place by inserting `n` holes at `at` (tail is shifted). */
  function insertHoles<T>(arr: T[], at: number, n: number): void {
    if (at >= arr.length) return;
    const tail = arr.splice(at);
    arr.length = at + n;
    for (let i = 0; i < tail.length; i += 1) arr.push(tail[i]);
  }

  /** Inserts `items` into an array at `at` without spreading (safe for very large arrays). */
  function insertItems<T>(arr: T[], at: number, items: T[]): void {
    const tail = arr.splice(at);
    for (let i = 0; i < items.length; i += 1) arr.push(items[i]);
    for (let i = 0; i < tail.length; i += 1) arr.push(tail[i]);
  }

  // ---------------------------------------------------------------- text/CSV codec

  /**
   * Decodes CSV bytes. Handles UTF-8/UTF-16 BOMs; invalid UTF-8 falls back to Windows-1252.
   * @param bytes File bytes.
   * @returns Decoded text.
   */
  function decodeCsv(bytes: Uint8Array): DecodedCsv {
    let enc = 'utf-8';
    let off = 0;
    let bom = false;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      bom = true; off = 3;
    } else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      enc = 'utf-16le'; off = 2; bom = true;
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      enc = 'utf-16be'; off = 2; bom = true;
    }
    const body = bytes.subarray(off);
    try {
      return { text: new TextDecoder(enc, { fatal: true }).decode(body), bom, fallback: enc !== 'utf-8' };
    } catch (err) {
      // Only TextDecoder can throw here (invalid byte sequence): use the legacy single-byte codepage.
      return { text: new TextDecoder('windows-1252').decode(body), bom, fallback: true };
    }
  }

  function detectDelimiter(text: string): string {
    const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
    let inQ = false;
    for (let i = 0; i < text.length && i < 100000; i += 1) {
      const ch = text.charAt(i);
      if (ch === '"') inQ = !inQ;
      else if (!inQ) {
        if (ch === '\n' || ch === '\r') { if (counts[','] + counts[';'] + counts['\t'] > 0) break; } else if (counts[ch] !== undefined) counts[ch] += 1;
      }
    }
    let best = ',';
    ['\t', ';', ','].forEach((d) => { if (counts[d] > counts[best]) best = d; });
    return best;
  }

  /**
   * Parses delimiter-separated text (RFC 4180 quoting).
   * @param text Source text.
   * @param fs Field separator.
   * @returns Rows of fields.
   */
  function parseDelimited(text: string, fs: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQ = false;
    let atStart = true;
    let pending = false;
    let cells = 0;
    const n = text.length;
    const endField = () => {
      cells += 1;
      row.push(field);
      field = '';
      if (row.length > MAX_COLS) throw new Error('This file has more than ' + MAX_COLS + ' columns, which CodePad cannot open.');
    };
    const endRow = () => {
      endField();
      rows.push(row);
      row = [];
      pending = false;
      if (rows.length > MAX_ROWS) throw new Error('This file has more than ' + MAX_ROWS + ' rows, which CodePad cannot open.');
      if (cells > MAX_CELLS) throw new Error('This file has more than ' + MAX_CELLS + ' cells, which CodePad cannot open.');
    };
    for (let i = 0; i < n; i += 1) {
      const ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 1; } else inQ = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && atStart) { inQ = true; atStart = false; pending = true; continue; }
      if (ch === fs) { endField(); atStart = true; pending = true; continue; }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
        endRow();
        atStart = true;
        continue;
      }
      field += ch;
      atStart = false;
      pending = true;
    }
    if (pending || field !== '' || row.length) endRow();
    return rows;
  }

  /**
   * CSV export (R-03): a text value that a spreadsheet would run as a formula (starts with = + - @, tab or CR)
   * gets a leading single quote. Numbers (-5, +3.2, 1e3) are left alone.
   * @param text Cell text.
   * @returns The text, prefixed when it could execute.
   */
  function neutralizeFormula(text: string): string {
    if (!/^[=+\-@\t\r]/.test(text) || /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return text;
    return "'" + text;
  }

  function quoteField(value: string, fs: string): string {
    if (value.indexOf(fs) >= 0 || value.indexOf('"') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  // ---------------------------------------------------------------- sheet model

  function newSheet(name: string): Sheet {
    return {
      name, rows: [], merges: [], colW: [], nRows: 100, nCols: 26, cc: null, colX: null,
      scrollTop: 0, scrollLeft: 0, sel: { ar: 0, ac: 0, fr: 0, fc: 0 }
    };
  }

  function getCell(s: Sheet, r: number, c: number): Cell | undefined {
    const row = s.rows[r];
    return row ? row[c] : undefined;
  }

  function trimRows(s: Sheet): void {
    const rows = s.rows;
    while (rows.length && (!rows[rows.length - 1] || (rows[rows.length - 1] as CellRow).length === 0)) rows.pop();
    s.cc = null;
  }

  function putCell(s: Sheet, r: number, c: number, cell: Cell | null | undefined): void {
    if (cell) {
      let row = s.rows[r];
      if (!row) { row = []; s.rows[r] = row; }
      row[c] = cell;
      s.cc = null;
      return;
    }
    const row = s.rows[r];
    if (!row || row[c] === undefined) return;
    row[c] = undefined;
    while (row.length && row[row.length - 1] === undefined) row.pop();
    if (!row.length) s.rows[r] = undefined;
    if (r >= s.rows.length - 1) trimRows(s);
    s.cc = null;
  }

  function usedRows(s: Sheet): number { return s.rows.length; }

  function usedCols(s: Sheet): number {
    if (s.cc === null) {
      let m = 0;
      for (let r = 0; r < s.rows.length; r += 1) {
        const row = s.rows[r];
        if (row && row.length > m) m = row.length;
      }
      s.cc = m;
    }
    return s.cc;
  }

  function ensureDims(s: Sheet, r: number, c: number): void {
    if (r >= s.nRows) { s.nRows = Math.min(MAX_ROWS, r + 50); }
    if (c >= s.nCols) { s.nCols = Math.min(MAX_COLS, c + 10); s.colX = null; }
  }

  function fitDims(s: Sheet): void {
    s.nRows = Math.min(MAX_ROWS, Math.max(100, usedRows(s) + 50));
    s.nCols = Math.min(MAX_COLS, Math.max(26, usedCols(s) + 10));
    s.colX = null;
  }

  function colWidth(s: Sheet, c: number): number { return s.colW[c] || DEF_COL_W; }

  function computeColX(s: Sheet): number[] {
    const x: number[] = new Array(s.nCols + 1);
    x[0] = 0;
    for (let c = 0; c < s.nCols; c += 1) x[c + 1] = x[c] + colWidth(s, c);
    s.colX = x;
    return x;
  }

  function colAt(s: Sheet, x: number): number {
    const cx = s.colX || computeColX(s);
    let lo = 0;
    let hi = s.nCols - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cx[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function mergeAt(s: Sheet, r: number, c: number): MergeRange | null {
    for (let i = 0; i < s.merges.length; i += 1) {
      const m = s.merges[i];
      if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return m;
    }
    return null;
  }

  function copyMerges(list: MergeRange[]): MergeRange[] {
    return list.map((m) => ({ s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } }));
  }

  /**
   * Adjusts merges for an insert (delta > 0) or delete (delta < 0) of `n` lines at `at`.
   * @param merges Merge list.
   * @param axis Axis.
   * @param at First affected line.
   * @param n Line count.
   * @param inserting True for insert.
   * @returns Adjusted copy.
   */
  function shiftMerges(merges: MergeRange[], axis: 'r' | 'c', at: number, n: number, inserting: boolean): MergeRange[] {
    const out: MergeRange[] = [];
    copyMerges(merges).forEach((m) => {
      const s = m.s;
      const e = m.e;
      if (inserting) {
        if (s[axis] >= at) { s[axis] += n; e[axis] += n; } else if (e[axis] >= at) e[axis] += n;
        out.push(m);
        return;
      }
      const end = at + n - 1;
      if (e[axis] < at) { out.push(m); return; }
      if (s[axis] > end) { s[axis] -= n; e[axis] -= n; out.push(m); return; }
      const removed = Math.min(e[axis], end) - Math.max(s[axis], at) + 1;
      const startsInside = s[axis] >= at;
      if (startsInside) s[axis] = at;
      e[axis] = (startsInside ? at : s[axis]) + (e[axis] - s[axis] + 1 - removed) - 1;
      if (e[axis] < s[axis] || (s.r === e.r && s.c === e.c)) return;
      out.push(m);
    });
    return out;
  }

  function mergeRef(m: MergeRange): string { return addrOf(m.s.r, m.s.c) + ':' + addrOf(m.e.r, m.e.c); }

  function parseRef(text: string): CellRange | null {
    const m = /^\s*([A-Za-z]{1,3})(\d{1,7})\s*(?::\s*([A-Za-z]{1,3})(\d{1,7})\s*)?$/.exec(text);
    if (!m) return null;
    const c1 = colIndex(m[1]);
    const r1 = Number(m[2]) - 1;
    const c2 = m[3] ? colIndex(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) - 1 : r1;
    if ([r1, r2].some((r) => r < 0 || r >= MAX_ROWS) || [c1, c2].some((c) => c < 0 || c >= MAX_COLS)) return null;
    return { r1, c1, r2, c2 };
  }

  // ---------------------------------------------------------------- SheetJS <-> model

  function convertSheetJsCell(rawCell: unknown): Cell | undefined {
    if (!rawCell || typeof rawCell !== 'object') return undefined;
    const raw = rawCell as { t?: unknown; v?: unknown; w?: unknown; z?: unknown; f?: unknown };
    let cell: Cell;
    switch (raw.t) {
      case 'n':
        if (typeof raw.v !== 'number' || !Number.isFinite(raw.v)) return undefined;
        cell = { t: 'n', v: raw.v };
        break;
      case 's': {
        const v = String(raw.v == null ? '' : raw.v);
        cell = { t: 's', v: v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v };
        break;
      }
      case 'b': cell = { t: 'b', v: Boolean(raw.v) }; break;
      case 'd':
        if (!(raw.v instanceof Date) || Number.isNaN(raw.v.getTime())) return undefined;
        cell = { t: 'd', v: new Date(raw.v.getTime()) };
        break;
      case 'e':
        cell = { t: 'e', v: typeof raw.v === 'number' ? raw.v : 0, w: String(raw.w || '#ERROR!') };
        break;
      default: return undefined;
    }
    if (typeof raw.z === 'string' && raw.z && cell.t !== 's' && cell.t !== 'b' && cell.t !== 'e') cell.z = raw.z.slice(0, 200);
    if (typeof raw.f === 'string' && raw.f) {
      cell.f = raw.f.slice(0, MAX_TEXT);
      if (cell.t === 'n' && raw.v === undefined) { cell.v = 0; cell.w = '=' + cell.f; }
    }
    return cell;
  }

  function sheetFromSheetJs(name: string, ws: XlsxWorkSheet): Sheet {
    const s = newSheet(name);
    let count = 0;
    const place = (r: number, c: number, raw: unknown): void => {
      const cell = convertSheetJsCell(raw);
      if (!cell) return;
      count += 1;
      if (count > MAX_CELLS) throw new Error('Sheet "' + name + '" has more than ' + MAX_CELLS + ' non-empty cells, which CodePad cannot open.');
      let row = s.rows[r];
      if (!row) { row = []; s.rows[r] = row; }
      row[c] = cell;
    };
    const dense: unknown = ws['!data'];
    if (isArray(dense)) {
      if (dense.length > MAX_ROWS) throw new Error('Sheet "' + name + '" has more than ' + MAX_ROWS + ' rows, which CodePad cannot open.');
      for (let r = 0; r < dense.length; r += 1) {
        const row = dense[r];
        if (!isArray(row)) continue;
        if (row.length > MAX_COLS) throw new Error('Sheet "' + name + '" has more than ' + MAX_COLS + ' columns, which CodePad cannot open.');
        for (let c = 0; c < row.length; c += 1) if (row[c]) place(r, c, row[c]);
      }
    } else {
      Object.keys(ws).forEach((key) => {
        if (key.charAt(0) === '!') return;
        const a = parseRef(key);
        if (!a) return;
        place(a.r1, a.c1, ws[key]);
      });
    }
    trimRows(s);
    const merges: unknown = ws['!merges'];
    if (isArray(merges)) {
      merges.slice(0, MAX_MERGES).forEach((m) => {
        if (!isRecord(m) || !isRecord(m.s) || !isRecord(m.e)) return;
        const { r: sr, c: sc } = m.s;
        const { r: er, c: ec } = m.e;
        const ok = isNonNegInt(sr) && isNonNegInt(sc) && isNonNegInt(er) && isNonNegInt(ec)
          && er < MAX_ROWS && ec < MAX_COLS && er >= sr && ec >= sc
          && (er > sr || ec > sc);
        if (ok) s.merges.push({ s: { r: sr, c: sc }, e: { r: er, c: ec } });
      });
    }
    const cols: unknown = ws['!cols'];
    if (isArray(cols)) {
      cols.slice(0, MAX_COLS).forEach((col, i) => {
        if (!isRecord(col)) return;
        let w = 0;
        if (typeof col.wpx === 'number') w = col.wpx;
        else if (typeof col.wch === 'number') w = col.wch * 7 + 5;
        else if (typeof col.width === 'number') w = col.width * 7 + 5;
        if (w > 0 && Number.isFinite(w)) s.colW[i] = clamp(Math.round(w), MIN_COL_W, MAX_COL_W);
      });
    }
    fitDims(s);
    return s;
  }

  function toSheetJsCell(cell: Cell): XlsxCellObject {
    if (typeof cell.f === 'string') {
      const out: XlsxCellObject = { t: 'n', v: 0, f: cell.f };
      if (cell.w === undefined || cell.w.charAt(0) !== '=' || cell.w.slice(1) !== cell.f) {
        // Cached result known: keep its type.
        out.t = cell.t === 'e' ? 'n' : cell.t;
        out.v = cell.v;
      }
      if (cell.z) out.z = cell.z;
      return out;
    }
    if (cell.t === 's') return { t: 's', v: cell.v.length > MAX_TEXT ? cell.v.slice(0, MAX_TEXT) : cell.v };
    if (cell.t === 'e') return { t: 'e', v: cell.v, w: cell.w };
    const out: XlsxCellObject = { t: cell.t, v: cell.v };
    if (cell.z) out.z = cell.z;
    return out;
  }

  function sheetToSheetJs(X: XlsxModule, s: Sheet): XlsxWorkSheet {
    const ws: XlsxWorkSheet = {};
    let maxR = -1;
    let maxC = -1;
    for (let r = 0; r < s.rows.length; r += 1) {
      const row = s.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c += 1) {
        const cell = row[c];
        if (!cell) continue;
        ws[X.utils.encode_cell({ r, c })] = toSheetJsCell(cell);
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      }
    }
    if (maxR >= 0) ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    if (s.merges.length) ws['!merges'] = copyMerges(s.merges);
    const cols: XlsxColInfo[] = [];
    s.colW.forEach((w, i) => { if (w) cols[i] = { wpx: w }; });
    if (cols.length) ws['!cols'] = cols;
    return ws;
  }

  // ---------------------------------------------------------------- session state

  function cellToState(cell: Cell | undefined, key: string, out: StateMaps): number | string | boolean | null {
    if (!cell) return null;
    if (typeof cell.f === 'string') {
      out.formulas[key] = '=' + cell.f;
      if (cell.w !== undefined && cell.w === '=' + cell.f && cell.t === 'n') return null;
    }
    if (cell.z) out.fmts[key] = cell.z;
    if (cell.t === 'd') { out.dates[key] = cell.v.getTime(); return null; }
    if (cell.t === 'e') { out.errs[key] = [cell.v, cell.w ?? '']; return null; }
    return cell.v;
  }

  function sheetToState(s: Sheet): SheetState {
    const out: StateMaps = { formulas: {}, dates: {}, fmts: {}, errs: {} };
    const rows: SheetState['rows'] = [];
    for (let r = 0; r < s.rows.length; r += 1) {
      const row = s.rows[r];
      const line: SheetState['rows'][number] = [];
      if (row) {
        for (let c = 0; c < row.length; c += 1) {
          const v = cellToState(row[c], r + ',' + c, out);
          line.push(v);
        }
      }
      rows.push(line);
    }
    return {
      name: s.name,
      rows,
      formulas: out.formulas,
      dates: out.dates,
      fmts: out.fmts,
      errs: out.errs,
      merges: s.merges.map(mergeRef),
      colWidths: Array.from({ length: s.colW.length }, (_, i) => s.colW[i] || 0)
    };
  }

  function stateKey(key: string): CellPos | null {
    const m = KEY_RE.exec(key);
    return m ? { r: Number(m[1]), c: Number(m[2]) } : null;
  }

  function sheetFromState(raw: unknown, taken: Set<string>): Sheet {
    if (!isRecord(raw) || !isArray(raw.rows)) throw new Error('Invalid saved spreadsheet state.');
    const rawRows = raw.rows;
    if (rawRows.length > MAX_ROWS) throw new Error('Saved spreadsheet state has too many rows.');
    const s = newSheet(sanitizeSheetName(typeof raw.name === 'string' ? raw.name : 'Sheet', taken));
    let count = 0;
    const put = (r: number, c: number, cell: Cell): void => {
      if (r >= MAX_ROWS || c >= MAX_COLS) return;
      count += 1;
      if (count > MAX_CELLS) throw new Error('Saved spreadsheet state has too many cells.');
      let row = s.rows[r];
      if (!row) { row = []; s.rows[r] = row; }
      row[c] = cell;
    };
    const mapOf = (v: unknown): Record<string, unknown> => (isRecord(v) && !isArray(v) ? v : {});
    const formulas = mapOf(raw.formulas);
    const dates = mapOf(raw.dates);
    const fmts = mapOf(raw.fmts);
    const errs = mapOf(raw.errs);
    rawRows.forEach((line, r) => {
      if (!isArray(line)) return;
      if (line.length > MAX_COLS) throw new Error('Saved spreadsheet state has too many columns.');
      line.forEach((v, c) => {
        const key = r + ',' + c;
        const fv = Object.prototype.hasOwnProperty.call(formulas, key) ? formulas[key] : undefined;
        const f = typeof fv === 'string' && fv.length > 1 ? fv.slice(1, MAX_TEXT + 1) : null;
        let cell: Cell | null = null;
        if (typeof v === 'number' && Number.isFinite(v)) cell = { t: 'n', v };
        else if (typeof v === 'string') cell = { t: 's', v: v.slice(0, MAX_TEXT) };
        else if (typeof v === 'boolean') cell = { t: 'b', v };
        if (f !== null) {
          if (cell) cell.f = f;
          else cell = { t: 'n', v: 0, f, w: '=' + f };
        }
        const fmt = Object.prototype.hasOwnProperty.call(fmts, key) ? fmts[key] : undefined;
        if (cell && typeof fmt === 'string' && cell.t === 'n') cell.z = fmt.slice(0, 200);
        if (cell) put(r, c, cell);
      });
    });
    Object.keys(dates).forEach((key) => {
      const k = stateKey(key);
      const ms = dates[key];
      if (!k || typeof ms !== 'number' || !Number.isFinite(ms)) return;
      const cell: DateCell = { t: 'd', v: new Date(ms) };
      if (Number.isNaN(cell.v.getTime())) return;
      const fmt = fmts[key];
      if (typeof fmt === 'string') cell.z = fmt.slice(0, 200);
      const fv = formulas[key];
      if (typeof fv === 'string' && fv.length > 1) cell.f = fv.slice(1, MAX_TEXT + 1);
      put(k.r, k.c, cell);
    });
    Object.keys(errs).forEach((key) => {
      const k = stateKey(key);
      const e = errs[key];
      if (!k || !isArray(e) || typeof e[1] !== 'string') return;
      put(k.r, k.c, { t: 'e', v: typeof e[0] === 'number' ? e[0] : 0, w: e[1].slice(0, 64) });
    });
    trimRows(s);
    if (isArray(raw.merges)) {
      raw.merges.slice(0, MAX_MERGES).forEach((ref) => {
        const a = typeof ref === 'string' ? parseRef(ref) : null;
        if (a && (a.r2 > a.r1 || a.c2 > a.c1)) s.merges.push({ s: { r: a.r1, c: a.c1 }, e: { r: a.r2, c: a.c2 } });
      });
    }
    if (isArray(raw.colWidths)) {
      raw.colWidths.slice(0, MAX_COLS).forEach((w, i) => {
        if (typeof w === 'number' && w > 0) s.colW[i] = clamp(Math.round(w), MIN_COL_W, MAX_COL_W);
      });
    }
    fitDims(s);
    return s;
  }

  // ---------------------------------------------------------------- the view

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function loadLibs(): Promise<XlsxModule> {
    const util = window.CodePadEditors.util;
    return util.loadScript(util.nodeModulesUrl(LIB_PATH)).then(() => {
      if (!window.XLSX || !window.XLSX.utils) throw new Error('The spreadsheet library failed to load.');
      return window.XLSX;
    });
  }

  function csvLayoutFromBytes(ext: string, bytes: Uint8Array): { dec: DecodedCsv; info: CsvInfo } {
    const dec = decodeCsv(bytes);
    const fs = ext === 'tsv' ? '\t' : detectDelimiter(dec.text);
    const nl = dec.text.indexOf('\n');
    let eol = '\r\n';
    if (nl > 0) eol = dec.text.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
    else if (nl === 0) eol = '\n';
    const last = dec.text.charAt(dec.text.length - 1);
    return { dec, info: { fs, bom: dec.bom, eol, trailing: last === '\n' || last === '\r' || dec.text === '' } };
  }

  /**
   * Builds the spreadsheet view.
   * @param options See the editor contract in .claude/plans/binary-formats-design.md (B.3).
   * @returns The View.
   */
  async function create(options: CodePadViewOptions): Promise<CodePadEditorView> {
    const container = options.container;
    const callbacks = options.callbacks || { onChange() {}, onStatus() {} };
    const ext = SUPPORTED.indexOf(extOf(options.filePath) || extOf(options.fileName)) >= 0
      ? (extOf(options.filePath) || extOf(options.fileName)) : 'xlsx';
    const textOnly = ext === 'csv' || ext === 'tsv';
    const baseName = baseOf(options.fileName || options.filePath);
    let notes = '';

    // ---- load document
    const sheets: Sheet[] = [];
    let csvInfo: CsvInfo = { fs: ext === 'tsv' ? '\t' : ',', bom: false, eol: '\r\n', trailing: true };
    let activeIdx = 0;
    let forceDirty = false;
    // Excel is told to recalculate on open only after a formula was edited (restored edits are unknown, so they count).
    let formulaEdited = false;
    let restored: RestoredState | null = options.restoredState && typeof options.restoredState === 'object'
      ? options.restoredState : null;

    let xlsxLib: XlsxModule | null = null;
    if (!textOnly) xlsxLib = await loadLibs();
    if (restored) {
      try {
        const restoredSheets = restored.sheets;
        if (!isArray(restoredSheets) || restoredSheets.length === 0 || restoredSheets.length > MAX_SHEETS) {
          throw new Error('Invalid saved spreadsheet state.');
        }
        const taken = new Set<string>();
        restoredSheets.forEach((rs) => sheets.push(sheetFromState(rs, taken)));
        const restoredCsv = restored.csv;
        if (isRecord(restoredCsv) && typeof restoredCsv.fs === 'string' && restoredCsv.fs.length === 1) {
          csvInfo = {
            fs: restoredCsv.fs, bom: Boolean(restoredCsv.bom),
            eol: restoredCsv.eol === '\n' ? '\n' : '\r\n', trailing: restoredCsv.trailing !== false
          };
        } else if (textOnly && options.bytes) {
          csvInfo = csvLayoutFromBytes(ext, options.bytes).info;
        }
        const restoredActive = restored.activeSheet;
        activeIdx = typeof restoredActive === 'number' && Number.isInteger(restoredActive)
          ? clamp(restoredActive, 0, sheets.length - 1) : 0;
        forceDirty = true;
        formulaEdited = true;
      } catch (err) {
        if (!options.bytes) throw err;
        sheets.length = 0;
        restored = null;
        notes = 'Saved unsaved edits were invalid and were discarded.';
      }
    }
    if (!restored) {
      if (!options.bytes) throw new Error('The spreadsheet file could not be read.');
      if (textOnly) {
        const parsed = csvLayoutFromBytes(ext, options.bytes);
        csvInfo = parsed.info;
        const s = newSheet(sanitizeSheetName(baseName, new Set()));
        parseDelimited(parsed.dec.text, csvInfo.fs).forEach((fields, r) => {
          const row: CellRow = [];
          for (let c = 0; c < fields.length; c += 1) if (fields[c] !== '') row[c] = { t: 's', v: fields[c] };
          while (row.length && row[row.length - 1] === undefined) row.pop();
          if (row.length) s.rows[r] = row;
        });
        trimRows(s);
        fitDims(s);
        sheets.push(s);
        if (parsed.dec.fallback) notes = 'File is not UTF-8; it was read as Windows-1252 or UTF-16 and will be saved as UTF-8.';
      } else {
        const X = xlsxLib;
        if (!X) throw new Error('The spreadsheet library failed to load.');
        if (options.bytes) window.CodePadEditors.util.checkZipLimits(options.bytes, baseName);
        let wb: XlsxWorkBook;
        try {
          wb = X.read(options.bytes, { type: 'array', cellDates: true, cellFormula: true, cellNF: true, dense: true });
        } catch (err) {
          throw new Error('Could not read the spreadsheet: ' + (err instanceof Error && err.message ? err.message : 'unsupported or corrupt file.'));
        }
        const names = Array.isArray(wb.SheetNames) ? wb.SheetNames.slice(0, MAX_SHEETS) : [];
        const taken = new Set<string>();
        names.forEach((rawName) => {
          const ws = wb.Sheets && Object.prototype.hasOwnProperty.call(wb.Sheets, rawName) ? wb.Sheets[rawName] : null;
          if (ws && typeof ws === 'object') sheets.push(sheetFromSheetJs(sanitizeSheetName(rawName, taken), ws));
        });
        if (sheets.length === 0) sheets.push(newSheet('Sheet1'));
      }
    }

    // ---- state
    const undoStack: HistoryEntry[] = [];
    const redoStack: HistoryEntry[] = [];
    let savedMarker: HistoryEntry | null = null;
    let edit: EditState | null = null;
    let drag: DragState | null = null;
    let rafId = 0;
    let statusDirty = true;
    let fb: FormulaBarState = { dirty: false, target: null };
    let lastCopy: CopyBuffer | null = null;
    let disposed = false;
    let dragTimer = 0;
    let lastMouse: MouseEvent | null = null;
    let rowHdrW = 46;
    let resizeObs: ResizeObserver | null = null;

    const sh = (): Sheet => sheets[activeIdx];

    // ---- DOM
    const root = el('div', 'cp-sheet');
    const bar = el('div', 'cp-sheet-bar');
    const nameBox = el('input', 'cp-sheet-name');
    nameBox.type = 'text';
    nameBox.setAttribute('aria-label', 'Cell address');
    nameBox.spellcheck = false;
    const fx = el('span', 'cp-sheet-fx');
    fx.textContent = 'fx';
    const formulaBox = el('input', 'cp-sheet-formula');
    formulaBox.type = 'text';
    formulaBox.setAttribute('aria-label', 'Cell content');
    formulaBox.spellcheck = false;
    bar.append(nameBox, fx, formulaBox);

    const findBar = el('div', 'cp-sheet-findbar');
    findBar.hidden = true;
    const findInput = el('input', 'cp-sheet-find-input');
    findInput.type = 'text';
    findInput.placeholder = 'Find in sheet';
    const findCaseLabel = el('label', 'cp-sheet-find-case');
    const findCase = el('input');
    findCase.type = 'checkbox';
    findCaseLabel.append(findCase, document.createTextNode('Match case'));
    const findPrev = el('button', 'cp-sheet-btn');
    findPrev.type = 'button';
    findPrev.textContent = 'Previous';
    const findNext = el('button', 'cp-sheet-btn');
    findNext.type = 'button';
    findNext.textContent = 'Next';
    const findClose = el('button', 'cp-sheet-btn');
    findClose.type = 'button';
    findClose.textContent = 'Close';
    const findMsg = el('span', 'cp-sheet-find-msg');
    findBar.append(findInput, findCaseLabel, findPrev, findNext, findMsg, findClose);

    const scroller = el('div', 'cp-sheet-scroller');
    scroller.tabIndex = 0;
    const frame = el('div', 'cp-sheet-frame');
    const corner = el('div', 'cp-sheet-corner');
    const colHdr = el('div', 'cp-sheet-colhdr');
    const rowHdr = el('div', 'cp-sheet-rowhdr');
    const cellsEl = el('div', 'cp-sheet-cells');
    const dataLayer = el('div');
    const selEl = el('div', 'cp-sheet-selbox');
    const activeEl = el('div', 'cp-sheet-active');
    const editorEl = el('textarea', 'cp-sheet-editor');
    editorEl.hidden = true;
    editorEl.spellcheck = false;
    cellsEl.append(dataLayer, selEl, activeEl, editorEl);
    frame.append(corner, colHdr, rowHdr, cellsEl);
    const sizer = el('div', 'cp-sheet-sizer');
    scroller.append(frame, sizer);

    const tabsEl = el('div', 'cp-sheet-tabs');
    tabsEl.hidden = textOnly;
    const menuEl = el('div', 'cp-sheet-menu');
    menuEl.hidden = true;
    const dialogEl = el('div', 'cp-sheet-dialog');
    dialogEl.hidden = true;

    root.append(bar, findBar, scroller, tabsEl, menuEl, dialogEl);
    container.appendChild(root);

    // ---- history / dirty
    const changed = (): void => {
      statusDirty = true;
      scheduleRender();
      syncBars();
      callbacks.onChange();
    };

    const record = (entry: HistoryEntry): void => {
      undoStack.push(entry);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      changed();
    };

    const run = (entry: HistoryEntry): void => {
      entry.redo();
      record(entry);
    };

    const goToEntrySheet = (entry: HistoryEntry): void => {
      const i = sheets.indexOf(entry.sheet);
      setActive(i >= 0 ? i : activeIdx, true);
    };

    const undo = (): void => {
      commitEdit(0, 0);
      const entry = undoStack.pop();
      if (!entry) return;
      entry.undo();
      redoStack.push(entry);
      goToEntrySheet(entry);
      changed();
    };

    const redo = (): void => {
      commitEdit(0, 0);
      const entry = redoStack.pop();
      if (!entry) return;
      entry.redo();
      undoStack.push(entry);
      goToEntrySheet(entry);
      changed();
    };

    const commitCells = (s: Sheet, changes: CellChange[]): boolean => {
      const before: CellChange[] = [];
      const after: CellChange[] = [];
      changes.forEach((ch) => {
        const prev = getCell(s, ch.r, ch.c);
        if (sameCell(prev, ch.cell || undefined)) return;
        if (typeof prev?.f === 'string' || typeof ch.cell?.f === 'string') formulaEdited = true;
        before.push({ r: ch.r, c: ch.c, cell: prev });
        after.push({ r: ch.r, c: ch.c, cell: ch.cell || undefined });
      });
      if (!after.length) return false;
      const apply = (list: CellChange[]): void => {
        let maxR = 0;
        let maxC = 0;
        list.forEach((ch) => {
          putCell(s, ch.r, ch.c, ch.cell);
          if (ch.r > maxR) maxR = ch.r;
          if (ch.c > maxC) maxC = ch.c;
        });
        ensureDims(s, maxR, maxC);
      };
      run({ sheet: s, redo() { apply(after); }, undo() { apply(before); } });
      return true;
    };

    // ---- selection
    const fullRows = (s: Sheet): boolean => s.sel.fc >= MAX_COLS - 1;
    const fullCols = (s: Sheet): boolean => s.sel.fr >= MAX_ROWS - 1;

    const rangeOf = (): CellRange => {
      const { ar, ac, fr, fc } = sh().sel;
      return { r1: Math.min(ar, fr), r2: Math.max(ar, fr), c1: Math.min(ac, fc), c2: Math.max(ac, fc) };
    };

    const ensureVisible = (r: number, c: number): void => {
      const s = sh();
      const W = scroller.clientWidth - rowHdrW;
      const H = scroller.clientHeight - HEADER_H;
      if (W <= 0 || H <= 0) return;
      const cx = s.colX || computeColX(s);
      const left = cx[c];
      const right = cx[c + 1];
      if (left < scroller.scrollLeft) scroller.scrollLeft = left;
      else if (right > scroller.scrollLeft + W) scroller.scrollLeft = right - W;
      const top = r * ROW_H;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + ROW_H > scroller.scrollTop + H) scroller.scrollTop = top + ROW_H - H;
    };

    const setSel = (ar: number, ac: number, fr: number, fc: number, keepView?: boolean): void => {
      const s = sh();
      const a = { ar: clamp(ar, 0, MAX_ROWS - 1), ac: clamp(ac, 0, MAX_COLS - 1), fr: clamp(fr, 0, MAX_ROWS - 1), fc: clamp(fc, 0, MAX_COLS - 1) };
      ensureDims(s, a.ar, a.ac);
      if (a.fr < MAX_ROWS - 1 || a.fr === a.ar) ensureDims(s, a.fr, 0);
      if (a.fc < MAX_COLS - 1 || a.fc === a.ac) ensureDims(s, 0, a.fc);
      s.sel = a;
      statusDirty = true;
      if (!keepView) ensureVisible(a.fr >= MAX_ROWS - 1 ? a.ar : a.fr, a.fc >= MAX_COLS - 1 ? a.ac : a.fc);
      scheduleRender();
      syncBars();
    };

    const moveTo = (r: number, c: number, extend: boolean): void => {
      const s = sh();
      if (extend) setSel(s.sel.ar, s.sel.ac, r, c);
      else setSel(r, c, r, c);
    };

    const isEmptyAt = (r: number, c: number): boolean => !getCell(sh(), r, c);

    const edgeJump = (r: number, c: number, dr: number, dc: number): CellPos => {
      const s = sh();
      const maxR = Math.max(usedRows(s) - 1, 0);
      const maxC = Math.max(usedCols(s) - 1, 0);
      const limitR = dr > 0 ? MAX_ROWS - 1 : 0;
      const limitC = dc > 0 ? MAX_COLS - 1 : 0;
      let nr = r + dr;
      let nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= MAX_ROWS || nc >= MAX_COLS) return { r, c };
      const inData = (rr: number, cc: number): boolean => rr >= 0 && cc >= 0 && rr <= maxR && cc <= maxC;
      if (!isEmptyAt(r, c) && !isEmptyAt(nr, nc)) {
        while (inData(nr + dr, nc + dc) && !isEmptyAt(nr + dr, nc + dc)) { nr += dr; nc += dc; }
        return { r: nr, c: nc };
      }
      while (inData(nr, nc) && isEmptyAt(nr, nc)) { nr += dr; nc += dc; }
      if (inData(nr, nc)) return { r: nr, c: nc };
      return { r: dr ? limitR : r, c: dc ? limitC : c };
    };

    // ---- clipboard, ranges
    const usedClamp = (rg: CellRange): CellRange => {
      const s = sh();
      return {
        r1: rg.r1, c1: rg.c1,
        r2: Math.min(rg.r2, usedRows(s) - 1), c2: Math.min(rg.c2, usedCols(s) - 1)
      };
    };

    const eachUsed = (rg: CellRange, fn: (r: number, c: number, cell: Cell) => void): void => {
      const s = sh();
      const u = usedClamp(rg);
      for (let r = u.r1; r <= u.r2; r += 1) {
        const row = s.rows[r];
        if (!row) continue;
        const end = Math.min(u.c2, row.length - 1);
        for (let c = u.c1; c <= end; c += 1) {
          const cell = row[c];
          if (cell) fn(r, c, cell);
        }
      }
    };

    const clearRange = (rg: CellRange): boolean => {
      const changes: CellChange[] = [];
      eachUsed(rg, (r, c) => changes.push({ r, c, cell: null }));
      return commitCells(sh(), changes);
    };

    const toTsv = (rg: CellRange): CopyBuffer | null => {
      const s = sh();
      const u = usedClamp(rg);
      const rEnd = fullCols(s) ? Math.max(u.r2, rg.r1) : rg.r2;
      const cEnd = fullRows(s) ? Math.max(u.c2, rg.c1) : rg.c2;
      if ((rEnd - rg.r1 + 1) * (cEnd - rg.c1 + 1) > MAX_PASTE_CELLS * 5) return null;
      const lines: string[] = [];
      const cells: CellRow[] = [];
      for (let r = rg.r1; r <= rEnd; r += 1) {
        const fields: string[] = [];
        const crow: CellRow = [];
        for (let c = rg.c1; c <= cEnd; c += 1) {
          const cell = r <= u.r2 && c <= u.c2 ? getCell(s, r, c) : undefined;
          const text = displayText(cell);
          fields.push(/[\t\n\r"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text);
          crow.push(cell ? cloneCell(cell) : undefined);
        }
        lines.push(fields.join('\t'));
        cells.push(crow);
      }
      return { text: lines.join('\n'), cells };
    };

    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      if (edit || e.target === editorEl || e.target === formulaBox || e.target === nameBox || e.target === findInput) return;
      if (!scroller.contains(asNode(e.target)) && e.target !== document.body) return;
      const rg = rangeOf();
      const data = toTsv(rg);
      if (!data) { callbacks.onStatus('Selection is too large to copy.'); e.preventDefault(); return; }
      if (e.clipboardData) e.clipboardData.setData('text/plain', data.text);
      lastCopy = { text: data.text, cells: data.cells };
      e.preventDefault();
      if (cut) clearRange(rg);
    };

    const onPaste = (e: ClipboardEvent): void => {
      if (edit || e.target === editorEl || e.target === formulaBox || e.target === nameBox || e.target === findInput) return;
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      e.preventDefault();
      if (text === '') return;
      const s = sh();
      const rg = rangeOf();
      let grid: (string | Cell | undefined)[][];
      let useCells = false;
      if (lastCopy && lastCopy.text === text) {
        grid = lastCopy.cells;
        useCells = true;
      } else {
        try {
          grid = parseDelimited(text, '\t');
        } catch (err) {
          callbacks.onStatus('Paste failed: ' + errorMessage(err));
          return;
        }
      }
      const h = grid.length;
      let w = 0;
      grid.forEach((row) => { if (row.length > w) w = row.length; });
      if (h === 0 || w === 0) return;
      let rows = h;
      let cols = w;
      const single = h === 1 && w === 1;
      const selRows = Math.min(rg.r2, MAX_ROWS - 1) - rg.r1 + 1;
      const selCols = Math.min(rg.c2, MAX_COLS - 1) - rg.c1 + 1;
      if (single && (selRows > 1 || selCols > 1)) {
        rows = fullCols(s) ? Math.max(usedRows(s) - rg.r1, 1) : selRows;
        cols = fullRows(s) ? Math.max(usedCols(s) - rg.c1, 1) : selCols;
      }
      if (rg.r1 + rows > MAX_ROWS || rg.c1 + cols > MAX_COLS || rows * cols > MAX_PASTE_CELLS) {
        callbacks.onStatus('Paste exceeds the sheet limits and was cancelled.');
        return;
      }
      const changes: CellChange[] = [];
      for (let i = 0; i < rows; i += 1) {
        for (let j = 0; j < cols; j += 1) {
          const src = single ? grid[0][0] : (grid[i] ? grid[i][j] : undefined);
          let cell: Cell | null;
          if (useCells) cell = src && typeof src === 'object' ? cloneCell(src) : null;
          else cell = parseInput(typeof src === 'string' ? src : '', getCell(s, rg.r1 + i, rg.c1 + j), textOnly);
          changes.push({ r: rg.r1 + i, c: rg.c1 + j, cell });
        }
      }
      commitCells(s, changes);
      setSel(rg.r1, rg.c1, rg.r1 + rows - 1, rg.c1 + cols - 1);
    };

    const fillDown = (): void => {
      const s = sh();
      const rg = rangeOf();
      const changes: CellChange[] = [];
      const last = Math.min(rg.r2, rg.r1 + 100000);
      const cEnd = Math.min(rg.c2, rg.c1 + 1000);
      if (rg.r1 === rg.r2) {
        if (rg.r1 === 0) return;
        for (let c = rg.c1; c <= cEnd; c += 1) changes.push({ r: rg.r1, c, cell: cloneCell(getCell(s, rg.r1 - 1, c)) || null });
      } else {
        for (let r = rg.r1 + 1; r <= last; r += 1) {
          for (let c = rg.c1; c <= cEnd; c += 1) changes.push({ r, c, cell: cloneCell(getCell(s, rg.r1, c)) || null });
        }
      }
      commitCells(s, changes);
    };

    const sortKey = (cell: Cell | undefined): SortKey | null => {
      if (!cell) return null;
      if (cell.t === 'n') return { k: 0, v: cell.v };
      if (cell.t === 'd') return { k: 0, v: cell.v.getTime() };
      if (cell.t === 's') {
        if (textOnly && NUM_RE.test(cell.v.trim())) return { k: 0, v: Number(cell.v) };
        return { k: 1, v: cell.v.toLowerCase() };
      }
      return { k: 2, v: displayText(cell) };
    };

    const sortSelection = (asc: boolean): void => {
      const s = sh();
      const rg = rangeOf();
      const r2 = Math.min(rg.r2, usedRows(s) - 1);
      const c2 = Math.min(rg.c2, rg.c1 + 1000);
      if (r2 <= rg.r1) { callbacks.onStatus('Select two or more rows to sort.'); return; }
      const keyCol = clamp(s.sel.ac, rg.c1, c2);
      const recs: { key: SortKey | null; cells: CellRow }[] = [];
      for (let r = rg.r1; r <= r2; r += 1) {
        const cells: CellRow = [];
        for (let c = rg.c1; c <= c2; c += 1) cells.push(getCell(s, r, c));
        recs.push({ key: sortKey(getCell(s, r, keyCol)), cells });
      }
      recs.sort((a, b) => {
        if (!a.key && !b.key) return 0;
        if (!a.key) return 1;
        if (!b.key) return -1;
        if (a.key.k !== b.key.k) return a.key.k - b.key.k;
        let d = 0;
        if (a.key.k === 0 && b.key.k === 0) d = a.key.v - b.key.v;
        else if (a.key.k !== 0 && b.key.k !== 0) d = a.key.v < b.key.v ? -1 : (a.key.v > b.key.v ? 1 : 0);
        return asc ? d : -d;
      });
      const changes: CellChange[] = [];
      recs.forEach((rec, i) => {
        rec.cells.forEach((cell, j) => changes.push({ r: rg.r1 + i, c: rg.c1 + j, cell: cell || null }));
      });
      commitCells(s, changes);
    };

    // ---- structural edits
    const insertLines = (axis: 'r' | 'c', at: number, n: number): void => {
      const s = sh();
      const count = clamp(n, 1, MAX_INSERT);
      if (axis === 'r' ? usedRows(s) + count > MAX_ROWS : usedCols(s) + count > MAX_COLS) {
        callbacks.onStatus('Cannot insert: the sheet size limit would be exceeded.');
        return;
      }
      const mBefore = copyMerges(s.merges);
      const mAfter = shiftMerges(s.merges, axis, at, count, true);
      const wBefore = s.colW.slice();
      run({
        sheet: s,
        redo() {
          if (axis === 'r') insertHoles(s.rows, at, count);
          else {
            s.rows.forEach((row) => { if (row) insertHoles(row, at, count); });
            insertHoles(s.colW, at, count);
          }
          s.merges = copyMerges(mAfter);
          s.cc = null;
          s.colX = null;
          if (axis === 'r') ensureDims(s, usedRows(s) + 1, 0); else ensureDims(s, 0, usedCols(s) + 1);
        },
        undo() {
          if (axis === 'r') { s.rows.splice(at, count); trimRows(s); } else {
            s.rows.forEach((row) => { if (row) row.splice(at, count); });
            s.colW = wBefore.slice();
            s.rows.forEach((row, r) => { if (row && !row.length) s.rows[r] = undefined; });
            trimRows(s);
          }
          s.merges = copyMerges(mBefore);
          s.cc = null;
          s.colX = null;
        }
      });
    };

    const deleteLines = (axis: 'r' | 'c', at: number, n: number): void => {
      const s = sh();
      const count = Math.max(n, 1);
      const mBefore = copyMerges(s.merges);
      const mAfter = shiftMerges(s.merges, axis, at, count, false);
      let removedRows: (CellRow | undefined)[] = [];
      const removedCols: { r: number; removed: (Cell | undefined)[] }[] = [];
      let removedWidths: number[] = [];
      run({
        sheet: s,
        redo() {
          if (axis === 'r') {
            removedRows = s.rows.splice(at, count);
            trimRows(s);
          } else {
            removedCols.length = 0;
            s.rows.forEach((row, r) => {
              if (!row) return;
              const removed = row.splice(at, count);
              if (removed.length) removedCols.push({ r, removed });
              if (!row.length) s.rows[r] = undefined;
            });
            removedWidths = s.colW.splice(at, count);
            trimRows(s);
          }
          s.merges = copyMerges(mAfter);
          s.cc = null;
          s.colX = null;
        },
        undo() {
          if (axis === 'r') {
            insertItems(s.rows, Math.min(at, s.rows.length), removedRows);
          } else {
            removedCols.forEach((rc) => {
              let row = s.rows[rc.r];
              if (!row) { row = []; s.rows[rc.r] = row; }
              if (row.length < at) row.length = at;
              insertItems(row, at, rc.removed);
            });
            insertItems(s.colW, Math.min(at, s.colW.length), removedWidths);
          }
          s.merges = copyMerges(mBefore);
          s.cc = null;
          s.colX = null;
          ensureDims(s, usedRows(s), usedCols(s));
        }
      });
      const a = sh().sel;
      setSel(a.ar, a.ac, a.ar, a.ac);
    };

    // ---- editing
    const positionRect = (r1: number, c1: number, r2: number, c2: number): Rect => {
      const s = sh();
      const cx = s.colX || computeColX(s);
      const sl = scroller.scrollLeft;
      const st = scroller.scrollTop;
      const cc2 = Math.min(c2, s.nCols - 1);
      return {
        x1: cx[c1] - sl, x2: cx[cc2 + 1] - sl,
        y1: r1 * ROW_H - st, y2: (r2 + 1) * ROW_H - st
      };
    };

    const positionEditor = (): void => {
      if (!edit) return;
      const s = sh();
      const m = mergeAt(s, edit.r, edit.c);
      const p = positionRect(edit.r, edit.c, m ? m.e.r : edit.r, m ? m.e.c : edit.c);
      editorEl.style.left = p.x1 + 'px';
      editorEl.style.top = p.y1 + 'px';
      editorEl.style.minWidth = Math.max(p.x2 - p.x1, 60) + 'px';
      editorEl.style.width = Math.max(p.x2 - p.x1, Math.min(320, 20 + editorEl.value.length * 8)) + 'px';
      editorEl.style.height = Math.max(p.y2 - p.y1, Math.min(220, editorEl.scrollHeight)) + 'px';
    };

    const startEdit = (mode: 'edit' | 'enter', initial?: string): void => {
      if (edit) return;
      const s = sh();
      const a = mergeAt(s, s.sel.ar, s.sel.ac);
      const r = a ? a.s.r : s.sel.ar;
      const c = a ? a.s.c : s.sel.ac;
      ensureVisible(r, c);
      edit = { r, c, mode, sheet: s, prev: getCell(s, r, c) };
      editorEl.value = mode === 'edit' ? rawText(edit.prev) : (initial || '');
      editorEl.hidden = false;
      positionEditor();
      editorEl.focus();
      if (mode === 'edit') editorEl.setSelectionRange(editorEl.value.length, editorEl.value.length);
    };

    const endEdit = (): EditState | null => {
      const e = edit;
      edit = null;
      editorEl.hidden = true;
      return e;
    };

    function commitEdit(dr: number, dc: number): void {
      if (!edit) return;
      const e = endEdit();
      if (!e) return;
      const text = editorEl.value;
      if (text !== rawText(e.prev) || e.prev === undefined) {
        commitCells(e.sheet, [{ r: e.r, c: e.c, cell: parseInput(text, e.prev, textOnly) }]);
      }
      if (dr || dc) moveTo(clamp(e.r + dr, 0, MAX_ROWS - 1), clamp(e.c + dc, 0, MAX_COLS - 1), false);
      scroller.focus({ preventScroll: true });
    }

    const cancelEdit = (): void => {
      if (!edit) return;
      endEdit();
      scroller.focus({ preventScroll: true });
    };

    editorEl.addEventListener('input', () => {
      if (!edit) return;
      formulaBox.value = editorEl.value;
      positionEditor();
    });

    editorEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      const arrow = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, [number, number] | undefined>)[e.key];
      if (e.key === 'Enter') {
        if (e.altKey) {
          e.preventDefault();
          const p = editorEl.selectionStart;
          editorEl.setRangeText('\n', p, editorEl.selectionEnd, 'end');
          editorEl.dispatchEvent(new Event('input'));
          return;
        }
        e.preventDefault();
        commitEdit(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit(0, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
        syncBars();
      } else if (arrow && edit && edit.mode === 'enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        commitEdit(arrow[0], arrow[1]);
      }
    });

    editorEl.addEventListener('blur', () => { if (edit) commitEdit(0, 0); });

    // ---- formula bar / name box
    const rangeLabel = (): string => {
      const s = sh();
      const rg = rangeOf();
      if (fullCols(s)) return colName(rg.c1) + ':' + colName(rg.c2);
      if (fullRows(s)) return String(rg.r1 + 1) + ':' + String(rg.r2 + 1);
      if (rg.r1 === rg.r2 && rg.c1 === rg.c2) return addrOf(rg.r1, rg.c1);
      return addrOf(rg.r1, rg.c1) + ':' + addrOf(rg.r2, rg.c2);
    };

    function syncBars(): void {
      if (disposed) return;
      const s = sh();
      if (document.activeElement !== nameBox) nameBox.value = rangeLabel();
      if (!edit && document.activeElement !== formulaBox) {
        const a = mergeAt(s, s.sel.ar, s.sel.ac);
        formulaBox.value = rawText(a ? getCell(s, a.s.r, a.s.c) : getCell(s, s.sel.ar, s.sel.ac));
      }
    }

    const commitFormulaBar = (): void => {
      if (!fb.dirty) return;
      const target = fb.target;
      fb = { dirty: false, target: null };
      if (!target || sheets.indexOf(target.sheet) < 0) return;
      const prev = getCell(target.sheet, target.r, target.c);
      if (formulaBox.value === rawText(prev) && prev) return;
      commitCells(target.sheet, [{ r: target.r, c: target.c, cell: parseInput(formulaBox.value, prev, textOnly) }]);
    };

    formulaBox.addEventListener('focus', () => {
      commitEdit(0, 0);
    });
    formulaBox.addEventListener('input', () => {
      if (!fb.dirty) {
        const s = sh();
        const a = mergeAt(s, s.sel.ar, s.sel.ac);
        fb = { dirty: true, target: { sheet: s, r: a ? a.s.r : s.sel.ar, c: a ? a.s.c : s.sel.ac } };
      }
    });
    formulaBox.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = fb.target;
        commitFormulaBar();
        scroller.focus({ preventScroll: true });
        if (target) moveTo(Math.min(target.r + 1, MAX_ROWS - 1), target.c, false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        fb = { dirty: false, target: null };
        scroller.focus({ preventScroll: true });
        syncBars();
      }
    });
    formulaBox.addEventListener('blur', () => { commitFormulaBar(); syncBars(); });

    nameBox.addEventListener('focus', () => nameBox.select());
    nameBox.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const ref = parseRef(nameBox.value);
        scroller.focus({ preventScroll: true });
        if (ref) setSel(ref.r1, ref.c1, ref.r2, ref.c2);
        else callbacks.onStatus('"' + nameBox.value + '" is not a valid cell reference.');
        syncBars();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        scroller.focus({ preventScroll: true });
        syncBars();
      }
    });
    nameBox.addEventListener('blur', syncBars);

    // ---- rendering
    function scheduleRender(): void {
      if (rafId || disposed) return;
      rafId = requestAnimationFrame(() => { rafId = 0; render(); });
    }

    function rowHeaderWidth(s: Sheet): number {
      return Math.max(40, String(s.nRows).length * 9 + 18);
    }

    const rectStyle = (node: HTMLElement, p: Rect, sides: { l: boolean; r: boolean; t: boolean; b: boolean } | null): void => {
      node.style.left = p.x1 + 'px';
      node.style.top = p.y1 + 'px';
      node.style.width = (p.x2 - p.x1) + 'px';
      node.style.height = (p.y2 - p.y1) + 'px';
      if (sides) {
        node.style.borderLeftWidth = sides.l ? '' : '0';
        node.style.borderRightWidth = sides.r ? '' : '0';
        node.style.borderTopWidth = sides.t ? '' : '0';
        node.style.borderBottomWidth = sides.b ? '' : '0';
      }
    };

    function render(): void {
      if (disposed) return;
      const s = sh();
      const W = scroller.clientWidth;
      const H = scroller.clientHeight;
      if (W <= 0 || H <= 0) return;
      rowHdrW = rowHeaderWidth(s);
      const cx = s.colX || computeColX(s);
      const areaW = Math.max(W - rowHdrW, 0);
      const areaH = Math.max(H - HEADER_H, 0);
      frame.style.width = W + 'px';
      frame.style.height = H + 'px';
      frame.style.marginBottom = (-H) + 'px';
      sizer.style.width = (cx[s.nCols] + rowHdrW) + 'px';
      sizer.style.height = (s.nRows * ROW_H + HEADER_H) + 'px';
      corner.style.width = rowHdrW + 'px';
      corner.style.height = HEADER_H + 'px';
      colHdr.style.left = rowHdrW + 'px';
      colHdr.style.width = areaW + 'px';
      colHdr.style.height = HEADER_H + 'px';
      rowHdr.style.top = HEADER_H + 'px';
      rowHdr.style.width = rowHdrW + 'px';
      rowHdr.style.height = areaH + 'px';
      cellsEl.style.left = rowHdrW + 'px';
      cellsEl.style.top = HEADER_H + 'px';
      cellsEl.style.width = areaW + 'px';
      cellsEl.style.height = areaH + 'px';

      const sl = scroller.scrollLeft;
      const st = scroller.scrollTop;
      cellsEl.style.backgroundPosition = '0 ' + (-(st % ROW_H)) + 'px';
      const r0 = Math.floor(st / ROW_H);
      const r1 = Math.min(s.nRows - 1, Math.floor((st + areaH) / ROW_H));
      const c0 = colAt(s, sl);
      const c1 = colAt(s, sl + areaW);

      const rg = rangeOf();
      const rEnd = fullCols(s) ? s.nRows - 1 : rg.r2;
      const cEnd = fullRows(s) ? s.nCols - 1 : rg.c2;

      // headers
      const colFrag = document.createDocumentFragment();
      for (let c = c0; c <= c1; c += 1) {
        const h = el('div', 'cp-sheet-hdr');
        h.textContent = colName(c);
        h.style.left = (cx[c] - sl) + 'px';
        h.style.width = (cx[c + 1] - cx[c]) + 'px';
        h.style.height = HEADER_H + 'px';
        if (c >= rg.c1 && c <= cEnd) h.classList.add(fullCols(s) ? 'full' : 'sel');
        colFrag.appendChild(h);
      }
      colHdr.replaceChildren(colFrag);
      const rowFrag = document.createDocumentFragment();
      for (let r = r0; r <= r1; r += 1) {
        const h = el('div', 'cp-sheet-hdr');
        h.textContent = String(r + 1);
        h.style.top = (r * ROW_H - st) + 'px';
        h.style.width = rowHdrW + 'px';
        h.style.height = ROW_H + 'px';
        if (r >= rg.r1 && r <= rEnd) h.classList.add(fullRows(s) ? 'full' : 'sel');
        rowFrag.appendChild(h);
      }
      rowHdr.replaceChildren(rowFrag);

      // data
      const frag = document.createDocumentFragment();
      for (let c = c0; c <= c1; c += 1) {
        const v = el('div', 'cp-sheet-vline');
        v.style.left = (cx[c + 1] - sl - 1) + 'px';
        frag.appendChild(v);
      }
      const vis: MergeRange[] = [];
      for (let i = 0; i < s.merges.length; i += 1) {
        const m = s.merges[i];
        if (m.e.r >= r0 && m.s.r <= r1 && m.e.c >= c0 && m.s.c <= c1) vis.push(m);
      }
      const covered = (r: number, c: number): boolean => {
        for (let i = 0; i < vis.length; i += 1) {
          const m = vis[i];
          if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return true;
        }
        return false;
      };
      const makeCell = (cell: Cell, x: number, y: number, w: number, h: number, merged: boolean): HTMLElement => {
        const d = el('div', 'cp-sheet-cell');
        let text = displayText(cell);
        if (text.length > DISPLAY_CHARS) text = text.slice(0, DISPLAY_CHARS);
        d.textContent = text;
        if (cell.t === 'n' || cell.t === 'd') d.classList.add('num');
        else if (cell.t === 'b' || cell.t === 'e') d.classList.add('ctr');
        if (typeof cell.f === 'string') d.classList.add('formula');
        if (merged) d.classList.add('merged');
        d.style.left = x + 'px';
        d.style.top = y + 'px';
        d.style.width = w + 'px';
        d.style.height = h + 'px';
        return d;
      };
      for (let r = r0; r <= r1; r += 1) {
        const row = s.rows[r];
        if (!row) continue;
        const end = Math.min(c1, row.length - 1);
        for (let c = c0; c <= end; c += 1) {
          const cell = row[c];
          if (!cell || (vis.length && covered(r, c))) continue;
          frag.appendChild(makeCell(cell, cx[c] - sl, r * ROW_H - st, cx[c + 1] - cx[c], ROW_H, false));
        }
      }
      vis.forEach((m) => {
        const p = positionRect(m.s.r, m.s.c, m.e.r, m.e.c);
        frag.appendChild(makeCell(getCell(s, m.s.r, m.s.c) || { t: 's', v: '' }, p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1, true));
      });
      dataLayer.replaceChildren(frag);

      // selection overlay
      const sel = s.sel;
      const am = mergeAt(s, sel.ar, sel.ac);
      const sp = positionRect(rg.r1, rg.c1, Math.min(rEnd, s.nRows - 1), Math.min(cEnd, s.nCols - 1));
      const clipped = {
        l: sp.x1 >= 0, t: sp.y1 >= 0, r: sp.x2 <= areaW, b: sp.y2 <= areaH
      };
      const cp = {
        x1: Math.max(sp.x1, 0), y1: Math.max(sp.y1, 0), x2: Math.min(sp.x2, areaW), y2: Math.min(sp.y2, areaH)
      };
      const multi = rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
      if (multi && cp.x2 > cp.x1 && cp.y2 > cp.y1) {
        selEl.hidden = false;
        rectStyle(selEl, cp, clipped);
      } else selEl.hidden = true;
      const ap = positionRect(am ? am.s.r : sel.ar, am ? am.s.c : sel.ac, am ? am.e.r : sel.ar, am ? am.e.c : sel.ac);
      if (ap.x2 > 0 && ap.y2 > 0 && ap.x1 < areaW && ap.y1 < areaH) {
        activeEl.hidden = false;
        rectStyle(activeEl, ap, null);
      } else activeEl.hidden = true;
      positionEditor();

      if (statusDirty) {
        statusDirty = false;
        callbacks.onStatus(getStatusText());
      }
    }

    // ---- sheet tabs and sheet-level operations
    function askConfirm(message: string, okLabel: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        dialogEl.replaceChildren();
        const box = el('div', 'cp-sheet-dialog-box');
        const msg = el('div');
        msg.textContent = message;
        const actions = el('div', 'cp-sheet-dialog-actions');
        const cancel = el('button', 'cp-sheet-btn');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        const ok = el('button', 'cp-sheet-btn');
        ok.type = 'button';
        ok.textContent = okLabel;
        const done = (v: boolean): void => { dialogEl.hidden = true; dialogEl.replaceChildren(); scroller.focus({ preventScroll: true }); resolve(v); };
        cancel.addEventListener('click', () => done(false));
        ok.addEventListener('click', () => done(true));
        box.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
        actions.append(cancel, ok);
        box.append(msg, actions);
        dialogEl.appendChild(box);
        dialogEl.hidden = false;
        cancel.focus();
      });
    }

    function renderTabs(): void {
      if (textOnly) return;
      const frag = document.createDocumentFragment();
      sheets.forEach((s, i) => {
        const b = el('button', 'cp-sheet-tab' + (i === activeIdx ? ' active' : ''));
        b.type = 'button';
        b.textContent = s.name;
        b.addEventListener('click', () => setActive(i, false));
        b.addEventListener('dblclick', () => beginRename(i, b));
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          setActive(i, false);
          showMenu([
            { label: 'Rename', action: () => beginRename(i, tabsEl.children[i]) },
            { label: 'Delete sheet', action: () => deleteSheet(i), disabled: sheets.length < 2 }
          ], e.clientX, e.clientY);
        });
        frag.appendChild(b);
      });
      const add = el('button', 'cp-sheet-tab cp-sheet-tab-add');
      add.type = 'button';
      add.textContent = '+';
      add.title = 'Add sheet';
      add.addEventListener('click', addSheet);
      frag.appendChild(add);
      tabsEl.replaceChildren(frag);
    }

    function setActive(i: number, fromHistory: boolean): void {
      commitEdit(0, 0);
      commitFormulaBar();
      activeIdx = clamp(i, 0, sheets.length - 1);
      const s = sh();
      renderTabs();
      statusDirty = true;
      render();
      scroller.scrollLeft = s.scrollLeft;
      scroller.scrollTop = s.scrollTop;
      render();
      syncBars();
      if (!fromHistory) scroller.focus({ preventScroll: true });
    }

    function uniqueName(base: string): string {
      const taken = new Set(sheets.map((s) => s.name.toLowerCase()));
      let i = sheets.length + 1;
      let name = base + i;
      while (taken.has(name.toLowerCase())) { i += 1; name = base + i; }
      return name;
    }

    function addSheet(): void {
      if (sheets.length >= MAX_SHEETS) { callbacks.onStatus('Cannot add more than ' + MAX_SHEETS + ' sheets.'); return; }
      const s = newSheet(uniqueName('Sheet'));
      const prevActive = activeIdx;
      run({
        sheet: s,
        redo() { sheets.push(s); activeIdx = sheets.length - 1; renderTabs(); },
        undo() { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); activeIdx = clamp(prevActive, 0, sheets.length - 1); renderTabs(); }
      });
      setActive(sheets.length - 1, false);
    }

    function deleteSheet(i: number): void {
      if (sheets.length < 2) return;
      const s = sheets[i];
      askConfirm('Delete sheet "' + s.name + '"?', 'Delete').then((yes) => {
        if (!yes) return;
        const idx = sheets.indexOf(s);
        if (idx < 0) return;
        run({
          sheet: s,
          redo() { const k = sheets.indexOf(s); if (k >= 0) sheets.splice(k, 1); activeIdx = clamp(activeIdx, 0, sheets.length - 1); renderTabs(); },
          undo() { sheets.splice(idx, 0, s); activeIdx = idx; renderTabs(); }
        });
        setActive(activeIdx, false);
      });
    }

    function renameSheet(s: Sheet, raw: string): boolean {
      const name = raw.trim();
      if (name === s.name) return true;
      if (name === '' || name.length > 31 || BAD_SHEET_TEST.test(name) || /^'|'$/.test(name) || name === '__proto__') {
        callbacks.onStatus('Sheet names must be 1-31 characters and cannot contain \\ / ? * [ ] : or start/end with an apostrophe.');
        return false;
      }
      if (sheets.some((o) => o !== s && o.name.toLowerCase() === name.toLowerCase())) {
        callbacks.onStatus('A sheet named "' + name + '" already exists.');
        return false;
      }
      const old = s.name;
      run({ sheet: s, redo() { s.name = name; renderTabs(); }, undo() { s.name = old; renderTabs(); } });
      return true;
    }

    function beginRename(i: number, tabButton: Element | undefined): void {
      const s = sheets[i];
      if (!s || !tabButton) return;
      const input = el('input', 'cp-sheet-tab-input');
      input.type = 'text';
      input.value = s.name;
      input.maxLength = 31;
      let finished = false;
      const finish = (apply: boolean): void => {
        if (finished) return;
        finished = true;
        if (apply) renameSheet(s, input.value);
        renderTabs();
        scroller.focus({ preventScroll: true });
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      tabButton.replaceWith(input);
      input.focus();
      input.select();
    }

    // ---- context menu
    function closeMenu(): void {
      if (menuEl.hidden) return;
      menuEl.hidden = true;
      menuEl.replaceChildren();
      document.removeEventListener('mousedown', onDocMouseDown, true);
    }

    function onDocMouseDown(e: MouseEvent): void {
      if (!menuEl.contains(asNode(e.target))) closeMenu();
    }

    function showMenu(items: MenuItem[], clientX: number, clientY: number): void {
      closeMenu();
      items.forEach((it) => {
        if (it === '-') { menuEl.appendChild(el('div', 'cp-sheet-menu-sep')); return; }
        const b = el('button', 'cp-sheet-menu-item');
        b.type = 'button';
        b.textContent = it.label;
        b.disabled = Boolean(it.disabled);
        b.addEventListener('click', () => { closeMenu(); it.action(); });
        menuEl.appendChild(b);
      });
      menuEl.hidden = false;
      const rr = root.getBoundingClientRect();
      menuEl.style.left = clamp(clientX - rr.left, 0, Math.max(rr.width - menuEl.offsetWidth - 4, 0)) + 'px';
      menuEl.style.top = clamp(clientY - rr.top, 0, Math.max(rr.height - menuEl.offsetHeight - 4, 0)) + 'px';
      document.addEventListener('mousedown', onDocMouseDown, true);
    }

    function cellMenu(clientX: number, clientY: number): void {
      const rg = rangeOf();
      const nR = Math.min(rg.r2 - rg.r1 + 1, MAX_INSERT);
      const nC = Math.min(rg.c2 - rg.c1 + 1, MAX_INSERT);
      showMenu([
        { label: 'Insert row' + (nR > 1 ? 's' : '') + ' above', action: () => insertLines('r', rg.r1, nR) },
        { label: 'Insert row' + (nR > 1 ? 's' : '') + ' below', action: () => insertLines('r', rg.r2 + 1, nR) },
        { label: 'Insert column' + (nC > 1 ? 's' : '') + ' left', action: () => insertLines('c', rg.c1, nC) },
        { label: 'Insert column' + (nC > 1 ? 's' : '') + ' right', action: () => insertLines('c', rg.c2 + 1, nC) },
        '-',
        { label: 'Delete row' + (nR > 1 ? 's' : ''), action: () => deleteLines('r', rg.r1, Math.min(rg.r2, MAX_ROWS - 1) - rg.r1 + 1) },
        { label: 'Delete column' + (nC > 1 ? 's' : ''), action: () => deleteLines('c', rg.c1, Math.min(rg.c2, MAX_COLS - 1) - rg.c1 + 1) },
        '-',
        { label: 'Clear contents', action: () => clearRange(rg) },
        { label: 'Sort selection A to Z', action: () => sortSelection(true) },
        { label: 'Sort selection Z to A', action: () => sortSelection(false) }
      ], clientX, clientY);
    }

    // ---- mouse
    const cellFromEvent = (e: MouseEvent): CellPos => {
      const s = sh();
      const rect = cellsEl.getBoundingClientRect();
      const x = e.clientX - rect.left + scroller.scrollLeft;
      const y = e.clientY - rect.top + scroller.scrollTop;
      return { r: clamp(Math.floor(y / ROW_H), 0, s.nRows - 1), c: colAt(s, x) };
    };

    const resizeTarget = (e: MouseEvent): number => {
      const s = sh();
      const rect = colHdr.getBoundingClientRect();
      const x = e.clientX - rect.left + scroller.scrollLeft;
      const c = colAt(s, x);
      const cx = s.colX || computeColX(s);
      if (Math.abs(x - cx[c + 1]) <= 4) return c;
      if (c > 0 && x - cx[c] <= 4) return c - 1;
      return -1;
    };

    const applyDrag = (e: MouseEvent): void => {
      if (!drag) return;
      const s = sh();
      if (drag.type === 'resize') {
        const w = clamp(drag.startW + (e.clientX - drag.startX), MIN_COL_W, MAX_COL_W);
        s.colW[drag.c] = w;
        s.colX = null;
        scheduleRender();
        return;
      }
      const rect = cellsEl.getBoundingClientRect();
      const dx = e.clientX < rect.left ? e.clientX - rect.left : (e.clientX > rect.right ? e.clientX - rect.right : 0);
      const dy = e.clientY < rect.top ? e.clientY - rect.top : (e.clientY > rect.bottom ? e.clientY - rect.bottom : 0);
      if (dx && drag.type !== 'row') scroller.scrollLeft += clamp(dx, -40, 40);
      if (dy && drag.type !== 'col') scroller.scrollTop += clamp(dy, -40, 40);
      const p = cellFromEvent(e);
      if (drag.type === 'cell') setSel(s.sel.ar, s.sel.ac, p.r, p.c, true);
      else if (drag.type === 'col') setSel(0, s.sel.ac, MAX_ROWS - 1, p.c, true);
      else if (drag.type === 'row') setSel(s.sel.ar, 0, p.r, MAX_COLS - 1, true);
    };

    const onDragMove = (e: MouseEvent): void => { lastMouse = e; applyDrag(e); };

    const endDrag = (): void => {
      if (!drag) return;
      const d = drag;
      drag = null;
      window.clearInterval(dragTimer);
      document.removeEventListener('mousemove', onDragMove, true);
      document.removeEventListener('mouseup', endDrag, true);
      if (d.type === 'resize') {
        const s = sh();
        const newW = s.colW[d.c];
        const oldW = d.startW === DEF_COL_W && !d.hadWidth ? 0 : d.startW;
        if (newW !== undefined && newW !== d.startW) {
          record({
            sheet: s,
            redo() { s.colW[d.c] = newW; s.colX = null; },
            undo() { s.colW[d.c] = oldW; s.colX = null; }
          });
        }
      }
    };

    const beginDrag = (d: DragState): void => {
      drag = d;
      lastMouse = null;
      document.addEventListener('mousemove', onDragMove, true);
      document.addEventListener('mouseup', endDrag, true);
      dragTimer = window.setInterval(() => { if (lastMouse && drag && drag.type !== 'resize') applyDrag(lastMouse); }, 50);
    };

    frame.addEventListener('mousedown', (e) => {
      closeMenu();
      commitFormulaBar();
      if (edit && e.target !== editorEl) commitEdit(0, 0);
      if (e.target === editorEl) return;
      const s = sh();
      const target = asNode(e.target);
      if (e.button === 2) {
        const inside = cellsEl.contains(target);
        const rg = rangeOf();
        if (inside) {
          const p = cellFromEvent(e);
          if (p.r < rg.r1 || p.r > rg.r2 || p.c < rg.c1 || p.c > rg.c2) setSel(p.r, p.c, p.r, p.c);
        } else if (colHdr.contains(target)) {
          const p = cellFromEvent(e);
          if (!(fullCols(s) && p.c >= rg.c1 && p.c <= rg.c2)) setSel(0, p.c, MAX_ROWS - 1, p.c);
        } else if (rowHdr.contains(target)) {
          const p = cellFromEvent(e);
          if (!(fullRows(s) && p.r >= rg.r1 && p.r <= rg.r2)) setSel(p.r, 0, p.r, MAX_COLS - 1);
        }
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      scroller.focus({ preventScroll: true });
      if (cellsEl.contains(target)) {
        const p = cellFromEvent(e);
        if (e.shiftKey) setSel(s.sel.ar, s.sel.ac, p.r, p.c, true);
        else setSel(p.r, p.c, p.r, p.c, true);
        beginDrag({ type: 'cell' });
      } else if (colHdr.contains(target)) {
        const rc = resizeTarget(e);
        if (rc >= 0) {
          beginDrag({ type: 'resize', c: rc, startX: e.clientX, startW: colWidth(s, rc), hadWidth: Boolean(s.colW[rc]) });
          return;
        }
        const p = cellFromEvent(e);
        setSel(0, e.shiftKey ? s.sel.ac : p.c, MAX_ROWS - 1, p.c, true);
        beginDrag({ type: 'col' });
      } else if (rowHdr.contains(target)) {
        const p = cellFromEvent(e);
        setSel(e.shiftKey ? s.sel.ar : p.r, 0, p.r, MAX_COLS - 1, true);
        beginDrag({ type: 'row' });
      } else if (e.target === corner) {
        setSel(0, 0, MAX_ROWS - 1, MAX_COLS - 1, true);
      }
    });

    frame.addEventListener('mousemove', (e) => {
      if (drag) return;
      colHdr.style.cursor = colHdr.contains(asNode(e.target)) && resizeTarget(e) >= 0 ? 'col-resize' : '';
    });

    frame.addEventListener('dblclick', (e) => {
      if (cellsEl.contains(asNode(e.target)) && e.target !== editorEl) startEdit('edit');
    });

    frame.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (editorEl.contains(asNode(e.target))) return;
      cellMenu(e.clientX, e.clientY);
    });

    scroller.addEventListener('scroll', () => {
      if (scroller.clientHeight === 0) return;
      const s = sh();
      s.scrollLeft = scroller.scrollLeft;
      s.scrollTop = scroller.scrollTop;
      scheduleRender();
    });

    // ---- keyboard
    scroller.addEventListener('keydown', (e) => {
      if (edit) return;
      closeMenu();
      const s = sh();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const cur = e.shiftKey ? { r: s.sel.fr, c: s.sel.fc } : { r: s.sel.ar, c: s.sel.ac };
      const visRows = Math.max(Math.floor((scroller.clientHeight - HEADER_H) / ROW_H) - 1, 1);
      const handled = () => { e.preventDefault(); };
      const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

      if (mod && key.toLowerCase() === 'z') { handled(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && key.toLowerCase() === 'y') { handled(); redo(); return; }
      if (mod && key.toLowerCase() === 'a') { handled(); setSel(0, 0, MAX_ROWS - 1, MAX_COLS - 1, true); return; }
      if (mod && key.toLowerCase() === 'd') { handled(); fillDown(); return; }
      if (mod && key === ' ') { handled(); setSel(0, s.sel.ac, MAX_ROWS - 1, s.sel.fc, true); return; }
      if (!mod && e.shiftKey && key === ' ') { handled(); setSel(s.sel.ar, 0, s.sel.fr, MAX_COLS - 1, true); return; }
      if (arrows[key]) {
        handled();
        const [dr, dc] = arrows[key];
        let target: CellPos;
        if (mod) target = edgeJump(cur.r, cur.c, dr, dc);
        else target = { r: clamp(cur.r + dr, 0, MAX_ROWS - 1), c: clamp(cur.c + dc, 0, MAX_COLS - 1) };
        moveTo(target.r, target.c, e.shiftKey);
        return;
      }
      switch (key) {
        case 'Tab': handled(); moveTo(s.sel.ar, clamp(s.sel.ac + (e.shiftKey ? -1 : 1), 0, MAX_COLS - 1), false); return;
        case 'Enter': handled(); moveTo(clamp(s.sel.ar + (e.shiftKey ? -1 : 1), 0, MAX_ROWS - 1), s.sel.ac, false); return;
        case 'F2': handled(); startEdit('edit'); return;
        case 'Delete':
        case 'Backspace': handled(); clearRange(rangeOf()); return;
        case 'Home': handled(); moveTo(mod ? 0 : cur.r, 0, e.shiftKey); return;
        case 'End': {
          handled();
          if (mod) moveTo(Math.max(usedRows(s) - 1, 0), Math.max(usedCols(s) - 1, 0), e.shiftKey);
          else {
            const row = s.rows[cur.r];
            moveTo(cur.r, row ? Math.max(row.length - 1, 0) : 0, e.shiftKey);
          }
          return;
        }
        case 'PageDown': handled(); moveTo(clamp(cur.r + visRows, 0, MAX_ROWS - 1), cur.c, e.shiftKey); return;
        case 'PageUp': handled(); moveTo(clamp(cur.r - visRows, 0, MAX_ROWS - 1), cur.c, e.shiftKey); return;
        case 'Escape': lastCopy = null; return;
        default:
      }
      if (key.length === 1 && (!mod && !e.altKey || e.getModifierState('AltGraph'))) {
        // The focused editor receives the keystroke that follows this keydown, so no value is injected here.
        startEdit('enter', '');
      }
    });

    scroller.addEventListener('copy', (e) => onCopy(e, false));
    scroller.addEventListener('cut', (e) => onCopy(e, true));
    scroller.addEventListener('paste', onPaste);

    // ---- find
    const matches = (cell: Cell | undefined, q: string, matchCase: boolean): boolean => {
      if (!cell) return false;
      let text = displayText(cell);
      if (typeof cell.f === 'string') text += '\n=' + cell.f;
      return (matchCase ? text : text.toLowerCase()).indexOf(q) >= 0;
    };

    const findStep = (dir: number): void => {
      const s = sh();
      const matchCase = findCase.checked;
      const q = matchCase ? findInput.value : findInput.value.toLowerCase();
      if (q === '') { findMsg.textContent = ''; return; }
      const rows = usedRows(s);
      const cols = usedCols(s);
      const total = rows * cols;
      if (total === 0) { findMsg.textContent = 'No matches'; return; }
      let idx = clamp(s.sel.ar, 0, rows - 1) * cols + clamp(s.sel.ac, 0, cols - 1);
      for (let n = 0; n < total; n += 1) {
        idx = (idx + dir + total) % total;
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        if (matches(getCell(s, r, c), q, matchCase)) {
          setSel(r, c, r, c);
          findMsg.textContent = '';
          return;
        }
      }
      findMsg.textContent = 'No matches';
    };

    const closeFind = (): void => {
      findBar.hidden = true;
      findMsg.textContent = '';
      scroller.focus({ preventScroll: true });
      scheduleRender();
    };

    findInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    findNext.addEventListener('click', () => findStep(1));
    findPrev.addEventListener('click', () => findStep(-1));
    findClose.addEventListener('click', closeFind);

    // ---- status
    function getStatusText(): string {
      const s = sh();
      const rg = rangeOf();
      let text = s.name + ' · ' + rangeLabel();
      if (rg.r1 === rg.r2 && rg.c1 === rg.c2) {
        if (usedRows(s) > 0) text += '  ·  ' + usedRows(s) + ' rows × ' + usedCols(s) + ' cols';
        return text;
      }
      let sum = 0;
      let count = 0;
      eachUsed(rg, (r, c, cell) => {
        const v = numericValue(cell, textOnly);
        if (!Number.isNaN(v)) { sum += v; count += 1; }
      });
      if (count > 0) text += '  ·  Sum: ' + Number(sum.toPrecision(12)) + '  Count: ' + count;
      return text;
    }

    // ---- save / session
    const buildWorkbook = (X: XlsxModule): XlsxWorkBook => {
      const wb = X.utils.book_new();
      sheets.forEach((s) => X.utils.book_append_sheet(wb, sheetToSheetJs(X, s), s.name));
      // CalcPr is written by SheetJS but missing from its type declarations.
      const workbookProps: NonNullable<XlsxWorkBook['Workbook']> & { CalcPr: { fullCalcOnLoad: boolean } } = {
        CalcPr: { fullCalcOnLoad: formulaEdited },
      };
      wb.Workbook = workbookProps;
      return wb;
    };

    const buildCsv = (fs: string): string => {
      const s = sh();
      const lines: string[] = [];
      for (let r = 0; r < usedRows(s); r += 1) {
        const row = s.rows[r];
        const fields: string[] = [];
        const end = row ? row.length : 0;
        for (let c = 0; c < end; c += 1) {
          const cell = row ? row[c] : undefined;
          fields.push(cell ? quoteField(rawCsvText(cell), fs) : '');
        }
        lines.push(fields.join(fs));
      }
      if (lines.length === 0) return '';
      return lines.join(csvInfo.eol) + (csvInfo.trailing ? csvInfo.eol : '');
    };

    function rawCsvText(cell: Cell): string {
      if (cell.t === 's') return neutralizeFormula(cell.v);
      if (typeof cell.f === 'string' && cell.w !== undefined && cell.w === '=' + cell.f) return neutralizeFormula(cell.w);
      return displayText(cell);
    }

    const view: CodePadEditorView = {
      kind: 'sheet',
      readOnly: false,
      saveMode: ext === 'xls' || ext === 'ods' ? 'saveAs' : 'overwrite',
      saveFilters: ext === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }, { name: 'Excel Workbook', extensions: ['xlsx'] }]
        : (ext === 'tsv'
          ? [{ name: 'TSV', extensions: ['tsv'] }, { name: 'Excel Workbook', extensions: ['xlsx'] }]
          : (ext === 'xlsx'
            ? [{ name: 'Excel Workbook', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'Excel Workbook', extensions: ['xlsx'] }])),
      defaultSaveName: baseName + (ext === 'xls' || ext === 'ods' ? '.xlsx' : '.' + ext),
      sessionStateTooLarge: false,

      /**
       * Serializes the workbook for the target extension.
       * @param targetExt 'xlsx', 'csv' or 'tsv'.
       * @returns File bytes.
       */
      async getBytes(targetExt: string): Promise<Uint8Array> {
        commitEdit(0, 0);
        commitFormulaBar();
        const want = String(targetExt || ext).toLowerCase();
        if (want === 'xlsx') {
          const X = await loadLibs();
          try {
            const out = X.write(buildWorkbook(X), { bookType: 'xlsx', type: 'array', compression: true, cellDates: true });
            return new Uint8Array(out);
          } catch (err) {
            throw new Error('Could not write the workbook: ' + (err instanceof Error && err.message ? err.message : 'unknown error'));
          }
        }
        if (want === 'csv' || want === 'tsv') {
          if (sheets.length > 1) callbacks.onStatus('CSV holds one sheet; the active sheet was saved.');
          const fs = want === 'tsv' ? '\t' : (ext === 'csv' ? csvInfo.fs : ',');
          const body = util().textToBytes((csvInfo.bom ? '﻿' : '') + buildCsv(fs));
          return body;
        }
        throw new Error('Saving spreadsheets as .' + want + ' is not supported.');
      },

      /** @returns True when the document differs from the last saved state. */
      isDirty(): boolean {
        return forceDirty || (undoStack.length ? undoStack[undoStack.length - 1] : null) !== savedMarker;
      },

      /** Marks the current state as saved. */
      markSaved(): void {
        forceDirty = false;
        savedMarker = undoStack.length ? undoStack[undoStack.length - 1] : null;
        // An .xls/.ods source can only be saved as .xlsx; from then on the tab points at that file.
        view.saveMode = 'overwrite';
      },

      /** @returns Snapshot of unsaved edits, or null. */
      async getSessionState(): Promise<object | null> {
        if (!view.isDirty()) return null;
        const state: SessionState = {
          ext,
          sheets: sheets.map(sheetToState),
          activeSheet: activeIdx,
          csv: { fs: csvInfo.fs, bom: csvInfo.bom, eol: csvInfo.eol, trailing: csvInfo.trailing }
        };
        const size = JSON.stringify(state).length;
        if (size > MAX_STATE_BYTES) {
          view.sessionStateTooLarge = true;
          return null;
        }
        view.sessionStateTooLarge = false;
        return state;
      },

      /** @returns Text for the status bar. */
      getStatusText,

      /** Re-measures and redraws the grid (called when the host becomes visible or resizes). */
      layout(): void {
        if (disposed || scroller.clientWidth <= 0 || scroller.clientHeight <= 0) return;
        const s = sh();
        render();
        if (scroller.scrollTop !== s.scrollTop || scroller.scrollLeft !== s.scrollLeft) {
          scroller.scrollLeft = s.scrollLeft;
          scroller.scrollTop = s.scrollTop;
          render();
        }
      },

      /** Focuses the grid. */
      focus(): void {
        if (!disposed) scroller.focus({ preventScroll: true });
      },

      /** Opens the find bar (Ctrl+F). */
      find(): void {
        findBar.hidden = false;
        findInput.focus();
        findInput.select();
        scheduleRender();
      },

      /** Releases listeners and DOM. */
      dispose(): void {
        disposed = true;
        window.clearInterval(dragTimer);
        if (rafId) cancelAnimationFrame(rafId);
        if (resizeObs) resizeObs.disconnect();
        document.removeEventListener('mousemove', onDragMove, true);
        document.removeEventListener('mouseup', endDrag, true);
        document.removeEventListener('mousedown', onDocMouseDown, true);
        root.remove();
      }
    };

    function util(): CodePadEditorUtil { return window.CodePadEditors.util; }

    // ---- start
    sheets.forEach(fitDims);
    renderTabs();
    resizeObs = new ResizeObserver(() => view.layout());
    resizeObs.observe(root);
    setActive(activeIdx, true);
    if (notes) callbacks.onStatus(notes);
    return view;
  }

  window.CodePadEditors.register('sheet', {
    extensions: ['.xlsx', '.xls', '.ods', '.csv', '.tsv'],
    create
  });
})();
