/**
 * The real HTTP fetch backend.
 *
 * Node's built-in `http`/`https` are used rather than global `fetch` because the
 * DNS answer must be inspected before the socket connects. `lookup` is the one
 * hook that sees the address that will actually be used; it rejects a public
 * hostname that resolves to a private address, which is the DNS-rebinding case a
 * string check cannot catch.
 *
 * Redirects are followed manually for the same reason: every hop is a new
 * destination and must pass the same check. Credentials are never attached, and
 * cookies from the browser are not part of this client at all.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { assertPublicUrl, resolvePublicHost, type UrlPolicyOptions } from './policy.ts';
import { WebError, type FetchProvider, type FetchedDocument } from './types.ts';

const USER_AGENT = 'Eunoia/0.1 (+local companion; web_fetch)';

/**
 * The `lookup` hook Node's http client calls with the validated address.
 *
 * Node enables `autoSelectFamily` by default and then calls `lookup` with
 * `{all: true}`, expecting an array. Returning a bare string in that mode makes
 * Node read `address[0].address` and fail with ERR_INVALID_IP_ADDRESS, which is
 * what a real `web_fetch` exposed. Both shapes are provided here.
 */
export function pinnedLookup(resolved: { readonly address: string; readonly family: number }) {
  return (
    _hostname: string,
    options: { readonly all?: boolean } | number,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if (typeof options === 'object' && options.all === true) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
}

export interface HttpFetchOptions {
  readonly policy?: UrlPolicyOptions;
  readonly now?: () => Date;
}

export class HttpFetchProvider implements FetchProvider {
  readonly id = 'http';
  readonly #policy: UrlPolicyOptions;
  readonly #now: () => Date;

  constructor(options: HttpFetchOptions = {}) {
    this.#policy = options.policy ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async fetch(input: {
    readonly url: string;
    readonly maxRedirects: number;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<FetchedDocument> {
    let current = assertPublicUrl(input.url, this.#policy).toString();
    const requested = current;
    for (let hop = 0; hop <= input.maxRedirects; hop += 1) {
      const response = await this.#requestOnce(current, input);
      if (response.status < 300 || response.status >= 400 || !response.location) {
        return this.#toDocument(requested, current, response, input.maxBytes);
      }
      current = assertPublicUrl(new URL(response.location, current).toString(), this.#policy).toString();
    }
    throw new WebError('WEB_HTTP_ERROR', `重定向超过 ${input.maxRedirects} 次`, 502);
  }

  async #requestOnce(
    url: string,
    input: {
      readonly timeoutMs: number;
      readonly maxBytes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<{
    readonly status: number;
    readonly location: string | null;
    readonly mimeType: string;
    readonly charset: string | null;
    readonly encoding: string | null;
    readonly body: Buffer;
    readonly truncated: boolean;
    readonly finalUrl: string;
  }> {
    const target = new URL(url);
    const resolved = await resolvePublicHost(target.hostname, this.#policy);
    if (input.signal?.aborted) throw new WebError('WEB_CANCELLED', '请求已取消', 499);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const requester = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requester(
        target,
        {
          method: 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
          },
          // The validated address is pinned here. Verification is still on, so
          // a certificate for the hostname is required; `servername` keeps SNI.
          lookup: pinnedLookup(resolved),
          servername: target.hostname,
          timeout: input.timeoutMs,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const contentType = String(response.headers['content-type'] ?? '');
          const { mimeType, charset } = parseContentType(contentType);
          const location = typeof response.headers.location === 'string' ? response.headers.location : null;
          const encoding = typeof response.headers['content-encoding'] === 'string'
            ? response.headers['content-encoding'].toLowerCase()
            : null;
          if (status >= 300 && status < 400) {
            response.resume();
            resolve({
              status,
              location,
              mimeType,
              charset,
              encoding,
              body: Buffer.alloc(0),
              truncated: false,
              finalUrl: url,
            });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          response.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > input.maxBytes) {
              truncated = true;
              chunks.push(chunk.subarray(0, Math.max(0, input.maxBytes - (total - chunk.length))));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status,
              location,
              mimeType,
              charset,
              encoding,
              body: Buffer.concat(chunks),
              truncated,
              finalUrl: url,
            });
          });
          response.on('error', finish);
        },
      );
      request.on('timeout', () => {
        request.destroy();
        finish(new WebError('WEB_TIMEOUT', `请求超时（${input.timeoutMs}ms）`, 504, { retryable: true }));
      });
      request.on('error', (error: NodeJS.ErrnoException) => {
        finish(
          new WebError(
            error.code === 'ENOTFOUND' ? 'WEB_NETWORK' : 'WEB_NETWORK',
            `请求失败：${error.message}`,
            502,
            { retryable: true, detail: { code: error.code ?? null } },
          ),
        );
      });
      const abort = (): void => {
        request.destroy();
        finish(new WebError('WEB_CANCELLED', '请求已取消', 499));
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => input.signal?.removeEventListener('abort', abort));
      request.end();
    });
  }

  #toDocument(
    requestedUrl: string,
    finalUrl: string,
    response: {
      readonly status: number;
      readonly mimeType: string;
      readonly charset: string | null;
      readonly encoding: string | null;
      readonly body: Buffer;
      readonly truncated: boolean;
    },
    maxBytes: number,
  ): FetchedDocument {
    if (response.status === 401 || response.status === 403) {
      throw new WebError('WEB_AUTH', `页面需要登录或拒绝访问（HTTP ${response.status}）`, 401);
    }
    if (response.status === 429) {
      throw new WebError('WEB_RATE_LIMIT', '请求被限流（HTTP 429）', 429, { retryable: true });
    }
    if (response.status >= 400) {
      throw new WebError('WEB_HTTP_ERROR', `HTTP ${response.status}`, 502, {
        detail: { status: response.status },
      });
    }
    if (!isTextual(response.mimeType)) {
      throw new WebError(
        'WEB_UNSUPPORTED_TYPE',
        `不支持的内容类型：${response.mimeType || '(unknown)'}。PDF、图片和二进制文件不会被当作网页正文。`,
        415,
        { detail: { mimeType: response.mimeType } },
      );
    }
    const decoded = decompress(response.body, response.encoding, maxBytes);
    const charset = response.charset ?? sniffCharset(decoded) ?? 'utf-8';
    const html = decodeText(decoded, charset);
    const extracted = response.mimeType.includes('html') ? extractHtml(html) : { title: null, text: html };
    // A 200 login form is not a readable document. Detect the unambiguous shape
    // (a password field on a short page) and report an auth-shaped error instead
    // of handing the model a form as if it were the page's content.
    if (response.mimeType.includes('html') && /<input[^>]+type\s*=\s*["']?password/i.test(html) && extracted.text.length < 5_000) {
      throw new WebError('WEB_AUTH', '页面看起来是登录/授权页（含密码输入框），不能作为正文读取。', 401);
    }
    const bounded = extracted.text.length > 50_000 ? extracted.text.slice(0, 50_000) : extracted.text;
    return {
      requestedUrl,
      finalUrl,
      status: response.status,
      mimeType: response.mimeType,
      charset,
      title: extracted.title,
      text: bounded,
      bytes: response.body.length,
      truncated: response.truncated || bounded.length < extracted.text.length,
      fetchedAt: this.#now().toISOString(),
    };
  }
}

