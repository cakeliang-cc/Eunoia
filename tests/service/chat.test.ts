/**
 * The turn orchestrator.
 *
 * Everything here runs against a fake runner, so the whole behavioural layer —
 * retrieval, risk, buffering, the output check, persistence — is exercised with
 * no model, no credential and no network. That is not a convenience: it is what
 * makes these assertions stable enough to gate a prompt change on.
 *
 * The two behaviours worth the most attention:
 *
 *   - **crisis turns buffer.** Nothing is emitted until the reply has passed the
 *     output check, because a delta that has been rendered cannot be un-rendered
 *     by replacing the message afterwards.
 *   - **persistence cannot fail a turn.** The reply is already on the person's
 *     screen; a bookkeeping error must not take it away.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { CRISIS_FALLBACK } from '../../src/safety/response.ts';
import { collectTurn, runTurn, type TurnRunner } from '../../src/service/chat.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { randomUUID } from 'node:crypto';
import { TurnCoordinator, turnRequestHash } from '../../src/service/turns.ts';

const USER = 'user-1';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

/** A runner that emits the given events, then `completed` with `reply`. */
function fakeRunner(reply: string, before: AgentEvent[] = []): TurnRunner {
  return async function* () {
    for (const event of before) yield event;
    if (reply.length > 0) yield { type: 'text_delta', text: reply };
    yield { type: 'completed', text: reply };
  };
}

/** A runner that streams in pieces, the way a real one does. */
function streamingRunner(pieces: string[]): TurnRunner {
  return async function* () {
    for (const piece of pieces) yield { type: 'text_delta', text: piece };
    yield { type: 'completed', text: pieces.join('') };
  };
}

async function drain(deps: Parameters<typeof runTurn>[0], request: Parameters<typeof runTurn>[1]) {
  const events: AgentEvent[] = [];
  for await (const event of runTurn(deps, request)) events.push(event);
  return events;
}

/** The terminal `completed` event, or null — so tests need not re-narrow. */
function completedOf(events: AgentEvent[]) {
  const last = events.at(-1);
  return last?.type === 'completed' ? last : null;
}

