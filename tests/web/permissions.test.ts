/**
 * The permission control in the page.
 *
 * Driven through the real module against the same shim as `client.test.ts`: the
 * subject is the contract between the server's payload and what a person can
 * press, not the CSS. What it proves is that the labels come from the payload,
 * that a mutation carries the local token and the conversation id, and that an
 * approval card turns into a "continue" affordance rather than silently
 * retrying.
 */

import { describe, expect, it } from 'vitest';

import { boot, El, type Frame, type Route } from './harness.ts';

const TOKEN = 'ui-test-token';

const MODES = [
  { id: 'read-only', label: '只读', description: '写文件会被拒绝，工作区以只读方式挂载。' },
  { id: 'auto', label: '自动', description: '工作区内的写入和命令直接执行。' },
  { id: 'on-request', label: '逐次确认', description: '需要扩展时停下来等人批准。' },
  { id: 'restricted', label: '白名单', description: '只有白名单里的工具和路径可用。' },
];

const PERMISSIONS: Record<string, unknown> = {
  enabled: true,
  mode: 'auto',
  permission_policy_version: 'ppv1:test.s0.t0.b0',
  allowed_modes: MODES.map((mode) => mode.id),
  modes: MODES,
  default_mode: null,
  deployment: { mode: 'auto' },
  auto_review: { enabled: true, allowedRiskLevels: ['low', 'medium'] },
  approval: { requireHumanForRiskLevels: ['high', 'critical'] },
  sandbox: { writes: true, commands: true },
  pending: [],
};

/** Clicks an element the way the client wired it. */
function click(node: El | undefined): void {
  expect(node, 'expected an element to click').toBeTruthy();
  // The shim types `onclick` as a zero-argument handler; the pill's real
  // handler needs the event to stop the document-level close.
  const handler = node?.onclick as ((event: unknown) => void) | null | undefined;
  handler?.({ preventDefault() {}, stopPropagation() {} });
}

function byText(nodes: El[], className: string, text: string): El | undefined {
  return nodes.find((node) => node.querySelector(`.${className}`)?.textContent === text);
}

const APPROVAL_TURN: Frame[] = [
  {
    type: 'tool_call',
    callId: 't1',
    name: 'write',
    displayable: true,
    summary: '写入 src/a.ts',
  },
  {
    type: 'tool_result',
    callId: 't1',
    name: 'write',
    ok: false,
    error: 'workspace writes are disabled for this deployment (approval appr-1)',
    approval: { requestId: 'req-1', approvalRequestId: 'appr-1' },
  },
  { type: 'text_delta', text: '需要你批准，我才能继续。' },
  { type: 'completed', text: '需要你批准，我才能继续。' },
];

const APPROVE_ROUTE: Route = { json: { ok: true, approval: {}, grantId: 'grant-1' } };

describe('the permission pill', () => {
  it('stays hidden when the page was opened without a token', async () => {
    const harness = await boot({ routes: { 'GET /api/permissions': { json: PERMISSIONS } } });
    expect(harness.element('perm-pill').hidden).toBe(true);
    expect(harness.requests.some((request) => request.url.startsWith('/api/permissions'))).toBe(
      false,
    );
  });

  it('shows the deployment mode before a conversation exists', async () => {
    const harness = await boot({
      token: TOKEN,
      routes: { 'GET /api/permissions': { json: PERMISSIONS } },
    });
    expect(harness.element('perm-pill').hidden).toBe(false);
    expect(harness.element('perm-label').textContent).toBe('自动');
    expect(harness.requests.some((request) => request.url === '/api/permissions')).toBe(true);
  });

  it('lists the modes the server sent, marked with the current one', async () => {
    const harness = await boot({
      token: TOKEN,
      routes: { 'GET /api/permissions': { json: PERMISSIONS } },
    });
    click(harness.element('perm-pill'));

    const menu = harness.element('perm-menu');
    const options = menu.querySelectorAll('.perm-option');
    expect(options.map((node) => node.querySelector('.name')?.textContent)).toEqual(
      MODES.map((mode) => mode.label),
    );
    const current = options.find((node) => node.attributes['aria-current'] === 'true');
    expect(current?.querySelector('.name')?.textContent).toBe('自动');
    expect(menu.textContent).toContain('只读');
  });

  it('shows the pending count and the queued request in the menu', async () => {
    const harness = await boot({
      token: TOKEN,
      routes: {
        'GET /api/permissions': {
          json: {
            ...PERMISSIONS,
            pending: [
              {
                approvalRequestId: 'appr-1',
                tool: 'write',
                action: 'fs.write',
                resource: '/workspace/src/a.ts',
                risk_level: 'high',
                reason: 'workspace writes are disabled',
              },
            ],
          },
        },
      },
    });

    expect(harness.element('perm-count').textContent).toBe('1');
    click(harness.element('perm-pill'));
    const menu = harness.element('perm-menu');
    expect(menu.querySelectorAll('.perm-pending-item')).toHaveLength(1);
    expect(
      menu.querySelectorAll('.perm-pending-item')[0]?.querySelector('.perm-pending-title')
        ?.textContent ?? '',
    ).toContain('write');
  });
});

