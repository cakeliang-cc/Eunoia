/**
 * The `change_directory` tool's own contract (ADR 021 §5).
 *
 * The tool is a formatter: it must not decide anything, and it must not ask the
 * model for context. These tests pin the two properties that are easy to break —
 * the schema is only `path`, and every runtime outcome is rendered as a
 * structured result rather than thrown into the loop's generic failure.
 */

import { describe, expect, it } from 'vitest';
import { changeDirectoryTool } from '../../src/tools/coding/change-directory-tool.ts';
import type { ToolContext, ToolCwdPort } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';

function context(cwd: ToolCwdPort | null): ToolContext {
  return {
    workspace: null,
    executor: null,
    cwd,
    policy: { ...DEFAULT_TOOL_POLICY, allowCommands: true },
    ledger: new TurnReadLedger(),
    toolCallId: 'call-1',
    now: new Date('2026-11-01T12:00:00.000Z'),
  };
}

describe('change_directory', () => {
  it('accepts only a path from the model', () => {
    const schema = changeDirectoryTool.parameters;
    const parsed = schema.safeParse({
      path: 'src',
      taskId: 'task-other',
      workspaceRoot: '/etc',
      cwdVersion: 99,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Unknown keys are stripped, so a model cannot smuggle runtime context in.
    expect(Object.keys(parsed.data as Record<string, unknown>)).toEqual(['path']);
  });

  it('requires a non-empty path', () => {
    expect(changeDirectoryTool.parameters.safeParse({ path: '' }).success).toBe(false);
    expect(changeDirectoryTool.parameters.safeParse({}).success).toBe(false);
  });

  it('reports the new directory on success', async () => {
    const seen: string[] = [];
    const port: ToolCwdPort = {
      change: async (input) => {
        seen.push(input.path);
        return {
          ok: true,
          previousCwd: '/workspace',
          cwd: '/workspace/src',
          cwdVersion: 2,
          workspaceRoot: '/workspace',
        };
      },
      current: async () => ({ cwd: '/workspace', workspaceRoot: '/workspace', cwdVersion: 1 }),
    };
    const result = await changeDirectoryTool.execute({ path: 'src' }, context(port));
    expect(seen).toEqual(['src']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('/workspace/src');
    expect(result.meta).toMatchObject({ cwd: '/workspace/src', cwdVersion: 2 });
  });

  it('passes the tool call id as the idempotency handle', async () => {
    let operationId: string | undefined;
    const port: ToolCwdPort = {
      change: async (input) => {
        operationId = input.operationId;
        return {
          ok: true,
          previousCwd: '/workspace',
          cwd: '/workspace/src',
          cwdVersion: 2,
          workspaceRoot: '/workspace',
        };
      },
      current: async () => ({ cwd: '/workspace', workspaceRoot: '/workspace', cwdVersion: 1 }),
    };
    await changeDirectoryTool.execute({ path: 'src' }, context(port));
    expect(operationId).toBe('call-1');
  });

  it('returns a structured error instead of throwing', async () => {
    const port: ToolCwdPort = {
      change: async () => ({
        ok: false,
        error: 'PATH_OUTSIDE_WORKSPACE',
        message: 'the requested directory is outside the task workspace',
      }),
      current: async () => ({ cwd: '/workspace', workspaceRoot: '/workspace', cwdVersion: 1 }),
    };
    const result = await changeDirectoryTool.execute({ path: '../..' }, context(port));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('PATH_OUTSIDE_WORKSPACE');
    expect(result.meta).toMatchObject({ cwdError: true });
  });

  it('refuses when no task working directory is configured', async () => {
    const result = await changeDirectoryTool.execute({ path: 'src' }, context(null));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('沙箱');
  });

  it('is not treated as read-only by the loop', () => {
    // Two concurrent directory changes on one task must not be dispatched in
    // parallel with each other (ADR §10.4).
    expect(changeDirectoryTool.readOnly).toBe(false);
    expect(changeDirectoryTool.sideEffect).toBe('workspace_state');
  });
});
