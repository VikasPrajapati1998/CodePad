/** Helpers for handling caught `unknown` errors. */

/** True for a Node filesystem error carrying the given errno code (for example `ENOENT`). */
export function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/** The message of a caught value (`String(value)` when it is not an Error). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The string `code` property of a caught value, or undefined. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && code ? code : undefined;
}
