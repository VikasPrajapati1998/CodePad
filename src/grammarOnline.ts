/**
 * Online grammar check (main process): the optional second opinion next to the offline spell checker. It sends the
 * text to the free public LanguageTool service, so the first use of each session is confirmed in a native box that
 * names the host; the renderer never decides that. Nothing is stored or logged.
 */
import { ProviderError } from './providers/http';
import { checkGrammar, LANGUAGETOOL_HOST, MAX_GRAMMAR_CHARS } from './providers/languagetool';

/** Asks the user (native box) whether the text may be sent to `host`. */
export type ConfirmSend = (host: string, characters: number) => Promise<boolean>;

/** The online grammar service main talks to. */
export interface GrammarService {
  /** Validates the request, asks for consent once per session and checks the text. */
  check(raw: unknown): Promise<CpGrammarResult>;
}

const FAILURES: Record<string, { code: 'offline' | 'rateLimit' | 'tooLarge' | 'failed'; message: string }> = {
  E_NETWORK: { code: 'offline', message: 'No internet connection. The offline spell check keeps working; use AI > Check Grammar and Spelling with AI for an offline grammar check.' },
  E_TIMEOUT: { code: 'offline', message: 'The grammar service did not answer in time. Check the internet connection and try again.' },
  E_RATE_LIMIT: { code: 'rateLimit', message: 'The free grammar service is busy or its limit was reached. Try again in a minute.' },
  E_PROMPT_TOO_LONG: { code: 'tooLarge', message: `The free grammar service accepts at most ${MAX_GRAMMAR_CHARS} characters at a time. Select a smaller part.` },
};

/**
 * Creates the service.
 * @param confirm Native confirmation shown before the first send of a session.
 * @returns The service.
 */
export function createGrammarService(confirm: ConfirmSend): GrammarService {
  let allowed = false;

  async function check(raw: unknown): Promise<CpGrammarResult> {
    if (typeof raw !== 'string') {
      return { ok: false, code: 'failed', message: 'Invalid grammar request.' };
    }
    if (raw.trim() === '') {
      return { ok: false, code: 'empty', message: 'There is no text to check.' };
    }
    if (raw.length > MAX_GRAMMAR_CHARS) {
      return { ...FAILURES.E_PROMPT_TOO_LONG, ok: false };
    }
    if (!allowed) {
      if (!(await confirm(LANGUAGETOOL_HOST, raw.length))) {
        return { ok: false, code: 'cancelled', message: 'Cancelled. Nothing was sent.' };
      }
      allowed = true;
    }
    try {
      return { ok: true, matches: await checkGrammar(raw) };
    } catch (error) {
      const known = error instanceof ProviderError ? FAILURES[error.code] : undefined;
      return known ? { ...known, ok: false } : { ok: false, code: 'failed', message: 'The grammar check failed.' };
    }
  }

  return { check };
}
