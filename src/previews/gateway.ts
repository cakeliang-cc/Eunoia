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
 * cookies are not sent to the main application. A `/__preview/<route>/` fallback
 * exists for clients that cannot resolve the wildcard host; it strips cookies
 * and authorization and is not the recommended origin.
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
  readonly viaHost: boolean;
}

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
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    const withoutPort = hostHeader.replace(/:\d+$/, '');
    let routeId: string | null = null;
    let path = req.url ?? '/';
    let viaHost = false;
    const suffix = `.${this.#baseDomain}`;
    if (withoutPort.endsWith(suffix)) {
      routeId = withoutPort.slice(0, -suffix.length).split('.')[0] ?? null;
      viaHost = true;
    }
    const headerRoute = req.headers['x-eunoia-preview-route'];
    if (!routeId && typeof headerRoute === 'string' && /^[a-f0-9]{16,64}$/i.test(headerRoute)) {
      routeId = headerRoute.toLowerCase();
      viaHost = false;
    }
    if (!routeId) {
      const match = /^\/__preview\/([a-zA-Z0-9_-]{8,80})(\/.*)?$/.exec(path);
      if (match) {
        routeId = match[1] ?? null;
        path = match[2] ?? '/';
        viaHost = false;
      }
    }
    if (!routeId) {
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
    return { ok: true, found: { route, path, viaHost } };
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
    const { route, path, viaHost } = resolved.found;
    const port = route.lease.containerPort;
    if ((this.#tunnels.get(route.lease.routeId) ?? 0) >= MAX_TUNNELS_PER_ROUTE) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many concurrent preview connections\n');
      return;
    }
    const headers = this.#forwardHeaders(req, port, viaHost);
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
        const responseHeaders = { ...proxyRes.headers } as Record<string, string | string[]>;
        delete responseHeaders['connection'];
        delete responseHeaders['keep-alive'];
        delete responseHeaders['transfer-encoding'];
        responseHeaders['x-eunoia-preview'] = route.lease.routeId;
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
      const { route, path, viaHost } = resolved.found;
      const origin = this.#upgradeOriginAllowed(req, route, viaHost);
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
      const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let index = 0; index + 1 < raw.length; index += 2) {
        const name = raw[index] as string;
        const value = raw[index + 1] as string;
        if (name.toLowerCase() === 'host') {
          lines.push(`Host: 127.0.0.1:${route.lease.containerPort}`);
          continue;
        }
        lines.push(`${name}: ${value}`);
      }
      tunnel.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) tunnel.write(head);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    })();
  }

  #upgradeOriginAllowed(
    req: IncomingMessage,
    route: PreviewRoute,
    viaHost: boolean,
  ): { ok: true } | { ok: false; reason: string } {
    if (!viaHost) return { ok: true };
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return { ok: true };
    try {
      const host = new URL(origin).host.toLowerCase().replace(/:\d+$/, '');
      const expected = `${route.lease.routeId}.${this.#baseDomain}`;
      if (host === expected) return { ok: true };
      return { ok: false, reason: 'websocket origin is not this preview origin' };
    } catch {
      return { ok: false, reason: 'websocket origin is not a valid URL' };
    }
  }

  #forwardHeaders(
    req: IncomingMessage,
    port: number,
    viaHost: boolean,
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'accept-encoding') continue;
      // A path-route shares the main application origin; forwarding its cookies
      // would let the preview read the main session. The host route already has
      // its own origin, so its own cookies are safe to pass through.
      if (!viaHost && (lower === 'cookie' || lower === 'authorization')) continue;
      headers[lower] = value;
    }
    headers['host'] = `127.0.0.1:${port}`;
    headers['x-forwarded-host'] = String(req.headers.host ?? '');
    return headers;
  }

  #count(routeId: string, delta: number): void {
    const next = Math.max(0, (this.#tunnels.get(routeId) ?? 0) + delta);
    if (next === 0) this.#tunnels.delete(routeId);
    else this.#tunnels.set(routeId, next);
  }
}
