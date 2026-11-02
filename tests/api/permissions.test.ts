/**
 * The local permission control surface, over a real socket.
 *
 * The sandbox is faked — this file is about the transport contract: who may
 * call, what a bad body returns, and whether the route passes the right scope
 * and operator down to the gateway. Mode semantics and auto-review are covered
 * by `tests/sandbox/permission-*.test.ts`; duplicating them here with a stub
 * would only test the stub.
 */

/*
 * Parsed JSON is untyped by nature and these tests read arbitrary fields to pin
 * the response shape. The `any`s below are the boundary, not a shortcut past it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import { PERMISSION_MODE_DEFAULT_KEY } from '../../src/api/permissions.ts';
import type { SandboxPlatform } from '../../src/sandbox/index.ts';
import type { TurnRunner } from '../../src/service/chat.ts';
import type {
  HumanApprovalRecord,
  PermissionMode,
  PermissionPolicyRecord,
} from '../../src/sandbox/permissions/types.ts';

const TOKEN = 'test-local-token';

const MODES: readonly PermissionMode[] = ['read-only', 'auto', 'on-request', 'restricted'];

let store: InMemoryStore;
let server: Server;
let base: string;
let sandbox: FakeSandbox;

/**
 * A sandbox platform with just the methods the routes call.
 *
 * `as unknown as SandboxPlatform` keeps the fake from having to reproduce the
 * container controller, the runtime and the recovery manager: the value is
 * never used as one.
 */
interface FakeCalls {
  modeChanges: {
    scopeType: string;
    scopeId: string;
    mode?: PermissionMode;
    ttlMs?: number;
    actor: string;
  }[];
  approvals: {
    approvalRequestId: string;
    decidedBy: string;
    scope?: string;
    ttlSeconds?: number;
    reason?: string;
  }[];
  denials: { approvalRequestId: string; decidedBy: string; reason?: string }[];
}

interface FakeSandbox {
  platform: SandboxPlatform;
  readonly calls: FakeCalls;
  readonly approvals: Map<string, HumanApprovalRecord>;
  /** Requests the fake status reports; tests push their own. */
  readonly requests: Record<string, unknown>[];
  mode: PermissionMode;
  allowedModes: readonly PermissionMode[];
  statusThrows: boolean;
}

