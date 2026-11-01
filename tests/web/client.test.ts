/**
 * The web client's rendering of a streamed turn.
 *
 * The client is one static file with no build step (ADR 006), so this drives
 * the real module out of `web/index.html` against a hand-written DOM rather
 * than a browser. That is a deliberate trade: adding jsdom to test one file is
 * a dependency the project does not otherwise need, and the shim is small
 * enough to read in a sitting.
 *
 * What it can prove: the event routing, the ordering, the classes and data
 * attributes the stylesheet keys off. What it cannot prove: that the result
 * *looks* right, or that a browser lays it out the way it does here. A test
 * that claimed otherwise would be lying.
 *
 * The reasoning block is the reason this file exists. It is the one part of
 * the client with real state — created lazily, streamed into, closed once,
 * collapsed unless the person has taken over — and every one of those rules
 * has an observable failure: a block that never appears, one that stays open
 * forever, or one that closes twice and forgets how long it took.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { boot, El, type Frame, type Harness, type Route } from './harness.ts';

/** Most tests only want one turn, so this is the short form. */
async function runTurn(frames: Frame[]): Promise<El> {
  const harness = await boot({ frames });
  await harness.send('今天什么都不想做。');
  return harness.transcript;
}

/** The last turn on the transcript, and the parts of it the tests inspect. */
function lastTurn(transcript: El) {
  const turns = transcript.children.filter((node) => node.classList.contains('turn'));
  const turn = turns.at(-1);
  const bubble = turn?.child('bubble');
  return {
    turn,
    turns,
    bubble,
    thinking: bubble?.child('thinking'),
    reply: bubble?.child('text'),
    head: bubble?.child('thinking')?.child('thinking-head'),
    body: bubble?.child('thinking')?.child('thinking-body'),
    trace: bubble?.child('tool-trace'),
    traceBody: bubble?.child('tool-trace')?.child('tool-trace-body'),
    traceHead: bubble?.child('tool-trace')?.child('tool-trace-head'),
    note: turn?.child('meta')?.children[0],
  };
}

const THINKING_TURN: Frame[] = [
  { type: 'thinking_delta', text: '他说累，' },
  { type: 'thinking_delta', text: '但累可能不是重点。' },
  { type: 'thinking_done', elapsedMs: 12_400 },
  { type: 'text_delta', text: '听起来' },
  { type: 'text_delta', text: '真的很沉。' },
  { type: 'completed', text: '听起来真的很沉。', conversationId: 'c1', messageId: 'm1' },
];

const TOOL_TURN: Frame[] = [
  { type: 'tool_call', callId: 'c1', name: 'read_file', displayable: true, summary: '读取 src/a.ts:1-40' },
  { type: 'tool_result', callId: 'c1', name: 'read_file', ok: true, durationMs: 1200, summary: '读取 1-40 行' },
  { type: 'text_delta', text: '看完了，可以改。' },
  { type: 'completed', text: '看完了，可以改。', conversationId: 'c1', messageId: 'm1' },
];

/** A stored conversation, as `/api/conversations/:id/messages` returns it. */
const STORED_MESSAGES = {
  messages: [
    { id: 'm1', role: 'user', content: '今天不想上班', createdAt: '2026-09-28T09:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: '嗯，那就先不上的样子。', createdAt: '2026-09-28T09:00:02.000Z' },
    { id: 'm3', role: 'user', content: '可是不行啊', createdAt: '2026-09-28T09:01:00.000Z' },
    { id: 'm4', role: 'assistant', content: '是有什么在后面等着？', createdAt: '2026-09-28T09:01:03.000Z' },
  ],
};

/** The last request the module made to a path. */
function lastRequest(harness: Harness, url: string) {
  return harness.requests.filter((request) => request.url === url).at(-1);
}

const messageRoute = (json: unknown, status = 200): Record<string, Route> => ({
  'GET /api/conversations/c1/messages': { status, json },
});

/** The turn bodies posted to `/api/chat`, which is what "continues the thread" means. */
function sentConversationIds(harness: Harness): unknown[] {
  return harness.requests
    .filter((request) => request.url === '/api/chat')
    .map((request) => request.body?.conversationId ?? null);
}

// ------------------------------------------------------------------ tests ---

describe('the page shell', () => {
  it('shows the product name, not the internal prompt fingerprint', () => {
    const html = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'index.html'), 'utf8');
    expect(html).toContain('<h1>Eunoia</h1>');
    expect(html).toContain('<title>Eunoia</title>');
    // The prompt version is an operator fact, not something the person using
    // the companion should have to read.
    expect(html).not.toContain('prompt-version');
  });
});

