/*
 * PDF viewer / text editor view for CodePad (kind 'pdf').
 *
 * Contract: registers with window.CodePadEditors; create() receives bytes and
 * returns a View. This module never calls IPC: bytes in, bytes out.
 *
 * How it works: pdf.js (lazy ESM) renders each page to a canvas and supplies
 * text items, which are merged into editable "runs" (one visual line fragment).
 * Edits are kept as a JSON list in "page frame" coordinates (the page at scale 1
 * after its /Rotate, origin top-left, y down, in PDF points), so they stay
 * correct at any zoom and page rotation. On save, @cantoo/pdf-lib loads the
 * original bytes into a NEW document, paints a rectangle over the old text and
 * draws the replacement text with a standard font (or embedded Liberation Sans
 * for non-WinAnsi text). The original bytes and file are never modified.
 *
 * Known limits:
 *  - Whiteout and replace only PAINT OVER the old content. The original text
 *    stays in the saved file and can still be selected/extracted. This is not
 *    redaction.
 *  - Original embedded fonts are not reused: edited text uses Helvetica, Times,
 *    Courier or Liberation Sans, so it looks slightly different and widths are
 *    not matched.
 *  - Saving rewrites the file: digital signatures become invalid, encryption is
 *    dropped, tagged structure / PDF-A conformance are not preserved.
 *  - Image-only (scanned) PDFs open view-only. Rotated text, vertical text,
 *    complex scripts and right-to-left text are shown but cannot be edited
 *    reliably; CJK/Arabic/Indic/emoji characters cannot be saved.
 *  - Annotations, forms, links and XFA are neither rendered nor editable.
 *  - Password-protected PDFs are rejected with an error (empty-password
 *    encryption is handled transparently).
 */