function fakeSandbox(options: { mode?: PermissionMode } = {}): FakeSandbox {
  const calls: FakeCalls = { modeChanges: [], approvals: [], denials: [] };
  const approvals = new Map<string, HumanApprovalRecord>();
  const requests: Record<string, unknown>[] = [];
  const state: FakeSandbox = {
    platform: null as unknown as SandboxPlatform,
    calls,
    approvals,
    requests,
    mode: options.mode ?? 'auto',
    allowedModes: MODES,
    statusThrows: true,
  };

  const settings = {
    allowWrites: true,
    allowCommands: true,
    network: { mode: 'none' },
    permission: {
      mode: state.mode,
      allowedModes: state.allowedModes,
      operatorId: 'operator',
      autoReview: { enabled: true, allowedRiskLevels: ['low', 'medium'], maxTtlMs: 600_000 },
      approval: { allowed: true, requireHumanForRiskLevels: ['high', 'critical'], maxTtlMs: 900_000 },
      restricted: {
        allowedTools: ['read_file', 'list_dir'],
        filesystem: { read: ['/workspace'], write: [] },
        network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
      },
    },
  };

  const policy = (mode: PermissionMode): PermissionPolicyRecord =>
    ({
      policyId: 'policy_task_1',
      scopeType: 'task',
      scopeId: 'task-1',
      version: 2,
      mode,
      rules: [],
      autoReview: settings.permission.autoReview,
      approval: settings.permission.approval,
      restricted: settings.permission.restricted,
      expiresAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }) as PermissionPolicyRecord;

  const gateway = {
    async permissionStatus() {
      if (state.statusThrows) {
        const error = Object.assign(new Error('task does not exist'), {
          name: 'SandboxNotFoundError',
          code: 'not_found',
        });
        throw error;
      }
      return {
        mode: state.mode,
        permission_policy_version: 'ppv1:test.s0.t1.b0',
        scopes: [],
        auto_review: settings.permission.autoReview,
        approval: settings.permission.approval,
        restricted: settings.permission.restricted,
        requests: state.requests,
        approvals: [...approvals.values()],
        grants: [],
      };
    },
    async effectivePermissionPolicy() {
      return {
        mode: state.mode,
        version: 'ppv1:test.s0.t0.b0',
        permissionVersion: 1,
        rules: [],
        autoReview: settings.permission.autoReview,
        approval: settings.permission.approval,
        restricted: settings.permission.restricted,
        sandboxPolicy: {},
        scopes: [],
      };
    },
    async setPermissionPolicy(input: {
      scopeType: string;
      scopeId: string;
      mode?: PermissionMode;
      ttlMs?: number;
      actor: string;
    }) {
      calls.modeChanges.push(input);
      if (input.mode) state.mode = input.mode;
      return policy(input.mode ?? state.mode);
    },
    async getPermissionApproval(id: string) {
      return approvals.get(id) ?? null;
    },
    async approvePermissionRequest(
      _context: unknown,
      input: { approvalRequestId: string; decidedBy: string; scope?: string; ttlSeconds?: number },
    ) {
      calls.approvals.push(input);
      const record = approvals.get(input.approvalRequestId);
      if (!record) throw new Error('approval not found');
      return {
        approval: { ...record, status: 'APPROVED', decidedBy: input.decidedBy },
        grantId: 'grant-1',
      };
    },
    async denyPermissionRequest(
      _context: unknown,
      input: { approvalRequestId: string; decidedBy: string; reason?: string },
    ) {
      calls.denials.push(input);
      const record = approvals.get(input.approvalRequestId);
      if (!record) throw new Error('approval not found');
      return { ...record, status: 'DENIED', decidedBy: input.decidedBy };
    },
  };

  state.platform = {
    settings,
    gateway,
  } as unknown as SandboxPlatform;
  return state;
}

async function start(options: { mode?: PermissionMode; runner?: TurnRunner } = {}): Promise<void> {
  store = new InMemoryStore();
  sandbox = fakeSandbox(options);
  server = createApp({
    store,
    sandbox: sandbox.platform,
    localToken: TOKEN,
    ...(options.runner ? { runner: options.runner } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
});

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, any>;
  readonly text: string;
}

async function api(
  path: string,
  init: RequestInit & { cookie?: string; token?: string } = {},
): Promise<ApiResponse> {
  const { cookie, token, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { 'X-Eunoia-Token': token } : {}),
    },
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { status: response.status, body, text };
}

/** An identity that persists across requests, the way a browser's cookie does. */
async function newIdentity(): Promise<string> {
  const response = await fetch(`${base}/api/conversations`);
  const cookie = response.headers.get('set-cookie');
  expect(cookie, 'the server should mint an identity on first contact').toBeTruthy();
  return (cookie as string).split(';')[0] as string;
}

