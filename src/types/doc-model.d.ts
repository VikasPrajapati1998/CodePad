/*
 * Types of the document intelligence core shared by the main process, the renderer and the tests:
 * shared/docModel.ts (window.CodePadDocModel), shared/docOps.ts (window.CodePadDocOps) and shared/chunker.ts
 * (window.CodePadChunker). All offsets are UTF-16 offsets into the LF-normalized text. Nothing here is a module.
 */

type CodePadBlockKind = 'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'quote' | 'rule';

/** One block of a document. Blank lines between blocks belong to no block. */
interface CodePadBlock {
  /** Stable id: derived from the kind, the normalized text and the occurrence number, so editing other blocks keeps it. */
  id: string;
  kind: CodePadBlockKind;
  /** Heading level 1-6; 0 for other kinds. */
  level: number;
  /** Offset of the first character. */
  start: number;
  /** Offset after the last character of the block's last line (the line break is not included). */
  end: number;
  /** 1-based first and last line. */
  startLine: number;
  endLine: number;
  text: string;
  /** Id of the heading block whose section contains this block (a heading belongs to its parent section); null at top level. */
  sectionId: string | null;
  /** Position among all blocks (0-based). */
  index: number;
}

interface CodePadDocSection {
  /** The id of its heading block. */
  id: string;
  title: string;
  level: number;
  parentId: string | null;
  /** Blocks of the section, its heading first, sub-sections included. */
  blockIds: string[];
}

interface CodePadDocument {
  /** Hash of the text; operations name it to detect that the document changed meanwhile. */
  version: string;
  text: string;
  /** True when Markdown rules were used (headings, lists, fences, tables). */
  markdown: boolean;
  blocks: CodePadBlock[];
  sections: CodePadDocSection[];
}

/** A place in a document named in words ("the second paragraph", "the section Pricing", "line 4"). */
type CodePadBlockRef =
  /** 1-based; negative counts from the end (-1 = last). */
  | { kind: 'paragraph'; index: number }
  | { kind: 'heading'; title: string }
  | { kind: 'section'; title: string }
  /** The last section of the document. */
  | { kind: 'lastSection' }
  /** Relative to the cursor. */
  | { kind: 'current' }
  | { kind: 'previous' }
  | { kind: 'next' }
  | { kind: 'line'; line: number }
  | { kind: 'start' }
  | { kind: 'end' };

interface CodePadDocModelApi {
  /** FNV-1a 32-bit hash as 8 hex digits. */
  hash(text: string): string;
  /** Parses LF text; `languageId` 'markdown' enables Markdown structure, plain text gets paragraphs and simple lists. */
  parse(text: string, languageId: string): CodePadDocument;
  /** The block that contains `offset`, else the nearest block before it, else null. */
  blockAt(doc: CodePadDocument, offset: number): CodePadBlock | null;
  /** The first place reference in a sentence, or null. */
  parseRef(sentence: string): CodePadBlockRef | null;
  /** The blocks a reference names ('section' returns all blocks of the section); empty when nothing matches. */
  resolve(doc: CodePadDocument, ref: CodePadBlockRef, cursorOffset?: number): CodePadBlock[];
  /** Markdown table of contents of the headings ('' when there are none). */
  outline(doc: CodePadDocument): string;
}

type CodePadOpType =
  | 'insert'
  | 'append'
  | 'prepend'
  | 'replace'
  | 'rewrite'
  | 'delete'
  | 'move'
  | 'merge'
  | 'split'
  | 'format'
  | 'reorder'
  | 'create_section'
  | 'find_replace';

type CodePadOpStatus = 'pending' | 'applied' | 'rejected' | 'failed' | 'skipped';

/**
 * A validated edit. The model never edits the document: it only supplies `new_content`; the application builds the
 * operation, validates it against the version it was planned on, and applies it.
 */
