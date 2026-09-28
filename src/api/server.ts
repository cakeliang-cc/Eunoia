/**
 * HTTP transport.
 *
 * Built on `node:http` rather than a framework: the surface is three routes, and
 * spec §0 warns against pulling in a framework that is not needed.
 *
 * Phase 1 is deliberately single-turn. Conversation history belongs with the
 * `conversations` / `messages` tables in Phase 2 — building it here would mean
 * building it twice. See docs/implementation-plan.md.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCompanionAgent, streamReply } from '../agent/infp-agent.ts';
import { installProvider } from '../agent/model-client.ts';
import { log } from '../observability/logging.ts';
import { installTracing } from '../observability/tracing.ts';
import { pipeEventsAsSse } from './sse.ts';

/** Reject absurd bodies rather than buffering them. */
const MAX_BODY_BYTES = 32 * 1024;

/** Reject absurd messages. A companion turn is not a document. */
const MAX_MESSAGE_CHARS = 8_000;

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');

interface ChatRequest {
  message: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read and parse a JSON body, enforcing the size cap. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new Error('empty request body');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Validate the chat payload, returning a reason when it is unusable. */
function parseChatRequest(raw: unknown): ChatRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const message = (raw as { message?: unknown }).message;
  if (typeof message !== 'string') return 'field "message" must be a string';
  const trimmed = message.trim();
  if (trimmed.length === 0) return 'field "message" must not be empty';
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return `field "message" exceeds ${MAX_MESSAGE_CHARS} characters`;
  }
  return { message: trimmed };
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

  // Constructed per request: the SDK's Agent is cheap, and a fresh instance per
  // turn keeps Phase 1 free of shared mutable state. Phase 2 revisits this once
  // sessions exist.
  const agent = createCompanionAgent();

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  log.info('chat.request', { message_fingerprint: `len=${parsed.message.length}` });

  await pipeEventsAsSse(
    streamReply(agent, parsed.message, { signal: controller.signal }),
    res,
    { onClose: () => controller.abort() },
  );
}

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  } catch {
    sendJson(res, 404, { error: 'web client not found' });
  }
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          await handleChat(req, res);
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          await serveIndex(res);
          return;
        }
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

/** Start the server. Exported so tests can bind an ephemeral port. */
export function startServer(port = Number(process.env.PORT ?? 8787)) {
  installTracing();
  installProvider();
  const server = createApp();
  server.listen(port, () => {
    log.info('server.listening', { port });
  });
  return server;
}

// Run directly: `node src/api/server.ts`
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  startServer();
}
