/**
 * Real-browser evidence for the Team drawer, end to end.
 *
 * Playwright is not a dependency of this package, so this reuses the CDP client
 * style from `scripts/dev-panel-check.ts`: Node's WebSocket and a local Chrome
 * install are the only requirements.
 *
 * The HTTP server is a local fixture, not the production service. It serves the
 * real `web/index.html`, `web/app.js`, `web/team.js` and `web/team.css`, and it
 * answers the Team API routes with a deterministic snapshot so the assertions
 * can check *which request a control sends* — method, URL, JSON body, CAS
 * revision and the `x-eunoia-token` header — and *what the real client renders*.
 * Screenshots and a JSON assertion log land in
 * `docs/features/evidence/integration-acceptance/team/`.
 *
 * What this exercises:
 *
 *   - open/close, focus, Escape, role=dialog, config meta, mode CAS toggle;
 *   - start run, member follow-up, task review (expectedRevision), messages;
 *   - approvals (member/action/generation), MCP interaction, integrations with
 *     a conflict resolved through source -> verify -> publish;
 *   - an SSE event plus reconnect that must not duplicate writes;
 *   - 1280px and 390px layouts with no horizontal overflow.
 */

import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVIDENCE = 'docs/features/evidence/integration-acceptance/team';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'team-fixture-token';
const TEAM_ID = 'team_fixture_0001';
const RUN_ID = 'run_team_fixture_0001';
const ROOT_ID = 'mem_root_0000000000000001';
const WRITER_ID = 'mem_writer_00000000000001';
const REQUIRED_TASK_ID = 'task_required_0001';
const OPTIONAL_TASK_ID = 'task_optional_0002';
const APPROVAL_ID = 'apr_shell_0001';
const SECOND_APPROVAL_ID = 'apr_network_0002';
const MCP_ID = 'mcp_interaction_0001';
const INTEGRATION_ID = 'int_team_fixture_0001';
const ARTIFACT_ID = 'artifact_required_0001';
const NOW = '2026-01-01T00:00:00.000Z';

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
const scenarios: Array<{ label: string; requests: Captured[] }> = [];
const findings: string[] = [];
const sseStreams = new Set<ServerResponse>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name: string, condition: boolean, detail = ''): void {
  checks.push({ name, pass: condition, detail });
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------- fixture ---

function makeMember(input: {
  id: string;
  name: string;
  role: 'root' | 'worker';
  depth: number;
  status: string;
  parentMemberId: string | null;
  workspaceId: string | null;
  workspaceMode: 'copy' | 'bind' | 'readonly';
  activationId: string | null;
}) {
  return {
    id: input.id,
    teamId: TEAM_ID,
    parentMemberId: input.parentMemberId,
    internalConversationId: `conv-${input.id}`,
    name: input.name,
    role: input.role,
    depth: input.depth,
    status: input.status,
    profile: {
      modelId: 'deepseek-flash',
      providerId: 'deepseek',
      maxSteps: 24,
      supportsTools: true,
      supportsImages: false,
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    permissions: {
      allowWorkspaceWrites: true,
      allowCommands: true,
      allowedTools: null,
      canSpawn: true,
      canWriteMemory: false,
      maxOutputChars: 12_000,
      imageAssetIds: [] as string[],
    },
    workspaceId: input.workspaceId,
    workspaceMode: input.workspaceMode,
    contextMode: 'fresh' as const,
    forkSeq: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    currentActivationId: input.activationId,
    error: null,
  };
}

function makeTask(input: {
  id: string;
  title: string;
  status: string;
  required: boolean;
  revision: number;
  ownerId: string | null;
  acceptance: string;
  specification?: string;
  failureReason?: string | null;
  attemptId: string;
}) {
  return {
    id: input.id,
    teamId: TEAM_ID,
    runId: RUN_ID,
    revision: input.revision,
    title: input.title,
    specification: input.specification ?? '',
    acceptance: input.acceptance,
    required: input.required,
    dependencies: [] as string[],
    ownerId: input.ownerId,
    status: input.status,
    writeScopes: ['src/'],
    createdBy: ROOT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: input.status === 'submitted' ? NOW : null,
    acceptedAt: null as string | null,
    failureReason: input.failureReason ?? null,
    currentAttemptId: input.attemptId,
  };
}

function makeMessage(sequence: number, senderId: string, recipientId: string, body: string) {
  return {
    id: `msg_${sequence}`,
    teamId: TEAM_ID,
    runId: RUN_ID,
    senderId,
    senderKind: senderId === ROOT_ID ? ('root' as const) : ('member' as const),
    recipientId,
    clientMessageId: `client-${sequence}`,
    body,
    sequence,
    state: 'processed' as const,
    createdAt: NOW,
    injectedAt: NOW,
    processedAt: NOW,
    activationId: 'act_root_0000000000000001',
    error: null,
  };
}

function makeEvent(sequence: number, kind: string, payload: Record<string, unknown>) {
  return {
    id: `evt_${sequence}`,
    teamId: TEAM_ID,
    runId: RUN_ID,
    sequence,
    kind,
    payload,
    idempotencyKey: null,
    createdAt: NOW,
  };
}

function makeApproval(index: number) {
  const shell = index === 1;
  return {
    approvalRequestId: shell ? APPROVAL_ID : SECOND_APPROVAL_ID,
    requestId: `req_approval_${index}`,
    requestKey: shell ? 'digest:4f2a9c' : 'digest:7d1e0b',
    memberId: ROOT_ID,
    memberName: '主成员',
    activationId: 'act_root_0000000000000001',
    generation: shell ? 3 : 2,
    taskId: null as string | null,
    action: shell ? 'shell.exec' : null,
    tool: shell ? null : 'net.fetch',
    resource: shell ? 'npm test' : 'https://example.test/api',
    reason: shell ? '成员请求在宿主机执行测试命令' : '成员请求访问外部网络',
    riskLevel: shell ? 'high' : 'medium',
    policyVersion: 'policy-v7',
    scope: 'team',
    expiresAt: '2026-01-01T00:10:00.000Z',
    createdAt: NOW,
    status: 'pending',
  };
}

function makeFixture() {
  const root = makeMember({
    id: ROOT_ID,
    name: '主成员',
    role: 'root',
    depth: 1,
    status: 'active',
    parentMemberId: null,
    workspaceId: 'ws_root_0001',
    workspaceMode: 'bind',
    activationId: 'act_root_0000000000000001',
  });
  const writer = makeMember({
    id: WRITER_ID,
    name: '写手',
    role: 'worker',
    depth: 2,
    status: 'idle',
    parentMemberId: ROOT_ID,
    workspaceId: 'ws_writer_0001',
    workspaceMode: 'copy',
    activationId: null,
  });
  const required = makeTask({
    id: REQUIRED_TASK_ID,
    title: '实现 S3 适配',
    status: 'submitted',
    required: true,
    revision: 7,
    ownerId: WRITER_ID,
    acceptance: 'npm test -- shared 通过，且没有改动 tests/',
    specification: '在 src/shared.ts 增加对象存储适配层。',
    attemptId: 'attempt_required_1',
  });
  const optional = makeTask({
    id: OPTIONAL_TASK_ID,
    title: '补充使用说明',
    status: 'submitted',
    required: false,
    revision: 4,
    ownerId: WRITER_ID,
    acceptance: 'README 里有一段可复制的例子。',
    attemptId: 'attempt_optional_1',
  });
  const approval1 = makeApproval(1);
  const approval2 = makeApproval(2);
  const sseEvent = makeEvent(9, 'member.status', { memberId: ROOT_ID, status: 'idle' });
  return {
    team: {
      id: TEAM_ID,
      ownerId: 'fixture-owner',
      rootConversationId: CONVERSATION,
      enabled: true,
      configRevision: 1,
      config: {
        mode: 'team' as 'team' | 'delegation',
        defaultModelId: 'deepseek-flash',
        autoDispatch: true,
        dispatchPaused: false,
        limits: {
          maxMembers: 4,
          maxConcurrentModelRequests: 3,
          maxDepth: 2,
          maxActivations: 32,
          maxModelRequests: 64,
          maxTasks: 256,
          maxMessages: 128,
          maxMessageChars: 4_000,
          maxQueuedMessagesPerMember: 16,
          maxAutoActivationsPerMember: 8,
          maxBroadcastFanout: 8,
        },
        budget: {
          maxInputTokens: 400_000,
          maxOutputTokens: 32_000,
          maxRequests: 24,
          maxEstimatedCostUsd: null,
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    run: {
      id: RUN_ID,
      teamId: TEAM_ID,
      ownerId: 'fixture-owner',
      rootConversationId: CONVERSATION,
      rootTurnId: 'turn-fixture',
      rootRequestId: 'req-fixture',
      inputHash: 'sha256:input-fixture',
      status: 'running',
      budget: {
        maxInputTokens: 400_000,
        maxOutputTokens: 32_000,
        maxRequests: 24,
        maxEstimatedCostUsd: null,
      },
      rootMemberId: ROOT_ID,
      reason: null as string | null,
      createdAt: NOW,
      updatedAt: NOW,
      finishedAt: null as string | null,
    },
    members: [root, writer],
    tasks: [required, optional],
    messages: [
      makeMessage(1, ROOT_ID, WRITER_ID, '请描述实现步骤。'),
      makeMessage(2, WRITER_ID, ROOT_ID, '已提交 diff，见 artifact_required_0001。'),
    ],
    events: [
      makeEvent(1, 'team.created', { teamId: TEAM_ID }),
      makeEvent(2, 'run.created', { runId: RUN_ID, rootMemberId: ROOT_ID }),
      makeEvent(3, 'member.created', { memberId: WRITER_ID, name: '写手' }),
      makeEvent(4, 'task.created', { taskId: REQUIRED_TASK_ID }),
      makeEvent(5, 'task.claimed', { taskId: REQUIRED_TASK_ID, memberId: WRITER_ID }),
      makeEvent(6, 'task.submitted', { taskId: REQUIRED_TASK_ID, attemptId: 'attempt_required_1' }),
      makeEvent(7, 'message.accepted', { messageId: 'msg_2', sequence: 2 }),
      makeEvent(8, 'integration.conflict', { integrationId: INTEGRATION_ID, path: 'src/shared.ts' }),
    ],
    sseEvent,
    sseReleased: false,
    approvals: [approval1, approval2],
    mcpInteractions: [
      {
        id: MCP_ID,
        userId: 'fixture-owner',
        conversationId: 'conv-mcp',
        turnId: 'turn-mcp',
        actionId: 'action_mcp_1',
        serverId: 'github',
        kind: 'approval',
        status: 'pending',
        summary: '写入仓库标签',
        payload: { tool: 'issues.update', argsDigest: 'sha256:mcp-args' },
        resumeKey: 'resume_mcp_1',
        expiresAt: '2026-01-01T00:10:00.000Z',
        response: null,
        createdAt: NOW,
        resolvedAt: null,
        memberId: WRITER_ID,
        memberName: '写手',
      },
    ],
    artifacts: [
      {
        id: ARTIFACT_ID,
        teamId: TEAM_ID,
        runId: RUN_ID,
        taskId: REQUIRED_TASK_ID,
        attemptId: 'attempt_required_1',
        memberId: WRITER_ID,
        kind: 'patch',
        manifest: {
          files: [
            {
              path: 'src/shared.ts',
              change: 'modified',
              baseHash: 'sha256:base-shared',
              contentHash: 'sha256:candidate-shared',
              bytes: 42,
              executable: false,
              binary: false,
              content: 'export const shared = "candidate";\n',
            },
          ],
          sourceVersion: 'v1',
          candidateHash: 'cand_required_0001',
        },
        testEvidence: ['npm test -- shared ✓'],
        createdAt: NOW,
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        teamId: TEAM_ID,
        runId: RUN_ID,
        taskId: REQUIRED_TASK_ID,
        baseVersion: 'v1',
        candidateHash: 'cand_integration_0001',
        status: 'conflict' as string,
        conflicts: ['src/shared.ts'],
        baseHashes: { 'src/shared.ts': 'sha256:base-shared' },
        resultHashes: {} as Record<string, string>,
        verification: {
          memberId: WRITER_ID,
          conflictContent: {
            'src/shared.ts': {
              candidate: 'export const shared = "candidate";\n',
              other: 'export const shared = "other";\n',
            },
          },
        } as Record<string, unknown> | null,
        journal: [{ at: NOW, action: 'created', files: ['src/shared.ts'], detail: 'candidate differs from source' }],
        createdAt: NOW,
        updatedAt: NOW,
        publishedAt: null as string | null,
      },
    ],
  };
}

type Fixture = ReturnType<typeof makeFixture>;
let fixture: Fixture = makeFixture();

function resetFixture(): void {
  for (const stream of sseStreams) {
    try {
      stream.end();
    } catch {
      // The client already went away.
    }
  }
  sseStreams.clear();
  fixture = makeFixture();
  captured.length = 0;
}

function activeRunId(): string | null {
  const active = ['queued', 'running', 'pausing', 'paused', 'waiting_user', 'stopping', 'needs_reconciliation'];
  return active.includes(fixture.run.status) ? fixture.run.id : null;
}

function snapshotValue(): Record<string, unknown> {
  return {
    team: fixture.team,
    run: fixture.run,
    members: fixture.members,
    approvals: fixture.approvals.filter((entry) => entry.status === 'pending'),
    mcpInteractions: fixture.mcpInteractions.filter((entry) => entry.status === 'pending'),
    tasks: fixture.tasks,
    taskTotal: fixture.tasks.length,
    messages: fixture.messages,
    artifacts: fixture.artifacts,
    budget: {
      limits: fixture.run.budget,
      reservedInputTokens: 1_200,
      reservedOutputTokens: 400,
      settledInputTokens: 0,
      settledOutputTokens: 0,
      reservedRequests: 1,
      settledRequests: 0,
      estimatedCostUsd: 0,
      incompleteEntries: 0,
      remainingInputTokens: 398_800,
      remainingOutputTokens: 31_600,
      remainingRequests: 23,
      exhausted: false,
    },
    events: fixture.events,
    eventCursor: fixture.events.at(-1)?.sequence ?? 0,
    mode: fixture.team.config.mode,
  };
}

function conflictDetail(): Record<string, unknown> {
  return {
    integration: fixture.integrations[0],
    conflicts: fixture.integrations[0]?.conflicts.map((path) => ({
      path,
      baseHash: 'sha256:base-shared',
      source: { content: 'export const shared = "source";\n', hash: 'sha256:source-shared' },
      candidate: { content: 'export const shared = "candidate";\n', hash: 'sha256:candidate-shared' },
      other: 'export const shared = "other";\n',
    })),
  };
}

function releaseSse(): void {
  if (!fixture.sseReleased) {
    fixture.sseReleased = true;
    fixture.sseEvent.sequence = fixture.events.length + 1;
    fixture.sseEvent.id = `evt_${fixture.sseEvent.sequence}`;
    fixture.events.push(fixture.sseEvent);
    const root = fixture.members.find((entry) => entry.role === 'root');
    if (root) root.status = 'idle';
    fixture.messages.push(makeMessage(4, WRITER_ID, ROOT_ID, '（SSE 重连）测试证据已附上。'));
  }
  const frame = `id: ${fixture.sseEvent.sequence}\nevent: team\ndata: ${JSON.stringify(fixture.sseEvent)}\n\n`;
  for (const stream of sseStreams) {
    try {
      stream.write(frame);
      // Give EventSource a tick to deliver and persist the sequence before the
      // transport closes; an immediate end can race the reconnect and resume
      // from the old cursor (a test-fixture race, not a client bug).
      setTimeout(() => {
        try {
          stream.end();
        } catch {
          // Ignore a stream that was already closed by the test.
        }
      }, 250);
    } catch {
      // Ignore a stream that was already closed by the test.
    }
    sseStreams.delete(stream);
  }
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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
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

function writeGuard(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['x-eunoia-token'] !== TOKEN) {
    json(res, 403, { error: '缺少本地控制令牌。', code: 'TEAM_FORBIDDEN' });
    return false;
  }
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    json(res, 415, { error: '写操作必须是 JSON。', code: 'TEAM_FORBIDDEN' });
    return false;
  }
  return true;
}

function pathOf(base: string): string {
  const prefix = `/api/teams/runs/${RUN_ID}`;
  return base.startsWith(`${prefix}/`) ? base.slice(prefix.length + 1) : '';
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathless = url.pathname;
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
  if (method !== 'GET' || pathless.startsWith('/api/')) {
    captured.push({
      method,
      path: `${pathless}${url.search}`,
      body,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(',') : String(value ?? ''),
        ]),
      ),
    });
  }

  if (pathless === '/__fixture/release-sse' && method === 'GET') {
    releaseSse();
    json(res, 200, { released: true, sequence: fixture.sseEvent.sequence });
    return;
  }
  if (pathless === '/__fixture/state' && method === 'GET') {
    json(res, 200, { checks, requests: captured.length, fixture });
    return;
  }

  // ------------------------------------------------------------- Team API ---

  if (pathless.startsWith('/api/teams') && method !== 'GET' && !writeGuard(req, res)) return;

  if (pathless === '/api/teams' && method === 'GET') {
    json(res, 200, {
      team: fixture.team,
      runs: [fixture.run],
      activeRunId: activeRunId(),
      mode: fixture.team.config.mode,
    });
    return;
  }

  if (pathless === '/api/teams/config' && method === 'POST') {
    const expected = body?.['expectedRevision'];
    if (typeof expected !== 'number' || expected !== fixture.team.configRevision) {
      json(res, 409, {
        error: '配置已被更新。',
        code: 'TEAM_CONFIG_CONFLICT',
        detail: { currentRevision: fixture.team.configRevision },
      });
      return;
    }
    const config = (body?.['config'] ?? {}) as Record<string, unknown>;
    fixture.team.config.mode = config['mode'] === 'delegation' ? 'delegation' : 'team';
    fixture.team.enabled = body?.['enabled'] !== false;
    fixture.team.configRevision += 1;
    fixture.team.updatedAt = NOW;
    json(res, 200, { team: fixture.team });
    return;
  }

  if (pathless === '/api/teams/runs' && method === 'POST') {
    if (typeof body?.['conversationId'] !== 'string' || typeof body?.['message'] !== 'string') {
      json(res, 400, { error: '缺少 conversationId 或 message。', code: 'TEAM_TASK_INVALID' });
      return;
    }
    fixture.run.status = 'running';
    fixture.run.finishedAt = null;
    fixture.run.updatedAt = NOW;
    json(res, 201, {
      team: fixture.team,
      run: fixture.run,
      rootMemberId: ROOT_ID,
      activationId: 'act_started_0001',
      created: true,
      snapshot: snapshotValue(),
    });
    return;
  }

  if (pathless === `/api/teams/runs/${RUN_ID}` && method === 'GET') {
    json(res, 200, snapshotValue());
    return;
  }

  const suffix = pathOf(pathless);
  if (suffix === 'events/stream' && method === 'GET') {
    const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseStreams.add(res);
    const drop = (): void => {
      sseStreams.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    if (after >= fixture.sseEvent.sequence) {
      // Reconnected at/after the fixture event: stay open, send nothing. A real
      // stream is a cursor, not a replay loop.
      return;
    }
    // The first connection waits for the test to release the event. That makes
    // "event then reconnect" deterministic instead of a timing race.
    return;
  }

  if (suffix === 'stop' && method === 'POST') {
    fixture.run.status = 'cancelled';
    fixture.run.finishedAt = NOW;
    fixture.run.updatedAt = NOW;
    fixture.run.reason = typeof body?.['reason'] === 'string' ? body['reason'] : '用户停止整队';
    releaseSse();
    json(res, 200, { run: fixture.run });
    return;
  }

  if (suffix === 'pause' && method === 'POST') {
    fixture.run.status = 'paused';
    json(res, 200, { run: fixture.run });
    return;
  }

  if (suffix === 'resume' && method === 'POST') {
    fixture.run.status = 'running';
    json(res, 200, { run: fixture.run });
    return;
  }

  if (suffix === 'messages' && method === 'POST') {
    if (
      typeof body?.['recipientId'] !== 'string' ||
      typeof body?.['clientMessageId'] !== 'string' ||
      typeof body?.['body'] !== 'string'
    ) {
      json(res, 400, { error: '消息字段不完整。', code: 'TEAM_MESSAGE_INVALID' });
      return;
    }
    const message = makeMessage(
      fixture.messages.length + 1,
      'fixture-owner',
      body['recipientId'],
      body['body'],
    );
    message.clientMessageId = body['clientMessageId'];
    fixture.messages.push(message);
    fixture.events.push(makeEvent(fixture.events.length + 1, 'message.accepted', { messageId: message.id }));
    json(res, 201, { message, duplicate: false });
    return;
  }

  const mcpMatch = /^mcp-interactions\/([^/]+)$/.exec(suffix);
  if (mcpMatch && method === 'POST') {
    const id = decodeURIComponent(mcpMatch[1] ?? '');
    const interaction = fixture.mcpInteractions.find((entry) => entry.id === id);
    if (!interaction) {
      json(res, 404, { error: '没有这个交互。', code: 'TEAM_TASK_NOT_FOUND' });
      return;
    }
    interaction.status = 'resolved';
    fixture.mcpInteractions = fixture.mcpInteractions.filter((entry) => entry.id !== id);
    json(res, 200, { interaction });
    return;
  }

  const approvalMatch = /^approvals\/([^/]+)$/.exec(suffix);
  if (approvalMatch && method === 'POST') {
    const id = decodeURIComponent(approvalMatch[1] ?? '');
    const approval = fixture.approvals.find((entry) => entry.approvalRequestId === id);
    if (!approval) {
      json(res, 404, { error: '没有这个审批。', code: 'TEAM_TASK_NOT_FOUND' });
      return;
    }
    approval.status = body?.['decision'] === 'approved' ? 'approved' : 'denied';
    fixture.approvals = fixture.approvals.filter((entry) => entry.approvalRequestId !== id);
    json(res, 200, { approval });
    return;
  }

  if (suffix === 'integrations' && method === 'GET') {
    json(res, 200, { integrations: fixture.integrations });
    return;
  }

  if (suffix === 'steering' && method === 'POST') {
    json(res, 201, { message: makeMessage(fixture.messages.length + 1, 'fixture-owner', ROOT_ID, String(body?.['message'] ?? '')) });
    return;
  }

  // ---------------------------------------------------------- member routes ---

  const memberMatch = /^\/api\/teams\/members\/([^/]+)\/([^/]+)$/.exec(pathless);
  if (memberMatch && method === 'POST') {
    const memberId = decodeURIComponent(memberMatch[1] ?? '');
    const member = fixture.members.find((entry) => entry.id === memberId);
    if (!member) {
      json(res, 404, { error: '没有这个成员。', code: 'TEAM_MEMBER_NOT_FOUND' });
      return;
    }
    if (memberMatch[2] === 'followup') {
      if (typeof body?.['runId'] !== 'string' || typeof body?.['message'] !== 'string') {
        json(res, 400, { error: '跟进字段不完整。', code: 'TEAM_TASK_INVALID' });
        return;
      }
      json(res, 201, {
        activation: {
          id: 'act_followup_0001',
          runId: RUN_ID,
          memberId,
          generation: 4,
          status: 'queued',
        },
      });
      return;
    }
    if (memberMatch[2] === 'interrupt') {
      json(res, 200, { member });
      return;
    }
    if (memberMatch[2] === 'close') {
      member.status = 'closed';
      json(res, 200, { members: [member] });
      return;
    }
  }

  // ------------------------------------------------------------ task routes ---

  const taskMatch = /^\/api\/teams\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(pathless);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1] ?? '');
    const task = fixture.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      json(res, 404, { error: '没有这个任务。', code: 'TEAM_TASK_NOT_FOUND' });
      return;
    }
    const action = taskMatch[2] ?? '';
    if (action === '' && method === 'GET') {
      json(res, 200, {
        task,
        run: fixture.run,
        attempts: [
          {
            id: task.currentAttemptId,
            taskId: task.id,
            activationId: `act_${task.id}`,
            generation: task.revision,
            leaseExpiresAt: null,
            baselineId: 'baseline_1',
            submission: {
              summary: '补充了 shared 适配与测试',
              artifactIds: [ARTIFACT_ID],
              testEvidence: ['npm test -- shared ✓'],
              candidateHash: 'cand_required_0001',
              submittedAt: NOW,
              submittedBy: WRITER_ID,
            },
            review: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      return;
    }
    if (action === 'review' && method === 'POST') {
      const expected = body?.['expectedRevision'];
      const decision = body?.['decision'];
      if (typeof expected !== 'number' || expected !== task.revision) {
        json(res, 409, {
          error: '任务版本已变化。',
          code: 'TEAM_TASK_CONFLICT',
          detail: { currentRevision: task.revision },
        });
        return;
      }
      if (decision !== 'accepted' && decision !== 'rejected') {
        json(res, 400, { error: 'decision 必须是 accepted 或 rejected。', code: 'TEAM_TASK_INVALID' });
        return;
      }
      task.revision += 1;
      task.updatedAt = NOW;
      if (decision === 'accepted') {
        task.status = 'accepted';
        task.acceptedAt = NOW;
        task.failureReason = null;
      } else {
        task.status = 'pending';
        task.failureReason = String(body?.['reason'] ?? '');
      }
      fixture.events.push(makeEvent(fixture.events.length + 1, 'task.reviewed', { taskId, decision }));
      json(res, 200, {
        task,
        review: { decision, reviewerId: 'fixture-owner', reason: body?.['reason'] ?? '', reviewedAt: NOW },
      });
      return;
    }
    if (action === 'cancel' && method === 'POST') {
      task.status = 'cancelled';
      task.revision += 1;
      task.updatedAt = NOW;
      json(res, 200, { task });
      return;
    }
  }

  // ----------------------------------------------------- integration routes ---

  const conflictMatch = /^\/api\/teams\/integrations\/([^/]+)\/conflicts$/.exec(pathless);
  if (conflictMatch) {
    const integration = fixture.integrations.find(
      (entry) => entry.id === decodeURIComponent(conflictMatch[1] ?? ''),
    );
    if (!integration) {
      json(res, 404, { error: '没有这个集成候选。', code: 'TEAM_INTEGRATION_CONFLICT' });
      return;
    }
    if (method === 'GET') {
      json(res, 200, conflictDetail());
      return;
    }
    if (method === 'POST') {
      const path = body?.['path'];
      const resolution = body?.['resolution'];
      if (typeof path !== 'string' || !integration.conflicts.includes(path)) {
        json(res, 409, { error: '这个路径不在冲突列表里。', code: 'TEAM_INTEGRATION_CONFLICT' });
        return;
      }
      if (resolution !== 'source' && resolution !== 'candidate' && resolution !== 'manual') {
        json(res, 400, { error: 'resolution 必须是 source/candidate/manual。', code: 'TEAM_TASK_INVALID' });
        return;
      }
      integration.conflicts = integration.conflicts.filter((entry) => entry !== path);
      integration.status = 'resolved';
      integration.updatedAt = NOW;
      integration.journal.push({
        at: NOW,
        action: 'resolved',
        files: [path],
        detail: `resolution=${resolution}`,
      });
      json(res, 200, { integration });
      return;
    }
  }

  const verifyMatch = /^\/api\/teams\/integrations\/([^/]+)\/verify$/.exec(pathless);
  if (verifyMatch && method === 'POST') {
    const integration = fixture.integrations.find(
      (entry) => entry.id === decodeURIComponent(verifyMatch[1] ?? ''),
    );
    if (!integration) {
      json(res, 404, { error: '没有这个集成候选。', code: 'TEAM_INTEGRATION_CONFLICT' });
      return;
    }
    integration.status = 'verified';
    integration.updatedAt = NOW;
    integration.journal.push({ at: NOW, action: 'verified', files: [], detail: 'verification passed' });
    json(res, 200, { integration });
    return;
  }

  const publishMatch = /^\/api\/teams\/integrations\/([^/]+)\/publish$/.exec(pathless);
  if (publishMatch && method === 'POST') {
    const integration = fixture.integrations.find(
      (entry) => entry.id === decodeURIComponent(publishMatch[1] ?? ''),
    );
    if (!integration) {
      json(res, 404, { error: '没有这个集成候选。', code: 'TEAM_INTEGRATION_CONFLICT' });
      return;
    }
    integration.status = 'published';
    integration.publishedAt = NOW;
    integration.updatedAt = NOW;
    integration.journal.push({ at: NOW, action: 'published', files: ['src/shared.ts'], detail: 'written' });
    json(res, 200, {
      integration,
      publication: { written: ['src/shared.ts'], skipped: [], stopped: false },
    });
    return;
  }

  // ---------------------------------------------- app.js bootstrap stubs ---

  if (pathless === '/api/media/capabilities') {
    json(res, 200, {
      limits: { maxImagesPerMessage: 5, maxImageBytes: 10 * 1024 * 1024, maxDimension: 8192, maxPixels: 40_000_000 },
      models: [{ id: 'deepseek-flash', displayName: 'DeepSeek Flash', available: true, input: { image: 'supported' } }],
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
  if (pathless === '/api/memory') {
    json(res, 200, { memories: [] });
    return;
  }

  if (pathless === '/' || pathless === '/index.html') {
    let html = await readFile(join(process.cwd(), 'web', 'index.html'), 'utf8');
    html = html.replace('</head>', `<meta name="eunoia-token" content="${TOKEN}">\n</head>`);
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

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// --------------------------------------------------------------- scenario ---

async function main(): Promise<void> {
  resetFixture();
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;
  await mkdir(EVIDENCE, { recursive: true });

  const profile = await mkdtemp(join(tmpdir(), 'team-check-profile-'));
  const home = await mkdtemp(join(tmpdir(), 'team-check-home-'));
  const debugPort = await freePort();
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
      '--disable-dev-shm-usage',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--hide-scrollbars',
      '--window-size=1280,900',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: home } },
  );
  chrome.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    if (/Failed to|FATAL|EPERM|denied/i.test(line)) process.stderr.write(`chrome: ${line}`);
  });
  const guard = setTimeout(() => {
    process.stderr.write('team browser check: timed out\n');
    chrome.kill('SIGKILL');
    process.exit(3);
  }, 240_000);
  guard.unref();

  let pageProbe: (() => Promise<Record<string, unknown>>) | null = null;
  const writeLog = async (error?: string): Promise<void> => {
    const passed = checks.filter((entry) => entry.pass).length;
    await writeFile(
      `${EVIDENCE}/team-browser-check.json`,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          command: 'node --experimental-strip-types scripts/team-browser-check.ts',
          browser: 'Google Chrome (headless=new) via CDP',
          url,
          viewports: [1280, 390],
          totals: { passed, total: checks.length, failed: checks.length - passed },
          checks,
          scenarios,
          findings,
          fixture: {
            conversationId: CONVERSATION,
            teamId: TEAM_ID,
            runId: RUN_ID,
            members: [ROOT_ID, WRITER_ID],
            tasks: [REQUIRED_TASK_ID, OPTIONAL_TASK_ID],
            approvals: [APPROVAL_ID, SECOND_APPROVAL_ID],
            mcpInteraction: MCP_ID,
            integration: INTEGRATION_ID,
            conflictPath: 'src/shared.ts',
          },
          notes: [
            'The HTTP server is a local fixture. The page, team.js and the requests it sends are real.',
            'This build writes Team config with POST /api/teams/config (CAS expectedRevision); it has no PUT/PATCH route.',
            'This build has no human claim/submit controls: task submission evidence is read through 查看提交 (GET /api/teams/tasks/:id) and review uses accept/reject with expectedRevision.',
            'A second pending approval exists only so both approve and reject request shapes are exercised.',
          ],
          ...(error ? { error } : {}),
          ...(pageProbe ? { pageProbe: await pageProbe().catch((probeError: unknown) => ({ probeError: String(probeError) })) } : {}),
        },
        null,
        2,
      )}\n`,
    );
  };

  try {
    let wsUrl = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
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
      )) as { result: { value: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      if (result.exceptionDetails) {
        throw new Error(
          `page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };
    pageProbe = async () =>
      evaluate(`({
        text: document.getElementById('team-view')?.textContent ?? '',
        drawerOpen: document.getElementById('team-drawer')?.hidden === false,
        activeTab: Array.from(document.querySelectorAll('[data-team-tab]')).find((node) => node.getAttribute('aria-selected') === 'true')?.dataset.teamTab ?? null,
        bodyText: document.body.textContent.slice(0, 500),
      })`);
    const until = async (expression: string, timeoutMs = 6_000): Promise<void> => {
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
    const writes = (): Captured[] => captured.filter((entry) => entry.method !== 'GET');
    const waitForCapture = async (
      predicate: (entry: Captured) => boolean,
      label: string,
      timeoutMs = 6_000,
    ): Promise<Captured> => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const found = captured.find(predicate);
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`timed out waiting for request: ${label}`);
    };
    const cardFor = (needle: string): string =>
      `Array.from(document.querySelectorAll('#team-view .team-card')).find((card) => (card.textContent || '').includes(${JSON.stringify(needle)}))`;
    const clickInCard = (needle: string, text: string): string => `(() => {
      const card = ${cardFor(needle)};
      if (!card) throw new Error('card not found: ${needle}');
      const button = Array.from(card.querySelectorAll('button')).find((node) => node.textContent.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error('button not found: ${text}');
      button.click();
      return true;
    })()`;
    const fillCard = (needle: string, label: string, value: string): string => `(() => {
      const card = ${cardFor(needle)};
      if (!card) throw new Error('card not found: ${needle}');
      const input = Array.from(card.querySelectorAll('input, textarea')).find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!input) throw new Error('input not found: ${label}');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;

    async function scenario(width: number, label: string): Promise<void> {
      resetFixture();
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width,
          height: width === 390 ? 844 : 900,
          deviceScaleFactor: width === 390 ? 2 : 1,
          mobile: width === 390,
        },
        session,
      );
      await cdp.send('Page.navigate', { url }, session);
      await sleep(700);
      await evaluate(`localStorage.setItem('df_conversation', ${JSON.stringify(CONVERSATION)}); true`);
      await cdp.send('Page.reload', {}, session);
      await sleep(1_200);
      await until(`document.readyState === 'complete' && document.getElementById('team-open') !== null`);
      await evaluate(`window.confirm = () => true; window.prompt = () => 'fixture-value'; true`);

      // ---------------------------------------------------------- open ---
      await evaluate(
        `document.getElementById('team-open').focus(); document.getElementById('team-open').click(); true`,
      );
      await until(`document.getElementById('team-drawer').hidden === false`);
      check(`${label}: Team drawer opens from #team-open`, true);
      check(
        `${label}: drawer is a modal dialog`,
        (await evaluate(`document.getElementById('team-drawer').getAttribute('role')`)) === 'dialog' &&
          (await evaluate(`document.getElementById('team-drawer').getAttribute('aria-modal')`)) === 'true',
      );
      check(
        `${label}: closing control is labelled`,
        (await evaluate(`document.getElementById('team-close').getAttribute('aria-label')`)) === '关闭协作面板',
      );
      await until(`document.querySelectorAll('#team-meta div').length >= 6`);
      const meta = (await evaluate(`Array.from(document.querySelectorAll('#team-meta div')).map((row) => ({
        label: row.querySelector('dt')?.textContent ?? '',
        value: row.querySelector('dd')?.textContent ?? '',
      }))`)) as Array<{ label: string; value: string }>;
      const metaValue = (name: string): string => meta.find((entry) => entry.label === name)?.value ?? '';
      check(`${label}: config renders mode`, metaValue('模式') === 'Team', JSON.stringify(meta));
      check(`${label}: config renders member limit`, metaValue('成员上限') === '4', JSON.stringify(meta));
      check(`${label}: config renders model`, metaValue('模型') === 'deepseek-flash', JSON.stringify(meta));
      check(`${label}: config renders request budget`, metaValue('请求上限') === '24', JSON.stringify(meta));
      check(
        `${label}: config renders token budgets`,
        metaValue('输入预算').replace(/,/g, '') === '400000' && metaValue('输出预算').replace(/,/g, '') === '32000',
        JSON.stringify(meta),
      );
      await shot(`${label}-members.png`);

      // ------------------------------------------------------ mode CAS ---
      await evaluate(`document.getElementById('team-mode').click(); true`);
      await until(`document.getElementById('team-mode').textContent === '关闭'`);
      const configWrites = requests((entry) => entry.method === 'POST' && entry.path === '/api/teams/config');
      check(
        `${label}: mode toggle writes config with expectedRevision (POST)`,
        configWrites.length === 1 &&
          configWrites[0]?.body?.['conversationId'] === CONVERSATION &&
          configWrites[0]?.body?.['expectedRevision'] === 1 &&
          (configWrites[0]?.body?.['config'] as Record<string, unknown> | undefined)?.['mode'] === 'delegation' &&
          configWrites[0]?.body?.['enabled'] === false &&
          configWrites[0]?.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(configWrites),
      );
      check(
        `${label}: mode label and meta follow the response`,
        (await evaluate(`document.getElementById('team-mode').getAttribute('aria-pressed')`)) === 'false' &&
          (await evaluate(`document.getElementById('team-meta').textContent`)).includes('仅委派'),
      );
      await evaluate(`document.getElementById('team-mode').click(); true`);
      await until(`document.getElementById('team-mode').textContent === '开启'`);
      const configWrites2 = requests((entry) => entry.method === 'POST' && entry.path === '/api/teams/config');
      check(
        `${label}: second toggle uses the new revision`,
        configWrites2.length === 2 &&
          configWrites2[1]?.body?.['expectedRevision'] === 2 &&
          (configWrites2[1]?.body?.['config'] as Record<string, unknown> | undefined)?.['mode'] === 'team' &&
          configWrites2[1]?.body?.['enabled'] === true,
        JSON.stringify(configWrites2),
      );

      // ------------------------------------------------------ start run ---
      await evaluate(`(() => {
        const input = document.getElementById('team-start-message');
        input.value = '给 shared.ts 加一个对象存储适配，并让写手补测试证据';
        document.getElementById('team-start').requestSubmit();
        return true;
      })()`);
      const startRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === '/api/teams/runs',
        'start run POST',
      );
      check(
        `${label}: start run posts conversationId/message/requestId and token`,
        startRequest.body?.['conversationId'] === CONVERSATION &&
          startRequest.body?.['message'] === '给 shared.ts 加一个对象存储适配，并让写手补测试证据' &&
          typeof startRequest.body?.['requestId'] === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(startRequest.body?.['requestId'])) &&
          startRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(startRequest),
      );
      await until(`document.getElementById('team-start-note').textContent.includes('当前运行')`);
      check(`${label}: start run note points at the active run`, true);

      // --------------------------------------------------------- members ---
      await until(`document.querySelectorAll('#team-view .team-card').length >= 2`);
      const memberIds = (await evaluate(`Array.from(document.querySelectorAll('#team-view .team-card-id'))
        .map((node) => node.textContent.trim())
        .filter((text) => text.startsWith('mem_'))`)) as string[];
      check(
        `${label}: members tab renders exactly two durable member ids`,
        memberIds.length === 2 && memberIds.includes(ROOT_ID) && memberIds.includes(WRITER_ID),
        JSON.stringify(memberIds),
      );
      const membersText = await evaluate(`document.getElementById('team-view').textContent`);
      check(
        `${label}: members render name/role/depth/model/context/workspace`,
        membersText.includes('主成员') &&
          membersText.includes('写手') &&
          membersText.includes('root · 深度 1 · deepseek-flash · fresh') &&
          membersText.includes('worker · 深度 2 · deepseek-flash · fresh') &&
          membersText.includes('工作区：bind') &&
          membersText.includes('工作区：copy'),
        String(membersText),
      );
      await evaluate(`(() => {
        const card = ${cardFor(WRITER_ID)};
        const input = Array.from(card.querySelectorAll('input')).find((node) => (node.getAttribute('aria-label') || '').startsWith('给 写手'));
        if (!input) throw new Error('follow-up input missing');
        input.value = '先补上测试证据，再报告命令输出';
        card.querySelector('form').requestSubmit();
        return true;
      })()`);
      const followupRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/members/${WRITER_ID}/followup`,
        'member follow-up POST',
      );
      check(
        `${label}: follow-up posts runId/message with token`,
        followupRequest.body?.['runId'] === RUN_ID &&
          followupRequest.body?.['message'] === '先补上测试证据，再报告命令输出' &&
          followupRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(followupRequest),
      );

      // ----------------------------------------------------------- tasks ---
      await evaluate(`document.querySelector('[data-team-tab="tasks"]').click(); true`);
      await until(`document.getElementById('team-view').textContent.includes(${JSON.stringify(REQUIRED_TASK_ID)})`);
      const taskText = await evaluate(`document.getElementById('team-view').textContent`);
      check(
        `${label}: tasks show required and optional with CAS revision`,
        taskText.includes(`${REQUIRED_TASK_ID} · rev 7 · 必需`) &&
          taskText.includes(`${OPTIONAL_TASK_ID} · rev 4 · 可选`),
        String(taskText),
      );
      check(
        `${label}: required task shows acceptance and owner`,
        taskText.includes('验收：npm test -- shared 通过，且没有改动 tests/') &&
          taskText.includes('负责人：写手（mem_writer_0…）'),
        String(taskText),
      );
      await evaluate(clickInCard(REQUIRED_TASK_ID, '查看提交'));
      await until(`document.getElementById('team-view').textContent.includes('npm test -- shared ✓')`);
      const taskDetailRequests = requests(
        (entry) => entry.method === 'GET' && entry.path === `/api/teams/tasks/${REQUIRED_TASK_ID}`,
      );
      check(
        `${label}: 查看提交 reads the submission evidence (no claim/submit controls in this build)`,
        taskDetailRequests.length === 1 &&
          (await evaluate(`document.getElementById('team-view').textContent`)).includes('补充了 shared 适配与测试'),
        JSON.stringify(taskDetailRequests),
      );
      await shot(`${label}-tasks.png`);

      await evaluate(fillCard(REQUIRED_TASK_ID, '任务 实现 S3 适配 的验收理由', '证据充分，通过'));
      await evaluate(clickInCard(REQUIRED_TASK_ID, '通过'));
      const acceptRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/tasks/${REQUIRED_TASK_ID}/review`,
        'task accept POST',
      );
      check(
        `${label}: accept posts expectedRevision 7 / accepted / reason`,
        acceptRequest.body?.['expectedRevision'] === 7 &&
          acceptRequest.body?.['decision'] === 'accepted' &&
          acceptRequest.body?.['reason'] === '证据充分，通过' &&
          acceptRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(acceptRequest),
      );
      await until(`document.getElementById('team-view').textContent.includes('rev 8')`);

      await evaluate(fillCard(OPTIONAL_TASK_ID, '任务 补充使用说明 的验收理由', '例子不可复制，退回'));
      await evaluate(clickInCard(OPTIONAL_TASK_ID, '拒绝'));
      const rejectRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/tasks/${OPTIONAL_TASK_ID}/review`,
        'task reject POST',
      );
      check(
        `${label}: reject posts expectedRevision 4 / rejected / reason`,
        rejectRequest.body?.['expectedRevision'] === 4 &&
          rejectRequest.body?.['decision'] === 'rejected' &&
          rejectRequest.body?.['reason'] === '例子不可复制，退回' &&
          rejectRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(rejectRequest),
      );

      // -------------------------------------------------------- messages ---
      await evaluate(`document.querySelector('[data-team-tab="messages"]').click(); true`);
      await until(`document.getElementById('team-view').textContent.includes('请描述实现步骤')`);
      const messagesText = await evaluate(`document.getElementById('team-view').textContent`);
      check(
        `${label}: messages show stable member ids, not just names`,
        messagesText.includes('主成员（mem_root_000…）') &&
          messagesText.includes('写手（mem_writer_0…）') &&
          messagesText.includes('#1') &&
          messagesText.includes('#2') &&
          messagesText.includes('processed'),
        String(messagesText),
      );
      await evaluate(`(() => {
        const select = document.querySelector('#team-view select[aria-label="收件成员"]');
        if (!select) throw new Error('recipient select missing');
        select.value = ${JSON.stringify(WRITER_ID)};
        const body = document.querySelector('#team-view textarea[aria-label="消息内容"]');
        body.value = '@写手 请把测试证据贴上来';
        body.closest('form').requestSubmit();
        return true;
      })()`);
      const messageRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/runs/${RUN_ID}/messages`,
        'mention message POST',
      );
      const clientMessageId = String(messageRequest.body?.['clientMessageId'] ?? '');
      check(
        `${label}: @ mention sends recipientId/clientMessageId/body with token`,
        messageRequest.body?.['recipientId'] === WRITER_ID &&
          messageRequest.body?.['body'] === '@写手 请把测试证据贴上来' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientMessageId) &&
          messageRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(messageRequest),
      );
      await until(`document.getElementById('team-view').textContent.includes('@写手 请把测试证据贴上来')`);
      await shot(`${label}-messages.png`);

      // --------------------------------------------- approvals and MCP card ---
      await evaluate(`document.querySelector('[data-team-tab="members"]').click(); true`);
      await until(`document.getElementById('team-view').textContent.includes('digest:4f2a9c')`);
      const approvalText = await evaluate(`document.getElementById('team-view').textContent`);
      if (String(approvalText).includes('[object HTMLSpanElement]')) {
        findings.push(
          `${label}: web/team.js renders the MCP/approval card title as [object HTMLSpanElement] because el(tag, className, element) assigns textContent from the element. The action/tool label is therefore not visible; member/generation/resource/reason still render.`,
        );
      }
      check(
        `${label}: approval shows action/member/generation/resource`,
        approvalText.includes('待审批：shell.exec') &&
          approvalText.includes('主成员（mem_root_00000…）· npm test') &&
          approvalText.includes('代次：3') &&
          approvalText.includes('执行：act_root_00000…') &&
          approvalText.includes('风险：high') &&
          approvalText.includes('策略：policy-v7') &&
          approvalText.includes('请求摘要：digest:4f2a9c') &&
          approvalText.includes('成员请求在宿主机执行测试命令'),
        String(approvalText),
      );
      check(
        `${label}: MCP interaction renders title and payload`,
        approvalText.includes('MCP approval：写入仓库标签') &&
          approvalText.includes('issues.update') &&
          approvalText.includes('sha256:mcp-args') &&
          approvalText.includes('写手（mem_writer_000…）'),
        String(approvalText),
      );
      await evaluate(fillCard('digest:4f2a9c', '审批理由', '证据足够，批准'));
      await evaluate(clickInCard('digest:4f2a9c', '批准本次'));
      const approveRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/runs/${RUN_ID}/approvals/${APPROVAL_ID}`,
        'approval approve POST',
      );
      check(
        `${label}: approve posts decision approved and reason with token`,
        approveRequest.body?.['decision'] === 'approved' &&
          approveRequest.body?.['reason'] === '证据足够，批准' &&
          approveRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(approveRequest),
      );
      await until(`!document.getElementById('team-view').textContent.includes('digest:4f2a9c')`);
      await shot(`${label}-approvals.png`);
      await evaluate(clickInCard('digest:7d1e0b', '拒绝'));
      const denyRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/runs/${RUN_ID}/approvals/${SECOND_APPROVAL_ID}`,
        'approval reject POST',
      );
      check(
        `${label}: reject posts decision denied with token`,
        denyRequest.body?.['decision'] === 'denied' &&
          denyRequest.body?.['reason'] === '用户拒绝' &&
          denyRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(denyRequest),
      );
      await until(`!document.getElementById('team-view').textContent.includes('digest:7d1e0b')`);
      await evaluate(clickInCard('issues.update', '接受'));
      const mcpRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/runs/${RUN_ID}/mcp-interactions/${MCP_ID}`,
        'MCP interaction POST',
      );
      check(
        `${label}: MCP accept posts action/response with token`,
        mcpRequest.body?.['action'] === 'accept' &&
          JSON.stringify(mcpRequest.body?.['response']) === '{}' &&
          mcpRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(mcpRequest),
      );

      // ----------------------------------------------------- integrations ---
      await evaluate(`document.querySelector('[data-team-tab="artifacts"]').click(); true`);
      await until(`document.getElementById('team-view').textContent.includes('冲突：src/shared.ts')`);
      const integrationText = await evaluate(`document.getElementById('team-view').textContent`);
      if (String(integrationText).includes('[object HTMLSpanElement]')) {
        findings.push(
          `${label}: web/team.js renders the artifact and integration card titles as [object HTMLSpanElement]; the candidate hashes, file list and conflict path still render.`,
        );
      }
      check(
        `${label}: artifacts tab shows artifact and integration conflict`,
        integrationText.includes('patch · artifact_requi…') &&
          integrationText.includes('集成候选 · int_team_fixtu…') &&
          integrationText.includes('候选哈希：cand_required_0001') &&
          integrationText.includes('modified src/shared.ts sha256:candidate-shared') &&
          integrationText.includes('npm test -- shared ✓') &&
          integrationText.includes('候选：cand_integration_0001') &&
          integrationText.includes('冲突：src/shared.ts') &&
          integrationText.includes('candidate differs from source'),
        String(integrationText),
      );
      await evaluate(`(() => {
        const card = ${cardFor('cand_integration_0001')};
        if (!card) throw new Error('integration card missing');
        const button = Array.from(card.querySelectorAll('button')).find((node) => node.textContent.trim() === '解决冲突');
        if (!button) throw new Error('resolve conflict button missing');
        button.click();
        return true;
      })()`);
      await until(`document.getElementById('team-view').textContent.includes('源文件:')`);
      const conflictText = await evaluate(`document.getElementById('team-view').textContent`);
      check(
        `${label}: conflict card shows source, candidate and the other side`,
        conflictText.includes('源文件:') &&
          conflictText.includes('export const shared = "source";') &&
          conflictText.includes('候选:') &&
          conflictText.includes('export const shared = "candidate";') &&
          conflictText.includes('另一方:') &&
          conflictText.includes('export const shared = "other";'),
        String(conflictText),
      );
      const conflictDetailRequest = requests(
        (entry) => entry.method === 'GET' && entry.path === `/api/teams/integrations/${INTEGRATION_ID}/conflicts`,
      );
      check(`${label}: opening conflicts reads both sides`, conflictDetailRequest.length === 1, JSON.stringify(conflictDetailRequest));
      await shot(`${label}-integration.png`);
      await evaluate(clickInCard('cand_integration_0001', '保留源文件'));
      const resolveRequest = await waitForCapture(
        (entry) =>
          entry.method === 'POST' && entry.path === `/api/teams/integrations/${INTEGRATION_ID}/conflicts`,
        'conflict resolve POST',
      );
      check(
        `${label}: resolve posts path/source with token`,
        resolveRequest.body?.['path'] === 'src/shared.ts' &&
          resolveRequest.body?.['resolution'] === 'source' &&
          resolveRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(resolveRequest),
      );
      await until(`document.getElementById('team-view').textContent.includes('重新验证')`);
      await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('#team-view button')).find((node) => node.textContent.trim() === '重新验证');
        if (!button) throw new Error('verify button missing');
        button.click();
        return true;
      })()`);
      const verifyRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/integrations/${INTEGRATION_ID}/verify`,
        'integration verify POST',
      );
      check(
        `${label}: verify posts an empty JSON body with token`,
        verifyRequest.body !== null &&
          Object.keys(verifyRequest.body).length === 0 &&
          verifyRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(verifyRequest),
      );
      await until(`document.getElementById('team-view').textContent.includes('发布到源目录')`);
      await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('#team-view button')).find((node) => node.textContent.trim() === '发布到源目录');
        if (!button) throw new Error('publish button missing');
        button.click();
        return true;
      })()`);
      const publishRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/integrations/${INTEGRATION_ID}/publish`,
        'integration publish POST',
      );
      check(
        `${label}: publish posts the artifact memberId with token`,
        publishRequest.body?.['memberId'] === WRITER_ID &&
          publishRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(publishRequest),
      );

      // ------------------------------------------------ SSE event/reconnect ---
      await evaluate(`document.querySelector('[data-team-tab="members"]').click(); true`);
      await until(`document.getElementById('team-view').textContent.includes(${JSON.stringify(ROOT_ID)})`);
      const streamsBefore = requests((entry) => entry.path.includes('/events/stream'));
      check(
        `${label}: opening the drawer subscribes from the snapshot cursor`,
        streamsBefore.some((entry) => entry.path === `/api/teams/runs/${RUN_ID}/events/stream?after=8`),
        JSON.stringify(streamsBefore.map((entry) => entry.path)),
      );
      const writesBefore = writes().length;
      const snapshotsBefore = requests(
        (entry) => entry.method === 'GET' && entry.path === `/api/teams/runs/${RUN_ID}`,
      ).length;
      const release = (await (await fetch(`${url}__fixture/release-sse`)).json()) as { sequence: number };
      await until(
        `document.querySelectorAll('#team-view .team-card').length >= 2 && (() => {
          const badge = ${cardFor(ROOT_ID)}?.querySelector('.team-badge');
          return badge?.dataset.status === 'idle';
        })()`,
        8_000,
      );
      await waitForCapture(
        (entry) => entry.path === `/api/teams/runs/${RUN_ID}/events/stream?after=${release.sequence}`,
        'SSE reconnect after the applied sequence',
        8_000,
      );
      const streamsAfter = requests((entry) => entry.path.includes('/events/stream'));
      check(
        `${label}: SSE reconnect resumes after the applied sequence`,
        streamsAfter.some((entry) => entry.path === `/api/teams/runs/${RUN_ID}/events/stream?after=${release.sequence}`),
        JSON.stringify(streamsAfter.map((entry) => entry.path)),
      );
      const snapshotsAfter = requests(
        (entry) => entry.method === 'GET' && entry.path === `/api/teams/runs/${RUN_ID}`,
      ).length;
      check(
        `${label}: SSE event triggers a snapshot refresh, not a new run`,
        snapshotsAfter > snapshotsBefore &&
          requests((entry) => entry.method === 'POST' && entry.path === '/api/teams/runs').length === 1,
        JSON.stringify({ snapshotsBefore, snapshotsAfter }),
      );
      check(
        `${label}: reconnect writes nothing and does not duplicate member cards`,
        writes().length === writesBefore && (await evaluate(`document.querySelectorAll('#team-view .team-card-id').length`)) === 2,
        JSON.stringify({ writesBefore, writesAfter: writes().length }),
      );

      // ----------------------------------------------------------- stop ---
      await evaluate(`document.getElementById('team-stop').click(); true`);
      const stopRequest = await waitForCapture(
        (entry) => entry.method === 'POST' && entry.path === `/api/teams/runs/${RUN_ID}/stop`,
        'stop run POST',
      );
      check(
        `${label}: stop posts the reason with token`,
        stopRequest.body?.['reason'] === '用户停止整队' &&
          stopRequest.headers['x-eunoia-token'] === TOKEN,
        JSON.stringify(stopRequest),
      );
      await until(`document.getElementById('team-start-note').textContent.includes('cancelled')`);
      check(`${label}: stop reaches a cancelled run and hides the stop button`, (await evaluate(`document.getElementById('team-stop').hidden`)) === true);

      // -------------------------------------------------------- keyboard ---
      await evaluate(`document.getElementById('team-close').click(); true`);
      await until(`document.getElementById('team-drawer').hidden === true`);
      await evaluate(`document.getElementById('team-open').focus(); document.getElementById('team-open').click(); true`);
      await until(`document.getElementById('team-drawer').hidden === false`);
      check(
        `${label}: opening focuses the close control`,
        (await evaluate(`document.activeElement?.id`)) === 'team-close',
        String(await evaluate(`document.activeElement?.id`)),
      );
      await key('Escape', 27);
      await until(`document.getElementById('team-drawer').hidden === true`);
      check(
        `${label}: Escape closes and restores focus to the opener`,
        (await evaluate(`document.activeElement?.id`)) === 'team-open' &&
          (await evaluate(`document.getElementById('team-open').getAttribute('aria-pressed')`)) === 'false',
        String(await evaluate(`document.activeElement?.id`)),
      );

      // ---------------------------------------------------------- layout ---
      await evaluate(`document.getElementById('team-open').click(); true`);
      await until(`document.getElementById('team-drawer').hidden === false`);
      await sleep(500);
      const layout = await evaluate(`(() => {
        const drawer = document.getElementById('team-drawer').getBoundingClientRect();
        const panel = document.getElementById('team-view');
        return {
          viewport: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          drawerWidth: Math.round(drawer.width),
          drawerLeft: Math.round(drawer.left),
          drawerRight: Math.round(drawer.right),
          drawerHeight: Math.round(drawer.height),
          drawerInside: drawer.left >= -1 && drawer.right <= window.innerWidth + 1,
          panelScrollWidth: panel.scrollWidth,
          panelClientWidth: panel.clientWidth,
          noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          controls: ['team-pause', 'team-resume', 'team-stop'].map((id) => {
            const node = document.getElementById(id);
            return { id, hidden: node.hidden, display: getComputedStyle(node).display };
          }),
        };
      })()`);
      check(
        `${label}: no horizontal overflow at ${width}px`,
        layout.noHorizontalOverflow && layout.bodyScrollWidth <= width + 1,
        JSON.stringify(layout),
      );
      check(
        `${label}: open drawer fits the viewport`,
        layout.drawerInside && layout.drawerWidth <= width + 1 && layout.drawerHeight <= (width === 390 ? 844 : 900) + 1,
        JSON.stringify(layout),
      );
      check(
        `${label}: panel content does not scroll sideways`,
        layout.panelScrollWidth <= layout.panelClientWidth + 1,
        JSON.stringify(layout),
      );
      check(
        `${label}: drawer width follows the breakpoint`,
        width === 390 ? layout.drawerWidth === 390 : layout.drawerWidth === 480,
        JSON.stringify(layout),
      );
      const hiddenButShown = (layout.controls as Array<{ id: string; hidden: boolean; display: string }>).filter(
        (entry) => entry.hidden && entry.display !== 'none',
      );
      if (hiddenButShown.length > 0) {
        findings.push(
          `${label}: the terminal run still shows inactive controls because .soft-button{display:inline-flex} overrides [hidden]: ${hiddenButShown.map((entry) => entry.id).join(', ')} (hidden=true, computed display=${hiddenButShown[0]?.display}). The drawer's own [hidden] fix exists, but the run-control buttons do not have one.`,
        );
      }
      await shot(`${label}-panel.png`);

      const teamWrites = requests((entry) => entry.method !== 'GET' && entry.path.startsWith('/api/teams'));
      check(
        `${label}: every Team write carries the token and JSON content type`,
        teamWrites.length >= 10 &&
          teamWrites.every((entry) => entry.headers['x-eunoia-token'] === TOKEN) &&
          teamWrites.every((entry) => String(entry.headers['content-type'] ?? '').includes('application/json')),
        JSON.stringify(teamWrites.map((entry) => `${entry.method} ${entry.path}`)),
      );
      check(
        `${label}: config/start always use the stored conversation`,
        requests((entry) => entry.method === 'POST' && entry.path === '/api/teams/config').every(
          (entry) => entry.body?.['conversationId'] === CONVERSATION,
        ) && requests((entry) => entry.method === 'POST' && entry.path === '/api/teams/runs').every(
          (entry) => entry.body?.['conversationId'] === CONVERSATION,
        ),
      );

      scenarios.push({ label, requests: [...captured] });
    }

    await scenario(1280, '1280');
    await scenario(390, '390');

    await writeLog();
    const passed = checks.filter((entry) => entry.pass).length;
    process.stdout.write(
      `team browser check: ${passed}/${checks.length} assertions passed\n` +
        `  evidence: ${EVIDENCE}/team-browser-check.json\n` +
        `  screenshots: ${EVIDENCE}/{1280,390}-{members,tasks,messages,approvals,integration,panel}.png\n`,
    );
    cdp.close();
    clearTimeout(guard);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (captured.length > 0) scenarios.push({ label: 'failure', requests: [...captured] });
    await writeLog(message).catch(() => undefined);
    throw error;
  } finally {
    for (const stream of sseStreams) {
      try {
        stream.end();
      } catch {
        // Already closed.
      }
    }
    sseStreams.clear();
    chrome.kill('SIGTERM');
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
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `team browser check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