describe('the reasoning block', () => {
  it('streams the thinking, then closes it with how long it took', async () => {
    const { thinking, head, body } = lastTurn(await runTurn(THINKING_TURN));

    expect(body?.children[0]?.textContent).toBe('他说累，但累可能不是重点。');
    expect(head?.child('label')?.textContent).toBe('思考了 12 秒');
    expect(thinking?.dataset.state).toBe('done');
  });

  it('collapses itself when the answer starts, so the answer is what is read', async () => {
    const { thinking, head } = lastTurn(await runTurn(THINKING_TURN));

    expect(thinking?.dataset.open).toBe('false');
    expect(head?.getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens when the person asks, and then stops deciding for them', async () => {
    const { thinking, head } = lastTurn(await runTurn(THINKING_TURN));

    head?.onclick?.();
    expect(thinking?.dataset.open).toBe('true');
    expect(head?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the reasoning while it is still arriving, not only after', async () => {
    // The failure this guards is the original bug in another form: a block that
    // only appears once the turn is over is no better than no block at all.
    const { thinking, head } = lastTurn(
      await runTurn([{ type: 'thinking_delta', text: '正在想…' }]),
    );

    expect(thinking?.dataset.state).toBe('live');
    expect(thinking?.dataset.open).toBe('true');
    expect(head?.child('label')?.textContent).toBe('正在想…');
  });

  it('does not appear at all when the model did not think', async () => {
    // A turn answered directly should not grow an empty box above the reply.
    const { thinking } = lastTurn(
      await runTurn([
        { type: 'text_delta', text: '嗯。' },
        { type: 'completed', text: '嗯。', conversationId: 'c1', messageId: 'm1' },
      ]),
    );

    expect(thinking).toBeUndefined();
  });

  it('closes rather than being left live when the turn fails', async () => {
    // Reasoning that stops mid-sentence with a spinner still turning beside it
    // reads as though something is still coming. It is not.
    const { thinking, head } = lastTurn(
      await runTurn([
        { type: 'thinking_delta', text: '他说累，' },
        { type: 'error', message: 'boom', retryable: true },
      ]),
    );

    expect(thinking?.dataset.state).toBe('done');
    expect(thinking?.dataset.open).toBe('false');
    expect(head?.child('label')?.textContent).toBe('思考过程');
  });
});

describe('the tool trace', () => {
  it('draws a row per call and closes it with the outcome', async () => {
    const { trace, traceBody, traceHead } = lastTurn(await runTurn(TOOL_TURN));

    expect(trace).toBeDefined();
    expect(traceHead?.child('tool-trace-count')?.textContent).toBe('1');
    const rows = traceBody?.find((node) => node.classList.contains('tool-row')) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.state).toBe('ok');
    expect(rows[0]?.child('tool-name')?.textContent).toBe('read_file');
    expect(rows[0]?.child('tool-summary')?.textContent).toBe('读取 1-40 行');
    expect(rows[0]?.child('tool-state')?.textContent).toContain('完成');
    expect(rows[0]?.child('tool-state')?.textContent).toContain('1.2s');
  });

  it('shows a failed call as failed, with the error available on hover', async () => {
    const { traceBody } = lastTurn(
      await runTurn([
        { type: 'tool_call', callId: 'c1', name: 'edit_file', displayable: true, summary: '修改 src/a.ts' },
        {
          type: 'tool_result',
          callId: 'c1',
          name: 'edit_file',
          ok: false,
          durationMs: 20,
          summary: 'old_string 不唯一',
          error: 'old_string appears 2 times',
        },
        { type: 'completed', text: '没改成。', conversationId: 'c1', messageId: 'm1' },
      ]),
    );

    const rows = traceBody?.find((node) => node.classList.contains('tool-row')) ?? [];
    expect(rows[0]?.dataset.state).toBe('error');
    expect(rows[0]?.child('tool-state')?.textContent).toContain('失败');
    expect(rows[0]?.title).toBe('old_string appears 2 times');
  });

  it('does not appear when the turn called no tools', async () => {
    const { trace } = lastTurn(await runTurn(THINKING_TURN));
    expect(trace).toBeUndefined();
  });

  it('reports a turned-off step cap without throwing the partial reply away', async () => {
    const { note, reply } = lastTurn(
      await runTurn([
        { type: 'loop_exhausted', steps: 12 },
        { type: 'completed', text: '做到一半。', conversationId: 'c1', messageId: 'm1' },
      ]),
    );

    expect(note?.textContent).toContain('12 步');
    expect(reply?.textContent).toBe('做到一半。');
  });
});

describe('the reply', () => {
  it('goes into its own element, so the reasoning above it is not overwritten', async () => {
    const { reply, body } = lastTurn(await runTurn(THINKING_TURN));

    expect(reply?.textContent).toBe('听起来真的很沉。');
    expect(body?.children[0]?.textContent).toBe('他说累，但累可能不是重点。');
  });

  it('drops the typing caret once the turn is over', async () => {
    const { reply } = lastTurn(await runTurn(THINKING_TURN));

    // The attribute is what the stylesheet hangs the caret off; leaving it set
    // would leave a cursor blinking after a finished reply.
    expect(reply?.dataset.streaming).toBeUndefined();
  });

  it('replaces the waiting dots with the reasoning as soon as it arrives', async () => {
    const { bubble, thinking } = lastTurn(await runTurn(THINKING_TURN));

    expect(thinking).toBeDefined();
    expect(bubble?.find((node) => node.classList.contains('dots')).some((n) => n.isConnected)).toBe(
      false,
    );
  });
});

/**
 * The conversation survives a reload.
 *
 * This is the bug these tests exist for. Everything server-side was already
 * right — the messages were being written, and both endpoints returned them —
 * but the client held the conversation id in a variable that died with the page
 * and never called either endpoint. From the outside that is indistinguishable
 * from losing the conversation, which is exactly what it looked like.
 */
describe('coming back to a conversation', () => {
  it('restores the remembered conversation on load', async () => {
    const harness = await boot({ stored: 'c1', routes: messageRoute(STORED_MESSAGES) });

    const turns = harness.transcript.children.filter((node) => node.classList.contains('turn'));
    expect(turns).toHaveLength(4);
    expect(turns[0]?.classList.contains('user')).toBe(true);
    expect(turns[0]?.child('bubble')?.child('text')?.textContent).toBe('今天不想上班');
    expect(turns[1]?.classList.contains('assistant')).toBe(true);
    expect(turns[3]?.child('bubble')?.child('text')?.textContent).toBe('是有什么在后面等着？');
  });

  it('continues that conversation on the next message rather than starting a new one', async () => {
    const harness = await boot({
      stored: 'c1',
      routes: messageRoute(STORED_MESSAGES),
      frames: [{ type: 'completed', text: '嗯。', conversationId: 'c1', messageId: 'm5' }],
    });

    await harness.send('我还是去了');

    expect(sentConversationIds(harness)).toEqual(['c1']);
  });

  it('offers feedback on the restored replies, as it does on live ones', async () => {
    // A reply that was rated when it arrived and cannot be rated on reload would
    // make the history a read-only copy rather than the same conversation.
    const harness = await boot({ stored: 'c1', routes: messageRoute(STORED_MESSAGES) });

    const rated = harness.transcript.find((node) => node.classList.contains('turn'))[1];
    // `meta` holds the note and then the rating buttons; neither carries a class
    // of its own, so this reaches in by position rather than by name.
    const buttons = rated?.child('meta')?.children[1]?.children ?? [];
    expect(buttons.map((button) => button.textContent)).toEqual(['有帮助', '不太对']);

    buttons[0]?.onclick?.();
    await harness.settle();
    const posted = lastRequest(harness, '/api/feedback');
    expect(posted?.body).toMatchObject({ messageId: 'm2', rating: 'good' });
  });

  it('remembers the id the server hands back', async () => {
    const harness = await boot({ frames: THINKING_TURN });

    await harness.send('今天什么都不想做。');

    // The first turn sends no id — the server makes one — and the client stores
    // what comes back, which is what the reload above reads.
    expect(sentConversationIds(harness)).toEqual([null]);
    expect(harness.store.get('df_conversation')).toBe('c1');
  });

  it('carries the stored id into the turn, even when the restore failed', async () => {
    // The transcript is empty because the fetch failed; that is not a reason to
    // abandon the conversation and write the reply somewhere else.
    const harness = await boot({
      stored: 'c1',
      routes: messageRoute({ error: 'boom' }, 500),
      frames: [{ type: 'completed', text: '嗯。', conversationId: 'c1', messageId: 'm5' }],
    });

    expect(harness.transcript.children).toEqual([]);
    await harness.send('在吗');
    expect(sentConversationIds(harness)).toEqual(['c1']);
  });

  it('replays nothing when the stored conversation is gone', async () => {
    const harness = await boot({ stored: 'c1', routes: messageRoute({ messages: [] }) });

    expect(harness.transcript.children).toEqual([]);
  });

  it('forgets the conversation when a new one is started', async () => {
    const harness = await boot({
      stored: 'c1',
      routes: messageRoute(STORED_MESSAGES),
      frames: [{ type: 'completed', text: '嗯。', conversationId: 'c2', messageId: 'm5' }],
    });

    harness.element('new-conversation').onclick?.();

    // Both halves matter: the screen is cleared, and the reload that follows
    // does not pull the old conversation back over it.
    expect(harness.transcript.children).toEqual([]);
    expect(harness.store.has('df_conversation')).toBe(false);

    await harness.send('换个话题');
    expect(sentConversationIds(harness)).toEqual([null]);
  });
});

describe('the conversation list', () => {
  // The order the server returns them in — newest first — is the order the
  // drawer draws them, so the fixture is written the way the API sends it.
  const LIST = {
    conversations: [
      { id: 'c2', title: '今天不想上班', startedAt: '2026-09-27T09:00:00.000Z', turnCount: 3 },
      { id: 'c1', title: null, startedAt: '2020-01-15T09:00:00.000Z', turnCount: 2 },
    ],
  };

  const listRoutes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
    ...messageRoute(STORED_MESSAGES),
    'GET /api/conversations': { json: LIST },
    ...extra,
  });

  async function openList(routes: Record<string, Route>, stored?: string) {
    const harness = await boot({ stored, routes });
    harness.element('history-toggle').onclick?.();
    await harness.settle();
    return harness.element('history-list').find((node) => node.classList.contains('thread'));
  }

  function actionsFor(thread: El): El[] {
    return thread.parent?.find((node) => node.classList.contains('thread-actions'))[0]?.children ?? [];
  }

  it('lists every conversation and marks the one that is open', async () => {
    const rows = await openList(listRoutes(), 'c1');

    expect(rows.map((row) => row.child('name')?.textContent)).toEqual([
      '今天不想上班',
      '（没有名字的对话）',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['false', 'true']);
  });

  it('names an untitled conversation rather than showing a hole', async () => {
    // Every conversation written before naming existed has a null title, and one
    // that is never written in again never gets one. The fallback is what keeps
    // those rows readable instead of blank.
    const rows = await openList(listRoutes());

    expect(rows[1]?.child('name')?.classList.contains('unnamed')).toBe(true);
    // An old conversation is dated, not counted in hours — "9864 小时前" tells
    // nobody anything. The exact string is not asserted because it is local time
    // and the test would then be answering about the machine it ran on.
    expect(rows[1]?.child('when')?.textContent).toMatch(/^\d+ 月 \d+ 日$/);
  });

  it('says 刚刚 for a conversation used moments ago', async () => {
    const rows = await openList({
      'GET /api/conversations': {
        json: {
          conversations: [
            { id: 'c9', title: '刚说过的', startedAt: new Date().toISOString(), turnCount: 1 },
          ],
        },
      },
    });

    expect(rows[0]?.child('when')?.textContent).toBe('刚刚');
  });

  it('opens a conversation when its row is picked', async () => {
    const harness = await boot({
      stored: 'c1',
      routes: listRoutes({
        'GET /api/conversations/c2/messages': {
          json: {
            messages: [{ id: 'm9', role: 'user', content: '昨天那些事', createdAt: new Date().toISOString() }],
          },
        },
      }),
    });

    harness.element('history-toggle').onclick?.();
    await harness.settle();
    const rows = harness.element('history-list').find((node) => node.classList.contains('thread'));
    rows[0]?.onclick?.();
    await harness.settle();

    // Picking a row replaces the transcript and adopts that conversation, so the
    // next message goes there rather than into the one that was open.
    expect(harness.transcript.children).toHaveLength(1);
    expect(harness.transcript.find((node) => node.classList.contains('turn'))[0]?.child('bubble')?.child('text')?.textContent).toBe('昨天那些事');
    expect(harness.store.get('df_conversation')).toBe('c2');
    expect(harness.element('history').dataset.open).toBe('false');
  });

  it('says so rather than showing nothing when the list cannot be read', async () => {
    const harness = await boot({
      routes: { 'GET /api/conversations': { status: 503, json: { error: 'down' } } },
    });

    harness.element('history-toggle').onclick?.();
    await harness.settle();

    expect(harness.element('history-list').child('empty-note')?.textContent).toBe(
      '读不到历史对话。',
    );
  });

  it('renames a conversation from its row', async () => {
    const harness = await boot({
      routes: listRoutes({
        'PATCH /api/conversations/c2': {
          json: { conversation: { id: 'c2', title: '新名字' } },
        },
      }),
    });
    harness.element('history-toggle').onclick?.();
    await harness.settle();

    const thread = harness.element('history-list').find((node) =>
      node.classList.contains('thread'),
    )[0];
    actionsFor(thread as El)[0]?.onclick?.();
    await harness.settle();

    const editor = (thread as El).parent?.child('thread-rename');
    const field = editor?.children[0];
    const save = editor?.children[1];
    if (!field || !save) throw new Error('the rename editor was not rendered');

    field.value = '新名字';
    save.onclick?.();
    await harness.settle();

    expect(lastRequest(harness, '/api/conversations/c2')?.body).toEqual({ title: '新名字' });
  });

  it('deletes a conversation only on the second click', async () => {
    const harness = await boot({
      routes: listRoutes({ 'DELETE /api/conversations/c2': { json: { deleted: 'c2' } } }),
    });
    harness.element('history-toggle').onclick?.();
    await harness.settle();

    const thread = harness.element('history-list').find((node) =>
      node.classList.contains('thread'),
    )[0];
    const remove = actionsFor(thread as El)[2];
    if (!remove) throw new Error('the delete action was not rendered');

    remove.onclick?.();
    await harness.settle();
    expect(harness.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(remove.textContent).toBe('确认删除');

    remove.onclick?.();
    await harness.settle();
    expect(lastRequest(harness, '/api/conversations/c2')?.method).toBe('DELETE');
  });

  it('asks for the archive only when the toggle is on', async () => {
    const harness = await boot({ routes: listRoutes() });
    harness.element('history-toggle').onclick?.();
    await harness.settle();

    harness.element('history-archived').onclick?.();
    await harness.settle();

    expect(lastRequest(harness, '/api/conversations?includeArchived=1')?.method).toBe('GET');
  });
});

describe('deleting everything', () => {
  it('asks twice, because the first click is not the one that deletes', async () => {
    // Not a `confirm()` dialog. A browser dialog is dismissed on reflex, and the
    // reflex is trained by dialogs that do not matter — so the button changes
    // what it says and what it looks like instead, and the second click is the
    // deliberate one.
    const harness = await boot({ routes: { 'DELETE /api/me': { json: { deleted: true } } } });
    const button = harness.element('forget-all');

    button.onclick?.();
    await harness.settle();

    expect(harness.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(button.dataset.armed).toBe('true');
    expect(button.textContent).toBe('再点一次，删除');
  });

  it('deletes on the second click and clears what is on screen', async () => {
    const harness = await boot({
      frames: [
        { type: 'text_delta', text: '嗯。' },
        { type: 'completed', text: '嗯。', conversationId: 'c1' },
      ],
      routes: {
        'DELETE /api/me': { json: { deleted: true } },
        'GET /api/conversations': { json: { conversations: [] } },
      },
    });
    await harness.send('今天什么都不想做。');
    expect(harness.transcript.children.length).toBeGreaterThan(0);

    const button = harness.element('forget-all');
    button.onclick?.();
    button.onclick?.();
    await harness.settle();

    expect(harness.requests.some((request) => `${request.method} ${request.url}` === 'DELETE /api/me')).toBe(true);
    // The transcript is the last copy of what was just deleted, and the stored
    // id now points at a row that is gone.
    expect(harness.transcript.children).toEqual([]);
    expect(harness.transcript.classList.contains('empty')).toBe(true);
    expect(harness.store.has('df_conversation')).toBe(false);
    expect(button.textContent).toBe('都删掉了');
  });

  it('says the deletion failed rather than reporting success', async () => {
    // A failed delete that left the button reading "都删掉了" would be a lie
    // about the one thing the person cannot check for themselves.
    const harness = await boot({ routes: { 'DELETE /api/me': { status: 500, json: { error: 'down' } } } });

    const button = harness.element('forget-all');
    button.onclick?.();
    button.onclick?.();
    await harness.settle();

    expect(button.textContent).toBe('删除失败，稍后再试');
    // Disarmed, so the next click is a fresh decision rather than a retry the
    // person did not make.
    expect(button.dataset.armed).toBe('false');
  });

  it('disarms when the drawer is closed', async () => {
    // An armed button that survives being put away is an armed button someone
    // finds later without the context that made it red.
    const harness = await boot({ routes: { 'DELETE /api/me': { json: { deleted: true } } } });
    const button = harness.element('forget-all');

    button.onclick?.();
    expect(button.dataset.armed).toBe('true');

    harness.element('drawer-close').onclick?.();

    expect(button.dataset.armed).toBe('false');
    expect(button.textContent).toBe('删除全部数据');
    expect(harness.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });
});
