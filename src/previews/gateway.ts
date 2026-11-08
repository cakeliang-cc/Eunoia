/**
 * The preview ingress gateway.
 *
 * It is deliberately not a general proxy: a request is routed to exactly one
 * live lease, and the lease names one container port. There is no caller-supplied
 * upstream, no path that reaches a sibling workspace and no route to the main
 * application's API.
 *
 * HTTP and WebSocket share the same lease check. The transport is a byte tunnel
 * over `docker exec -i` (see `OciRuntime.openTunnel`), so the sandbox keeps
 * `network:none` and nothing is published on a host interface.
 *
 * Each preview gets its own host label under `preview.localhost`, which gives it
 * a distinct origin: the main application's cookies are not sent to it and its
 * cookies are not sent to the main application.
 *
 * There is deliberately no path fallback and no `x-eunoia-preview-route`
 * header. Both shared the gateway's origin with every other preview and let a
 * caller name a route without the Host check; a fallback that skips the origin
 * boundary is not a fallback, it is a second ingress. A client that cannot
 * resolve the wildcard host must use a browser/runtime that can, or an explicit
 * authenticated ingress outside this gateway.
 */

import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { PreviewLease } from './types.ts';

export interface PreviewRoute {
  readonly lease: PreviewLease;
  readonly openTunnel: (port: number, signal?: AbortSignal) => Promise<Duplex>;
  readonly isActive: () => Promise<boolean>;
}

export interface PreviewGatewayOptions {
  readonly host: string;
  readonly port: number;
  readonly baseDomain: string;
  readonly now?: () => Date;
}

interface Found {
  readonly route: PreviewRoute;
  readonly path: string;
}

type RequestKind = 'http' | 'websocket';

const MAX_TUNNELS_PER_ROUTE = 64;

export class PreviewGateway {
  readonly #host: string;
  readonly #port: number;
  readonly #baseDomain: string;
  readonly #now: () => Date;
  readonly #routes = new Map<string, PreviewRoute>();
  readonly #tunnels = new Map<string, number>();
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #listening: { host: string; port: number } | null = null;

  constructor(options: PreviewGatewayOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#baseDomain = options.baseDomain.replace(/^\./, '').toLowerCase();
    this.#now = options.now ?? (() => new Date());
  }

  get address(): { host: string; port: number } | null {
    return this.#listening;
  }

  setRoute(route: PreviewRoute): void {
    this.#routes.set(route.lease.routeId, route);
  }

  removeRoute(routeId: string): void {
    this.#routes.delete(routeId);
  }

  routeCount(): number {
    return this.#routes.size;
  }

