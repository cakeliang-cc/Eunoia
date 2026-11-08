/**
 * Turn undo, against a real per-task workspace.
 *
 * The cases that matter are the refusals: an edit the person made after the turn
 * must become a conflict, not an overwrite. The happy path is the easy half.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { applyPatchTool } from '../../src/tools/coding/apply-patch.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-undo-'));
  const source = join(root, 'source');
  const storage = join(root, 'storage');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(source, 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(source, 'keep.txt'), 'keep\n');

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
  });
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { service, workspaces, workspace, changesets, root, storage };
}

function files(workspaces: WorkspaceManager, workspace: { storageLocation: string }) {
  return workspaces.files(workspace.storageLocation);
}

describe('a turn that edits, adds and deletes', () => {
  it('records exactly those files and restores them', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    expect(await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' })).toBe(true);

    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'export const a = 42;\n');
    await ws.writeText('c.ts', 'export const c = 3;\n');
    await service.beforeWrite({ taskId: 'conv-1', path: 'b.ts' });
    await ws.deleteFile('b.ts');

    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    expect(summary).toMatchObject({ added: 1, modified: 1, deleted: 1, fileCount: 3 });
    const result = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(result.status).toBe('undone');
    expect([...result.restored].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'].sort());
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(await readFile(join(workspace.storageLocation, 'b.ts'), 'utf8')).toBe(
      'export const b = 2;\n',
    );
    await expect(readFile(join(workspace.storageLocation, 'c.ts'), 'utf8')).rejects.toThrow();
    // Untouched files stay untouched.
    expect(await readFile(join(workspace.storageLocation, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('does not touch anything when the turn only read', async () => {
    const { service } = await setup();
    expect(await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-read', taskId: 'conv-1' })).toBe(true);
    expect(await service.finish({ userId: 'u1', turnId: 'turn-read' })).toBeNull();
  });

  it('is idempotent: a second undo reports already-undone and writes nothing', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'changed\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    await service.undo({ userId: 'u1', conversationId: 'conv-1', changesetId: summary!.id });
    const again = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(again.alreadyUndone).toBe(true);
    expect(again.status).toBe('undone');
  });
});

describe('protecting changes the person made later', () => {
  it('refuses to overwrite a file edited after the turn', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'agent version\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });

    // The person edits the same file after the turn ended.
    await writeFile(join(workspace.storageLocation, 'a.ts'), 'human version\n');
    const result = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(result.status).toBe('partial');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.path).toBe('a.ts');
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe('human version\n');
  });

  it('restores on an explicit force, after reporting the conflict once', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'agent version\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    await writeFile(join(workspace.storageLocation, 'a.ts'), 'human version\n');

    const forced = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
      force: true,
    });
    expect(forced.status).toBe('undone');
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('does not resurrect a file the person deleted after the turn', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'agent version\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    await rm(join(workspace.storageLocation, 'a.ts'));
    const result = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(result.conflicts.some((entry) => entry.path === 'a.ts')).toBe(true);
    await expect(readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).rejects.toThrow();
  });
});

describe('files changed by a command', () => {
  it('uses a checkpoint captured before the first command', async () => {
    const { service, workspace } = await setup();
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeCommand({ taskId: 'conv-1' });
    // Simulate a formatter: no write tool saw this change.
    await writeFile(join(workspace.storageLocation, 'a.ts'), 'formatted\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    expect(summary?.checkpointId).toMatch(/^ckpt_/);
    const result = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(result.status).toBe('undone');
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('reports a pruned checkpoint instead of inventing content', async () => {
    const { service, workspace, storage } = await setup();
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeCommand({ taskId: 'conv-1' });
    await writeFile(join(workspace.storageLocation, 'a.ts'), 'formatted\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    expect(summary?.checkpointId).toBeTruthy();
    // Simulate retention removing the checkpoint directory.
    await rm(
      join(
        storage,
        'checkpoints',
        workspace.workspaceId,
        String(summary?.checkpointId).replace(/^ckpt_/, ''),
      ),
      { recursive: true, force: true },
    );
    const result = await service.undo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: summary!.id,
    });
    expect(result.skipped.some((entry) => entry.path === 'a.ts')).toBe(true);
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe('formatted\n');
  });
});

describe('ownership', () => {
  it('does not read another conversation\'s change set', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-1', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'x\n');
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-1' });
    await expect(
      service.undo({ userId: 'u1', conversationId: 'conv-2', changesetId: summary!.id }),
    ).rejects.toThrow(/没有可撤销/);
  });
});

describe('a patch turn', () => {
  it('restores added, modified, moved and deleted files through the same change set', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-patch', taskId: 'conv-1' });
    const patch = [
      '*** Begin Patch',
      '*** Add File: added.ts',
      '+export const added = 1;',
      '*** Update File: a.ts',
      '@@',
      '-export const a = 1;',
      '+export const a = 2;',
      '*** Update File: b.ts',
      '*** Move to: moved.ts',
      '@@',
      '-export const b = 2;',
      '+export const b = 3;',
      '*** End Patch',
    ].join('\n');
    const checked = applyPatchTool.contract?.validate({ patch });
    if (!checked || !checked.ok) throw new Error('contract');
    const result = await applyPatchTool.execute(checked.value, {
      workspace: ws,
      policy: { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true },
      ledger: new TurnReadLedger(),
      now: new Date('2026-04-01T00:00:00Z'),
      userId: 'u1',
      conversationId: 'conv-1',
      changes: {
        beforeWrite: (path) => service.beforeWrite({ taskId: 'conv-1', path }),
      },
    });
    expect(result.ok).toBe(true);
    const summary = await service.finish({ userId: 'u1', turnId: 'turn-patch' });
    expect(summary).toMatchObject({ added: 2, modified: 1, deleted: 1 });
    const undo = await service.undo({ userId: 'u1', conversationId: 'conv-1', changesetId: summary!.id });
    expect(undo.status).toBe('undone');
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(workspace.storageLocation, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
    await expect(readFile(join(workspace.storageLocation, 'added.ts'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace.storageLocation, 'moved.ts'), 'utf8')).rejects.toThrow();
  });

  it('blocks a partial undo whose file is still referenced by a later turn', async () => {
    const { service, workspaces, workspace } = await setup();
    const ws = files(workspaces, workspace);
    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-a', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'first turn\n');
    const first = await service.finish({ userId: 'u1', turnId: 'turn-a' });

    await service.arm({ userId: 'u1', conversationId: 'conv-1', turnId: 'turn-b', taskId: 'conv-1' });
    await service.beforeWrite({ taskId: 'conv-1', path: 'a.ts' });
    await ws.writeText('a.ts', 'second turn\n');
    await service.finish({ userId: 'u1', turnId: 'turn-b' });

        const plan = await service.planUndo({
      userId: 'u1',
      conversationId: 'conv-1',
      changesetId: first!.id,
      paths: ['a.ts'],
    });
    expect(plan.blocked.some((entry) => entry.path === 'a.ts')).toBe(true);
    await expect(
      service.undo({
        userId: 'u1',
        conversationId: 'conv-1',
        changesetId: first!.id,
        paths: ['a.ts'],
      }),
    ).rejects.toMatchObject({ code: 'UNDO_SCOPE_BLOCKED' });
    expect(await readFile(join(workspace.storageLocation, 'a.ts'), 'utf8')).toBe('second turn\n');
  });
});