describe('a normal turn', () => {
  it('streams deltas and ends with completed carrying the whole reply', async () => {
    const events = await drain({ store, runner: streamingRunner(['听起来', '真的很沉。']) }, {
      userId: USER,
      message: '今天什么都不想做。',
    });

    const deltas = events.filter((event) => event.type === 'text_delta');
    expect(deltas).toHaveLength(2);

    const completed = events.at(-1);
    expect(completed?.type).toBe('completed');
    expect(completed?.type === 'completed' && completed.text).toBe('听起来真的很沉。');
  });

  it('forwards the reasoning phase, which used to be dropped', async () => {
    // The reason this event type exists: the model thinks for a dozen seconds
    // before its first character, so without this the person watches a static
    // "…" and a streamed reply looks exactly like a non-streamed one.
    const withReasoning: TurnRunner = async function* () {
      yield { type: 'thinking_delta', text: '他说累，' };
      yield { type: 'thinking_delta', text: '但累可能不是重点。' };
      yield { type: 'thinking_done', elapsedMs: 12_000 };
      yield { type: 'text_delta', text: '听起来真的很沉。' };
      yield { type: 'completed', text: '听起来真的很沉。' };
    };

    const events = await drain({ store, runner: withReasoning }, {
      userId: USER,
      message: '今天什么都不想做。',
    });

    const thinking = events.filter((event) => event.type === 'thinking_delta');
    expect(
      thinking.map((event) => (event.type === 'thinking_delta' ? event.text : '')).join(''),
    ).toBe('他说累，但累可能不是重点。');

    // Ordering is part of the contract: reasoning, then its close, then reply.
    const types = events.map((event) => event.type);
    expect(types.indexOf('thinking_done')).toBeGreaterThan(types.indexOf('thinking_delta'));
    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text_delta'));
  });

  it('never persists the reasoning as part of the conversation', async () => {
    // The transcript is what the next turn is built from. Storing the model's
    // working-out would feed its own notes back to it as things it had said.
    const withReasoning: TurnRunner = async function* () {
      yield { type: 'thinking_delta', text: '内部推理，不该被存下来' };
      yield { type: 'thinking_done', elapsedMs: 900 };
      yield { type: 'text_delta', text: '嗯，我在。' };
      yield { type: 'completed', text: '嗯，我在。' };
    };

    await drain({ store, runner: withReasoning }, { userId: USER, message: '在吗' });

    const conversationId = (await store.listConversations(USER))[0]?.id as string;
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.map((message) => message.content)).toEqual(['在吗', '嗯，我在。']);
  });

  it('persists the user message, the reply, and a run row', async () => {
    const events = await drain({ store, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '在吗',
    });

    const completed = events.at(-1);
    const conversationId = completed?.type === 'completed' ? completed.conversationId : null;
    expect(conversationId).toBeTruthy();

    const messages = await store.listMessages(USER, conversationId as string);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('在吗');
    expect(messages[1]?.content).toBe('嗯。');

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('completed');
    expect(store.runs[0]?.riskLevel).toBe('none');
  });

  it('returns the stored assistant message id, which feedback is attached to', async () => {
    const events = await drain({ store, runner: fakeRunner('嗯。') }, { userId: USER, message: '在吗' });
    const completed = events.at(-1);
    expect(completed?.type === 'completed' && completed.messageId).toBeTruthy();
  });

  it('continues an existing conversation when given its id', async () => {
    const first = await drain({ store, runner: fakeRunner('第一句。') }, { userId: USER, message: '一' });
    const conversationId = completedOf(first)?.conversationId as string;
    expect(conversationId).toBeTruthy();

    const second = await drain({ store, runner: fakeRunner('第二句。') }, {
      userId: USER,
      conversationId,
      message: '二',
    });

    expect(completedOf(second)?.conversationId).toBe(conversationId);
    expect(await store.listMessages(USER, conversationId)).toHaveLength(4);
  });

  it('passes prior turns to the model as history, without duplicating the new message', async () => {
    const first = await drain({ store, runner: fakeRunner('第一句。') }, { userId: USER, message: '一' });
    const conversationId = completedOf(first)?.conversationId as string;

    let seen: { role: string; content: string }[] = [];
    const capturing: TurnRunner = async function* (_agent, message, options) {
      seen = [
        ...(options?.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: message },
      ];
      yield { type: 'completed', text: '第二句。' };
    };
    await drain({ store, runner: capturing }, { userId: USER, conversationId, message: '二' });

    // The new message must not also be in the history: the model would be
    // answering itself.
    expect(seen).toEqual([
      { role: 'user', content: '一' },
      { role: 'assistant', content: '第一句。' },
      { role: 'user', content: '二' },
    ]);
  });

  it('starts a new thread when the client does not name one', async () => {
    // What the client relies on: it sends no id on the first message and stores
    // the one that comes back.
    await drain({ store, runner: fakeRunner('第一句。') }, { userId: USER, message: '一' });

    let history: readonly unknown[] = ['unset'];
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      history = options?.history ?? [];
      yield { type: 'completed', text: '第二句。' };
    };
    await drain({ store, runner: capturing }, { userId: USER, message: '二' });

    expect(history).toEqual([]);
    expect(await store.listConversations(USER)).toHaveLength(2);
  });

  it('replays the earlier turn from the database on the next turn', async () => {
    await drain({ store, runner: fakeRunner('嗯。') }, { userId: USER, message: '在吗' });

    const conversationId = await store.listConversations(USER).then((list) => list[0]?.id as string);
    expect((await store.listMessages(USER, conversationId)).map((message) => message.content)).toEqual([
      '在吗',
      '嗯。',
    ]);

    let history: readonly unknown[] = [];
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      history = options?.history ?? [];
      yield { type: 'completed', text: '还在。' };
    };
    await drain({ store, runner: capturing }, { userId: USER, conversationId, message: '二' });

    // The model sees the previous turn even though no process-local cache
    // survived between the two calls.
    expect(history).toEqual([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '嗯。' },
    ]);
  });

  it('refuses an empty message without creating a conversation', async () => {
    const events = await drain({ store, runner: fakeRunner('嗯。') }, { userId: USER, message: '   ' });

    expect(events).toEqual([{ type: 'error', message: 'message is empty', retryable: false }]);
    expect(await store.listConversations(USER)).toEqual([]);
  });

  it('names the conversation after its first message, and only the first', async () => {
    // The name is what makes a list of conversations a list rather than a pile
    // of threads. It is derived here rather than asked for, because a companion
    // that opened by requesting a title would be asking the person to do filing.
    const first = await drain({ store, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '今天不想上班',
    });
    const conversationId = completedOf(first)?.conversationId as string;

    await drain({ store, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '而且我还没睡好',
      conversationId,
    });

    const conversation = (await store.listConversations(USER))[0];
    expect(conversation?.title).toBe('今天不想上班');
  });

  it('does not name a conversation it was told not to persist', async () => {
    // Evaluation turns run through this path. The conversation row itself is
    // still created — it scopes retrieval and the tools — but a named one would
    // put an evaluation prompt into the product's own history list.
    await drain({ store, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '这是评测用例',
      persist: false,
    });

    expect((await store.listConversations(USER))[0]?.title).toBeNull();
  });
});

