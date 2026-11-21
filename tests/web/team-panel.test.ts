/**
 * The Team mode switch in `web/team.js`.
 *
 * The switch is a read-modify-write over the team's `configRevision`: the panel
 * sends the revision it last saw and the server answers TEAM_CONFIG_CONFLICT
 * when that copy is stale. Two rules follow, and both had a visible failure:
 *
 *   - a successful write must adopt the revision the response carries, or the
 *     next click quotes a revision the server has already moved past;
 *   - a conflict must be recovered by re-reading, not shown to the person:
 *     "请刷新后重试" for a two-state switch is a dead end, not an instruction.
 *
 * The panel only refreshed its copy of the team from a *run* snapshot, so on a
 * conversation with no run the switch wrote and then never moved — the click
 * looked ignored, and the second one was a conflict. These tests hold the
 * switch down to the revision it quotes, because that number is the whole bug.
 */

import { describe, expect, it } from 'vitest';

import { boot, El, type Harness } from './harness.ts';

const TOKEN = 'local-token';
const CONVERSATION = 'conv-1';

type Mode = 'team' | 'delegation';

interface TeamDocument {
  configRevision: number;
  enabled: boolean;
  config: {
    mode: Mode;
    defaultModelId: string;
    limits: { maxMembers: number };
    budget: { maxRequests: number; maxInputTokens: number; maxOutputTokens: number };
  };
}

interface ConfigWrite {
  conversationId: string;
  expectedRevision: number;
  config: { mode: Mode };
  enabled: boolean;
}

/**
 * The Team endpoints the panel uses, with the CAS the service enforces.
 *
 * `writes` is the assertion surface: what matters is not how many requests the
 * panel makes but which revision each write quoted. The response body is read
 * as text by the panel, so `text()` is what the double has to answer.
 */
function createServer(start: { revision?: number; mode?: Mode } = {}) {
  let revision = start.revision ?? 1;
  let mode: Mode = start.mode ?? 'team';
  const writes: ConfigWrite[] = [];

  const document = (): TeamDocument => ({
    configRevision: revision,
    enabled: mode === 'team',
    config: {
      mode,
      defaultModelId: 'deepseek-v4-pro',
      limits: { maxMembers: 4 },
      budget: { maxRequests: 24, maxInputTokens: 400_000, maxOutputTokens: 32_000 },
    },
  });
  const reply = (status: number, payload: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    body: null,
  });

  return {
    writes,
    mode: () => mode,
    /** Move the row behind the panel's back, the way another tab would. */
    moveTo(next: Mode): void {
      mode = next;
      revision += 1;
    },
    fetch: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('/api/teams')) {
        return reply(200, { team: document(), runs: [], activeRunId: null });
      }
      if (method === 'POST' && url === '/api/teams/config') {
        const body = JSON.parse(String(init?.body ?? '{}')) as ConfigWrite;
        writes.push(body);
        if (body.expectedRevision !== revision) {
          return reply(409, {
            error: 'Team 配置已被修改，请刷新后重试。',
            code: 'TEAM_CONFIG_CONFLICT',
            detail: { expectedRevision: body.expectedRevision, currentRevision: revision },
          });
        }
        mode = body.enabled ? 'team' : 'delegation';
        revision += 1;
        return reply(200, { team: document() });
      }
      return reply(200, {});
    },
  };
}

type Server = ReturnType<typeof createServer>;

function click(node: El | undefined): void {
  if (!node) throw new Error('tried to click a missing node');
  if (node.onclick) node.onclick();
  else node.listeners['click']?.[0]?.({ preventDefault() {} });
}

/** Boot the page with the panel loaded, and open it on a conversation. */
async function openPanel(server: Server): Promise<Harness> {
  const harness = await boot({
    stored: CONVERSATION,
    token: TOKEN,
    extraScripts: ['team.js'],
  });
  // The panel's server is stateful (a revision only a CAS can answer), which
  // the static route table cannot express; install it after both scripts load.
  (globalThis as { fetch?: unknown }).fetch = server.fetch;
  // `render()` reaches through the start form for its submit button so it can
  // disable it. The template has one; the shim only mints empty elements.
  const submit = new El('button');
  harness.element('team-start').querySelector = () => submit;
  click(harness.element('team-open'));
  await harness.settle();
  return harness;
}

function text(node: El): string {
  return node.textContent;
}

