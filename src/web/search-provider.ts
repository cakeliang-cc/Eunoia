import { setTimeout as delay } from 'node:timers/promises';
import { assertPublicUrl } from './policy.ts';
import { createDefaultSearchProvider } from './tavily.ts';
import { WebError, type FetchProvider, type SearchProvider, type SearchResponse, type SearchResult } from './types.ts';

const MWMBL_ENDPOINT = 'https://api.mwmbl.org/api/v2/search/';

export function selectSearchProvider(env: NodeJS.ProcessEnv, http: FetchProvider): SearchProvider {
  switch (env.WEB_SEARCH_PROVIDER?.trim() || 'tavily') {
    case 'tavily': return createDefaultSearchProvider(env);
    case 'mwmbl': return new MwmblSearchProvider(http);
    default: throw new Error('WEB_SEARCH_PROVIDER 须为 tavily 或 mwmbl');
  }
}

class MwmblSearchProvider implements SearchProvider {
  readonly id = 'mwmbl';
  readonly configured = true;
  readonly #http: FetchProvider;
  #nextRequestAt = 0;

  constructor(http: FetchProvider) {
    this.#http = http;
  }

  status() {
    return { configured: true, detail: 'Mwmbl 匿名搜索（按 IP 限流，支持结果域名过滤，日期过滤需 Tavily）' };
  }

  async search(input: Parameters<SearchProvider['search']>[0]): Promise<SearchResponse> {
    if (input.timeRange?.start || input.timeRange?.end) {
      throw new WebError('WEB_UNSUPPORTED_FILTER', 'Mwmbl 不支持日期过滤。请选择支持日期过滤的搜索后端。', 400);
    }
    const domains = (input.domains ?? []).map((domain) => domain.trim().toLowerCase().replace(/\.$/, ''));
    const now = performance.now();
    const startAt = Math.max(now, this.#nextRequestAt);
    if (startAt - now > 5_000) {
      throw new WebError('WEB_RATE_LIMIT', 'Mwmbl 搜索队列已满，请稍后再试。', 429, { retryable: true });
    }
    this.#nextRequestAt = startAt + 1_100;
    if (startAt > now) {
      try {
        await delay(startAt - now, undefined, { signal: input.signal });
      } catch (error) {
        if (!input.signal?.aborted) throw error;
      }
    }
    if (input.signal?.aborted) throw new WebError('WEB_CANCELLED', '请求已取消', 499);

    const endpoint = new URL(MWMBL_ENDPOINT);
    endpoint.searchParams.set('q', input.query);
    const page = await this.#http.fetch({
      url: endpoint.toString(), maxRedirects: 0, timeoutMs: 8_000, maxBytes: 256_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (page.truncated) throw new WebError('WEB_TOO_LARGE', 'Mwmbl 搜索响应超过大小上限。', 502);
    let rows: unknown;
    try {
      rows = JSON.parse(page.text)?.results;
    } catch {
      throw new WebError('WEB_HTTP_ERROR', 'Mwmbl 返回了不完整或无效的搜索响应。', 502);
    }
    if (!Array.isArray(rows)) throw new WebError('WEB_HTTP_ERROR', 'Mwmbl 响应缺少结果列表。', 502);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row?.url !== 'string') continue;
      let url: URL;
      try {
        url = assertPublicUrl(row.url);
      } catch {
        continue;
      }
      const host = url.hostname.replace(/\.$/, '');
      if (domains.length && !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
      const link = url.toString();
      if (seen.has(link)) continue;
      seen.add(link);
      results.push({
        url: link,
        title: typeof row.title === 'string' && row.title.trim() ? row.title.slice(0, 300) : link,
        snippet: typeof row.content === 'string' ? row.content.slice(0, 2_000) : '',
        publishedAt: null,
        source: host,
      });
      if (results.length >= input.maxResults) break;
    }
    return { provider: this.id, billed: false, query: input.query, results };
  }
}
