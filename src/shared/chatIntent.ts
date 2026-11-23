/*
 * Deterministic intent parser of the AI chat assistant. It decides WHAT the user wants (the id of a chat tool, see
 * renderer/features/ai-chat-tools.ts, or a plain answer), which file is meant and, where it applies, the new name or the
 * text to find / replace / append, from the sentence alone.
 * No AI, no DOM, no Node API: the same file is a Node module and a renderer <script> (window.CodePadChatIntent), so the
 * rules can be tested without the model. The AI is only used afterwards to write text.
 */
(function (root: { CodePadChatIntent?: CodePadChatIntentApi }, factory: () => CodePadChatIntentApi) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodePadChatIntent = factory();
  }
})(globalThis, () => {
  const POLITE = '(?:please\\s+|can you\\s+|could you\\s+|would you\\s+|i want you to\\s+|i would like you to\\s+|i\'d like you to\\s+|just\\s+)*';
  const THIS_FILE = '(?:this|the|current|that|my|open|active)\\s+(?:file|tab|document|doc|text)';
  const EDIT_VERBS =
    /\b(rewrite|re-write|rephrase|restructure|reformat|reword|re-order|reorder|reorganize|reorganise|shorten|condense|lengthen|expand|proofread|polish|improve|simplify|paraphrase|fix|correct|clean up|tidy|translate|capitalize|capitalise|indent|sort|dedupe|format|convert|bullet|bulleted|numbered|break|split|divide|merge|combine|elaborate)\b/;
  const EDIT_PHRASES = /\b(make (it|this|the (text|file|document)|them)\b.*\b(formal|informal|casual|concise|shorter|longer|professional|friendly|polite|clearer|simpler|bullet|technical|detailed|engaging|persuasive)|turn (it|this|the (text|file|document))\b.* into|bullet points?|in bullets|as a list|more formal|less formal|(?:remove|delete|strip|clear|erase|get rid of|drop)\b[^.]{0,40}\b(?:tags?|html|xml|markup|formatting|blank lines?|empty lines?|duplicates?|extra (?:spaces|whitespace|lines)|punctuation))\b/;
  const CREATE_VERB = /\b(create|make|generate|write|add|start|new)\b[^.]{0,30}?\b(?:new\s+)?(file|document|doc|note|notes|script|page|readme)\b/;
  const REFERS_TO_CURRENT = /\b(this|the (file|document|doc|text|email|mail|code|note|notes|tab|content)|above|current|open (file|tab)|here)\b/;
  /** "remove the html tags", "strip the markup": exact work, done by a rule instead of the model. */
  const TAG_REMOVAL = /\b(?:remove|delete|strip|clear|erase|get rid of|drop)\b[^.]{0,40}\b(?:html|xml|markup|tags?)\b/i;
  /** Exact whole-text operations done by a rule, in the order they are tested ("remove duplicate lines" before "remove all content"). */
  const TRANSFORMS: ReadonlyArray<readonly [CodePadChatTransform, RegExp]> = [
    ['dedupe-lines', /\b(?:(?:remove|delete|drop|strip)\b[^.]{0,20}\b(?:duplicate|duplicated|repeated)\b[^.]{0,15}\blines?|dedupe|unique lines)\b/],
    ['remove-blank-lines', /\b(?:remove|delete|drop|strip)\b[^.]{0,20}\b(?:blank|empty)\s+lines?\b/],
    ['trim-spaces', /\b(?:trim|remove|strip|delete)\b[^.]{0,20}\b(?:trailing|leading|extra)\s+(?:spaces|whitespace)\b/],
    ['sort-lines', /\bsort\b[^.]{0,30}\b(?:lines?|list|file|text|alphabetically)\b/],
    ['uppercase', /\b(?:upper ?case|all caps|capital letters)\b/],
    ['lowercase', /\b(?:lower ?case|small letters)\b/],
    [
      'clear',
      /\b(?:clear|empty|wipe|erase|delete|remove|discard)\b[^.]{0,25}\b(?:all|whole|entire|everything|complete)\b[^.]{0,25}\b(?:content|contents|text)\b|\b(?:clear|empty|wipe)\s+(?:out\s+)?(?:this|the|current|that)\s+(?:file|tab|document|text)\b/,
    ],
  ];
  /** What a "write / insert ..." request asks to produce, or a topic marker ("about", "related to"). */
  const CONTENT_WORDS =
    /\b(?:content|text|paragraphs?|sentences?|lines?|article|essay|code|function|class|script|snippet|json|data|examples?|section|description|story|email|summary|notes?|list|outline|table|config|configuration|query|html|css|related to|about|regarding|on the topic of)\b/;
  const FILE_WORD = /\b(?:file|tab|document|doc)\b/;
  /** A question rather than a command ("how do you translate hello into French?"). */
  const QUESTION = /^(?:how|what|why|when|where|which|who)\b/;
  /**
   * "move the second paragraph after the third paragraph", "move the section Pricing to the end": groups are the lead,
   * the source place, the relation and the destination place (empty for start/end).
   */
  const MOVE_BLOCK = new RegExp(
    `^(${POLITE}(?:move|shift|reorder)\\s+)((?:the\\s+|this\\s+)?(?:[a-z0-9-]+\\s+)?(?:paragraph|section|heading|block|list|table)\\b(?:\\s+["'\`]?[^"'\`]*?["'\`]?)?)\\s+(before|after|above|below|to the (?:start|beginning|top|end|bottom)|(?:start|beginning|top|end|bottom))\\b\\s*(.*?)\\s*[.!]?$`,
  );
  /** "complete this essay", "finish the story", "read the content and write the essay": the file itself is to be completed. */
  const COMPLETION = new RegExp(
    `^${POLITE}(?:complete|finish|continue|extend|flesh out|carry on with)\\s+(?:this|the|my|it|that|writing|essay|article|story|text|document|file|paragraph|letter|email|draft|content)\\b` +
      `|^${POLITE}(?:read|use|take)\\b[^.]{0,40}\\b(?:content|text|file|document|above)\\b[^.]{0,60}\\b(?:write|complete|finish|continue|expand)\\b`,
  );
  const QUOTED = '(["\'`])([^"\'`]+)\\1';
  /** Verbs that put new content into a document (insert-at). */
  const INSERT_VERB = '(?:add|insert|put|write|type|place|include|append|prepend|paste)';
  /** Words that name a block of a document; a "before / after X" place must contain one. */
  const PLACE_WORDS = /\b(?:paragraphs?|para|lines?|sections?|headings?|header|title|chapter|list|table|block|intro(?:duction)?|conclusion|summary)\b/i;
  const ORDINAL = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|current|final|opening|closing|\\d+(?:st|nd|rd|th)?)';
  /** A place reference starts like one: "the second paragraph", "line 4", "this section", "paragraph 2". */
  const REF_START = new RegExp(`^(?:the|this|that|my|${ORDINAL}|paragraphs?|para|lines?|sections?|headings?|header|title|chapter|list|table|intro(?:duction)?|conclusion)\\b`, 'i');
  /** "the second paragraph", "line 4", "the section Pricing" (the object of "to" in an append-to-block request). */
  const BLOCK_REF = `(?:the\\s+|this\\s+|that\\s+)?(?:${ORDINAL}\\s+)?(?:paragraph|line|sentence|section|heading)\\b(?:\\s+\\d+|\\s+["'\`][^"'\`]+["'\`]|\\s+[A-Z][\\w-]*)?`;
  /** File words after "end of" / "start of": the whole document, not a block. */
  const DOC_WORDS = /^(?:this|the|current|that|my|whole|entire|open|active)?\s*(?:file|tab|document|doc|text|page)\b/i;
  /** "it / this / the answer": the pending answer of a follow-up. */
  const PRONOUN = '(?:it|this|that|this text|that text|the answer|your answer|the result|the reply|the text above|the above)';
  /** Requests that analyse a whole document (a deterministic report plus AI suggestions). */
  const ANALYZE =
    /\b(?:analy[sz]e|review|assess|evaluate|critique|audit)\b[^.]{0,30}?\b(?:document|doc|file|text|essay|article|report|draft|paper|content|it|this)\b|\bwhat\s+is\s+(?:this|the|my)\s+(?:document|doc|file|text|essay|article|report)\s+about\b|\b(?:find|identify|list|show|detect|check for)\s+(?:the\s+|any\s+)?(?:missing\s+sections?|inconsistenc(?:y|ies))\b/;
  const TOC = /\btable of contents\b|\btoc\b(?!\.)/;
  const OUTLINE = new RegExp(
    `^${POLITE}(?:(?:generate|create|make|build|show|give me|get|produce|write|insert|add)\\s+)?(?:me\\s+)?(?:an?\\s+|the\\s+)?outline\\b(?:\\s+(?:of|for)\\s+${THIS_FILE})?\\s*[.!?]?$`,
  );
  const DUPLICATES =
    /\b(?:find|show|list|detect|check(?:\s+for)?|are there|search for|look for)\b[^.]{0,30}\b(?:duplicate|duplicated|repeated|identical)\s+(?:paragraphs?|content|text|sentences?|sections?|blocks?|passages?)\b|\brepeated content\b/;
  /** Words that never name a target language. */
  const NOT_LANGUAGE = new Set(['the', 'this', 'that', 'my', 'a', 'an', 'it', 'line', 'paragraph', 'file', 'document', 'doc', 'selection', 'text', 'please', 'language', 'and', 'then', 'now']);

  const clean = (text: string): string => text.trim().replace(/\s+/g, ' ');
  const stripPunctuation = (token: string): string => token.replace(/^["'`([]+/, '').replace(/["'`)\],;:!?]+$/, '').replace(/\.+$/, '');
  const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** A file-like token (name.ext) or a quoted name, in order of appearance. */
  function fileTokens(text: string): string[] {
    const found: { index: number; value: string }[] = [];
    for (const match of text.matchAll(/["'`]([^"'`\\/:*?<>|\r\n]{1,100})["'`]/g)) {
      found.push({ index: match.index ?? 0, value: match[1].trim() });
    }
    for (const match of text.matchAll(/(?<![\w.-])[\w\-()[\]]+(?:\.[\w\-()[\]]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w-])/g)) {
      if (!found.some((entry) => match.index !== undefined && match.index >= entry.index && match.index < entry.index + entry.value.length + 2)) {
        found.push({ index: match.index ?? 0, value: match[0] });
      }
    }
    return found.sort((a, b) => a.index - b.index).map((entry) => entry.value).filter((value) => value.length > 0);
  }

  /** The longest open tab name that occurs in the sentence (case-insensitive), or null. */
  function matchOpenName(text: string, openNames: readonly string[], exclude?: string | null): string | null {
    const lower = text.toLowerCase();
    const candidates = [...openNames]
      .filter((name) => name.length > 0 && name.toLowerCase() !== (exclude ?? '').toLowerCase())
      .sort((a, b) => b.length - a.length);
    for (const name of candidates) {
      const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(name.toLowerCase())}(?![\\w-])`);
      if (pattern.test(lower)) {
        return name;
      }
    }
    return null;
  }

  /** The file the sentence names: an open tab name, else the first file-like token (excluding `exclude`), else null. */
  function findTarget(text: string, openNames: readonly string[], exclude?: string | null): string | null {
    const open = matchOpenName(text, openNames, exclude);
    if (open) {
      return open;
    }
    const token = fileTokens(text).find((value) => value.toLowerCase() !== (exclude ?? '').toLowerCase());
    return token ?? null;
  }

  /** The name that follows "to / as / called / named / into" (quoted names may contain spaces). */
  function nameAfterKeyword(text: string, keywords: string): string | null {
    const quoted = new RegExp(`\\b(?:${keywords})\\s+["'\`]([^"'\`\\\\/:*?<>|\\r\\n]{1,100})["'\`]`, 'i').exec(text);
    if (quoted) {
      return quoted[1].trim();
    }
    const plain = new RegExp(`\\b(?:${keywords})\\s+(?:(?:a|an|the|new|file|document)\\s+)*([^\\s"'\`]+)`, 'i').exec(text);
    if (!plain) {
      return null;
    }
    const value = stripPunctuation(plain[1]);
    return value.length > 0 && !/^(this|that|it|file|new|another|a|an|the)$/i.test(value) ? value : null;
  }

  /** The part of the sentence after "with / containing / that says ..." (the content to write), else the whole sentence. */
  function contentPart(text: string): string {
    const match = /\b(?:with|containing|contains|that says|that has|which has|saying|about|including)\b\s*:?\s*(.+)$/i.exec(text);
    return clean(match ? match[1] : text);
  }

  /** "replace A with B" (quoted, or single words): the two strings and the sentence without them, else null. */
  function findReplacePair(text: string): { find: string; replaceWith: string; rest: string } | null {
    const lead = 'replace\\s+(?:all\\s+)?(?:(?:occurrences|instances)\\s+of\\s+)?(?:the\\s+)?(?:(?:word|text|string|phrase)\\s+)?';
    const quoted = new RegExp(`\\b${lead}${QUOTED}\\s+(?:with|by)\\s+(?:(["'\`])([^"'\`]*)\\3|(\\S+))`, 'i').exec(text);
    if (quoted) {
      const value = quoted[4] !== undefined ? quoted[4] : stripPunctuation(quoted[5] ?? '');
      return { find: quoted[2], replaceWith: value, rest: text.replace(quoted[0], ' ') };
    }
    const plain = new RegExp(`\\b${lead}([^\\s"'\`]+)\\s+(?:with|by)\\s+([^\\s"'\`]+)`, 'i').exec(text);
    if (!plain) {
      return null;
    }
    return { find: stripPunctuation(plain[1]), replaceWith: stripPunctuation(plain[2]), rest: text.replace(plain[0], ' ') };
  }

  const result = (
    action: CodePadChatAction,
    text: string,
    target: string | null,
    extra: Partial<CodePadChatIntent> = {},
  ): CodePadChatIntent => ({
    action,
    target,
    newName: null,
    instruction: clean(text),
    useCurrent: false,
    literal: null,
    find: null,
    replaceWith: null,
    transform: null,
    descending: false,
    selectionOnly: false,
    completion: false,
    position: null,
    placeText: null,
    intoList: false,
    language: null,
    steps: [],
    followUp: null,
    ...extra,
  });

  /** The steps of "A and then B" / "A; then B" / "1. A 2. B" (a preamble ending in ':' is dropped); one entry when there are none. */
  function splitSteps(text: string): string[] {
    const numbered = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s+/g)];
    if (numbered.length >= 2 && numbered[0][1] === '1' && numbered[1][1] === '2') {
      const first = numbered[0].index ?? 0;
      const preamble = text.slice(0, first).trim();
      if (preamble === '' || preamble.endsWith(':')) {
        return text
          .slice(first)
          .split(/(?:^|\s)\d{1,2}[.)]\s+/)
          .map((step) => clean(step).replace(/[;,]\s*$/, ''))
          .filter((step) => step !== '');
      }
    }
    return text
      .split(/\s*[,;]?\s+and\s+then\s+|\s*[;,]\s*then\s+|(?<=[.!?])\s+then\s*,?\s+/i)
      .map((step) => clean(step).replace(/[.;,]\s*$/, ''))
      .filter((step) => step !== '');
  }

  /** Position of a "before / after / below ..." keyword. */
  const sideOf = (word: string): CodePadChatPosition => (/^(?:before|above|preceding)$/i.test(word) ? 'before' : 'after');

  /**
   * The place of an insert-at request: position, the words naming the block, whether it goes into a list, and the
   * sentence without the place (what to write). Null when the sentence names no place in the document.
   */
  function insertPlace(text: string): { position: CodePadChatPosition; placeText: string | null; intoList: boolean; rest: string } | null {
    const lower = text.toLowerCase();
    if (!new RegExp(`^${POLITE}${INSERT_VERB}\\b`).test(lower)) {
      return null;
    }
    const cut = (match: RegExpExecArray): string => clean(text.slice(0, match.index) + text.slice(match.index + match[0].length));
    const list = /\s*\b(?:to|into|in|at the end of)\s+(?:the\s+|my\s+|this\s+)?(?:existing\s+|current\s+|bullet(?:ed)?\s+|numbered\s+)?list\b(?:\s+(?:of|in)\s+[^.]*)?/i.exec(text);
    if (list) {
      return { position: 'inside_end', placeText: null, intoList: true, rest: cut(list) };
    }
    const side = /\s*\b(before|after|above|below|underneath|under|following|preceding)\s+(.+?)\s*[.!?]?$/i.exec(text);
    if (side && REF_START.test(side[2]) && PLACE_WORDS.test(side[2]) && !DOC_WORDS.test(side[2])) {
      return { position: sideOf(side[1].toLowerCase() === 'underneath' ? 'under' : side[1]), placeText: side[2], intoList: false, rest: cut(side) };
    }
    const startOf = /\s*\b(?:at|to)\s+the\s+(?:very\s+)?(?:start|beginning|top)\b(?:\s+of\s+(.+?))?\s*[.!?]?$/i.exec(text);
    if (startOf) {
      const place = startOf[1];
      if (place && PLACE_WORDS.test(place) && !DOC_WORDS.test(place)) {
        return { position: 'before', placeText: place, intoList: false, rest: cut(startOf) };
      }
      return { position: 'start', placeText: null, intoList: false, rest: cut(startOf) };
    }
    const endOf = /\s*\b(?:at|to)\s+the\s+(?:very\s+)?end\s+of\s+(.+?)\s*[.!?]?$/i.exec(text);
    if (endOf && PLACE_WORDS.test(endOf[1]) && !DOC_WORDS.test(endOf[1])) {
      return { position: 'inside_end', placeText: endOf[1], intoList: false, rest: cut(endOf) };
    }
    const into = new RegExp(`\\s*\\b(?:to|into)\\s+(${BLOCK_REF}(?:\\s+(?:of|in)\\s+[^.!?]+)?)\\s*[.!?]?$`, 'i').exec(text);
    if (into) {
      return { position: 'inside_end', placeText: into[1], intoList: false, rest: cut(into) };
    }
    const atLine = /\s*\bat\s+(line\s+\d+)\b/i.exec(text);
    if (atLine) {
      return { position: 'before', placeText: atLine[1], intoList: false, rest: cut(atLine) };
    }
    if (new RegExp(`^${POLITE}prepend\\b`).test(lower)) {
      const target = /\s*\bto\s+(?:the\s+)?(?:start\s+of\s+)?(.+?)\s*[.!?]?$/i.exec(text);
      if (target && PLACE_WORDS.test(target[1]) && !DOC_WORDS.test(target[1])) {
        return { position: 'before', placeText: target[1], intoList: false, rest: cut(target) };
      }
      return { position: 'start', placeText: null, intoList: false, rest: target && DOC_WORDS.test(target[1]) ? cut(target) : text };
    }
    // "add a heading Summary at the end": a heading is its own block at the end of the document
    const atEnd = /\s*\b(?:at|to)\s+the\s+(?:very\s+)?(?:end|bottom)\b(?:\s+of\s+(?:this|the|my|current)\s+(?:file|document|doc|text))?\s*[.!?]?$/i.exec(text);
    if (atEnd && /\b(?:heading|title|section|header)\b/i.test(text.slice(0, atEnd.index))) {
      return { position: 'end', placeText: null, intoList: false, rest: cut(atEnd) };
    }
    return null;
  }

  /** Quoted text right after the insert verb ("add the heading 'Summary' after ..."), or null. */
  function quotedContent(text: string): string | null {
    const match = new RegExp(
      `^${POLITE}${INSERT_VERB}\\s+(?:(?:a|an|the)\\s+)?(?:(?:new\\s+)?(?:text|line|word|words|sentence|heading|title|paragraph|note|item|bullet|point)\\s+)?(?:(?:called|named|saying|that says)\\s+)?${QUOTED}`,
      'i',
    ).exec(text);
    return match ? match[2] : null;
  }

  /**
   * A follow-up on the pending answer ("append it to my document", "insert it after the second paragraph"), or null. The
   * document is only ever changed on the selected text, so "append" puts the answer after the selection and a place
   * names a block of the selected text.
   */
  function followUpIntent(text: string, lower: string): CodePadChatIntent | null {
    if (new RegExp(`\\breplace\\s+(?:the\\s+|my\\s+)?(?:current\\s+)?(?:selection|selected text|highlighted text)\\s+(?:with|by)\\s+${PRONOUN}\\s*[.!?]?$`).test(lower)) {
      return result('follow-up', text, null, { followUp: 'replace-selection' });
    }
    const lead = `^${POLITE}(?:append|add|insert|put|paste|place|copy|move)\\s+${PRONOUN}\\s+`;
    if (new RegExp(`${lead}(?:(?:after|below|following)|(?:at|to)\\s+the\\s+end\\s+of)\\s+(?:the\\s+)?(?:selection|selected text|highlighted text)\\s*[.!?]?$`).test(lower)) {
      return result('follow-up', text, null, { followUp: 'append' });
    }
    if (new RegExp(`${lead}(?:(?:to|into|in)\\s+${THIS_FILE}|(?:at|to)\\s+the\\s+(?:end|bottom)(?:\\s+of\\s+${THIS_FILE})?)\\s*[.!?]?$`).test(lower)) {
      return result('follow-up', text, null, { followUp: 'append' });
    }
    if (new RegExp(`${lead}(?:at|to)\\s+the\\s+(?:very\\s+)?(?:start|beginning|top)(?:\\s+of\\s+${THIS_FILE})?\\s*[.!?]?$`).test(lower)) {
      return result('follow-up', text, null, { followUp: 'insert', position: 'start' });
    }
    const side = new RegExp(`${lead}(before|after|above|below|under|following|preceding)\\s+(.+?)\\s*[.!?]?$`, 'i').exec(text);
    if (side) {
      return result('follow-up', text, null, { followUp: 'insert', position: sideOf(side[1]), placeText: side[2] });
    }
    return null;
  }

  /** The language after the last "to / into" of a translate request ("to Brazilian Portuguese"), or null. */
  function targetLanguage(text: string): string | null {
    const matches = [...text.matchAll(/\b(?:to|into|in)\s+([A-Za-zÀ-ɏ][\wÀ-ɏ-]*(?:\s+[A-Za-zÀ-ɏ][\wÀ-ɏ-]*)?)/g)];
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const words = matches[index][1].split(/\s+/).filter((word) => !NOT_LANGUAGE.has(word.toLowerCase()));
      if (words.length > 0 && !NOT_LANGUAGE.has(matches[index][1].split(/\s+/)[0].toLowerCase()) && fileTokens(words.join(' ')).length === 0) {
        return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      }
    }
    return null;
  }

  /**
   * Derives the intent from one user sentence.
   * @param input The user's message.
   * @param openNames Names of the open tabs (matched case-insensitively against the sentence).
   * @returns The action, the file the sentence names (null = the active tab), the new name for rename / create /
   *   extract (null when none was given), the instruction for the AI and whether the active file's text is needed.
   */
  function parseIntent(input: string, openNames: readonly string[] = []): CodePadChatIntent {
    return parseOne(input, openNames, true);
  }

  function parseOne(input: string, openNames: readonly string[], allowSteps: boolean): CodePadChatIntent {
    const text = clean(input);
    const lower = text.toLowerCase();

    // several steps in one message: "rewrite it formally and then add a heading at the start", "1. ... 2. ..."
    if (allowSteps && !COMPLETION.test(lower)) {
      const steps = splitSteps(text);
      if (steps.length >= 2 && steps.length <= 8 && steps.every((step) => parseOne(step, openNames, false).action !== 'answer')) {
        return result('multi-step', text, null, { steps });
      }
    }

    // follow-ups on the pending answer card: "append it to my document", "insert it after the second paragraph"
    const followUp = followUpIntent(text, lower);
    if (followUp) {
      return followUp;
    }

    // complete or continue the text of the file: before every other rule, so "complete it and then translate it" stays a completion
    if (COMPLETION.test(lower)) {
      return result('edit-file', text, findTarget(text, openNames), { useCurrent: true, completion: true });
    }

    // move a paragraph / section / heading within the document: "move the second paragraph after the third paragraph"
    const moveBlock = MOVE_BLOCK.exec(lower);
    if (moveBlock) {
      return result('move-block', text, findTarget(text, openNames), {
        useCurrent: true,
        // places are matched without case (CodePadDocModel.resolve), so the lower-case parts are enough
        placeText: moveBlock[2],
        position: moveBlock[3] === 'before' || moveBlock[3] === 'above' ? 'before' : /^(?:to the )?(?:start|beginning|top)/.test(moveBlock[3]) ? 'start' : /^(?:to the )?(?:end|bottom)/.test(moveBlock[3]) ? 'end' : 'after',
        newName: moveBlock[4],
      });
    }

    // save: a short command, "save", "save this file", "save notes.txt"
    if (new RegExp(`^${POLITE}save\\b(?!.*\\b(?:as|into|to)\\b)`).test(lower) && lower.length <= 80 && !/\b(extract|summar|key points|results?)\b/.test(lower)) {
      return result('save-file', text, findTarget(text, openNames));
    }

    // summary operations, the same as the AI menu: summarize the file or the selection, cancel, clear the cache
    if (/\bsummar(?:y|ies)\s+cache\b|\bcache\s+of\s+(?:the\s+)?summar/.test(lower) && /\b(?:clear|delete|reset|empty|remove|wipe)\b/.test(lower)) {
      return result('clear-summary-cache', text, null);
    }
    if (/\b(?:cancel|stop|abort)\b[^.]{0,25}\bsummar/.test(lower)) {
      return result('cancel-summary', text, null);
    }
    if (
      (new RegExp(`^${POLITE}summari[sz]e\\b`).test(lower) || /\b(?:give|make|create|write|show|get)\s+(?:me\s+)?(?:a\s+|the\s+)?summary\s+of\b/.test(lower)) &&
      !/\b(?:into|to|in)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:file|document|doc|note|notes)\b|\b(?:into|to|in)\s+["'`]?[\w\-()[\]]+\.[a-z][a-z0-9]{0,7}\b/.test(lower)
    ) {
      return result('summarize-content', text, findTarget(text, openNames), { selectionOnly: /\b(?:selection|selected|highlighted)\b/.test(lower) });
    }

    // duplicate paragraphs / repeated content: a deterministic list, nothing changes
    if (DUPLICATES.test(lower)) {
      return result('find-duplicates', text, findTarget(text, openNames), { useCurrent: true });
    }

    // translate the selected text, or one paragraph of it, into a language (an edit with a diff)
    if (new RegExp(`^${POLITE}translate\\b`).test(lower) || (/\btranslate\b/.test(lower) && /\b(?:to|into)\s+[a-z]/.test(lower) && !QUESTION.test(lower))) {
      // the place is read from the whole sentence by CodePadDocModel.parseRef ("paragraph 2", "the section Pricing")
      return result('translate', text, findTarget(text, openNames), {
        useCurrent: true,
        language: targetLanguage(text),
        placeText: /\b(?:paragraph|section|heading|line)\b/.test(lower) ? text : null,
      });
    }

    // rename
    if (/\b(rename|change (?:the )?(?:file ?)?name|re-name)\b/.test(lower)) {
      const newName = nameAfterKeyword(text, 'to|as|into|called|named');
      return result('rename-file', text, findTarget(text, openNames, newName), { newName });
    }

    // create a folder in the opened folder: "create a folder called drafts", "new folder drafts"
    if (new RegExp(`^${POLITE}(?:(?:create|make|add)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?|new\\s+)(?:folder|directory|sub-?folder)\\b`).test(lower)) {
      const after = /\b(?:folder|directory|sub-?folder)\s+(?!called\b|named\b|in\b|inside\b)["'`]?([^"'`\s]+)["'`]?/i.exec(text);
      const newName = nameAfterKeyword(text, 'called|named|name it') ?? (after ? stripPunctuation(after[1]) : null);
      return result('create-folder', text, null, { newName: newName || null });
    }

    // move a file into a folder of the opened folder: "move notes.txt to archive"
    const move = new RegExp(`^${POLITE}move\\s+(.+?)\\s+(?:to|into|in)\\s+(?:the\\s+)?(?:(?:folder|directory|sub-?folder)\\s+)?(.+?)\\s*[.!]?$`, 'i').exec(text);
    if (move) {
      const source = move[1];
      const target = matchOpenName(source, openNames) ?? fileTokens(source)[0] ?? null;
      if (target || new RegExp(`^${THIS_FILE}$`, 'i').test(source)) {
        const dest = stripPunctuation(move[2].replace(/^["'`]|["'`]$/g, '')).replace(/\s+(?:folder|directory)$/i, '').trim();
        return result('move-file', text, target, { newName: dest || null });
      }
    }

    // find and replace: "replace A with B in this file" (exact text, no AI)
    const pair = findReplacePair(text);
    if (pair) {
      return result('find-replace', text, findTarget(pair.rest, openNames), { find: pair.find, replaceWith: pair.replaceWith });
    }

    // exact text operations: clear the file, change case, sort / de-duplicate lines, trim (no AI)
    if (!TAG_REMOVAL.test(text)) {
      const transform = TRANSFORMS.find(([, pattern]) => pattern.test(lower));
      if (transform) {
        return result('transform-content', text, findTarget(text, openNames), {
          useCurrent: true,
          transform: transform[0],
          descending: /\b(?:descending|reverse|z\s*(?:to|-)\s*a)\b/.test(lower),
        });
      }
    }

    // delete: "remove" only counts when it is followed by a file word or a file name ("remove duplicate lines" is an edit)
    const del = new RegExp(`\\b(delete|trash|erase|remove|get rid of)\\s+(${THIS_FILE}|\\S+)`).exec(lower);
    if (del) {
      const object = stripPunctuation(del[2]);
      const isFile = new RegExp(`^${THIS_FILE}$`).test(del[2]) || matchOpenName(object, openNames) !== null || fileTokens(object).length > 0;
      const quoted = /\b(?:delete|trash|erase|remove)\s+["'`]/.test(lower);
      if (isFile || quoted) {
        return result('delete-file', text, findTarget(text, openNames));
      }
    }

    // close a tab: "close this tab", "close notes.txt"
    if (new RegExp(`^${POLITE}(?:close|shut)\\b`).test(lower)) {
      const target = findTarget(text, openNames);
      if (target || FILE_WORD.test(lower)) {
        return result('close-file', text, target);
      }
    }

    // duplicate: "duplicate this file", "copy notes.txt to notes-old.txt"
    if (new RegExp(`^${POLITE}(?:duplicate|clone|copy|make a copy of)\\b`).test(lower) && !/\b(extract|summar|key points)\b/.test(lower)) {
      const newName = nameAfterKeyword(text, 'to|as|into|called|named');
      const target = findTarget(text, openNames, newName);
      if (target || FILE_WORD.test(lower)) {
        return result('duplicate-file', text, target, { newName });
      }
    }

    // list the files of the folder or the open tabs
    if (new RegExp(`^${POLITE}(?:list|show|display|what|which)\\b[^.]{0,30}?\\b(?:files|tabs|folder|directory)\\b`).test(lower) && !/\b(key points|summar|extract|into)\b/.test(lower)) {
      return result('list-files', text, null);
    }

    // extract: pull information out of a file into a new one, or into a named file
    const intoFile = /\b(?:into|to|in|as)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:file|document|doc|note|notes)\b|\b(?:into|to|in)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+|named\s+)?["'`]?[\w\-()[\]]+\.[a-z][a-z0-9]{0,7}\b/.test(lower);
    if (/\b(extract|pull out|pick out|write down|save)\b/.test(lower) && (intoFile || /\bextract\b/.test(lower))) {
      const newName = nameAfterKeyword(text, 'into|to|in|as|called|named');
      const open = matchOpenName(text, openNames, newName);
      return result('extract-to-file', text, open ?? findTarget(text, openNames, newName), { newName, useCurrent: true });
    }
    if (/\b(list|collect|copy|move|put|summari[sz]e)\b/.test(lower) && intoFile) {
      const newName = nameAfterKeyword(text, 'into|to|in|as|called|named');
      return result('extract-to-file', text, findTarget(text, openNames, newName), { newName, useCurrent: true });
    }

    // analyse a document: a deterministic report and AI suggestions (nothing changes)
    if (ANALYZE.test(lower) && !EDIT_VERBS.test(lower)) {
      return result('analyze-document', text, findTarget(text, openNames), { useCurrent: true });
    }

    // table of contents / outline from the headings (no AI)
    if (TOC.test(lower) || OUTLINE.test(lower)) {
      return result('outline', text, findTarget(text, openNames), {
        useCurrent: true,
        position: /\b(?:at|to)\s+the\s+(?:very\s+)?(?:top|start|beginning)\b/.test(lower) ? 'start' : null,
      });
    }

    // insert new content at a place of the document: "add an example after the second paragraph", "prepend ...",
    // "append three points to the existing list", "add a heading Summary at the end"
    const place = insertPlace(text);
    if (place) {
      // quoted words here are content or headings, so only an open tab name or a name with an extension is a file
      const named = matchOpenName(text, openNames) ?? fileTokens(text).find((token) => /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token)) ?? null;
      return result('insert-at', place.rest, named, {
        useCurrent: true,
        literal: quotedContent(text),
        position: place.position,
        placeText: place.placeText,
        intoList: place.intoList,
      });
    }

    // write new content (text, JSON, code...) into the current file: "insert some content about X", "write a function that Y"
    if (
      new RegExp(`^${POLITE}(?:insert|write|add|generate|compose|draft|produce|put|type)\\b`).test(lower) &&
      CONTENT_WORDS.test(lower) &&
      !/\b(?:new\s+(?:file|document|doc)|called|named)\b|\b(?:at|to|in)\s+the\s+(?:end|bottom)\b|\bappend\b/.test(lower) &&
      !EDIT_VERBS.test(lower)
    ) {
      // "add an example" right after an answer revises that answer (the tool checks that one is pending)
      const revise = new RegExp(`^${POLITE}(?:add|include|give)\\s+(?:an?\\s+|some\\s+|more\\s+|another\\s+)?(?:examples?|details?|statistics|numbers|facts|references)\\b`).test(lower) && !FILE_WORD.test(lower);
      return result('write-content', text, findTarget(text, openNames), { useCurrent: false, followUp: revise ? 'revise' : null });
    }

    // append to the end of a file: "append X to this file", "add X at the end of notes.txt" (X quoted = written as is)
    if (/\bappend\b/.test(lower) || (/\b(?:add|insert|put|write|type)\b/.test(lower) && /\b(?:at|to|in)\s+the\s+(?:end|bottom)\b/.test(lower))) {
      const literal = new RegExp(`\\b(?:append|add|insert|put|write|type)\\s+(?:the\\s+(?:text|line|word)\\s+)?${QUOTED}`, 'i').exec(text);
      const rest = literal ? text.replace(literal[0], ' ') : text;
      return result('append-content', text, findTarget(rest, openNames), { useCurrent: true, literal: literal ? literal[2] : null });
    }

    // create a new file
    if (CREATE_VERB.test(lower) && !EDIT_PHRASES.test(lower)) {
      const newName = nameAfterKeyword(text, 'called|named|name it|as') ?? fileTokens(text)[0] ?? null;
      const content = contentPart(text);
      return result('create-file', content, null, { newName, useCurrent: REFERS_TO_CURRENT.test(lower) });
    }

    // open a named file as a tab ("open this file" is read below)
    if (new RegExp(`^${POLITE}(?:open|load|switch to|go to)\\b`).test(lower)) {
      const target = findTarget(text, openNames);
      if (target) {
        return result('open-file', text, target);
      }
    }

    // read / show
    const readMatch = new RegExp(`^${POLITE}(show|read|open|display|view|print|cat|what(?:'s| is) in)\\b`).exec(lower);
    if (readMatch) {
      const target = findTarget(text, openNames);
      if (target || new RegExp(THIS_FILE).test(lower)) {
        return result('read-file', text, target);
      }
    }

    // remove html tags / markup (exact rule)
    if (TAG_REMOVAL.test(text)) {
      return result('remove-tags', text, findTarget(text, openNames), { useCurrent: true });
    }

    // edit the current file
    if ((EDIT_VERBS.test(lower) && !QUESTION.test(lower)) || EDIT_PHRASES.test(lower)) {
      return result('edit-file', text, findTarget(text, openNames), { useCurrent: true });
    }

    // plain chat; the file text is only sent when the question is about the file
    const target = matchOpenName(text, openNames);
    return result('answer', text, target, { useCurrent: target !== null || REFERS_TO_CURRENT.test(lower) });
  }

  return { parseIntent };
});
