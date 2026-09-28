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
import { resolveIdentity } from './identity.ts';
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
   * Injected so the routes can be tested over real HTTP without a model call.
   * Production leaves it unset and `runTurn` uses the real runner.
   */
  readonly runner?: TurnRunner;
}

export function createApp(deps: AppDependencies) {
  const working = deps.working ?? new WorkingMemory();
  const store = deps.store;

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

    const identity = resolveIdentity(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    log.info('chat.request', {
      message_fingerprint: `len=${parsed.message.length}`,
      conversation_id: parsed.conversationId,
    });

    const retrieve = await retrievalEnabled(identity.userId);

    await pipeEventsAsSse(
      runTurn(
        { store, working, runner: deps.runner },
        {
          userId: identity.userId,
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

    // ---------------------------------------------------------- history -----

    if (req.method === 'GET' && pathname === '/api/conversations') {
      const { userId } = resolveIdentity(req, res);
      const conversations = await store.listConversations(userId);
      sendJson(res, 200, { conversations });
      return true;
    }

    const messagesMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/messages$/.exec(pathname);
    if (req.method === 'GET' && messagesMatch) {
      const { userId } = resolveIdentity(req, res);
      const messages = await store.listMessages(userId, messagesMatch[1] as string);
      sendJson(res, 200, { messages });
      return true;
    }

    // ----------------------------------------------------------- memory -----

    if (req.method === 'GET' && pathname === '/api/memory') {
      const { userId } = resolveIdentity(req, res);
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
      const { userId } = resolveIdentity(req, res);
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
      const { userId } = resolveIdentity(req, res);
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
      const { userId } = resolveIdentity(req, res);
      const preferences = await store.listPreferences(userId);
      sendJson(res, 200, { preferences, memoryEnabled: preferences[MEMORY_ENABLED_KEY] !== false });
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/preferences') {
      const { userId } = resolveIdentity(req, res);
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
      const { userId } = resolveIdentity(req, res);
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
      const { userId } = resolveIdentity(req, res);
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
  installProvider();

  const { store, kind, detail } = await selectStore();
  log.info('server.store', { kind, detail });

  const working = new WorkingMemory();
  const server = createApp({ store, working });

  // Without this the process grows by one conversation's working set per
  // conversation, forever.
  const sweep = setInterval(() => working.sweep(), 10 * 60 * 1000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    void store.close();
  });

  server.listen(port, () => log.info('server.listening', { port }));
  return server;
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
