import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createEgressProxy } from '../../src/sandbox/network/egress-proxy.ts';
import { EgressPolicy } from '../../src/sandbox/network/egress-policy.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

describe('preview CONNECT never exposes a raw gateway socket', () => {
  it.each([
    ['GET / HTTP/1.1\r\nHost: sibling.preview.localhost:8790\r\nConnection: close\r\n\r\n', '400'],
    ['GET http://example.com/ HTTP/1.1\r\nHost: owned.preview.localhost:8790\r\nConnection: close\r\n\r\n', '400'],
    ['CONNECT example.com:443 HTTP/1.1\r\nHost: owned.preview.localhost:8790\r\n\r\n', '403'],
    ['GET / HTTP/1.1\r\nHost: owned.preview.localhost:8790\r\nConnection: close\r\n\r\n', '200'],
  ])('parses the inner HTTP origin: %s', async (inner, expected) => {
    let reached = 0;
    const target = createServer((_req, res) => { reached++; res.end('owned-preview'); });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => { target.closeAllConnections(); target.close(() => resolve()); }));
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('no target');
    const proxy = createEgressProxy({ policy: new EgressPolicy({ allowedDomains: ['example.com'], allowedPorts: [443] }), previewRoute: async (url) => url.origin === 'http://owned.preview.localhost:8790' ? { address: '127.0.0.1', port: address.port } : null });
    const sockets = new Set<Socket>();
    proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); proxy.close(() => resolve()); }));
    const bound = proxy.address();
    if (!bound || typeof bound === 'string') throw new Error('no proxy');
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(bound.port, '127.0.0.1');
      let data = ''; let handshaken = false;
      socket.setTimeout(3_000, () => socket.destroy(new Error('test timeout')));
      socket.on('connect', () => socket.write('CONNECT owned.preview.localhost:8790 HTTP/1.1\r\nHost: owned.preview.localhost:8790\r\n\r\n'));
      socket.on('data', (bytes) => {
        data += bytes.toString();
        if (!handshaken && data.includes('\r\n\r\n')) { expect(data).toContain('200 Connection Established'); handshaken = true; data = ''; socket.write(inner); }
      });
      socket.on('error', reject); socket.on('end', () => resolve(data));
    });
    expect(response).toContain(`HTTP/1.1 ${expected}`);
    expect(reached).toBe(expected === '200' ? 1 : 0);
  });
});
