/**
 * HTTP transport.
 *
 * Built on `node:http` rather than a framework: the surface is a dozen routes
 * and none of them need routing, middleware, or content negotiation. Spec §0
 * warns against pulling in a framework that is not needed, and nothing here has
 * reached the point where one would earn its weight.
 *
 * Every route below is a thin adapter. Chat goes through `runTurn`, which is the
 * same entry point the evaluation runner uses — so what is measured and what is
 * shipped cannot diverge.
 *
 * Read `identity.ts` before deploying this anywhere. The identity here is a
 * handle, not authentication.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installProvider } from '../agent/model-client.ts';
import { PROMPT_VERSION } from '../agent/instructions.ts';
import { log } from '../observability/logging.ts';
import { installTracing } from '../observability/tracing.ts';
import { WorkingMemory } from '../memory/working-memory.ts';
import type { Store } from '../memory/store.ts';
import type { MemoryStatus } from '../memory/types.ts';
import { MEMORY_STATUSES } from '../memory/types.ts';
import { runTurn, type TurnRunner } from '../service/chat.ts';
import { selectStore } from '../db/pool.ts';
import { clearIdentity, readIdentity, resolveIdentity, singleUserId } from './identity.ts';
import { pipeEventsAsSse } from './sse.ts';

/** Reject absurd bodies rather than buffering them. */
const MAX_BODY_BYTES = 32 * 1024;

/** Reject absurd messages. A companion turn is not a document. */
const MAX_MESSAGE_CHARS = 8_000;

/** Preference key that lets the person switch retrieval off entirely. */
export const MEMORY_ENABLED_KEY = 'memory.enabled';

/**
 * The statuses the memory panel shows.
 *
 * A soft-deleted memory is still a row — `memory_events` and `superseded_by`
 * both point at it, and removing it would strand them — so "deleted" has to be
 * filtered on read rather than prevented on write. Both stores return every
 * status when asked for nothing in particular, which is the right default for a
 * data layer and the wrong one for a screen: without this, deleting a memory
 * would leave it sitting in the panel the person deleted it from.
 */
const VISIBLE_MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'unconfirmed'];

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function asObject(raw: unknown): Json | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Json) : null;
}

export interface ChatPayload {
  readonly message: string;
  readonly conversationId: string | null;
}

export function parseChatRequest(raw: unknown): ChatPayload | string {
  const body = asObject(raw);
  if (!body) return 'body must be a JSON object';

  const message = body.message;
  if (typeof message !== 'string') return 'field "message" must be a string';
  const trimmed = message.trim();
  if (trimmed.length === 0) return 'field "message" must not be empty';
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return `field "message" exceeds ${MAX_MESSAGE_CHARS} characters`;
  }

  const conversationId = body.conversationId;
  if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') {
    return 'field "conversationId" must be a string or null';
  }

  return { message: trimmed, conversationId: (conversationId as string | null) ?? null };
}

export interface AppDependencies {
  readonly store: Store;
  readonly working?: WorkingMemory;
  /**
   * Which store the process actually selected.
   *
   * Reported by `/health` because the in-memory fallback is silent on the page
   * and looks exactly like "my history disappeared": the server keeps working,
   * but every restart starts from nothing. Tests inject a store directly and
   * leave this unset, which reports as `unknown` rather than claiming
   * persistence the test never asked for.
   */
  readonly storeKind?: 'postgres' | 'memory';
  /**
   * Injected so the routes can be tested over real HTTP without a model call.
   * Production leaves it unset and `runTurn` uses the real runner.
   */
  readonly runner?: TurnRunner;
}

