/**
 * The web tools' domain vocabulary.
 *
 * Search and fetch are replaceable backends: the model sees one stable contract
 * (`web_search`, `web_fetch`), while a deployment may swap Tavily for another
 * provider without touching the loop, the prompt or the schema. Fetched
 * documents are immutable: a cursor always addresses the snapshot returned by
 * the first request, never whatever the page says today.
 */

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt: string | null;
  readonly source: string;
  readonly score?: number;
}

export interface SearchResponse {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly provider: string;
  /** True when the provider reports a billed request; cost stays unknown. */
  readonly billed: boolean;
}

export interface SearchProvider {
  readonly id: string;
  readonly configured: boolean;
  search(input: {
    readonly query: string;
    readonly maxResults: number;
    readonly domains?: readonly string[];
    readonly timeRange?: { readonly start?: string; readonly end?: string };
    readonly signal?: AbortSignal;
  }): Promise<SearchResponse>;
  status(): { readonly configured: boolean; readonly detail: string };
}

export interface FetchProvider {
  readonly id: string;
  fetch(input: {
    readonly url: string;
    readonly maxRedirects: number;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<FetchedDocument>;
}

export interface FetchedDocument {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly mimeType: string;
  readonly charset: string | null;
  readonly title: string | null;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly fetchedAt: string;
}

export class WebError extends Error {
  readonly code:
    | 'WEB_NOT_CONFIGURED'
    | 'WEB_INVALID_URL'
    | 'WEB_BLOCKED_HOST'
    | 'WEB_AUTH'
    | 'WEB_RATE_LIMIT'
    | 'WEB_TIMEOUT'
    | 'WEB_TOO_LARGE'
    | 'WEB_UNSUPPORTED_TYPE'
    | 'WEB_HTTP_ERROR'
    | 'WEB_NETWORK'
    | 'WEB_CANCELLED';
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: WebError['code'],
    message: string,
    status = 400,
    options: { readonly retryable?: boolean; readonly detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'WebError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? {};
  }
}

export function isWebError(error: unknown): error is WebError {
  return error instanceof WebError;
}
