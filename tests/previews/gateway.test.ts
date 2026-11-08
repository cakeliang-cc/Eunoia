/**
 * R04 — the preview gateway routes only live leases and keeps origins apart.
 *
 * Every refusal is checked against a server-side HTTP/upgrade counter: a 403
 * string while the upstream still received the request would fail these tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { once } from 'node:events';
import { PreviewGateway } from '../../src/previews/gateway.ts';
import type { PreviewLease } from '../../src/previews/types.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no address');
  return address.port;
}

function lease(
  overrides: Partial<PreviewLease> & { routeId: string; containerPort: number },
): PreviewLease {
  return {
    id: `prv_${overrides.routeId}`,
    jobId: 'job-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    memberId: null,
    runId: null,
    taskId: 'conv-1',
    sandboxId: 'sbx-1',
    workspaceId: 'ws-1',
    status: 'ready',
    generation: 1,
    userUrl: null,
    browserUrl: null,
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastOpenedAt: null,
    error: null,
    ...overrides,
  };
}

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function setup() {
  const httpCalls: Captured[] = [];
  const wsCalls: Captured[] = [];
  const upstream = createHttpServer((req, res) => {
    httpCalls.push({ url: req.url ?? '/', headers: req.headers });
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
      res.write('first\n');
      setTimeout(() => res.end('second\n'), 30);
      return;
    }
    const previewHost = String(req.headers['x-forwarded-host'] ?? 'preview.localhost');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': [
        'host_only=1; Path=/; HttpOnly',
        'broad=1; Domain=.preview.localhost; Path=/',
        `exact=1; Domain=${previewHost}; Path=/`,
        'other=1; Domain=evil.example; Path=/',
      ],
    });
    res.end(`<html><body>preview ${req.url}</body></html>`);
  });
  const wsUpstream = createHttpServer((_req, res) => {
    res.writeHead(426);
    res.end('upgrade required');
  });
  wsUpstream.on('upgrade', (req, socket) => {
    wsCalls.push({ url: req.url ?? '/', headers: req.headers });
    (socket as Socket).write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    (socket as Socket).on('data', (chunk) => (socket as Socket).write(`echo:${chunk.toString()}`));
  });
  const upstreamPort = await listen(upstream);
  const wsPort = await listen(wsUpstream);
  const gateway = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
  const address = await gateway.start();
  cleanups.push(async () => {
    await gateway.stop();
    upstream.close();
    wsUpstream.close();
  });
  return { gateway, address, upstreamPort, wsPort, httpCalls, wsCalls };
}

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function request(
  port: number,
  routeId: string,
  path: string,
  headers: Record<string, string> = {},
  host?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: host ?? `${routeId}.preview.localhost:${String(port)}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function websocketRequest(
  port: number,
  routeId: string,
  headers: Record<string, string> = {},
  path = '/hmr',
  host?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    const received: string[] = [];
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.on('error', reject);
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${host ?? `${routeId}.preview.localhost:${String(port)}`}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n'),
    );
    setTimeout(() => {
      socket.write('hello');
      setTimeout(() => {
        socket.destroy();
        resolve(received.join(''));
      }, 120);
    }, 120);
  });
}

describe('R04 — preview gateway', () => {
  it('routes a no-Origin navigation, passes the preview cookie and narrows Set-Cookie scope', async () => {
    const h = await setup();
    const routeId = 'aaaa1111';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const res = await request(h.address.port, routeId, '/index.html', {
      cookie: 'preview_own=1',
      authorization: 'Bearer main-app-token',
      'x-forwarded-host': 'evil.example',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('preview /index.html');
    const upstream = h.httpCalls[0] as Captured;
    expect(upstream.headers['cookie']).toBe('preview_own=1');
    expect(upstream.headers['authorization']).toBeUndefined();
    expect(upstream.headers['x-forwarded-host']).toBe(`${routeId}.preview.localhost`);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((entry) => entry.startsWith('host_only=1'))).toBe(true);
    expect(cookies.some((entry) => entry.startsWith('exact=1'))).toBe(true);
    expect(cookies.some((entry) => entry.startsWith('broad=1'))).toBe(false);
    expect(cookies.some((entry) => entry.startsWith('other=1'))).toBe(false);
    expect(cookies.every((entry) => !/domain=/i.test(entry))).toBe(true);
    expect(res.headers['x-eunoia-preview']).toBe(routeId);
  });

  it('streams a chunked response through the tunnel', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: 'bbbb2222', containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const res = await request(h.address.port, 'bbbb2222', '/stream');
    expect(res.status).toBe(200);
    expect(res.body).toContain('first');
    expect(res.body).toContain('second');
  });

  it('accepts HTTP only from its own full origin and never reaches upstream on a mismatch', async () => {
    const h = await setup();
    const routeId = 'cccc3333';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const expected = `http://${routeId}.preview.localhost:${String(h.address.port)}`;
    expect((await request(h.address.port, routeId, '/', { origin: expected })).status).toBe(200);
    const before = h.httpCalls.length;
    expect((await request(h.address.port, routeId, '/', { origin: `https://${routeId}.preview.localhost:1` })).status).toBe(403);
    expect((await request(h.address.port, routeId, '/', { origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await request(h.address.port, routeId, '/', { origin: 'null' })).status).toBe(403);
    expect(h.httpCalls.length).toBe(before);
  });

  it('does not provide a path- or header-based route that skips the Host and Origin checks', async () => {
    const h = await setup();
    const routeId = 'dddd4444';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const before = h.httpCalls.length;
    const path = `/__preview/${routeId}/api/private`;
    const res = await request(h.address.port, routeId, path, {
      cookie: 'eunoia_session=secret',
      authorization: 'Bearer control-token',
    }, `127.0.0.1:${String(h.address.port)}`);
    expect(res.status).toBe(404);
    const headerRes = await request(h.address.port, routeId, '/', {
      'x-eunoia-preview-route': routeId,
      cookie: 'eunoia_session=secret',
    }, `127.0.0.1:${String(h.address.port)}`);
    expect(headerRes.status).toBe(404);
    expect(h.httpCalls.length).toBe(before);
  });

  it('upgrades a WebSocket only for the exact full preview Origin', async () => {
    const h = await setup();
    const routeId = 'eeee5555';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.wsPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const expected = `http://${routeId}.preview.localhost:${String(h.address.port)}`;
    const text = await websocketRequest(h.address.port, routeId, {
      Origin: expected,
      Cookie: 'preview_own=1',
      Authorization: 'Bearer main-app-token',
    });
    expect(text).toContain('101 Switching Protocols');
    expect(text).toContain('echo:hello');
    expect(h.wsCalls).toHaveLength(1);
    expect(h.wsCalls[0]?.headers['cookie']).toBe('preview_own=1');
    expect(h.wsCalls[0]?.headers['authorization']).toBeUndefined();
    expect(h.wsCalls[0]?.headers['origin']).toBe(expected);
  });

  it('refuses WebSocket scheme/port/null/missing/wrong-origin requests before opening a tunnel', async () => {
    const h = await setup();
    const routeId = 'ffff6666';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.wsPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const cases: Array<Record<string, string>> = [
      { Origin: `https://${routeId}.preview.localhost:${String(h.address.port)}` },
      { Origin: `http://${routeId}.preview.localhost:1` },
      { Origin: 'https://untrusted.example' },
      { Origin: 'null' },
      {},
    ];
    for (const headers of cases) {
      expect(await websocketRequest(h.address.port, routeId, headers)).toContain('403 Forbidden');
    }
    expect(h.wsCalls).toHaveLength(0);
  });

  it('refuses path fallback WebSocket requests without opening a tunnel', async () => {
    const h = await setup();
    const routeId = '9999aaaa';
    h.gateway.setRoute({
      lease: lease({ routeId, containerPort: h.wsPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const text = await websocketRequest(
      h.address.port,
      routeId,
      { Origin: `http://${routeId}.preview.localhost:${String(h.address.port)}` },
      `/__preview/${routeId}/hmr`,
      `127.0.0.1:${String(h.address.port)}`,
    );
    expect(text).toContain('404 Preview Unavailable');
    expect(h.wsCalls).toHaveLength(0);
  });

  it('rejects unknown, stopped, expired and inactive leases with zero upstream calls', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: '12121212', containerPort: h.upstreamPort, status: 'stopped' }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    h.gateway.setRoute({
      lease: lease({
        routeId: '34343434',
        containerPort: h.upstreamPort,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    h.gateway.setRoute({
      lease: lease({ routeId: '56565656', containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => false,
    });
    expect((await request(h.address.port, '12121212', '/')).status).toBe(410);
    expect((await request(h.address.port, '34343434', '/')).status).toBe(410);
    expect((await request(h.address.port, '56565656', '/')).status).toBe(410);
    expect((await request(h.address.port, 'notaroute', '/')).status).toBe(404);
    expect(h.httpCalls).toHaveLength(0);
    expect(h.wsCalls).toHaveLength(0);
  });
});
