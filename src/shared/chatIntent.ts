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
  const EDIT_PHRASES = /\b(make (it|this|the (text|file|document)|them)\b.*\b(formal|informal|casual|concise|shorter|longer|professional|friendly|polite|clearer|simpler|bullet)|turn (it|this|the (text|file|document))\b.* into|bullet points?|in bullets|as a list|more formal|less formal|(?:remove|delete|strip|clear|erase|get rid of|drop)\b[^.]{0,40}\b(?:tags?|html|xml|markup|formatting|blank lines?|empty lines?|duplicates?|extra (?:spaces|whitespace|lines)|punctuation))\b/;
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
  const QUOTED = '(["\'`])([^"\'`]+)\\1';

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
    ...extra,
  });

  /**
   * Derives the intent from one user sentence.
   * @param input The user's message.
   * @param openNames Names of the open tabs (matched case-insensitively against the sentence).
   * @returns The action, the file the sentence names (null = the active tab), the new name for rename / create /
   *   extract (null when none was given), the instruction for the AI and whether the active file's text is needed.
   */
  function parseIntent(input: string, openNames: readonly string[] = []): CodePadChatIntent {
    const text = clean(input);
    const lower = text.toLowerCase();

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

    // rename
    if (/\b(rename|change (?:the )?(?:file ?)?name|re-name)\b/.test(lower)) {
      const newName = nameAfterKeyword(text, 'to|as|into|called|named');
      return result('rename-file', text, findTarget(text, openNames, newName), { newName });
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

    // write new content (text, JSON, code...) into the current file: "insert some content about X", "write a function that Y"
    if (
      new RegExp(`^${POLITE}(?:insert|write|add|generate|compose|draft|produce|put|type)\\b`).test(lower) &&
      CONTENT_WORDS.test(lower) &&
      !/\b(?:new\s+(?:file|document|doc)|called|named)\b|\b(?:at|to|in)\s+the\s+(?:end|bottom)\b|\bappend\b/.test(lower) &&
      !EDIT_VERBS.test(lower)
    ) {
      return result('write-content', text, findTarget(text, openNames), { useCurrent: false });
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
    if (EDIT_VERBS.test(lower) || EDIT_PHRASES.test(lower)) {
      return result('edit-file', text, findTarget(text, openNames), { useCurrent: true });
    }

    // plain chat; the file text is only sent when the question is about the file
    const target = matchOpenName(text, openNames);
    return result('answer', text, target, { useCurrent: target !== null || REFERS_TO_CURRENT.test(lower) });
  }

  return { parseIntent };
});
