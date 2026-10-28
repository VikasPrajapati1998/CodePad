/*
 * Cache of finished summaries (main process). Stores only the final summary text under a SHA-256 key derived
 * from the document, the settings and the model; never the source text, chunks, file names or paths.
 * Persisted through userStore.ts as userData/summary-cache.json with a bounded entry count and file size.
 */
import * as crypto from 'crypto';
import { PIPELINE_VERSION } from './summarizer';

/** The parts of the userStore module the cache uses. */
export interface SummaryCacheStore {
  readJson(file: string, options: { maxBytes: number; signed: boolean }): Promise<{ data: unknown; integrity: string }>;
  writeJson(file: string, value: unknown, options: { maxBytes: number; signed: boolean }): Promise<unknown>;
  remove(file: string): Promise<unknown>;
}

/** Options of {@link createSummaryCache}. */
export interface SummaryCacheOptions {
  /** The userStore module (readJson / writeJson / remove). */
  userStore: SummaryCacheStore;
  /** Entries kept (least recently used are evicted). */
  maxEntries?: number;
  /** Longest summary that is cached. */
  maxEntryChars?: number;
  /** Largest cache file. */
  maxFileBytes?: number;
}

/** What the cache key is derived from. */
export interface SummaryKeyInput {
  text: string;
  modelId: string;
  style: string;
  chunkTokens: number;
  scope: string;
}

/** The summary cache. */
export interface SummaryCache {
  keyFor(input: SummaryKeyInput): string;
  get(key: string): Promise<string | null>;
  set(key: string, markdown: string): Promise<void>;
  clear(): Promise<number>;
  flush(): Promise<void>;
}

interface CacheEntry {
  markdown: string;
  createdAt: number;
  lastUsedAt: number;
}

interface StoredItem {
  key?: unknown;
  markdown?: unknown;
  createdAt?: unknown;
  lastUsedAt?: unknown;
}

const CACHE_FILE = 'summary-cache.json';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const FLUSH_DELAY_MS = 2000;
/** Room kept in the file budget for the `sig` property added on write. */
const SIGNATURE_RESERVE_BYTES = 128;

/**
 * Creates the summary cache.
 * @param options See {@link SummaryCacheOptions}.
 * @returns The cache.
 */
export function createSummaryCache({
  userStore,
  maxEntries = 50,
  maxEntryChars = 32000,
  maxFileBytes = 2 * 1024 * 1024,
}: SummaryCacheOptions): SummaryCache {
  let entries = new Map<string, CacheEntry>();
  let loading: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<unknown> = Promise.resolve();

  function load(): Promise<void> {
    if (!loading) {
      loading = userStore.readJson(CACHE_FILE, { maxBytes: maxFileBytes, signed: true }).then(async ({ data, integrity }) => {
        if (integrity === 'failed') {
          // Unsigned, tampered or unreadable: a planted summary must never be served, so the file is dropped.
          await userStore.remove(CACHE_FILE).catch(() => {});
          return;
        }
        const stored = data as { entries?: unknown } | null;
        const list = (stored && Array.isArray(stored.entries) ? stored.entries : []) as (StoredItem | null)[];
        for (const item of list.slice(0, maxEntries)) {
          if (
            item &&
            typeof item.key === 'string' &&
            KEY_PATTERN.test(item.key) &&
            typeof item.markdown === 'string' &&
            item.markdown.length <= maxEntryChars
          ) {
            const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0;
            const lastUsedAt = typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : createdAt;
            entries.set(item.key, { markdown: item.markdown, createdAt, lastUsedAt });
          }
        }
      });
    }
    return loading;
  }

  /** Serialized snapshot, evicting the least recently used entries beyond the entry and file-size limits. */
  function snapshot(): { version: number; entries: (CacheEntry & { key: string })[] } {
    const ordered = [...entries].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt).slice(0, maxEntries);
    const fits = (items: unknown[]): boolean =>
      Buffer.byteLength(JSON.stringify({ version: 1, entries: items })) <= maxFileBytes - SIGNATURE_RESERVE_BYTES;
    const toItems = (pairs: [string, CacheEntry][]): (CacheEntry & { key: string })[] =>
      pairs.map(([key, entry]) => ({ key, ...entry }));
    let kept = ordered;
    while (kept.length > 0 && !fits(toItems(kept))) {
      kept = kept.slice(0, -1);
    }
    entries = new Map(kept);
    return { version: 1, entries: toItems(kept) };
  }

  function persist(): Promise<unknown> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    writing = writing.catch(() => {}).then(() => userStore.writeJson(CACHE_FILE, snapshot(), { maxBytes: maxFileBytes, signed: true }));
    return writing;
  }

  function scheduleFlush(): void {
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        persist().catch(() => {});
      }, FLUSH_DELAY_MS);
      timer.unref();
    }
  }

  return {
    /** SHA-256 hex key over the pipeline version, model, settings and the document text. */
    keyFor({ text, modelId, style, chunkTokens, scope }: SummaryKeyInput): string {
      return crypto
        .createHash('sha256')
        .update(`${PIPELINE_VERSION}\0${modelId}\0${style}\0${chunkTokens}\0${scope}\0`)
        .update(text)
        .digest('hex');
    },

    /** The cached summary body, or null. Marks the entry as recently used (written lazily). */
    async get(key: string): Promise<string | null> {
      await load();
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      entry.lastUsedAt = Date.now();
      scheduleFlush();
      return entry.markdown;
    },

    /** Stores a summary body (bodies longer than the entry limit are not cached). */
    async set(key: string, markdown: string): Promise<void> {
      await load();
      if (!KEY_PATTERN.test(key) || typeof markdown !== 'string' || markdown.length > maxEntryChars) {
        return;
      }
      const now = Date.now();
      entries.set(key, { markdown, createdAt: now, lastUsedAt: now });
      await persist();
    },

    /** Removes every entry and deletes the file. Resolves with the number of entries removed. */
    async clear(): Promise<number> {
      await load();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const removed = entries.size;
      entries = new Map();
      await writing.catch(() => {});
      await userStore.remove(CACHE_FILE);
      return removed;
    },

    /** Writes pending recency updates (called on quit). */
    async flush(): Promise<void> {
      if (timer) {
        await persist();
      }
    },
  };
}
