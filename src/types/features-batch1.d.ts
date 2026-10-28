/*
 * Types shared by the batch-1 renderer features (search, search-results, bookmarks, ...). Declaration merging only:
 * the existing d.ts files are not edited. Nothing here is a module.
 */

/** The boolean search flags that renderer-globals.d.ts leaves to the index signature. */
interface CodePadSearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  extended: boolean;
  dotAll: boolean;
}

/** One file (or open tab) group of a result set. `key` is the tab id or the file path. */
interface CodePadResultFile {
  key: string | number;
  label: string;
  path: string | null;
  tabId: number | null;
  collapsed: boolean;
  matches: CpSearchMatch[];
}

interface CodePadResultTotals {
  files: number;
  matches: number;
  filesScanned: number;
  skippedBinary: number;
  skippedLarge: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

/** One search run as shown in the Search Results panel. */
interface CodePadResultSet {
  id: number;
  title: string;
  scope: string;
  query: string;
  options: Record<string, boolean>;
  running: boolean;
  error: string | null;
  files: CodePadResultFile[];
  totals: CodePadResultTotals;
}

/** `window.CodePadSearchResults`, set by features/search-results.ts. */
interface CodePadSearchResultsApi {
  /** Adds a result set (becomes the active one) and shows the panel. */
  show(set: CodePadResultSet): void;
  /** Appends files to a result set that is still being filled. */
  append(set: CodePadResultSet, files: CodePadResultFile[]): void;
  /** Marks a result set as complete and merges final totals. */
  finish(set: CodePadResultSet, patch: { totals?: Partial<CodePadResultTotals>; error?: string }): void;
  refresh(set: CodePadResultSet): void;
  clear(): void;
  next(): void;
  prev(): void;
}

interface Window {
  CodePadSearchResults: CodePadSearchResultsApi;
}
