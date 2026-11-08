/**
 * The web backends over real sockets.
 *
 * A local HTTP server exercises the fetch path (HTML, gzip, redirects, errors,
 * pagination). The Tavily adapter is tested against an HTTP endpoint as well;
 * the real Tavily account is a deployment credential, not a unit-test fixture.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { HttpFetchProvider } from '../../src/web/fetch-http.ts';
import { TavilySearchProvider } from '../../src/web/tavily.ts';
import { WebService } from '../../src/web/service.ts';
import { assertPublicUrl, isPrivateAddress } from '../../src/web/policy.ts';
import { extractHtml } from '../../src/web/fetch-http.ts';
import { WebError } from '../../src/web/types.ts';

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server?.closeAllConnections?.();
    });
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function service(base: string, options: { maxFetchChars?: number } = {}): WebService {
  return new WebService({
    fetchProvider: new HttpFetchProvider({ policy: { allowPrivateNetwork: true } }),
    searchProvider: new TavilySearchProvider({ apiKey: null }),
    documents: new InMemoryStore(),
    limits: { maxFetchChars: options.maxFetchChars ?? 50_000 },
    now: () => new Date('2026-08-01T00:00:00Z'),
    ...(base ? {} : {}),
  });
}

describe('web_fetch backend', () => {
  it('extracts readable text, title and source metadata', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Docs</title><style>.x{}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>World &amp; friends</p></body></html>');
    });
    const result = await service(base).fetch({
      userId: 'u1',
      conversationId: 'c1',
      actionId: 'a1',
      url: `${base}/docs`,
    });
    expect(result.title).toBe('Docs');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World & friends');
    expect(result.text).not.toContain('alert(1)');
    expect(result.text).not.toContain('h1');
  });

  it('follows a redirect and records the final URL', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { location: '/new' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final page');
    });
    const result = await service(base).fetch({
      userId: 'u1',
      conversationId: 'c1',
      actionId: null,
      url: `${base}/old`,
    });
    expect(result.finalUrl).toBe(`${base}/new`);
    expect(result.text).toBe('final page');
  });

  it('decompresses gzip and respects the char limit with a cursor', async () => {
    const body = gzipSync(Buffer.from('0123456789abcdefghij'.repeat(3), 'utf8'));
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(body);
    });
    const web = service(base, { maxFetchChars: 10 });
    const first = await web.fetch({
      userId: 'u1',
      conversationId: 'c1',
      actionId: null,
      url: `${base}/long`,
    });
    expect(first.text).toHaveLength(10);
    expect(first.cursor).toBeTruthy();
    const second = await web.fetch({
      userId: 'u1',
      conversationId: 'c1',
      actionId: null,
      url: `${base}/long`,
      cursor: first.cursor as string,
    });
    expect(second.documentId).toBe(first.documentId);
    expect(second.text).not.toBe(first.text);
  });

  it('maps 404, 429, login walls and binary types to distinct errors', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/missing') {
        res.writeHead(404);
        res.end('no');
        return;
      }
      if (req.url === '/limited') {
        res.writeHead(429);
        res.end('slow down');
        return;
      }
      if (req.url === '/login') {
        res.writeHead(401);
        res.end('login');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7');
    });
    const web = service(base);
    const call = (path: string) =>
      web.fetch({ userId: 'u1', conversationId: 'c1', actionId: null, url: `${base}${path}` });

    await expect(call('/missing')).rejects.toMatchObject({ code: 'WEB_HTTP_ERROR' });
    await expect(call('/limited')).rejects.toMatchObject({ code: 'WEB_RATE_LIMIT', retryable: true });
    await expect(call('/login')).rejects.toMatchObject({ code: 'WEB_AUTH' });
    await expect(call('/doc.pdf')).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_TYPE' });
  });

  it('rejects private and loopback addresses by default', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('private');
    });
    const blocking = new WebService({
      fetchProvider: new HttpFetchProvider({}),
      searchProvider: new TavilySearchProvider({ apiKey: null }),
      documents: new InMemoryStore(),
    });
    await expect(
      blocking.fetch({ userId: 'u1', conversationId: 'c1', actionId: null, url: `${base}/x` }),
    ).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
  });

  it('classifies private IPv4/IPv6 and rejects credentials in URLs', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(() => assertPublicUrl('https://user:pass@example.com/')).toThrow(WebError);
  });

  it('does not treat a login page as readable content', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>Sign in</title><body><form action="/login"><input type="password"></form></body></html>');
    });
    await expect(
      service(base).fetch({
        userId: 'u1',
        conversationId: 'c1',
        actionId: null,
        url: `${base}/`,
      }),
    ).rejects.toMatchObject({ code: 'WEB_AUTH' });
  });
});

describe('Tavily adapter', () => {
  it('posts basic search and normalizes sources', async () => {
    let received = '';
    const endpoint = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            results: [
              { title: 'Doc', url: 'https://example.com/doc', content: 'summary', published_date: '2026-01-02', score: 0.9 },
              { title: '', url: 'https://example.com/no-date', content: 'other' },
            ],
          }),
        );
      });
    });
    const provider = new TavilySearchProvider({ apiKey: 'tvly-test', endpoint: `${endpoint}/search` });
    const response = await provider.search({ query: 'typescript lsp', maxResults: 5 });
    expect(response.results).toHaveLength(2);
    expect(response.results[1]?.publishedAt).toBeNull();
    expect(response.billed).toBe(true);
    const sent = JSON.parse(received) as Record<string, unknown>;
    expect(sent).toMatchObject({
      query: 'typescript lsp',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      search_depth: 'basic',
    });
    expect(JSON.stringify(sent)).toContain('tvly-test');
  });

  it('maps auth, rate limit and missing key', async () => {
    const endpoint = await listen((req, res) => {
      res.writeHead(req.url === '/auth' ? 401 : 429);
      res.end('no');
    });
    const auth = new TavilySearchProvider({ apiKey: 'k', endpoint: `${endpoint}/auth` });
    await expect(auth.search({ query: 'q', maxResults: 5 })).rejects.toMatchObject({ code: 'WEB_AUTH' });
    const limited = new TavilySearchProvider({ apiKey: 'k', endpoint: `${endpoint}/limited` });
    await expect(limited.search({ query: 'q', maxResults: 5 })).rejects.toMatchObject({
      code: 'WEB_RATE_LIMIT',
      retryable: true,
    });
    const none = new TavilySearchProvider({ apiKey: null });
    await expect(none.search({ query: 'q', maxResults: 5 })).rejects.toMatchObject({
      code: 'WEB_NOT_CONFIGURED',
    });
    expect(none.status().configured).toBe(false);
  });
});

describe('HTML extraction', () => {
  it('decodes entities and removes scripts', () => {
    const { title, text } = extractHtml(
      '<title>A &amp; B</title><script>x()</script><p>1 &lt; 2 &#x4e2d;</p>',
    );
    expect(title).toBe('A & B');
    expect(text).toContain('1 < 2 中');
    expect(text).not.toContain('x()');
  });
});

describe('pinnedLookup (autoSelectFamily compatibility)', () => {
  it('returns a string for the legacy shape and an array when all=true', async () => {
    const { pinnedLookup } = await import('../../src/web/fetch-http.ts');
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    const legacy = await new Promise<unknown>((resolve, reject) => {
      lookup('example.com', 0, (error, address) => (error ? reject(error) : resolve(address)));
    });
    expect(legacy).toBe('93.184.216.34');
    const all = await new Promise<unknown>((resolve, reject) => {
      lookup('example.com', { all: true }, (error, address) =>
        error ? reject(error) : resolve(address),
      );
    });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
