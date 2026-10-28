/*
 * DOCX editor view for CodePad.
 *
 * Opens a .docx with mammoth (docx -> HTML), sanitizes the HTML with an allow-list rebuild, edits it in a
 * contenteditable surface and writes it back with the `docx` library. The module never performs I/O: it receives
 * bytes and returns bytes through the View contract (see .claude/plans/binary-formats-design.md, section B.3).
 *
 * Known simplifications (the document is re-created on save, not patched):
 * - Lost or simplified: headers/footers, footnotes, comments, tracked changes, text boxes, shapes, columns, page
 *   setup, custom styles and fonts, highlight, line spacing, cell shading and widths, equations, fields.
 * - Kept: headings 1-6, paragraphs, bold/italic/underline/strike/sub/superscript, text colour and size, alignment,
 *   nested bullet/numbered lists, tables (colspan/rowspan), inline PNG/JPEG/GIF images, http/https/mailto links.
 * - "Quote" and "Indent" are the same construct (blockquote = one indent level of 0.5 inch).
 * - Table row/column commands use cell indexes and ignore merged cells; they bypass the browser undo stack.
 * - Dropping content onto the page inserts it as sanitized text/HTML (a copy, never a move).
 * - document.execCommand is deprecated but still shipped by Chromium/Electron.
 */

