/**
 * The egress proxy's refusal paths, over a real socket.
 *
 * A forward proxy is the only network egress a sandbox is supposed to have. The
 * policy tests cover the address logic; these cover the HTTP surface that actually
 * answers a request: a disallowed target is 403, a flood is 429, and CONNECT to a
 * metadata host is refused before any socket is opened.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { EgressPolicy } from '../../src/sandbox/network/egress-policy.ts';
import { createEgressProxy, type EgressAuditEvent } from '../../src/sandbox/network/egress-proxy.ts';

const servers: { close: (callback?: () => void) => void }[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as { close: (callback?: () => void) => void };
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startProxy(options: {
  policy: EgressPolicy;
  audit?: (event: EgressAuditEvent) => void;
}): Promise<number> {
  const server = createEgressProxy(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no proxy address');
  return address.port;
}

function throughProxy(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: target,
        headers: { host: new URL(target).host },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy', () => {
  it('refuses a domain that is not allowlisted', async () => {
    const events: EgressAuditEvent[] = [];
    const port = await startProxy({
      policy: new EgressPolicy({ allowedDomains: [], allowedPorts: [] }),
      audit: (event) => events.push(event),
    });
    const response = await throughProxy(port, 'http://evil.test/');
    expect(response.status).toBe(403);
    expect(response.body).toContain('blocked');
    expect(events[0]?.allowed).toBe(false);
  });

  it('refuses an IP literal through the proxy even when the host is allowlisted', async () => {
    const port = await startProxy({
      policy: new EgressPolicy({ allowedDomains: ['127.0.0.1'], allowedPorts: [80] }),
    });
    const response = await throughProxy(port, 'http://127.0.0.1/');
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/IP literal|blocked/);
  });

  it('refuses CONNECT to a metadata hostname', async () => {
    const port = await startProxy({
      policy: new EgressPolicy({ allowedDomains: ['metadata.google.internal'], allowedPorts: [80] }),
    });
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write('CONNECT metadata.google.internal:80 HTTP/1.1\r\nHost: metadata.google.internal:80\r\n\r\n');
      });
      socket.on('data', (chunk: string) => {
        data += chunk;
        if (data.includes('\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 2_000).unref();
    });
    expect(response).toContain('403');
  });

  it('rate-limits a flood', async () => {
    const port = await startProxy({
      policy: new EgressPolicy({
        allowedDomains: [],
        allowedPorts: [],
        maxRequestsPerMinute: 1,
      }),
    });
    const first = await throughProxy(port, 'http://evil.test/');
    const second = await throughProxy(port, 'http://evil.test/');
    expect(first.status).toBe(403);
    expect(second.status).toBe(429);
  });
});