function parseContentType(value: string): { mimeType: string; charset: string | null } {
  const [type] = value.split(';');
  const charsetMatch = /charset\s*=\s*"?([^";\s]+)"?/i.exec(value);
  return {
    mimeType: (type ?? '').trim().toLowerCase() || 'application/octet-stream',
    charset: charsetMatch ? (charsetMatch[1] as string).toLowerCase() : null,
  };
}

function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('xhtml') ||
    mimeType === 'application/javascript'
  );
}

function decompress(body: Buffer, encoding: string | null, maxBytes: number): Buffer {
  const limit = Math.max(maxBytes, 1);
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return gunzipSync(body, { maxOutputLength: limit });
    }
    if (encoding === 'deflate') return inflateSync(body, { maxOutputLength: limit });
    if (encoding === 'br') return brotliDecompressSync(body, { maxOutputLength: limit });
  } catch (error) {
    throw new WebError('WEB_TOO_LARGE', `解压失败或超过大小上限：${error instanceof Error ? error.message : String(error)}`, 413);
  }
  return body;
}

function sniffCharset(body: Buffer): string | null {
  const head = body.subarray(0, 4096).toString('latin1');
  const match = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(head);
  return match ? (match[1] as string).toLowerCase() : null;
}

function decodeText(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/** A conservative HTML→text extraction: no scripts, no styles, no markup. */
export function extractHtml(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1] as string))) : null;
  let body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);
  return { title, text: collapse(body) };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function collapse(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Exported for the provider contract tests. */
export { brotliDecompressSync, gunzipSync };
