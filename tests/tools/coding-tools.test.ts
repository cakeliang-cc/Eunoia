/**
 * The coding tools through their real execute path.
 *
 * The loop's policy tests cover refusal; these cover the part a policy cannot
 * fix: that a read is line-numbered, that a second identical read becomes a
 * pointer, that a write/ edit reports what changed, and that a missing workspace
 * is a model-visible error rather than an exception that ends the turn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runCommandTool,
  writeFileTool,
} from '../../src/tools/coding/index.ts';
import { summarizeToolCall, summarizeToolResult } from '../../src/tools/summary.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { Workspace } from '../../src/tools/workspace.ts';

let base: string;
let workspace: Workspace;
let context: ToolContext;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'eunoia-tools-'));
  workspace = new Workspace({ root: base });
  context = {
    workspace,
    policy: { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true, allowCommands: true },
    ledger: new TurnReadLedger(),
    now: new Date('2026-10-25T12:00:00Z'),
  };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('read_file', () => {
  it('returns numbered content and a summary', async () => {
    await writeFile(join(base, 'a.ts'), 'one\ntwo\nthree\n');
    const result = await readFileTool.execute({ path: 'a.ts' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('     1\tone');
    expect(result.meta?.summary).toContain('读取 a.ts');
  });

  it('answers a repeated read with a pointer instead of the same bytes', async () => {
    await writeFile(join(base, 'a.ts'), 'one\ntwo\n');
    const first = await readFileTool.execute({ path: 'a.ts' }, context);
    const second = await readFileTool.execute({ path: 'a.ts' }, context);
    expect(first.meta?.ledgerHit).toBeUndefined();
    expect(second.meta?.ledgerHit).toBe(true);
    expect(second.output).toContain('已经在本次对话的上文里');
    expect(second.output).not.toContain('one');
  });

  it('re-reads after the file changes', async () => {
    await writeFile(join(base, 'a.ts'), 'one\n');
    await readFileTool.execute({ path: 'a.ts' }, context);
    await writeFile(join(base, 'a.ts'), 'one changed\n');
    const again = await readFileTool.execute({ path: 'a.ts' }, context);
    expect(again.meta?.ledgerHit).toBeUndefined();
    expect(again.output).toContain('one changed');
  });

  it('reports a missing workspace as a tool error', async () => {
    const result = await readFileTool.execute({ path: 'a.ts' }, { ...context, workspace: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('WORKSPACE_ROOT');
  });

  it('returns an error result for an escaping path rather than throwing', async () => {
    const result = await readFileTool.execute({ path: '../secret' }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escapes');
  });
});

describe('list_dir and glob', () => {
  it('lists a tree', async () => {
    await writeFile(join(base, 'a.ts'), '');
    const result = await listDirTool.execute({ path: '.' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.ts');
  });

  it('finds files by glob', async () => {
    await writeFile(join(base, 'a.ts'), '');
    const result = await globTool.execute({ pattern: '**/*.ts' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.ts');
  });
});

describe('grep', () => {
  it('returns path:line: text', async () => {
    await writeFile(join(base, 'a.ts'), 'const needle = 1;\n');
    const result = await grepTool.execute({ pattern: 'needle' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.ts:1:');
  });
});

describe('write_file and edit_file', () => {
  it('writes and then edits a file', async () => {
    const written = await writeFileTool.execute(
      { path: 'src/a.ts', content: 'const a = 1;\n' },
      context,
    );
    expect(written.ok).toBe(true);
    expect(await readFile(join(base, 'src/a.ts'), 'utf8')).toBe('const a = 1;\n');

    const edited = await editFileTool.execute(
      { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      context,
    );
    expect(edited.ok).toBe(true);
    expect(edited.meta?.replacements).toBe(1);
    expect(await readFile(join(base, 'src/a.ts'), 'utf8')).toBe('const a = 2;\n');
  });

  it('reports a non-unique edit as a tool error the model can act on', async () => {
    await writeFile(join(base, 'a.ts'), 'x\nx\n');
    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'x', new_string: 'y' },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('appears 2 times');
  });
});

describe('run_command', () => {
  it('formats exit code and output', async () => {
    const result = await runCommandTool.execute({ command: 'printf hello' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('exit code: 0');
    expect(result.output).toContain('hello');
  });

  it('keeps output on a non-zero exit and marks the result failed', async () => {
    const result = await runCommandTool.execute(
      { command: 'printf "the assertion failed"; exit 1' },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('code 1');
    expect(result.output).toContain('the assertion failed');
  });
});

describe('summaries', () => {
  it('describe the step without leaking file content', () => {
    expect(summarizeToolCall('read_file', { path: 'src/a.ts', start: 1, end: 40 })).toBe(
      '读取 src/a.ts:1-40',
    );
    expect(summarizeToolCall('edit_file', { path: 'src/a.ts', old_string: 'secret' })).toBe(
      '修改 src/a.ts',
    );
    expect(
      summarizeToolResult('read_file', {
        ok: true,
        output: '...',
        meta: { read: { path: 'src/a.ts', start: 1, end: 40, complete: false, chars: 1, mtimeMs: 1, size: 1 } },
      }),
    ).toContain('读取 1-40 行');
  });
});
