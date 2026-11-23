/*
 * Types of the AI chat intent parser (shared/chatIntent.ts, window.CodePadChatIntent). Nothing here is a module.
 */

/** The action is the id of the chat tool that runs it; 'answer' is the plain chat answer. */
type CodePadChatAction =
  | 'edit-file'
  | 'create-file'
  | 'extract-to-file'
  | 'rename-file'
  | 'delete-file'
  | 'save-file'
  | 'read-file'
  | 'remove-tags'
  | 'transform-content'
  | 'summarize-content'
  | 'cancel-summary'
  | 'clear-summary-cache'
  | 'write-content'
  | 'list-files'
  | 'duplicate-file'
  | 'append-content'
  | 'find-replace'
  | 'open-file'
  | 'close-file'
  | 'insert-at'
  | 'analyze-document'
  | 'outline'
  | 'find-duplicates'
  | 'translate'
  | 'move-file'
  | 'move-block'
  | 'create-folder'
  | 'multi-step'
  | 'follow-up'
  | 'answer';

/** Where insert-at puts new content: around a block, at the end of its own text, or at the start / end of the document. */
type CodePadChatPosition = 'before' | 'after' | 'inside_end' | 'start' | 'end';

/**
 * What a follow-up does with the pending answer card: 'append' puts it after the selected text, 'insert' at a place of
 * the selected text, 'replace-selection' replaces the selection, 'revise' changes the answer itself.
 */
type CodePadChatFollowUp = 'append' | 'insert' | 'replace-selection' | 'revise';

/** Whole-text operations done by a rule (the transform-content tool). */
type CodePadChatTransform = 'clear' | 'uppercase' | 'lowercase' | 'sort-lines' | 'dedupe-lines' | 'remove-blank-lines' | 'trim-spaces';

interface CodePadChatIntent {
  action: CodePadChatAction;
  /** File name the sentence mentions (an open tab name or a file-like token); null means the active tab. */
  target: string | null;
  /** New file name for rename / create / extract / duplicate; null when the sentence gave none. */
  newName: string | null;
  /** What to tell the AI (for create: the content part of the sentence). */
  instruction: string;
  /** True when the text of the active/mentioned file is needed to answer. */
  useCurrent: boolean;
  /** Quoted text to append exactly as written (append-content); null = the AI writes it. */
  literal: string | null;
  /** Text to find and its replacement (find-replace). */
  find: string | null;
  replaceWith: string | null;
  /** Which rule-based operation to run (transform-content); null for every other action. */
  transform: CodePadChatTransform | null;
  /** Sort order for sort-lines. */
  descending: boolean;
  /** summarize-content: only the selected text (content changes always work on the selection, whatever the sentence says). */
  selectionOnly: boolean;
  /** edit-file: the request is to complete or continue the text of the file (never a revision of a pending answer). */
  completion: boolean;
  /** insert-at / follow-up 'insert' / outline: where the new content goes; null when the sentence names no place. */
  position: CodePadChatPosition | null;
  /** The words that name the place ("the second paragraph", "line 4"), resolved with CodePadDocModel.parseRef; null = none. */
  placeText: string | null;
  /** insert-at: the content goes at the end of a list ("append three points to the existing list"). */
  intoList: boolean;
  /** translate: the target language as written ("French"); null when the sentence names none. */
  language: string | null;
  /** multi-step: the sentences of the steps in order; empty for every other action. */
  steps: string[];
  /** The request works on the pending answer card when there is one (follow-up, or a revision such as "add an example"). */
  followUp: CodePadChatFollowUp | null;
}

interface CodePadChatIntentApi {
  parseIntent(input: string, openNames?: readonly string[]): CodePadChatIntent;
}

declare var CodePadChatIntent: CodePadChatIntentApi;
