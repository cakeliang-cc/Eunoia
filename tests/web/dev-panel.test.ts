/**
 * The developer panel: jobs, previews, sources and scoped undo.
 *
 * This drives the real `web/dev-panel.js` and the real `web/app.js` against the
 * shared DOM shim. The browser script is the layout/focus evidence; this is the
 * regression guard for the contracts that are easy to break silently:
 *
 *   - a stop request goes to the job's own route with the local token;
 *   - a log read sends the cursor it just showed, not a fresh zero;
 *   - a failed or expired preview never renders a link to a dead address;
 *   - source cards have a real title/URL and say "费用未知" when cost is absent;
 *   - undo sends exactly the selected paths, never the whole changeset;
 *   - Escape closes the panel and returns focus to its opener.
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { boot, type El, type Harness, type Route } from './harness.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { runAgentLoop } from '../../src/agent/loop.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { LoopOutputItem, ModelTurn } from '../../src/agent/model-port.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY, defineTool, toolOk } from '../../src/tools/types.ts';

const CONV = '11111111-1111-4111-8111-111111111111';
const CHANGESET_ID = 'wcs_11111111-1111-4111-8111-111111111111';
const CHANGES = `/api/conversations/${CONV}/changes`;
const TOKEN = 'dev-panel-token';

const JOB_RUNNING = {
  id: 'job_1',
  userId: 'owner-user-123456',
  conversationId: CONV,
  turnId: 'turn-1',
  memberId: 'member-abc-9876',
  taskId: CONV,
  toolCallId: 'call-1',
  command: 'npm run dev',
  cwd: '.',
  marker: 'marker-1',
  pid: 41,
  status: 'running',
  exitCode: null,
  stdoutPath: '/tmp/eunoia-jobs/job_1/out',
  stderrPath: '/tmp/eunoia-jobs/job_1/err',
  stdinFifo: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  expiresAt: null,
  error: null,
};

const JOB_EXITED = {
  ...JOB_RUNNING,
  id: 'job_2',
  memberId: null,
  command: 'npm test',
  status: 'exited',
  exitCode: 2,
  endedAt: '2026-01-01T00:02:00.000Z',
};

const CHANGESET_SUMMARY = {
  id: CHANGESET_ID,
  userId: 'u1',
  conversationId: CONV,
  turnId: 'turn-1',
  workspaceId: 'w1',
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

const CHANGESET = {
  ...CHANGESET_SUMMARY,
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

function previewsRoute(leases: unknown[]): Route {
  return { json: { previews: leases, available: true } };
}

async function openPanel(routes: Record<string, Route>, frames?: Record<string, unknown>[]): Promise<Harness> {
  const harness = await boot({
    stored: CONV,
    token: TOKEN,
    routes,
    extraScripts: ['dev-panel.js'],
    ...(frames ? { frames } : {}),
  });
  click(harness.element('dev-open'));
  await harness.settle();
  return harness;
}

function click(node: El | undefined): void {
  if (!node) throw new Error('tried to click a missing node');
  if (node.onclick) node.onclick();
  else node.listeners.click?.[0]?.({ preventDefault() {} });
}

function all(node: El, className: string): El[] {
  return node.find((child) => child.classList.contains(className));
}

function byText(nodes: El[], text: string): El | undefined {
  return nodes.find((node) => node.textContent.includes(text));
}

function activeElement(): unknown {
  return (
    globalThis as unknown as { document?: { activeElement?: unknown } }
  ).document?.activeElement;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe('jobs', () => {
  it('lists owner, member, status, exit code and cursor; reads logs and stops one job', async () => {
    const harness = await openPanel({
      [`GET /api/processes?conversationId=${CONV}`]: {
        json: { jobs: [JOB_RUNNING, JOB_EXITED], available: true },
      },
      [`GET /api/processes/job_1/logs?conversationId=${CONV}&cursor=0`]: {
        json: {
          job: JOB_RUNNING,
          text: 'ready on 3000\n',
          stderrText: 'warn: slow\n',
          nextCursor: 14,
          stdoutBytes: 14,
          stderrBytes: 11,
          gap: false,
        },
      },
      'POST /api/processes/job_1/stop': { json: { job: JOB_RUNNING } },
    });

    expect(harness.element('dev-drawer').hidden).toBe(false);
    expect(harness.element('dev-open').getAttribute('aria-pressed')).toBe('true');

    const rows = all(harness.element('dev-jobs-list'), 'dev-job');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('npm run dev');
    expect(rows[0]?.textContent).toContain('运行中');
    expect(rows[0]?.textContent).toContain('归属：owner-us…');
    expect(rows[0]?.textContent).toContain('成员：member-a…');
    expect(rows[0]?.textContent).toContain('日志游标：0');
    expect(rows[1]?.textContent).toContain('退出码：2');
    expect(rows[1]?.textContent).toContain('已退出');

    const readButtons = all(harness.element('dev-jobs-list'), 'dev-button');
    const read = byText(readButtons, '读日志');
    expect(read?.getAttribute('aria-label')).toBe('读取作业 job_1 的日志');
    click(read);
    await waitFor(
      () => all(harness.element('dev-jobs-list'), 'dev-log').length > 0,
      'the job log never rendered',
    );

    expect(harness.element('dev-jobs-list').textContent).toContain('ready on 3000');
    expect(harness.element('dev-jobs-list').textContent).toContain('warn: slow');
    expect(harness.element('dev-jobs-list').textContent).toContain('日志游标：14');
    const logRequest = harness.requests.find((request) => request.url.includes('/logs'));
    expect(logRequest?.url).toBe(`/api/processes/job_1/logs?conversationId=${CONV}&cursor=0`);

    const stop = all(harness.element('dev-jobs-list'), 'dev-button').find(
      (button) => button.getAttribute('aria-label') === '停止作业 job_1',
    );
    expect(stop?.disabled).toBe(false);
    click(stop);
    await harness.settle();
    const stopped = harness.requests.find(
      (request) => request.method === 'POST' && request.url === '/api/processes/job_1/stop',
    );
    expect(stopped?.body).toEqual({ conversationId: CONV });
    expect(stopped?.headers['x-eunoia-token']).toBe(TOKEN);
  });

  it('shows the reason instead of rows when jobs are unavailable', async () => {
    const harness = await openPanel({
      [`GET /api/processes?conversationId=${CONV}`]: {
        json: { jobs: [], available: false, reason: '没有启用沙箱' },
      },
    });

    expect(harness.element('dev-jobs-note').textContent).toBe('没有启用沙箱');
    expect(harness.element('dev-jobs-list').textContent).toContain('还没有作业');
  });
});

describe('previews', () => {
  const READY = {
    id: 'pv_ready',
    routeId: 'route-ready',
    jobId: 'job_1',
    userId: 'u1',
    conversationId: CONV,
    memberId: null,
    runId: null,
    taskId: CONV,
    sandboxId: 'sb',
    workspaceId: 'w',
    containerPort: 3000,
    status: 'ready',
    generation: 1,
    userUrl: 'http://pv-ready.eunoia.test/',
    browserUrl: 'http://pv-ready.eunoia.test/browser',
    createdAt: '2026-01-01T00:00:00.000Z',
    readyAt: '2026-01-01T00:00:03.000Z',
    expiresAt: '2026-01-01T00:30:00.000Z',
    lastOpenedAt: null,
    error: null,
  };
  const FAILED = {
    ...READY,
    id: 'pv_failed',
    routeId: 'route-failed',
    status: 'failed',
    userUrl: 'http://pv-failed.eunoia.test/',
    error: '端口没有响应',
  };
  const EXPIRED = {
    ...READY,
    id: 'pv_expired',
    routeId: 'route-expired',
    status: 'expired',
    userUrl: 'http://pv-expired.eunoia.test/',
  };

  it('links only a ready lease and starts a preview with the chosen fields', async () => {
    const harness = await openPanel({
      [`GET /api/previews?conversationId=${CONV}`]: previewsRoute([READY, FAILED, EXPIRED]),
      'POST /api/previews': {
        status: 201,
        json: { preview: READY, job: JOB_RUNNING, ready: true, detail: 'HTTP 200', internalUrl: 'http://127.0.0.1:3000/' },
      },
      [`GET /api/processes/job_1/logs?conversationId=${CONV}&cursor=0`]: {
        json: {
          job: JOB_RUNNING,
          text: 'listening on 3000\n',
          stderrText: '',
          nextCursor: 18,
          stdoutBytes: 18,
          stderrBytes: 0,
          gap: false,
        },
      },
      'POST /api/previews/pv_ready/stop': { json: { preview: { ...READY, status: 'stopped' } } },
    });

    click(harness.element('dev-tab-previews'));
    await waitFor(
      () => all(harness.element('dev-previews-list'), 'dev-preview').length === 3,
      'the preview list never rendered',
    );

    const links = all(harness.element('dev-previews-list'), 'dev-preview-open');
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe('http://pv-ready.eunoia.test/');
    expect(links[0]?.target).toBe('_blank');
    expect(links[0]?.rel).toBe('noopener noreferrer');

    const previewRows = all(harness.element('dev-previews-list'), 'dev-preview');
    const failed = previewRows.find((row) => row.dataset.status === 'failed');
    const expired = previewRows.find((row) => row.dataset.status === 'expired');
    expect(failed?.find((node) => node.tagName === 'a')).toHaveLength(0);
    expect(expired?.find((node) => node.tagName === 'a')).toHaveLength(0);
    expect(failed?.textContent).toContain('地址不可用：端口没有响应');
    expect(expired?.textContent).toContain('地址不可用：已过期');

    const note = harness.element('dev-previews-note');
    expect(note.textContent).toBe('');

    harness.element('dev-preview-command').value = 'npm run dev';
    harness.element('dev-preview-port').value = '3000';
    harness.element('dev-preview-cwd').value = 'apps/web';
    harness.element('dev-preview-timeout').value = '45000';
    const submit = harness.element('dev-preview-form').listeners.submit?.[0];
    if (!submit) throw new Error('the preview form no longer listens for submit');
    submit({ preventDefault() {} });
    await waitFor(
      () => harness.requests.some((request) => request.url === '/api/previews' && request.method === 'POST'),
      'the preview start request never went out',
    );

    const started = harness.requests.find(
      (request) => request.method === 'POST' && request.url === '/api/previews',
    );
    expect(started?.body).toEqual({
      conversationId: CONV,
      command: 'npm run dev',
      port: 3000,
      cwd: 'apps/web',
      ready_timeout_ms: 45000,
    });
    expect(started?.headers['x-eunoia-token']).toBe(TOKEN);
    await waitFor(
      () => harness.element('dev-preview-result').textContent.includes('预览已就绪'),
      'the ready result never rendered',
    );

    const logButton = byText(
      all(harness.element('dev-previews-list'), 'dev-button'),
      '看日志',
    );
    click(logButton);
    await waitFor(
      () => harness.element('dev-previews-list').textContent.includes('listening on 3000'),
      'the preview log never rendered',
    );

    const stop = byText(all(harness.element('dev-previews-list'), 'dev-button'), '停止');
    click(stop);
    await harness.settle();
    const stopped = harness.requests.find(
      (request) => request.method === 'POST' && request.url === '/api/previews/pv_ready/stop',
    );
    expect(stopped?.body).toEqual({ conversationId: CONV });
    expect(stopped?.headers['x-eunoia-token']).toBe(TOKEN);
  });

  it('renders a 409 as not ready, with the detail and no open link', async () => {
    const harness = await openPanel({
      [`GET /api/previews?conversationId=${CONV}`]: previewsRoute([]),
      'POST /api/previews': {
        status: 409,
        json: {
          preview: { ...FAILED, error: '端口没有响应' },
          job: JOB_RUNNING,
          ready: false,
          detail: '容器里 3000 端口没有应答',
          internalUrl: 'http://127.0.0.1:3000/',
        },
      },
    });

    click(harness.element('dev-tab-previews'));
    harness.element('dev-preview-command').value = 'npm run dev';
    harness.element('dev-preview-port').value = '3000';
    const submit = harness.element('dev-preview-form').listeners.submit?.[0];
    if (!submit) throw new Error('the preview form no longer listens for submit');
    submit({ preventDefault() {} });
    await waitFor(
      () => harness.element('dev-preview-result').textContent.includes('预览未就绪'),
      'the not-ready result never rendered',
    );

    expect(harness.element('dev-preview-result').textContent).toContain('容器里 3000 端口没有应答');
    expect(harness.element('dev-preview-result').textContent).toContain('失败的预览不会显示“打开”链接');
    expect(all(harness.element('dev-preview-result'), 'dev-preview-open')).toHaveLength(0);
    expect(harness.element('dev-previews-note').textContent).toContain('预览未就绪');
  });
});

describe('source cards', () => {
  it('renders real titles and URLs, an explicit unknown cost and no invented date', async () => {
    const harness = await openPanel(
      {},
      [
        {
          type: 'tool_call',
          callId: 'c1',
          name: 'web_search',
          displayable: true,
          summary: '2 个来源',
        },
        {
          type: 'tool_result',
          callId: 'c1',
          name: 'web_search',
          ok: true,
          durationMs: 9,
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
            // A source without a URL must not become a card with a guessed one.
            { title: 'Broken row', url: 'javascript:alert(1)' },
          ],
        },
        { type: 'completed', text: '看完了。', conversationId: CONV, messageId: 'm1' },
      ],
    );

    await harness.send('查一下 node');
    const cards = all(harness.transcript, 'source-card');
    expect(cards).toHaveLength(2);

    const links = all(harness.transcript, 'source-title');
    expect(links[0]?.textContent).toBe('Node.js — Run JavaScript Everywhere');
    expect(links[0]?.href).toBe('https://nodejs.org/en');
    expect(links[0]?.target).toBe('_blank');
    expect(links[0]?.rel).toBe('noopener noreferrer');
    expect(links[1]?.href).toBe('https://www.typescriptlang.org/docs/');

    const first = cards[0];
    expect(first?.textContent).toContain('费用未知');
    expect(first?.textContent).toContain('日期未知');
    expect(first?.textContent).toContain('tavily');
    expect(first?.textContent).toContain('查询「node runtime」');
    expect(cards[1]?.textContent).toContain('日期 2026-01-02');
    expect(harness.transcript.textContent).not.toContain('javascript:alert(1)');
  });

  it('shows a real cost when the backend provides one', async () => {
    const harness = await openPanel(
      {},
      [
        {
          type: 'tool_call',
          callId: 'c2',
          name: 'web_fetch',
          displayable: true,
          summary: 'example.com',
        },
        {
          type: 'tool_result',
          callId: 'c2',
          name: 'web_fetch',
          ok: true,
          summary: '1 个来源',
          sources: [
            {
              title: 'Example Domain',
              url: 'https://example.com/',
              fetchedAt: '2026-01-03T00:00:00.000Z',
              costUsd: 0.0012,
            },
          ],
        },
        { type: 'completed', text: '读完了。', conversationId: CONV, messageId: 'm2' },
      ],
    );

    await harness.send('读一下');
    const card = all(harness.transcript, 'source-card')[0];
    expect(card?.textContent).toContain('费用 $0.0012');
    expect(card?.textContent).toContain('抓取 2026-01-03T00:00:00.000Z');
    expect(card?.textContent).not.toContain('费用未知');
  });
});

describe('changes and scoped undo', () => {
  const BLOCKED_PLAN = {
    changesetId: CHANGESET_ID,
    turnId: 'turn-1',
    files: [
      {
        path: 'src/a.ts',
        kind: 'modified',
        currentSha: 'dddd',
        afterSha: 'bbbb',
        matches: false,
        restorable: false,
        reason: '文件在本轮之后被修改或重建',
      },
      {
        path: 'src/new.ts',
        kind: 'added',
        currentSha: 'cccc',
        afterSha: 'cccc',
        matches: true,
        restorable: true,
        reason: null,
      },
    ],
    blocked: [{ path: 'src/new.ts', reason: '后续第 deadbeef 轮仍引用了这个文件' }],
  };

  const ALLOWED_PLAN = {
    ...BLOCKED_PLAN,
    files: BLOCKED_PLAN.files.map((file) => ({
      ...file,
      matches: true,
      restorable: true,
      reason: null,
    })),
    blocked: [],
  };

  function routesWith(plan: unknown, undo?: Route): Record<string, Route> {
    return {
      [`GET ${CHANGES}`]: { json: { changesets: [CHANGESET_SUMMARY] } },
      [`GET ${CHANGES}/${CHANGESET_ID}`]: { json: { changeset: CHANGESET } },
      [`POST ${CHANGES}/${CHANGESET_ID}/undo/preflight`]: { json: plan },
      ...(undo ? { [`POST ${CHANGES}/${CHANGESET_ID}/undo`]: undo } : {}),
    };
  }

  async function openChanges(routes: Record<string, Route>): Promise<Harness> {
    const harness = await openPanel(routes);
    click(harness.element('dev-tab-changes'));
    await waitFor(
      () => all(harness.element('dev-changesets'), 'dev-changeset').length === 1,
      'the changeset list never rendered',
    );
    click(all(harness.element('dev-changesets'), 'dev-changeset')[0]);
    await waitFor(
      () => all(harness.element('dev-changeset-detail'), 'dev-change-file').length === 2,
      'the changeset detail never rendered',
    );
    return harness;
  }

  it('shows added/modified before and after, refuses a blocked partial scope and writes nothing', async () => {
    const harness = await openChanges(routesWith(BLOCKED_PLAN));

    const detail = harness.element('dev-changeset-detail').textContent;
    expect(detail).toContain('src/a.ts');
    expect(detail).toContain('src/new.ts');
    expect(detail).toContain('修改');
    expect(detail).toContain('新增');
    expect(detail).toContain('before 7 B');
    expect(detail).toContain('after 8 B');

    // A strict subset of one file: the later turn still references it, so this
    // is the partial scope the server must refuse.
    const rowsBefore = all(harness.element('dev-changeset-detail'), 'dev-change-file');
    const addedBefore = rowsBefore.find((row) => row.dataset.path === 'src/new.ts');
    const addedCheckbox = addedBefore?.find((node) => node.tagName === 'input')[0];
    if (!addedCheckbox) throw new Error('the added file checkbox is missing');
    addedCheckbox.checked = false;
    addedCheckbox.onchange?.();
    await waitFor(
      () => all(harness.element('dev-changeset-detail'), 'dev-change-file').length === 2,
      'the detail did not repaint after narrowing the scope',
    );

    const preflight = byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '预检范围');
    click(preflight);
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('被拒绝的部分撤销'),
      'the blocked preflight never rendered',
    );
    expect(harness.element('dev-changeset-detail').textContent).toContain(
      '后续第 deadbeef 轮仍引用了这个文件',
    );
    expect(harness.element('dev-changeset-detail').textContent).toContain('可行范围');

    const beforePreflight = harness.requests.filter((request) => request.url.endsWith('/undo')).length;
    const undo = byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '撤销选中');
    click(undo);
    await harness.settle();
    expect(
      harness.requests.filter((request) => request.url.endsWith('/undo')).length,
    ).toBe(beforePreflight);
    expect(harness.element('dev-changes-note').textContent).toContain('预检拒绝了这次部分撤销');
  });

  it('undoes only the selected paths and reports the actually applied set', async () => {
    const undo: Route = {
      json: {
        changesetId: CHANGESET_ID,
        turnId: 'turn-1',
        status: 'partial',
        restored: ['src/new.ts'],
        deleted: ['src/new.ts'],
        conflicts: [],
        skipped: [],
        alreadyUndone: false,
      },
    };
    const harness = await openChanges(routesWith(ALLOWED_PLAN, undo));

    // Deselect the modified file: this is the "one file, not everything" case.
    const files = all(harness.element('dev-changeset-detail'), 'dev-change-file');
    const modified = files.find((row) => row.dataset.path === 'src/a.ts');
    const checkbox = modified?.find((node) => node.tagName === 'input')[0];
    if (!checkbox) throw new Error('the file checkbox is missing');
    checkbox.checked = false;
    checkbox.onchange?.();

    await waitFor(
      () => all(harness.element('dev-changeset-detail'), 'dev-change-file').length === 2,
      'the detail did not repaint after deselection',
    );
    const preflight = byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '预检范围');
    click(preflight);
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('选中 1 / 2 个文件'),
      'the scoped preflight never rendered',
    );

    const beforeApply = harness.requests.filter((request) => request.url.endsWith('/undo')).length;
    const apply = byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '撤销选中');
    click(apply);
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('实际已应用'),
      'the undo result never rendered',
    );

    const undoRequests = harness.requests.filter((request) => request.url.endsWith('/undo'));
    expect(undoRequests.length).toBe(beforeApply + 1);
    expect(undoRequests.at(-1)?.body).toEqual({ paths: ['src/new.ts'], force: false });
    expect(undoRequests.at(-1)?.headers['x-eunoia-token']).toBe(TOKEN);

    const detail = harness.element('dev-changeset-detail').textContent;
    expect(detail).toContain('已应用：src/new.ts');
    expect(detail).toContain('只撤销了选中的文件，其余保持原样');
    expect(detail).toContain('实际已应用撤销');
    expect(detail).not.toContain('已应用：src/a.ts');

    const preflightRequest = harness.requests.find((request) =>
      request.url.endsWith('/undo/preflight'),
    );
    expect(preflightRequest?.body).toEqual({ paths: ['src/new.ts'] });
  });

  it('treats an explicit full selection as a whole-round undo, not a partial one', async () => {
    const undo: Route = {
      json: {
        changesetId: CHANGESET_ID,
        turnId: 'turn-1',
        status: 'undone',
        restored: ['src/a.ts', 'src/new.ts'],
        deleted: ['src/new.ts'],
        conflicts: [],
        skipped: [],
        alreadyUndone: false,
      },
    };
    const harness = await openChanges(routesWith(BLOCKED_PLAN, undo));

    click(byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '预检范围'));
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('整轮撤销提示'),
      'the whole-round notice never rendered',
    );
    expect(harness.element('dev-changeset-detail').textContent).not.toContain(
      '被拒绝的部分撤销',
    );

    click(byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '撤销选中'));
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('实际已应用'),
      'the full undo result never rendered',
    );
    const request = harness.requests.filter((entry) => entry.url.endsWith('/undo')).at(-1);
    expect(request?.body).toEqual({ force: false });
    expect(harness.element('dev-changeset-detail').textContent).toContain(
      '已应用：src/a.ts、src/new.ts',
    );
  });

  it('lists conflicts from the preflight without applying them', async () => {
    const harness = await openChanges(routesWith(BLOCKED_PLAN));
    click(byText(all(harness.element('dev-changeset-detail'), 'dev-button'), '预检范围'));
    await waitFor(
      () => harness.element('dev-changeset-detail').textContent.includes('冲突清单'),
      'the conflict list never rendered',
    );
    expect(harness.element('dev-changeset-detail').textContent).toContain(
      'src/a.ts：文件在本轮之后被修改或重建',
    );
  });
});

describe('accessibility', () => {
  it('closes on Escape and restores focus to the opener', async () => {
    const harness = await boot({
      stored: CONV,
      token: TOKEN,
      extraScripts: ['dev-panel.js'],
      routes: {
        [`GET /api/processes?conversationId=${CONV}`]: { json: { jobs: [], available: true } },
      },
    });
    harness.element('dev-open').focus();
    click(harness.element('dev-open'));
    await harness.settle();
    expect(harness.element('dev-drawer').hidden).toBe(false);
    expect(activeElement()).toBe(harness.element('dev-close'));

    harness.fireDocument('keydown', {
      key: 'Escape',
      preventDefault() {},
    });

    expect(harness.element('dev-drawer').hidden).toBe(true);
    expect(harness.element('dev-open').getAttribute('aria-pressed')).toBe('false');
    expect(activeElement()).toBe(harness.element('dev-open'));
  });

  it('ships dialog semantics and labelled controls in the page markup', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const html = readFileSync(
      join(import.meta.dirname, '..', '..', 'web', 'index.html'),
      'utf8',
    );
    expect(html).toContain('id="dev-drawer" role="dialog" aria-modal="true"');
    expect(html).toContain('aria-labelledby="dev-title"');
    expect(html).toContain('id="dev-close" class="icon-button" type="button" aria-label="关闭开发面板"');
    expect(html).toContain('id="dev-jobs-refresh" class="dev-button" type="button"');
    expect(html).toContain('aria-label="刷新作业列表"');
    expect(html).toContain('aria-label="启动预览"');
    expect(html).toContain('aria-label="刷新修改集"');

    const harness = await openPanel({
      [`GET /api/processes?conversationId=${CONV}`]: { json: { jobs: [], available: true } },
    });
    expect(harness.element('dev-open').getAttribute('aria-pressed')).toBe('true');
  });
});


/**
 * The backend contract the panel's two-phase undo depends on.
 *
 * A later turn that still names a path makes that path unsafe to undo alone. The
 * plan is read-only, and the undo path re-checks the same rule instead of
 * trusting a stale preflight from the browser.
 */
