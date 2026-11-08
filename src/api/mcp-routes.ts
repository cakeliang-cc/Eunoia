/**
 * The MCP management API.
 *
 * A separate module from `server.ts` because these routes are a product surface
 * of their own, and because the file that owns chat streaming should not also
 * own credential lifecycle. The patterns are the same as the rest of the API:
 * loopback + origin + local token for writes, owner-scoped reads, typed errors.
 *
 * Nothing here accepts an arbitrary URL to fetch or a host command to run. A
 * server's endpoint is part of its validated configuration; the routes only
 * operate on servers the caller already owns.
 *
 * See docs/adr/033-mcp-host.md §14.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpService } from '../mcp/service.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { isMcpError } from '../mcp/types.ts';
import type { ServerInput } from '../mcp/config.ts';
import { SSE_HEADERS } from './sse.ts';

type Json = Record<string, unknown>;

export interface McpRouteDeps {
  readonly mcp: McpService;
  readonly runtime: McpRuntime | null;
  identify(req: IncomingMessage, res: ServerResponse): Promise<string>;
  guardRead(req: IncomingMessage, res: ServerResponse): boolean;
  guardWrite(req: IncomingMessage, res: ServerResponse): boolean;
  readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }>;
  hasConversation(userId: string, conversationId: string): Promise<boolean>;
  isUuid(value: string): boolean;
  localToken: string;
}

const SERVER_ID = '([0-9a-fA-F-]{36})';

export async function handleMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: McpRouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/mcp')) return false;

  // The OAuth callback arrives as a top-level browser navigation and cannot send
  // the local token header. It is guarded by the one-shot state instead.
  if (req.method === 'GET' && pathname === '/api/mcp/oauth/callback') {
    await oauthCallback(req, res, url, deps);
    return true;
  }

  try {
    if (!(await dispatch(req, res, url, deps))) return false;
    return true;
  } catch (error) {
    sendMcpError(res, error);
    return true;
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: McpRouteDeps,
): Promise<boolean> {
  const { pathname } = url;

  // ---------------------------------------------------------------- servers ---
  if (pathname === '/api/mcp/servers') {
    if (req.method === 'GET') {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      sendJson(res, 200, { servers: await deps.mcp.listServers(userId) });
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.guardWrite(req, res)) return true;
      const body = await deps.readJson(req, res);
      if (!body.ok) return true;
      const userId = await deps.identify(req, res);
      const view = await deps.mcp.createServer(userId, asServerInput(body.value));
      sendJson(res, 201, { server: view });
      return true;
    }
  }

  if (pathname === '/api/mcp/servers/import/preview' && req.method === 'POST') {
    if (!deps.guardWrite(req, res)) return true;
    const body = await deps.readJson(req, res);
    if (!body.ok) return true;
    const userId = await deps.identify(req, res);
    sendJson(res, 200, await deps.mcp.previewImport(userId, body.value));
    return true;
  }

  const serverMatch = new RegExp(`^/api/mcp/servers/${SERVER_ID}$`).exec(pathname);
  if (serverMatch) {
    const serverId = serverMatch[1] as string;
    if (!deps.isUuid(serverId)) {
      sendJson(res, 400, { error: 'server id must be a uuid' });
      return true;
    }
    if (req.method === 'GET') {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      sendJson(res, 200, { server: await deps.mcp.getServer(userId, serverId) });
      return true;
    }
    if (req.method === 'PUT') {
      if (!deps.guardWrite(req, res)) return true;
      const body = await deps.readJson(req, res);
      if (!body.ok) return true;
      const userId = await deps.identify(req, res);
      const view = await deps.mcp.updateServer(userId, serverId, asServerInput(body.value));
      sendJson(res, 200, { server: view });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.guardWrite(req, res)) return true;
      const userId = await deps.identify(req, res);
      await deps.mcp.deleteServer(userId, serverId);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const actionMatch = new RegExp(
    `^/api/mcp/servers/${SERVER_ID}/(connect|disconnect|refresh|tools|auth/logout|auth/start)$`,
  ).exec(pathname);
  if (actionMatch) {
    const serverId = actionMatch[1] as string;
    const action = actionMatch[2] as string;
    if (action === 'tools' && req.method === 'GET') {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      sendJson(res, 200, { tools: await deps.mcp.tools(userId, serverId) });
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!deps.guardWrite(req, res)) return true;
    const userId = await deps.identify(req, res);
    if (action === 'connect') {
      sendJson(res, 200, { status: await deps.mcp.connect(userId, serverId) });
      return true;
    }
    if (action === 'disconnect') {
      await deps.mcp.disconnect(userId, serverId);
      sendJson(res, 200, { status: await deps.mcp.status(userId, serverId) });
      return true;
    }
    if (action === 'refresh') {
      sendJson(res, 200, { status: await deps.mcp.refresh(userId, serverId) });
      return true;
    }
    if (action === 'auth/logout') {
      await deps.mcp.logout(userId, serverId);
      sendJson(res, 200, { status: await deps.mcp.status(userId, serverId) });
      return true;
    }
    if (action === 'auth/start') {
      const started = await deps.mcp.beginAuth(userId, serverId);
      sendJson(res, 200, { authorization_url: started.url });
      return true;
    }
  }

  // ------------------------------------------------------------- resources ---
  const resourceMatch = new RegExp(
    `^/api/mcp/servers/${SERVER_ID}/(resources|resources/read|resources/complete|prompts|prompts/get|prompts/complete)$`,
  ).exec(pathname);
  if (resourceMatch) {
    const serverId = resourceMatch[1] as string;
    const action = resourceMatch[2] as string;
    if (req.method === 'GET' && (action === 'resources' || action === 'prompts')) {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      const result =
        action === 'resources'
          ? await deps.mcp.listResources(userId, serverId)
          : await deps.mcp.listPrompts(userId, serverId);
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.guardWrite(req, res)) return true;
      const body = await deps.readJson(req, res);
      if (!body.ok) return true;
      const userId = await deps.identify(req, res);
      const record = asObject(body.value);
      const conversationId = typeof record.conversationId === 'string' ? record.conversationId : '';
      if (!deps.isUuid(conversationId) || !(await deps.hasConversation(userId, conversationId))) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      if (action === 'resources/read') {
        const uri = typeof record.uri === 'string' ? record.uri : '';
        if (uri.length === 0) {
          sendJson(res, 400, { error: 'field "uri" is required' });
          return true;
        }
        sendJson(
          res,
          200,
          await deps.mcp.readResource({
            userId,
            conversationId,
            serverId,
            uri,
            select: record.select === true,
          }),
        );
        return true;
      }
      if (action === 'resources/complete' || action === 'prompts/complete') {
        const name = typeof record.name === 'string' ? record.name : '';
        const argument = asObject(record.argument);
        const argumentName = typeof argument.name === 'string' ? argument.name : '';
        const value = typeof argument.value === 'string' ? argument.value : '';
        if (name.length === 0 || argumentName.length === 0) {
          sendJson(res, 400, { error: 'name and argument.name are required' });
          return true;
        }
        sendJson(
          res,
          200,
          await deps.mcp.complete(userId, serverId, {
            type: action === 'resources/complete' ? 'resource' : 'prompt',
            name,
            argument: { name: argumentName, value },
          }),
        );
        return true;
      }
      if (action === 'prompts/get') {
        const name = typeof record.name === 'string' ? record.name : '';
        if (name.length === 0) {
          sendJson(res, 400, { error: 'field "name" is required' });
          return true;
        }
        const args: Record<string, string> = {};
        for (const [key, value] of Object.entries(asObject(record.arguments))) {
          if (typeof value === 'string') args[key] = value;
        }
        sendJson(
          res,
          200,
          await deps.mcp.getPrompt({ userId, conversationId, serverId, name, arguments: args }),
        );
        return true;
      }
    }
  }

  // ---------------------------------------------------------- interactions ---
  if (pathname === '/api/mcp/interactions' && req.method === 'GET') {
    if (!deps.guardRead(req, res)) return true;
    const userId = await deps.identify(req, res);
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!deps.isUuid(conversationId)) {
      sendJson(res, 400, { error: 'conversationId must be a uuid' });
      return true;
    }
    sendJson(res, 200, { interactions: await deps.mcp.listInteractions(userId, conversationId) });
    return true;
  }

  const interactionMatch = new RegExp(
    `^/api/mcp/interactions/([0-9a-fA-F-]{36})/(accept|reject|cancel)$`,
  ).exec(pathname);
  if (interactionMatch && req.method === 'POST') {
    if (!deps.guardWrite(req, res)) return true;
    const userId = await deps.identify(req, res);
    const interactionId = interactionMatch[1] as string;
    const action = interactionMatch[2] as 'accept' | 'reject' | 'cancel';
    const body = await deps.readJson(req, res);
    if (!body.ok) return true;
    const record = await deps.mcp.resolveInteraction({
      userId,
      interactionId,
      action,
      ...(action === 'accept' ? { response: asObject(body.value).response } : {}),
    });
    sendJson(res, 200, { interaction: record });
    return true;
  }

  // --------------------------------------------------------------- actions ---
  const resumeMatch = new RegExp(`^/api/mcp/actions/([0-9a-fA-F-]{36})/resume$`).exec(pathname);
  if (resumeMatch && req.method === 'POST') {
    if (!deps.guardWrite(req, res)) return true;
    const userId = await deps.identify(req, res);
    const body = await deps.readJson(req, res);
    if (!body.ok) return true;
    const conversationId = String(asObject(body.value).conversationId ?? '');
    if (!deps.isUuid(conversationId) || !(await deps.hasConversation(userId, conversationId))) {
      sendJson(res, 404, { error: 'conversation not found' });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.mcp.resumeAction({
        userId,
        actionId: resumeMatch[1] as string,
        conversationId,
      }),
    );
    return true;
  }

  if (pathname === '/api/mcp/actions' && req.method === 'GET') {
    if (!deps.guardRead(req, res)) return true;
    const userId = await deps.identify(req, res);
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!deps.isUuid(conversationId)) {
      sendJson(res, 400, { error: 'conversationId must be a uuid' });
      return true;
    }
    sendJson(res, 200, { actions: await deps.mcp.listActions(userId, conversationId) });
    return true;
  }

  // ----------------------------------------------------------------- tasks ---
  if (pathname === '/api/mcp/tasks' && req.method === 'GET') {
    if (!deps.guardRead(req, res)) return true;
    const userId = await deps.identify(req, res);
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!deps.isUuid(conversationId)) {
      sendJson(res, 400, { error: 'conversationId must be a uuid' });
      return true;
    }
    sendJson(res, 200, { tasks: await deps.mcp.listTasks(userId, conversationId) });
    return true;
  }

  const taskMatch = new RegExp(`^/api/mcp/tasks/([0-9a-fA-F-]{36})(/cancel)?$`).exec(pathname);
  if (taskMatch) {
    if (req.method === 'GET' && !taskMatch[2]) {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      sendJson(res, 200, { task: await deps.mcp.getTask(userId, taskMatch[1] as string) });
      return true;
    }
    if (req.method === 'POST' && taskMatch[2]) {
      if (!deps.guardWrite(req, res)) return true;
      const userId = await deps.identify(req, res);
      sendJson(res, 200, { task: await deps.mcp.cancelTask(userId, taskMatch[1] as string) });
      return true;
    }
  }

  // -------------------------------------------------------------- bindings ---
  const bindingMatch = new RegExp(
    `^/api/mcp/conversations/([0-9a-fA-F-]{36})/servers$`,
  ).exec(pathname);
  if (bindingMatch) {
    const conversationId = bindingMatch[1] as string;
    if (req.method === 'GET') {
      if (!deps.guardRead(req, res)) return true;
      const userId = await deps.identify(req, res);
      if (!(await deps.hasConversation(userId, conversationId))) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      sendJson(res, 200, {
        serverIds: await deps.mcp.conversationServers(userId, conversationId),
      });
      return true;
    }
    if (req.method === 'PUT') {
      if (!deps.guardWrite(req, res)) return true;
      const body = await deps.readJson(req, res);
      if (!body.ok) return true;
      const userId = await deps.identify(req, res);
      if (!(await deps.hasConversation(userId, conversationId))) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      const raw = asObject(body.value).serverIds;
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
        sendJson(res, 400, { error: 'serverIds must be an array of ids' });
        return true;
      }
      sendJson(res, 200, {
        serverIds: await deps.mcp.setConversationServers(
          userId,
          conversationId,
          raw as string[],
        ),
      });
      return true;
    }
  }

  // ----------------------------------------------------------------- events ---
  if (pathname === '/api/mcp/events' && req.method === 'GET') {
    if (!deps.guardRead(req, res)) return true;
    const userId = await deps.identify(req, res);
    streamMcpEvents(req, res, deps, userId);
    return true;
  }

  return false;
}

/**
 * Server-sent status and interaction updates.
 *
 * The stream is a convenience, not the source of truth: a client that reconnects
 * re-reads the persisted status and pending interactions. Nothing here is only
 * in the stream.
 */
function streamMcpEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpRouteDeps,
  userId: string,
): void {
  res.writeHead(200, {
    ...SSE_HEADERS,
    'cache-control': 'no-store',
  });
  res.write(mcpFrame({ type: 'ready' }));

  const runtime = deps.runtime;
  if (!runtime) {
    res.write(mcpFrame({ type: 'unavailable' }));
    res.end();
    return;
  }
  const unsubscribeStatus = runtime.manager.onStatusChange((owner, serverId, status) => {
    if (owner !== userId) return;
    res.write(mcpFrame({ type: 'status', serverId, status }));
  });
  const unsubscribeInteraction = runtime.broker.onChange((record) => {
    if (record.userId !== userId) return;
    res.write(mcpFrame({ type: 'interaction', interaction: record }));
  });

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 20_000);
  keepAlive.unref();

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribeStatus();
    unsubscribeInteraction();
    res.end();
  });
}

async function oauthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: McpRouteDeps,
): Promise<void> {
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const serverId = url.searchParams.get('serverId') ?? '';
  if (code.length === 0 || state.length === 0 || !deps.isUuid(serverId)) {
    sendHtml(res, 400, '授权回调不完整', '缺少 code、state 或 serverId。');
    return;
  }
  try {
    const userId = await deps.identify(req, res);
    await deps.mcp.finishAuth({ userId, serverId, state, code });
    sendHtml(res, 200, '授权完成', '可以关闭这个页面，回到 Eunoia。');
  } catch (error) {
    const message = isMcpError(error) ? error.message : '授权失败';
    sendHtml(res, 400, '授权失败', message);
  }
}