describe('memory retrieval', () => {
  it('announces retrieval with counts, never content', async () => {
    await store.createMemory(USER, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
      importance: 0.7,
    });

    const events = await drain({ store, runner: fakeRunner('团子最近还好吗？') }, {
      userId: USER,
      message: '团子最近有点不吃饭',
    });

    const retrieved = events.find((event) => event.type === 'memory_retrieved');
    expect(retrieved).toBeDefined();
    // The person's private history does not go on the wire for a UI flourish.
    expect(JSON.stringify(retrieved)).not.toContain('团子');
    expect(retrieved?.type === 'memory_retrieved' && retrieved.count).toBe(1);
  });

  it('does not announce anything when nothing matched', async () => {
    const events = await drain({ store, runner: fakeRunner('嗯。') }, { userId: USER, message: '在吗' });
    expect(events.some((event) => event.type === 'memory_retrieved')).toBe(false);
  });

  it('tells the model what time it is in the trailing context, not the stable prompt', async () => {
    let instructions = '';
    let context = '';
    const capturing: TurnRunner = async function* (agent, _message, options) {
      instructions = agent.instructions as string;
      context = options?.context ?? '';
      yield { type: 'completed', text: '嗯。' };
    };

    await drain(
      {
        store,
        runner: capturing,
        now: () => new Date('2026-10-25T12:33:00Z'),
        timeZone: 'Asia/Shanghai',
      },
      { userId: USER, message: '这周末想出去' },
    );

    expect(context).toContain('2026年10月25日 星期日 20:33');
    expect(instructions).not.toContain('2026年10月25日');
  });

  it('puts retrieved memories into the trailing context for the turn', async () => {
    await store.createMemory(USER, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
    });

    let context = '';
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      context = options?.context ?? '';
      yield { type: 'completed', text: '嗯。' };
    };
    await drain({ store, runner: capturing }, { userId: USER, message: '团子最近有点不吃饭' });

    expect(context).toContain('团子');
  });

  it('honours retrieve: false — no retrieval, no context block', async () => {
    await store.createMemory(USER, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
      importance: 0.9,
    });

    let context = '';
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      context = options?.context ?? '';
      yield { type: 'completed', text: '嗯。' };
    };
    const events = await drain({ store, runner: capturing }, {
      userId: USER,
      message: '团子最近有点不吃饭',
      retrieve: false,
    });

    expect(events.some((event) => event.type === 'memory_retrieved')).toBe(false);
    expect(context).not.toContain('团子');
    // The memory is still there; it just was not consulted.
    expect(await store.listMemories(USER)).toHaveLength(1);
    expect(store.events.some((event) => event.action === 'retrieved')).toBe(false);
  });
});

