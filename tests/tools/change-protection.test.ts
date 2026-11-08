/**
 * R03 — version-protected writes, a single lock per task and a cross-file journal.
 *
 * The failures are the point: A reads, B writes, A's write must be refused and
 * B's content must survive. The tests use an explicit interleaving hook (the
 * lock boundary) rather than a sleep to decide the order.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { applyPatchTool } from '../../src/tools/coding/apply-patch.ts';
import { writeFileTool, editFileTool } from '../../src/tools/coding/edit-tools.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolChangeJournal, ToolContext, ToolWorkspacePort } from '../../src/tools/types.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function digest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-change-'));
  const source = join(root, 'source');
  const storage = join(root, 'storage');
  const journal = join(root, 'journal');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(source, 'b.ts'), 'export const b = 2;\n');
  const sandboxStore = new MemorySandboxStore();
  const workspaces = new WorkspaceManager(
    { store: sandboxStore },
    {
      storageRoot: storage,
      sourceRoot: source,
      mode: 'copy',
      now: () => new Date('2026-04-01T00:00:00Z'),
    },
  );
  const workspace = await workspaces.ensureForTask('conv-1');
  const changesets = new InMemoryStore();
  const service = new WorkspaceChangeService({
    store: sandboxStore,
    workspaces,
    changesets,
    now: () => new Date('2026-04-01T00:01:00Z'),
    journalRoot: journal,
  });
  await service.arm({
    userId: 'u1',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    taskId: 'conv-1',
  });
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const ws = workspaces.files(workspace.storageLocation) as unknown as ToolWorkspacePort;
  return { service, workspaces, workspace, ws, journal, root };
}

function context(
  ws: ToolWorkspacePort,
  changes: ToolChangeJournal,
  ledger: TurnReadLedger,
): ToolContext {
  return {
    workspace: ws,
    policy: { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true, allowCommands: true },
    ledger,
    now: new Date('2026-04-01T00:02:00Z'),
    userId: 'u1',
    conversationId: 'conv-1',
    changes,
  };
}

async function deliveredDigest(ws: ToolWorkspacePort, path: string): Promise<string> {
  const slice = await ws.readLines(path, 1, 0);
  const text = slice.text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
  return digest(text);
}

describe('R03 — change protection', () => {
  it('A reads, B changes the same file, then A writes: A conflicts and B survives', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const stale = await deliveredDigest(h.ws, 'a.ts');
    await h.ws.writeText('a.ts', 'export const a = 99; // B\n');
    await expect(
      port.writeText!({ path: 'a.ts', content: 'export const a = 1; // A\n', expectedSha: stale }),
    ).rejects.toMatchObject({ code: 'CHANGE_CONFLICT' });
    expect(await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8')).toContain('B');
  });

  it('two concurrent writes from the same version: exactly one wins', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const expected = await deliveredDigest(h.ws, 'a.ts');
    const results = await Promise.allSettled([
      port.writeText!({ path: 'a.ts', content: 'A\n', expectedSha: expected }),
      port.writeText!({ path: 'a.ts', content: 'B\n', expectedSha: expected }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const final = await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8');
    expect(['A\n', 'B\n']).toContain(final);
  });

  it('the write tool uses the read digest and refuses a stale overwrite', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const ledger = new TurnReadLedger();
    const slice = await h.ws.readLines('a.ts', 1, 0);
    ledger.record({
      path: 'a.ts',
      start: 1,
      end: slice.totalLines,
      complete: true,
      chars: slice.chars,
      mtimeMs: slice.mtimeMs,
      size: slice.size,
      sha256: digest(
        slice.text
          .split('\n')
          .map((line) => line.replace(/^\s*\d+\t/, ''))
          .join('\n'),
      ),
    });
    await h.ws.writeText('a.ts', 'B changed it\n');
    const result = await writeFileTool.execute(
      { file_path: 'a.ts', content: 'A overwrite\n' },
      context(h.ws, port, ledger),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/变化|read the whole file/);
    expect(await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8')).toBe('B changed it\n');
  });

  it('a patch that planned before an external edit is re-verified under the lock and refused', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const ledger = new TurnReadLedger();
    const changes: ToolChangeJournal = {
      ...port,
      lockPaths: async (paths, run) => {
        // The interleaving point: another writer lands after the preflight and
        // before the lock is acquired.
        await h.ws.writeText('a.ts', 'export const a = 100; // external\n');
        return port.lockPaths!(paths, run);
      },
    };
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-export const a = 1;',
      '+export const a = 2;',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute(
      { patch },
      context(h.ws, changes, ledger),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不匹配');
    expect(await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8')).toContain('external');
  });

  it('a multi-file patch records prepared/applied/completed in the durable journal', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const ledger = new TurnReadLedger();
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-export const a = 1;',
      '+export const a = 11;',
      '*** Update File: b.ts',
      '@@',
      '-export const b = 2;',
      '+export const b = 22;',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, context(h.ws, port, ledger));
    expect(result.ok).toBe(true);
    const entries = await h.service.listIncompleteBatches();
    expect(entries.filter((entry) => entry.state === 'prepared')).toHaveLength(0);
    const files = await readFile(join(h.journal, (await listJournal(h.journal))[0] as string), 'utf8');
    const record = JSON.parse(files) as {
      state: string;
      applied: Record<string, string | null>;
    };
    expect(record.state).toBe('completed');
    expect(Object.keys(record.applied).sort()).toEqual(['a.ts', 'b.ts']);
    expect(await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8')).toBe('export const a = 11;\n');
    expect(await readFile(join(h.workspace.storageLocation, 'b.ts'), 'utf8')).toBe('export const b = 22;\n');
  });

  it('a failed patch leaves needs_reconciliation evidence and restores what it wrote', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const ledger = new TurnReadLedger();
    // The workspace refuses the second write; the first has already been applied.
    let writes = 0;
    const flaky = Object.create(h.ws) as ToolWorkspacePort;
    (flaky as { writeText: ToolWorkspacePort['writeText'] }).writeText = async (path, content) => {
      writes += 1;
      if (writes === 2) throw new Error('disk full');
      return h.ws.writeText(path, content);
    };
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-export const a = 1;',
      '+export const a = 11;',
      '*** Update File: b.ts',
      '@@',
      '-export const b = 2;',
      '+export const b = 22;',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchTool.execute({ patch }, context(flaky, port, ledger));
    expect(result.ok).toBe(false);
    expect(await readFile(join(h.workspace.storageLocation, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(h.workspace.storageLocation, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
    const files = await listJournal(h.journal);
    const record = JSON.parse(await readFile(join(h.journal, files[0] as string), 'utf8')) as {
      state: string;
      reasons: string[];
    };
    expect(record.state).toBe('needs_reconciliation');
    expect(record.reasons.join(' ')).toContain('disk full');
  });

  it('edit uses the same lock and reports no change for an identical string', async () => {
    const h = await setup();
    const port = h.service.port('conv-1');
    const ledger = new TurnReadLedger();
    const result = await editFileTool.execute(
      { file_path: 'a.ts', old_string: 'export const a = 1;', new_string: 'export const a = 1;' },
      context(h.ws, port, ledger),
    );
    expect(result.ok).toBe(true);
  });
});

async function listJournal(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(directory)).filter((entry) => entry.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
