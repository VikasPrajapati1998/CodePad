/*
 * Types of the Markdown parser shared by the renderer preview and the tests: shared/markdown.ts
 * (window.CodePadMarkdown). The parser returns a node tree, never HTML. Nothing here is a module.
 */

type CodePadMdInline =
  | { type: 'text'; value: string }
  | { type: 'em' | 'strong' | 'del'; children: CodePadMdInline[] }
  | { type: 'code'; value: string }
  /** `href` is the raw target: check it with `safeHref` before use. */
  | { type: 'link'; href: string; children: CodePadMdInline[] }
  /** Images are shown as their alt text only. */
  | { type: 'image'; alt: string }
  | { type: 'br' };

type CodePadMdAlign = 'left' | 'right' | 'center' | null;

interface CodePadMdListItem {
  /** null for a normal item, true/false for a task item. */
  checked: boolean | null;
  children: CodePadMdBlock[];
}

type CodePadMdBlock =
  | { type: 'heading'; level: number; children: CodePadMdInline[] }
  | { type: 'paragraph'; children: CodePadMdInline[] }
  | { type: 'code'; lang: string; value: string }
  | { type: 'quote'; children: CodePadMdBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: CodePadMdListItem[] }
  | { type: 'table'; align: CodePadMdAlign[]; header: CodePadMdInline[][]; rows: CodePadMdInline[][][] }
  | { type: 'rule' };

interface CodePadMarkdownApi {
  /** Longest source the parser reads (UTF-16 units); the rest is ignored. */
  readonly MAX_INPUT: number;
  /** Deepest nesting of quotes, lists and emphasis; deeper content is kept as plain text. */
  readonly MAX_DEPTH: number;
  /** Parses Markdown (CommonMark subset plus GFM tables, strike-through, task lists and bare links) into a node tree. */
  parse(source: string): CodePadMdBlock[];
  /** The link target when it is an http, https or mailto address, otherwise null. */
  safeHref(href: string): string | null;
}

declare var CodePadMarkdown: CodePadMarkdownApi;
