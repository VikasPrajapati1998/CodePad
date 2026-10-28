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
  | 'answer';

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
  /** summarize-content: only the selected text. */
  selectionOnly: boolean;
}

interface CodePadChatIntentApi {
  parseIntent(input: string, openNames?: readonly string[]): CodePadChatIntent;
}

declare var CodePadChatIntent: CodePadChatIntentApi;
