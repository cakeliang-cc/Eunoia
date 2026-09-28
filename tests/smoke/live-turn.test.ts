/**
 * Real turns against the live DeepSeek endpoint.
 *
 * Gated behind `RUN_SMOKE=1` because it costs money and needs a credential —
 * `npm test` must stay offline, fast, and deterministic. Run it with:
 *
 *     RUN_SMOKE=1 npm run smoke
 *
 * These tests assert only mechanical properties: the stream produces text, the
 * turn terminates, the reply is non-empty. They deliberately do not score the
 * reply's quality — that is the evaluation framework's job, and an assertion
 * about tone here would be a guess dressed up as a test.
 *
 * ## Why the multi-turn case is here and not in the offline suite
 *
 * Passing prior turns to the Responses API requires an asymmetric input shape:
 * a user turn is a plain string, while an assistant turn must carry `status` and
 * its content as typed parts. Sending an assistant turn in the user's shape is a
 * 400 from the provider — and no offline test can tell you that, because the
 * offline tests replace the thing that would reject it. Phase 1 learned this the
 * hard way when the SDK's event renaming silently produced zero deltas while
 * every offline test stayed green. This is the same class of bug, so it gets the
 * same treatment.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.ts';
import { buildRunInput, createCompanionAgent, streamReply } from '../../src/agent/infp-agent.ts';
import { installProvider } from '../../src/agent/model-client.ts';

const enabled = process.env.RUN_SMOKE === '1';

function collect(events: AgentEvent[]) {
  const errors = events.filter((event) => event.type === 'error');
  const completed = events.find((event) => event.type === 'completed');
  return {
    errors,
    deltas: events.filter((event) => event.type === 'text_delta'),
    thinking: events.filter((event) => event.type === 'thinking_delta'),
    thinkingDone: events.filter((event) => event.type === 'thinking_done'),
    toolCalls: events.filter((event) => event.type === 'tool_call'),
    text: completed?.type === 'completed' ? completed.text : '',
  };
}

describe.skipIf(!enabled)('live smoke turn', () => {
  it(
    'streams a reply and terminates with a completed event',
    async () => {
      installProvider();
      const agent = createCompanionAgent();

      const events: AgentEvent[] = [];
      for await (const event of streamReply(agent, '今天真的什么都不想做。')) {
        events.push(event);
      }

      const { errors, deltas, text } = collect(events);
      expect(errors, `run errored: ${JSON.stringify(errors)}`).toEqual([]);
      expect(deltas.length).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);
    },
    90_000,
  );

  it(
    'forwards the reasoning phase, which is where the wait actually goes',
    async () => {
      // The wire shape this asserts cannot be checked offline. The SDK
      // normalises `response.output_text.delta` to `output_text_delta` but
      // passes reasoning through *unnormalised*, wrapped under a generic `model`
      // type — so the fields sit one level deeper and a matcher written by
      // analogy with the text one finds nothing at all. When that happened, the
      // reply still completed and every offline test stayed green: the only
      // symptom was a person watching a static "…" for twelve seconds.
      installProvider();
      const agent = createCompanionAgent();

      const events: AgentEvent[] = [];
      for await (const event of streamReply(agent, '你觉得人为什么会觉得累？')) {
        events.push(event);
      }

      const { errors, thinking, thinkingDone, deltas, text } = collect(events);
      expect(errors, `run errored: ${JSON.stringify(errors)}`).toEqual([]);

      // Required, not reported: a reasoning model that produced no reasoning is
      // a change in the wire contract, which is the entire subject of this test.
      expect(
        thinking.length,
        'no thinking_delta arrived — the provider event name or nesting has changed',
      ).toBeGreaterThan(0);

      // At most once, and never before the reasoning it closes.
      expect(thinkingDone).toHaveLength(1);
      const types = events.map((event) => event.type);
      expect(types.indexOf('thinking_done')).toBeGreaterThan(types.lastIndexOf('thinking_delta'));

      // The reasoning is a preamble to the reply, not a substitute for it.
      expect(deltas.length).toBeGreaterThan(0);
      expect(types.indexOf('thinking_delta')).toBeLessThan(types.indexOf('text_delta'));
      expect(text.length).toBeGreaterThan(0);
    },
    90_000,
  );

  it(
    'accepts a prior assistant turn in the shape the Responses API requires',
    async () => {
      // The exact thing that cannot be checked offline. If the assistant item's
      // shape is wrong the provider rejects the whole request, so a passing run
      // here is the assertion.
      installProvider();
      const agent = createCompanionAgent();

      const input = buildRunInput('那我应该怎么办？', [
        { role: 'user', content: '我最近总是睡不好。' },
        { role: 'assistant', content: '睡不好这件事，是从什么时候开始的？' },
      ]);
      expect(Array.isArray(input)).toBe(true);
      expect(input).toHaveLength(3);

      const events: AgentEvent[] = [];
      for await (const event of streamReply(agent, '那我应该怎么办？', {
        history: [
          { role: 'user', content: '我最近总是睡不好。' },
          { role: 'assistant', content: '睡不好这件事，是从什么时候开始的？' },
        ],
      })) {
        events.push(event);
      }

      const { errors, text } = collect(events);
      expect(errors, `multi-turn run errored: ${JSON.stringify(errors)}`).toEqual([]);
      expect(text.length).toBeGreaterThan(0);
      // The reply should be a continuation, not a fresh start — but that is a
      // quality judgement, so it is not asserted here.
    },
    90_000,
  );

  it(
    'runs a real memory turn end to end, tools and persistence included',
    async () => {
      // The full service path: retrieval, the SDK tool loop, the output check,
      // and the store. This is the only test that exercises the agent and the
      // database in the same breath.
      installProvider();
      const { InMemoryStore } = await import('../../src/db/in-memory-store.ts');
      const { collectTurn } = await import('../../src/service/chat.ts');

      const store = new InMemoryStore();
      const userId = 'smoke-user';

      // `persist: true` on purpose. The default is false because the evaluation
      // runner must not write into anyone's history, but a smoke test that
      // skipped persistence would test the one thing already covered offline and
      // skip the thing that is not.
      const first = await collectTurn(
        { store },
        { userId, message: '记住一件事：我讨厌香菜，以后别推荐带香菜的。', persist: true },
      );
      expect(first.events.some((event) => event.type === 'error'), JSON.stringify(first.events)).toBe(
        false,
      );
      expect(first.reply.length).toBeGreaterThan(0);

      const second = await collectTurn(
        { store },
        { userId, message: '晚上吃什么好？', persist: true },
      );
      expect(second.events.some((event) => event.type === 'error'), JSON.stringify(second.events)).toBe(
        false,
      );
      expect(second.reply.length).toBeGreaterThan(0);

      // The turn is recorded — which means the audit row and the message pair
      // both survived the live path, not just the fake one.
      expect(store.runs.length).toBe(2);
      const memories = await store.listMemories(userId, { statuses: ['active', 'unconfirmed'] });
      const saved = memories.filter((memory) => memory.content.includes('香菜'));
      // `save_memory` is a model decision, so this is reported rather than
      // required: a run where the model chose not to save is a prompt-quality
      // finding for the evaluation suite, not a broken transport.
      if (saved.length === 0) {
        console.warn(`[smoke] the model did not save the 香菜 preference; memories=${memories.length}`);
      }
    },
    120_000,
  );
});
