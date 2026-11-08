/**
 * The Egress Proxy.
 *
 * A sandbox with `network.mode = "proxy_only"` keeps network:none and reaches
 * this proxy only through a managed reverse control pipe. The proxy is where DNS resolution,
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
  /** Trusted preview lease resolver. Never used for CONNECT or arbitrary ports. */
  readonly previewRoute?: (url: URL) => Promise<{ readonly address: string; readonly port: number } | null>;
}

const defaultResolver: Resolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

export function createEgressProxy(options: EgressProxyOptions): ReturnType<typeof createServer> {
  const resolver = options.resolver ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestTimes: number[] = [];
  // Chromium also CONNECTs plain ws:// URLs. An owned-preview CONNECT is
  // parsed again as HTTP, with its origin pinned; it is never a raw gateway
  // socket on which a different lease's Host could be smuggled.
  const previewTunnels = new WeakMap<Socket, URL>();
  const requestUrl = (req: IncomingMessage): URL => {
    const pinned = previewTunnels.get(req.socket);
    const raw = req.url ?? '';
    const url = pinned ? new URL(raw, pinned) : new URL(raw);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (pinned && (url.origin !== pinned.origin || String(req.headers.host ?? '').toLowerCase() !== pinned.host.toLowerCase())) throw new Error('preview tunnel origin mismatch');
    return url;
  };

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
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('absolute-form URL required\n');
      return;
    }
    if (url.protocol !== 'http:' || url.username || url.password) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('use absolute http URLs or CONNECT for HTTPS; URL credentials are refused\n');
      return;
    }
    if (res.destroyed) return;
    const port = Number(url.port || 80);
    const preview = await options.previewRoute?.(url);
    const decision = preview
      ? { allowed: true, address: preview.address, reason: 'owned preview lease' }
      : await decide(url.hostname, port);
    if (!decision.allowed || !decision.address) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`blocked: ${decision.reason}\n`);
      return;
    }

    if (res.destroyed) return;
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
        port: preview?.port ?? port,
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
    req.on('data', (chunk: Buffer) => { received += chunk.length; if (received > options.policy.maxBytesPerRequest) { upstream.destroy(); res.destroy(); } });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
    res.on('close', () => {
      upstream.destroy();
      options.audit?.({
        host: url.hostname,
        port,
        allowed: true,
        reason: decision.reason,
        bytes: received,
      });
    });
  }

  // Only a verified preview lease can upgrade. Preview CONNECT is re-parsed
  // through requestUrl; public CONNECT remains bounded by the public policy.
  server.on('upgrade', (req, client, head) => {
    void (async () => {
      const url = requestUrl(req);
      const route = url.protocol === 'http:' ? await options.previewRoute?.(url) : null;
      if (!route || rateLimited()) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest({ host: route.address, port: route.port, method: 'GET', path: `${url.pathname}${url.search}`, headers, timeout: timeoutMs });
      upstream.on('upgrade', (response, socket, upstreamHead) => {
        client.write(`HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n`);
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) client.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
        }
        client.write('\r\n');
        if (upstreamHead.length) client.write(upstreamHead);
        if (head.length) socket.write(head);
        let bytes = 0;
        const count = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > options.policy.maxBytesPerRequest) { socket.destroy(); client.destroy(); } };
        socket.on('data', count); client.on('data', count);
        socket.setTimeout(timeoutMs, () => socket.destroy());
        socket.on('error', () => client.destroy()); client.on('error', () => socket.destroy());
        socket.on('close', () => client.destroy()); client.on('close', () => socket.destroy());
        socket.pipe(client); client.pipe(socket);
      });
      upstream.on('response', (response) => { response.resume(); client.end(`HTTP/1.1 ${response.statusCode ?? 502} Preview rejected\r\n\r\n`); });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.end();
    })().catch(() => client.destroy());
  });

  async function handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (rateLimited()) {
      clientSocket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return;
    }
    if (previewTunnels.has(clientSocket)) { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const target = req.url ?? '';
    const parsed = parseHostPort(target);
    if (!parsed) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (clientSocket.destroyed) return;
    const authority = parsed.host.includes(':') && !parsed.host.startsWith('[') ? `[${parsed.host}]` : parsed.host;
    const previewUrl = new URL(`http://${authority}:${parsed.port}/`);
    const preview = await options.previewRoute?.(previewUrl);
    if (clientSocket.destroyed) return;
    if (preview) {
      previewTunnels.set(clientSocket, previewUrl);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.setTimeout(timeoutMs, () => clientSocket.destroy());
      let bytes = head.length;
      clientSocket.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.policy.maxBytesPerRequest) clientSocket.destroy(); });
      server.emit('connection', clientSocket);
      if (head.length) clientSocket.unshift(head);
      return;
    }
    const decision = await decide(parsed.host, parsed.port);
    if (!decision.allowed || !decision.address) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Egress-Reason: ${safeHeader(decision.reason)}\r\n\r\n`);
      return;
    }

    if (clientSocket.destroyed) return;
    if (head.length > options.policy.maxBytesPerRequest) { clientSocket.destroy(); return; }
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
