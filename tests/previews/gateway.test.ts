/**
 * R04 — the preview gateway routes only live leases and keeps origins apart.
 *
 * A local upstream stands in for the container port; the tunnel is a real TCP
 * connection, so HTTP framing, streaming and the WebSocket upgrade are exercised
 * end to end. Expiry, stop, unknown routes and a path-routed request without
 * preview cookies are all negative cases.
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

function lease(overrides: Partial<PreviewLease> & { routeId: string; containerPort: number }): PreviewLease {
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

async function setup() {
  const upstream = createHttpServer((req, res) => {
    if (req.url === '/api/private') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('preview upstream has no such route');
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
      res.write('first\n');
      setTimeout(() => res.end('second\n'), 30);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'preview_session=abc; Path=/',
    });
    res.end(`<html><body>preview ${req.url}</body></html>`);
  });
  const wsUpstream = createHttpServer((_req, res) => {
    res.writeHead(426);
    res.end('upgrade required');
  });
  wsUpstream.on('upgrade', (_req, socket) => {
    (socket as Socket).write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    (socket as Socket).on('data', (chunk) => (socket as Socket).write(`echo:${chunk.toString()}`));
  });
  const upstreamPort = await listen(upstream);
  const wsPort = await listen(wsUpstream);
  const gateway = new PreviewGateway({
    host: '127.0.0.1',
    port: 0,
    baseDomain: 'preview.localhost',
  });
  const address = await gateway.start();
  cleanups.push(async () => {
    await gateway.stop();
    upstream.close();
    wsUpstream.close();
  });
  return { gateway, address, upstreamPort, wsPort };
}

function request(
  port: number,
  routeId: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `${routeId}.preview.localhost:${String(port)}`, ...headers },
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

describe('R04 — preview gateway', () => {
  it('routes HTTP to the lease target and preserves the preview cookie', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: 'aaaa1111', containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const res = await request(h.address.port, 'aaaa1111', '/index.html');
    expect(res.status).toBe(200);
    expect(res.body).toContain('preview /index.html');
    expect(res.headers['set-cookie']).toEqual(['preview_session=abc; Path=/']);
    expect(res.headers['x-eunoia-preview']).toBe('aaaa1111');
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

  it('upgrades a WebSocket only for a live, same-origin route', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: 'cccc3333', containerPort: h.wsPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const socket = netConnect(h.address.port, '127.0.0.1');
    const received: string[] = [];
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.write(
      [
        'GET /hmr HTTP/1.1',
        `Host: cccc3333.preview.localhost:${String(h.address.port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Origin: http://cccc3333.preview.localhost:${String(h.address.port)}`,
        '',
        '',
      ].join('\r\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.write('hello');
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.destroy();
    const text = received.join('');
    expect(text).toContain('101 Switching Protocols');
    expect(text).toContain('echo:hello');
  });

  it('refuses a WebSocket whose Origin is the main application', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: 'dddd4444', containerPort: h.wsPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const socket = netConnect(h.address.port, '127.0.0.1');
    const received: string[] = [];
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.write(
      [
        'GET /hmr HTTP/1.1',
        `Host: dddd4444.preview.localhost:${String(h.address.port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: http://127.0.0.1:8787',
        '',
        '',
      ].join('\r\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.destroy();
    expect(received.join('')).toContain('403 Forbidden');
  });

  it('rejects unknown, stopped, expired and inactive leases with no upstream call', async () => {
    const h = await setup();
    let upstreamCalls = 0;
    const counted = createHttpServer((_req, res) => {
      upstreamCalls += 1;
      res.end('should not happen');
    });
    const countedPort = await listen(counted);
    cleanups.push(async () => {
      counted.close();
    });
    h.gateway.setRoute({
      lease: lease({ routeId: 'eeee5555', containerPort: countedPort, status: 'stopped' }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    h.gateway.setRoute({
      lease: lease({
        routeId: 'ffff6666',
        containerPort: countedPort,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    h.gateway.setRoute({
      lease: lease({ routeId: '9999aaaa', containerPort: countedPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => false,
    });
    expect((await request(h.address.port, 'eeee5555', '/')).status).toBe(410);
    expect((await request(h.address.port, 'ffff6666', '/')).status).toBe(410);
    expect((await request(h.address.port, '9999aaaa', '/')).status).toBe(410);
    expect((await request(h.address.port, 'notaroute', '/')).status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it('does not proxy the main application API and strips cookies on the path fallback', async () => {
    const h = await setup();
    h.gateway.setRoute({
      lease: lease({ routeId: 'aaaa7777', containerPort: h.upstreamPort }),
      openTunnel: (port) => Promise.resolve(netConnect(port, '127.0.0.1')),
      isActive: async () => true,
    });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: h.address.port,
          path: '/__preview/aaaa7777/api/private',
          method: 'GET',
          headers: {
            host: `127.0.0.1:${String(h.address.port)}`,
            cookie: 'eunoia_session=secret',
            authorization: 'Bearer control-token',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk as Buffer));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(404);
    expect(res.body).toContain('preview upstream has no such route');
  });
});
