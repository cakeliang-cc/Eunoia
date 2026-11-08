/**
 * R03/R04 cross-task write coordination.
 *
 * Two tasks bound to the same source directory, and a Team candidate publishing
 * into that source, must compete for the same canonical-path lock. A task-id
 * keyed map would let both pass the version check and the later one overwrite
 * the earlier one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { acquireWorkspaceWriteLocks } from '../../src/sandbox/write-lock.ts';
import { publishCandidate } from '../../src/teams/integration.ts';
import type { ArtifactFile } from '../../src/teams/types.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function sha(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function digest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-write-coord-'));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.ts'), 'export const a = 1;\n');
  const sandboxStore = new MemorySandboxStore();
  const workspaces = new WorkspaceManager(
    { store: sandboxStore },
    {
      storageRoot: join(root, 'storage'),
      sourceRoot: source,
      mode: 'bind',
      now: () => new Date('2026-04-01T00:00:00Z'),
    },
  );
  await workspaces.ensureForTask('task-a');
  await workspaces.ensureForTask('task-b');
  const changesets = new InMemoryStore();
  const service = new WorkspaceChangeService({ store: sandboxStore, workspaces, changesets });
  await service.arm({ userId: 'u1', conversationId: 'c-a', turnId: 'turn-a', taskId: 'task-a' });
  await service.arm({ userId: 'u1', conversationId: 'c-b', turnId: 'turn-b', taskId: 'task-b' });
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const files = workspaces.files(source);
  return { root, source, service, files };
}

async function currentDigest(source: string, path: string): Promise<string> {
  const text = await readFile(join(source, path), 'utf8');
  return digest(text);
}

function artifact(content: string, base: string): ArtifactFile {
  return {
    path: 'a.ts',
    change: 'modified',
    baseHash: sha(base),
    contentHash: sha(content),
    bytes: Buffer.byteLength(content),
    executable: false,
    binary: false,
    content,
  };
}

describe('R03/R04 — canonical workspace write coordination', () => {
  it('two tasks writing the same bind file from the same version: one wins, one conflicts', async () => {
    const h = await setup();
    const before = await currentDigest(h.source, 'a.ts');
    const a = h.service.port('task-a');
    const b = h.service.port('task-b');
    const results = await Promise.allSettled([
      a.writeText!({ path: 'a.ts', content: 'task-a\n', expectedSha: before }),
      b.writeText!({ path: 'a.ts', content: 'task-b\n', expectedSha: before }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const final = await readFile(join(h.source, 'a.ts'), 'utf8');
    expect(['task-a\n', 'task-b\n']).toContain(final);
  });

  it('a task write and a Team publish cannot both pass the version check and overwrite', async () => {
    const h = await setup();
    const beforeText = 'export const a = 1;\n';
    const before = digest(beforeText);
    const release = await acquireWorkspaceWriteLocks([join(h.source, 'a.ts')]);
    const taskWrite = h.service.port('task-a').writeText!({
      path: 'a.ts',
      content: 'task-write\n',
      expectedSha: before,
    });
    const publish = publishCandidate({
      targetRoot: h.source,
      files: [artifact('team-publish\n', beforeText)],
      sourceHashes: { 'a.ts': sha(beforeText) },
      expectedHashes: { 'a.ts': sha(beforeText) },
      idempotencyKey: 'publish-cross-task',
    });
    let settled = false;
    void Promise.allSettled([taskWrite, publish]).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    await release();
    const [writeResult, publishResult] = await Promise.allSettled([taskWrite, publish]);
    const final = await readFile(join(h.source, 'a.ts'), 'utf8');
    const writeWon = writeResult.status === 'fulfilled' && final === 'task-write\n';
    const publishWon =
      publishResult.status === 'fulfilled' &&
      (publishResult.value as { ok: boolean }).ok &&
      final === 'team-publish\n';
    expect(writeWon || publishWon).toBe(true);
    expect(writeWon && publishWon).toBe(false);
  });

  it('does not overwrite a user edit made between the read and the second writer', async () => {
    const h = await setup();
    const before = await currentDigest(h.source, 'a.ts');
    await writeFile(join(h.source, 'a.ts'), 'user content\n');
    const result = await Promise.allSettled([
      h.service.port('task-a').writeText!({ path: 'a.ts', content: 'task\n', expectedSha: before }),
      publishCandidate({
        targetRoot: h.source,
        files: [artifact('team\n', 'export const a = 1;\n')],
        sourceHashes: { 'a.ts': sha('export const a = 1;\n') },
        expectedHashes: { 'a.ts': sha('export const a = 1;\n') },
        idempotencyKey: 'publish-user-edit',
      }),
    ]);
    expect(result.every((entry) => entry.status === 'fulfilled' || (entry.reason as { code?: string }).code === 'CHANGE_CONFLICT')).toBe(true);
    expect(await readFile(join(h.source, 'a.ts'), 'utf8')).toBe('user content\n');
  });
});
