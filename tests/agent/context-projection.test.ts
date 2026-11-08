/**
 * A05–A09, A13, A23: structured background and the state baseline.
 *
 * These are pure functions. The value of testing them separately is that a
 * changed clock, a changed directory and a cleared memory have different update
 * rules, and a single rendered string cannot express that.
 */

import { describe, expect, it } from 'vitest';
import {
  planContext,
  projectRuntimeBlocks,
  renderBlock,
  type PlannedBlock,
} from '../../src/agent/context-projection.ts';
import { fitContext } from '../../src/agent/context-budget.ts';
import { policyDenial } from '../../src/tools/policy.ts';
import { defineTool, toolOk } from '../../src/tools/types.ts';
import { z } from 'zod';
import { canonicalJson, TRANSCRIPT_RENDER_VERSION } from '../../src/session/model-transcript.ts';
import type { ModelContextState } from '../../src/session/model-transcript.ts';

function stateOf(block: PlannedBlock): ModelContextState {
  return {
    conversationId: 'c1',
    epochId: 'e1',
    key: block.key,
    scope: block.scope,
    contentHash: block.hash,
    renderVersion: TRANSCRIPT_RENDER_VERSION,
    revision: block.revision,
    latestItemId: `item-${block.key}-${block.revision}`,
    cleared: block.cleared,
    updatedAt: new Date(),
  };
}

function statesFrom(blocks: readonly PlannedBlock[]): Map<string, ModelContextState> {
  return new Map(blocks.map((block) => [block.key, stateOf(block)]));
}

