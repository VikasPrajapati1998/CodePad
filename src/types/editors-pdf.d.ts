/*
 * Types private to renderer/editors/pdf-editor.ts (the PDF view). Nothing here is a module: keep it free of
 * top-level import/export. Library types are reached through `import(...)` type expressions into pdfjs-dist and
 * @cantoo/pdf-lib; the runtime libraries themselves are declared in third-party-globals.d.ts.
 */

type CpPdfJsDocument = import('../../node_modules/pdfjs-dist/types/src/pdf').PDFDocumentProxy;
type CpPdfJsLoadingTask = import('../../node_modules/pdfjs-dist/types/src/pdf').PDFDocumentLoadingTask;
type CpPdfJsPage = import('../../node_modules/pdfjs-dist/types/src/pdf').PDFPageProxy;
type CpPdfJsRenderTask = import('../../node_modules/pdfjs-dist/types/src/pdf').RenderTask;
type CpPdfJsViewport = import('../../node_modules/pdfjs-dist/types/src/pdf').PageViewport;
/*
 * PdfLibModule (third-party-globals.d.ts) points at cjs/index, whose './api' re-exports do not resolve under the
 * renderer project (module none uses classic resolution, which has no directory index). The api barrel is named
 * explicitly here, and loadPdfLib() in pdf-editor.ts hands out the global as this type.
 */
type CpPdfLibApi = typeof import('../../node_modules/@cantoo/pdf-lib/cjs/api/index');
type CpPdfLibDrawTextOptions = import('../../node_modules/@cantoo/pdf-lib/cjs/api/index').PDFPageDrawTextOptions;
type CpPdfLibFont = import('../../node_modules/@cantoo/pdf-lib/cjs/api/index').PDFFont;
type CpPdfLibStandardFont = keyof CpPdfLibApi['StandardFonts'];

/** getDocument() options: this pdf.js release no longer declares two options the viewer still passes. */
type CpPdfJsOpenParams = import('../../node_modules/pdfjs-dist/types/src/display/api').DocumentInitParameters & {
  isEvalSupported: boolean;
  enableScripting: boolean;
};

/** Four numbers in page-frame coordinates: x, y, width, height. */
type CpPdfRect = [number, number, number, number];
/** RGB, each component 0..1. */
type CpPdfColor = [number, number, number];
type CpPdfFontKey = 'Helvetica' | 'Times' | 'Courier' | 'Liberation';
type CpPdfEditType = 'replace' | 'add' | 'whiteout';

/** Text style shared by text edits and the toolbar defaults. */
interface CpPdfStyle {
  fontKey: CpPdfFontKey;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: CpPdfColor;
  bg: CpPdfColor;
}

interface CpPdfWhiteoutEdit {
  id: string;
  page: number;
  type: 'whiteout';
  rect: CpPdfRect;
  bg: CpPdfColor;
}

interface CpPdfReplaceEdit extends CpPdfStyle {
  id: string;
  page: number;
  type: 'replace';
  rect: CpPdfRect;
  origRect: CpPdfRect;
  text: string;
}

interface CpPdfAddEdit extends CpPdfStyle {
  id: string;
  page: number;
  type: 'add';
  rect: CpPdfRect;
  text: string;
}

type CpPdfTextEdit = CpPdfReplaceEdit | CpPdfAddEdit;
type CpPdfEdit = CpPdfWhiteoutEdit | CpPdfTextEdit;

/** An editable fragment of text on a page, in page-frame coordinates. */
interface CpPdfRun {
  pageIndex: number;
  str: string;
  x: number;
  base: number;
  fs: number;
  w: number;
  rot: boolean;
  angle: number;
  fontName: string;
  family: string;
  y: number;
  h: number;
}

/** DOM elements that show one edit. */
interface CpPdfEditEls {
  patch: HTMLElement | null;
  box: HTMLElement | null;
  handle: HTMLElement;
}

interface CpPdfPageState {
  index: number;
  page: CpPdfJsPage;
  vp: CpPdfJsViewport;
  w: number;
  h: number;
  live: boolean;
  canvas: HTMLCanvasElement | null;
  renderTask: CpPdfJsRenderTask | null;
  renderToken: number;
  runs: CpPdfRun[] | null;
  runsPromise: Promise<CpPdfRun[]> | null;
  editEls: Map<string, CpPdfEditEls>;
  el: HTMLElement;
  patchLayer: HTMLElement;
  hitLayer: HTMLElement;
  runLayer: HTMLElement;
  boxLayer: HTMLElement;
}

interface CpPdfEditing {
  ps: CpPdfPageState;
  edit: CpPdfTextEdit;
  isNew: boolean;
  before: string;
  pristine: string;
  box: HTMLElement;
}

interface CpPdfMatch {
  ps: CpPdfPageState;
  run: CpPdfRun;
  start: number;
  len: number;
}

interface CpPdfHistory {
  undo: string[];
  redo: string[];
}

interface CpPdfHandle {
  doc: CpPdfJsDocument;
  task: CpPdfJsLoadingTask;
}

/** The parts of a pdf.js font object that runStyle reads (it is only a hint). */
interface CpPdfFontObject {
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  isMonospace?: boolean;
  isSerifFont?: boolean;
}

/** Page-frame sample result of the on-screen canvas. */
interface CpPdfSampledColors {
  fg: CpPdfColor;
  bg: CpPdfColor;
}

/** Snapshot of unsaved edits returned by getSessionState. */
interface CpPdfSessionState {
  edits: CpPdfEdit[];
  page: number;
  zoom: number;
}
