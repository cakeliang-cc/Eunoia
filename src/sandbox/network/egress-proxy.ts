/**
 * The Egress Proxy.
 *
 * A sandbox with `network.mode = "proxy_only"` is attached to an operator-managed
 * network whose only route is this proxy. The proxy is where DNS resolution,
 * IP-range checks and per-request accounting happen, because the sandbox itself
 * must not be trusted to apply its own network policy (ADR §5.2).
 *
 * Both HTTP and HTTPS (CONNECT) are handled. For CONNECT the proxy can check the
 * destination and the resolved address, but not the request inside the TLS
 * tunnel; that is a real limitation of a forward proxy and is documented in the
 * ops guide rather than papered over. The domain/port allowlist still bounds
 * what the tunnel can reach.
 *
 * This module imports `node:http`/`node:net`; it is deliberately outside the
 * transport-agnostic core. The architecture test pins that exception to this one
 * file.
 */

import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { EgressPolicy, type EgressDecision, type Resolver } from './egress-policy.ts';

export interface EgressAuditEvent {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
  readonly reason: string;
  readonly bytes: number;
}

export interface EgressProxyOptions {
  readonly policy: EgressPolicy;
  readonly resolver?: Resolver;
  readonly audit?: (event: EgressAuditEvent) => void;
  /** Per-request idle timeout. */
  readonly timeoutMs?: number;
}

const defaultResolver: Resolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

export function createEgressProxy(options: EgressProxyOptions): ReturnType<typeof createServer> {
  const resolver = options.resolver ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestTimes: number[] = [];

  const rateLimited = (): boolean => {
    const now = Date.now();
    while (requestTimes.length > 0 && (requestTimes[0] as number) < now - 60_000) requestTimes.shift();
    if (requestTimes.length >= options.policy.maxRequestsPerMinute) return true;
    requestTimes.push(now);
    return false;
  };

  const decide = async (host: string, port: number): Promise<EgressDecision> => {
    const decision = await options.policy.evaluate(host, port, resolver);
    if (!decision.allowed) {
      options.audit?.({
        host,
        port,
        allowed: false,
        reason: decision.reason,
        bytes: 0,
      });
    }
    return decision;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`proxy error: ${error instanceof Error ? error.message : String(error)}\n`);
      } else {
        res.destroy();
      }
    });
  });

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void handleConnect(req, clientSocket, head).catch(() => clientSocket.destroy());
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (rateLimited()) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proxy rate limit exceeded\n');
      return;
    }
    const raw = req.url ?? '';
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('absolute-form URL required\n');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('only http and https are proxied\n');
      return;
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const decision = await decide(url.hostname, port);
    if (!decision.allowed || !decision.address) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`blocked: ${decision.reason}\n`);
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === 'proxy-authorization' || key.toLowerCase() === 'proxy-connection') continue;
      headers[key] = value;
    }
    headers.host = url.host;

    let received = 0;
    const upstream = httpRequest(
      {
        protocol: url.protocol,
        host: decision.address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        // TLS verification for https forward-proxying uses CONNECT, not this path.
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.policy.maxBytesPerRequest) {
            res.destroy();
            upstreamRes.destroy();
            return;
          }
          res.write(chunk);
        });
        upstreamRes.on('end', () => res.end());
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream error: ${error.message}\n`);
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
    res.on('close', () => {
      options.audit?.({
        host: url.hostname,
        port,
        allowed: true,
        reason: decision.reason,
        bytes: received,
      });
    });
  }

  async function handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (rateLimited()) {
      clientSocket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return;
    }
    const target = req.url ?? '';
    const parsed = parseHostPort(target);
    if (!parsed) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const decision = await decide(parsed.host, parsed.port);
    if (!decision.allowed || !decision.address) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Egress-Reason: ${safeHeader(decision.reason)}\r\n\r\n`);
      return;
    }

    const upstream = netConnect({ host: decision.address, port: parsed.port });
    upstream.setTimeout(timeoutMs, () => upstream.destroy());
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      let bytes = 0;
      upstream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.policy.maxBytesPerRequest) {
          upstream.destroy();
          clientSocket.destroy();
          return;
        }
        clientSocket.write(chunk);
      });
      clientSocket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.policy.maxBytesPerRequest) {
          upstream.destroy();
          clientSocket.destroy();
          return;
        }
        upstream.write(chunk);
      });
      upstream.on('close', () => {
        options.audit?.({
          host: parsed.host,
          port: parsed.port,
          allowed: true,
          reason: decision.reason,
          bytes,
        });
        clientSocket.end();
      });
      clientSocket.on('close', () => upstream.destroy());
    });
    upstream.on('error', () => {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  }

  return server;
}

function parseHostPort(value: string): { host: string; port: number } | null {
  // CONNECT authority form: `example.com:443` or `[2001:db8::1]:443`.
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return isIP(host) !== 0 && validPort(port) ? { host, port } : null;
  }
  const index = value.lastIndexOf(':');
  if (index <= 0) return null;
  const host = value.slice(0, index).toLowerCase();
  const port = Number(value.slice(index + 1));
  if (host.length === 0 || !validPort(port)) return null;
  return { host, port };
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]/g, ' ').slice(0, 200);
}