describe('crisis turns buffer (ADR 008)', () => {
  it('withholds every delta until the reply has been checked', async () => {
    // The model's own deltas, if streamed, would already be on screen — and
    // replacing the message afterwards does not un-show them.
    const events = await drain(
      { store, runner: streamingRunner(['想开点，', '一切都会好的。']) },
      { userId: USER, message: '我不想活了' },
    );

    const deltas = events.filter((event) => event.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.type === 'text_delta' && deltas[0].text).toBe(CRISIS_FALLBACK);
    // Nothing before the check could have rendered a partial reply.
    expect(events.findIndex((event) => event.type === 'text_delta')).toBeGreaterThan(
      events.findIndex((event) => event.type === 'safety_notice'),
    );
  });

  it('withholds the reasoning too, not just the reply', async () => {
    // Reasoning is withheld for the same reason the reply is: a rendered
    // thought cannot be un-rendered, and reasoning that argued for a reply the
    // safety check then discarded is the last thing anyone should be shown.
    const reasoningThenReply: TurnRunner = async function* () {
      yield { type: 'thinking_delta', text: '他说不想活了，' };
      yield { type: 'thinking_delta', text: '我得先确认他此刻是否安全。' };
      yield { type: 'thinking_done', elapsedMs: 4200 };
      yield { type: 'text_delta', text: '别多想，加油。' };
      yield { type: 'completed', text: '别多想，加油。' };
    };

    const events = await drain({ store, runner: reasoningThenReply }, {
      userId: USER,
      message: '我不想活了',
    });

    expect(events.some((event) => event.type === 'thinking_delta')).toBe(false);
    expect(events.some((event) => event.type === 'thinking_done')).toBe(false);
    // The only text that reaches the screen is the checked reply.
    const deltas = events.filter((event) => event.type === 'text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.type === 'text_delta' && deltas[0].text).toBe(CRISIS_FALLBACK);
  });

  it('reports the substitution, so a caught regression is visible', async () => {
    const events = await drain({ store, runner: fakeRunner('别多想，加油。') }, {
      userId: USER,
      message: '我不想活了',
    });

    const notices = events.filter((event) => event.type === 'safety_notice');
    expect(notices[0]?.type === 'safety_notice' && notices[0].level).toBe('crisis');
    expect(notices.some((event) => event.type === 'safety_notice' && event.replaced)).toBe(true);
  });

  it('records the run as safety_replaced rather than as a normal completion', async () => {
    await drain({ store, runner: fakeRunner('别多想，加油。') }, { userId: USER, message: '我不想活了' });

    expect(store.runs[0]?.status).toBe('safety_replaced');
    expect(store.runs[0]?.riskLevel).toBe('crisis');
  });

  it('persists the reply the person actually received, not what the model wrote', async () => {
    // Otherwise the transcript would disagree with the screen, and every later
    // turn would be built on a reply that was never sent.
    await drain({ store, runner: fakeRunner('别多想，加油。') }, { userId: USER, message: '我不想活了' });

    const conversationId = (await store.listConversations(USER))[0]?.id as string;
    const messages = await store.listMessages(USER, conversationId);
    expect(messages[1]?.content).toBe(CRISIS_FALLBACK);
  });

  it('lets a good crisis reply through unchanged', async () => {
    const good =
      '我很担心你。你现在安全吗？如果情况紧急请打 120，全国心理援助热线是 12356，随时有人接。';
    const events = await drain({ store, runner: fakeRunner(good) }, {
      userId: USER,
      message: '我不想活了',
    });

    const completed = events.at(-1);
    expect(completed?.type === 'completed' && completed.text).toBe(good);
    expect(events.some((event) => event.type === 'safety_notice' && event.replaced)).toBe(false);
    expect(store.runs[0]?.status).toBe('completed');
  });

  it('does not buffer an ordinary turn', async () => {
    const events = await drain({ store, runner: streamingRunner(['听起来', '真的很沉。']) }, {
      userId: USER,
      message: '今天什么都不想做。',
    });
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(2);
  });

  it('does not buffer an elevated turn, only reports it', async () => {
    const events = await drain({ store, runner: streamingRunner(['我在。', '这阵子很重吧。']) }, {
      userId: USER,
      message: '我快崩溃了',
    });

    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(2);
    expect(events.some((event) => event.type === 'safety_notice' && event.level === 'elevated')).toBe(true);
    expect(store.runs[0]?.riskLevel).toBe('elevated');
  });

  it('gives the model the safety directive for a risky turn, and none otherwise', async () => {
    const directives: (string | null | undefined)[] = [];
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      directives.push((options?.context ?? '').includes('安全优先于人格设定') ? 'crisis' : null);
      yield { type: 'completed', text: '嗯。' };
    };

    await drain({ store, runner: capturing }, { userId: USER, message: '我不想活了' });
    await drain({ store, runner: capturing }, { userId: USER, message: '今天天气不错' });

    expect(directives).toEqual(['crisis', null]);
  });
});

