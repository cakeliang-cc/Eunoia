/**
 * The skill mechanism inside the loop.
 *
 * `load_skill` is only useful if its result reaches the next model step. This is
 * that end-to-end assertion without a provider: the first step calls the tool,
 * the second sees the body in its input, and the turn completes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgentLoop } from '../../src/agent/loop.ts';
import type { LoopInputItem, LoopOutputItem, ModelTurn } from '../../src/agent/model-port.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import type { Skill } from '../../src/skills/types.ts';
import { createSkillTools } from '../../src/tools/skill.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import { Workspace } from '../../src/tools/workspace.ts';

let root: string;
let workspace: Workspace;
let skill: Skill;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eunoia-skill-loop-'));
  workspace = new Workspace({ root });
  skill = {
    manifest: {
      name: 'demo-skill',
      description: '演示技能，在测试里使用。',
      allowedTools: ['read_file'],
      metadata: {},
    },
    root: join(workspace.root, 'skills', 'demo-skill'),
    entry: join(workspace.root, 'skills', 'demo-skill', 'SKILL.md'),
    body: 'SKILL_BODY_SENTINEL: 先做这个，再做那个。',
    source: 'project',
    hash: 'hash123',
    references: [],
    scripts: [],
    assets: [],
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skills in the loop', () => {
  it('feeds a loaded skill body into the next model step', async () => {
    const registry = new ToolRegistry(
      createSkillTools(new SkillRegistry([skill]), { availableTools: new Set(['read_file']) }),
    );
    const requests: LoopInputItem[][] = [];
    let step = 0;

    const model: ModelTurn = async function* (request) {
      requests.push([...request.input]);
      step += 1;
      if (step === 1) {
        const output: LoopOutputItem[] = [
          {
            type: 'function_call',
            callId: 'c1',
            name: 'load_skill',
            arguments: JSON.stringify({ name: 'demo-skill' }),
          },
        ];
        yield { type: 'done', output };
        return;
      }
      const output: LoopOutputItem[] = [
        { type: 'message', role: 'assistant', content: '已加载。' },
      ];
      yield { type: 'done', output };
    };

    const events: AgentEvent[] = [];
    for await (const event of runAgentLoop({
      modelTurn: model,
      instructions: 'stable',
      input: [{ type: 'message', role: 'user', content: '用这个技能' }],
      tools: registry,
      toolContext: {
        workspace,
        policy: DEFAULT_TOOL_POLICY,
        ledger: new TurnReadLedger(),
        now: new Date('2026-10-25T12:00:00Z'),
      },
      maxSteps: 4,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'tool_call' && event.name === 'load_skill')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'tool_result' && event.ok)).toBe(true);
    expect(requests[1]?.some((item) => item.type === 'function_call_result' && item.output.includes('SKILL_BODY_SENTINEL'))).toBe(
      true,
    );
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'completed', text: '已加载。' });
  });
});