/** The view's banners, split the way `render()` splits them. */
function banner(harness: Harness, className: string): string {
  return harness
    .element('team-view')
    .children.filter((node) => node.classList.contains(className))
    .map(text)
    .join('');
}

describe('the Team mode switch', () => {
  it('renders the mode the conversation is in', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);

    expect(text(harness.element('team-mode'))).toBe('开启');
    expect(harness.element('team-mode').getAttribute('aria-pressed')).toBe('true');
    expect(text(harness.element('team-meta'))).toContain('Team');
  });

  it('moves to the mode the server wrote', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    click(harness.element('team-mode'));
    await harness.settle();

    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]).toMatchObject({
      conversationId: CONVERSATION,
      expectedRevision: 1,
      config: { mode: 'delegation' },
      enabled: false,
    });
    // The failure this test exists for: the switch, the hint and the meta rows
    // all read from the copy the response replaced, so they have to follow it.
    expect(text(harness.element('team-mode'))).toBe('关闭');
    expect(harness.element('team-mode').getAttribute('aria-pressed')).toBe('false');
    expect(text(harness.element('team-meta'))).toContain('仅委派');
    expect(text(harness.element('team-mode-hint'))).toContain('不启用共享任务板');
    expect(banner(harness, 'team-error')).toBe('');
    expect(banner(harness, 'team-success')).toContain('Team 已关闭');
  });

  it('quotes the new revision on the next click', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    click(harness.element('team-mode'));
    await harness.settle();
    click(harness.element('team-mode'));
    await harness.settle();

    expect(server.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(server.writes[1]).toMatchObject({ config: { mode: 'team' }, enabled: true });
    expect(text(harness.element('team-mode'))).toBe('开启');
  });

  it('recovers from a revision another tab already moved', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    // Between the read and the click somebody else turned Team off.
    server.moveTo('delegation');
    click(harness.element('team-mode'));
    await harness.settle();

    // The panel wanted "off" too, so the re-read settles it: one write, no
    // second one, and the state on screen is the one the server holds.
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]?.expectedRevision).toBe(1);
    expect(text(harness.element('team-mode'))).toBe('关闭');
    expect(banner(harness, 'team-error')).toBe('');
    expect(banner(harness, 'team-success')).toContain('Team 已关闭');
  });

  it('retries once against the revision that is current', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    // The row was rewritten without changing the mode — a limit edit, say.
    server.moveTo('team');
    click(harness.element('team-mode'));
    await harness.settle();

    // The first write quoted the stale revision and was refused; the retry
    // quotes revision 2 and turns Team off. A conflict the panel can resolve on
    // its own never reaches the screen.
    expect(server.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(server.mode()).toBe('delegation');
    expect(text(harness.element('team-mode'))).toBe('关闭');
    expect(banner(harness, 'team-error')).toBe('');
  });

  it('sends one write when the switch is clicked twice at once', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    click(harness.element('team-mode'));
    // The second click lands while the first is in flight — the button is
    // disabled, but a queued click still reaches the handler.
    click(harness.element('team-mode'));
    await harness.settle();

    expect(server.writes).toHaveLength(1);
    expect(text(harness.element('team-mode'))).toBe('关闭');
    expect(banner(harness, 'team-error')).toBe('');
  });

  it('does not retry a write after switching conversations during conflict recovery', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    server.moveTo('team');
    const originalRequest = `/api/teams?conversationId=${CONVERSATION}`;
    let releaseRead!: () => void;
    const delayedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      if (url === originalRequest) await delayedRead;
      return server.fetch(url, init);
    };

    click(harness.element('team-mode'));
    await harness.settle();
    harness.store.set('df_conversation', 'conv-2');
    click(harness.element('team-close'));
    click(harness.element('team-open'));
    releaseRead();
    await harness.settle();

    expect(server.writes.map((write) => write.conversationId)).toEqual([CONVERSATION]);
    expect(harness.element('team-mode').getAttribute('aria-pressed')).toBe('true');
    expect(banner(harness, 'team-error')).toBe('');
  });

  it('quotes the mode the conversation is actually in after a re-open', async () => {
    const server = createServer({ mode: 'team' });
    const harness = await openPanel(server);
    click(harness.element('team-mode'));
    await harness.settle();
    click(harness.element('team-close'));
    click(harness.element('team-open'));
    await harness.settle();
    click(harness.element('team-mode'));
    await harness.settle();

    expect(server.writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
    expect(text(harness.element('team-mode'))).toBe('开启');
  });
});