// ------------------------------------------------------------------ helpers ---

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asServerInput(value: unknown): ServerInput {
  const record = asObject(value);
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.configRevision === 'number' ? { configRevision: record.configRevision } : {}),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
    ...(record.required !== undefined ? { required: record.required } : {}),
    ...(record.transport !== undefined ? { transport: record.transport } : {}),
    ...(record.http !== undefined ? { http: record.http } : {}),
    ...(record.stdio !== undefined ? { stdio: record.stdio } : {}),
    ...(record.timeouts !== undefined ? { timeouts: record.timeouts } : {}),
    ...(record.limits !== undefined ? { limits: record.limits } : {}),
    ...(record.toolPolicy !== undefined ? { toolPolicy: record.toolPolicy } : {}),
  };
}

function sendMcpError(res: ServerResponse, error: unknown): void {
  if (isMcpError(error)) {
    sendJson(res, error.status, {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.detail).length > 0 ? { details: error.detail } : {}),
    });
    return;
  }
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : 'internal error',
    code: 'MCP_INTERNAL',
  });
}

function mcpFrame(event: unknown): string {
  return `event: mcp\ndata: ${JSON.stringify(event)}\n\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, (char) =>
      char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;',
    );
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${escape(title)}</title>
<body style="font:16px/1.6 system-ui;max-width:36rem;margin:4rem auto;padding:0 1.5rem">
<h1 style="font-size:1.2rem">${escape(title)}</h1><p>${escape(detail)}</p>
<p><a href="/">返回 Eunoia</a></p></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(body);
}
