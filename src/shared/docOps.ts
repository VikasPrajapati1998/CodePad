/*
 * Structured document operations of the AI document assistant. The model never edits a document: the application
 * builds operations (insert, replace, move, format...), validates them against the version and the target text they
 * were planned on, and applies a whole batch atomically as text edits on the original text. Also a line diff (LCS)
 * whose hunks can be accepted one by one.
 * No AI, no DOM, no Node API: the same file is a Node module and a renderer <script> (window.CodePadDocOps).
 * Types in types/doc-model.d.ts.
 */
(function (root: { CodePadDocOps?: CodePadDocOpsApi }, factory: () => CodePadDocOpsApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadDocOps = factory();
  }
})(globalThis, () => {
  const VERSION_CONFLICT = 'The document changed since the edit was planned.';
  const FORMAT_STYLES: ReadonlySet<string> = new Set(['bold', 'italic', 'code', 'quote', 'bullets', 'numbered', 'heading']);
  const LIST_MARKER = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;
  /** Largest line count per side of the LCS table; beyond it the differing middle becomes one hunk. */
  const MAX_DIFF_LINES = 4000;

  type Validation = { ok: true } | { ok: false; error: string };

  /** One text edit on the original text: [start, end) is replaced by `text`. */
  interface Edit {
    start: number;
    end: number;
    text: string;
    /** Position of the operation in the batch. */
    order: number;
    /** A whole block (or several) inserted between blocks; separated from its neighbours by one blank line. */
    block: boolean;
    /** A removed block; removals of different blocks may touch or overlap and are joined. */
    removes: string | null;
  }

  let counter = 0;

  /** A new unique operation id. */
  function newId(): string {
    counter += 1;
    return `op-${Date.now().toString(36)}-${counter}`;
  }

  /**
   * Builds an operation with every optional field null and status 'pending'.
   * @param fields Type, document and version, plus any other fields to set.
   * @returns The operation (a new id unless `operation_id` is given).
   */
  function create(
    fields: Pick<CodePadDocOperation, 'operation_type' | 'document_id' | 'document_version'> & Partial<CodePadDocOperation>,
  ): CodePadDocOperation {
    const base: CodePadDocOperation = {
      operation_id: newId(),
      operation_type: fields.operation_type,
      document_id: fields.document_id,
      target_block_id: null,
      target_section_id: null,
      original_content: null,
      new_content: null,
      insertion_position: null,
      cursor_offset: null,
      destination_block_id: null,
      split_at: null,
      find: null,
      replace_with: null,
      formatting_metadata: null,
      document_version: fields.document_version,
      execution_status: 'pending',
    };
    const result: CodePadDocOperation = { ...base };
    for (const key of Object.keys(fields) as Array<keyof CodePadDocOperation>) {
      if (fields[key] !== undefined) {
        Object.assign(result, { [key]: fields[key] });
      }
    }
    return result;
  }

  const findBlock = (doc: CodePadDocument, id: string | null): CodePadBlock | undefined =>
    id === null ? undefined : doc.blocks.find((block) => block.id === id);

  const fail = (error: string): Validation => ({ ok: false, error });

  function countOccurrences(text: string, find: string): number {
    let count = 0;
    let index = text.indexOf(find);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(find, index + find.length);
    }
    return count;
  }

  function headingLevel(meta: Record<string, string> | null): number | null {
    const raw = meta ? meta.level : undefined;
    if (raw === undefined || raw === '') {
      return null;
    }
    const level = Number(raw);
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : -1;
  }

  /**
   * Checks one operation against the document.
   * @param doc The current document.
   * @param op The operation.
   * @returns ok, or the reason it cannot be applied.
   */
  function validate(doc: CodePadDocument, op: CodePadDocOperation): Validation {
    if (op.document_version !== doc.version) {
      return fail(VERSION_CONFLICT);
    }
    const target = findBlock(doc, op.target_block_id);
    if (op.target_block_id !== null && !target) {
      return fail('The block to edit no longer exists.');
    }
    if (target && op.original_content !== null && target.text !== op.original_content) {
      return fail('The block to edit changed since the edit was planned.');
    }
    const needsTarget = (): Validation => (target ? { ok: true } : fail(`The ${op.operation_type} operation needs a target block.`));
    const needsContent = (): Validation =>
      typeof op.new_content === 'string' ? { ok: true } : fail(`The ${op.operation_type} operation needs new content.`);
    switch (op.operation_type) {
      case 'insert': {
        if (typeof op.new_content !== 'string' || op.new_content === '') {
          return fail('An insert needs new content.');
        }
        if (op.insertion_position === null) {
          return fail('An insert needs a position.');
        }
        if (op.insertion_position === 'cursor') {
          const offset = op.cursor_offset;
          return offset !== null && Number.isInteger(offset) && offset >= 0 && offset <= doc.text.length
            ? { ok: true }
            : fail('The cursor position is outside the document.');
        }
        return needsTarget();
      }
      case 'append':
      case 'prepend':
        return typeof op.new_content === 'string' && op.new_content !== '' ? { ok: true } : fail(`The ${op.operation_type} operation needs new content.`);
      case 'replace':
      case 'rewrite': {
        const result = needsTarget();
        return result.ok ? needsContent() : result;
      }
      case 'delete':
        return needsTarget();
      case 'move':
      case 'reorder': {
        if (!target) {
          return needsTarget();
        }
        if (op.destination_block_id !== null && !findBlock(doc, op.destination_block_id)) {
          return fail('The destination block no longer exists.');
        }
        return op.destination_block_id === target.id ? fail('A block cannot be moved after itself.') : { ok: true };
      }
      case 'merge':
        if (!target) {
          return needsTarget();
        }
        return target.index + 1 < doc.blocks.length ? { ok: true } : fail('There is no following block to merge with.');
      case 'split': {
        if (!target) {
          return needsTarget();
        }
        const at = op.split_at;
        if (at === null || !Number.isInteger(at) || at <= 0 || at >= target.text.length) {
          return fail('The split position must be inside the block.');
        }
        return target.text.slice(0, at).trim() === '' || target.text.slice(at).trim() === ''
          ? fail('There is no text on one side of the split.')
          : { ok: true };
      }
      case 'format': {
        if (!target) {
          return needsTarget();
        }
        const style = op.formatting_metadata ? op.formatting_metadata.style : undefined;
        if (style === undefined || !FORMAT_STYLES.has(style)) {
          return fail('Unknown format style.');
        }
        return style === 'heading' && headingLevel(op.formatting_metadata) === -1 ? fail('A heading level must be 1 to 6.') : { ok: true };
      }
      case 'create_section': {
        if (typeof op.new_content !== 'string') {
          return fail('A new section needs its body text.');
        }
        const title = op.formatting_metadata ? op.formatting_metadata.title : undefined;
        if (title === undefined || title.trim() === '' || /\n/.test(title.trim())) {
          return fail('A new section needs a one-line title.');
        }
        return headingLevel(op.formatting_metadata) === -1 ? fail('A heading level must be 1 to 6.') : { ok: true };
      }
      case 'find_replace': {
        if (typeof op.find !== 'string' || op.find === '') {
          return fail('The text to find is empty.');
        }
        if (typeof op.replace_with !== 'string') {
          return fail('The replacement text is missing.');
        }
        return countOccurrences(doc.text, op.find) > 0 ? { ok: true } : fail('The text to find does not occur in the document.');
      }
      default:
        return fail('Unknown operation type.');
    }
  }

  /** Content of a new block: LF, without blank lines around it and without trailing white space. */
  const blockContent = (content: string): string =>
    content.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');

  const trailingNewlines = (text: string): number => (/\n*$/.exec(text) ?? [''])[0].length;
  const leadingNewlines = (text: string): number => (/^\n*/.exec(text) ?? [''])[0].length;

  /** The replacement that puts `content` at `pos` with exactly one blank line to the text on either side. */
  function blockInsertion(text: string, pos: number, content: string): string {
    const left = text.slice(0, pos);
    const right = text.slice(pos);
    const lead = /\S/.test(left) ? '\n'.repeat(Math.max(0, 2 - trailingNewlines(left))) : '';
    const tail = /\S/.test(right) ? '\n'.repeat(Math.max(0, 2 - leadingNewlines(right))) : '';
    return `${lead}${content}${tail}`;
  }

  /** The range that removes a block together with the blank lines that separate it from its neighbours. */
  function removalRange(doc: CodePadDocument, block: CodePadBlock): [number, number] {
    const next = doc.blocks[block.index + 1];
    if (next) {
      return [block.start, next.start];
    }
    const previous = doc.blocks[block.index - 1];
    return previous ? [previous.end, block.end] : [block.start, block.end];
  }

  const stripListMarker = (line: string): string => line.replace(LIST_MARKER, '');

  /** The block's lines as list items: its lines, or its sentences when it is a single line. */
  function itemsOf(text: string): string[] {
    const lines = text.split('\n').map((line) => stripListMarker(line).trim()).filter((line) => line !== '');
    if (lines.length > 1) {
      return lines;
    }
    return (lines[0] ?? '').split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== '');
  }

  function wrapInline(block: CodePadBlock, marker: string): string {
    if (block.kind === 'list') {
      return block.text
        .split('\n')
        .map((line) => {
          const match = LIST_MARKER.exec(line);
          const body = match ? line.slice(match[0].length) : line;
          const prefix = match ? match[0] : /^[ \t]*/.exec(line)?.[0] ?? '';
          return body.trim() === '' ? line : `${prefix}${marker}${body.trim()}${marker}`;
        })
        .join('\n');
    }
    if (block.kind === 'heading') {
      const match = /^( {0,3}#{1,6}[ \t]+)(.*?)([ \t]+#+)?[ \t]*$/.exec(block.text);
      if (match && !block.text.includes('\n')) {
        return `${match[1]}${marker}${match[2]}${marker}`;
      }
    }
    return `${marker}${block.text.trim()}${marker}`;
  }

  /** The block's text in the requested style (Markdown markup, also for plain text). */
  function formatBlock(block: CodePadBlock, meta: Record<string, string>): string {
    const plainText = (): string =>
      block.kind === 'heading'
        ? block.text.split('\n').filter((line) => !/^ {0,3}(=+|-+)[ \t]*$/.test(line)).join(' ').replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
        : block.text.trim();
    switch (meta.style) {
      case 'bold':
        return wrapInline(block, '**');
      case 'italic':
        return wrapInline(block, '*');
      case 'code':
        return block.text.includes('\n') ? `\`\`\`\n${block.text}\n\`\`\`` : `\`${block.text.trim()}\``;
      case 'quote':
        return block.text
          .split('\n')
          .map((line) => (/^ {0,3}>/.test(line) ? line : `> ${line}`.replace(/\s+$/, '')))
          .join('\n');
      case 'bullets':
        return itemsOf(block.text).map((item) => `- ${item}`).join('\n');
      case 'numbered':
        return itemsOf(block.text).map((item, index) => `${index + 1}. ${item}`).join('\n');
      default: {
        const level = headingLevel(meta) ?? 1;
        return `${'#'.repeat(level)} ${plainText().replace(/\s+/g, ' ')}`;
      }
    }
  }

  /** Level of the section `block` is in (its own level when it is a heading), else null. */
  function sectionLevel(doc: CodePadDocument, block: CodePadBlock | undefined): number | null {
    if (!block) {
      return null;
    }
    if (block.kind === 'heading') {
      return block.level;
    }
    const heading = findBlock(doc, block.sectionId);
    return heading ? heading.level : null;
  }

  /** The text edits of one valid operation on the original text. */
  function editsOf(doc: CodePadDocument, op: CodePadDocOperation, order: number): Edit[] {
    const text = doc.text;
    const target = findBlock(doc, op.target_block_id);
    const first = doc.blocks[0];
    const last = doc.blocks[doc.blocks.length - 1];
    const plain = (start: number, end: number, replacement: string): Edit => ({ start, end, text: replacement, order, block: false, removes: null });
    const blockAt = (pos: number, content: string): Edit => ({ start: pos, end: pos, text: content, order, block: true, removes: null });
    const removal = (block: CodePadBlock): Edit => {
      const [start, end] = removalRange(doc, block);
      return { start, end, text: '', order, block: false, removes: block.id };
    };
    const content = op.new_content ?? '';
    const insideEnd = (block: CodePadBlock): Edit => {
      const addition = content.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      return plain(block.end, block.end, /^[\s.,;:!?)\]}]/.test(addition) ? addition : ` ${addition}`);
    };
    const insideStart = (block: CodePadBlock): Edit => {
      const addition = content.replace(/\r\n?/g, '\n').replace(/^\s+/, '');
      return plain(block.start, block.start, /\s$/.test(addition) ? addition : `${addition} `);
    };
    switch (op.operation_type) {
      case 'insert':
        if (op.insertion_position === 'cursor') {
          const offset = op.cursor_offset ?? 0;
          return [plain(offset, offset, content.replace(/\r\n?/g, '\n'))];
        }
        if (!target) {
          return [];
        }
        if (op.insertion_position === 'inside_end') {
          return [insideEnd(target)];
        }
        return [blockAt(op.insertion_position === 'before' ? target.start : target.end, blockContent(content))];
      case 'append':
        if (target) {
          return [insideEnd(target)];
        }
        return [blockAt(last ? last.end : text.length, blockContent(content))];
      case 'prepend':
        if (target) {
          return [insideStart(target)];
        }
        return [blockAt(first ? first.start : 0, blockContent(content))];
      case 'replace':
      case 'rewrite': {
        if (!target) {
          return [];
        }
        const replacement = blockContent(content);
        return [replacement === '' ? removal(target) : plain(target.start, target.end, replacement)];
      }
      case 'delete':
        return target ? [removal(target)] : [];
      case 'move':
      case 'reorder': {
        if (!target) {
          return [];
        }
        const destination = findBlock(doc, op.destination_block_id);
        const pos = destination ? destination.end : first ? first.start : 0;
        return [removal(target), blockAt(pos, target.text)];
      }
      case 'merge': {
        const next = target ? doc.blocks[target.index + 1] : undefined;
        if (!target || !next) {
          return [];
        }
        const joiner = target.kind === 'list' && next.kind === 'list' ? '\n' : ' ';
        return [plain(target.end, next.start, joiner)];
      }
      case 'split': {
        if (!target || op.split_at === null) {
          return [];
        }
        const head = target.text.slice(0, op.split_at).replace(/\s+$/, '');
        const tail = target.text.slice(op.split_at).replace(/^\s+/, '');
        return [plain(target.start, target.end, `${head}\n\n${tail}`)];
      }
      case 'format':
        return target && op.formatting_metadata ? [plain(target.start, target.end, formatBlock(target, op.formatting_metadata))] : [];
      case 'create_section': {
        const meta: Record<string, string> = op.formatting_metadata ?? {};
        const level = headingLevel(meta) ?? sectionLevel(doc, target ?? last) ?? 1;
        const heading = `${'#'.repeat(level)} ${(meta.title ?? '').trim()}`;
        const body = blockContent(content);
        const section = body === '' ? heading : `${heading}\n\n${body}`;
        return [blockAt(target ? target.end : last ? last.end : text.length, section)];
      }
      case 'find_replace': {
        const find = op.find ?? '';
        const edits: Edit[] = [];
        let index = find === '' ? -1 : text.indexOf(find);
        while (index !== -1) {
          edits.push(plain(index, index + find.length, op.replace_with ?? ''));
          index = text.indexOf(find, index + find.length);
        }
        return edits;
      }
      default:
        return [];
    }
  }

  const zeroWidth = (edit: Edit): boolean => edit.start === edit.end;

  function overlaps(a: Edit, b: Edit): boolean {
    if (zeroWidth(a) && zeroWidth(b)) {
      return false;
    }
    if (zeroWidth(a)) {
      return b.start < a.start && a.start < b.end;
    }
    if (zeroWidth(b)) {
      return a.start < b.start && b.start < a.end;
    }
    return a.start < b.end && b.start < a.end;
  }

  /**
   * Removals of neighbouring blocks become one removal per run of blocks (so the blank lines around the run are
   * removed once); the same block removed twice keeps its second removal, which then conflicts with the first.
   */
  function joinRemovals(doc: CodePadDocument, edits: Edit[]): Edit[] {
    const others: Edit[] = [];
    const duplicates: Edit[] = [];
    const byIndex = new Map<number, Edit>();
    for (const edit of edits) {
      const block = edit.removes === null ? undefined : findBlock(doc, edit.removes);
      if (!block) {
        others.push(edit);
      } else if (byIndex.has(block.index)) {
        duplicates.push(edit);
      } else {
        byIndex.set(block.index, edit);
      }
    }
    const indices = [...byIndex.keys()].sort((a, b) => a - b);
    const joined: Edit[] = [];
    let from = 0;
    while (from < indices.length) {
      let to = from;
      while (to + 1 < indices.length && indices[to + 1] === indices[to] + 1) {
        to += 1;
      }
      const firstBlock = doc.blocks[indices[from]];
      const lastBlock = doc.blocks[indices[to]];
      const next = doc.blocks[lastBlock.index + 1];
      const previous = firstBlock.index > 0 ? doc.blocks[firstBlock.index - 1] : undefined;
      const [start, end] = next ? [firstBlock.start, next.start] : previous ? [previous.end, lastBlock.end] : [firstBlock.start, lastBlock.end];
      const order = Math.min(...indices.slice(from, to + 1).map((index) => byIndex.get(index)?.order ?? 0));
      joined.push({ start, end, text: '', order, block: false, removes: firstBlock.id });
      from = to + 1;
    }
    return [...others, ...joined, ...duplicates];
  }

  /** Several whole-block inserts at one place become one insert (in batch order) so they get one blank line each. */
  function groupBlockInserts(text: string, edits: Edit[]): Edit[] {
    const groups = new Map<number, Edit[]>();
    const rest: Edit[] = [];
    for (const edit of edits) {
      if (edit.block) {
        const group = groups.get(edit.start) ?? [];
        group.push(edit);
        groups.set(edit.start, group);
      } else {
        rest.push(edit);
      }
    }
    for (const [pos, group] of groups) {
      group.sort((a, b) => a.order - b.order);
      const contents = group.map((edit) => edit.text).filter((content) => content !== '');
      if (contents.length > 0) {
        rest.push({ start: pos, end: pos, text: blockInsertion(text, pos, contents.join('\n\n')), order: group[0].order, block: true, removes: null });
      }
    }
    return rest;
  }

  const withStatus = (op: CodePadDocOperation, status: CodePadOpStatus): CodePadDocOperation => ({ ...op, execution_status: status });

  /**
   * Applies operations atomically.
   * @param doc The current document.
   * @param operations The batch, in order.
   * @param applied Ids already executed (a retry): they are skipped.
   * @returns The new text, the operations with their status and the line diff; or the error with the failing
   *   operation 'failed' and the others 'rejected' (skipped ones stay 'skipped').
   */
  function apply(doc: CodePadDocument, operations: CodePadDocOperation[], applied?: ReadonlySet<string>): CodePadOpsResult {
    const skipped = (op: CodePadDocOperation): boolean => applied !== undefined && applied.has(op.operation_id);
    const failWith = (failing: number, error: string): CodePadOpsResult => ({
      ok: false,
      error,
      operations: operations.map((op, index) => withStatus(op, skipped(op) ? 'skipped' : index === failing ? 'failed' : 'rejected')),
    });
    const seenIds = new Set<string>();
    let edits: Edit[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      if (skipped(op)) {
        continue;
      }
      if (seenIds.has(op.operation_id)) {
        return failWith(index, 'The same operation appears twice in the batch.');
      }
      seenIds.add(op.operation_id);
      const check = validate(doc, op);
      if (!check.ok) {
        return failWith(index, check.error);
      }
      edits.push(...editsOf(doc, op, index));
    }
    edits = groupBlockInserts(doc.text, joinRemovals(doc, edits));
    for (let i = 0; i < edits.length; i += 1) {
      for (let j = i + 1; j < edits.length; j += 1) {
        if (overlaps(edits[i], edits[j])) {
          const later = Math.max(edits[i].order, edits[j].order);
          const earlier = Math.min(edits[i].order, edits[j].order);
          const message =
            later === earlier
              ? 'The operation changes the same text twice.'
              : `Operation ${operations[later].operation_id} overlaps operation ${operations[earlier].operation_id}.`;
          return failWith(later, message);
        }
      }
    }
    // Same result as applying from the last edit to the first: an insert at the start of a replaced range comes first.
    edits.sort((a, b) => a.start - b.start || Number(!zeroWidth(a)) - Number(!zeroWidth(b)) || a.order - b.order);
    let text = '';
    let cursor = 0;
    for (const edit of edits) {
      text += doc.text.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
    text += doc.text.slice(cursor);
    return {
      ok: true,
      text,
      operations: operations.map((op) => withStatus(op, skipped(op) ? 'skipped' : 'applied')),
      changes: diff(doc.text, text),
    };
  }

  interface DiffStep {
    kind: 'same' | 'removed' | 'added';
    line: string;
  }

  /** LCS steps of two line arrays (both at most MAX_DIFF_LINES long). */
  function lcsSteps(a: readonly string[], b: readonly string[]): DiffStep[] {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    const steps: DiffStep[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        steps.push({ kind: 'same', line: a[i] });
        i += 1;
        j += 1;
      } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        steps.push({ kind: 'removed', line: a[i] });
        i += 1;
      } else {
        steps.push({ kind: 'added', line: b[j] });
        j += 1;
      }
    }
    return steps;
  }

  /**
   * Line diff of two LF texts.
   * @param before Old text.
   * @param after New text.
   * @returns Hunks of consecutive changed lines, ids 'c1', 'c2', ...
   */
  function diff(before: string, after: string): CodePadDocChange[] {
    if (before === after) {
      return [];
    }
    const a = before.split('\n');
    const b = after.split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) {
      head += 1;
    }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
      tail += 1;
    }
    const middleA = a.slice(head, a.length - tail);
    const middleB = b.slice(head, b.length - tail);
    if (middleA.length > MAX_DIFF_LINES || middleB.length > MAX_DIFF_LINES) {
      return [{ id: 'c1', beforeStart: head, beforeEnd: a.length - tail, afterStart: head, afterEnd: b.length - tail, removed: middleA, added: middleB }];
    }
    const changes: CodePadDocChange[] = [];
    let lineA = head;
    let lineB = head;
    let open: CodePadDocChange | null = null;
    for (const step of lcsSteps(middleA, middleB)) {
      if (step.kind === 'same') {
        open = null;
        lineA += 1;
        lineB += 1;
        continue;
      }
      if (!open) {
        open = { id: `c${changes.length + 1}`, beforeStart: lineA, beforeEnd: lineA, afterStart: lineB, afterEnd: lineB, removed: [], added: [] };
        changes.push(open);
      }
      if (step.kind === 'removed') {
        open.removed.push(step.line);
        lineA += 1;
        open.beforeEnd = lineA;
      } else {
        open.added.push(step.line);
        lineB += 1;
        open.afterEnd = lineB;
      }
    }
    return changes;
  }

  /**
   * Applies only the accepted hunks.
   * @param before The old text the hunks were computed on.
   * @param changes Hunks of `diff(before, after)`.
   * @param accepted Ids of the hunks to apply.
   * @returns The old text with the accepted hunks applied (all accepted = the new text).
   */
  function applyChanges(before: string, changes: CodePadDocChange[], accepted: ReadonlySet<string>): string {
    const lines = before.split('\n');
    const ordered = [...changes].sort((x, y) => x.beforeStart - y.beforeStart);
    const out: string[] = [];
    let cursor = 0;
    for (const change of ordered) {
      if (change.beforeStart < cursor) {
        continue;
      }
      out.push(...lines.slice(cursor, change.beforeStart));
      out.push(...(accepted.has(change.id) ? change.added : lines.slice(change.beforeStart, change.beforeEnd)));
      cursor = change.beforeEnd;
    }
    out.push(...lines.slice(cursor));
    return out.join('\n');
  }

  return { newId, create, validate, apply, diff, applyChanges };
});
