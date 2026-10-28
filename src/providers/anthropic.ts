/**
 * Anthropic Messages API adapter. The host is fixed (api.anthropic.com); the key goes only in the
 * `x-api-key` header. Adapter interface: `complete({system, prompt, maxTokens, signal})` -> `{text, stopReason}`.
 */
import { ProviderError, postJson, type Provider, type ProviderRequest, type ProviderResult } from './http';

interface AnthropicResponse {
  content?: unknown;
  stop_reason?: unknown;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

export const BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/**
 * Creates the adapter.
 * @param entry Registry entry (model id such as `claude-sonnet-4-5`).
 * @param key API key (required).
 * @returns Adapter.
 * @throws {ProviderError} `E_NO_KEY` when no key is available.
 */
export function createAnthropicProvider(entry: { modelName: string }, key: string | null): Provider {
  if (!key) {
    throw new ProviderError('E_NO_KEY', 'No API key is set for this model.');
  }
  return {
    host: new URL(BASE_URL).host,
    async complete({ system, prompt, maxTokens, signal }: ProviderRequest): Promise<ProviderResult> {
      const data = (await postJson({
        url: `${BASE_URL}/v1/messages`,
        headers: { 'x-api-key': key, 'anthropic-version': API_VERSION },
        body: {
          model: entry.modelName,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        },
        signal,
        secrets: [key],
      })) as AnthropicResponse;
      const blocks = (Array.isArray(data.content) ? data.content : []) as (ContentBlock | null)[];
      const text = blocks
        .filter((block): block is ContentBlock & { text: string } => !!block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (!text) {
        throw new ProviderError('E_BAD_RESPONSE', 'The model returned no text.');
      }
      return { text, stopReason: String(data.stop_reason || '') };
    },
  };
}
