/**
 * Hugging Face hosted inference adapter: the OpenAI-compatible router at https://router.huggingface.co/v1
 * (Bearer token; `model` is a Hub id such as `Qwen/Qwen2.5-7B-Instruct`, optionally with a provider suffix).
 * The host is fixed and a user-supplied base URL is ignored. The token is optional here; the service decides
 * whether a request without one is allowed.
 */
import type { Provider } from './http';
import { createOpenAiProvider } from './openai';

export const BASE_URL = 'https://router.huggingface.co/v1';

/**
 * Creates the adapter.
 * @param entry Registry entry.
 * @param key Optional Hugging Face token.
 * @returns Adapter (see openai.ts).
 */
export function createHuggingFaceProvider(entry: { modelName: string }, key: string | null): Provider {
  return createOpenAiProvider(entry, key, { baseUrl: BASE_URL, keyOptional: true });
}