describe('tool use', () => {
  it('collects tool calls and records them on the run', async () => {
    const runner = fakeRunner('好，我记住了。', [
      { type: 'tool_call', callId: 'c1', name: 'save_memory', displayable: true },
      { type: 'tool_result', callId: 'c1', name: 'save_memory', ok: true },
    ]);

    await drain({ store, runner }, { userId: USER, message: '记住我喜欢在晚上写东西' });

    expect(store.runs[0]?.usedTools).toBe(true);
    expect(store.runs[0]?.toolCalls).toEqual(['save_memory']);
  });

  it('offers the memory tools to the agent', async () => {
    let toolNames: string[] = [];
    const capturing: TurnRunner = async function* (agent) {
      toolNames = [...agent.tools.names()];
      yield { type: 'completed', text: '嗯。' };
    };
    await drain({ store, runner: capturing }, { userId: USER, message: '在吗' });

    expect(toolNames.sort()).toEqual(['save_memory', 'search_memory', 'update_memory']);
  });
});

describe('failure is contained', () => {
  it('reports a runner error and records the run as failed', async () => {
    const failing: TurnRunner = async function* () {
      yield { type: 'error', message: 'upstream 503', retryable: true };
    };

    const events = await drain({ store, runner: failing }, { userId: USER, message: '在吗' });

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('failed');
    expect(store.runs[0]?.error).toContain('503');
  });

  it('does not persist a reply for a failed turn', async () => {
    const failing: TurnRunner = async function* () {
      yield { type: 'error', message: 'boom', retryable: false };
    };
    await drain({ store, runner: failing }, { userId: USER, message: '在吗' });

    const conversationId = (await store.listConversations(USER))[0]?.id as string;
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user']);
  });

  it('still delivers the reply when persisting it fails', async () => {
    class FlakyStore extends InMemoryStore {
      override async appendMessage(message: Parameters<InMemoryStore['appendMessage']>[0]) {
        if (message.role === 'assistant') throw new Error('disk full');
        return super.appendMessage(message);
      }
    }
    const flaky = new FlakyStore();

    const events = await drain({ store: flaky, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '在吗',
    });

    const completed = events.at(-1);
    expect(completed?.type === 'completed' && completed.text).toBe('嗯。');
    expect(completed?.type === 'completed' && completed.messageId).toBeNull();
  });

  it('does not write anything at all when persist is false', async () => {
    // Evaluation turns run through this path: they are nobody's conversation,
    // and letting them in would corrupt the history being measured.
    const events = await drain(
      { store, runner: fakeRunner('嗯。') },
      { userId: USER, message: '在吗', persist: false },
    );

    const completed = completedOf(events);
    expect(completed?.conversationId).toBeNull();
    expect(completed?.messageId).toBeNull();
    expect(store.runs).toEqual([]);

    // No messages, and no conversation list entry with anything in it. The
    // conversation row itself is still created — it is what scopes retrieval and
    // the tools for the turn — but nothing is written into it.
    const conversations = await store.listConversations(USER);
    for (const conversation of conversations) {
      expect(await store.listMessages(USER, conversation.id)).toEqual([]);
    }
  });
});