  /**
   * Start listening on loopback only.
   *
   * A remote deployment must put an authenticated ingress in front; this server
   * itself never pretends that a loopback bind is authentication.
   */
  async start(): Promise<{ host: string; port: number }> {
    if (this.#server) return this.#listening as { host: string; port: number };
    const server = createServer((req, res) => {
      void this.#handleHttp(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      this.#handleUpgrade(req, socket as Socket, head);
    });
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#port, this.#host);
    });
    this.#server = server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : this.#port;
    this.#listening = { host: this.#host, port };
    return this.#listening;
  }

  async stop(): Promise<void> {
    this.#routes.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    this.#listening = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sockets that keep the close from completing are already destroyed.
      setTimeout(resolve, 1_000).unref();
    });
  }

  /** Resolve a request to a live route, or explain why it is not one. */
  async resolve(
    req: IncomingMessage,
  ): Promise<{ ok: true; found: Found } | { ok: false; status: number; message: string }> {
    const hostHeader = String(req.headers.host ?? '').toLowerCase().trim();
    const withoutPort = hostHeader.replace(/:\d+$/, '');
    const path = req.url ?? '/';
    const suffix = `.${this.#baseDomain}`;
    if (!withoutPort.endsWith(suffix)) {
      return { ok: false, status: 404, message: 'preview requests must use the lease host' };
    }
    const routeId = withoutPort.slice(0, -suffix.length);
    // Exactly one unguessable label, no dots, no userinfo, no alternate host.
    if (!/^[a-f0-9]{8,64}$/.test(routeId)) {
      return { ok: false, status: 404, message: 'no preview route in this request' };
    }
    const route = this.#routes.get(routeId);
    if (!route) return { ok: false, status: 404, message: 'preview route is not active' };
    const lease = route.lease;
    if (lease.status !== 'ready') {
      return { ok: false, status: 410, message: `preview is ${lease.status}` };
    }
    if (lease.expiresAt <= this.#now().toISOString()) {
      return { ok: false, status: 410, message: 'preview lease expired' };
    }
    if (!(await route.isActive().catch(() => false))) {
      return { ok: false, status: 410, message: 'preview process is no longer running' };
    }
    return { ok: true, found: { route, path } };
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resolved = await this.resolve(req);
    if (!resolved.ok) {
      res.writeHead(resolved.status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(`${resolved.message}\n`);
      return;
    }
    const { route, path } = resolved.found;
    const port = route.lease.containerPort;
    const origin = this.#originAllowed(req, route, 'http');
    if (!origin.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`preview origin rejected: ${origin.reason}\n`);
      return;
    }
    if ((this.#tunnels.get(route.lease.routeId) ?? 0) >= MAX_TUNNELS_PER_ROUTE) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many concurrent preview connections\n');
      return;
    }
    const headers = this.#forwardHeaders(req, route, port, 'http');
    let tunnel: Duplex;
    try {
      tunnel = await route.openTunnel(port);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`preview tunnel failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    this.#count(route.lease.routeId, 1);
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    (agent as unknown as { createConnection: () => Duplex }).createConnection = () => tunnel;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      this.#count(route.lease.routeId, -1);
      tunnel.destroy();
    };
    res.on('close', done);
    const proxy = httpRequest(
      {
        method: req.method ?? 'GET',
        path,
        headers,
        // A per-request agent whose only connection is this tunnel. Passing
        // `createConnection` next to `agent:false` is ignored by Node, which
        // would silently connect to the URL instead of the lease.
        agent,
      },
      (proxyRes) => {
        const responseHeaders = this.#responseHeaders(proxyRes.headers, route);
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', done);
        proxyRes.on('error', done);
      },
    );
    proxy.setTimeout(180_000, () => {
      proxy.destroy(new Error('preview upstream timeout'));
    });
    proxy.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`preview upstream failed: ${error.message}\n`);
      } else {
        res.destroy();
      }
      done();
    });
    req.pipe(proxy);
  }

  #handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    void (async () => {
      const resolved = await this.resolve(req);
      if (!resolved.ok) {
        socket.end(`HTTP/1.1 ${resolved.status} Preview Unavailable\r\nConnection: close\r\n\r\n`);
        return;
      }
      const { route, path } = resolved.found;
      const origin = this.#originAllowed(req, route, 'websocket');
      if (!origin.ok) {
        socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${origin.reason}`);
        return;
      }
      let tunnel: Duplex;
      try {
        tunnel = await route.openTunnel(route.lease.containerPort);
      } catch {
        socket.end('HTTP/1.1 502 Preview Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      this.#count(route.lease.routeId, 1);
      const done = (): void => {
        this.#count(route.lease.routeId, -1);
        tunnel.destroy();
        socket.destroy();
      };
      socket.on('close', done);
      socket.on('error', done);
      tunnel.on('error', done);
      tunnel.on('close', done);
      const headers = this.#forwardHeaders(req, route, route.lease.containerPort, 'websocket');
      const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        const values = Array.isArray(value) ? value : [value];
        for (const entry of values) lines.push(`${name}: ${entry}`);
      }
      tunnel.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) tunnel.write(head);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    })();
  }

  /**
   * The one origin this lease is allowed to be used from.
   *
   * The gateway is HTTP-only on loopback; a TLS ingress in front must be
   * configured with a matching public origin instead of silently accepting
   * every scheme.
   */
  #previewOrigin(route: PreviewRoute): string {
    const port = this.#listening?.port ?? this.#port;
    return new URL(`http://${route.lease.routeId}.${this.#baseDomain}:${port}`).origin;
  }

  /**
   * Validate the complete Origin, not just a hostname.
   *
   * - WebSocket always requires an Origin and it must equal the lease origin
   *   exactly (scheme + host + port); `null` and missing values are refused.
   * - HTTP navigation has no Origin and is allowed. A present Origin must equal
   *   the lease origin; a cross-origin fetch therefore fails before a tunnel
   *   is opened. This is what stops a page on the main application, or another
   *   preview, from driving this lease with the browser's credentials.
   */
  #originAllowed(
    req: IncomingMessage,
    route: PreviewRoute,
    kind: RequestKind,
  ): { ok: true } | { ok: false; reason: string } {
    const raw = req.headers.origin;
    const expected = this.#previewOrigin(route);
    if (raw === undefined || raw === '') {
      return kind === 'websocket'
        ? { ok: false, reason: 'websocket request has no Origin' }
        : { ok: true };
    }
    if (raw === 'null') return { ok: false, reason: 'Origin is null' };
    if (typeof raw !== 'string') return { ok: false, reason: 'Origin is not a single value' };
    let actual: string;
    try {
      actual = new URL(raw).origin;
    } catch {
      return { ok: false, reason: 'Origin is not a valid URL' };
    }
    if (actual !== expected) {
      return { ok: false, reason: `Origin ${actual} is not ${expected}` };
    }
    return { ok: true };
  }

  /**
   * Build the upstream headers for both HTTP and WebSocket.
   *
   * The client is not allowed to name a different upstream host, to smuggle a
   * main-application Authorization header into the preview, or to spoof the
   * forwarding chain. Cookies belong to the preview's own host and are passed;
   * the preview origin is separate, so they are not the main application's
   * cookies.
   */
  #forwardHeaders(
    req: IncomingMessage,
    route: PreviewRoute,
    port: number,
    kind: RequestKind,
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    const hopByHop = new Set([
      'host',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'accept-encoding',
      'authorization',
      'forwarded',
    ]);
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (hopByHop.has(lower)) continue;
      if (lower.startsWith('x-forwarded-')) continue;
      headers[lower] = value;
    }
    // WebSocket handshake headers are required by the upstream server.
    if (kind === 'websocket') {
      headers['connection'] = 'Upgrade';
      const upgrade = req.headers.upgrade;
      if (typeof upgrade === 'string') headers['upgrade'] = upgrade;
    }
    headers['host'] = `127.0.0.1:${port}`;
    headers['x-forwarded-host'] = `${route.lease.routeId}.${this.#baseDomain}`;
    headers['x-forwarded-proto'] = 'http';
    return headers;
  }

  /** Response headers with cross-preview cookie scope removed. */
  #responseHeaders(
    upstream: NodeJS.Dict<string | string[]>,
    route: PreviewRoute,
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstream)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
      headers[lower] = value;
    }
    const cookies = headers['set-cookie'];
    if (cookies !== undefined) {
      const list = Array.isArray(cookies) ? cookies : [cookies];
      const kept = list
        .map((cookie) => this.#narrowCookie(cookie, route))
        .filter((cookie): cookie is string => cookie !== null);
      if (kept.length > 0) headers['set-cookie'] = kept;
      else delete headers['set-cookie'];
    }
    headers['x-eunoia-preview'] = route.lease.routeId;
    return headers;
  }

  /**
   * Keep a cookie only for the exact preview host.
   *
   * Browsers ignore the port in cookie scope. A `Domain=.preview.localhost`
   * cookie would therefore be readable by a sibling preview; removing the
   * Domain attribute makes it host-only, and a cookie explicitly scoped to a
   * different host is dropped entirely.
   */
  #narrowCookie(cookie: string, route: PreviewRoute): string | null {
    const host = `${route.lease.routeId}.${this.#baseDomain}`;
    const parts = cookie.split(';');
    const kept: string[] = [parts[0]?.trim() ?? ''];
    for (const raw of parts.slice(1)) {
      const part = raw.trim();
      if (part.length === 0) continue;
      const [rawName, ...rest] = part.split('=');
      const name = rawName?.trim().toLowerCase() ?? '';
      const value = rest.join('=');
      if (name === 'domain') {
        const domain = value.trim().replace(/^\./, '').toLowerCase();
        if (domain !== host) return null;
        continue;
      }
      kept.push(part);
    }
    if ((kept[0] ?? '').length === 0) return null;
    return kept.join('; ');
  }

  #count(routeId: string, delta: number): void {
    const next = Math.max(0, (this.#tunnels.get(routeId) ?? 0) + delta);
    if (next === 0) this.#tunnels.delete(routeId);
    else this.#tunnels.set(routeId, next);
  }
}
