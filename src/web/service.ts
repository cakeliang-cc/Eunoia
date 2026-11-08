/**
 * The web tools' domain service.
 *
 * `web_fetch` is idempotent per cursor: the first call performs the request and
 * stores an immutable snapshot, later cursors read that snapshot. A page that
 * changes between calls cannot swap content into an answer the model is still
 * reading.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { WebDocumentStore } from './store.ts';
import type { FetchProvider, SearchProvider, SearchResponse } from './types.ts';
import { WebError } from './types.ts';

export interface WebLimits {
  readonly maxFetchChars: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxQueries: number;
  readonly maxResults: number;
}

export const DEFAULT_WEB_LIMITS: WebLimits = {
  maxFetchChars: 50_000,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 5,
  maxQueries: 3,
  maxResults: 5,
};

export interface WebServiceDeps {
  readonly fetchProvider: FetchProvider;
  readonly searchProvider: SearchProvider;
  readonly documents: WebDocumentStore;
  readonly limits?: Partial<WebLimits>;
  readonly now?: () => Date;
}

export interface FetchedPage {
  readonly documentId: string;
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly text: string;
  readonly status: number;
  readonly mimeType: string;
  readonly fetchedAt: string;
  readonly truncated: boolean;
  readonly cursor: string | null;
  readonly totalChars: number;
}

export class WebService {
  readonly #fetchProvider: FetchProvider;
  readonly #searchProvider: SearchProvider;
  readonly #documents: WebDocumentStore;
  readonly #limits: WebLimits;

  constructor(deps: WebServiceDeps) {
    this.#fetchProvider = deps.fetchProvider;
    this.#searchProvider = deps.searchProvider;
    this.#documents = deps.documents;
    this.#limits = { ...DEFAULT_WEB_LIMITS, ...deps.limits };
  }

  status(): {
    readonly fetch: { readonly configured: boolean; readonly provider: string };
    readonly search: { readonly configured: boolean; readonly provider: string; readonly detail: string };
    readonly limits: WebLimits;
  } {
    return {
      fetch: { configured: true, provider: this.#fetchProvider.id },
      search: {
        configured: this.#searchProvider.configured,
        provider: this.#searchProvider.id,
        detail: this.#searchProvider.status().detail,
      },
      limits: this.#limits,
    };
  }

  async fetch(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly actionId: string | null;
    readonly url: string;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }): Promise<FetchedPage> {
    const cursor = input.cursor;
    if (cursor) {
      return this.#pageFromSnapshot({
        userId: input.userId,
        conversationId: input.conversationId,
        cursor,
      });
    }
    const document = await this.#fetchProvider.fetch({
      url: input.url,
      maxRedirects: this.#limits.maxRedirects,
      timeoutMs: this.#limits.timeoutMs,
      maxBytes: this.#limits.maxBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const id = randomUUID();
    const text = document.text.slice(0, this.#limits.maxFetchChars);
    await this.#documents.saveWebDocument({
      id,
      userId: input.userId,
      conversationId: input.conversationId,
      actionId: input.actionId,
      requestedUrl: document.requestedUrl,
      finalUrl: document.finalUrl,
      status: document.status,
      mimeType: document.mimeType,
      title: document.title,
      text: document.text,
      bytes: document.bytes,
      truncated: document.truncated || text.length < document.text.length,
      fetchedAt: document.fetchedAt,
      sha256: createHash('sha256').update(document.text).digest('hex'),
    });
    return {
      documentId: id,
      url: document.requestedUrl,
      finalUrl: document.finalUrl,
      title: document.title,
      text,
      status: document.status,
      mimeType: document.mimeType,
      fetchedAt: document.fetchedAt,
      truncated: document.truncated || text.length < document.text.length,
      cursor: text.length < document.text.length ? makeCursor(id, text.length) : null,
      totalChars: document.text.length,
    };
  }

  async #pageFromSnapshot(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly cursor: string;
  }): Promise<FetchedPage> {
    const parsed = parseCursor(input.cursor);
    if (!parsed) throw new WebError('WEB_INVALID_URL', '游标不合法。', 400);
    const document = await this.#documents.getWebDocument(input.userId, parsed.id);
    if (!document || document.conversationId !== input.conversationId) {
      throw new WebError('WEB_NOT_CONFIGURED', '这份网页快照不存在或不属于当前会话。', 404);
    }
    const start = Math.min(parsed.offset, document.text.length);
    const end = Math.min(start + this.#limits.maxFetchChars, document.text.length);
    const text = document.text.slice(start, end);
    return {
      documentId: document.id,
      url: document.requestedUrl,
      finalUrl: document.finalUrl,
      title: document.title,
      text,
      status: document.status,
      mimeType: document.mimeType,
      fetchedAt: document.fetchedAt,
      truncated: end < document.text.length || document.truncated,
      cursor: end < document.text.length ? makeCursor(document.id, end) : null,
      totalChars: document.text.length,
    };
  }

  async search(input: {
    readonly query: string;
    readonly domains?: readonly string[];
    readonly timeRange?: { readonly start?: string; readonly end?: string };
    readonly signal?: AbortSignal;
  }): Promise<SearchResponse> {
    return this.#searchProvider.search({
      query: input.query,
      maxResults: this.#limits.maxResults,
      ...(input.domains && input.domains.length > 0 ? { domains: input.domains } : {}),
      ...(input.timeRange ? { timeRange: input.timeRange } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async searchMany(input: {
    readonly queries: readonly string[];
    readonly domains?: readonly string[];
    readonly timeRange?: { readonly start?: string; readonly end?: string };
    readonly signal?: AbortSignal;
  }): Promise<ReadonlyArray<SearchResponse | { readonly query: string; readonly error: WebError }>> {
    const queries = input.queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0)
      .slice(0, this.#limits.maxQueries);
    if (queries.length === 0) {
      throw new WebError('WEB_INVALID_URL', '至少需要一个搜索词。', 400);
    }
    const out: Array<SearchResponse | { readonly query: string; readonly error: WebError }> = [];
    for (const query of queries) {
      try {
        out.push(
          await this.search({
            query,
            ...(input.domains ? { domains: input.domains } : {}),
            ...(input.timeRange ? { timeRange: input.timeRange } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof WebError && error.code === 'WEB_NOT_CONFIGURED') throw error;
        out.push({
          query,
          error:
            error instanceof WebError
              ? error
              : new WebError('WEB_NETWORK', error instanceof Error ? error.message : String(error), 502),
        });
      }
    }
    return out;
  }
}

function makeCursor(id: string, offset: number): string {
  return Buffer.from(`${id}:${offset}`, 'utf8').toString('base64url');
}

function parseCursor(cursor: string): { id: string; offset: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const index = decoded.lastIndexOf(':');
    if (index <= 0) return null;
    const id = decoded.slice(0, index);
    const offset = Number(decoded.slice(index + 1));
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(offset) || offset < 0) return null;
    return { id, offset };
  } catch {
    return null;
  }
}
