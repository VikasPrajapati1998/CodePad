/*
 * Model-adaptive chunking of the AI document assistant: a rough token estimate, the token budget of a model, and a
 * split of a parsed document into chunks at heading, then paragraph, then sentence boundaries. The chunks' texts
 * joined in order are exactly the document, so edited chunks can be merged back without losing a character.
 * No AI, no DOM, no Node API: the same file is a Node module and a renderer <script> (window.CodePadChunker).
 * Types in types/doc-model.d.ts.
 */
(function (root: { CodePadChunker?: CodePadChunkerApi }, factory: () => CodePadChunkerApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadChunker = factory();
  }
})(globalThis, () => {
  const DEFAULT_RESERVE = 256;
  const DEFAULT_CONTEXT_SHARE = 0.35;
  const DEFAULT_OVERLAP = 400;
  const MIN_CHUNK_TOKENS = 150;
  /** An edit writes the chunk back, so a chunk may use only this share of the answer length. */
  const OUTPUT_SHARE = 0.8;
  /** A heading starts a new chunk once the current one holds this share of the budget. */
  const HEADING_BREAK_SHARE = 0.5;
  /** Code units up to the end of Latin Extended-B count as Latin text (about 4 characters per token). */
  const LATIN_LIMIT = 0x024f;

  /** Token weight of one UTF-16 code unit. */
  const weight = (code: number): number => (code <= LATIN_LIMIT ? 1 / 4 : 1 / 1.5);

  /**
   * Rough token count.
   * @param text Any text.
   * @returns ceil(latin / 4 + other / 1.5): about 4 characters per token for Latin text, fewer for other scripts.
   */
  function estimateTokens(text: string): number {
    let latin = 0;
    let other = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) <= LATIN_LIMIT) {
        latin += 1;
      } else {
        other += 1;
      }
    }
    return Math.ceil(latin / 4 + other / 1.5);
  }

  /**
   * Token budget for a model.
   * @param options Context and answer length of the model, the reserve for the template and the share of the input
   *   kept for instructions and document context.
   * @returns Tokens per chunk, input tokens and output tokens.
   */
  function budget(options: { contextTokens: number; maxOutputTokens: number; reserveTokens?: number; contextShare?: number }): CodePadChunkBudget {
    const outputTokens = Math.max(0, Math.floor(options.maxOutputTokens));
    const inputTokens = Math.max(0, Math.floor(options.contextTokens - outputTokens - (options.reserveTokens ?? DEFAULT_RESERVE)));
    const share = options.contextShare ?? DEFAULT_CONTEXT_SHARE;
    const chunkTokens = Math.max(MIN_CHUNK_TOKENS, Math.floor(Math.min(inputTokens * (1 - share), outputTokens * OUTPUT_SHARE)));
    return { chunkTokens, inputTokens, outputTokens };
  }

  /** Splits `text` before each boundary found by `pattern` (the boundary text stays with the piece before it). */
  function splitAfter(text: string, pattern: RegExp): string[] {
    const pieces: string[] = [];
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end > start && end < text.length) {
        pieces.push(text.slice(start, end));
        start = end;
      }
    }
    pieces.push(text.slice(start));
    return pieces.filter((piece) => piece !== '');
  }

  /** Cuts text into pieces of at most `max` tokens by characters, never inside a surrogate pair. */
  function hardSplit(text: string, max: number): string[] {
    const pieces: string[] = [];
    let start = 0;
    let sum = 0;
    for (let index = 0; index < text.length; index += 1) {
      const next = sum + weight(text.charCodeAt(index));
      if (Math.ceil(next - 1e-9) > max && index > start) {
        let cut = index;
        const code = text.charCodeAt(cut);
        if (code >= 0xdc00 && code <= 0xdfff && cut - 1 > start) {
          cut -= 1;
        }
        pieces.push(text.slice(start, cut));
        start = cut;
        sum = 0;
        index = cut - 1;
        continue;
      }
      sum = next;
    }
    pieces.push(text.slice(start));
    return pieces.filter((piece) => piece !== '');
  }

  /** Packs consecutive pieces greedily into groups of at most `max` tokens (a single larger piece stays alone). */
  function pack(pieces: readonly string[], max: number): string[] {
    const groups: string[] = [];
    let current = '';
    let tokens = 0;
    for (const piece of pieces) {
      const size = estimateTokens(piece);
      if (current !== '' && tokens + size > max) {
        groups.push(current);
        current = '';
        tokens = 0;
      }
      current += piece;
      tokens += size;
    }
    if (current !== '') {
      groups.push(current);
    }
    return groups;
  }

  /** Splits an oversize text at sentence ends, then at line breaks, then hard; the pieces joined are the text. */
  function splitOversize(text: string, max: number): string[] {
    const out: string[] = [];
    for (const sentence of pack(splitAfter(text, /[.!?]+["')\]]*[ \t\n]+/g), max)) {
      if (estimateTokens(sentence) <= max) {
        out.push(sentence);
        continue;
      }
      for (const line of pack(splitAfter(sentence, /\n+/g), max)) {
        if (estimateTokens(line) <= max) {
          out.push(line);
        } else {
          out.push(...hardSplit(line, max));
        }
      }
    }
    return out;
  }

  interface Piece {
    start: number;
    end: number;
    tokens: number;
    block: CodePadBlock;
    /** First piece of a heading block. */
    heading: boolean;
  }

  /** Titles of the sections a block is in, outermost first (a heading is in its own section). */
  function sectionPath(doc: CodePadDocument, block: CodePadBlock): string[] {
    const byId = new Map(doc.sections.map((section) => [section.id, section] as const));
    const path: string[] = [];
    let id: string | null = block.kind === 'heading' ? block.id : block.sectionId;
    const visited = new Set<string>();
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const section = byId.get(id);
      if (!section) {
        break;
      }
      path.unshift(section.title);
      id = section.parentId;
    }
    return path;
  }

  /** Up to `max` characters before `start`, without a cut word at the far end. */
  function contextBefore(text: string, start: number, max: number): string {
    const from = Math.max(0, start - max);
    let slice = text.slice(from, start);
    if (from > 0 && /\S/.test(text[from - 1] ?? '') && /^\S/.test(slice)) {
      slice = slice.replace(/^\S+/, '');
    }
    return slice;
  }

  /** Up to `max` characters after `end`, without a cut word at the far end. */
  function contextAfter(text: string, end: number, max: number): string {
    const to = Math.min(text.length, end + max);
    let slice = text.slice(end, to);
    if (to < text.length && /\S/.test(text[to] ?? '') && /\S$/.test(slice)) {
      slice = slice.replace(/\S+$/, '');
    }
    return slice;
  }

  /**
   * Splits a document into chunks.
   * @param doc Parsed document.
   * @param options Largest chunk in tokens and the length of the context before/after each chunk.
   * @returns Chunks in order; their texts joined are exactly `doc.text`.
   */
  function plan(doc: CodePadDocument, options: { chunkTokens: number; overlapChars?: number }): CodePadChunk[] {
    const text = doc.text;
    const max = Math.max(1, Math.floor(options.chunkTokens));
    const overlap = Math.max(0, Math.floor(options.overlapChars ?? DEFAULT_OVERLAP));
    if (text === '') {
      return [];
    }
    const pieces: Piece[] = [];
    doc.blocks.forEach((block, index) => {
      // A block owns the blank lines after it; the first block also owns the text before it.
      const start = index === 0 ? 0 : block.start;
      const next = doc.blocks[index + 1];
      const end = next ? next.start : text.length;
      const slice = text.slice(start, end);
      const tokens = estimateTokens(slice);
      if (tokens <= max) {
        pieces.push({ start, end, tokens, block, heading: block.kind === 'heading' });
        return;
      }
      let offset = start;
      splitOversize(slice, max).forEach((part, partIndex) => {
        pieces.push({ start: offset, end: offset + part.length, tokens: estimateTokens(part), block, heading: block.kind === 'heading' && partIndex === 0 });
        offset += part.length;
      });
    });
    const groups: Piece[][] = [];
    let current: Piece[] = [];
    let tokens = 0;
    const flush = (): void => {
      if (current.length > 0) {
        groups.push(current);
      }
      current = [];
      tokens = 0;
    };
    for (const piece of pieces) {
      if (current.length > 0 && piece.heading && tokens >= max * HEADING_BREAK_SHARE) {
        flush();
      } else if (current.length > 0 && tokens + piece.tokens > max) {
        // Do not leave a heading alone at the end of a chunk: it moves to the next one when it fits there.
        const last = current[current.length - 1];
        if (last.heading && current.length > 1 && last.tokens + piece.tokens <= max) {
          current.pop();
          tokens -= last.tokens;
          flush();
          current = [last];
          tokens = last.tokens;
        } else {
          flush();
        }
      }
      current.push(piece);
      tokens += piece.tokens;
    }
    flush();
    if (groups.length === 0) {
      // Only white space: one chunk keeps the text whole.
      return [{ index: 0, start: 0, end: text.length, text, blockIds: [], sectionPath: [], before: '', after: '' }];
    }
    return groups.map((group, index) => {
      const start = group[0].start;
      const end = group[group.length - 1].end;
      const blockIds: string[] = [];
      for (const piece of group) {
        if (!blockIds.includes(piece.block.id)) {
          blockIds.push(piece.block.id);
        }
      }
      return {
        index,
        start,
        end,
        text: text.slice(start, end),
        blockIds,
        sectionPath: sectionPath(doc, group[0].block),
        before: contextBefore(text, start, overlap),
        after: contextAfter(text, end, overlap),
      };
    });
  }

  /**
   * Joins edited chunk texts.
   * @param chunks The planned chunks.
   * @param outputs One edited text per chunk.
   * @returns The document: each output without its trailing white space plus the trailing white space of its chunk.
   * @throws {Error} When the counts differ.
   */
  function merge(chunks: readonly CodePadChunk[], outputs: readonly string[]): string {
    if (chunks.length !== outputs.length) {
      throw new Error(`Expected ${chunks.length} edited parts but got ${outputs.length}.`);
    }
    return chunks.map((chunk, index) => outputs[index].replace(/\s+$/, '') + (/\s*$/.exec(chunk.text) ?? [''])[0]).join('');
  }

  return { estimateTokens, budget, plan, merge };
});
