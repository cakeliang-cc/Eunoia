/**
 * HTTP adapter for the workbench.
 *
 * These routes are not part of the agent's tool surface. They exist so a person
 * looking at the page can see the directory the agent is working in, inspect a
 * file, ask git what changed, and run a command themselves. The agent still
 * reaches the filesystem only through its tools.
 *
 * Two guards matter beyond ordinary validation:
 *
 *   - a same-origin check, because a page on another site must not be able to
 *     read a local directory through the user's browser;
 *   - an explicit `X-Workspace-UI: 1` header on mutations and the terminal, so a
 *     plain HTML form (which cannot set a custom header) is not enough.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { contentFingerprint, log } from '../observability/logging.ts';
import { WorkspaceUiError } from './types.ts';
import type { WorkspaceUiService } from './service.ts';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 8_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceUiError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('workspace_ui.request_failed', { error: message });
  sendJson(res, 500, { error: 'the workspace request failed' });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new WorkspaceUiError('unavailable', 'request body is too large', 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkspaceUiError('unavailable', 'request body must be an object', 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkspaceUiError) throw error;
    throw new WorkspaceUiError('unavailable', 'request body is not valid JSON', 400);
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

function hasUiHeader(req: IncomingMessage): boolean {
  return req.headers['x-workspace-ui'] === '1';
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Handle one `/api/workspace` request.
 *
 * Returns true when the path belongs to this adapter, so the server's route
 * chain can keep its "first match wins" shape.
 */
export async function handleWorkspaceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: WorkspaceUiService,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/workspace')) return false;

  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin workspace requests are refused', code: 'forbidden' });
    return true;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/workspace') {
      sendJson(res, 200, service.state());
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/workspace') {
      if (!hasUiHeader(req)) {
        sendJson(res, 403, { error: 'missing workspace UI header', code: 'forbidden' });
        return true;
      }
      const body = await readJson(req);
      const path = stringField(body, 'path');
      if (!path) throw new WorkspaceUiError('invalid-path', 'path is required', 400);
      sendJson(res, 200, await service.setRoot(path));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/browse') {
      sendJson(res, 200, await service.browse(url.searchParams.get('path') ?? undefined));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/files') {
      sendJson(res, 200, await service.list(url.searchParams.get('path') ?? '.'));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/file') {
      const path = url.searchParams.get('path');
      if (!path) throw new WorkspaceUiError('invalid-path', 'path is required', 400);
      const start = numberParam(url, 'start', 1);
      const end = numberParam(url, 'end', 0);
      sendJson(res, 200, await service.read(path, start, end));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/git/status') {
      sendJson(res, 200, await service.gitStatus());
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/git/diff') {
      const path = url.searchParams.get('path');
      if (!path) throw new WorkspaceUiError('invalid-path', 'path is required', 400);
      sendJson(res, 200, await service.diff(path));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/workspace/terminal') {
      await handleTerminal(req, res, service);
      return true;
    }

    sendJson(res, 404, { error: 'unknown workspace route', code: 'not-found' });
    return true;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}

// --------------------------------------------------------------- terminal ---

async function handleTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkspaceUiService,
): Promise<void> {
  if (!service.state().terminal) {
    throw new WorkspaceUiError(
      'terminal-disabled',
      'the workspace terminal is disabled; set WORKSPACE_TERMINAL=1 to enable it',
      403,
    );
  }
  if (!hasUiHeader(req)) {
    throw new WorkspaceUiError('terminal-disabled', 'missing workspace UI header', 403);
  }

  const body = await readJson(req);
  const command = stringField(body, 'command')?.trim() ?? '';
  if (command.length === 0) throw new WorkspaceUiError('invalid-path', 'command is required', 400);
  if (command.length > MAX_COMMAND_CHARS) {
    throw new WorkspaceUiError('invalid-path', `command is longer than ${MAX_COMMAND_CHARS} characters`, 413);
  }
  const cwd = await service.terminalCwd(stringField(body, 'cwd') ?? '.');

  log.info('workspace_ui.terminal', {
    cwd,
    command_fingerprint: contentFingerprint(command),
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const startedAt = Date.now();
  const limits = service.terminalLimits;
  const maxOutput = limits.maxOutputBytes;
  let outputBytes = 0;
  let closed = false;
  let timedOut = false;

  const send = (event: Record<string, unknown>): void => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const shell = process.env.SHELL?.trim() || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
  const args =
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-Command', command]
      : ['-c', command];

  let child: ChildProcess;
  try {
    child = spawn(shell, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    send({
      type: 'terminal_error',
      message: error instanceof Error ? error.message : String(error),
    });
    res.end();
    return;
  }

  const stop = (): void => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, limits.timeoutMs);
  timer.unref();

  const onClose = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    stop();
    if (!res.writableEnded) res.end();
  };
  res.on('close', onClose);

  const onData = (kind: 'stdout' | 'stderr', chunk: string): void => {
    if (closed) return;
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (outputBytes + bytes > maxOutput) {
      const remaining = Math.max(0, maxOutput - outputBytes);
      if (remaining > 0) {
        const slice = Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
        send({ type: `terminal_${kind}`, text: slice });
      }
      outputBytes = maxOutput;
      send({ type: 'terminal_truncated', message: 'output limit reached; the command was stopped' });
      stop();
      return;
    }
    outputBytes += bytes;
    send({ type: `terminal_${kind}`, text: chunk });
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => onData('stdout', chunk));
  child.stderr?.on('data', (chunk: string) => onData('stderr', chunk));

  child.on('error', (error: Error) => {
    if (closed) return;
    send({ type: 'terminal_error', message: error.message });
    clearTimeout(timer);
    closed = true;
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  });

  child.on('close', (code, signal) => {
    if (closed) return;
    clearTimeout(timer);
    res.off('close', onClose);
    send({
      type: 'terminal_exit',
      code: code ?? null,
      signal: signal ?? null,
      timedOut,
      durationMs: Date.now() - startedAt,
      truncated: outputBytes >= maxOutput,
    });
    closed = true;
    if (!res.writableEnded) res.end();
  });
}