describe('scoped undo contract', () => {
  it('blocks a path a later turn still references and restores only the safe selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-r11-undo-'));
    try {
      const source = join(root, 'source');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(source, 'b.ts'), 'export const b = 1;\n');
      const sandboxStore = new MemorySandboxStore();
      const workspaces = new WorkspaceManager(
        { store: sandboxStore },
        {
          storageRoot: join(root, 'storage'),
          sourceRoot: source,
          mode: 'copy',
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      );
      const store = new InMemoryStore();
      let tick = 0;
      const service = new WorkspaceChangeService({
        store: sandboxStore,
        workspaces,
        changesets: store,
        now: () => new Date(Date.parse('2026-05-01T00:01:00Z') + tick++ * 60_000),
      });
      const workspace = await workspaces.ensureForTask('conv-r11');
      const files = workspaces.files(workspace.storageLocation);

      await service.arm({ userId: 'u1', conversationId: 'conv-r11', turnId: 't1', taskId: 'conv-r11' });
      await service.beforeWrite({ taskId: 'conv-r11', path: 'a.ts' });
      await files.writeText('a.ts', 'export const a = 2;\n');
      await service.beforeWrite({ taskId: 'conv-r11', path: 'b.ts' });
      await files.writeText('b.ts', 'export const b = 2;\n');
      const first = await service.finish({ userId: 'u1', turnId: 't1' });
      if (!first) throw new Error('the first turn produced no changeset');

      await service.arm({ userId: 'u1', conversationId: 'conv-r11', turnId: 't2', taskId: 'conv-r11' });
      await service.beforeWrite({ taskId: 'conv-r11', path: 'a.ts' });
      await files.writeText('a.ts', 'export const a = 3;\n');
      const second = await service.finish({ userId: 'u1', turnId: 't2' });
      if (!second) throw new Error('the second turn produced no changeset');

      const plan = await service.planUndo({
        userId: 'u1',
        conversationId: 'conv-r11',
        changesetId: first.id,
        paths: ['a.ts'],
      });
      expect(plan.blocked).toHaveLength(1);
      expect(plan.blocked[0]?.path).toBe('a.ts');
      expect(plan.files[0]).toMatchObject({ path: 'a.ts', restorable: false });

      await expect(
        service.undo({
          userId: 'u1',
          conversationId: 'conv-r11',
          changesetId: first.id,
          paths: ['a.ts'],
        }),
      ).rejects.toMatchObject({ code: 'UNDO_SCOPE_BLOCKED' });

      const safe = await service.undo({
        userId: 'u1',
        conversationId: 'conv-r11',
        changesetId: first.id,
        paths: ['b.ts'],
      });
      expect(safe.restored).toEqual(['b.ts']);
      expect(safe.status).toBe('partial');
      expect(await readFile(join(workspace.storageLocation, 'b.ts'), 'utf8')).toBe(
        'export const b = 1;\n',
      );
      // The later turn's own change is untouched.
      expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe(
        'export const a = 3;\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


/**
 * The server-side half of the source card: a real tool result must put its
 * `structuredContent.sources` on the wire, sanitized. The fixture browser check
 * proves the client; this proves the event it consumes can actually exist.
 */
describe('source event forwarding', () => {
  it('forwards only real http(s) sources with a title', async () => {
    const search = defineTool({
      name: 'web_search',
      description: 'search',
      parameters: z.object({}),
      sideEffect: 'external_read',
      readOnly: true,
      execute: async () => ({
        ...toolOk('results', { summary: '2 个来源' }),
        structuredContent: {
          sources: [
            {
              title: 'Real title',
              url: 'https://example.test/page',
              snippet: 'snippet',
              provider: 'tavily',
            },
            { title: '', url: 'https://missing-title.test/' },
            { title: 'Script URL', url: 'javascript:alert(1)' },
          ],
        },
      }),
    });
    let step = 0;
    const modelTurn: ModelTurn = async function* () {
      if (step++ === 0) {
        const output: LoopOutputItem[] = [
          { type: 'function_call', callId: 'c1', name: 'web_search', arguments: '{}' },
        ];
        yield { type: 'done', output };
        return;
      }
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
    };
    const events: AgentEvent[] = [];
    for await (const event of runAgentLoop({
      modelTurn,
      instructions: 'stable',
      input: [{ type: 'message', role: 'user', content: '搜索' }],
      tools: new ToolRegistry([search]),
      toolContext: {
        workspace: null,
        policy: DEFAULT_TOOL_POLICY,
        ledger: new TurnReadLedger(),
        now: new Date('2026-10-25T12:00:00Z'),
      },
    })) {
      events.push(event);
    }

    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({
      type: 'tool_result',
      name: 'web_search',
      ok: true,
      sources: [
        {
          title: 'Real title',
          url: 'https://example.test/page',
          snippet: 'snippet',
          provider: 'tavily',
        },
      ],
    });
  });
});