describe('collectTurn', () => {
  it('drains a turn into its final reply', async () => {
    const result = await collectTurn({ store, runner: fakeRunner('听起来真的很沉。') }, {
      userId: USER,
      message: '今天什么都不想做。',
    });

    expect(result.reply).toBe('听起来真的很沉。');
    expect(result.riskLevel).toBe('none');
    expect(result.events.at(-1)?.type).toBe('completed');
  });

  it('does not persist by default', async () => {
    await collectTurn({ store, runner: fakeRunner('嗯。') }, { userId: USER, message: '在吗' });
    expect(store.runs).toEqual([]);
  });

  it('reports the highest risk level seen, not the last', async () => {
    const runner: TurnRunner = async function* () {
      yield { type: 'safety_notice', level: 'elevated', replaced: false };
      yield { type: 'completed', text: '我在。' };
    };
    const result = await collectTurn({ store, runner }, { userId: USER, message: '在吗' });
    expect(result.riskLevel).toBe('elevated');
  });

  it('returns an empty reply for an errored turn', async () => {
    const failing: TurnRunner = async function* () {
      yield { type: 'error', message: 'boom', retryable: false };
    };
    const result = await collectTurn({ store, runner: failing }, { userId: USER, message: '在吗' });
    expect(result.reply).toBe('');
  });
});

describe('interrupt and continue', () => {
  /**
   * A runner that streams a partial reply and then unwinds the way the real
   * loop does when its signal fires: an `error` saying "cancelled".
   */
  function interruptedRunner(pieces: string[]): TurnRunner {
    return async function* () {
      for (const piece of pieces) yield { type: 'text_delta', text: piece };
      yield { type: 'error', message: 'cancelled', retryable: false };
    };
  }

  it('keeps the part that was shown and records the turn as interrupted', async () => {
    const events = await drain(
      { store, runner: interruptedRunner(['听起来', '真的很沉。']) },
      { userId: USER, message: '今天什么都不想做。' },
    );

    // A stop is a normal ending; it must not reach the client as an error.
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe('interrupted');
    if (last?.type !== 'interrupted') throw new Error('expected an interrupted turn');

    expect(last.text).toBe('听起来真的很沉。');
    const conversationId = last.conversationId as string;
    const messages = await store.listMessages(USER, conversationId);
    expect(
      messages.map((message) => ({
        role: message.role,
        content: message.content,
        interrupted: message.interrupted,
      })),
    ).toEqual([
      { role: 'user', content: '今天什么都不想做。', interrupted: false },
      { role: 'assistant', content: '听起来真的很沉。', interrupted: true },
    ]);
    expect(last.messageId).toBe(messages[1]?.id);

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('interrupted');
    expect(store.runs[0]?.outputFingerprint).toContain('len=8');
  });

  it('stores nothing when the stop lands before the first visible character', async () => {
    const events = await drain(
      { store, runner: interruptedRunner([]) },
      { userId: USER, message: '在吗' },
    );

    const last = events.at(-1);
    expect(last?.type).toBe('interrupted');
    expect(last?.type === 'interrupted' && last.text).toBe('');
    expect(last?.type === 'interrupted' && last.messageId).toBeNull();

    const conversationId = (last?.type === 'interrupted' && last.conversationId) as string;
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user']);
    expect(store.runs[0]?.status).toBe('interrupted');
  });

  it('continues from the break, with the partial reply as history', async () => {
    const first = await drain(
      { store, runner: interruptedRunner(['睡不着的时候，']) },
      { userId: USER, message: '我最近睡不好。' },
    );
    const interrupted = first.at(-1);
    if (interrupted?.type !== 'interrupted') throw new Error('expected an interrupted turn');
    const conversationId = interrupted.conversationId as string;

    let seen: { role: string; content: string }[] = [];
    let context = '';
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      seen = (options?.history ?? []).map((turn) => ({ role: turn.role, content: turn.content }));
      context = options?.context ?? '';
      yield { type: 'text_delta', text: '我会先陪你坐一会儿。' };
      yield { type: 'completed', text: '我会先陪你坐一会儿。' };
    };

    const second = await drain(
      { store, runner: capturing },
      { userId: USER, conversationId, message: '继续', continue: true },
    );

    // The model sees the half-finished reply immediately before the new turn;
    // that adjacency is what makes it a continuation instead of a restart.
    expect(seen).toEqual([
      { role: 'user', content: '我最近睡不好。' },
      { role: 'assistant', content: '睡不着的时候，' },
    ]);
    expect(context).toContain('继续被打断的回复');
    expect(context).toContain('不要重新开头');

    expect(second.at(-1)?.type).toBe('completed');
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      '我最近睡不好。',
      '睡不着的时候，',
      '继续',
      '我会先陪你坐一会儿。',
    ]);
  });

  it('does not tell an ordinary turn that it is continuing anything', async () => {
    let context = '';
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      context = options?.context ?? '';
      yield { type: 'completed', text: '嗯。' };
    };

    await drain({ store, runner: capturing }, { userId: USER, message: '在吗' });

    expect(context).not.toContain('继续被打断的回复');
  });
});

