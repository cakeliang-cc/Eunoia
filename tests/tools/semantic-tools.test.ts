/**
 * Semantic tools over a real workspace.
 *
 * The interesting assertion is the negative one: a same-named function in an
 * unrelated file is not a caller. Text search cannot make that distinction, and
 * that is the reason these tools exist.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceFiles } from '../../src/sandbox/workspace-files.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext, ToolDefinition } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import {
  diagnosticsTool,
  findDefinitionTool,
  findReferencesTool,
} from '../../src/tools/coding/semantic-tools.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function workspaceWith(files: Record<string, string>): Promise<{
  context: ToolContext;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-semantic-'));
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceFiles({ root });
  return {
    root,
    context: {
      workspace,
      policy: { ...DEFAULT_TOOL_POLICY, maxOutputChars: 40_000 },
      ledger: new TurnReadLedger(),
      now: new Date('2026-04-01T00:00:00Z'),
    },
  };
}

function output(result: { output: string; error?: string }): string {
  return result.output || result.error || '';
}

async function run(
  tool: ToolDefinition,
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; error?: string; meta?: Record<string, unknown> }> {
  const checked = tool.contract?.validate(args);
  if (!checked || !checked.ok) throw new Error(checked?.error ?? 'contract missing');
  const result = await tool.execute(checked.value, context);
  return {
    ok: result.ok,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta as Record<string, unknown> } : {}),
  };
}

const PROJECT = {
  'a.ts': [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    'export const unrelated = 1;',
  ].join('\n'),
  'b.ts': ["import { add } from './a';", 'export const sum = add(1, 2);'].join('\n'),
  'c.ts': ['function add() { return 0; }', 'export const x = add();'].join('\n'),
};

describe('find_definition', () => {
  it('resolves a cross-file import to its declaration', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findDefinitionTool, context, { path: 'b.ts', symbol: 'add' });
    expect(result.ok).toBe(true);
    expect(output(result)).toContain('a.ts:1');
    expect(output(result)).toContain('function add');
  });

  it('accepts a 1-based line and column', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findDefinitionTool, context, {
      path: 'b.ts',
      line: 2,
      column: 20,
    });
    expect(result.ok).toBe(true);
    expect(output(result)).toContain('a.ts:1');
  });

  it('refuses a language it does not understand instead of text-searching', async () => {
    const { context } = await workspaceWith({ ...PROJECT, 'script.py': 'def add():\n  pass\n' });
    const result = await run(findDefinitionTool, context, { path: 'script.py', symbol: 'add' });
    expect(result.ok).toBe(false);
    expect(output(result)).toContain('只支持 TypeScript/JavaScript');
  });

  it('explains a missing symbol', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findDefinitionTool, context, { path: 'b.ts', symbol: 'notThere' });
    expect(result.ok).toBe(false);
    expect(output(result)).toContain('could not resolve a position');
  });
});

describe('find_references', () => {
  it('finds the caller in another file and ignores a same-named local function', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findReferencesTool, context, { path: 'a.ts', symbol: 'add' });
    expect(result.ok).toBe(true);
    const text = output(result);
    expect(text).toContain('a.ts:1');
    expect(text).toContain('b.ts:2');
    // The unrelated `add` in c.ts is a different symbol.
    expect(text).not.toContain('c.ts');
  });

  it('can omit the declaration', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findReferencesTool, context, {
      path: 'a.ts',
      symbol: 'add',
      includeDeclaration: false,
    });
    const text = output(result);
    expect(text).toContain('b.ts:2');
    expect(text).not.toContain('a.ts:1');
  });

  it('reports when there are no references', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(findReferencesTool, context, {
      path: 'a.ts',
      symbol: 'unrelated',
    });
    // `unrelated` is exported and never used; the declaration itself may count.
    expect(result.ok).toBe(true);
    expect(output(result)).toContain('引用');
  });
});

describe('diagnostics', () => {
  it('reports a real type error with path, line and code', async () => {
    const { context } = await workspaceWith({
      ...PROJECT,
      'bad.ts': ["export const value: number = 'not a number';"].join('\n'),
    });
    const result = await run(diagnosticsTool, context, { path: 'bad.ts' });
    expect(result.ok).toBe(true);
    expect(output(result)).toContain('bad.ts:1');
    expect(output(result)).toContain('TS2322');
  });

  it('reports no diagnostics for a clean file', async () => {
    const { context } = await workspaceWith(PROJECT);
    const result = await run(diagnosticsTool, context, { path: 'a.ts' });
    expect(result.ok).toBe(true);
    expect(output(result)).toContain('没有诊断错误');
  });

  it('checks loaded files when no path is given', async () => {
    const { context } = await workspaceWith({
      'bad.ts': ["export const value: number = 'not a number';"].join('\n'),
    });
    const result = await run(diagnosticsTool, context, {});
    expect(output(result)).toContain('TS2322');
  });
});
