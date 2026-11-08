/**
 * Tavily search adapter.
 *
 * The API key is sent in the request body, never in the URL, and is registered
 * with the process redactor before any request. Only basic search results are
 * requested: no generated answer, no raw page content and no images, so a search
 * cannot silently become a second model call.
 */

import { WebError, type SearchProvider, type SearchResponse, type SearchResult } from './types.ts';
import { MCP_REDACTOR } from '../mcp/credentials.ts';

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';

export interface TavilyOptions {
  readonly apiKey?: string | null;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

interface TavilyResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  readonly score?: unknown;
  readonly published_date?: unknown;
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';
  readonly configured: boolean;
  readonly #key: string | null;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: TavilyOptions = {}) {
    this.#key = options.apiKey?.trim() ? options.apiKey.trim() : null;
    this.configured = this.#key !== null;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (this.#key) MCP_REDACTOR.registerToken(this.#key, 'tavily');
  }

  status(): { readonly configured: boolean; readonly detail: string } {
    return this.configured
      ? { configured: true, detail: 'Tavily 已配置（基础搜索，最多 5 条结果）' }
      : { configured: false, detail: '未配置 TAVILY_API_KEY；搜索工具会返回结构化“未配置”错误。' };
  }

  async search(input: {
    readonly query: string;
    readonly maxResults: number;
    readonly domains?: readonly string[];
    readonly timeRange?: { readonly start?: string; readonly end?: string };
    readonly signal?: AbortSignal;
  }): Promise<SearchResponse> {
    if (!this.#key) {
      throw new WebError('WEB_NOT_CONFIGURED', '未配置 TAVILY_API_KEY，联网搜索不可用。', 503);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({
          api_key: this.#key,
          query: input.query,
          max_results: Math.min(Math.max(input.maxResults, 1), 5),
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          ...(input.domains && input.domains.length > 0 ? { include_domains: [...input.domains] } : {}),
          ...(input.timeRange?.start ? { start_date: input.timeRange.start } : {}),
          ...(input.timeRange?.end ? { end_date: input.timeRange.end } : {}),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new WebError('WEB_AUTH', 'Tavily 拒绝了凭据（401/403），请检查 TAVILY_API_KEY。', 401);
      }
      if (response.status === 429) {
        throw new WebError('WEB_RATE_LIMIT', 'Tavily 限流（429），请稍后再试。', 429, { retryable: true });
      }
      if (!response.ok) {
        throw new WebError('WEB_HTTP_ERROR', `Tavily 返回 HTTP ${response.status}`, 502);
      }
      const payload = (await response.json()) as { results?: unknown };
      const results = Array.isArray(payload.results) ? payload.results : [];
      return {
        query: input.query,
        provider: this.id,
        billed: true,
        results: results.map((entry) => this.#normalize(entry, input.query)),
      };
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (controller.signal.aborted) {
        throw new WebError('WEB_TIMEOUT', 'Tavily 请求超时或被取消', 504, { retryable: true });
      }
      throw new WebError('WEB_NETWORK', `Tavily 请求失败：${error instanceof Error ? error.message : String(error)}`, 502, {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  #normalize(entry: unknown, query: string): SearchResult {
    const result = (entry ?? {}) as TavilyResult;
    const url = typeof result.url === 'string' ? result.url : '';
    return {
      title: typeof result.title === 'string' && result.title.length > 0 ? result.title : url,
      url,
      snippet: typeof result.content === 'string' ? result.content.slice(0, 2_000) : '',
      publishedAt:
        typeof result.published_date === 'string' && result.published_date.length > 0
          ? result.published_date
          : null,
      source: hostOf(url) ?? query,
      ...(typeof result.score === 'number' ? { score: result.score } : {}),
    };
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function createDefaultSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<TavilyOptions, 'apiKey'> = {},
): TavilySearchProvider {
  return new TavilySearchProvider({
    apiKey: env.TAVILY_API_KEY?.trim() || null,
    ...options,
  });
}
