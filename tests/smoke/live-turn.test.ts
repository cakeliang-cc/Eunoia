/**
 * A real turn against the live DeepSeek endpoint.
 *
 * Gated behind `RUN_SMOKE=1` because it costs money and needs a credential —
 * `npm test` must stay offline, fast, and deterministic. Run it with:
 *
 *     RUN_SMOKE=1 npm run smoke
 *
 * This test asserts only mechanical properties: the stream produces text and
 * terminates with a `completed` event carrying the same reply. It deliberately
 * does not score the reply's quality — that is the evaluation framework's job
 * in Phase 3, and an assertion about tone here would be a guess dressed up as a
 * test.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.ts';
import { createCompanionAgent, streamReply } from '../../src/agent/infp-agent.ts';
import { installProvider } from '../../src/agent/model-client.ts';

const enabled = process.env.RUN_SMOKE === '1';

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

      const errors = events.filter((e) => e.type === 'error');
      expect(errors, `run errored: ${JSON.stringify(errors)}`).toEqual([]);

      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas.length).toBeGreaterThan(0);

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed && completed.type === 'completed' && completed.text.length).toBeGreaterThan(0);

      // A single-turn reply should not need tools in Phase 1 — memory tools do
      // not exist yet.
      const toolCalls = events.filter((e) => e.type === 'tool_call');
      expect(toolCalls).toEqual([]);
    },
    90_000,
  );
});