async function newConversation(cookie: string): Promise<string> {
  const response = await api('/api/conversations', {
    method: 'POST',
    cookie,
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id as string;
}

/** A runner that answers with fixed text and never touches the network. */
function stubRunner(): TurnRunner {
  return async function* () {
    yield { type: 'text_delta', text: '好。' };
    yield { type: 'completed', text: '好。' };
  };
}

/** The `completed` frame's payload, which is where a new conversation id lands. */
function completedFrame(sse: string): Record<string, any> | null {
  for (const frame of sse.split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('');
    if (!data) continue;
    try {
      const event = JSON.parse(data);
      if (event.type === 'completed') return event;
    } catch {
      // A partial frame is not interesting here.
    }
  }
  return null;
}

function approvalRecord(overrides: Partial<HumanApprovalRecord> = {}): HumanApprovalRecord {
  return {
    approvalRequestId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    taskId: '33333333-3333-4333-8333-333333333333',
    sessionId: '33333333-3333-4333-8333-333333333333',
    sandboxId: null,
    scope: 'once',
    status: 'PENDING',
    requestedBy: 'agent:task',
    decidedBy: null,
    decisionReason: null,
    expiresAt: '2026-11-01T01:00:00.000Z',
    decidedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/permissions', () => {
  it('reports the deployment default before a conversation exists', async () => {
    const cookie = await newIdentity();
    const response = await api('/api/permissions', { cookie });
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe('auto');
    expect(response.body.allowed_modes).toEqual([...MODES]);
    expect(response.body.modes).toHaveLength(4);
    expect(response.body.modes.map((mode: any) => mode.id)).toEqual([...MODES]);
    expect(response.body.pending).toEqual([]);
    expect(response.body.default_mode).toBeNull();
  });

  it('answers for a conversation that has no task row yet', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api(`/api/permissions?conversationId=${conversationId}`, { cookie });
    expect(response.status).toBe(200);
    // The gateway threw not_found, and the route resolved the same policy
    // without the task row instead of turning a new conversation into a 500.
    expect(response.body.mode).toBe('auto');
    expect(response.body.permission_policy_version).toBe('ppv1:test.s0.t0.b0');
  });

  it('404s an unknown conversation rather than inventing a mode', async () => {
    const cookie = await newIdentity();
    const response = await api(
      '/api/permissions?conversationId=44444444-4444-4444-8444-444444444444',
      { cookie },
    );
    expect(response.status).toBe(404);
  });

  it('rejects a malformed conversation id', async () => {
    const cookie = await newIdentity();
    const response = await api('/api/permissions?conversationId=not-a-uuid', { cookie });
    expect(response.status).toBe(400);
  });

  it('lists pending approvals with the action and reason to decide on', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    sandbox.statusThrows = false;
    sandbox.requests.push({
      requestId: '22222222-2222-4222-8222-222222222222',
      approvalRequestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'write_file',
      action: 'fs.write',
      resourceIdentifier: '/workspace/src/a.ts',
      riskLevel: 'high',
      reason: 'workspace writes are disabled for this deployment',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    sandbox.approvals.set(
      '11111111-1111-4111-8111-111111111111',
      approvalRecord({ taskId: conversationId, sessionId: conversationId }),
    );

    const response = await api(`/api/permissions?conversationId=${conversationId}`, { cookie });
    expect(response.status).toBe(200);
    expect(response.body.pending).toHaveLength(1);
    expect(response.body.pending[0]).toMatchObject({
      approvalRequestId: '11111111-1111-4111-8111-111111111111',
      tool: 'write_file',
      action: 'fs.write',
      resource: '/workspace/src/a.ts',
      risk_level: 'high',
    });
  });
});

describe('POST /api/permissions/mode', () => {
  it('refuses a call without the local token', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode: 'read-only' }),
    });
    expect(response.status).toBe(403);
    expect(sandbox.calls.modeChanges).toHaveLength(0);
  });

  it('refuses a non-JSON body', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ conversationId, mode: 'read-only' }),
    });
    expect(response.status).toBe(415);
  });

  it('writes a task-scoped policy as the operator', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode: 'restricted', minutes: 30 }),
    });
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe('restricted');
    expect(sandbox.calls.modeChanges).toEqual([
      {
        scopeType: 'task',
        scopeId: conversationId,
        mode: 'restricted',
        ttlMs: 30 * 60_000,
        actor: 'operator',
      },
    ]);
  });

  it('refuses a mode the deployment did not allow', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    // Narrow the same object the route reads; the fake has no other state.
    (
      sandbox.platform.settings.permission as { allowedModes: readonly PermissionMode[] }
    ).allowedModes = ['read-only', 'on-request'];

    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode: 'auto' }),
    });
    expect(response.status).toBe(403);
    expect(sandbox.calls.modeChanges).toHaveLength(0);
  });

  it('404s an unknown conversation', async () => {
    const cookie = await newIdentity();
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: '55555555-5555-4555-8555-555555555555',
        mode: 'read-only',
      }),
    });
    expect(response.status).toBe(404);
  });

  it('remembers the mode for new conversations when asked', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode: 'on-request', remember: true }),
    });
    expect(response.status).toBe(200);

    const preferences = await api('/api/preferences', { cookie });
    expect(preferences.body.preferences[PERMISSION_MODE_DEFAULT_KEY]).toBe('on-request');

    const next = await newConversation(cookie);
    const applied = sandbox.calls.modeChanges.find((call) => call.scopeId === next);
    expect(applied?.mode).toBe('on-request');
  });

  it('rejects a bad minutes value', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    const response = await api('/api/permissions/mode', {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode: 'read-only', minutes: 0 }),
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/permissions/approvals/:id/(approve|deny)', () => {
  const approvalId = '11111111-1111-4111-8111-111111111111';

  it('refuses a call without the local token', async () => {
    const cookie = await newIdentity();
    const response = await api(`/api/permissions/approvals/${approvalId}/approve`, {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(sandbox.calls.approvals).toHaveLength(0);
  });

  it('404s an approval nobody knows', async () => {
    const cookie = await newIdentity();
    const response = await api(`/api/permissions/approvals/${approvalId}/approve`, {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });

  it('404s an approval that belongs to somebody else', async () => {
    const owner = await newIdentity();
    const conversationId = await newConversation(owner);
    sandbox.approvals.set(
      approvalId,
      approvalRecord({ taskId: conversationId, sessionId: conversationId }),
    );

    const stranger = await newIdentity();
    const response = await api(`/api/permissions/approvals/${approvalId}/approve`, {
      method: 'POST',
      cookie: stranger,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    expect(sandbox.calls.approvals).toHaveLength(0);
  });

  it('approves once as the operator and returns the grant', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    sandbox.approvals.set(
      approvalId,
      approvalRecord({ taskId: conversationId, sessionId: conversationId }),
    );

    const response = await api(`/api/permissions/approvals/${approvalId}/approve`, {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'once', ttlSeconds: 60 }),
    });
    expect(response.status).toBe(200);
    expect(response.body.grantId).toBe('grant-1');
    expect(sandbox.calls.approvals).toEqual([
      { approvalRequestId: approvalId, decidedBy: 'operator', scope: 'once', ttlSeconds: 60 },
    ]);
  });

  it('denies without creating a grant', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    sandbox.approvals.set(
      approvalId,
      approvalRecord({ taskId: conversationId, sessionId: conversationId }),
    );

    const response = await api(`/api/permissions/approvals/${approvalId}/deny`, {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '不在范围内' }),
    });
    expect(response.status).toBe(200);
    expect(response.body.grantId).toBeNull();
    expect(sandbox.calls.denials).toEqual([
      { approvalRequestId: approvalId, decidedBy: 'operator', reason: '不在范围内' },
    ]);
  });

  it('rejects an unknown scope', async () => {
    const cookie = await newIdentity();
    const conversationId = await newConversation(cookie);
    sandbox.approvals.set(
      approvalId,
      approvalRecord({ taskId: conversationId, sessionId: conversationId }),
    );

    const response = await api(`/api/permissions/approvals/${approvalId}/approve`, {
      method: 'POST',
      cookie,
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'forever' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('a chat that creates its conversation', () => {
  it('applies the remembered mode before the first tool call', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start({ runner: stubRunner() });

    const cookie = await newIdentity();
    const preferences = await api('/api/preferences', {
      method: 'PUT',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PERMISSION_MODE_DEFAULT_KEY]: 'read-only' }),
    });
    expect(preferences.status).toBe(200);

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ message: '看看这个文件' }),
    });
    const completed = completedFrame(await response.text());
    const conversationId = completed?.conversationId as string | undefined;
    expect(conversationId).toBeTruthy();

    expect(sandbox.calls.modeChanges).toEqual([
      { scopeType: 'task', scopeId: conversationId, mode: 'read-only', actor: 'operator' },
    ]);
  });
});

describe('the page', () => {
  it('carries the token the client must echo', async () => {
    const response = await api('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain(`content="${TOKEN}"`);
    expect(response.text).toContain('name="eunoia-token"');
  });
});
