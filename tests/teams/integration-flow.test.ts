/**
 * E03/E04 — candidate integration and publish on real copies.
 *
 * Two members get private copies of a temp source project, edit different files
 * (E03) or the same file (E04), and the Team service builds/publishes candidates.
 * Publishing checks the source hashes, so a user edit after the candidate was
 * built stops the write instead of overwriting it.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService } from '../../src/teams/service.ts';
import { TeamWorkspaceService } from '../../src/teams/workspaces.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';

const USER = '00000000-0000-4000-8000-000000000001';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-team-integration-'));
  const source = join(base, 'repo');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'keep.txt'), 'user content\n');
  await writeFile(join(source, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(source, 'src', 'b.ts'), 'export const b = 1;\n');
  const workspace = new TeamWorkspaceService({
    store: new MemorySandboxStore(),
    options: { sourceRoot: source, storageRoot: join(base, 'storage') },
  });
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '集成', 'deepseek-flash');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rootTurn: ModelTurn = async function* () {
    await gate;
    yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
  };
  const childTurn: ModelTurn = async function* () {
    yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
  };
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: defaultTeamConfig('deepseek-flash'),
    toolPolicy: { allowWorkspaceWrites: true, allowCommands: false, maxOutputChars: 60_000 },
    resolveModelTurn: async (member) => (member.role === 'root' ? rootTurn : childTurn),
    transcriptMode: 'legacy',
  });
  const run = await service.createRun({
    ownerId: USER,
    conversationId: conversation.id,
    requestId: `integration-${Math.random().toString(36).slice(2)}`,
    message: '集成测试',
  });
  const first = await service.spawnMember({
    ownerId: USER,
    runId: run.run.id,
    parentMemberId: run.rootMember!.id,
    name: '甲',
    message: '待命',
  });
  const second = await service.spawnMember({
    ownerId: USER,
    runId: run.run.id,
    parentMemberId: run.rootMember!.id,
    name: '乙',
    message: '待命',
  });
  const firstPath = await workspace.workspacePathFor(first.member.workspaceId!);
  const secondPath = await workspace.workspacePathFor(second.member.workspaceId!);
  return {
    base,
    source,
    workspace,
    service,
    run,
    first,
    second,
    firstPath: firstPath!,
    secondPath: secondPath!,
    release,
  };
}

describe('E03 — two non-conflicting member changes integrate and publish', () => {
  it('applies both member files to the temp source without touching user files', async () => {
    const h = await setup();
    try {
      await writeFile(join(h.firstPath, 'src', 'a.ts'), 'export const a = 2;\n');
      await writeFile(join(h.secondPath, 'src', 'b.ts'), 'export const b = 2;\n');
      const task = await h.service.createTask(
        { run: h.run.run, member: null, userId: USER },
        { title: '集成 A/B', specification: '', acceptance: '构建通过', required: true },
      );
      const candidateA = await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: task.id,
        memberId: h.first.member.id,
      });
      expect(candidateA.integration.status).toBe('candidate');
      expect(candidateA.integration.conflicts).toEqual([]);
      const publishedA = await h.service.publishIntegration({
        ownerId: USER,
        integrationId: candidateA.integration.id,
        memberId: h.first.member.id,
      });
      expect(publishedA.result.conflicts).toEqual([]);
      expect(publishedA.integration.status).toBe('published');
      expect(await readFile(join(h.source, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(await readFile(join(h.source, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');

      const taskB = await h.service.createTask(
        { run: h.run.run, member: null, userId: USER },
        { title: '集成 B', specification: '', acceptance: '构建通过', required: true },
      );
      const candidateB = await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: taskB.id,
        memberId: h.second.member.id,
      });
      const publishedB = await h.service.publishIntegration({
        ownerId: USER,
        integrationId: candidateB.integration.id,
        memberId: h.second.member.id,
      });
      expect(publishedB.result.conflicts).toEqual([]);
      expect(await readFile(join(h.source, 'src', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
      // The user's unrelated file is untouched.
      expect(await readFile(join(h.source, 'keep.txt'), 'utf8')).toBe('user content\n');
    } finally {
      h.release();
      await rm(h.base, { recursive: true, force: true });
    }
  });
});

describe('T59 — cleanup refuses referenced workspaces', () => {
  it('keeps a workspace with artifacts and removes an unreferenced one', async () => {
    const h = await setup();
    try {
      // Second member has no task/artifact yet: safe to remove.
      const removed = await h.service.cleanupMemberWorkspace({
        ownerId: USER,
        runId: h.run.run.id,
        memberId: h.second.member.id,
      });
      expect(removed.removed).toBe(true);
      await expect(readFile(join(h.secondPath, 'keep.txt'))).rejects.toThrow();

      await writeFile(join(h.firstPath, 'keep.txt'), 'from a\n');
      const task = await h.service.createTask(
        { run: h.run.run, member: null, userId: USER },
        { title: '有产物', specification: '', acceptance: '证据', required: true },
      );
      await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: task.id,
        memberId: h.first.member.id,
      });
      const kept = await h.service.cleanupMemberWorkspace({
        ownerId: USER,
        runId: h.run.run.id,
        memberId: h.first.member.id,
      });
      expect(kept.removed).toBe(false);
      expect(await readFile(join(h.firstPath, 'keep.txt'), 'utf8')).toBe('from a\n');
    } finally {
      h.release();
      await rm(h.base, { recursive: true, force: true });
    }
  });
});

describe('E04 — same-file conflict and stale source', () => {
  it('reports both-member conflict and refuses publish', async () => {
    const h = await setup();
    try {
      await writeFile(join(h.firstPath, 'keep.txt'), 'from a\n');
      await writeFile(join(h.secondPath, 'keep.txt'), 'from b\n');
      const task = await h.service.createTask(
        { run: h.run.run, member: null, userId: USER },
        { title: '冲突', specification: '', acceptance: '证据', required: true },
      );
      const candidateA = await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: task.id,
        memberId: h.first.member.id,
      });
      expect(candidateA.integration.conflicts).toEqual([]);
      const candidateB = await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: task.id,
        memberId: h.second.member.id,
        otherMemberId: h.first.member.id,
      });
      expect(candidateB.integration.status).toBe('conflict');
      expect(candidateB.integration.conflicts).toContain('keep.txt');
      await expect(
        h.service.publishIntegration({
          ownerId: USER,
          integrationId: candidateB.integration.id,
          memberId: h.second.member.id,
        }),
      ).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_CONFLICT' });
    } finally {
      h.release();
      await rm(h.base, { recursive: true, force: true });
    }
  });

  it('stops publish when the user changed the source after the candidate', async () => {
    const h = await setup();
    try {
      await writeFile(join(h.firstPath, 'keep.txt'), 'from a\n');
      const task = await h.service.createTask(
        { run: h.run.run, member: null, userId: USER },
        { title: '过期基线', specification: '', acceptance: '证据', required: true },
      );
      const candidate = await h.service.createIntegrationCandidate({
        ownerId: USER,
        runId: h.run.run.id,
        taskId: task.id,
        memberId: h.first.member.id,
      });
      await writeFile(join(h.source, 'keep.txt'), 'user changed after candidate\n');
      const result = await h.service.publishIntegration({
        ownerId: USER,
        integrationId: candidate.integration.id,
        memberId: h.first.member.id,
      });
      expect(result.result.conflicts.length).toBeGreaterThan(0);
      expect(result.integration.status).toBe('conflict');
      expect(await readFile(join(h.source, 'keep.txt'), 'utf8')).toBe(
        'user changed after candidate\n',
      );
    } finally {
      h.release();
      await rm(h.base, { recursive: true, force: true });
    }
  });
});