(() => {
  const registry = window.CodePadEditors;

  /** The view returned by create(): the standard interface with the find bar made mandatory. */
  type PdfView = CodePadEditorView & { find(): void };
  type PdfTextContent = Awaited<ReturnType<CpPdfJsPage['getTextContent']>>;

  const ASCENT = 0.95;
  const LINE = 1.2;
  const COVER_PAD = 0.5;
  const MAX_HISTORY = 100;
  const MAX_EDITS = 5000;
  const MAX_TEXT = 20000;
  const MAX_SCAN_PAGES = 500;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3;
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const MAX_CANVAS_PIXELS = 16000000;
  const MIN_FONT = 6;
  const MAX_FONT = 96;
  const DRAG_THRESHOLD = 4;
  const EDIT_TYPES: CpPdfEditType[] = ['replace', 'add', 'whiteout'];
  const FONT_KEYS: CpPdfFontKey[] = ['Helvetica', 'Times', 'Courier', 'Liberation'];
  const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace'];
  const CSS_FAMILIES: Record<CpPdfFontKey, string> = {
    Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
    Times: '"Times New Roman", Times, "Liberation Serif", serif',
    Courier: '"Courier New", Courier, "Liberation Mono", monospace',
    Liberation: '"Liberation Sans", Arial, Helvetica, sans-serif',
  };
  const FONT_LABELS: Record<CpPdfFontKey, string> = {
    Helvetica: 'Helvetica (sans)',
    Times: 'Times (serif)',
    Courier: 'Courier (mono)',
    Liberation: 'Liberation Sans',
  };
  const STANDARD_NAMES: Record<Exclude<CpPdfFontKey, 'Liberation'>, CpPdfLibStandardFont[]> = {
    Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  };
  const LIBERATION_FILES = ['Regular', 'Bold', 'Italic', 'BoldItalic'];
  // Rough Latin/Greek/Cyrillic/punctuation/symbol coverage of Liberation Sans, used only
  // for the live "unsupported character" warning; the save-time check uses the real font.
  const LIBERATION_LIKE =
    /^[\u0000-ɏͰ-ϿЀ-ԯḀ-῿ -⁯₠-⃏℀-⅏←-⇿∀-⋿■-◿]*$/;

  const VIEW_ONLY_MESSAGE =
    'This PDF has no text layer (scanned or image-only), so it opens view-only. ' +
    'Image-only pages cannot be edited. Run OCR in another tool first to make it editable.';
  const WHITEOUT_MESSAGE =
    'Whiteout is not redaction: covered text remains in the file and can still be selected ' +
    'or extracted. Do not use it to hide confidential information.';

  /**
   * Creates an element with an optional class and text.
   * @param tag Tag name.
   * @param cls Class names.
   * @param text Text content (inserted with textContent).
   * @returns The element.
   */
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const round1 = (v: number): number => Math.round(v * 10) / 10;

  /** Message of a caught value, or the value itself as text. */
  function errText(err: unknown): string {
    if (typeof err === 'object' && err !== null && 'message' in err && err.message) {
      return String(err.message);
    }
    return String(err);
  }

  /** The `name` of a caught value, if it has one. */
  function errName(err: unknown): unknown {
    return typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
  }

  const copyRect = (r: CpPdfRect): CpPdfRect => [r[0], r[1], r[2], r[3]];
  const copyColor = (c: CpPdfColor): CpPdfColor => [c[0], c[1], c[2]];

  /** Multiplies two PDF 2D matrices (m1 applied after m2), as pdf.js Util.transform. */
  function mul(m1: readonly number[], m2: readonly number[]): number[] {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  const rgbCss = (c: CpPdfColor): string =>
    `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  const toHex = (c: CpPdfColor): string =>
    `#${c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
  const fromHex = (h: string): CpPdfColor => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];

  let measureCtx: CanvasRenderingContext2D | null = null;
  /** Measures text width in CSS px for the given font settings. */
  function measureWidth(text: string, px: number, family: string, bold: boolean, italic: boolean): number {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
    if (!measureCtx) {
      throw new Error('A 2D canvas context is not available.');
    }
    measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${family}`;
    return measureCtx.measureText(text).width;
  }

  /** Normalizes user text: unified newlines, no tabs/control characters, bounded length. */
  function normalizeText(s: string): string {
    return String(s)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
      .replace(/\n+$/, '')
      .slice(0, MAX_TEXT);
  }

  /** Returns the set of characters Liberation Sans plausibly cannot draw. */
  function unsupportedChars(text: string): Set<string> {
    const bad = new Set<string>();
    for (const ch of text) {
      if (ch !== '\n' && !LIBERATION_LIKE.test(ch)) {
        bad.add(ch);
      }
    }
    return bad;
  }

  /** Directory URL (with trailing slash) of a node_modules sub path. */
  function assetDir(rel: string): string {
    return `${registry.util.nodeModulesUrl(rel).replace(/\/+$/, '')}/`;
  }

  /**
   * Loads pdf.js (ESM) lazily and configures its worker. Single place to change
   * if the library is swapped.
   * @returns The pdf.js module namespace.
   */
  async function loadPdfJs(): Promise<PdfJsModule> {
    const util = registry.util;
    const lib = await util.loadModule(util.nodeModulesUrl('pdfjs-dist/build/pdf.min.mjs'));
    lib.GlobalWorkerOptions.workerSrc = util.nodeModulesUrl('pdfjs-dist/build/pdf.worker.min.mjs');
    return lib;
  }

  /**
   * Loads pdf-lib (and returns fontkit loader) on first save.
   * @returns The PDFLib global.
   */
  async function loadPdfLib(): Promise<CpPdfLibApi> {
    const util = registry.util;
    if (!window.PDFLib) {
      await util.loadScript(util.nodeModulesUrl('@cantoo/pdf-lib/dist/pdf-lib.min.js'));
    }
    if (!window.PDFLib) {
      throw new Error('The PDF writer library could not be loaded.');
    }
    return window.PDFLib;
  }

  /** Loads fontkit (only needed for non-WinAnsi text). */
  async function loadFontkit(): Promise<FontkitModule> {
    const util = registry.util;
    if (!window.fontkit) {
      await util.loadScript(util.nodeModulesUrl('@pdf-lib/fontkit/dist/fontkit.umd.min.js'));
    }
    if (!window.fontkit) {
      throw new Error('The font embedding library could not be loaded.');
    }
    return window.fontkit;
  }

  /**
   * Opens a document with pdf.js.
   * @param pdfjs pdf.js module.
   * @param data Bytes (pdf.js takes ownership of this buffer).
   * @returns Document and loading task.
   * @throws {Error} For encrypted, invalid or unreadable files.
   */
  async function openDocument(pdfjs: PdfJsModule, data: Uint8Array): Promise<CpPdfHandle> {
    const params: CpPdfJsOpenParams = {
      data,
      cMapUrl: assetDir('pdfjs-dist/cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assetDir('pdfjs-dist/standard_fonts'),
      wasmUrl: assetDir('pdfjs-dist/wasm'),
      iccUrl: assetDir('pdfjs-dist/iccs'),
      isEvalSupported: false,
      enableScripting: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: false,
    };
    const task = pdfjs.getDocument(params);
    try {
      return { doc: await task.promise, task };
    } catch (err) {
      task.destroy();
      if (errName(err) === 'PasswordException') {
        throw new Error('This PDF is password-protected. Password-protected PDFs cannot be opened in CodePad.', {
          cause: err,
        });
      }
      if (errName(err) === 'InvalidPDFException') {
        throw new Error('This file is not a valid PDF or is damaged.', { cause: err });
      }
      throw new Error(`The PDF could not be opened: ${errText(err)}`, { cause: err });
    }
  }

  /**
   * Merges pdf.js text items of a page into editable runs.
   * @param ps Page state (needs index and vp).
   * @param tc pdf.js text content.
   * @returns Runs in page-frame coordinates.
   */
  function extractRuns(ps: CpPdfPageState, tc: PdfTextContent): CpPdfRun[] {
    const out: CpPdfRun[] = [];
    let cur: CpPdfRun | null = null;
    let prevEol = false;
    for (const item of tc.items) {
      if (!('str' in item) || typeof item.str !== 'string' || item.str === '') {
        if ('hasEOL' in item && item.hasEOL) {
          cur = null;
        }
        continue;
      }
      const m = mul(ps.vp.transform, item.transform);
      const fs = Math.hypot(m[2], m[3]);
      if (!(fs >= 1)) {
        cur = null;
        continue;
      }
      const angle = Math.atan2(m[1], m[0]);
      const rot = Math.abs(angle) > 0.02;
      const x = m[4];
      const base = m[5];
      const w = Math.abs(item.width);
      const blank = item.str.trim() === '';
      if (
        cur &&
        !cur.rot &&
        !rot &&
        !prevEol &&
        Math.abs(base - cur.base) < 0.2 * cur.fs &&
        (blank || (item.fontName === cur.fontName && Math.abs(fs - cur.fs) < 0.5))
      ) {
        const gap = x - (cur.x + cur.w);
        if (gap > -0.5 * cur.fs && gap < 0.35 * cur.fs) {
          if (gap > 0.15 * cur.fs && !/\s$/.test(cur.str) && !/^\s/.test(item.str)) {
            cur.str += ' ';
          }
          cur.str += item.str;
          cur.w = Math.max(cur.w, x + w - cur.x);
          prevEol = item.hasEOL;
          continue;
        }
      }
      const style: { fontFamily?: string } = (tc.styles && tc.styles[item.fontName]) || {};
      cur = {
        pageIndex: ps.index,
        str: item.str,
        x,
        base,
        fs,
        w,
        rot,
        angle,
        fontName: item.fontName,
        family: style.fontFamily || 'sans-serif',
        y: base - ASCENT * fs,
        h: LINE * fs,
      };
      out.push(cur);
      prevEol = item.hasEOL;
    }
    return out.filter((r) => r.str.trim() !== '');
  }

  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
  const isRect = (r: unknown): r is CpPdfRect =>
    Array.isArray(r) && r.length === 4 && r.every(isNum) && r[2] >= 0 && r[3] >= 0;
  const isEditType = (v: unknown): v is CpPdfEditType => EDIT_TYPES.some((t) => t === v);
  const isFontKey = (v: unknown): v is CpPdfFontKey => FONT_KEYS.some((k) => k === v);

  /**
   * Validates a restored edit list (untrusted data).
   * @param raw Value from restoredState.edits.
   * @param pageCount Number of pages.
   * @param newId Id generator.
   * @returns Sanitized edits.
   */
  function sanitizeEdits(raw: unknown, pageCount: number, newId: () => string): CpPdfEdit[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const list: unknown[] = raw;
    const colorOf = (c: unknown, dflt: CpPdfColor): CpPdfColor =>
      Array.isArray(c) && c.length === 3 && c.every(isNum)
        ? [clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1)]
        : dflt;
    const out: CpPdfEdit[] = [];
    for (const item of list.slice(0, MAX_EDITS)) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const e = item as Record<string, unknown>;
      const type = e.type;
      const page = e.page;
      const rect = e.rect;
      const origRect = e.origRect;
      if (!isEditType(type)) {
        continue;
      }
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page >= pageCount || !isRect(rect)) {
        continue;
      }
      if (type === 'replace' && !isRect(origRect)) {
        continue;
      }
      const id = newId();
      const bg = colorOf(e.bg, [1, 1, 1]);
      if (type === 'whiteout') {
        out.push({ id, page, type, rect: copyRect(rect), bg });
        continue;
      }
      const text = typeof e.text === 'string' ? normalizeText(e.text) : '';
      const fontSize = isNum(e.fontSize) ? clamp(e.fontSize, MIN_FONT, MAX_FONT) : 12;
      const fontKey = isFontKey(e.fontKey) ? e.fontKey : 'Helvetica';
      const bold = e.bold === true;
      const italic = e.italic === true;
      const color = colorOf(e.color, [0, 0, 0]);
      if (type === 'replace' && isRect(origRect)) {
        out.push({
          id,
          page,
          type,
          rect: copyRect(rect),
          bg,
          origRect: copyRect(origRect),
          text,
          fontSize,
          fontKey,
          bold,
          italic,
          color,
        });
      } else if (type === 'add') {
        out.push({ id, page, type, rect: copyRect(rect), bg, text, fontSize, fontKey, bold, italic, color });
      }
    }
    return out;
  }

  const hasBox = (edit: CpPdfEdit): edit is CpPdfTextEdit => edit.type !== 'whiteout';
  const patchRect = (edit: CpPdfEdit): CpPdfRect | undefined => (edit.type === 'whiteout' ? edit.rect : edit.type === 'replace' ? edit.origRect : undefined);

  /** Assigns one style property (the typed counterpart of `target[prop] = value`). */
  function setStyle<K extends keyof CpPdfStyle>(target: Partial<CpPdfStyle>, prop: K, value: CpPdfStyle[K]): void {
    target[prop] = value;
  }

  /**
   * Builds the PDF view.
   * @param options Options from CodePadEditors (container, bytes, fileName, restoredState, callbacks).
   * @returns The View.
   * @throws {Error} When the PDF cannot be opened.
   */
  async function create(options: CodePadViewOptions): Promise<PdfView> {
    const { container, bytes, fileName, restoredState, callbacks } = options;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error('The PDF file has no content.');
    }
    const pdfjs = await loadPdfJs();
    const baseCopy = bytes.slice();
    let handle = await openDocument(pdfjs, bytes.slice());
    let proxies: CpPdfJsPage[];
    let hasText = false;
    try {
      proxies = [];
      for (let i = 1; i <= handle.doc.numPages; i += 1) {
        proxies.push(await handle.doc.getPage(i));
      }
      for (let i = 0; i < Math.min(proxies.length, MAX_SCAN_PAGES) && !hasText; i += 1) {
        const tc = await proxies[i].getTextContent();
        hasText = tc.items.some((it) => 'str' in it && typeof it.str === 'string' && it.str.trim() !== '');
      }
    } catch (err) {
      handle.task.destroy();
      throw new Error(`The PDF could not be read: ${errText(err)}`, { cause: err });
    }

    const readOnly = !hasText;
    const baseName = String(fileName || 'document').replace(/\.pdf$/i, '');

    // ---- state ----
    let baseBytes: Uint8Array = baseCopy;
    let pages: CpPdfPageState[] = [];
    let edits: CpPdfEdit[] = [];
    let idCounter = 0;
    const newId = (): string => {
      idCounter += 1;
      return `e${idCounter}`;
    };
    let savedJson = '[]';
    let lastOutput: { bytes: Uint8Array; snapshot: string } | null = null;
    let hist: CpPdfHistory = { undo: [], redo: [] };
    let zoom = 1;
    let zoomMode = 'fit';
    let selectedId: string | null = null;
    let editing: CpPdfEditing | null = null;
    let currentPage = 1;
    let pendingPage: number | null = null;
    let disposed = false;
    let observer: IntersectionObserver | null = null;
    let rafPending = false;
    let matches: CpPdfMatch[] = [];
    let findIndex = -1;
    let findToken = 0;
    let findCase = false;
    const runOfEl = new WeakMap<Element, CpPdfRun>();
    const defaults: CpPdfStyle = {
      fontKey: 'Helvetica',
      fontSize: 12,
      bold: false,
      italic: false,
      color: [0, 0, 0],
      bg: [1, 1, 1],
    };

    if (restoredState && typeof restoredState === 'object') {
      const saved = restoredState as Record<string, unknown>;
      const savedZoom = saved.zoom;
      const savedPage = saved.page;
      edits = sanitizeEdits(saved.edits, proxies.length, newId);
      if (typeof savedZoom === 'number' && Number.isFinite(savedZoom)) {
        zoom = clamp(savedZoom, MIN_ZOOM, MAX_ZOOM);
        zoomMode = 'manual';
      }
      if (typeof savedPage === 'number' && Number.isInteger(savedPage) && savedPage >= 1 && savedPage <= proxies.length) {
        pendingPage = savedPage;
        currentPage = savedPage;
      }
    }

    // ---- DOM ----
    const root = el('div', 'cp-pdf');
    root.tabIndex = -1;
    root.dataset.tool = 'edit';
    if (readOnly) {
      root.classList.add('cp-pdf-readonly');
    }
    const toolbar = el('div', 'cp-pdf-toolbar');
    const banner = el('div', 'cp-pdf-banner');
    const findBar = el('div', 'cp-pdf-find');
    const scrollEl = el('div', 'cp-pdf-scroll');
    const pagesEl = el('div', 'cp-pdf-pages');
    scrollEl.append(pagesEl);
    root.append(toolbar, banner, findBar, scrollEl);
    container.append(root);

    /** Creates a toolbar button that does not steal focus from an open text box. */
    function button(label: string, title: string, onClick: () => void, cls?: string): HTMLButtonElement {
      const b = el('button', `cp-pdf-btn${cls ? ` ${cls}` : ''}`, label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', onClick);
      return b;
    }
    function group(cls?: string): HTMLDivElement {
      const g = el('div', `cp-pdf-group${cls ? ` ${cls}` : ''}`);
      toolbar.append(g);
      return g;
    }

    const toolBtns: Record<string, HTMLButtonElement> = {};
    const toolGroup = group('cp-pdf-editonly');
    [
      ['edit', 'Edit text', 'Click a line of text to edit it in place'],
      ['add', 'Add text', 'Click anywhere on a page to add new text'],
      ['whiteout', 'Whiteout', 'Drag a rectangle to cover content. Not redaction: covered text stays in the file.'],
    ].forEach(([tool, label, title]) => {
      toolBtns[tool] = button(label, title, () => setTool(tool));
      toolGroup.append(toolBtns[tool]);
    });
    const undoBtn = button('Undo', 'Undo (Ctrl+Z)', () => undo());
    const redoBtn = button('Redo', 'Redo (Ctrl+Y)', () => redo());
    group('cp-pdf-editonly').append(undoBtn, redoBtn);

    const styleGroup = group('cp-pdf-editonly');
    const fontSel = el('select', 'cp-pdf-input');
    fontSel.title = 'Font';
    FONT_KEYS.forEach((k) => {
      const o = el('option', '', FONT_LABELS[k]);
      o.value = k;
      fontSel.append(o);
    });
    const sizeInput = el('input', 'cp-pdf-input cp-pdf-size');
    sizeInput.type = 'number';
    sizeInput.min = String(MIN_FONT);
    sizeInput.max = String(MAX_FONT);
    sizeInput.step = '0.5';
    sizeInput.title = 'Font size (pt)';
    const boldBtn = button('B', 'Bold', () => applyStyle('bold', !currentStyle().bold), 'cp-pdf-bold');
    const italicBtn = button('I', 'Italic', () => applyStyle('italic', !currentStyle().italic), 'cp-pdf-italic');
    const colorInput = el('input', 'cp-pdf-color');
    colorInput.type = 'color';
    colorInput.title = 'Text colour';
    const fillInput = el('input', 'cp-pdf-color');
    fillInput.type = 'color';
    fillInput.title = 'Cover / background colour';
    styleGroup.append(fontSel, sizeInput, boldBtn, italicBtn, colorInput, fillInput);

    const zoomGroup = group();
    const zoomLabel = el('span', 'cp-pdf-label', '100%');
    zoomGroup.append(
      button('-', 'Zoom out', () => zoomStep(-1)),
      zoomLabel,
      button('+', 'Zoom in', () => zoomStep(1)),
      button('Fit width', 'Fit page width', () => setZoom(computeFit(), 'fit')),
    );
    const pageGroup = group();
    const pageInput = el('input', 'cp-pdf-input cp-pdf-page-input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.max = String(proxies.length);
    pageInput.title = 'Go to page';
    pageGroup.append(pageInput, el('span', 'cp-pdf-label', `/ ${proxies.length}`));
    const findToggle = button('Find', 'Find text (Ctrl+F)', () => view.find());
    group().append(findToggle);

    const findInput = el('input', 'cp-pdf-input cp-pdf-find-input');
    findInput.type = 'text';
    findInput.placeholder = 'Find in document';
    const findCount = el('span', 'cp-pdf-label');
    const caseBtn = button('Aa', 'Match case', () => {
      findCase = !findCase;
      caseBtn.setAttribute('aria-pressed', String(findCase));
      runFind();
    });
    caseBtn.setAttribute('aria-pressed', 'false');
    findBar.append(
      findInput,
      caseBtn,
      button('Prev', 'Previous match', () => stepFind(-1)),
      button('Next', 'Next match', () => stepFind(1)),
      findCount,
      button('Close', 'Close find', () => closeFind()),
    );

    // ---- helpers ----
    const pageCount = (): number => proxies.length;
    const lookupEdit = (id: string): CpPdfEdit | undefined =>
      editing && editing.edit.id === id ? editing.edit : edits.find((x) => x.id === id);
    const selectedEdit = (): CpPdfEdit | null | undefined => (selectedId ? lookupEdit(selectedId) : null);
    const editsOnPage = (ps: CpPdfPageState): CpPdfEdit[] => {
      const list = edits.filter((e) => e.page === ps.index);
      if (editing && editing.edit.page === ps.index && !list.includes(editing.edit)) {
        list.push(editing.edit);
      }
      return list;
    };

    function currentStyle(): CpPdfStyle {
      const t = editing ? editing.edit : selectedEdit();
      return t && hasBox(t) ? t : defaults;
    }

    function status(): string {
      const parts = [`Page ${currentPage} / ${pageCount()}`, `${Math.round(zoom * 100)}%`];
      if (readOnly) {
        parts.push('view only');
      } else if (edits.length) {
        parts.push(`${edits.length} edit${edits.length === 1 ? '' : 's'}`);
      }
      return parts.join(' · ');
    }

    function updateBanner(): void {
      const msgs: string[] = [];
      if (readOnly) {
        msgs.push(VIEW_ONLY_MESSAGE);
      } else if (root.dataset.tool === 'whiteout' || edits.some((e) => e.type !== 'add')) {
        msgs.push(WHITEOUT_MESSAGE);
      }
      banner.textContent = msgs.join(' ');
      banner.classList.toggle('cp-pdf-banner-visible', msgs.length > 0);
      banner.classList.toggle('cp-pdf-banner-info', readOnly);
    }

    function updateUi(): void {
      undoBtn.disabled = hist.undo.length === 0;
      redoBtn.disabled = hist.redo.length === 0;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      if (document.activeElement !== pageInput) {
        pageInput.value = String(currentPage);
      }
      Object.keys(toolBtns).forEach((t) => toolBtns[t].setAttribute('aria-pressed', String(root.dataset.tool === t)));
      updateBanner();
    }

    function syncControls(): void {
      const t = editing ? editing.edit : selectedEdit();
      const src = t && hasBox(t) ? t : defaults;
      const disabled = !!t && !hasBox(t);
      fontSel.value = src.fontKey;
      if (document.activeElement !== sizeInput) {
        sizeInput.value = String(round1(src.fontSize));
      }
      boldBtn.setAttribute('aria-pressed', String(!!src.bold));
      italicBtn.setAttribute('aria-pressed', String(!!src.italic));
      colorInput.value = toHex(src.color);
      fillInput.value = toHex(t ? t.bg : defaults.bg);
      [fontSel, sizeInput, boldBtn, italicBtn, colorInput].forEach((c) => {
        c.disabled = disabled;
      });
      fillInput.disabled = !!t && t.type === 'add';
    }

    function changed(): void {
      updateUi();
      callbacks.onChange();
    }

    function commitHistory(before: string): void {
      if (JSON.stringify(edits) === before) {
        return;
      }
      hist.undo.push(before);
      if (hist.undo.length > MAX_HISTORY) {
        hist.undo.shift();
      }
      hist.redo = [];
      changed();
    }

    /** Recomputes width/height of a text edit's box from its text and font. */
    function fitRect(edit: CpPdfEdit): void {
      if (!hasBox(edit)) {
        return;
      }
      const lines = (edit.text || '').split('\n');
      const fam = CSS_FAMILIES[edit.fontKey];
      let w = 0;
      lines.forEach((l) => {
        w = Math.max(w, measureWidth(l, edit.fontSize, fam, edit.bold, edit.italic));
      });
      edit.rect[2] = Math.max(w, edit.fontSize * 0.5);
      edit.rect[3] = lines.length * LINE * edit.fontSize;
    }

    // ---- edit elements ----
    function ensureEls(ps: CpPdfPageState, edit: CpPdfEdit): CpPdfEditEls {
      const existing = ps.editEls.get(edit.id);
      if (existing) {
        return existing;
      }
      const els: CpPdfEditEls = { patch: null, box: null, handle: el('div', 'cp-pdf-handle') };
      if (edit.type !== 'add') {
        els.patch = el('div', 'cp-pdf-patch');
        els.patch.dataset.edit = edit.id;
        ps.patchLayer.append(els.patch);
      }
      if (hasBox(edit)) {
        els.box = el('div', 'cp-pdf-box');
        els.box.dataset.edit = edit.id;
        els.box.spellcheck = false;
        els.box.addEventListener('input', () => onBoxInput(edit.id));
        els.box.addEventListener('keydown', (e) => onBoxKeyDown(e, edit.id));
        ps.boxLayer.append(els.box);
      }
      els.handle.dataset.edit = edit.id;
      els.handle.dataset.handle = '1';
      els.handle.title = hasBox(edit) ? 'Drag to change the font size' : 'Drag to resize';
      ps.boxLayer.append(els.handle);
      ps.editEls.set(edit.id, els);
      return els;
    }

    function styleEls(ps: CpPdfPageState, edit: CpPdfEdit): void {
      const els = ensureEls(ps, edit);
      const z = zoom;
      const isEditing = !!editing && editing.edit === edit;
      const selected = edit.id === selectedId;
      const r = patchRect(edit);
      if (els.patch && r) {
        els.patch.style.left = `${(r[0] - COVER_PAD) * z}px`;
        els.patch.style.top = `${(r[1] - COVER_PAD) * z}px`;
        els.patch.style.width = `${(r[2] + 2 * COVER_PAD) * z}px`;
        els.patch.style.height = `${(r[3] + 2 * COVER_PAD) * z}px`;
        els.patch.style.background = rgbCss(edit.bg);
        els.patch.classList.toggle('selected', selected);
      }
      if (els.box && hasBox(edit)) {
        const b = els.box;
        const unsupported = unsupportedChars(edit.text || '');
        b.style.left = `${edit.rect[0] * z}px`;
        b.style.top = `${edit.rect[1] * z}px`;
        b.style.fontSize = `${edit.fontSize * z}px`;
        b.style.lineHeight = `${LINE * edit.fontSize * z}px`;
        b.style.fontFamily = CSS_FAMILIES[edit.fontKey];
        b.style.fontWeight = edit.bold ? 'bold' : 'normal';
        b.style.fontStyle = edit.italic ? 'italic' : 'normal';
        b.style.color = rgbCss(edit.color);
        b.style.display = !isEditing && (edit.text || '') === '' ? 'none' : '';
        b.classList.toggle('selected', selected);
        b.classList.toggle('unsupported', unsupported.size > 0);
        b.title = unsupported.size
          ? `These characters cannot be saved: ${[...unsupported].join(' ')}`
          : 'Click to edit, drag to move';
        if (!isEditing && b.textContent !== edit.text) {
          b.textContent = edit.text || '';
        }
      }
      const hr = edit.rect;
      els.handle.style.left = `${(hr[0] + hr[2]) * z - 5}px`;
      els.handle.style.top = `${(hr[1] + hr[3]) * z - 5}px`;
      els.handle.classList.toggle('selected', selected && !isEditing);
    }

    function isRunHidden(ps: CpPdfPageState, run: CpPdfRun): boolean {
      const cx = run.x + run.w / 2;
      const cy = run.base - run.fs * 0.3;
      return editsOnPage(ps).some((e) => {
        const r = patchRect(e);
        return !!r && cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3];
      });
    }

    async function loadRuns(ps: CpPdfPageState): Promise<CpPdfRun[]> {
      if (ps.runs) {
        return ps.runs;
      }
      if (!ps.runsPromise) {
        ps.runsPromise = ps.page
          .getTextContent()
          .then((tc) => extractRuns(ps, tc))
          .catch((err: unknown): CpPdfRun[] => {
            callbacks.onStatus(`Could not read the text of page ${ps.index + 1}: ${errText(err)}`);
            return [];
          })
          .then((runs) => {
            ps.runs = runs;
            return runs;
          });
      }
      return ps.runsPromise;
    }

    function makeRunEl(run: CpPdfRun): HTMLElement {
      const span = el('span', 'cp-pdf-run', run.str);
      const fam = GENERIC_FAMILIES.includes(run.family) ? run.family : 'sans-serif';
      const natural = measureWidth(run.str, run.fs, fam, false, false);
      const k = natural > 0 && run.w > 0 ? run.w / natural : 1;
      span.style.left = `${run.x * zoom}px`;
      span.style.top = `${run.base * zoom}px`;
      span.style.fontSize = `${run.fs * zoom}px`;
      span.style.lineHeight = `${LINE * run.fs * zoom}px`;
      span.style.fontFamily = fam;
      span.style.transform =
        `${run.rot ? `rotate(${run.angle}rad) ` : ''}translateY(${-ASCENT * run.fs * zoom}px) scaleX(${k})`;
      if (run.rot) {
        span.classList.add('cp-pdf-run-rot');
        span.title = 'Rotated text cannot be edited';
      }
      runOfEl.set(span, run);
      return span;
    }

    function renderHits(ps: CpPdfPageState): void {
      ps.hitLayer.replaceChildren();
      matches.forEach((m, i) => {
        if (m.ps !== ps || m.run.rot) {
          return;
        }
        const len = m.run.str.length || 1;
        const hit = el('div', `cp-pdf-hit${i === findIndex ? ' cp-pdf-hit-current' : ''}`);
        hit.style.left = `${(m.run.x + (m.run.w * m.start) / len) * zoom}px`;
        hit.style.top = `${m.run.y * zoom}px`;
        hit.style.width = `${((m.run.w * m.len) / len) * zoom}px`;
        hit.style.height = `${m.run.h * zoom}px`;
        ps.hitLayer.append(hit);
      });
    }

    function buildEditLayer(ps: CpPdfPageState): void {
      ps.patchLayer.replaceChildren();
      ps.boxLayer.replaceChildren();
      ps.editEls.clear();
      editsOnPage(ps).forEach((e) => styleEls(ps, e));
    }

    function buildRunLayer(ps: CpPdfPageState): void {
      loadRuns(ps).then((runs) => {
        if (!ps.live || disposed) {
          return;
        }
        const frag = document.createDocumentFragment();
        runs.forEach((run) => {
          if (!isRunHidden(ps, run)) {
            frag.append(makeRunEl(run));
          }
        });
        ps.runLayer.replaceChildren(frag);
        renderHits(ps);
      });
    }

    function buildLayer(ps: CpPdfPageState): void {
      buildEditLayer(ps);
      buildRunLayer(ps);
    }

    function rebuildAllLive(): void {
      pages.forEach((ps) => {
        if (ps.live) {
          buildLayer(ps);
        }
      });
    }

    // ---- page rendering ----
    function setPageSize(ps: CpPdfPageState): void {
      ps.el.style.width = `${ps.w * zoom}px`;
      ps.el.style.height = `${ps.h * zoom}px`;
    }

    async function renderCanvas(ps: CpPdfPageState): Promise<void> {
      ps.renderToken += 1;
      const token = ps.renderToken;
      if (ps.renderTask) {
        ps.renderTask.cancel();
        ps.renderTask = null;
      }
      let scale = zoom * (window.devicePixelRatio || 1);
      while (ps.w * scale * ps.h * scale > MAX_CANVAS_PIXELS) {
        scale *= 0.9;
      }
      const viewport = ps.page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.className = 'cp-pdf-canvas';
      const task = ps.page.render({ canvasContext: canvas.getContext('2d') ?? undefined, canvas, viewport });
      ps.renderTask = task;
      try {
        await task.promise;
      } catch (err) {
        if (errName(err) === 'RenderingCancelledException') {
          return;
        }
        callbacks.onStatus(`Could not render page ${ps.index + 1}: ${errText(err)}`);
        return;
      }
      if (token !== ps.renderToken || !ps.live || disposed) {
        return;
      }
      ps.renderTask = null;
      if (ps.canvas) {
        ps.canvas.remove();
      }
      ps.canvas = canvas;
      ps.el.insertBefore(canvas, ps.el.firstChild);
    }

    function activatePage(ps: CpPdfPageState): void {
      if (ps.live) {
        return;
      }
      ps.live = true;
      renderCanvas(ps);
      buildLayer(ps);
    }

    function deactivatePage(ps: CpPdfPageState): void {
      if (!ps.live || (editing && editing.ps === ps)) {
        return;
      }
      ps.live = false;
      ps.renderToken += 1;
      if (ps.renderTask) {
        ps.renderTask.cancel();
        ps.renderTask = null;
      }
      if (ps.canvas) {
        ps.canvas.width = 0;
        ps.canvas.height = 0;
        ps.canvas.remove();
        ps.canvas = null;
      }
      [ps.patchLayer, ps.hitLayer, ps.runLayer, ps.boxLayer].forEach((l) => l.replaceChildren());
      ps.editEls.clear();
    }

    function buildPages(): void {
      if (observer) {
        observer.disconnect();
      }
      pages.forEach((ps) => {
        ps.renderToken += 1;
        if (ps.renderTask) {
          ps.renderTask.cancel();
        }
      });
      pagesEl.replaceChildren();
      pages = proxies.map((page, index) => {
        const vp = page.getViewport({ scale: 1 });
        const ps: CpPdfPageState = {
          index,
          page,
          vp,
          w: vp.width,
          h: vp.height,
          live: false,
          canvas: null,
          renderTask: null,
          renderToken: 0,
          runs: null,
          runsPromise: null,
          editEls: new Map(),
          el: el('div', 'cp-pdf-page'),
          patchLayer: el('div', 'cp-pdf-layer cp-pdf-patches'),
          hitLayer: el('div', 'cp-pdf-layer cp-pdf-hits'),
          runLayer: el('div', 'cp-pdf-layer cp-pdf-runs'),
          boxLayer: el('div', 'cp-pdf-layer cp-pdf-boxes'),
        };
        ps.el.dataset.index = String(index);
        ps.el.append(ps.patchLayer, ps.hitLayer, ps.runLayer, ps.boxLayer);
        setPageSize(ps);
        pagesEl.append(ps.el);
        return ps;
      });
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const ps = pages[Number((entry.target as HTMLElement).dataset.index)];
            if (!ps) {
              return;
            }
            if (entry.isIntersecting) {
              activatePage(ps);
            } else {
              deactivatePage(ps);
            }
          });
        },
        { root: scrollEl, rootMargin: '150% 0px 150% 0px' },
      );
      const pageObserver = observer;
      pages.forEach((ps) => pageObserver.observe(ps.el));
    }

    // ---- zoom / navigation ----
    function computeFit(): number {
      const maxW = pages.reduce((m, ps) => Math.max(m, ps.w), 1);
      const avail = Math.max(100, scrollEl.clientWidth - 32);
      return clamp(avail / maxW, 0.25, MAX_ZOOM);
    }

    function setZoom(z: number, mode: string): void {
      commitEdit();
      const next = clamp(z, mode === 'fit' ? 0.25 : MIN_ZOOM, MAX_ZOOM);
      zoomMode = mode;
      if (Math.abs(next - zoom) < 0.0005) {
        updateUi();
        return;
      }
      const ratio = scrollEl.scrollTop / Math.max(1, scrollEl.scrollHeight);
      zoom = next;
      pages.forEach((ps) => {
        setPageSize(ps);
        if (ps.live) {
          renderCanvas(ps);
          buildLayer(ps);
        }
      });
      scrollEl.scrollTop = ratio * scrollEl.scrollHeight;
      updateCurrentPage();
      changed();
    }

    function zoomStep(dir: number): void {
      const target =
        dir > 0
          ? ZOOM_STEPS.find((s) => s > zoom + 0.001) || MAX_ZOOM
          : [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001) || MIN_ZOOM;
      setZoom(target, 'manual');
    }

    function goToPage(n: number): void {
      const idx = clamp(Math.round(n), 1, pageCount()) - 1;
      scrollEl.scrollTop = Math.max(0, pages[idx].el.offsetTop - 8);
    }

    function updateCurrentPage(): void {
      const y = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
      let found = 1;
      for (let i = 0; i < pages.length; i += 1) {
        if (pages[i].el.offsetTop <= y) {
          found = i + 1;
        } else {
          break;
        }
      }
      if (found !== currentPage) {
        currentPage = found;
        updateUi();
        callbacks.onChange();
      }
    }

    // ---- history ----
    function afterHistory(): void {
      if (selectedId && !edits.some((e) => e.id === selectedId)) {
        selectedId = null;
      }
      rebuildAllLive();
      syncControls();
      changed();
      if (findInput.value && !findBar.hidden) {
        runFind();
      }
    }

    function undo(): void {
      commitEdit();
      const previous = hist.undo.pop();
      if (previous === undefined) {
        return;
      }
      hist.redo.push(JSON.stringify(edits));
      edits = JSON.parse(previous) as CpPdfEdit[];
      afterHistory();
    }

    function redo(): void {
      commitEdit();
      const next = hist.redo.pop();
      if (next === undefined) {
        return;
      }
      hist.undo.push(JSON.stringify(edits));
      edits = JSON.parse(next) as CpPdfEdit[];
      afterHistory();
    }

    function deleteSelected(): void {
      const edit = selectedEdit();
      if (!edit) {
        return;
      }
      const before = JSON.stringify(edits);
      edits = edits.filter((e) => e.id !== edit.id);
      selectedId = null;
      rebuildAllLive();
      syncControls();
      commitHistory(before);
    }

    // ---- selection / styling ----
    function selectEdit(id: string | null): void {
      selectedId = id;
      pages.forEach((ps) => {
        if (ps.live) {
          editsOnPage(ps).forEach((e) => styleEls(ps, e));
        }
      });
      syncControls();
    }

    function applyStyle<K extends keyof CpPdfStyle>(prop: K, value: CpPdfStyle[K]): void {
      const target = editing ? editing.edit : selectedEdit();
      if (!target || (target.type === 'whiteout' && prop !== 'bg')) {
        if (!target) {
          setStyle(defaults, prop, value);
          syncControls();
        }
        return;
      }
      if (prop !== 'bg' && !hasBox(target)) {
        return;
      }
      const before = JSON.stringify(edits);
      setStyle(target, prop, value);
      if (target.type === 'add' && prop in defaults) {
        setStyle(defaults, prop, value);
      }
      fitRect(target);
      const ps = pages[target.page];
      if (ps && ps.live) {
        styleEls(ps, target);
      }
      syncControls();
      if (!editing) {
        commitHistory(before);
      }
    }

    fontSel.addEventListener('change', () => {
      if (isFontKey(fontSel.value)) {
        applyStyle('fontKey', fontSel.value);
      }
    });
    sizeInput.addEventListener('input', () => {
      const v = parseFloat(sizeInput.value);
      if (Number.isFinite(v) && v >= MIN_FONT && v <= MAX_FONT) {
        applyStyle('fontSize', v);
      }
    });
    colorInput.addEventListener('input', () => applyStyle('color', fromHex(colorInput.value)));
    fillInput.addEventListener('input', () => applyStyle('bg', fromHex(fillInput.value)));
    pageInput.addEventListener('change', () => {
      const n = parseInt(pageInput.value, 10);
      if (Number.isFinite(n)) {
        goToPage(n);
      }
    });
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        pageInput.dispatchEvent(new Event('change'));
        root.focus({ preventScroll: true });
      }
    });

    function setTool(tool: string): void {
      commitEdit();
      root.dataset.tool = tool;
      updateUi();
    }

    // ---- sampling ----
    function sampleColors(ps: CpPdfPageState, rect: CpPdfRect): CpPdfSampledColors {
      const out: CpPdfSampledColors = { fg: [0, 0, 0], bg: [1, 1, 1] };
      if (!ps.canvas) {
        return out;
      }
      const sc = ps.canvas.width / ps.w;
      const x0 = clamp(Math.floor(rect[0] * sc), 0, ps.canvas.width - 1);
      const y0 = clamp(Math.floor(rect[1] * sc), 0, ps.canvas.height - 1);
      const w = clamp(Math.ceil(rect[2] * sc), 1, ps.canvas.width - x0);
      const h = clamp(Math.ceil(rect[3] * sc), 1, ps.canvas.height - y0);
      let data: Uint8ClampedArray;
      try {
        const context = ps.canvas.getContext('2d');
        if (!context) {
          throw new Error('A 2D canvas context is not available.');
        }
        data = context.getImageData(x0, y0, w, h).data;
      } catch (err) {
        callbacks.onStatus(`Could not sample page colours: ${errText(err)}`);
        return out;
      }
      const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
      const px = (x: number, y: number): number => (y * w + x) * 4;
      const consider = (x: number, y: number): void => {
        const i = px(x, y);
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const b = buckets.get(key);
        if (b) {
          b.n += 1;
        } else {
          buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
        }
      };
      for (let x = 0; x < w; x += 1) {
        consider(x, 0);
        consider(x, h - 1);
      }
      for (let y = 1; y < h - 1; y += 1) {
        consider(0, y);
        consider(w - 1, y);
      }
      let best: { n: number; r: number; g: number; b: number } | null = null;
      buckets.forEach((b) => {
        if (!best || b.n > best.n) {
          best = b;
        }
      });
      if (!best) {
        return out;
      }
      const dominant: { n: number; r: number; g: number; b: number } = best;
      out.bg = [dominant.r / 255, dominant.g / 255, dominant.b / 255];
      let far: CpPdfColor | null = null;
      let farDist = 0;
      for (let i = 0; i < data.length; i += 4) {
        const d = Math.abs(data[i] - dominant.r) + Math.abs(data[i + 1] - dominant.g) + Math.abs(data[i + 2] - dominant.b);
        if (d > farDist) {
          farDist = d;
          far = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
        }
      }
      if (far && farDist >= 96) {
        out.fg = far;
      } else {
        const lum = 0.299 * out.bg[0] + 0.587 * out.bg[1] + 0.114 * out.bg[2];
        out.fg = lum > 0.5 ? [0, 0, 0] : [1, 1, 1];
      }
      return out;
    }

    function runStyle(
      ps: CpPdfPageState,
      run: CpPdfRun,
    ): { fontKey: CpPdfFontKey; bold: boolean; italic: boolean } {
      let name = '';
      let bold = false;
      let italic = false;
      let mono = run.family === 'monospace';
      let serif = run.family === 'serif';
      try {
        if (ps.page.commonObjs.has(run.fontName)) {
          const f: CpPdfFontObject | null = ps.page.commonObjs.get(run.fontName);
          name = String((f && f.name) || '');
          bold = !!(f && (f.bold || f.black));
          italic = !!(f && f.italic);
          mono = mono || !!(f && f.isMonospace);
          serif = serif || !!(f && f.isSerifFont);
        }
      } catch (err) {
        // The font object is only a hint; fall back to the generic family and name heuristics.
        name = '';
      }
      bold = bold || /bold|black|heavy|semibold|demi/i.test(name);
      italic = italic || /italic|oblique/i.test(name);
      mono = mono || /courier|mono|consolas/i.test(name);
      serif = serif || (/times|serif|georgia|garamond|palatino|minion|bookman|cambria/i.test(name) && !/sans/i.test(name));
      return { fontKey: mono ? 'Courier' : serif ? 'Times' : 'Helvetica', bold, italic };
    }

    // ---- text editing ----
    function startReplace(ps: CpPdfPageState, run: CpPdfRun): void {
      if (run.rot || readOnly) {
        return;
      }
      const style = runStyle(ps, run);
      const colors = sampleColors(ps, [run.x, run.y, run.w, run.h]);
      const edit: CpPdfReplaceEdit = {
        id: newId(),
        page: ps.index,
        type: 'replace',
        rect: [run.x, run.y, run.w, run.h],
        origRect: [run.x, run.y, run.w, run.h],
        text: run.str,
        fontSize: round1(run.fs),
        fontKey: style.fontKey,
        bold: style.bold,
        italic: style.italic,
        color: colors.fg,
        bg: colors.bg,
      };
      startEditing(ps, edit, true);
    }

    function startEditing(ps: CpPdfPageState, edit: CpPdfTextEdit, isNew: boolean): void {
      commitEdit();
      selectedId = edit.id;
      const els = ensureEls(ps, edit);
      const box = els.box;
      if (!box) {
        return;
      }
      editing = { ps, edit, isNew, before: JSON.stringify(edits), pristine: JSON.stringify(edit), box };
      box.textContent = edit.text || '';
      box.setAttribute('contenteditable', 'plaintext-only');
      box.classList.add('editing');
      styleEls(ps, edit);
      buildRunLayer(ps);
      box.focus({ preventScroll: true });
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      syncControls();
      updateUi();
    }

    function onBoxInput(id: string): void {
      if (!editing || editing.edit.id !== id) {
        return;
      }
      editing.edit.text = editing.box.textContent ?? '';
      fitRect(editing.edit);
      styleEls(editing.ps, editing.edit);
    }

    function onBoxKeyDown(e: KeyboardEvent, id: string): void {
      if (!editing || editing.edit.id !== id) {
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          document.execCommand('insertText', false, '\n');
        } else {
          commitEdit();
          root.focus({ preventScroll: true });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
        root.focus({ preventScroll: true });
      }
    }

    /** True when a new replace edit still equals its freshly sampled original. */
    function isUnchanged(edit: CpPdfTextEdit, pristineJson: string): boolean {
      const p = JSON.parse(pristineJson) as CpPdfTextEdit;
      const keys: (keyof CpPdfStyle | 'text')[] = ['text', 'fontSize', 'fontKey', 'bold', 'italic', 'color', 'bg'];
      return (
        edit.type === 'replace' &&
        keys.every((k) => JSON.stringify(edit[k]) === JSON.stringify(p[k])) &&
        edit.rect[0] === p.rect[0] &&
        edit.rect[1] === p.rect[1]
      );
    }

    function commitEdit(): void {
      if (!editing) {
        return;
      }
      const { ps, edit, isNew, before, pristine, box } = editing;
      editing = null;
      box.removeAttribute('contenteditable');
      box.classList.remove('editing');
      edit.text = normalizeText(box.textContent ?? '');
      fitRect(edit);
      let keep = true;
      if (isNew) {
        if (edit.type === 'add' && edit.text.trim() === '') {
          keep = false;
        } else if (isUnchanged(edit, pristine)) {
          keep = false;
        } else {
          edits.push(edit);
        }
      }
      if (!keep) {
        selectedId = null;
      }
      buildLayer(ps);
      syncControls();
      commitHistory(before);
      updateUi();
    }

    function cancelEdit(): void {
      if (!editing) {
        return;
      }
      const { ps, edit, isNew, before, box } = editing;
      editing = null;
      box.removeAttribute('contenteditable');
      box.classList.remove('editing');
      if (isNew) {
        selectedId = null;
      } else {
        const saved = (JSON.parse(before) as CpPdfEdit[]).find((x) => x.id === edit.id);
        if (saved) {
          Object.assign(edit, saved);
        }
      }
      buildLayer(ps);
      syncControls();
      updateUi();
    }

    function pagePoint(ps: CpPdfPageState, e: MouseEvent): { x: number; y: number } {
      const r = ps.el.getBoundingClientRect();
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
    }

    function addTextAt(ps: CpPdfPageState, e: MouseEvent): void {
      const p = pagePoint(ps, e);
      const fs = defaults.fontSize;
      const edit: CpPdfAddEdit = {
        id: newId(),
        page: ps.index,
        type: 'add',
        rect: [p.x, p.y - (LINE * fs) / 2, fs, LINE * fs],
        text: '',
        fontSize: fs,
        fontKey: defaults.fontKey,
        bold: defaults.bold,
        italic: defaults.italic,
        color: copyColor(defaults.color),
        bg: [1, 1, 1],
      };
      fitRect(edit);
      startEditing(ps, edit, true);
    }

    function beginRubber(ps: CpPdfPageState, e: MouseEvent): void {
      const start = pagePoint(ps, e);
      const band = el('div', 'cp-pdf-rubber');
      ps.boxLayer.append(band);
      const rectOf = (p: { x: number; y: number }): CpPdfRect => [
        Math.min(start.x, p.x),
        Math.min(start.y, p.y),
        Math.abs(p.x - start.x),
        Math.abs(p.y - start.y),
      ];
      const onMove = (ev: MouseEvent): void => {
        const r = rectOf(pagePoint(ps, ev));
        band.style.left = `${r[0] * zoom}px`;
        band.style.top = `${r[1] * zoom}px`;
        band.style.width = `${r[2] * zoom}px`;
        band.style.height = `${r[3] * zoom}px`;
      };
      const onUp = (ev: MouseEvent): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        band.remove();
        const r = rectOf(pagePoint(ps, ev));
        if (r[2] * zoom < DRAG_THRESHOLD || r[3] * zoom < DRAG_THRESHOLD) {
          return;
        }
        const before = JSON.stringify(edits);
        const edit: CpPdfWhiteoutEdit = {
          id: newId(),
          page: ps.index,
          type: 'whiteout',
          rect: r,
          bg: sampleColors(ps, r).bg,
        };
        edits.push(edit);
        selectedId = edit.id;
        buildLayer(ps);
        syncControls();
        commitHistory(before);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function beginDrag(e: MouseEvent, ps: CpPdfPageState, edit: CpPdfEdit, mode: 'move' | 'resize'): void {
      const startX = e.clientX;
      const startY = e.clientY;
      const orig = copyRect(edit.rect);
      const before = JSON.stringify(edits);
      let moved = false;
      const onMove = (ev: MouseEvent): void => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) {
          return;
        }
        moved = true;
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (mode === 'move') {
          edit.rect[0] = clamp(orig[0] + dx, -orig[2] + 10, ps.w - 10);
          edit.rect[1] = clamp(orig[1] + dy, -orig[3] + 10, ps.h - 10);
        } else if (hasBox(edit)) {
          edit.fontSize = clamp(Math.round((fs0 * (orig[3] + dy)) / orig[3]), MIN_FONT, MAX_FONT);
          fitRect(edit);
        } else {
          edit.rect[2] = Math.max(4, orig[2] + dx);
          edit.rect[3] = Math.max(4, orig[3] + dy);
        }
        styleEls(ps, edit);
      };
      const fs0 = hasBox(edit) ? edit.fontSize : 0;
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (moved) {
          syncControls();
          commitHistory(before);
        } else if (mode === 'move' && hasBox(edit)) {
          startEditing(ps, edit, false);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function onMouseDown(e: MouseEvent): void {
      if (e.button !== 0) {
        return;
      }
      const t = e.target as Element;
      if (editing && editing.box.contains(t)) {
        return;
      }
      const pageEl = t.closest<HTMLElement>('.cp-pdf-page');
      const editEl = t.closest<HTMLElement>('[data-edit]');
      const runEl = t.closest('.cp-pdf-run');
      const handleEl = editEl && editEl.dataset.handle === '1';
      const run = runEl ? runOfEl.get(runEl) : null;
      const editId = editEl ? editEl.dataset.edit : null;
      commitEdit();
      if (readOnly || !pageEl) {
        return;
      }
      const ps = pages[Number(pageEl.dataset.index)];
      if (editId) {
        const edit = lookupEdit(editId);
        if (edit) {
          e.preventDefault();
          selectEdit(edit.id);
          beginDrag(e, ps, edit, handleEl ? 'resize' : 'move');
        }
        return;
      }
      selectEdit(null);
      const tool = root.dataset.tool;
      if (run && tool === 'edit') {
        const sx = e.clientX;
        const sy = e.clientY;
        const onUp = (ev: MouseEvent): void => {
          document.removeEventListener('mouseup', onUp);
          const selected = window.getSelection()?.toString();
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD && !selected) {
            startReplace(ps, run);
          }
        };
        document.addEventListener('mouseup', onUp);
      } else if (tool === 'add') {
        e.preventDefault();
        addTextAt(ps, e);
      } else if (tool === 'whiteout') {
        e.preventDefault();
        beginRubber(ps, e);
      }
    }
    scrollEl.addEventListener('mousedown', onMouseDown);
    toolbar.addEventListener('mousedown', (e) => {
      if (editing && !(e.target as Element).closest('.cp-pdf-input, .cp-pdf-color')) {
        e.preventDefault();
      }
    });

    scrollEl.addEventListener('scroll', () => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (!disposed) {
            updateCurrentPage();
          }
        });
      }
    });
    scrollEl.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 'manual');
        }
      },
      { passive: false },
    );

    root.addEventListener('keydown', (e) => {
      const tag = (e.target as Element).tagName;
      const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (editing && editing.box.contains(e.target as Node)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (inField) {
        return;
      }
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (mod && key === 'y') {
        e.preventDefault();
        redo();
      } else if (!mod && (key === 'delete' || key === 'backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
      } else if (key === 'escape') {
        selectEdit(null);
      } else if (!mod && (key === '+' || key === '=')) {
        zoomStep(1);
      } else if (!mod && (key === '-' || key === '_')) {
        zoomStep(-1);
      }
    });

    // ---- find ----
    async function runFind(): Promise<void> {
      findToken += 1;
      const token = findToken;
      const q = findCase ? findInput.value : findInput.value.toLowerCase();
      matches = [];
      findIndex = -1;
      if (!q) {
        findCount.textContent = '';
        pages.forEach((ps) => renderHits(ps));
        return;
      }
      findCount.textContent = 'Searching...';
      for (const ps of pages) {
        const runs = await loadRuns(ps);
        if (token !== findToken || disposed) {
          return;
        }
        for (const run of runs) {
          if (isRunHidden(ps, run)) {
            continue;
          }
          const hay = findCase ? run.str : run.str.toLowerCase();
          let at = hay.indexOf(q);
          while (at !== -1) {
            matches.push({ ps, run, start: at, len: q.length });
            at = hay.indexOf(q, at + q.length);
          }
        }
      }
      findIndex = matches.length ? 0 : -1;
      showMatch();
    }

    function showMatch(): void {
      findCount.textContent = matches.length ? `${findIndex + 1} / ${matches.length}` : 'No matches';
      pages.forEach((ps) => {
        if (ps.live) {
          renderHits(ps);
        }
      });
      const m = matches[findIndex];
      if (m) {
        scrollEl.scrollTop = Math.max(0, m.ps.el.offsetTop + m.run.y * zoom - scrollEl.clientHeight / 3);
      }
    }

    function stepFind(dir: number): void {
      if (!matches.length) {
        return;
      }
      findIndex = (findIndex + dir + matches.length) % matches.length;
      showMatch();
    }

    function closeFind(): void {
      findToken += 1;
      findBar.hidden = true;
      matches = [];
      findIndex = -1;
      pages.forEach((ps) => renderHits(ps));
      root.focus({ preventScroll: true });
    }

    let findTimer: number | undefined;
    findInput.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(runFind, 150);
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
      }
    });
    findBar.hidden = true;

    // ---- saving ----
    async function buildOutput(): Promise<Uint8Array> {
      const lib = await loadPdfLib();
      const { PDFDocument, StandardFonts, rgb, degrees } = lib;
      let pdfDoc: Awaited<ReturnType<typeof PDFDocument.load>>;
      try {
        pdfDoc = await PDFDocument.load(baseBytes, { updateMetadata: false, password: '' });
      } catch (err) {
        throw new Error(`The PDF could not be prepared for saving: ${errText(err)}`, {
          cause: err,
        });
      }
      const pdfPages = pdfDoc.getPages();
      const fontCache = new Map<string, CpPdfLibFont>();
      let fontkitReady = false;
      let usedFallback = false;
      const missing = new Set<string>();

      const embedStandard = async (name: CpPdfLibStandardFont): Promise<CpPdfLibFont> => {
        let font = fontCache.get(name);
        if (!font) {
          font = await pdfDoc.embedFont(StandardFonts[name]);
          fontCache.set(name, font);
        }
        return font;
      };
      const embedLiberation = async (bold: boolean, italic: boolean): Promise<CpPdfLibFont> => {
        const style = LIBERATION_FILES[(bold ? 1 : 0) + (italic ? 2 : 0)];
        const key = `Liberation${style}`;
        let font = fontCache.get(key);
        if (!font) {
          if (!fontkitReady) {
            pdfDoc.registerFontkit(await loadFontkit());
            fontkitReady = true;
          }
          const data = await registry.util.fetchBytes(
            registry.util.nodeModulesUrl(`pdfjs-dist/standard_fonts/LiberationSans-${style}.ttf`),
          );
          font = await pdfDoc.embedFont(data, { subset: true });
          fontCache.set(key, font);
        }
        return font;
      };
      const covers = (font: CpPdfLibFont, text: string): string[] => {
        const set = new Set(font.getCharacterSet());
        const absent: string[] = [];
        for (const ch of text) {
          if (ch !== '\n' && !set.has(ch.codePointAt(0) ?? 0)) {
            absent.push(ch);
          }
        }
        return absent;
      };
      const pickFont = async (edit: CpPdfTextEdit, text: string): Promise<CpPdfLibFont> => {
        const idx = (edit.bold ? 1 : 0) + (edit.italic ? 2 : 0);
        if (edit.fontKey !== 'Liberation') {
          const std = await embedStandard(STANDARD_NAMES[edit.fontKey][idx]);
          if (covers(std, text).length === 0) {
            return std;
          }
        }
        usedFallback = true;
        const lib2 = await embedLiberation(edit.bold, edit.italic);
        covers(lib2, text).forEach((ch) => missing.add(ch));
        return lib2;
      };

      const toPdf = (ps: CpPdfPageState, x: number, y: number): number[] => ps.vp.convertToPdfPoint(x, y);

      // Pass 1: covers (rendered below all text, like the on-screen layers).
      edits.forEach((edit) => {
        if (edit.type === 'add') {
          return;
        }
        const ps = pages[edit.page];
        const page = pdfPages[edit.page];
        if (!ps || !page) {
          throw new Error(`Page ${edit.page + 1} no longer exists in this PDF.`);
        }
        const r = patchRect(edit);
        if (!r) {
          return;
        }
        const a = toPdf(ps, r[0] - COVER_PAD, r[1] - COVER_PAD);
        const b = toPdf(ps, r[0] + r[2] + COVER_PAD, r[1] + r[3] + COVER_PAD);
        page.drawRectangle({
          x: Math.min(a[0], b[0]),
          y: Math.min(a[1], b[1]),
          width: Math.abs(b[0] - a[0]),
          height: Math.abs(b[1] - a[1]),
          color: rgb(edit.bg[0], edit.bg[1], edit.bg[2]),
          borderWidth: 0,
        });
      });

      // Pass 2: text.
      for (const edit of edits) {
        if (!hasBox(edit)) {
          continue;
        }
        const text = normalizeText(edit.text || '');
        if (text.trim() === '') {
          continue;
        }
        const ps = pages[edit.page];
        const page = pdfPages[edit.page];
        const font = await pickFont(edit, text);
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (line === '') {
            return;
          }
          const pt = toPdf(ps, edit.rect[0], edit.rect[1] + ASCENT * edit.fontSize + i * LINE * edit.fontSize);
          const opts: CpPdfLibDrawTextOptions = {
            x: pt[0],
            y: pt[1],
            size: edit.fontSize,
            font,
            color: rgb(edit.color[0], edit.color[1], edit.color[2]),
          };
          if (ps.vp.rotation) {
            opts.rotate = degrees(ps.vp.rotation);
          }
          page.drawText(line, opts);
        });
      }

      if (missing.size) {
        throw new Error(
          `Cannot save: these characters are not supported by the available fonts: ${[...missing].join(' ')}. ` +
            'Remove them (the boxes outlined in red) and save again.',
        );
      }
      const out = await pdfDoc.save({ useObjectStreams: true });
      if (usedFallback) {
        callbacks.onStatus('Some edited text uses a substitute font (Liberation Sans) because the standard font lacks those characters.');
      }
      return out;
    }

    async function swapDocument(newBytes: Uint8Array): Promise<void> {
      const next = await openDocument(pdfjs, newBytes.slice());
      let nextProxies: CpPdfJsPage[];
      try {
        nextProxies = [];
        for (let i = 1; i <= next.doc.numPages; i += 1) {
          nextProxies.push(await next.doc.getPage(i));
        }
      } catch (err) {
        next.task.destroy();
        throw err;
      }
      if (disposed || JSON.stringify(edits) !== savedJson) {
        next.task.destroy();
        return;
      }
      const top = scrollEl.scrollTop;
      const old = handle;
      handle = next;
      proxies = nextProxies;
      baseBytes = newBytes;
      edits = [];
      hist = { undo: [], redo: [] };
      savedJson = '[]';
      selectedId = null;
      matches = [];
      findIndex = -1;
      buildPages();
      scrollEl.scrollTop = top;
      old.task.destroy();
      syncControls();
      changed();
    }

    // ---- the View ----
    const view: PdfView = {
      kind: 'pdf',
      readOnly,
      saveMode: 'saveAs',
      saveFilters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultSaveName: `${baseName} (edited).pdf`,

      /**
       * Applies all edits to a copy of the original PDF and returns the new document.
       * @param ext Target extension; only 'pdf' is supported.
       * @returns The new PDF bytes (the original is never mutated).
       * @throws {Error} When view-only, on unsupported characters, or when writing fails.
       */
      async getBytes(ext: string): Promise<Uint8Array> {
        if (String(ext).toLowerCase() !== 'pdf') {
          throw new Error('PDF files can only be saved as .pdf.');
        }
        if (readOnly) {
          throw new Error('This PDF is view-only.');
        }
        commitEdit();
        const snapshot = JSON.stringify(edits);
        const out = await buildOutput();
        lastOutput = { bytes: out, snapshot };
        return out;
      },

      /** @returns True when the edit list differs from the last saved state. */
      isDirty(): boolean {
        return JSON.stringify(edits) !== savedJson;
      },

      /** Marks the current edits as saved and rebases onto the written copy. */
      markSaved(): void {
        savedJson = JSON.stringify(edits);
        if (lastOutput && lastOutput.snapshot === savedJson) {
          const { bytes: written } = lastOutput;
          lastOutput = null;
          swapDocument(written).catch((err: unknown) => {
            callbacks.onStatus(`Saved, but the view could not be refreshed: ${errText(err)}`);
          });
        }
        updateUi();
      },

      /**
       * Snapshot of unsaved edits (never rendered pixels).
       * @returns {edits, page, zoom} or null when clean.
       */
      async getSessionState(): Promise<CpPdfSessionState | null> {
        commitEdit();
        if (!view.isDirty()) {
          return null;
        }
        return { edits: JSON.parse(JSON.stringify(edits)) as CpPdfEdit[], page: currentPage, zoom };
      },

      /** @returns Text for the status bar. */
      getStatusText: status,

      /** Recomputes sizes after the host becomes visible or resizes. */
      layout(): void {
        if (disposed || scrollEl.clientWidth === 0) {
          return;
        }
        if (zoomMode === 'fit') {
          setZoom(computeFit(), 'fit');
        }
        if (pendingPage !== null) {
          const n = pendingPage;
          pendingPage = null;
          goToPage(n);
        }
        updateCurrentPage();
      },

      /** Focuses the view. */
      focus(): void {
        root.focus({ preventScroll: true });
      },

      /** Opens the find bar (Ctrl+F). */
      find(): void {
        findBar.hidden = false;
        findInput.focus();
        findInput.select();
      },

      /** Releases workers, canvases and listeners. */
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        findToken += 1;
        clearTimeout(findTimer);
        editing = null;
        if (observer) {
          observer.disconnect();
        }
        pages.forEach((ps) => {
          ps.renderToken += 1;
          if (ps.renderTask) {
            ps.renderTask.cancel();
          }
          if (ps.canvas) {
            ps.canvas.width = 0;
            ps.canvas.height = 0;
          }
        });
        root.remove();
        pages = [];
        handle.task.destroy();
      },
    };

    buildPages();
    syncControls();
    updateUi();
    return view;
  }

  registry.register('pdf', { extensions: ['.pdf'], create });
})();
