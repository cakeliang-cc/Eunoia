/**
 * R11 real-browser evidence: the developer panel, source cards and scoped undo.
 *
 * Playwright is not a dependency of this package (`@playwright/mcp` bundles a
 * copy, but importing a transitive package is not a contract), so this reuses
 * the proven CDP client style from `scripts/browser-check.ts`: Node's WebSocket
 * and a local Chrome install are the only requirements.
 *
 * The server is a local fixture, not the production app, because the point is
 * the client contract: which request a button sends, which response it renders,
 * and what it refuses to render (an "open" link to a failed preview). The
 * fixture records every request so the assertions can check method, URL, body
 * and the `x-eunoia-token` header. Screenshots and a JSON assertion log land in
 * `docs/features/evidence/integration-acceptance/r11/`.
 */

import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, extname } from 'node:path';
import type { AddressInfo } from 'node:net';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVIDENCE = 'docs/features/evidence/integration-acceptance/r11';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'fixture-local-token';
const CHANGESET_ID = 'wcs_11111111-1111-4111-8111-111111111111';

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
const captured: Captured[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name: string, condition: boolean, detail = ''): void {
  checks.push({ name, pass: condition, detail });
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------- fixture ---

interface JobFixture {
  id: string;
  userId: string;
  conversationId: string;
  turnId: string;
  memberId: string | null;
  taskId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  marker: string;
  pid: number;
  status: string;
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  stdinFifo: string | null;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

function job(id: string, command: string, status: string, memberId: string | null): JobFixture {
  return {
    id,
    userId: 'owner-user-123456',
    conversationId: CONVERSATION,
    turnId: 'turn-1',
    memberId,
    taskId: CONVERSATION,
    toolCallId: `call-${id}`,
    command,
    cwd: '.',
    marker: `marker-${id}`,
    pid: 41,
    status,
    exitCode: status === 'exited' ? 2 : null,
    stdoutPath: `/tmp/eunoia-jobs/${id}/out`,
    stderrPath: `/tmp/eunoia-jobs/${id}/err`,
    stdinFifo: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: status === 'exited' ? '2026-01-01T00:02:00.000Z' : null,
    expiresAt: null,
    error: null,
  };
}

function preview(id: string, status: string, userUrl: string, error: string | null) {
  return {
    id,
    routeId: `route-${id}`,
    jobId: `job_${id}`,
    userId: 'owner-user-123456',
    conversationId: CONVERSATION,
    memberId: null,
    runId: null,
    taskId: CONVERSATION,
    sandboxId: 'sandbox-1',
    workspaceId: 'workspace-1',
    containerPort: 3000,
    status,
    generation: 1,
    userUrl,
    browserUrl: `${userUrl}browser`,
    createdAt: '2026-01-01T00:00:00.000Z',
    readyAt: status === 'ready' ? '2026-01-01T00:00:03.000Z' : null,
    expiresAt: '2026-01-01T00:30:00.000Z',
    lastOpenedAt: null,
    error,
  };
}

const changesetSummary = {
  id: CHANGESET_ID,
  userId: 'owner-user-123456',
  conversationId: CONVERSATION,
  turnId: 'turn-fixture',
  workspaceId: 'workspace-1',
  checkpointId: null,
  beforeDigest: 'sha256:before',
  afterDigest: 'sha256:after',
  fileCount: 2,
  added: 1,
  modified: 1,
  deleted: 0,
  status: 'available',
  createdAt: '2026-01-01T00:01:00.000Z',
  undoneAt: null,
};

const changeset = {
  ...changesetSummary,
  files: [
    {
      path: 'src/a.ts',
      kind: 'modified',
      beforeSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      afterSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      beforeBytes: 7,
      afterBytes: 8,
      beforeContent: 'export const a = 1;\n',
      restoreSource: 'journal',
      restored: false,
    },
    {
      path: 'src/new.ts',
      kind: 'added',
      beforeSha: null,
      afterSha: 'cccccccccccccccccccccccccccccccc',
      beforeBytes: null,
      afterBytes: 9,
      beforeContent: null,
      restoreSource: 'none',
      restored: false,
    },
  ],
};

let jobs: JobFixture[] = [];
let previews: ReturnType<typeof preview>[] = [];
let undoRequests = 0;

function resetFixture(): void {
  jobs = [
    job('job_1', 'npm run dev', 'running', 'member-abc-9876'),
    job('job_2', 'npm test', 'exited', null),
  ];
  previews = [
    preview('pv_ready', 'ready', 'http://preview-ready.eunoia.test/', null),
    preview('pv_failed', 'failed', 'http://preview-failed.eunoia.test/', '端口没有响应'),
    preview('pv_expired', 'expired', 'http://preview-expired.eunoia.test/', null),
  ];
  undoRequests = 0;
  captured.length = 0;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function staticFile(res: ServerResponse, relative: string): Promise<boolean> {
  const path = join(process.cwd(), 'web', relative);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const pathless = url.pathname;
  const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
  if (method !== 'GET' || pathless.startsWith('/api/')) {
    captured.push({
      method,
      path: `${pathless}${url.search}`,
      body,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value ?? '')]),
      ),
    });
  }

  if (pathless === '/api/chat' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const frames = [
      {
        type: 'tool_call',
        callId: 'call-sources',
        name: 'web_search',
        displayable: true,
        summary: '2 个来源',
      },
      {
        type: 'tool_result',
        callId: 'call-sources',
        name: 'web_search',
        ok: true,
        durationMs: 12,
        summary: '2 个来源',
        sources: [
          {
            title: 'Node.js — Run JavaScript Everywhere',
            url: 'https://nodejs.org/en',
            snippet: 'Node.js is a free, open-source, cross-platform JavaScript runtime.',
            provider: 'tavily',
            query: 'node runtime',
          },
          {
            title: 'TypeScript: Documentation',
            url: 'https://www.typescriptlang.org/docs/',
            publishedAt: '2026-01-02',
          },
        ],
      },
      { type: 'text_delta', text: '看完了。' },
      {
        type: 'completed',
        text: '看完了。',
        conversationId: CONVERSATION,
        messageId: 'message-fixture',
        finishReason: 'completed',
      },
    ];
    for (const frame of frames) {
      res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    res.end();
    return;
  }

  if (pathless === '/__fixture/requests' && method === 'GET') {
    json(res, 200, { requests: captured, checks });
    return;
  }

  if (pathless === '/api/media/capabilities') {
    json(res, 200, {
      limits: { maxImagesPerMessage: 5, maxImageBytes: 10 * 1024 * 1024, maxDimension: 8192, maxPixels: 40_000_000 },
      models: [
        {
          id: 'deepseek-flash',
          displayName: 'DeepSeek Flash',
          available: true,
          input: { image: 'supported' },
        },
      ],
      defaultModelId: 'deepseek-flash',
    });
    return;
  }
  if (pathless === '/api/preferences') {
    json(res, 200, { memoryEnabled: true });
    return;
  }
  if (pathless === '/api/permissions') {
    json(res, 200, { enabled: false });
    return;
  }
  if (pathless === '/api/conversations' && method === 'GET') {
    json(res, 200, { conversations: [] });
    return;
  }
  if (/^\/api\/conversations\/[0-9a-f-]+\/messages$/.test(pathless)) {
    json(res, 200, { messages: [], modelId: 'deepseek-flash' });
    return;
  }
  if (pathless === '/api/workspace') {
    json(res, 200, {
      configured: false,
      root: null,
      name: null,
      source: null,
      agentRoot: null,
      terminal: false,
      git: false,
      maxFileBytes: 0,
      browseStart: '',
    });
    return;
  }

  if (pathless === '/api/processes' && method === 'GET') {
    json(res, 200, { jobs, available: true });
    return;
  }
  const logs = /^\/api\/processes\/([^/]+)\/logs$/.exec(pathless);
  if (logs && method === 'GET') {
    const id = decodeURIComponent(logs[1] as string);
    const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const text = cursor === 0 ? `fixture stdout line from ${id}\n` : '';
    const stderr = cursor === 0 ? `fixture stderr line from ${id}\n` : '';
    json(res, 200, {
      job: jobs.find((entry) => entry.id === id) ?? jobs[0],
      text,
      stderrText: stderr,
      nextCursor: cursor === 0 ? text.length + stderr.length : cursor,
      stdoutBytes: text.length,
      stderrBytes: stderr.length,
      gap: false,
    });
    return;
  }
  const stop = /^\/api\/processes\/([^/]+)\/stop$/.exec(pathless);
  if (stop && method === 'POST') {
    const id = decodeURIComponent(stop[1] as string);
    const target = jobs.find((entry) => entry.id === id);
    if (target) target.status = 'stopped';
    json(res, 200, { job: target ?? null });
    return;
  }

  if (pathless === '/api/previews' && method === 'GET') {
    json(res, 200, { previews, available: true });
    return;
  }
  if (pathless === '/api/previews' && method === 'POST') {
    const command = typeof body?.['command'] === 'string' ? body['command'] : '';
    if (command.includes('fail')) {
      const failed = preview('pv_started', 'failed', 'http://preview-started.eunoia.test/', '端口没有响应');
      previews = [...previews, failed];
      json(res, 409, {
        preview: failed,
        job: jobs[0],
        ready: false,
        detail: '容器里 3000 端口没有应答',
        internalUrl: 'http://127.0.0.1:3000/',
      });
      return;
    }
    const started = preview('pv_started', 'ready', 'http://preview-started.eunoia.test/', null);
    started.containerPort = Number(body?.['port'] ?? 3000);
    previews = [...previews, started];
    json(res, 201, {
      preview: started,
      job: jobs[0],
      ready: true,
      detail: 'HTTP 200',
      internalUrl: 'http://127.0.0.1:3000/',
    });
    return;
  }
  const previewStop = /^\/api\/previews\/([^/]+)\/stop$/.exec(pathless);
  if (previewStop && method === 'POST') {
    const id = decodeURIComponent(previewStop[1] as string);
    const target = previews.find((entry) => entry.id === id);
    if (target) target.status = 'stopped';
    json(res, 200, { preview: target ?? null });
    return;
  }

  if (pathless === `/api/conversations/${CONVERSATION}/changes` && method === 'GET') {
    json(res, 200, { changesets: [changesetSummary] });
    return;
  }
  if (pathless === `/api/conversations/${CONVERSATION}/changes/${CHANGESET_ID}` && method === 'GET') {
    json(res, 200, { changeset });
    return;
  }
  if (
    pathless === `/api/conversations/${CONVERSATION}/changes/${CHANGESET_ID}/undo/preflight` &&
    method === 'POST'
  ) {
    const paths = Array.isArray(body?.['paths']) ? (body['paths'] as string[]) : [];
    const blocked = paths.includes('src/a.ts')
      ? [{ path: 'src/a.ts', reason: '后续第 deadbeef 轮仍引用了这个文件' }]
      : [];
    json(res, 200, {
      changesetId: CHANGESET_ID,
      turnId: 'turn-fixture',
      files: changeset.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        currentSha: file.afterSha,
        afterSha: file.afterSha,
        matches: !blocked.some((entry) => entry.path === file.path),
        restorable: !blocked.some((entry) => entry.path === file.path),
        reason: blocked.find((entry) => entry.path === file.path)?.reason ?? null,
      })),
      blocked,
    });
    return;
  }
  if (
    pathless === `/api/conversations/${CONVERSATION}/changes/${CHANGESET_ID}/undo` &&
    method === 'POST'
  ) {
    undoRequests += 1;
    const paths = Array.isArray(body?.['paths']) ? (body['paths'] as string[]) : [];
    json(res, 200, {
      changesetId: CHANGESET_ID,
      turnId: 'turn-fixture',
      status: paths.length === changeset.files.length ? 'undone' : 'partial',
      restored: paths,
      deleted: [],
      conflicts: [],
      skipped: [],
      alreadyUndone: false,
    });
    return;
  }

  if (pathless === '/' || pathless === '/index.html') {
    let html = await readFile(join(process.cwd(), 'web', 'index.html'), 'utf8');
    html = html.replace(
      '</head>',
      `<meta name="eunoia-token" content="${TOKEN}">\n</head>`,
    );
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }
  if (await staticFile(res, pathless.replace(/^\//, ''))) return;
  json(res, 404, { error: `fixture has no route for ${pathless}` });
}

// --------------------------------------------------------------------- CDP ---

interface Cdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP socket timed out')), 10_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('CDP socket failed'));
      },
      { once: true },
    );
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? 'CDP error'));
    else entry.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function main(): Promise<void> {
  resetFixture();
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;
  await mkdir(EVIDENCE, { recursive: true });

  const profile = await mkdtemp(join(process.cwd(), '.dev-panel-check-'));
  const debugPort = 9334;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--hide-scrollbars',
      '--window-size=1280,900',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    if (/Failed to|FATAL|cannot/i.test(line)) process.stderr.write(`chrome: ${line}`);
  });
  const guard = setTimeout(() => {
    process.stderr.write('dev panel check: timed out\n');
    chrome.kill('SIGKILL');
    process.exit(3);
  }, 180_000);
  guard.unref();

  const writeLog = async (error?: string): Promise<void> => {
    await writeFile(
      `${EVIDENCE}/dev-panel-check.json`,
      `${JSON.stringify(
        {
          url,
          viewportChecks: checks,
          requests: captured,
          ...(error ? { error } : {}),
        },
        null,
        2,
      )}\n`,
    );
  };

  try {
    let wsUrl = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (response.ok) {
          wsUrl = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
          break;
        }
      } catch {
        // Chrome is still starting.
      }
      await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome did not expose a DevTools endpoint');

    const cdp = await connect(wsUrl);
    const target = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    const session = attached.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);

    const evaluate = async (expression: string): Promise<any> => {
      const result = (await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session,
      )) as { result: { value: unknown }; exceptionDetails?: { text: string } };
      if (result.exceptionDetails) {
        throw new Error(`page exception: ${result.exceptionDetails.text}`);
      }
      return result.result.value;
    };
    const until = async (expression: string, timeoutMs = 5_000): Promise<void> => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await sleep(60);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    };
    const shot = async (name: string): Promise<void> => {
      const image = (await cdp.send('Page.captureScreenshot', { format: 'png' }, session)) as {
        data: string;
      };
      await writeFile(`${EVIDENCE}/${name}`, Buffer.from(image.data, 'base64'));
    };
    const key = async (keyName: string, code: number, modifiers = 0): Promise<void> => {
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers },
        session,
      );
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers },
        session,
      );
    };
    const requests = (predicate: (entry: Captured) => boolean): Captured[] =>
      captured.filter(predicate);

    async function scenario(width: number, label: string): Promise<void> {
      resetFixture();
      await cdp.send('Page.navigate', { url }, session);
      await sleep(900);
      await evaluate(`localStorage.setItem('df_conversation', '${CONVERSATION}'); true`);

      await evaluate(`document.getElementById('dev-open').focus(); document.getElementById('dev-open').click(); true`);
      await until(`document.getElementById('dev-drawer').hidden === false`);
      check(`${label}: panel opens`, true);
      check(
        `${label}: panel role is dialog`,
        (await evaluate(`document.getElementById('dev-drawer').getAttribute('role')`)) === 'dialog',
      );
      await until(`document.querySelectorAll('#dev-jobs-list .dev-job').length === 2`);
      const jobsText = await evaluate(`document.getElementById('dev-jobs-list').textContent`);
      check(`${label}: jobs render owner/member/status/exit code`, jobsText.includes('归属：') && jobsText.includes('成员：') && jobsText.includes('运行中') && jobsText.includes('退出码：2'), String(jobsText));
      check(`${label}: jobs show a log cursor`, jobsText.includes('日志游标：0'));
      await shot(`${label}-jobs.png`);

      await evaluate(`document.querySelector('button[aria-label="读取作业 job_1 的日志"]').click(); true`);
      await until(`document.getElementById('dev-jobs-list').textContent.includes('fixture stdout line from job_1')`);
      check(
        `${label}: log text and advanced cursor render`,
        (await evaluate(`document.getElementById('dev-jobs-list').textContent`)).includes('日志游标：'),
      );
      const logsRequest = requests((entry) => entry.path.includes('/api/processes/job_1/logs'));
      check(
        `${label}: log read carries conversationId and cursor`,
        logsRequest.some((entry) => entry.path.includes(`conversationId=${CONVERSATION}`) && entry.path.includes('cursor=0')),
        JSON.stringify(logsRequest.map((entry) => entry.path)),
      );

      await evaluate(`document.querySelector('button[aria-label="停止作业 job_1"]').click(); true`);
      await until(`document.querySelector('.dev-job[data-job-id="job_1"]').dataset.status === 'stopped'`);
      const stopJob = requests(
        (entry) => entry.method === 'POST' && entry.path === '/api/processes/job_1/stop',
      );
      check(
        `${label}: stop job sends the token and conversation`,
        stopJob.length === 1 &&
          stopJob[0]?.body?.['conversationId'] === CONVERSATION &&
          stopJob[0]?.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(stopJob),
      );

      await evaluate(`document.getElementById('dev-tab-previews').click(); true`);
      await until(`document.querySelectorAll('#dev-previews-list .dev-preview').length === 3`);
      const beforeLinks = await evaluate(`document.querySelectorAll('#dev-previews-list a.dev-preview-open').length`);
      check(`${label}: only the ready preview has an open link`, beforeLinks === 1, String(beforeLinks));
      const deadLinks = await evaluate(`Array.from(document.querySelectorAll('#dev-previews-list .dev-preview'))
        .filter((row) => row.dataset.status !== 'ready')
        .map((row) => row.querySelectorAll('a').length)`);
      check(`${label}: failed/expired previews have no links`, Array.isArray(deadLinks) && deadLinks.every((count: number) => count === 0), JSON.stringify(deadLinks));
      await evaluate(`document.getElementById('dev-preview-command').value = 'npm run dev';
        document.getElementById('dev-preview-port').value = '3000';
        document.getElementById('dev-preview-cwd').value = 'apps/web';
        document.getElementById('dev-preview-timeout').value = '45000';
        document.getElementById('dev-preview-start').click(); true`);
      await until(`document.getElementById('dev-preview-result').textContent.includes('预览已就绪')`);
      const startPreview = requests(
        (entry) => entry.method === 'POST' && entry.path === '/api/previews',
      );
      check(
        `${label}: preview start sends exact JSON body`,
        startPreview.length === 1 &&
          startPreview[0]?.body?.['conversationId'] === CONVERSATION &&
          startPreview[0]?.body?.['command'] === 'npm run dev' &&
          startPreview[0]?.body?.['port'] === 3000 &&
          startPreview[0]?.body?.['cwd'] === 'apps/web' &&
          startPreview[0]?.body?.['ready_timeout_ms'] === 45000 &&
          startPreview[0]?.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(startPreview),
      );
      await until(`document.querySelectorAll('#dev-previews-list .dev-preview').length === 4`);
      check(
        `${label}: started ready preview has an open link`,
        (await evaluate(`document.querySelector('.dev-preview[data-preview-id="pv_started"] a.dev-preview-open')?.getAttribute('href')`)) ===
          'http://preview-started.eunoia.test/',
      );

      await evaluate(`document.querySelector('#dev-previews-list button[aria-label="读取预览 pv_ready 的启动日志"]').click(); true`);
      await until(`document.getElementById('dev-previews-list').textContent.includes('fixture stdout line')`);
      check(`${label}: preview logs render`, true);
      await evaluate(`document.querySelector('.dev-preview[data-status="failed"]').scrollIntoView({ block: 'center' }); true`);
      await sleep(120);
      await shot(`${label}-previews.png`);

      const stopInfo = await evaluate(`(() => {
        const button = document.querySelector('#dev-previews-list button[aria-label="停止预览 pv_ready"]');
        return button ? { disabled: button.disabled, status: button.closest('.dev-preview')?.dataset.status } : null;
      })()`);
      check(`${label}: preview stop button is enabled`, stopInfo !== null && stopInfo.disabled === false, JSON.stringify(stopInfo));
      await evaluate(`document.querySelector('#dev-previews-list button[aria-label="停止预览 pv_ready"]').click(); true`);
      await sleep(250);
      const stopPreview = requests(
        (entry) => entry.method === 'POST' && entry.path === '/api/previews/pv_ready/stop',
      );
      check(
        `${label}: stop preview sends conversationId`,
        stopPreview.length === 1 &&
          stopPreview[0]?.body?.['conversationId'] === CONVERSATION &&
          stopPreview[0]?.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(stopPreview),
      );

      // Source cards: close the panel, send a turn, check the real title/URL.
      await evaluate(`document.getElementById('dev-close').click(); true`);
      await until(`document.getElementById('dev-drawer').hidden === true`);
      check(
        `${label}: closed panel leaves the page (hidden is not overridden by display)`,
        (await evaluate(`getComputedStyle(document.getElementById('dev-drawer')).display`)) === 'none',
      );
      await evaluate(`(() => {
        const input = document.getElementById('input');
        input.value = '查一下 node';
        document.getElementById('composer').requestSubmit();
        return true;
      })()`);
      await until(`document.querySelectorAll('.source-card').length === 2`);
      const source = await evaluate(`(() => {
        const card = document.querySelector('.source-card');
        const link = card?.querySelector('a.source-title');
        return {
          title: link?.textContent ?? '',
          href: link?.getAttribute('href') ?? '',
          rel: link?.getAttribute('rel') ?? '',
          target: link?.getAttribute('target') ?? '',
          text: card?.textContent ?? '',
          allText: document.getElementById('transcript').textContent,
        };
      })()`);
      check(
        `${label}: source card has the real title and URL`,
        source.title === 'Node.js — Run JavaScript Everywhere' &&
          source.href === 'https://nodejs.org/en' &&
          source.rel === 'noopener noreferrer' &&
          source.target === '_blank',
        JSON.stringify(source),
      );
      check(
        `${label}: unknown cost is explicit and no date is invented`,
        source.text.includes('费用未知') && source.text.includes('日期未知'),
        source.text,
      );
      check(
        `${label}: published date is shown when the source has one`,
        source.allText.includes('日期 2026-01-02'),
      );
      await shot(`${label}-sources.png`);

      // Scoped undo: a blocked subset must render the reason and write nothing.
      await evaluate(`document.getElementById('dev-open').click(); true`);
      await evaluate(`document.getElementById('dev-tab-changes').click(); true`);
      await until(`document.querySelectorAll('#dev-changesets .dev-changeset').length === 1`);
      await evaluate(`document.querySelector('#dev-changesets .dev-changeset').click(); true`);
      await until(`document.querySelectorAll('#dev-changeset-detail .dev-change-file').length === 2`);
      const detailText = await evaluate(`document.getElementById('dev-changeset-detail').textContent`);
      check(
        `${label}: changeset shows modified/added and before/after`,
        detailText.includes('修改') && detailText.includes('新增') && detailText.includes('before 7 B') && detailText.includes('after 8 B'),
        detailText,
      );
      // Narrow to one file the later turn still references: this is the partial
      // scope the server must refuse, and the panel must not write anything.
      await evaluate(`(() => {
        const box = document.querySelector('.dev-change-file[data-path="src/new.ts"] input');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(150);
      await evaluate(`Array.from(document.querySelectorAll('#dev-changeset-detail .dev-button')).find((button) => button.textContent === '预检范围').click(); true`);
      await until(`document.getElementById('dev-changeset-detail').textContent.includes('被拒绝的部分撤销')`);
      check(
        `${label}: blocked partial undo shows the reason and the feasible range`,
        (await evaluate(`document.getElementById('dev-changeset-detail').textContent`)).includes('后续第 deadbeef 轮仍引用了这个文件') &&
          (await evaluate(`document.getElementById('dev-changeset-detail').textContent`)).includes('可行范围'),
      );
      const undosBefore = undoRequests;
      await evaluate(`Array.from(document.querySelectorAll('#dev-changeset-detail .dev-button')).find((button) => button.textContent === '撤销选中').click(); true`);
      await sleep(300);
      check(`${label}: refused partial undo wrote nothing`, undoRequests === undosBefore, String(undoRequests));
      await evaluate(`document.querySelector('.dev-plan')?.scrollIntoView({ block: 'end' }); true`);
      await sleep(120);
      await shot(`${label}-changes-blocked.png`);

      await evaluate(`(() => {
        const addBox = document.querySelector('.dev-change-file[data-path="src/new.ts"] input');
        addBox.checked = true;
        addBox.dispatchEvent(new Event('change', { bubbles: true }));
        const removeBox = document.querySelector('.dev-change-file[data-path="src/a.ts"] input');
        removeBox.checked = false;
        removeBox.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(200);
      await evaluate(`Array.from(document.querySelectorAll('#dev-changeset-detail .dev-button')).find((button) => button.textContent === '预检范围').click(); true`);
      await until(`document.getElementById('dev-changeset-detail').textContent.includes('选中 1 / 2 个文件')`);
      const preflight = requests(
        (entry) => entry.path.endsWith('/undo/preflight'),
      );
      check(
        `${label}: preflight carries the selected subset`,
        preflight.at(-1)?.body?.['paths'] instanceof Array &&
          (preflight.at(-1)?.body?.['paths'] as string[]).length === 1 &&
          (preflight.at(-1)?.body?.['paths'] as string[])[0] === 'src/new.ts',
        JSON.stringify(preflight.at(-1)?.body),
      );
      await evaluate(`Array.from(document.querySelectorAll('#dev-changeset-detail .dev-button')).find((button) => button.textContent === '撤销选中').click(); true`);
      await until(`document.getElementById('dev-changeset-detail').textContent.includes('实际已应用')`);
      const undo = requests((entry) => entry.path.endsWith('/undo') && entry.method === 'POST');
      check(
        `${label}: undo sends exactly the selected paths, never the whole set`,
        undo.length === 1 &&
          (undo[0]?.body?.['paths'] as string[]).length === 1 &&
          (undo[0]?.body?.['paths'] as string[])[0] === 'src/new.ts' &&
          undo[0]?.body?.['force'] === false,
        JSON.stringify(undo),
      );
      check(
        `${label}: applied set is reported`,
        (await evaluate(`document.getElementById('dev-changeset-detail').textContent`)).includes('已应用：src/new.ts'),
      );
      await shot(`${label}-changes-applied.png`);

      // Keyboard: focus enters the dialog, Tab stays inside, Escape restores focus.
      await evaluate(`document.getElementById('dev-close').click(); document.getElementById('dev-open').focus(); document.getElementById('dev-open').click(); true`);
      await until(`document.getElementById('dev-drawer').hidden === false`);
      check(
        `${label}: opening focuses the close button`,
        (await evaluate(`document.activeElement?.id`)) === 'dev-close',
        String(await evaluate(`document.activeElement?.id`)),
      );
      await key('Tab', 9);
      await sleep(80);
      const afterTab = await evaluate(`document.activeElement?.id`);
      check(`${label}: Tab moves into the panel`, afterTab === 'dev-tab-jobs' || afterTab === 'dev-tab-previews' || afterTab === 'dev-tab-changes', String(afterTab));
      await key('Tab', 9, 8);
      await sleep(80);
      check(
        `${label}: Shift+Tab returns to the close button`,
        (await evaluate(`document.activeElement?.id`)) === 'dev-close',
        String(await evaluate(`document.activeElement?.id`)),
      );
      await key('Escape', 27);
      await until(`document.getElementById('dev-drawer').hidden === true`);
      check(
        `${label}: Escape closes and restores focus to the opener`,
        (await evaluate(`document.activeElement?.id`)) === 'dev-open',
        String(await evaluate(`document.activeElement?.id`)),
      );

      await evaluate(`document.getElementById('dev-open').click(); true`);
      await until(`document.getElementById('dev-drawer').hidden === false`);
      // The drawer slides in over 180ms; measure the settled layout, not a frame
      // of the animation.
      await sleep(500);
      const overflow = await evaluate(`(() => {
        const drawer = document.getElementById('dev-drawer').getBoundingClientRect();
        return {
          viewport: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          drawerWidth: Math.round(drawer.width),
          drawerLeft: Math.round(drawer.left),
          drawerRight: Math.round(drawer.right),
          drawerInside: drawer.left >= -1 && drawer.right <= window.innerWidth + 1,
          noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        };
      })()`);
      check(
        `${label}: no horizontal overflow at ${width}px`,
        overflow.noHorizontalOverflow && overflow.bodyScrollWidth <= width + 1,
        JSON.stringify(overflow),
      );
      check(
        `${label}: the open drawer fits the viewport`,
        overflow.drawerInside && overflow.drawerWidth <= width + 1,
        JSON.stringify(overflow),
      );
      checks.push({
        name: `${label}: viewport detail`,
        pass: true,
        detail: JSON.stringify(overflow),
      });
      await shot(`${label}-panel.png`);
    }

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      session,
    );
    await scenario(390, '390');

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await scenario(1280, '1280');

    await writeLog();
    process.stdout.write(
      `dev-panel check: ${checks.filter((entry) => entry.pass).length}/${checks.length} assertions passed\n` +
        `  evidence: ${EVIDENCE}/dev-panel-check.json\n` +
        `  screenshots: ${EVIDENCE}/{390,1280}-{jobs,previews,sources,changes-*,panel}.png\n`,
    );
    cdp.close();
    clearTimeout(guard);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLog(message).catch(() => undefined);
    throw error;
  } finally {
    chrome.kill('SIGTERM');
    // Wait for Chrome to release the profile before removing it; otherwise the
    // directory is left behind and every run accumulates one.
    await new Promise<void>((resolve) => {
      if (chrome.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5_000);
      chrome.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await sleep(200);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `dev panel check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
