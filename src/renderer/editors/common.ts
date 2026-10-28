/**
 * Registry and helpers shared by the document editor modules (docx, sheet, pdf).
 * Loaded before the modules and before app.ts; the modules call `CodePadEditors.register(...)`.
 */
(() => {
  const BASE64_CHUNK = 0x8000;
  // Zip limits checked before an OOXML/ODF file is handed to a parser (R-02: decompression bombs).
  const ZIP_MAX_ENTRIES = 10000;
  const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
  const ZIP_MAX_ENTRY_BYTES = 100 * 1024 * 1024;
  const ZIP_MAX_RATIO = 100;
  // Entries below this size are not ratio-checked (tiny repetitive parts legitimately compress very well).
  const ZIP_RATIO_MIN_BYTES = 10 * 1024 * 1024;
  const ZIP_EOCD_SIGNATURE = 0x06054b50;
  const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
  const ZIP_EOCD_MIN = 22;
  const ZIP_EOCD_SEARCH = 0xffff + ZIP_EOCD_MIN;

  const registry = new Map<string, CodePadEditorModule>();
  const scriptCache = new Map<string, Promise<void>>();
  const moduleCache = new Map<string, Promise<PdfJsModule>>();

  // The app root (the folder holding node_modules/) is two levels above dist/renderer/.
  const baseUrl = new URL('../..', window.location.href).href.replace(/\/$/, '');

  /**
   * Reads the zip central directory and refuses archives that would expand into a decompression bomb: too many
   * entries, an oversized entry or total, or a compression ratio above 100:1. Nothing is inflated here. Bytes that
   * are not a zip (xls, csv) pass through. The declared sizes can be forged, so this is a first line of defence.
   * @param bytes File bytes.
   * @param fileName Display name for the message.
   * @throws {Error} With a user-facing message when a limit is exceeded or the directory is damaged.
   */
  function checkZipLimits(bytes: Uint8Array, fileName: string): void {
    if (bytes.length < ZIP_EOCD_MIN || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const refuse = (reason: string): Error =>
      new Error(`"${fileName}" was not opened: ${reason} It may be a decompression bomb or a damaged file.`);
    let eocd = -1;
    for (let at = bytes.length - ZIP_EOCD_MIN; at >= Math.max(0, bytes.length - ZIP_EOCD_SEARCH); at -= 1) {
      if (view.getUint32(at, true) === ZIP_EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) {
      throw refuse('its zip directory is missing.');
    }
    const entryCount = view.getUint16(eocd + 10, true);
    const directorySize = view.getUint32(eocd + 12, true);
    const directoryStart = view.getUint32(eocd + 16, true);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
      throw refuse('Zip64 archives are not supported.');
    }
    if (entryCount > ZIP_MAX_ENTRIES) {
      throw refuse(`it holds ${entryCount} parts (limit ${ZIP_MAX_ENTRIES}).`);
    }
    let at = directoryStart;
    let total = 0;
    for (let i = 0; i < entryCount; i += 1) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== ZIP_CENTRAL_SIGNATURE) {
        throw refuse('its zip directory is damaged.');
      }
      const packed = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      if (size > ZIP_MAX_ENTRY_BYTES) {
        throw refuse(`one part expands to ${Math.round(size / 1048576)} MB (limit ${ZIP_MAX_ENTRY_BYTES / 1048576} MB).`);
      }
      if (size >= ZIP_RATIO_MIN_BYTES && size > packed * ZIP_MAX_RATIO) {
        throw refuse(`one part is compressed more than ${ZIP_MAX_RATIO}:1.`);
      }
      total += size;
      if (total > ZIP_MAX_TOTAL_BYTES) {
        throw refuse(`it expands to more than ${ZIP_MAX_TOTAL_BYTES / 1048576} MB.`);
      }
      at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
  }

  /** Registers the editor module for a tab kind ('docx', 'sheet' or 'pdf'). */
  function register(kind: string, definition: CodePadEditorModule): void {
    if (typeof kind !== 'string' || !definition || typeof definition.create !== 'function') {
      throw new TypeError('CodePadEditors.register needs a kind and a definition with a create() function.');
    }
    registry.set(kind, definition);
  }

  /** The module registered for a kind, or undefined. */
  function get(kind: string): CodePadEditorModule | undefined {
    return registry.get(kind);
  }

  /** File URL of a path inside the app's node_modules folder (relative, no '..' segments). */
  function nodeModulesUrl(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.startsWith('/') || relPath.split('/').includes('..')) {
      throw new Error(`Invalid node_modules path: ${relPath}`);
    }
    return `${baseUrl}/node_modules/${relPath}`;
  }

  /** Injects a classic script once; resolves when it has run. A failed load can be retried. */
  function loadScript(url: string): Promise<void> {
    let cached = scriptCache.get(url);
    if (!cached) {
      const promise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => {
          script.remove();
          reject(new Error(`Could not load ${url}`));
        };
        document.head.appendChild(script);
      });
      promise.catch(() => scriptCache.delete(url));
      scriptCache.set(url, promise);
      cached = promise;
    }
    return cached;
  }

  /** Dynamically imports the pdf.js ES module once. A failed import can be retried. */
  function loadModule(url: string): Promise<PdfJsModule> {
    let cached = moduleCache.get(url);
    if (!cached) {
      const promise: Promise<PdfJsModule> = import(url);
      promise.catch(() => moduleCache.delete(url));
      moduleCache.set(url, promise);
      cached = promise;
    }
    return cached;
  }

  /** Reads a local asset as bytes; falls back to XMLHttpRequest because fetch may refuse file:// URLs. */
  async function fetchBytes(url: string): Promise<Uint8Array> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (fetchError) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', url);
        request.responseType = 'arraybuffer';
        request.onload = () => {
          // file:// responses report status 0 on success.
          if (request.status === 200 || (request.status === 0 && request.response)) {
            resolve(new Uint8Array(request.response));
          } else {
            reject(new Error(`Could not read ${url} (status ${request.status})`, { cause: fetchError }));
          }
        };
        request.onerror = () => reject(new Error(`Could not read ${url}`, { cause: fetchError }));
        request.send();
      });
    }
  }

  /** Base64 for multi-megabyte byte arrays (chunked so String.fromCharCode never overflows the stack). */
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBytes(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const textToBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const bytesToText = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

  window.CodePadEditors = Object.freeze({
    register,
    get,
    util: Object.freeze({
      nodeModulesUrl,
      loadScript,
      loadModule,
      fetchBytes,
      bytesToBase64,
      base64ToBytes,
      textToBytes,
      bytesToText,
      checkZipLimits,
    }),
  });
})();
