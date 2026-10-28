/**
 * OpenAI-compatible chat/completions adapter (OpenAI, Groq, OpenRouter, LM Studio, custom base URL).
 * The key goes only in the Authorization header. https is required; http is accepted for loopback addresses
 * only. `createOpenAiProvider` is also the engine of the Hugging Face adapter (fixed base URL, optional key).
 */
import { ProviderError, parseBaseUrl, postJson, isLoopbackHost, type Provider, type ProviderRequest, type ProviderResult } from './http';

/** Registry fields the adapter reads. */
export interface OpenAiEntry {
  modelName: string;
  baseUrl?: string;
}

interface ChatCompletion {
  choices?: unknown;
}

interface Choice {
  message?: { content?: unknown } | null;
  finish_reason?: unknown;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Creates the adapter.
 * @param entry Registry entry.
 * @param key API key; optional for loopback servers.
 * @param fixed Fixed base URL (ignores `entry.baseUrl`) and whether a missing key is allowed on a remote host.
 * @returns Adapter.
 * @throws {ProviderError} `E_BAD_URL`, `E_NO_KEY`.
 */
export function createOpenAiProvider(
  entry: OpenAiEntry,
  key: string | null,
  fixed: { baseUrl?: string; keyOptional?: boolean } = {}
): Provider {
  const base = parseBaseUrl(fixed.baseUrl || entry.baseUrl || OPENAI_BASE_URL, { allowLoopbackHttp: !fixed.baseUrl });
  if (!key && !fixed.keyOptional && !isLoopbackHost(base.hostname)) {
    throw new ProviderError('E_NO_KEY', 'No API key is set for this model.');
  }
  const endpoint = `${base.origin}${base.pathname.replace(/\/+$/, '')}/chat/completions`;
  // OpenAI's own newer models reject max_tokens; other compatible servers still expect it.
  const limitField = base.hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  return {
    host: base.host,
    async complete({ system, prompt, maxTokens, signal }: ProviderRequest): Promise<ProviderResult> {
      const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
      const data = (await postJson({
        url: endpoint,
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: { model: entry.modelName, messages, [limitField]: maxTokens },
        signal,
        secrets: [key],
      })) as ChatCompletion;
      const choice = (Array.isArray(data.choices) ? data.choices[0] : null) as Choice | null;
      const content = choice && choice.message ? choice.message.content : null;
      const text: unknown = Array.isArray(content)
        ? (content as ({ text?: unknown } | null)[]).map((part) => (part && part.text) || '').join('')
        : content;
      if (typeof text !== 'string' || !text) {
        throw new ProviderError('E_BAD_RESPONSE', 'The model returned no text.');
      }
      return { text, stopReason: String((choice && choice.finish_reason) || '') };
    },
  };
}