describe('A05: unchanged persistent background is not appended again', () => {
  it('appends a block once, then skips it on two identical turns', () => {
    const first = planContext(
      projectRuntimeBlocks({
        situationBlock: '现在是 2026-11-08 10:00',
        workspaceBlock: '目录 /workspace',
        relationshipBlock: '刚认识',
      }),
      new Map(),
      'r1',
    );
    expect(first.appends.map((block) => block.key)).toEqual([
      'relationship',
      'workspace',
      'clock',
    ]);

    let states = statesFrom(first.appends);
    for (const requestId of ['r2', 'r3']) {
      const next = planContext(
        projectRuntimeBlocks({
          situationBlock: '现在是 2026-11-08 10:00',
          workspaceBlock: '目录 /workspace',
          relationshipBlock: '刚认识',
        }),
        states,
        requestId,
      );
      expect(next.appends).toEqual([]);
      expect(next.skipped).toContain('relationship');
      expect(next.skipped).toContain('workspace');
      expect(next.skipped).toContain('clock');
      states = new Map<string, ModelContextState>([
        ...states,
        ...next.appends.map((block) => [block.key, stateOf(block)] as const),
      ]);
    }
  });

  it('does not resend the clock when only the minute changed in a later turn', () => {
    const first = planContext(
      projectRuntimeBlocks({ situationBlock: '现在是 10:00', workspaceBlock: '/workspace' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);
    const same = planContext(
      projectRuntimeBlocks({ situationBlock: '现在是 10:00', workspaceBlock: '/workspace' }),
      states,
      'r2',
    );
    expect(same.appends).toEqual([]);
    const later = planContext(
      projectRuntimeBlocks({ situationBlock: '现在是 10:01', workspaceBlock: '/workspace' }),
      states,
      'r3',
    );
    expect(later.appends.map((block) => block.key)).toEqual(['clock']);
    expect(later.appends[0]?.revision).toBe(2);
  });
});

describe('A06: a changed cwd is one new revision', () => {
  it('appends only workspace and keeps revision monotonic', () => {
    const first = planContext(
      projectRuntimeBlocks({ workspaceBlock: '目录 /workspace/a', situationBlock: '10:00' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);
    const changed = planContext(
      projectRuntimeBlocks({ workspaceBlock: '目录 /workspace/b', situationBlock: '10:00' }),
      states,
      'r2',
    );
    expect(changed.appends.map((block) => block.key)).toEqual(['workspace']);
    expect(changed.appends[0]?.revision).toBe(2);
    expect(renderBlock(changed.appends[0]!)).toContain('/workspace/b');
    expect(renderBlock(changed.appends[0]!)).not.toContain('/workspace/a');
  });
});

describe('A07: permission state is a block and execution uses the real policy', () => {
  const writeTool = defineTool({
    name: 'write_file',
    description: 'write a file',
    parameters: z.object({ path: z.string() }),
    sideEffect: 'workspace_write',
    readOnly: false,
    execute: async () => toolOk('written'),
  });

  it('appends the permission block when policy changes', () => {
    const first = planContext(
      projectRuntimeBlocks({ permissionBlock: '允许写入', workspaceBlock: '/workspace' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);
    const denied = planContext(
      projectRuntimeBlocks({ permissionBlock: '拒绝写入', workspaceBlock: '/workspace' }),
      states,
      'r2',
    );
    expect(denied.appends.map((block) => block.key)).toEqual(['permission']);
    expect(renderBlock(denied.appends[0]!)).toContain('拒绝写入');

    const denial = policyDenial(
      writeTool,
      {
        allowWorkspaceWrites: false,
        allowCommands: false,
        maxOutputChars: 1000,
      },
      false,
    );
    expect(denial).not.toBeNull();
    expect(denial).toContain('写入');
  });
});

describe('A08: clearing a persistent block is an explicit tombstone', () => {
  it('tombstones on clear and reactivates with a new revision', () => {
    const first = planContext(
      projectRuntimeBlocks({ narrativeBlock: '正在准备考试' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);

    const cleared = planContext(projectRuntimeBlocks({}), states, 'r2');
    expect(cleared.appends).toEqual([]);
    expect(cleared.cleared).toHaveLength(1);
    expect(cleared.cleared[0]?.key).toBe('narrative');
    expect(cleared.cleared[0]?.cleared).toBe(true);
    expect(renderBlock(cleared.cleared[0]!)).toContain('已被系统清空');
    expect(renderBlock(cleared.cleared[0]!)).not.toContain('正在准备考试');

    const clearedStates = new Map(states);
    clearedStates.set('narrative', stateOf(cleared.cleared[0]!));
    const restored = planContext(
      projectRuntimeBlocks({ narrativeBlock: '考试结束了' }),
      clearedStates,
      'r3',
    );
    expect(restored.appends.map((block) => block.key)).toEqual(['narrative']);
    expect(restored.appends[0]?.revision).toBe(3);
    expect(restored.appends[0]?.cleared).toBe(false);
  });
});

describe('A09: turn-scoped blocks and the clock', () => {
  it('repeats identical turn data but not the clock', () => {
    const first = planContext(
      projectRuntimeBlocks({ situationBlock: '10:00', memoryBlock: '相关记忆' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);
    const second = planContext(
      projectRuntimeBlocks({ situationBlock: '10:00', memoryBlock: '相关记忆' }),
      states,
      'r2',
    );
    expect(second.appends.map((block) => block.key)).toEqual(['retrievedMemory']);
    expect(second.appends[0]?.requestId).toBe('r2');
    expect(renderBlock(second.appends[0]!)).toContain('只适用于本回合');
  });

  it('does not tombstone a turn-scoped block that is simply absent', () => {
    const first = planContext(
      projectRuntimeBlocks({ continuationBlock: '继续上一条', safetyDirective: '安全指令' }),
      new Map(),
      'r1',
    );
    const states = statesFrom(first.appends);
    const next = planContext(projectRuntimeBlocks({}), states, 'r2');
    expect(next.cleared).toEqual([]);
  });

  it('orders a fresh turn deterministically', () => {
    const plan = planContext(
      projectRuntimeBlocks({
        safetyDirective: 'safety',
        memoryBlock: 'memory',
        situationBlock: '10:00',
        workspaceBlock: '/workspace',
        permissionBlock: 'read',
        toolGuidelines: 'guidelines',
        skillsBlock: 'skills',
        relationshipBlock: 'relationship',
        narrativeBlock: 'narrative',
        attachmentsBlock: 'files',
        continuationBlock: 'continue',
        archivedSummaryBlock: 'summary',
      }),
      new Map(),
      'r1',
    );
    expect(plan.appends.map((block) => block.key)).toEqual([
      'relationship',
      'narrative',
      'permission',
      'workspace',
      'skills',
      'toolGuidelines',
      'clock',
      'retrievedMemory',
      'attachments',
      'continuation',
      'safetyDirective',
      'archivedSummary',
    ]);
  });
});

describe('A13: canonical form only for application blocks', () => {
  it('sorts object keys for hashing without rewriting content', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const plan = planContext(
      projectRuntimeBlocks({ workspaceBlock: '  path with  spaces\nline  ' }),
      new Map(),
      'r1',
    );
    expect(plan.appends[0]?.content).toBe('path with  spaces\nline');
    expect(renderBlock(plan.appends[0]!)).toContain('path with  spaces\nline');
  });
});

describe('A23: a background user message does not move the protected boundary', () => {
  it('protects the real user turn even when background is the last user role', () => {
    const result = fitContext({
      instructions: 'system',
      tools: [],
      budget: { windowTokens: 120, outputReserveTokens: 10, safetyBufferTokens: 10 },
      items: [
        { type: 'message', role: 'user', content: 'real request' },
        { type: 'message', role: 'assistant', content: 'x'.repeat(400) },
        {
          type: 'message',
          role: 'user',
          content: 'background note',
          source: 'background',
          turnId: 't1',
        },
      ],
    });
    expect(result.droppedItems).toBe(0);
    expect(result.exhausted).toBe(true);
  });
});