describe('changing the mode', () => {
  it('posts the conversation id, the mode and the local token', async () => {
    const harness = await boot({
      token: TOKEN,
      stored: '11111111-1111-4111-8111-111111111111',
      routes: {
        'GET /api/permissions?conversationId=11111111-1111-4111-8111-111111111111': {
          json: PERMISSIONS,
        },
        'POST /api/permissions/mode': { json: { ok: true, mode: 'read-only' } },
      },
    });
    click(harness.element('perm-pill'));
    const option = byText(
      harness.element('perm-menu').querySelectorAll('.perm-option'),
      'name',
      '只读',
    );
    click(option);
    await harness.settle();

    const posted = harness.requests.find((request) => request.url === '/api/permissions/mode');
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toEqual({
      conversationId: '11111111-1111-4111-8111-111111111111',
      mode: 'read-only',
      remember: false,
    });
    expect(posted?.headers['X-Eunoia-Token']).toBe(TOKEN);
  });

  it('says so instead of posting when there is no conversation yet', async () => {
    const harness = await boot({
      token: TOKEN,
      routes: { 'GET /api/permissions': { json: PERMISSIONS } },
    });
    click(harness.element('perm-pill'));
    const option = byText(
      harness.element('perm-menu').querySelectorAll('.perm-option'),
      'name',
      '只读',
    );
    click(option);
    await harness.settle();

    expect(harness.requests.some((request) => request.url === '/api/permissions/mode')).toBe(
      false,
    );
    expect(harness.transcript.querySelector('.notice')?.textContent ?? '').toContain(
      '先发一句话',
    );
  });
});

describe('an approval card', () => {
  async function approvalHarness(): Promise<Awaited<ReturnType<typeof boot>>> {
    return boot({
      token: TOKEN,
      frames: APPROVAL_TURN,
      routes: {
        'GET /api/permissions': { json: PERMISSIONS },
        'POST /api/permissions/approvals/appr-1/approve': APPROVE_ROUTE,
      },
    });
  }

  it('appears under the stopped tool call', async () => {
    const harness = await approvalHarness();
    await harness.send('改一下 a.ts');

    const card = harness.transcript.querySelector('.approval');
    expect(card?.dataset.state).toBe('pending');
    expect(card?.querySelector('.approval-head')?.textContent ?? '').toContain('write');
  });

  it('approves once with the token, then offers to continue instead of retrying', async () => {
    const harness = await approvalHarness();
    await harness.send('改一下 a.ts');

    const card = harness.transcript.querySelector('.approval');
    const buttons = card?.querySelectorAll('button') ?? [];
    expect(buttons.map((button) => button.textContent)).toEqual([
      '批准一次',
      '批准 30 分钟',
      '拒绝',
    ]);
    click(buttons[0]);
    await harness.settle();

    const posted = harness.requests.find(
      (request) => request.url === '/api/permissions/approvals/appr-1/approve',
    );
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toEqual({ scope: 'once', ttlSeconds: 60 });
    expect(posted?.headers['X-Eunoia-Token']).toBe(TOKEN);

    expect(card?.dataset.state).toBe('approved');
    const after = card?.querySelectorAll('button') ?? [];
    expect(after.map((button) => button.textContent)).toEqual(['让 ta 继续']);

    // The call is not replayed behind the person's back: approving added no
    // chat request beyond the turn that produced the card.
    expect(harness.requests.filter((request) => request.url === '/api/chat')).toHaveLength(1);
  });

  it('sends a short message when the person presses continue', async () => {
    const harness = await approvalHarness();
    await harness.send('改一下 a.ts');
    click(harness.transcript.querySelector('.approval')?.querySelectorAll('button')[0]);
    await harness.settle();
    click(harness.transcript.querySelector('.approval')?.querySelectorAll('button')[0]);
    await harness.settle();

    const chat = harness.requests.filter((request) => request.url === '/api/chat');
    expect(chat).toHaveLength(2);
    expect(chat[1]?.body?.message).toContain('已经批准了');
  });
});
