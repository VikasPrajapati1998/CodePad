/**
 * Remote model providers (main process): Anthropic, OpenAI-compatible and Hugging Face. `createProvider` builds
 * an adapter from a registry runtime record, `createSummaryCompleter` adapts it to the `complete(spec, gen)`
 * primitive of summarizer.ts, and `testProvider` makes a tiny call for the "Test" button. Keys come from
 * `registry.runtime(id)`, stay inside this process and are never logged or sent to the renderer.
 */
import { ProviderError, parseBaseUrl, type Provider } from './http';
import { BASE_URL as ANTHROPIC_URL, createAnthropicProvider } from './anthropic';
import { OPENAI_BASE_URL, createOpenAiProvider } from './openai';
import { BASE_URL as HUGGINGFACE_URL, createHuggingFaceProvider } from './huggingface';
import type { CompleteFn } from '../summarizer';

export { ProviderError };
export type { Provider, ProviderRequest, ProviderResult } from './http';

/** Registry fields a provider factory reads. */
export interface ProviderEntry {
  kind: string;
  modelName: string;
  baseUrl?: string;
}

/** A registry runtime record: the entry plus its API key. */
export interface ProviderRuntime {
  entry: ProviderEntry;
  key: string | null;
}

export const REMOTE_KINDS: readonly string[] = Object.freeze(['anthropic', 'openai-compatible', 'huggingface']);
// Hidden "reasoning" tokens count against the limit on some models, so the small per-call limits of the local
// prompts are raised; the prompts themselves already ask for short answers.
const MIN_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS = 4096;
const NO_THINK_SUFFIX = / \/no_think$/;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
const BULLET_START = /^\s*(?:[-*•]|\d{1,2}[.)])\s/;

const FACTORIES: Record<string, ((entry: ProviderEntry, key: string | null) => Provider) | undefined> = {
  anthropic: createAnthropicProvider,
  'openai-compatible': createOpenAiProvider,
  huggingface: createHuggingFaceProvider,
};

/**
 * Builds the adapter for a registry runtime record.
 * @param runtime The entry and key of `registry.runtime(id)`.
 * @returns Adapter.
 * @throws {ProviderError} `E_UNSUPPORTED`, `E_NO_KEY`, `E_BAD_URL`.
 */
export function createProvider({ entry, key }: ProviderRuntime): Provider {
  const factory = FACTORIES[entry.kind];
  if (!factory) {
    throw new ProviderError('E_UNSUPPORTED', 'This model type has no remote provider.');
  }
  return factory(entry, key || null);
}

/**
 * The host (with port) a remote entry really sends its text to: fixed for Anthropic and Hugging Face, parsed from
 * the base URL (default OpenAI) for custom servers. Used by main's confirmation dialogs.
 * @param entry Registry fields of a remote model.
 * @returns Host such as `api.openai.com`.
 * @throws {ProviderError} `E_UNSUPPORTED`, `E_BAD_URL`.
 */
export function remoteHost(entry: ProviderEntry): string {
  if (entry.kind === 'anthropic') {
    return new URL(ANTHROPIC_URL).host;
  }
  if (entry.kind === 'huggingface') {
    return new URL(HUGGINGFACE_URL).host;
  }
  if (entry.kind === 'openai-compatible') {
    return parseBaseUrl(entry.baseUrl || OPENAI_BASE_URL, { allowLoopbackHttp: true }).host;
  }
  throw new ProviderError('E_UNSUPPORTED', 'This model type has no remote provider.');
}

/**
 * Adapts a provider to summarizer's `complete(spec, gen)`. The chat spec of aiPrompts (`system`, `user`,
 * `assistantPrefix`) becomes a plain chat request; the local-model control suffix is removed and `<think>`
 * blocks are dropped from the answer. When the answer does not start as a bullet list the prefix is restored
 * so bullet parsing works like it does for the local model.
 * @param provider Adapter from createProvider.
 * @param signal Cancels the calls.
 * @returns Generation primitive for summarizer.summarize.
 */
export function createSummaryCompleter(provider: Provider, signal?: AbortSignal): CompleteFn {
  return async (spec, gen) => {
    const wantsBullets = BULLET_START.test(spec.assistantPrefix || '');
    const maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Number(gen.maxTokens) || 0));
    const { text } = await provider.complete({
      system: spec.system,
      prompt: String(spec.user).replace(NO_THINK_SUFFIX, ''),
      maxTokens,
      signal,
    });
    const answer = text.replace(THINK_BLOCK, '').trim();
    return wantsBullets && !BULLET_START.test(answer) ? `${spec.assistantPrefix}${answer}` : answer;
  };
}

/**
 * Makes one tiny request to check address, model name and key.
 * @param runtime The entry and key of `registry.runtime(id)`.
 * @param signal Cancels the test.
 * @returns Resolves when the model answered.
 * @throws {ProviderError} Any adapter error code.
 */
export async function testProvider(runtime: ProviderRuntime, signal?: AbortSignal): Promise<void> {
  const provider = createProvider(runtime);
  await provider.complete({ system: '', prompt: 'Reply with the single word OK.', maxTokens: 64, signal });
}
