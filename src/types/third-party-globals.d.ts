/*
 * Ambient declarations of the third-party browser globals the renderer uses. Monaco and the AMD loader come from
 * <script> tags in index.html; mammoth, docx, XLSX, PDFLib and fontkit are injected lazily by editors/common.ts
 * (`loadScript`) and pdf.js is an ES module imported on demand (`loadModule`). Where the package ships its own
 * .d.ts it is reused through `typeof import(...)`; nothing here is a module, so everything stays global.
 */

/// <reference path="../../node_modules/monaco-editor/monaco.d.ts" />

/** The pdf.js module namespace (pdfjs-dist/build/pdf.min.mjs); there is no UMD global, only `loadModule`. */
type PdfJsModule = typeof import('../../node_modules/pdfjs-dist/types/src/pdf');
/** SheetJS (global `XLSX`, dist/xlsx.full.min.js). */
type XlsxModule = typeof import('../../node_modules/xlsx/types/index');
/** docx (global `docx`, dist/index.iife.js). */
type DocxModule = typeof import('../../node_modules/docx/dist/index');
/** @cantoo/pdf-lib (global `PDFLib`, dist/pdf-lib.min.js). */
type PdfLibModule = typeof import('../../node_modules/@cantoo/pdf-lib/cjs/api/index');
/** @pdf-lib/fontkit (global `fontkit`, dist/fontkit.umd.min.js). */
type FontkitModule = typeof import('../../node_modules/@pdf-lib/fontkit/fontkit');
/** mammoth (global `mammoth`, mammoth.browser.min.js). */
type MammothModule = typeof import('../../node_modules/mammoth/lib/index');

/** The Monaco AMD loader (`vs/loader.js`). */
interface MonacoAmdRequire {
  (dependencies: string[], onLoad: () => void): void;
  config(options: { paths: Record<string, string> }): void;
}

interface Window {
  /** Set by the AMD loader once `vs/editor/editor.main` has loaded. */
  monaco: typeof monaco;
  require: MonacoAmdRequire;
  /** Lazy libraries: undefined until the editor module that needs them has loaded the script. */
  mammoth?: MammothModule;
  docx?: DocxModule;
  XLSX?: XlsxModule;
  PDFLib?: PdfLibModule;
  fontkit?: FontkitModule;
}