describe('regeneration and attachments', () => {
  it('reruns the last user message without appending a duplicate', async () => {
    const first = await drain({ store, runner: fakeRunner('第一版。') }, {
      userId: USER,
      message: '第一句',
    });
    const conversationId = completedOf(first)?.conversationId as string;
    expect(conversationId).toBeTruthy();

    // The route removes the reply being replaced before starting the turn.
    const rewound = await new SessionService(store).rewind(USER, conversationId);
    expect(rewound?.removed).toBe(1);
    expect((await store.listMessages(USER, conversationId)).map((m) => m.content)).toEqual(['第一句']);

    let seenMessage = '';
    let seenHistory: { role: string; content: string }[] = [];
    const capturing: TurnRunner = async function* (_agent, message, options) {
      seenMessage = message;
      seenHistory = (options?.history ?? []).map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));
      yield { type: 'completed', text: '第二版。' };
    };

    const events = await drain(
      { store, runner: capturing },
      { userId: USER, conversationId, message: '', regenerate: true },
    );

    expect(completedOf(events)?.text).toBe('第二版。');
    expect(seenMessage).toBe('第一句');
    // The rerun message is the current input, not also a history entry.
    expect(seenHistory).toEqual([]);
    expect((await store.listMessages(USER, conversationId)).map((m) => m.content)).toEqual([
      '第一句',
      '第二版。',
    ]);
  });

  it('tells the model about attached files without inlining them', async () => {
    let context = '';
    const capturing: TurnRunner = async function* (_agent, _message, options) {
      context = options?.context ?? '';
      yield { type: 'completed', text: '看到了。' };
    };

    await drain(
      { store, runner: capturing },
      {
        userId: USER,
        message: '看看这个',
        attachments: [
          {
            path: '.eunoia/uploads/c1/shot.png',
            name: 'shot.png',
            mime: 'image/png',
            bytes: 2048,
          },
        ],
      },
    );

    expect(context).toContain('.eunoia/uploads/c1/shot.png');
    expect(context).toContain('image/png');
    expect(context).toContain('2.0 KB');
    // This model cannot see images; the prompt must not let it pretend it can.
    expect(context).toContain('图片不会作为视觉输入');
  });
});


/**
 * Finish reason and acceptance (ADR 029).
 *
 * These are the two verdicts the chat page and the run table read. They are
 * asserted together here because the interesting cases are the ones where they
 * disagree: output without completion, completion without success.
 */