(() => {
  type DocxLib = DocxModule;
  type DocxParagraph = import('../../../node_modules/docx/dist/index').Paragraph;
  type DocxTable = import('../../../node_modules/docx/dist/index').Table;
  type DocxParagraphOptions = import('../../../node_modules/docx/dist/index').IParagraphOptions;
  type DocxTableCellOptions = import('../../../node_modules/docx/dist/index').ITableCellOptions;
  type DocxRunOptions = import('../../../node_modules/docx/dist/index').IRunOptions;
  type DocxParagraphChild = import('../../../node_modules/docx/dist/index').ParagraphChild;
  type DocxBlock = DocxParagraph | DocxTable;
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };

  /** Formatting we understand from an element's inline style. */
  interface StyleInfo {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    color?: string | null;
    size?: number | null;
    align?: string | null;
  }

  /** Sanitizer recursion context. */
  interface SanitizeCtx {
    state: { count: number };
    depth: number;
    align: string | null;
  }

  /** Inherited run formatting while converting DOM to docx. */
  interface Fmt {
    bold?: boolean;
    italics?: boolean;
    underline?: boolean;
    strike?: boolean;
    sub?: boolean;
    sup?: boolean;
    font?: string;
    color?: string;
    size?: number;
  }

  interface TextItem { t: 'text'; text: string; fmt: Fmt; pre: boolean }
  interface BreakItem { t: 'br' }
  interface ImageItem { t: 'img'; el: Element }
  interface LinkItem { t: 'link'; href: string | null; items: InlineItem[] }
  type InlineItem = TextItem | BreakItem | ImageItem | LinkItem;

  interface ImageSize { width: number; height: number }

  interface BlockCtx { indent: number; fmt: Fmt }

  interface NodeParent { readonly childNodes: ArrayLike<Node> }

  interface DialogField {
    name: string;
    label: string;
    value: string;
    type?: string;
    min?: number;
    max?: number;
  }

  interface DialogSpec {
    title: string;
    fields: DialogField[];
    submit: string;
    extra?: { name: string; label: string } | null;
  }

  interface DialogResult {
    action: string;
    values?: Record<string, string>;
  }

  interface FindMatch { node: Node; index: number }

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_SESSION_HTML = 14 * 1024 * 1024;
  const MAX_NODES = 600000;
  const MAX_DEPTH = 64;
  const BASE_FONT = 'Calibri';
  const MONO_FONT = 'Consolas';

  const LIBS = {
    mammoth: 'mammoth/mammoth.browser.min.js',
    docx: 'docx/dist/index.iife.js',
  };

  const STYLE_MAP = [
    "p[style-name='Title'] => h1.title:fresh",
    "p[style-name='Subtitle'] => h2:fresh",
  ];

  const DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'head', 'title',
    'meta', 'link', 'textarea', 'select', 'option', 'button', 'form', 'input', 'audio', 'video', 'canvas',
    'applet', 'frame', 'frameset', 'base', 'colgroup', 'col', 'caption', 'hr',
  ]);
  const INLINE_FORMAT: Record<string, string> = {
    b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', sub: 'sub', sup: 'sup',
    code: 'code',
  };
  const BLOCK_SIMPLE = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
    'tfoot', 'tr', 'td', 'th',
  ]);
  const BLOCKISH = new Set([
    'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'center',
    'address', 'dl', 'dd', 'dt', 'details', 'summary', 'fieldset',
  ]);
  const ALIGNABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th']);
  const ROOT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'table']);
  const ALIGNS = new Set(['left', 'center', 'right', 'justify']);
  const IMAGE_SRC = /^data:image\/(png|jpe?g|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];
  const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
  const BLOCK_STYLES: [string, string][] = [
    ['p', 'Normal'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'],
    ['h5', 'Heading 5'], ['h6', 'Heading 6'], ['blockquote', 'Quote'],
  ];

  const utilOf = () => window.CodePadEditors.util;

  /** Message of a caught value. */
  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** The element, or the parent element of a non-element node, or null. */
  function elementOf(node: Node | null): Element | null {
    if (!node) return null;
    return node instanceof Element ? node : node.parentElement;
  }

  /** Inline text-align of an element, '' when unavailable. */
  function textAlignOf(el: Element): string {
    return el instanceof HTMLElement ? el.style.textAlign : '';
  }

  function tagOf(node: Node): string {
    return node instanceof Element ? node.localName : '';
  }

  // ---------------------------------------------------------------------------------------------
  // Library loading (single place to swap library versions)
  // ---------------------------------------------------------------------------------------------

  /**
   * Lazily loads mammoth and/or docx.
   * @param which Libraries needed.
   * @returns Resolves when the requested globals exist.
   * @throws {Error} When a library cannot be loaded.
   */
  async function loadLibs(which: { mammoth?: boolean; docx?: boolean }): Promise<void> {
    const util = utilOf();
    if (which.mammoth && !window.mammoth) {
      await util.loadScript(util.nodeModulesUrl(LIBS.mammoth));
      if (!window.mammoth) throw new Error('The Word reader library (mammoth) failed to load.');
    }
    if (which.docx && !window.docx) {
      await util.loadScript(util.nodeModulesUrl(LIBS.docx));
      if (!window.docx) throw new Error('The Word writer library (docx) failed to load.');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sanitizer: rebuilds untrusted HTML with an allow-list of elements, attributes and style values
  // ---------------------------------------------------------------------------------------------

  /**
   * Converts a CSS colour (hex or rgb) to a lowercase 6-digit hex string without '#'.
   * @param value CSS colour text.
   * @returns Hex digits, or null when unsupported or plain black.
   */
  function toHexColor(value: string | null | undefined): string | null {
    const v = String(value || '').trim().toLowerCase();
    let hex: string | null = null;
    let m = /^#([0-9a-f]{6})$/.exec(v);
    if (m) {
      hex = m[1];
    } else if ((m = /^#([0-9a-f]{3})$/.exec(v))) {
      hex = m[1].split('').map((c) => c + c).join('');
    } else if ((m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(v))) {
      const rgb = m;
      hex = [1, 2, 3].map((i) => Math.min(255, Number(rgb[i])).toString(16).padStart(2, '0')).join('');
    }
    return hex && hex !== '000000' ? hex : null;
  }

  /**
   * Parses a CSS length in pt or px into points.
   * @param value CSS length.
   * @returns Points (6-96, half-point steps) or null.
   */
  function toPoints(value: string | null | undefined): number | null {
    const m = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(String(value || '').trim().toLowerCase());
    if (!m) return null;
    const pt = Math.round(parseFloat(m[1]) * (m[2] === 'px' ? 0.75 : 1) * 2) / 2;
    return pt >= 6 && pt <= 96 ? pt : null;
  }

  /**
   * Validates a link target.
   * @param value Raw href.
   * @returns Normalized absolute URL, or null when the scheme is not http/https/mailto.
   */
  function safeHref(value: string | null): string | null {
    if (!value) return null;
    try {
      const url = new URL(String(value).trim());
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Reads the formatting we understand from an element's inline style.
   * @param el Source element.
   * @returns Parsed bold/italic/underline/strike/color/size/align values.
   */
  function readStyle(el: Element): StyleInfo {
    const st = el instanceof HTMLElement ? el.style : null;
    if (!st) return {};
    const weight = st.fontWeight;
    const deco = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
    const align = (st.textAlign || el.getAttribute('align') || '').toLowerCase();
    return {
      bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
      italic: st.fontStyle === 'italic' || st.fontStyle === 'oblique',
      underline: deco.includes('underline'),
      strike: deco.includes('line-through'),
      color: toHexColor(st.color),
      size: toPoints(st.fontSize),
      align: ALIGNS.has(align) ? align : null,
    };
  }

  function hasBlockChild(el: Element): boolean {
    return Array.from(el.children).some((c) => BLOCK_SIMPLE.has(c.localName) || BLOCKISH.has(c.localName));
  }

  function sanitizeChildren(src: Node, dest: HTMLElement, ctx: SanitizeCtx): void {
    for (const node of Array.from(src.childNodes)) sanitizeNode(node, dest, ctx);
  }

  function sanitizeNode(node: Node, dest: HTMLElement, ctx: SanitizeCtx): void {
    ctx.state.count += 1;
    if (ctx.state.count > MAX_NODES) throw new Error('The document is too large or complex to edit.');
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(document.createTextNode(node.nodeValue ?? ''));
    } else if (node instanceof Element) {
      if (ctx.depth >= MAX_DEPTH) {
        dest.appendChild(document.createTextNode(node.textContent ?? ''));
      } else {
        sanitizeElement(node, dest, ctx);
      }
    }
  }

  function wrapInline(el: Element, dest: HTMLElement, info: StyleInfo, ctx: SanitizeCtx): void {
    let target: HTMLElement = dest;
    const wrap = (name: 'b' | 'i' | 'u' | 's' | 'span'): void => {
      const n = document.createElement(name);
      target.appendChild(n);
      target = n;
    };
    if (info.bold) wrap('b');
    if (info.italic) wrap('i');
    if (info.underline) wrap('u');
    if (info.strike) wrap('s');
    const color = el.localName === 'font' ? toHexColor(el.getAttribute('color')) : info.color;
    if (color || info.size) {
      wrap('span');
      if (color) target.style.color = `#${color}`;
      if (info.size) target.style.fontSize = `${info.size}pt`;
    }
    sanitizeChildren(el, target, { state: ctx.state, depth: ctx.depth + 1, align: ctx.align });
  }

  function sanitizeElement(el: Element, dest: HTMLElement, ctx: SanitizeCtx): void {
    const tag = el.localName;
    if (DROP_TAGS.has(tag)) return;
    const info = readStyle(el);
    const align = info.align || (tag === 'center' ? 'center' : ctx.align);
    const child: SanitizeCtx = { state: ctx.state, depth: ctx.depth + 1, align };

    if (INLINE_FORMAT[tag]) {
      const out = document.createElement(INLINE_FORMAT[tag]);
      dest.appendChild(out);
      sanitizeChildren(el, out, child);
    } else if (tag === 'br') {
      dest.appendChild(document.createElement('br'));
    } else if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      if (!IMAGE_SRC.test(src)) return;
      const img = document.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', (el.getAttribute('alt') || '').slice(0, 500));
      dest.appendChild(img);
    } else if (tag === 'a') {
      const href = safeHref(el.getAttribute('href'));
      if (!href) {
        sanitizeChildren(el, dest, child);
        return;
      }
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.setAttribute('rel', 'noopener noreferrer');
      dest.appendChild(a);
      sanitizeChildren(el, a, child);
    } else if (BLOCK_SIMPLE.has(tag) || BLOCKISH.has(tag)) {
      let name = tag;
      if (BLOCKISH.has(tag)) {
        if (hasBlockChild(el)) {
          sanitizeChildren(el, dest, child);
          return;
        }
        name = 'p';
      }
      const out = document.createElement(name);
      if (ALIGNABLE.has(name) && align && align !== 'left') out.style.textAlign = align;
      if (name === 'td' || name === 'th') {
        const cs = parseInt(el.getAttribute('colspan') ?? '', 10);
        const rs = parseInt(el.getAttribute('rowspan') ?? '', 10);
        if (cs > 1) out.setAttribute('colspan', String(Math.min(cs, 50)));
        if (rs > 1) out.setAttribute('rowspan', String(Math.min(rs, 100)));
      }
      dest.appendChild(out);
      sanitizeChildren(el, out, child);
    } else {
      wrapInline(el, dest, info, child);
    }
  }

  /**
   * Parses untrusted HTML in an inert document and rebuilds it with allowed elements only.
   * @param html Untrusted HTML.
   * @returns Detached container holding the sanitized nodes.
   * @throws {Error} When the document exceeds the node limit.
   */
  function sanitizeHtml(html: string): HTMLDivElement {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const out = document.createElement('div');
    sanitizeChildren(doc.body, out, { state: { count: 0 }, depth: 0, align: null });
    return out;
  }

  /**
   * Wraps loose top-level inline content in paragraphs and guarantees at least one block.
   * @param root Sanitized container, modified in place.
   */
  function normalizeRoot(root: HTMLElement): void {
    let run: HTMLParagraphElement | null = null;
    for (const node of Array.from(root.childNodes)) {
      const isBlock = node instanceof Element && ROOT_BLOCKS.has(node.localName);
      if (isBlock) {
        run = null;
      } else if (run) {
        run.appendChild(node);
      } else if (node.nodeType !== Node.TEXT_NODE || (node.nodeValue ?? '').trim()) {
        run = document.createElement('p');
        root.insertBefore(run, node);
        run.appendChild(node);
      } else {
        node.remove();
      }
    }
    if (!root.firstChild) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      root.appendChild(p);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // DOM -> docx conversion
  // ---------------------------------------------------------------------------------------------

  /**
   * Builds the converter that maps sanitized DOM to docx objects.
   * @param D The docx library namespace.
   * @param sizes Image sizes in px.
   * @param contentTwips Printable width in twips.
   * @returns Function returning section children.
   */
  function createConverter(
    D: DocxLib,
    sizes: Map<Element, ImageSize>,
    contentTwips: number,
  ): (root: HTMLElement) => DocxBlock[] {
    type Alignment = (typeof D.AlignmentType)[keyof typeof D.AlignmentType];
    type Heading = (typeof D.HeadingLevel)[keyof typeof D.HeadingLevel];
    interface Numbering { reference: string; level: number; instance: number }
    interface ParaOpts {
      heading?: Heading;
      alignment?: Alignment;
      indent?: number;
      numbering?: Numbering | null;
    }
    interface SpaceState { space: boolean; last: TextItem | null }

    const ALIGN: Record<string, Alignment> = {
      left: D.AlignmentType.LEFT, center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT,
      justify: D.AlignmentType.JUSTIFIED,
    };
    const HEADINGS: Record<string, Heading> = {
      h1: D.HeadingLevel.HEADING_1, h2: D.HeadingLevel.HEADING_2, h3: D.HeadingLevel.HEADING_3,
      h4: D.HeadingLevel.HEADING_4, h5: D.HeadingLevel.HEADING_5, h6: D.HeadingLevel.HEADING_6,
    };
    const INLINE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'li']);
    const maxImagePx = Math.floor(contentTwips / 15);
    let listInstance = 0;

    function inheritFmt(el: Element, fmt: Fmt): Fmt {
      switch (el.localName) {
        case 'b': return { ...fmt, bold: true };
        case 'i': return { ...fmt, italics: true };
        case 'u': return { ...fmt, underline: true };
        case 's': return { ...fmt, strike: true };
        case 'sub': return { ...fmt, sub: true, sup: false };
        case 'sup': return { ...fmt, sup: true, sub: false };
        case 'code': return { ...fmt, font: MONO_FONT };
        case 'span': {
          const next: Fmt = { ...fmt };
          const style = el instanceof HTMLElement ? el.style : null;
          const color = toHexColor(style?.color);
          const size = toPoints(style?.fontSize);
          if (color) next.color = color;
          if (size) next.size = Math.round(size * 2);
          return next;
        }
        default: return fmt;
      }
    }

    function collectInline(node: Node, fmt: Fmt, out: InlineItem[], pre: boolean): void {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push({ t: 'text', text: node.nodeValue ?? '', fmt, pre });
      } else if (node instanceof Element) {
        const tag = node.localName;
        if (tag === 'br') {
          out.push({ t: 'br' });
        } else if (tag === 'img') {
          out.push({ t: 'img', el: node });
        } else if (tag === 'a') {
          const items: InlineItem[] = [];
          const linkFmt: Fmt = { ...fmt, color: fmt.color || '0563C1', underline: true };
          for (const c of Array.from(node.childNodes)) collectInline(c, linkFmt, items, pre);
          out.push({ t: 'link', href: node.getAttribute('href'), items });
        } else {
          const next = inheritFmt(node, fmt);
          for (const c of Array.from(node.childNodes)) collectInline(c, next, out, pre);
        }
      }
    }

    function normalizeSpace(items: InlineItem[], state: SpaceState): () => void {
      const trimLast = (): void => {
        if (state.last && state.last.text.endsWith(' ')) state.last.text = state.last.text.slice(0, -1);
        state.last = null;
      };
      for (const it of items) {
        if (it.t === 'text' && it.pre) {
          state.space = false;
          state.last = null;
        } else if (it.t === 'text') {
          let s = it.text.replace(/[ \t\r\n\f]+/g, ' ');
          if (state.space && s.startsWith(' ')) s = s.slice(1);
          it.text = s;
          if (s) {
            state.space = s.endsWith(' ');
            state.last = it;
          }
        } else if (it.t === 'br') {
          trimLast();
          state.space = true;
        } else if (it.t === 'link') {
          normalizeSpace(it.items, state);
        } else {
          state.space = false;
          state.last = null;
        }
      }
      return trimLast;
    }

    function runProps(fmt: Fmt): Mutable<DocxRunOptions> {
      const p: Mutable<DocxRunOptions> = {};
      if (fmt.bold) p.bold = true;
      if (fmt.italics) p.italics = true;
      if (fmt.underline) p.underline = { type: D.UnderlineType.SINGLE };
      if (fmt.strike) p.strike = true;
      if (fmt.color) p.color = fmt.color;
      if (fmt.size) p.size = fmt.size;
      if (fmt.sup) p.superScript = true;
      if (fmt.sub) p.subScript = true;
      if (fmt.font) p.font = fmt.font;
      return p;
    }

    function imageRun(el: Element): InstanceType<DocxLib['ImageRun']> | null {
      const src = el.getAttribute('src') || '';
      const m = IMAGE_SRC.exec(src);
      if (!m) return null;
      const size = sizes.get(el) || { width: 300, height: 200 };
      const scale = Math.min(1, maxImagePx / size.width);
      const type = m[1].toLowerCase() === 'png' ? 'png' : m[1].toLowerCase() === 'gif' ? 'gif' : 'jpg';
      const base64 = src.slice(src.indexOf(',') + 1);
      return new D.ImageRun({
        type,
        data: utilOf().base64ToBytes(base64),
        transformation: {
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
        },
      });
    }

    function toChildren(items: InlineItem[]): DocxParagraphChild[] {
      const kids: DocxParagraphChild[] = [];
      for (const it of items) {
        if (it.t === 'text') {
          const lines = it.pre ? it.text.split(/\r?\n/) : [it.text];
          lines.forEach((line, i) => {
            if (line || i > 0) kids.push(new D.TextRun({ ...runProps(it.fmt), text: line, ...(i > 0 ? { break: 1 } : {}) }));
          });
        } else if (it.t === 'br') {
          kids.push(new D.TextRun({ break: 1 }));
        } else if (it.t === 'img') {
          const run = imageRun(it.el);
          if (run) kids.push(run);
        } else if (it.t === 'link') {
          const link = safeHref(it.href);
          const inner = toChildren(it.items);
          if (link && inner.length) kids.push(new D.ExternalHyperlink({ link, children: inner }));
          else kids.push(...inner);
        }
      }
      return kids;
    }

    function hasContent(items: InlineItem[]): boolean {
      return items.some((it) => (it.t === 'text' ? it.text.length > 0 : it.t !== 'link' || hasContent(it.items)));
    }

    function makeParagraph(items: InlineItem[], opts: ParaOpts, force: true): DocxParagraph;
    function makeParagraph(items: InlineItem[], opts: ParaOpts, force: boolean): DocxParagraph | null;
    function makeParagraph(items: InlineItem[], opts: ParaOpts, force: boolean): DocxParagraph | null {
      const trimLast = normalizeSpace(items, { space: true, last: null });
      trimLast();
      if (!force && !hasContent(items)) return null;
      const options: Mutable<DocxParagraphOptions> = { children: toChildren(items) };
      if (opts.heading) options.heading = opts.heading;
      else if (!opts.numbering) options.spacing = { after: 120 };
      if (opts.alignment) options.alignment = opts.alignment;
      if (opts.numbering) options.numbering = opts.numbering;
      else if (opts.indent) options.indent = { left: opts.indent };
      return new D.Paragraph(options);
    }

    function blockParagraph(el: Element, ctx: BlockCtx, numbering: Numbering | null): DocxParagraph {
      const items: InlineItem[] = [];
      const tag = el.localName;
      const pre = tag === 'pre';
      const fmt = pre ? { ...ctx.fmt, font: MONO_FONT } : ctx.fmt;
      for (const c of Array.from(el.childNodes)) collectInline(c, fmt, items, pre);
      return makeParagraph(items, {
        heading: HEADINGS[tag],
        alignment: ALIGN[textAlignOf(el)],
        indent: ctx.indent * 720,
        numbering,
      }, true);
    }

    function convertList(listEl: Element, ctx: BlockCtx, level: number, instance: number, out: DocxBlock[]): void {
      const ordered = listEl.localName === 'ol';
      const inst = level === 0 ? (listInstance += 1) : instance;
      const lvl = Math.min(level, 8);
      const numbering = (): Numbering => ({ reference: ordered ? 'cp-decimal' : 'cp-bullet', level: lvl, instance: inst });
      for (const li of Array.from(listEl.children)) {
        if (li.localName !== 'li') continue;
        let first = true;
        let pending: InlineItem[] = [];
        const itemCtx: BlockCtx = { ...ctx, indent: lvl + 1 };
        const flush = (): void => {
          if (!pending.length) return;
          const p = makeParagraph(pending, {
            alignment: ALIGN[textAlignOf(li)],
            indent: itemCtx.indent * 720,
            numbering: first ? numbering() : null,
          }, false);
          if (p) {
            out.push(p);
            first = false;
          }
          pending = [];
        };
        for (const c of Array.from(li.childNodes)) {
          const tag = tagOf(c);
          if (c instanceof Element && (tag === 'ul' || tag === 'ol')) {
            flush();
            convertList(c, ctx, level + 1, inst, out);
          } else if (tag === 'table' || tag === 'blockquote') {
            flush();
            convertBlocks({ childNodes: [c] }, itemCtx, out);
          } else if (c instanceof Element && INLINE_BLOCKS.has(tag)) {
            flush();
            out.push(blockParagraph(c, itemCtx, first ? numbering() : null));
            first = false;
          } else {
            collectInline(c, ctx.fmt, pending, false);
          }
        }
        flush();
        if (first && !li.querySelector('ul,ol,table')) {
          out.push(new D.Paragraph({ children: [], numbering: numbering() }));
        }
      }
    }

    function convertTable(tableEl: HTMLTableElement): DocxTable | null {
      const rows = Array.from(tableEl.rows);
      if (!rows.length) return null;
      const occ: number[] = [];
      let cols = 0;
      for (const row of rows) {
        let col = 0;
        for (const cell of Array.from(row.cells)) {
          while (occ[col] > 0) col += 1;
          const cs = Math.min(cell.colSpan || 1, 50);
          for (let c = col; c < col + cs; c += 1) occ[c] = cell.rowSpan || 1;
          col += cs;
        }
        cols = Math.max(cols, col, occ.length);
        for (let c = 0; c < occ.length; c += 1) if (occ[c] > 0) occ[c] -= 1;
      }
      if (!cols) return null;
      const colWidth = Math.floor(contentTwips / cols);
      const border = { style: D.BorderStyle.SINGLE, size: 4, color: '999999' };
      const tableRows = rows.map((row, ri) => new D.TableRow({
        children: Array.from(row.cells).map((cell) => {
          const cs = Math.min(cell.colSpan || 1, 50);
          const rs = Math.min(cell.rowSpan || 1, rows.length - ri);
          const kids: DocxBlock[] = [];
          convertBlocks(cell, { indent: 0, fmt: cell.localName === 'th' ? { bold: true } : {} }, kids);
          if (!kids.length || kids[kids.length - 1] instanceof D.Table) kids.push(new D.Paragraph({ children: [] }));
          const opts: Mutable<DocxTableCellOptions> = { children: kids, width: { size: colWidth * cs, type: D.WidthType.DXA } };
          if (cs > 1) opts.columnSpan = cs;
          if (rs > 1) opts.rowSpan = rs;
          return new D.TableCell(opts);
        }),
      }));
      return new D.Table({
        rows: tableRows,
        columnWidths: Array(cols).fill(colWidth),
        width: { size: colWidth * cols, type: D.WidthType.DXA },
        borders: {
          top: border, bottom: border, left: border, right: border,
          insideHorizontal: border, insideVertical: border,
        },
      });
    }

    function convertBlocks(parent: NodeParent, ctx: BlockCtx, out: DocxBlock[]): void {
      let pending: InlineItem[] = [];
      const flush = (): void => {
        if (!pending.length) return;
        const p = makeParagraph(pending, { indent: ctx.indent * 720 }, false);
        if (p) out.push(p);
        pending = [];
      };
      for (const c of Array.from(parent.childNodes)) {
        const tag = tagOf(c);
        if (c instanceof Element && INLINE_BLOCKS.has(tag)) {
          flush();
          out.push(blockParagraph(c, ctx, null));
        } else if (tag === 'blockquote') {
          flush();
          convertBlocks(c, { ...ctx, indent: ctx.indent + 1 }, out);
        } else if (c instanceof Element && (tag === 'ul' || tag === 'ol')) {
          flush();
          convertList(c, ctx, 0, 0, out);
        } else if (c instanceof HTMLTableElement) {
          flush();
          const t = convertTable(c);
          if (t) {
            if (out.length && out[out.length - 1] instanceof D.Table) out.push(new D.Paragraph({ children: [] }));
            out.push(t);
          }
        } else {
          collectInline(c, ctx.fmt, pending, false);
        }
      }
      flush();
    }

    return (root) => {
      const out: DocxBlock[] = [];
      convertBlocks(root, { indent: 0, fmt: {} }, out);
      if (!out.length || out[out.length - 1] instanceof D.Table) out.push(new D.Paragraph({ children: [] }));
      return out;
    };
  }

  function numberingConfig(D: DocxLib) {
    const levels = (
      format: (typeof D.LevelFormat)[keyof typeof D.LevelFormat],
      text: (level: number) => string,
    ) => Array.from({ length: 9 }, (_, level) => ({
      level,
      format,
      text: text(level),
      alignment: D.AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));
    return {
      config: [
        { reference: 'cp-bullet', levels: levels(D.LevelFormat.BULLET, () => '•') },
        { reference: 'cp-decimal', levels: levels(D.LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
      ],
    };
  }

  /**
   * Decodes every image of a detached tree so natural sizes are known.
   * @param root Sanitized container.
   * @returns Pixel sizes per <img>.
   */
  async function measureImages(root: HTMLElement): Promise<Map<Element, ImageSize>> {
    const sizes = new Map<Element, ImageSize>();
    await Promise.all(Array.from(root.querySelectorAll('img')).map(async (img) => {
      try {
        await img.decode();
      } catch (err) {
        return;
      }
      if (img.naturalWidth && img.naturalHeight) sizes.set(img, { width: img.naturalWidth, height: img.naturalHeight });
    }));
    return sizes;
  }

  /**
   * Serializes editor HTML to a .docx file.
   * @param html Editor innerHTML.
   * @returns The docx bytes.
   * @throws {Error} When the document cannot be generated.
   */
  async function htmlToDocx(html: string): Promise<Uint8Array> {
    await loadLibs({ docx: true });
    const D = window.docx;
    if (!D) throw new Error('The Word writer library (docx) failed to load.');
    const root = sanitizeHtml(html);
    const sizes = await measureImages(root);
    const letter = /^en-(US|CA)$/i.test(navigator.language || '');
    const page = letter ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 };
    const contentTwips = page.width - 2880;
    const children = createConverter(D, sizes, contentTwips)(root);
    const doc = new D.Document({
      creator: 'CodePad',
      styles: { default: { document: { run: { font: BASE_FONT, size: 22 } } } },
      numbering: numberingConfig(D),
      sections: [{
        properties: { page: { size: page, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        children,
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Reads a .docx into sanitized editor HTML.
   * @param bytes File bytes.
   * @param fileName Display name for messages.
   * @returns HTML and mammoth message count.
   * @throws {Error} When the bytes are not a readable docx.
   */
  async function docxToHtml(bytes: Uint8Array, fileName: string): Promise<{ html: string; warnings: number }> {
    const isZip = bytes instanceof Uint8Array && bytes.length >= 4 &&
      bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!isZip) throw new Error(`"${fileName}" is empty or not a valid .docx file.`);
    utilOf().checkZipLimits(bytes, fileName);
    await loadLibs({ mammoth: true });
    const mammothLib = window.mammoth;
    if (!mammothLib) throw new Error('The Word reader library (mammoth) failed to load.');
    const arrayBuffer = new Uint8Array(bytes).buffer;
    try {
      const result = await mammothLib.convertToHtml({ arrayBuffer }, { styleMap: STYLE_MAP });
      return { html: result.value, warnings: result.messages.length };
    } catch (err) {
      throw new Error(`Could not read "${fileName}" as a Word document: ${errorMessage(err)}`, { cause: err });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Editor view
  // ---------------------------------------------------------------------------------------------

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Creates the DOCX editor view.
   * @param options Create options from the glue (container, bytes, fileName, restoredState, callbacks).
   * @returns The View object.
   * @throws {Error} When the file cannot be read.
   */
  async function create(options: CodePadViewOptions): Promise<CodePadEditorView> {
    const { container, bytes, restoredState, callbacks } = options;
    const fileName = options.fileName || 'document.docx';
    const baseName = fileName.replace(/\.[^.]+$/, '') || 'document';

    // ---- Load content before touching the DOM so a failure leaves nothing behind.
    let sourceHtml: string;
    let warnings = 0;
    const restoredHtml: unknown = restoredState ? (restoredState as { html?: unknown }).html : undefined;
    const restored = typeof restoredHtml === 'string' && restoredHtml.length <= MAX_SESSION_HTML;
    if (typeof restoredHtml === 'string' && restored) {
      sourceHtml = restoredHtml;
    } else if (bytes) {
      ({ html: sourceHtml, warnings } = await docxToHtml(bytes, fileName));
    } else {
      throw new Error(`"${fileName}" has no content to open.`);
    }
    const content = sanitizeHtml(sourceHtml);
    normalizeRoot(content);

    // ---- State
    let version = 0;
    let savedVersion = restored ? -1 : 0;
    let pendingSaveVersion: number | null = null;
    let wordCache = { version: -1, count: 0 };
    let savedRange: Range | null = null;
    let disposed = false;
    const stateful: { button: HTMLButtonElement; cmd: string }[] = [];

    // ---- DOM
    const root = el('div', 'cp-docx');
    const banner = el('div', 'cp-docx-banner');
    const bannerText = el('span', 'cp-docx-banner-text',
      'CodePad re-creates the document on save. Headers, footers, text boxes, comments, tracked changes, ' +
      'page layout, fonts and colours may be simplified or removed.' +
      (warnings ? ` ${warnings} conversion warning${warnings === 1 ? '' : 's'} while opening.` : ''));
    const bannerClose = el('button', 'cp-docx-btn', '×');
    bannerClose.type = 'button';
    bannerClose.title = 'Dismiss';
    bannerClose.addEventListener('click', () => banner.remove());
    banner.append(bannerText, bannerClose);

    const toolbar = el('div', 'cp-docx-toolbar');
    const tableBar = el('div', 'cp-docx-toolbar cp-docx-tablebar');
    tableBar.hidden = true;
    const findBar = el('div', 'cp-docx-toolbar cp-docx-findbar');
    findBar.hidden = true;
    const scroller = el('div', 'cp-docx-scroll');
    const page = el('div', 'cp-docx-page');
    page.contentEditable = 'true';
    page.spellcheck = true;
    page.setAttribute('role', 'textbox');
    page.setAttribute('aria-multiline', 'true');
    page.append(...Array.from(content.childNodes));
    scroller.appendChild(page);
    root.append(banner, toolbar, tableBar, findBar, scroller);
    container.appendChild(root);

    // ---- Helpers
    function notifyChange(): void {
      version += 1;
      if (callbacks && callbacks.onChange) callbacks.onChange();
    }

    function status(text: string): void {
      if (callbacks && callbacks.onStatus) callbacks.onStatus(text);
    }

    function selectionInPage(): Selection | null {
      const sel = window.getSelection();
      return sel && sel.rangeCount && page.contains(sel.anchorNode) ? sel : null;
    }

    function focusPage(): void {
      if (document.activeElement === page) return;
      page.focus({ preventScroll: true });
      if (savedRange) {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(savedRange);
        }
      }
    }

    function exec(cmd: string, value?: string): boolean {
      focusPage();
      document.execCommand('styleWithCSS', false, 'false');
      const ok = document.execCommand(cmd, false, value);
      refreshToolbar();
      return ok;
    }

    function execCss(cmd: string, value?: string): boolean {
      focusPage();
      document.execCommand('styleWithCSS', false, 'true');
      const ok = document.execCommand(cmd, false, value);
      document.execCommand('styleWithCSS', false, 'false');
      refreshToolbar();
      return ok;
    }

    function insertNode(node: Node): void {
      const holder = document.createElement('div');
      holder.appendChild(node);
      focusPage();
      document.execCommand('insertHTML', false, holder.innerHTML);
    }

    function currentCell(): HTMLTableCellElement | null {
      const sel = selectionInPage();
      const elem = elementOf(sel && sel.anchorNode);
      const cell = elem && elem.closest<HTMLTableCellElement>('td,th');
      return cell && page.contains(cell) ? cell : null;
    }

    function currentAnchor(): HTMLAnchorElement | null {
      const sel = selectionInPage();
      const elem = elementOf(sel && sel.anchorNode);
      const a = elem && elem.closest('a');
      return a && page.contains(a) ? a : null;
    }

    function ensureContent(): void {
      if (!page.firstChild) {
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        page.appendChild(p);
      }
    }

    // ---- In-view dialog (no alert/prompt)
    function openDialog(spec: DialogSpec): Promise<DialogResult | null> {
      return new Promise<DialogResult | null>((resolve) => {
        const overlay = el('div', 'cp-docx-overlay');
        const form = el('form', 'cp-docx-dialog');
        form.appendChild(el('h3', 'cp-docx-dialog-title', spec.title));
        const inputs: Record<string, HTMLInputElement> = {};
        for (const f of spec.fields) {
          const label = el('label', 'cp-docx-field');
          label.appendChild(el('span', '', f.label));
          const input = el('input');
          input.type = f.type || 'text';
          input.value = f.value;
          if (f.min !== undefined) input.min = String(f.min);
          if (f.max !== undefined) input.max = String(f.max);
          inputs[f.name] = input;
          label.appendChild(input);
          form.appendChild(label);
        }
        const buttons = el('div', 'cp-docx-dialog-buttons');
        const close = (result: DialogResult | null): void => {
          overlay.remove();
          resolve(result);
        };
        const extraSpec = spec.extra;
        if (extraSpec) {
          const extra = el('button', 'cp-docx-dialog-btn', extraSpec.label);
          extra.type = 'button';
          extra.addEventListener('click', () => close({ action: extraSpec.name }));
          buttons.appendChild(extra);
        }
        const cancel = el('button', 'cp-docx-dialog-btn', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => close(null));
        const ok = el('button', 'cp-docx-dialog-btn cp-docx-primary', spec.submit);
        ok.type = 'submit';
        buttons.append(cancel, ok);
        form.appendChild(buttons);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const values: Record<string, string> = {};
          for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
          close({ action: 'ok', values });
        });
        overlay.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close(null);
          }
        });
        overlay.addEventListener('mousedown', (e) => {
          if (e.target === overlay) close(null);
        });
        overlay.appendChild(form);
        root.appendChild(overlay);
        const first: HTMLInputElement | undefined = Object.values(inputs)[0];
        if (first) {
          first.focus();
          first.select();
        }
      });
    }

    // ---- Commands
    async function editLink(): Promise<void> {
      const anchor = currentAnchor();
      const live = selectionInPage();
      const range = live ? live.getRangeAt(0) : savedRange;
      const collapsed = !range || range.collapsed;
      const fields: DialogField[] = [
        { name: 'url', label: 'Address', value: anchor ? (anchor.getAttribute('href') ?? '') : 'https://' },
      ];
      if (collapsed && !anchor) fields.push({ name: 'text', label: 'Text', value: '' });
      const res = await openDialog({
        title: anchor ? 'Edit link' : 'Insert link',
        fields,
        submit: 'Apply',
        extra: anchor ? { name: 'remove', label: 'Remove link' } : null,
      });
      if (!res) {
        focusPage();
        return;
      }
      focusPage();
      if (res.action === 'remove') {
        if (anchor) {
          const range = document.createRange();
          range.selectNodeContents(anchor);
          const s = window.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(range);
          }
        }
        exec('unlink');
        return;
      }
      if (!res.values) return;
      let raw = res.values.url.trim();
      if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? 'mailto:' : 'https://') + raw;
      const href = safeHref(raw);
      if (!href) {
        status('Only http, https and mailto links are supported.');
        return;
      }
      if (anchor) {
        anchor.setAttribute('href', href);
        notifyChange();
      } else if (collapsed) {
        const a = document.createElement('a');
        a.setAttribute('href', href);
        a.textContent = (res.values.text || '').trim() || href;
        insertNode(a);
      } else {
        exec('createLink', href);
      }
    }

    function applyFontSize(pt: number): void {
      if (!pt) return;
      focusPage();
      const live = window.getSelection();
      if (!live || !live.rangeCount || live.getRangeAt(0).collapsed) {
        status('Select some text first to change its size.');
        return;
      }
      exec('fontSize', '7');
      for (const f of Array.from(page.querySelectorAll('font[size="7"]'))) {
        const span = document.createElement('span');
        span.style.fontSize = `${pt}pt`;
        while (f.firstChild) span.appendChild(f.firstChild);
        for (const inner of Array.from(span.querySelectorAll('span'))) inner.style.removeProperty('font-size');
        f.replaceWith(span);
      }
      notifyChange();
    }

    function clearFormatting(): void {
      focusPage();
      exec('removeFormat');
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        for (const span of Array.from(page.querySelectorAll<HTMLElement>('span[style]'))) {
          if (!range.intersectsNode(span)) continue;
          span.style.removeProperty('color');
          span.style.removeProperty('font-size');
          if (!span.getAttribute('style')) span.replaceWith(...Array.from(span.childNodes));
        }
      }
      notifyChange();
    }

    async function insertImageFile(file: File): Promise<void> {
      if (!IMAGE_TYPES.includes(file.type)) {
        status('Only PNG, JPEG and GIF images can be inserted.');
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        status('The image is larger than 10 MB.');
        return;
      }
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the image file.'));
        reader.readAsDataURL(file);
      });
      if (!IMAGE_SRC.test(dataUri)) {
        status('That image could not be inserted.');
        return;
      }
      const img = document.createElement('img');
      img.setAttribute('src', dataUri);
      img.setAttribute('alt', file.name.slice(0, 200));
      insertNode(img);
    }

    async function insertTable(): Promise<void> {
      const res = await openDialog({
        title: 'Insert table',
        fields: [
          { name: 'rows', label: 'Rows', value: '3', type: 'number', min: 1, max: 50 },
          { name: 'cols', label: 'Columns', value: '3', type: 'number', min: 1, max: 20 },
        ],
        submit: 'Insert',
      });
      focusPage();
      if (!res || !res.values) return;
      const rows = Math.min(50, Math.max(1, parseInt(res.values.rows, 10) || 1));
      const cols = Math.min(20, Math.max(1, parseInt(res.values.cols, 10) || 1));
      const table = document.createElement('table');
      const body = document.createElement('tbody');
      for (let r = 0; r < rows; r += 1) {
        const tr = document.createElement('tr');
        for (let c = 0; c < cols; c += 1) {
          const td = document.createElement('td');
          td.appendChild(document.createElement('br'));
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
      const holder = document.createElement('div');
      const after = document.createElement('p');
      after.appendChild(document.createElement('br'));
      holder.append(table, after);
      document.execCommand('insertHTML', false, holder.innerHTML);
    }

    function placeCaret(target: Node | null | undefined): void {
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function blankCell(ref?: Element | null): HTMLTableCellElement {
      const td = document.createElement(ref && ref.localName === 'th' ? 'th' : 'td');
      td.appendChild(document.createElement('br'));
      return td;
    }

    function tableOp(op: string): void {
      const cell = currentCell();
      if (!cell) return;
      const row = cell.parentElement;
      const table = cell.closest('table');
      if (!(row instanceof HTMLTableRowElement) || !table) return;
      const idx = cell.cellIndex;
      const removeTable = (): void => {
        const next = table.nextElementSibling || table.previousElementSibling;
        table.remove();
        ensureContent();
        placeCaret(next || page.firstChild);
      };
      if (op === 'addRow') {
        const nr = document.createElement('tr');
        for (const c of Array.from(row.cells)) {
          const nc = blankCell(c);
          if (c.colSpan > 1) nc.colSpan = c.colSpan;
          nr.appendChild(nc);
        }
        row.after(nr);
        placeCaret(nr.cells[0]);
      } else if (op === 'delRow') {
        if (table.rows.length <= 1) {
          removeTable();
        } else {
          const near = row.nextElementSibling || row.previousElementSibling;
          row.remove();
          placeCaret(near instanceof HTMLTableRowElement ? near.cells[Math.min(idx, near.cells.length - 1)] : null);
        }
      } else if (op === 'addCol') {
        for (const r of Array.from(table.rows)) {
          const ref = r.cells[idx];
          const nc = blankCell(ref);
          if (ref) ref.after(nc);
          else r.appendChild(nc);
        }
        placeCaret(row.cells[idx + 1]);
      } else if (op === 'delCol') {
        if (row.cells.length <= 1) {
          removeTable();
        } else {
          for (const r of Array.from(table.rows)) if (r.cells[idx]) r.cells[idx].remove();
          placeCaret(row.cells[Math.min(idx, row.cells.length - 1)]);
        }
      } else if (op === 'delTable') {
        removeTable();
      }
      notifyChange();
      refreshToolbar();
    }

    // ---- Find
    let findInput: HTMLInputElement;
    function findNext(backward: boolean): void {
      const term = findInput.value;
      if (!term) return;
      const needle = term.toLowerCase();
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      const matches: FindMatch[] = [];
      while (walker.nextNode()) {
        const text = (walker.currentNode.nodeValue ?? '').toLowerCase();
        let i = text.indexOf(needle);
        while (i !== -1) {
          matches.push({ node: walker.currentNode, index: i });
          i = text.indexOf(needle, i + needle.length);
        }
      }
      if (!matches.length) {
        status('No matches found.');
        return;
      }
      let pick: FindMatch;
      const from = savedRange;
      if (!from) {
        pick = backward ? matches[matches.length - 1] : matches[0];
      } else if (backward) {
        pick = [...matches].reverse().find((m) => from.comparePoint(m.node, m.index) < 0) ||
          matches[matches.length - 1];
      } else {
        pick = matches.find((m) => from.comparePoint(m.node, m.index) > 0) || matches[0];
      }
      const range = document.createRange();
      range.setStart(pick.node, pick.index);
      range.setEnd(pick.node, pick.index + term.length);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      savedRange = range.cloneRange();
      if (pick.node.parentElement) pick.node.parentElement.scrollIntoView({ block: 'center' });
    }

    // ---- Toolbar
    const blockSelect = el('select', 'cp-docx-select');
    blockSelect.title = 'Paragraph style';
    for (const [value, label] of BLOCK_STYLES) {
      const opt = el('option', '', label);
      opt.value = value;
      blockSelect.appendChild(opt);
    }
    blockSelect.addEventListener('change', () => {
      exec('formatBlock', `<${blockSelect.value}>`);
    });

    const sizeSelect = el('select', 'cp-docx-select cp-docx-size');
    sizeSelect.title = 'Font size (pt)';
    const sizePlaceholder = el('option', '', 'Size');
    sizePlaceholder.value = '';
    sizeSelect.appendChild(sizePlaceholder);
    for (const n of FONT_SIZES) {
      const opt = el('option', '', String(n));
      opt.value = String(n);
      sizeSelect.appendChild(opt);
    }
    sizeSelect.addEventListener('change', () => {
      applyFontSize(Number(sizeSelect.value));
      sizeSelect.value = '';
    });

    const colorInput = el('input', 'cp-docx-color');
    colorInput.type = 'color';
    colorInput.value = '#c00000';
    colorInput.title = 'Text colour';
    colorInput.addEventListener('change', () => {
      execCss('foreColor', colorInput.value);
      notifyChange();
    });

    const imageInput = el('input');
    imageInput.type = 'file';
    imageInput.accept = IMAGE_TYPES.join(',');
    imageInput.hidden = true;
    imageInput.addEventListener('change', async () => {
      const file = imageInput.files && imageInput.files[0];
      imageInput.value = '';
      if (file) {
        try {
          await insertImageFile(file);
        } catch (err) {
          status(errorMessage(err));
        }
      }
    });

    function addButton(
      bar: HTMLElement,
      label: string,
      title: string,
      run: () => unknown,
      stateCmd?: string,
    ): HTMLButtonElement {
      const b = el('button', 'cp-docx-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => run());
      if (stateCmd) stateful.push({ button: b, cmd: stateCmd });
      bar.appendChild(b);
      return b;
    }

    function addSep(bar: HTMLElement): void {
      bar.appendChild(el('span', 'cp-docx-sep'));
    }

    addButton(toolbar, '↶', 'Undo (Ctrl+Z)', () => exec('undo'));
    addButton(toolbar, '↷', 'Redo (Ctrl+Y)', () => exec('redo'));
    addSep(toolbar);
    toolbar.append(blockSelect, sizeSelect);
    addSep(toolbar);
    addButton(toolbar, 'B', 'Bold (Ctrl+B)', () => exec('bold'), 'bold').classList.add('cp-docx-bold');
    addButton(toolbar, 'I', 'Italic (Ctrl+I)', () => exec('italic'), 'italic').classList.add('cp-docx-italic');
    addButton(toolbar, 'U', 'Underline (Ctrl+U)', () => exec('underline'), 'underline').classList.add('cp-docx-underline');
    addButton(toolbar, 'S', 'Strikethrough', () => exec('strikeThrough'), 'strikeThrough').classList.add('cp-docx-strike');
    toolbar.appendChild(colorInput);
    addSep(toolbar);
    addButton(toolbar, 'Left', 'Align left', () => execCss('justifyLeft'), 'justifyLeft');
    addButton(toolbar, 'Center', 'Align center', () => execCss('justifyCenter'), 'justifyCenter');
    addButton(toolbar, 'Right', 'Align right', () => execCss('justifyRight'), 'justifyRight');
    addButton(toolbar, 'Justify', 'Justify', () => execCss('justifyFull'), 'justifyFull');
    addSep(toolbar);
    addButton(toolbar, '• List', 'Bulleted list', () => exec('insertUnorderedList'), 'insertUnorderedList');
    addButton(toolbar, '1. List', 'Numbered list', () => exec('insertOrderedList'), 'insertOrderedList');
    addButton(toolbar, '→', 'Increase indent', () => exec('indent'));
    addButton(toolbar, '←', 'Decrease indent', () => exec('outdent'));
    addSep(toolbar);
    addButton(toolbar, 'Link', 'Insert or edit link (Ctrl+K)', () => editLink());
    addButton(toolbar, 'Image', 'Insert image', () => {
      focusPage();
      imageInput.click();
    });
    addButton(toolbar, 'Table', 'Insert table', () => insertTable());
    addSep(toolbar);
    addButton(toolbar, 'Clear', 'Clear formatting', () => clearFormatting());
    toolbar.appendChild(imageInput);

    tableBar.appendChild(el('span', 'cp-docx-label', 'Table'));
    addButton(tableBar, '+ Row', 'Add row below', () => tableOp('addRow'));
    addButton(tableBar, '− Row', 'Delete row', () => tableOp('delRow'));
    addButton(tableBar, '+ Column', 'Add column to the right', () => tableOp('addCol'));
    addButton(tableBar, '− Column', 'Delete column', () => tableOp('delCol'));
    addButton(tableBar, 'Delete table', 'Delete the whole table', () => tableOp('delTable'));

    findInput = el('input', 'cp-docx-find');
    findInput.type = 'text';
    findInput.placeholder = 'Find in document';
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        findNext(e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        findBar.hidden = true;
        focusPage();
      }
    });
    findBar.appendChild(findInput);
    addButton(findBar, 'Prev', 'Previous match', () => findNext(true));
    addButton(findBar, 'Next', 'Next match', () => findNext(false));
    addButton(findBar, '×', 'Close', () => {
      findBar.hidden = true;
      focusPage();
    });

    function refreshToolbar(): void {
      if (disposed || !selectionInPage()) return;
      for (const s of stateful) {
        let on = false;
        try {
          on = document.queryCommandState(s.cmd);
        } catch (err) {
          on = false;
        }
        s.button.classList.toggle('active', on);
      }
      let block = 'p';
      try {
        block = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase();
      } catch (err) {
        block = 'p';
      }
      blockSelect.value = BLOCK_STYLES.some(([v]) => v === block) ? block : 'p';
      tableBar.hidden = !currentCell();
    }

    // ---- Events
    const onSelectionChange = () => {
      if (disposed) return;
      const sel = selectionInPage();
      if (sel) {
        savedRange = sel.getRangeAt(0).cloneRange();
        refreshToolbar();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);

    page.addEventListener('input', () => {
      ensureContent();
      notifyChange();
    });

    page.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        editLink();
      } else if (e.key === 'Tab' && !mod && !e.altKey) {
        const sel = selectionInPage();
        const elem = elementOf(sel && sel.anchorNode);
        if (elem && elem.closest('li')) {
          e.preventDefault();
          exec(e.shiftKey ? 'outdent' : 'indent');
        }
      }
    });

    function insertSanitized(html: string): void {
      const clean = sanitizeHtml(html);
      focusPage();
      document.execCommand('insertHTML', false, clean.innerHTML);
    }

    page.addEventListener('paste', (e) => {
      e.preventDefault();
      const data = e.clipboardData;
      if (!data) return;
      const imageFile = Array.from(data.files || []).find((f) => IMAGE_TYPES.includes(f.type));
      const html = data.getData('text/html');
      const text = data.getData('text/plain');
      try {
        if (html) {
          insertSanitized(html);
        } else if (text) {
          focusPage();
          document.execCommand('insertText', false, text);
        } else if (imageFile) {
          insertImageFile(imageFile).catch((err: unknown) => status(errorMessage(err)));
        }
      } catch (err) {
        status(`Could not paste: ${errorMessage(err)}`);
      }
    });

    page.addEventListener('dragover', (e) => {
      if (!(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'))) e.preventDefault();
    });
    page.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt || Array.from(dt.types).includes('Files')) return;
      e.preventDefault();
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range && page.contains(range.startContainer)) {
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          savedRange = range.cloneRange();
        }
      }
      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      try {
        if (html) {
          insertSanitized(html);
        } else if (text) {
          focusPage();
          document.execCommand('insertText', false, text);
        }
      } catch (err) {
        status(`Could not insert dropped content: ${errorMessage(err)}`);
      }
    });

    const blockLinkNavigation = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest('a')) e.preventDefault();
    };
    page.addEventListener('click', blockLinkNavigation);
    page.addEventListener('auxclick', blockLinkNavigation);

    document.execCommand('defaultParagraphSeparator', false, 'p');

    // ---- View
    const view: CodePadEditorView = {
      kind: 'docx',
      readOnly: false,
      saveMode: 'overwrite',
      saveFilters: [{ name: 'Word Document', extensions: ['docx'] }],
      defaultSaveName: `${baseName}.docx`,
      sessionStateTooLarge: false,

      /**
       * Serializes the document.
       * @param ext Target extension without the dot.
       * @returns The docx bytes.
       * @throws {Error} For unsupported extensions or generation failures.
       */
      async getBytes(ext: string): Promise<Uint8Array> {
        if (ext !== 'docx') throw new Error(`The Word editor cannot save as .${ext}.`);
        pendingSaveVersion = version;
        try {
          return await htmlToDocx(page.innerHTML);
        } catch (err) {
          throw new Error(`Could not create the Word document: ${errorMessage(err)}`, { cause: err });
        }
      },

      isDirty(): boolean {
        return version !== savedVersion;
      },

      markSaved(): void {
        savedVersion = pendingSaveVersion === null ? version : pendingSaveVersion;
        pendingSaveVersion = null;
      },

      async getSessionState(): Promise<object | null> {
        if (version === savedVersion) return null;
        const clean = sanitizeHtml(page.innerHTML);
        const html = clean.innerHTML;
        if (html.length > MAX_SESSION_HTML) {
          view.sessionStateTooLarge = true;
          return null;
        }
        view.sessionStateTooLarge = false;
        return { html };
      },

      getStatusText(): string {
        if (wordCache.version !== version) {
          wordCache = { version, count: ((page.textContent ?? '').match(/\S+/g) || []).length };
        }
        return `${wordCache.count} word${wordCache.count === 1 ? '' : 's'}`;
      },

      layout(): void {
        // The layout is pure CSS (flex column with a scrolling page); nothing to recompute.
      },

      focus(): void {
        page.focus({ preventScroll: true });
      },

      find(): void {
        findBar.hidden = false;
        findInput.focus();
        findInput.select();
      },

      dispose(): void {
        disposed = true;
        document.removeEventListener('selectionchange', onSelectionChange);
        root.remove();
      },
    };
    return view;
  }

  window.CodePadEditors.register('docx', { extensions: ['.docx'], create });
})();
