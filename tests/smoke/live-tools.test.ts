/**
 * A live tool-using turn.
 *
 * The offline suite can prove the loop, the sandbox and the event stream; it
 * cannot prove that DeepSeek accepts the request shape this project builds for
 * a function-calling turn. That is the same class of blind spot the original
 * streaming bug had, so it gets the same treatment: one real turn, gated behind
 * `RUN_SMOKE=1`, asserting only mechanical properties.
 *
 *     RUN_SMOKE=1 npm run smoke
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '../../src/agent/events.ts';
import { createCompanionAgent, streamReply } from '../../src/agent/infp-agent.ts';
import { installProvider } from '../../src/agent/model-client.ts';
import { installTracing } from '../../src/observability/tracing.ts';
import { codingTools } from '../../src/tools/coding/index.ts';
import { Workspace } from '../../src/tools/workspace.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';

const enabled = process.env.RUN_SMOKE === '1';

describe.skipIf(!enabled)('live tool turn', () => {
  it(
    'reads a file through the real provider and answers from its contents',
    async () => {
      installProvider();
      installTracing();
      const root = await mkdtemp(join(tmpdir(), 'eunoia-live-'));
      try {
        await writeFile(join(root, 'note.txt'), 'the secret word is orchid\n');
        const workspace = new Workspace({ root });
        const agent = createCompanionAgent({
          tools: codingTools,
          workspace,
          policy: { ...DEFAULT_TOOL_POLICY },
          maxSteps: 4,
        });

        const events: AgentEvent[] = [];
        for await (const event of streamReply(
          agent,
          '请读一下 note.txt，只告诉我里面的暗号是什么。',
        )) {
          events.push(event);
        }

        const errors = events.filter((event) => event.type === 'error');
        expect(errors, JSON.stringify(errors)).toEqual([]);

        const calls = events.filter((event) => event.type === 'tool_call');
        expect(calls.length, 'the model never called a tool').toBeGreaterThan(0);
        expect(calls.some((event) => event.type === 'tool_call' && event.name === 'read_file')).toBe(
          true,
        );

        const completed = events.at(-1);
        const text = completed?.type === 'completed' ? completed.text : '';
        expect(text.toLowerCase()).toContain('orchid');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