export function createApp(deps: AppDependencies) {
  const working = deps.working ?? new WorkingMemory();
  const store = deps.store;

  /**
   * Resolve the caller, and make sure their row exists.
   *
   * Every per-user table has a foreign key to `users`, and the in-memory store
   * enforces none of them — so a route that wrote before the user row existed
   * worked perfectly in every test and failed in the only environment that
   * mattered. `/api/chat` created a conversation before its user, and
   * `/api/preferences` inserted a preference before its user; both were a 500
   * against Postgres, both passed offline.
   *
   * Doing it here rather than in each route means no route has to remember, and
   * a new route is safe by default instead of safe by review.
   */
  async function identify(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const { userId } = resolveIdentity(req, res);
    await store.ensureUser(userId);
    return userId;
  }

  /** Retrieval can be switched off by the person; it is their history. */
  async function retrievalEnabled(userId: string): Promise<boolean> {
    const value = await store.getPreference(userId, MEMORY_ENABLED_KEY).catch(() => null);
    return value !== false;
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
      return;
    }

    const parsed = parseChatRequest(raw);
    if (typeof parsed === 'string') {
      sendJson(res, 400, { error: parsed });
      return;
    }

    const userId = await identify(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    log.info('chat.request', {
      message_fingerprint: `len=${parsed.message.length}`,
      conversation_id: parsed.conversationId,
    });

    const retrieve = await retrievalEnabled(userId);

    await pipeEventsAsSse(
      runTurn(
        { store, working, runner: deps.runner },
        {
          userId,
          conversationId: parsed.conversationId,
          message: parsed.message,
          signal: controller.signal,
          // Retrieval happens inside `runTurn`; turning it off here means the
          // promise is not made rather than made and ignored.
          ...(retrieve ? {} : { retrieve: false }),
        },
      ),
      res,
      { onClose: () => controller.abort() },
    );
  }

  async function handleRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      const ok = await store.ping();
      sendJson(res, ok ? 200 : 503, {
        status: ok ? 'ok' : 'degraded',
        prompt_version: PROMPT_VERSION,
        store: deps.storeKind ?? 'unknown',
        persistent: deps.storeKind === 'postgres',
        single_user: singleUserId() !== null,
      });
      return true;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveIndex(res);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      await handleChat(req, res);
      return true;
    }

    // ------------------------------------------------------------- me -----

    if (req.method === 'DELETE' && pathname === '/api/me') {
      // Deliberately not `identify`: that mints an identity when it finds none,
      // and creating a person in order to delete them would also hand back a
      // cookie for a row that no longer exists.
      const userId = readIdentity(req);
      const deleted = userId === null ? false : await store.deleteUser(userId);
      clearIdentity(res);
      // `deleted: false` is a 200, not a 404. The caller asked for a state, and
      // somebody with no row here is already in it — the only interesting
      // outcome is the one where a cookie was pointing at real data.
      sendJson(res, 200, { deleted });
      return true;
    }

    // ---------------------------------------------------------- history -----

    if (req.method === 'GET' && pathname === '/api/conversations') {
      const userId = await identify(req, res);
      const conversations = await store.listConversations(userId);
      sendJson(res, 200, { conversations });
      return true;
    }

    const messagesMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/messages$/.exec(pathname);
    if (req.method === 'GET' && messagesMatch) {
      const userId = await identify(req, res);
      const messages = await store.listMessages(userId, messagesMatch[1] as string);
      sendJson(res, 200, { messages });
      return true;
    }

    // ----------------------------------------------------------- memory -----

    if (req.method === 'GET' && pathname === '/api/memory') {
      const userId = await identify(req, res);
      const memories = await store.listMemories(userId, {
        limit: 200,
        statuses: [...VISIBLE_MEMORY_STATUSES],
      });
      const enabled = await retrievalEnabled(userId);
      sendJson(res, 200, { memories, enabled });
      return true;
    }

    const memoryMatch = /^\/api\/memory\/([0-9a-f-]{36})$/.exec(pathname);

    if (req.method === 'PATCH' && memoryMatch) {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req)) ?? {};

      const status = body.status;
      if (status !== undefined && !MEMORY_STATUSES.includes(status as MemoryStatus)) {
        sendJson(res, 400, { error: `status must be one of ${MEMORY_STATUSES.join(', ')}` });
        return true;
      }

      const updated = await store.updateMemory(userId, memoryMatch[1] as string, {
        content: typeof body.content === 'string' ? body.content : undefined,
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        status: status as MemoryStatus | undefined,
      });

      if (!updated) {
        sendJson(res, 404, { error: 'memory not found' });
        return true;
      }

      // Recorded as an actor of `user`, not `agent`: the distinction is the
      // whole reason the column exists, and a person correcting a memory is
      // exactly the event it needs to capture.
      await store.logMemoryEvent({
        memoryId: updated.id,
        userId,
        action: 'updated',
        actor: 'user',
        detail: { fields: Object.keys(body) },
      });

      sendJson(res, 200, { memory: updated });
      return true;
    }

    if (req.method === 'DELETE' && memoryMatch) {
      const userId = await identify(req, res);
      const id = memoryMatch[1] as string;
      const deleted = await store.deleteMemory(userId, id);
      if (!deleted) {
        sendJson(res, 404, { error: 'memory not found' });
        return true;
      }
      await store.logMemoryEvent({ memoryId: id, userId, action: 'deleted', actor: 'user' });
      sendJson(res, 200, { deleted: id });
      return true;
    }

    // ------------------------------------------------------- preferences -----

    if (req.method === 'GET' && pathname === '/api/preferences') {
      const userId = await identify(req, res);
      const preferences = await store.listPreferences(userId);
      sendJson(res, 200, { preferences, memoryEnabled: preferences[MEMORY_ENABLED_KEY] !== false });
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/preferences') {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req));
      if (!body) {
        sendJson(res, 400, { error: 'body must be a JSON object' });
        return true;
      }
      for (const [key, value] of Object.entries(body)) {
        await store.setPreference(userId, key, value);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---------------------------------------------------------- feedback -----

    if (req.method === 'POST' && pathname === '/api/feedback') {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req)) ?? {};

      const messageId = body.messageId;
      const rating = body.rating;
      if (typeof messageId !== 'string' || (rating !== 'good' && rating !== 'bad')) {
        sendJson(res, 400, { error: 'messageId (string) and rating ("good"|"bad") are required' });
        return true;
      }

      await store.saveFeedback({
        messageId,
        userId,
        rating,
        note: typeof body.note === 'string' ? body.note : null,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/feedback') {
      const userId = await identify(req, res);
      sendJson(res, 200, { feedback: await store.listFeedback(userId) });
      return true;
    }

    return false;
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    void (async () => {
      try {
        if (await handleRoutes(req, res, url)) return;
        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        log.error('http.unhandled', {
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      }
    })();
  });
}

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  } catch {
    sendJson(res, 404, { error: 'web client not found' });
  }
}

