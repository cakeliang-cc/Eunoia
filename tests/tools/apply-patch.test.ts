/**
 * Multi-file patch: preflight, context matching, rollback and undo journal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFiles } from '../../src/sandbox/workspace-files.ts';
import { applyPatchTool, applyHunks, parsePatch, planPatch, PatchError } from '../../src/tools/coding/apply-patch.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(files: Record<string, string>): Promise<{ context: ToolContext; root: string; journal: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-patch-'));
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), body);
  }
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const journal: string[] = [];
  return {
    root,
    journal,
    context: {
      workspace: new WorkspaceFiles({ root }),
      policy: { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true, maxOutputChars: 40_000 },
      ledger: new TurnReadLedger(),
      now: new Date('2026-10-01T00:00:00Z'),
      changes: {
        beforeWrite: async (path) => {
          journal.push(path);
        },
      },
    },
  };
}

async function run(context: ToolContext, patch: string, dry = false) {
  const checked = applyPatchTool.contract?.validate({ patch, dry_run: dry });
  if (!checked || !checked.ok) throw new Error(checked?.error ?? 'contract missing');
  return applyPatchTool.execute(checked.value, context);
}

const PATCH = `*** Begin Patch
*** Add File: src/new.ts
+export const created = true;
*** Update File: src/app.ts
@@
 const answer = 42;
-export const old = true;
+export const modern = true;
*** Update File: src/move.ts
*** Move to: src/moved.ts
@@
-export const move = 1;
+export const move = 2;
*** Delete File: src/gone.ts
*** End Patch
`;

describe('parse and plan', () => {
  it('parses add/update/move/delete and preserves context', () => {
    const operations = parsePatch(PATCH);
    expect(operations.map((operation) => operation.kind)).toEqual([
      'add',
      'update',
      'update',
      'delete',
    ]);
    const plan = planPatch(operations, (path) => {
      const files: Record<string, string> = {
        'src/app.ts': 'const answer = 42;\nexport const old = true;\n',
        'src/move.ts': 'export const move = 1;\n',
        'src/gone.ts': 'gone\n',
      };
      return files[path] ?? null;
    });
    expect(plan.files).toHaveLength(4);
    expect(plan.moves).toEqual([{ from: 'src/move.ts', to: 'src/moved.ts' }]);
    expect(plan.writes.get('src/app.ts')).toContain('export const modern = true;');
  });

  it('rejects an ambiguous hunk instead of guessing', () => {
    const original = 'same\nsame\n';
    expect(() =>
      applyHunks('a.ts', original, [{ context: ['same'], removed: [], added: ['changed'] }]),
    ).toThrow(PatchError);
  });

  it('rejects an unmatched hunk, a missing file and a duplicate target', () => {
    expect(() =>
      applyHunks('a.ts', 'one\n', [{ context: [], removed: ['nope'], added: ['x'] }]),
    ).toThrow(/不匹配/);
    expect(() =>
      planPatch(parsePatch('*** Begin Patch\n*** Update File: missing.ts\n@@\n-a\n+b\n*** End Patch'), () => null),
    ).toThrow(/不存在/);
    expect(() =>
      parsePatch(
        '*** Begin Patch\n*** Delete File: a.ts\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch',
      ),
    ).toThrow(/重复/);
  });

  it('keeps CRLF line endings', () => {
    const result = applyHunks('a.ts', 'a\r\nb\r\n', [
      { context: ['a'], removed: ['b'], added: ['c'] },
    ]);
    expect(result.text).toBe('a\r\nc\r\n');
  });
});

describe('apply_patch tool', () => {
  it('applies all four operations and journals every touched path', async () => {
    const { context, root, journal } = await setup({
      'src/app.ts': 'const answer = 42;\nexport const old = true;\n',
      'src/move.ts': 'export const move = 1;\n',
      'src/gone.ts': 'gone\n',
    });
    const result = await run(context, PATCH);
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe('export const created = true;\n');
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('export const modern = true;');
    expect(await readFile(join(root, 'src/moved.ts'), 'utf8')).toContain('export const move = 2;');
    await expect(readFile(join(root, 'src/move.ts'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'src/gone.ts'), 'utf8')).rejects.toThrow();
    expect(new Set(journal)).toEqual(
      new Set(['src/new.ts', 'src/app.ts', 'src/moved.ts', 'src/move.ts', 'src/gone.ts']),
    );
  });

  it('does not write in dry-run mode', async () => {
    const { context, root, journal } = await setup({
      'src/app.ts': 'const answer = 42;\nexport const old = true;\n',
    });
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-export const old = true;\n+export const modern = true;\n*** End Patch';
    const result = await run(context, patch, true);
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('old = true');
    expect(journal).toEqual([]);
  });

  it('rolls back files already written when a later delete fails', async () => {
    const { context, root } = await setup({
      'src/app.ts': 'const answer = 42;\nexport const old = true;\n',
      'src/gone.ts': 'gone\n',
    });
    const base = context.workspace as WorkspaceFiles;
    const withoutDelete: ToolContext = {
      ...context,
      workspace: {
        readLines: base.readLines.bind(base),
        stat: base.stat.bind(base),
        writeText: base.writeText.bind(base),
      } as never,
    };
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-export const old = true;\n+export const modern = true;\n*** Delete File: src/gone.ts\n*** End Patch';
    const result = await run(withoutDelete, patch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('回滚');
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('old = true');
    expect(await readFile(join(root, 'src/gone.ts'), 'utf8')).toBe('gone\n');
  });

  it('refuses a patch with no begin marker', async () => {
    const { context } = await setup({});
    const result = await run(context, 'nonsense');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('*** Begin Patch');
  });
});
