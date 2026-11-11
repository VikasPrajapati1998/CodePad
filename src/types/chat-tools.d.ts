/*
 * Types of the AI chat tools (renderer/features/ai-chat-tools.ts registers them in window.CodePadChatTools,
 * renderer/features/ai-chat.ts dispatches to them). Nothing here is a module.
 */

/** A card button; the card shows `busy` while the handler runs. */
interface CodePadChatCardAction {
  label: string;
  primary?: boolean;
  run(): Promise<void> | void;
}

/** What a tool is asked to do: the parsed intent and the user's own sentence. */
interface CodePadChatRequest {
  intent: CodePadChatIntent;
  question: string;
}

/** One request to the AI model; `onDone` gets the whole answer when it arrives. */
interface CodePadChatAiOptions {
  instruction: string;
  /** The text tab whose text is sent as context (null = none). */
  tab: CodePadTextTab | null;
  /** Text to send as the file text instead of a tab's text (for example an answer that is being revised). */
  text?: string;
  /** 'file' = the complete new text and nothing else, 'write' = new content for a file of the type the instruction names, 'answer' = a normal reply. */
  output: 'answer' | 'file' | 'write';
  /** Send the earlier turns of the conversation (answers only). */
  withHistory?: boolean;
  onDone(text: string, warnings: string[]): void;
  /** Called instead of `onDone` when the request failed, was refused or was cancelled (a message was already shown). */
  onFail?(): void;
}

/** The chat window and helpers a tool may use. Tools never touch the DOM of the window directly. */
interface CodePadChatServices {
  readonly ctx: CodePadCtx;
  /** The opened Explorer folder, or null. */
  folder(): string | null;
  /** Longest file text sent to the model. */
  readonly maxFileChars: number;
  el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K];
  /** Adds a bot message. */
  bot(text: string): HTMLElement;
  /** Adds a final note (same look as a bot message). */
  doneNote(text: string): void;
  /** Adds a node (for example a preformatted block) to the transcript. */
  showNode(node: HTMLElement): void;
  /** A proposal card; buttons are disabled once one has run, unless `reusable`. */
  addCard(title: string, body: HTMLElement[], actions: CodePadChatCardAction[], reusable?: boolean): HTMLElement;
  diffBlock(before: string, after: string): HTMLElement;
  collapsible(summary: string, text: string): HTMLElement;
  warningNodes(warnings: string[]): HTMLElement[];
  /** The open tab the intent names, else the active one; says why when there is none. */
  resolveTab(intent: CodePadChatIntent): CodePadTab | null;
  /** Like resolveTab, but only plain text tabs (writable ones when `forEdit`). */
  resolveTextTab(intent: CodePadChatIntent, forEdit: boolean): CodePadTextTab | null;
  /** The text tab an answer / new file may use as context when the intent asks for it; `aborted` when a named file is missing. */
  contextTab(intent: CodePadChatIntent): { aborted: boolean; tab: CodePadTextTab | null };
  /** The text of a tab with LF line breaks. */
  lfText(tab: CodePadTextTab): string;
  /** Sends a request to the model; the result arrives in `options.onDone`. */
  runAi(options: CodePadChatAiOptions): Promise<void>;
  /** One request in a series: resolves the answer, or null when it failed or was cancelled (a message was already shown). */
  runPart(options: Omit<CodePadChatAiOptions, 'onDone' | 'onFail'>): Promise<{ text: string; warnings: string[] } | null>;
  /** The chat's scope setting: only the part of a long file the user sees, or all of it. */
  scope(): 'visible' | 'all';
  /** Adds a one-time Helpful / Not helpful rating row to an answer card while personal learning is on. */
  addRating(card: HTMLElement, answer: string): void;
  /** Adds a question and its answer to the conversation history. */
  remember(question: string, answer: string): void;
}

interface CodePadChatTool {
  /** Equals the `CodePadChatAction` the parser returns for this tool. */
  id: CodePadChatAction;
  title: string;
  /** One short line for the welcome text. */
  description: string;
  /** A sentence that triggers the tool; it fills the input when the welcome entry is clicked. */
  example: string;
  /** True when the tool asks the model to write text. */
  needsAi: boolean;
  execute(request: CodePadChatRequest, services: CodePadChatServices): Promise<void> | void;
}

interface CodePadChatToolsApi {
  /** @throws {Error} on a duplicate id. */
  register(tool: CodePadChatTool): void;
  get(id: string): CodePadChatTool | undefined;
  /** In registration order. */
  list(): CodePadChatTool[];
  /** Forgets the pending answer and other per-conversation state (New conversation / Clear chat). */
  reset(): void;
}

interface Window {
  CodePadChatTools: CodePadChatToolsApi;
}