interface CodePadDocOperation {
  operation_id: string;
  operation_type: CodePadOpType;
  document_id: string;
  /** The block the operation works on (null for append/prepend of the whole document, find_replace, cursor insert). */
  target_block_id: string | null;
  target_section_id: string | null;
  /** The target block's text when planned; a different current text is a conflict. */
  original_content: string | null;
  new_content: string | null;
  /**
   * insert: 'before' | 'after' the target block, or 'cursor' (with `cursor_offset`); append/prepend ignore it;
   * 'inside_end' appends `new_content` to the end of the target block's own text (same line / paragraph).
   */
  insertion_position: 'before' | 'after' | 'cursor' | 'inside_end' | null;
  cursor_offset: number | null;
  /** move / reorder: the block the target goes after (null = to the start of the document). */
  destination_block_id: string | null;
  /** split: offset inside the target block's text where it is split into two paragraphs. */
  split_at: number | null;
  /** find_replace: exact text and its replacement (all occurrences). */
  find: string | null;
  replace_with: string | null;
  /** format: { style: 'bold' | 'italic' | 'code' | 'quote' | 'bullets' | 'numbered' | 'heading', level?: '1'..'6' }. */
  formatting_metadata: Record<string, string> | null;
  document_version: string;
  execution_status: CodePadOpStatus;
}

/** One hunk of a line diff; `id` is unique within one diff. */
interface CodePadDocChange {
  id: string;
  /** 0-based line range [beforeStart, beforeEnd) in the old text that is replaced. */
  beforeStart: number;
  beforeEnd: number;
  /** 0-based line range [afterStart, afterEnd) in the new text that replaces it. */
  afterStart: number;
  afterEnd: number;
  removed: string[];
  added: string[];
}

type CodePadOpsResult =
  | { ok: true; text: string; operations: CodePadDocOperation[]; changes: CodePadDocChange[] }
  | { ok: false; error: string; operations: CodePadDocOperation[] };

interface CodePadDocOpsApi {
  /** A new unique operation id. */
  newId(): string;
  /** Builds an operation with every optional field null and status 'pending'. */
  create(fields: Pick<CodePadDocOperation, 'operation_type' | 'document_id' | 'document_version'> & Partial<CodePadDocOperation>): CodePadDocOperation;
  /** Checks one operation against the document (version, target exists and still has `original_content`, fields). */
  validate(doc: CodePadDocument, op: CodePadDocOperation): { ok: true } | { ok: false; error: string };
  /**
   * Applies operations atomically: all are validated first; any failure (or overlapping targets) applies none.
   * Operations whose id is in `applied` are skipped (duplicate execution after a retry).
   */
  apply(doc: CodePadDocument, operations: CodePadDocOperation[], applied?: ReadonlySet<string>): CodePadOpsResult;
  /** Line diff (LCS) of two LF texts as hunks. */
  diff(before: string, after: string): CodePadDocChange[];
  /** The old text with only the accepted hunks of `diff(before, after)` applied. */
  applyChanges(before: string, changes: CodePadDocChange[], accepted: ReadonlySet<string>): string;
}

interface CodePadChunk {
  index: number;
  start: number;
  end: number;
  /** The exact slice of the document; the chunks' texts joined in order are the whole document. */
  text: string;
  blockIds: string[];
  /** Titles of the sections the chunk starts in, outermost first. */
  sectionPath: string[];
  /** Up to `overlapChars` of the text before and after the chunk (context only, never edited). */
  before: string;
  after: string;
}

interface CodePadChunkBudget {
  /** Tokens of document text per chunk. */
  chunkTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface CodePadChunkerApi {
  /** Rough token count (about 4 characters per token for Latin text, fewer for other scripts). */
  estimateTokens(text: string): number;
  /**
   * Token budget for a model: input = context - output - reserve; a chunk gets the input share left after the
   * instruction and document context (`contextShare`, default 0.35), and edits need room to write it back.
   */
  budget(options: { contextTokens: number; maxOutputTokens: number; reserveTokens?: number; contextShare?: number }): CodePadChunkBudget;
  /** Splits a parsed document into chunks of at most `chunkTokens`, at heading, then paragraph, then sentence boundaries. */
  plan(doc: CodePadDocument, options: { chunkTokens: number; overlapChars?: number }): CodePadChunk[];
  /** Joins edited chunk texts in order; each output keeps the trailing white space of its chunk. */
  merge(chunks: readonly CodePadChunk[], outputs: readonly string[]): string;
}

declare var CodePadDocModel: CodePadDocModelApi;
declare var CodePadDocOps: CodePadDocOpsApi;
declare var CodePadChunker: CodePadChunkerApi;