/** Start the server. Exported so tests can bind an ephemeral port. */
export async function startServer(port = Number(process.env.PORT ?? 8787)) {
  installTracing();

  // Validate before the process starts listening: a typo in SINGLE_USER_ID
  // should refuse to boot, not hand every request a new identity later.
  const single = singleUserId();
  if (single) log.info('server.single_user', { userId: single });

  installProvider();

  const { store, kind, detail } = await selectStore();
  log.info('server.store', { kind, detail });

  const working = new WorkingMemory();
  const server = createApp({ store, working, storeKind: kind });

  // Without this the process grows by one conversation's working set per
  // conversation, forever.
  const sweep = setInterval(() => working.sweep(), 10 * 60 * 1000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    void store.close();
  });

  const host = bindHost();
  if (!isLoopback(host)) {
    log.warn('server.public_bind', {
      host,
      note: 'no authentication is enabled; anyone who can reach this port is the user',
    });
  }
  server.listen(port, host, () => log.info('server.listening', { host, port }));
  return server;
}

/**
 * Where the HTTP server listens.
 *
 * Loopback by default. The previous version used the runtime's default, which
 * is every interface — the page looked local at `127.0.0.1:8787`, but the
 * socket was reachable from the LAN. With no login, that is the whole account.
 * Remote access has to be an explicit decision (`HOST=0.0.0.0`) and still needs
 * a real auth layer before it is safe.
 */
export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.HOST?.trim();
  return value && value.length > 0 ? value : '127.0.0.1';
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// Run directly: `node src/api/server.ts`
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  startServer().catch((error: unknown) => {
    log.error('server.start_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
