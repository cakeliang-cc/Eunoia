/**
 * The Host header is part of the security boundary.
 *
 * Binding to 127.0.0.1 does not stop DNS rebinding: an attacker's domain can
 * resolve to loopback, and the browser then sends that domain in `Host` while
 * treating the request as same-origin. The same-origin checks the workspace UI
 * performs compare `Origin` to `Host`, so under rebinding they agree and pass.
 *
 * These tests pin the outer lock: a request must be addressed to a name this
 * process answers to before any route runs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../../src/api/server.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';

let server: Server | null = null;
const savedAllowed = process.env.EUNOIA_ALLOWED_HOSTS;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server?.closeAllConnections?.();
    });
    server = null;
  }
  if (savedAllowed === undefined) delete process.env.EUNOIA_ALLOWED_HOSTS;
  else process.env.EUNOIA_ALLOWED_HOSTS = savedAllowed;
});

async function start(): Promise<number> {
  server = createApp({ store: new InMemoryStore() });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function get(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the Host header', () => {
  it('accepts a request addressed to loopback', async () => {
    const port = await start();
    const response = await get(port, '/health', `127.0.0.1:${port}`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).status).toBe('ok');
  });

  it('refuses a request addressed to a name this process does not answer to', async () => {
    const port = await start();
    const response = await get(port, '/health', `evil.example:${port}`);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error).toBe('host not allowed');
  });

  it('refuses the page and the token it carries to an unlisted host', async () => {
    const port = await start();
    const response = await get(port, '/', `evil.example:${port}`);
    expect(response.status).toBe(403);
    expect(response.body).not.toContain('eunoia-token');
  });

  it('accepts an operator-named host when it is explicitly allowed', async () => {
    process.env.EUNOIA_ALLOWED_HOSTS = 'dev.internal, evil.example';
    const port = await start();
    const response = await get(port, '/health', `evil.example:${port}`);
    expect(response.status).toBe(200);
  });
});