describe('outcome reporting', () => {
  it('keeps the text of a cut stream and marks it incomplete', async () => {
    const cut: TurnRunner = async function* () {
      yield { type: 'text_delta', text: '说到一半' };
      yield { type: 'completed', text: '说到一半', finishReason: 'incomplete_stream' };
    };

    const events = await drain({ store, runner: cut }, { userId: USER, message: '说点' });
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: 'completed',
      text: '说到一半',
      finishReason: 'incomplete_stream',
      accepted: false,
    });
    const checks = last?.type === 'completed' ? last.acceptance ?? [] : [];
    expect(checks.find((entry) => entry.id === 'finished')?.ok).toBe(false);
    expect(checks.find((entry) => entry.id === 'has_output')?.ok).toBe(true);
  });

  it('accepts a normal answer', async () => {
    const events = await drain({ store, runner: fakeRunner('嗯。') }, {
      userId: USER,
      message: '在吗',
    });
    expect(events.at(-1)).toMatchObject({
      finishReason: 'completed',
      accepted: true,
    });
  });

  it('does not accept a turn whose tool call failed', async () => {
    const withFailure: TurnRunner = async function* () {
      yield {
        type: 'tool_call',
        callId: 'c1',
        name: 'write_file',
        displayable: true,
      };
      yield {
        type: 'tool_result',
        callId: 'c1',
        name: 'write_file',
        ok: false,
        error: 'permission denied',
      };
      yield { type: 'completed', text: '没改成。' };
    };

    const events = await drain({ store, runner: withFailure }, {
      userId: USER,
      message: '改一下',
    });
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: 'completed',
      finishReason: 'completed',
      accepted: false,
    });
    const checks = last?.type === 'completed' ? last.acceptance ?? [] : [];
    expect(checks.find((entry) => entry.id === 'tools_ok')?.ok).toBe(false);
  });

  it('settles the turn record with the finish reason and the verdict', async () => {
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER);
    const coordinator = new TurnCoordinator(store);
    const requestId = randomUUID();
    const admission = await coordinator.begin({
      requestId,
      userId: USER,
      conversationId: conversation.id,
      requestHash: turnRequestHash({
        kind: 'chat',
        userId: USER,
        conversationId: conversation.id,
        message: '在吗',
      }),
    });
    expect(admission.kind).toBe('started');

    await drain(
      { store, turns: coordinator, runner: fakeRunner('嗯。') },
      { userId: USER, conversationId: conversation.id, message: '在吗', requestId },
    );

    expect(await coordinator.get(requestId)).toMatchObject({
      status: 'completed',
      finishReason: 'completed',
      reply: '嗯。',
      accepted: true,
    });
    // The run row carries the same reason: statistics and the turn record must
    // not disagree about how a turn ended.
    expect(store.runs.at(-1)?.finishReason).toBe('completed');
  });

  it('settles an incomplete turn as not accepted', async () => {
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER);
    const coordinator = new TurnCoordinator(store);
    const requestId = randomUUID();
    await coordinator.begin({
      requestId,
      userId: USER,
      conversationId: conversation.id,
      requestHash: turnRequestHash({
        kind: 'chat',
        userId: USER,
        conversationId: conversation.id,
        message: '说点',
      }),
    });

    const cut: TurnRunner = async function* () {
      yield { type: 'text_delta', text: '断在这里' };
      yield { type: 'completed', text: '断在这里', finishReason: 'incomplete_stream' };
    };
    await drain(
      { store, turns: coordinator, runner: cut },
      { userId: USER, conversationId: conversation.id, message: '说点', requestId },
    );

    expect(await coordinator.get(requestId)).toMatchObject({
      status: 'completed',
      finishReason: 'incomplete_stream',
      reply: '断在这里',
      accepted: false,
    });
    expect(store.runs.at(-1)?.finishReason).toBe('incomplete_stream');
  });
});
