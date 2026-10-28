'use strict';

// Converters: Base64, URL, ASCII<->Hex, JSON and XML formatting/validation.
// Every command works on the selection, else on the whole document, and only
// edits the text when the conversion succeeds; failures go to the status bar.
(() => {
  const BASE64_LINE = 76;
  const encoder = new TextEncoder();

  /** Where an XML parse error was reported (1-based). */
  interface ErrorLocation {
    line: number;
    column: number;
  }

  /** `offset` (JSON) or `where` (XML) tell the validators where to put the cursor. */
  class ConvertError extends Error {
    declare offset?: number;
    declare where?: ErrorLocation | null;
  }

  const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // ---- Base64 / hex / URL --------------------------------------------------

  function bytesToBinary(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return out;
  }

  function utf8Decode(bytes: Uint8Array, what: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ConvertError(`${what} is not valid UTF-8 text.`);
    }
  }

  function base64Encode(text: string, { urlSafe = false, wrap = false }: { urlSafe?: boolean; wrap?: boolean } = {}): string {
    let out = btoa(bytesToBinary(encoder.encode(text)));
    if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (wrap) out = out.match(new RegExp(`.{1,${BASE64_LINE}}`, 'g'))?.join('\n') ?? '';
    return out;
  }

  function base64Decode(text: string): string {
    let clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.replace(/=+$/, '').length % 4 === 1) {
      throw new ConvertError('Invalid Base64 input.');
    }
    clean = clean.replace(/=+$/, '');
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return utf8Decode(bytes, 'The decoded data');
  }

  function urlDecode(text: string): string {
    try {
      return decodeURIComponent(text);
    } catch {
      throw new ConvertError('Malformed URL-encoded text (bad % sequence).');
    }
  }

  const asciiToHex = (text: string): string =>
    Array.from(encoder.encode(text), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

  function hexToAscii(text: string): string {
    const clean = text.replace(/0x|\\x|[\s,]/gi, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) {
      throw new ConvertError('Invalid hex input: use pairs of hex digits such as "41 42 43".');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
    return utf8Decode(bytes, 'The hex data');
  }

  // ---- JSON ----------------------------------------------------------------

  /** Offset the engine reports for a JSON.parse failure, or the end of the text. */
  function jsonErrorOffset(message: string, text: string): number {
    const match = /position (\d+)/.exec(message);
    return match ? Math.min(Number(match[1]), text.length) : text.length;
  }

  /**
   * Re-indents valid JSON text without parsing values, so number precision and
   * key order are untouched. A null indent produces minified output.
   */
  function reformatJson(text: string, indent: string | null): string {
    let out = '';
    let depth = 0;
    let i = 0;
    const newline = () => (indent === null ? '' : `\n${indent.repeat(depth)}`);
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1;
        while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
      } else if (/\s/.test(ch)) {
        i += 1;
      } else if (ch === '{' || ch === '[') {
        let j = i + 1;
        while (/\s/.test(text[j])) j += 1;
        if (text[j] === (ch === '{' ? '}' : ']')) {
          out += ch + text[j];
          i = j + 1;
        } else {
          depth += 1;
          out += ch + newline();
          i += 1;
        }
      } else if (ch === '}' || ch === ']') {
        depth -= 1;
        out += newline() + ch;
        i += 1;
      } else if (ch === ',') {
        out += ch + newline();
        i += 1;
      } else if (ch === ':') {
        out += indent === null ? ':' : ': ';
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  }

  function parseJson(text: string): void {
    try {
      JSON.parse(text);
    } catch (err) {
      throw new ConvertError(`Invalid JSON: ${errorMessage(err)}`);
    }
  }

  function indentUnit(ctx: CodePadCtx): string {
    const model = ctx.editor.getModel();
    if (!model) throw new Error('No editor model.');
    const options = model.getOptions();
    return options.insertSpaces ? ' '.repeat(options.indentSize || options.tabSize) : '\t';
  }

  // ---- XML -----------------------------------------------------------------

  const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

  const ELEMENT = 1;
  const TEXT = 3;
  const CDATA = 4;
  const PI = 7;
  const COMMENT = 8;
  const isElement = (node: Node): node is Element => node.nodeType === ELEMENT;
  const isBlankText = (node: Node): boolean => node.nodeType === TEXT && (node.nodeValue ?? '').trim() === '';
  const hasSignificantText = (el: Element): boolean =>
    Array.from(el.childNodes).some((n) => (n.nodeType === TEXT && !isBlankText(n)) || n.nodeType === CDATA);

  function openTag(el: Element): string {
    let out = `<${el.tagName}`;
    for (const attr of Array.from(el.attributes)) out += ` ${attr.name}="${escapeAttr(attr.value)}"`;
    return out;
  }

  function leafMarkup(node: Node): string {
    switch (node.nodeType) {
      case TEXT: return escapeText(node.nodeValue ?? '');
      case CDATA: return `<![CDATA[${node.nodeValue}]]>`;
      case COMMENT: return `<!--${node.nodeValue}-->`;
      case PI: return `<?${(node as ProcessingInstruction).target} ${node.nodeValue}?>`.replace(/ \?>$/, '?>');
      default: return '';
    }
  }

  /** One-line markup; whitespace-only text is dropped unless the element has real text. */
  function compactMarkup(node: Node): string {
    if (!isElement(node)) return leafMarkup(node);
    if (node.childNodes.length === 0) return `${openTag(node)}/>`;
    const keepBlank = hasSignificantText(node);
    let inner = '';
    for (const child of Array.from(node.childNodes)) {
      if (!keepBlank && isBlankText(child)) continue;
      inner += compactMarkup(child);
    }
    return inner === '' && !keepBlank ? `${openTag(node)}/>` : `${openTag(node)}>${inner}</${node.tagName}>`;
  }

  function prettyLines(node: Node, depth: number, unit: string, lines: string[]): void {
    const pad = unit.repeat(depth);
    if (!isElement(node)) {
      if (!isBlankText(node)) lines.push(pad + leafMarkup(node).trim());
      return;
    }
    const children = Array.from(node.childNodes).filter((n) => !isBlankText(n));
    if (children.length === 0) {
      lines.push(`${pad}${openTag(node)}/>`);
    } else if (hasSignificantText(node)) {
      lines.push(pad + compactMarkup(node));
    } else {
      lines.push(`${pad}${openTag(node)}>`);
      for (const child of children) prettyLines(child, depth + 1, unit, lines);
      lines.push(`${pad}</${node.tagName}>`);
    }
  }

  function parseXml(text: string): Document {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const errorNode = doc.getElementsByTagName('parsererror')[0];
    if (errorNode) {
      const detail = errorNode.textContent || '';
      const match = /error on line (\d+) at column (\d+): ([^\n]*)/.exec(detail);
      const where = match ? { line: Number(match[1]), column: Number(match[2]) } : null;
      const reason = match ? match[3] : detail.split('\n').find((l) => l.trim() && !/^This page/.test(l)) || 'parse error';
      throw Object.assign(new ConvertError(`Invalid XML${where ? ` at line ${where.line}, column ${where.column}` : ''}: ${reason.trim()}`), { where });
    }
    return doc;
  }

  function reformatXml(text: string, unit: string | null): string {
    const doc = parseXml(text);
    const declaration = /^\s*(<\?xml[^?]*\?>)/.exec(text);
    const doctype = /<!DOCTYPE\s[^[>]*(?:\[[^\]]*\])?\s*>/i.exec(text);
    const lines: string[] = declaration ? [declaration[1] as string] : [];
    for (const node of Array.from(doc.childNodes)) {
      if (node.nodeType === 10) {
        if (doctype) lines.push(doctype[0]);
      } else if (unit === null) {
        const markup = compactMarkup(node);
        if (markup) lines.push(markup);
      } else {
        prettyLines(node, 0, unit, lines);
      }
    }
    return lines.join(unit === null ? '' : '\n');
  }

  // ---- command plumbing ------------------------------------------------------

  /** Runs fn on the selection or whole document; reports a ConvertError instead of editing. */
  function convert(ctx: CodePadCtx, label: string, fn: (text: string) => string): void {
    const current = ctx.text.selectionOrDocument();
    if (!current) return;
    try {
      ctx.text.transformSelections((text) => fn(text), {
        scope: current.isSelection ? 'selection' : 'document',
        label,
      });
    } catch (err) {
      if (!(err instanceof ConvertError)) throw err;
      ctx.status.set(`${label}: ${err.message}`);
    }
  }

  function revealError(ctx: CodePadCtx, current: CodePadTextSelection, offsetInText: number, where: ErrorLocation | null | undefined): monaco.IPosition {
    const editor = ctx.editor;
    const model = current.model;
    const base = current.isSelection ? current.ranges[0].getStartPosition() : { lineNumber: 1, column: 1 };
    let position: monaco.IPosition;
    if (where) {
      position = {
        lineNumber: base.lineNumber + where.line - 1,
        column: where.line === 1 ? base.column + where.column - 1 : where.column,
      };
    } else {
      position = model.getPositionAt(model.getOffsetAt(base) + offsetInText);
    }
    position = model.validatePosition(position);
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
    return position;
  }

  function validate(ctx: CodePadCtx, label: string, check: (text: string) => unknown): void {
    const current = ctx.text.selectionOrDocument();
    if (!current) return;
    const text = current.isSelection
      ? current.ranges.map((range) => current.model.getValueInRange(range)).join('\n')
      : current.model.getValue();
    try {
      check(text);
      ctx.status.set(`${label}: valid.`);
    } catch (err) {
      if (!(err instanceof ConvertError)) throw err;
      const position = revealError(ctx, current, err.offset || 0, err.where);
      ctx.status.set(`${err.message} (line ${position.lineNumber}, column ${position.column})`);
    }
  }

  const register = (id: string, run: (ctx: CodePadCtx) => void): void => CodePadCommands.register({ id, run });
  const convertCommand = (id: string, label: string, fn: (text: string) => string): void => register(id, (ctx) => convert(ctx, label, fn));

  convertCommand('conv.base64Encode', 'Base64 encode', (t) => base64Encode(t));
  convertCommand('conv.base64EncodeUrl', 'Base64 encode (URL-safe)', (t) => base64Encode(t, { urlSafe: true }));
  convertCommand('conv.base64EncodeWrapped', 'Base64 encode (76 columns)', (t) => base64Encode(t, { wrap: true }));
  convertCommand('conv.base64Decode', 'Base64 decode', base64Decode);
  convertCommand('conv.urlEncode', 'URL encode', encodeURIComponent);
  convertCommand('conv.urlDecode', 'URL decode', urlDecode);
  convertCommand('conv.asciiToHex', 'ASCII to hex', asciiToHex);
  convertCommand('conv.hexToAscii', 'Hex to ASCII', hexToAscii);

  register('json.pretty', (ctx) => {
    const unit = indentUnit(ctx);
    convert(ctx, 'JSON pretty-print', (t) => {
      parseJson(t);
      return reformatJson(t, unit);
    });
  });
  convertCommand('json.minify', 'JSON minify', (t) => {
    parseJson(t);
    return reformatJson(t, null);
  });
  register('json.validate', (ctx) => validate(ctx, 'JSON', (t) => {
    try {
      JSON.parse(t);
    } catch (err) {
      throw Object.assign(new ConvertError(`Invalid JSON: ${errorMessage(err)}`), { offset: jsonErrorOffset(errorMessage(err), t) });
    }
  }));

  register('xml.pretty', (ctx) => {
    const unit = indentUnit(ctx);
    convert(ctx, 'XML pretty-print', (t) => reformatXml(t, unit));
  });
  convertCommand('xml.minify', 'XML minify', (t) => reformatXml(t, null));
  register('xml.validate', (ctx) => validate(ctx, 'XML', parseXml));
})();
