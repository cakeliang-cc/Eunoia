/**
 * The SQLite store, against the shared contract plus the things only a real
 * database file can prove: two connections racing one task, a restart, and
 * schema application being idempotent.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { TeamStore } from '../../src/teams/store.ts';
import { openSqliteTeamStore } from '../../src/teams/store-sqlite.ts';
import { runStoreContract } from './store-contract.ts';
import type { StoreFixture } from './store-contract.ts';
import {
  NOW,
  createRunInputFrom,
  createTeamInputFrom,
  isoAfter,
  makeArtifact,
  makeIntegration,
  makeMember,
  makeMessage,
  makeRun,
  makeTask,
  makeTeam,
} from './helpers.ts';

/** A fresh file per test, removed by the contract's teardown hook. */
async function makeSqliteFixture(): Promise<StoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-teams-'));
  const store = openSqliteTeamStore(join(directory, 'teams.sqlite'));
  return {
    store,
    close: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runStoreContract('sqlite', makeSqliteFixture);

interface Seed {
  readonly ownerId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly taskId: string;
}

/** The team/run/task shape the connection-level tests share. */
async function seedRun(store: TeamStore): Promise<Seed> {
  const team = await store.createTeam(createTeamInputFrom(makeTeam()));
  const run = (
    await store.createRun(
      createRunInputFrom(
        makeRun({
          teamId: team.id,
          ownerId: team.ownerId,
          rootConversationId: team.rootConversationId,
        }),
      ),
    )
  ).run;
  const task = await store.createTask({
    task: makeTask({ teamId: team.id, runId: run.id }),
    maxTasks: 10,
  });
  return { ownerId: team.ownerId, teamId: team.id, runId: run.id, taskId: task.id };
}

describe('SqliteTeamStore connections', () => {
  const scratch: string[] = [];

  afterEach(async () => {
    for (const directory of scratch.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function tempDatabase(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    scratch.push(directory);
    return join(directory, 'teams.sqlite');
  }

  it('lets exactly one of two connections claim the same task', async () => {
    const path = await tempDatabase('eunoia-teams-race-');
    const left = openSqliteTeamStore(path);
    const right = openSqliteTeamStore(path);
    try {
      const seed = await seedRun(left);
      const task = await left.getTask(seed.taskId);
      if (!task) throw new Error('expected the seeded task');

      const claim = (store: TeamStore, memberId: string) =>
        store.claimTask({
          taskId: seed.taskId,
          expectedRevision: task.revision,
          memberId,
          activationId: null,
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 100),
        });

      // Both connections start from the same revision, with no awaits in
      // between. The update is guarded by `revision` and `status`, so only one
      // can win even though both statements were attempted "together".
      const [first, second] = await Promise.all([
        claim(left, 'member_left'),
        claim(right, 'member_right'),
      ]);
      expect(first.ok).not.toBe(second.ok);

      // Exactly one attempt exists, and both connections agree on the row.
      expect(await left.listAttempts(seed.taskId)).toHaveLength(1);
      expect(await right.listAttempts(seed.taskId)).toHaveLength(1);
      const stored = await left.getTask(seed.taskId);
      expect(stored?.status).toBe('running');
      expect(stored?.revision).toBe(task.revision + 1);
      expect(await right.getTask(seed.taskId)).toEqual(stored);

      // The loser got the winner's row back, not an exception.
      const loser = first.ok ? second : first;
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(loser.current).toEqual(stored);
    } finally {
      await left.close();
      await right.close();
    }
  });

  it('reads its state back after a restart', async () => {
    const path = await tempDatabase('eunoia-teams-restart-');
    const first = openSqliteTeamStore(path);

    const team = await first.createTeam(createTeamInputFrom(makeTeam()));
    const member = await first.createMember({ member: makeMember({ teamId: team.id }) });
    const run = (
      await first.createRun(
        createRunInputFrom(
          makeRun({
            teamId: team.id,
            ownerId: team.ownerId,
            rootConversationId: team.rootConversationId,
          }),
        ),
      )
    ).run;
    await first.updateMember(member.id, { status: 'active', now: isoAfter(NOW, 10) });
    const task = await first.createTask({
      task: makeTask({
        teamId: team.id,
        runId: run.id,
        dependencies: ['task_dependency'],
        writeScopes: ['src/parser.ts', 'src/lexer.ts'],
        createdAt: isoAfter(NOW, 20),
        updatedAt: isoAfter(NOW, 20),
      }),
      maxTasks: 10,
    });
    const message = await first.appendMessage({
      message: makeMessage({
        teamId: team.id,
        runId: run.id,
        recipientId: 'member_restart',
        clientMessageId: 'restart_1',
        createdAt: isoAfter(NOW, 30),
      }),
      maxMessages: 100,
      maxQueuedPerMember: 100,
    });
    const artifact = await first.createArtifact({
      artifact: makeArtifact({ teamId: team.id, runId: run.id, taskId: task.id }),
    });
    const integration = await first.createIntegration({
      integration: makeIntegration({ teamId: team.id, runId: run.id, taskId: task.id }),
    });
    await first.appendEvent(
      team.id,
      run.id,
      { kind: 'run.created', payload: { source: 'restart-test' } },
      isoAfter(NOW, 40),
    );

    await first.close();

    const second = openSqliteTeamStore(path);
    try {
      expect(await second.getTeam(team.id)).toEqual(team);
      expect(await second.getMember(member.id)).toEqual({
        ...member,
        status: 'active',
        updatedAt: isoAfter(NOW, 10),
      });
      expect(await second.getRun(run.id)).toEqual(run);
      expect(await second.getTask(task.id)).toEqual(task);
      expect((await second.getTask(task.id))?.dependencies).toEqual(['task_dependency']);
      expect(await second.getMessage(message.message.id)).toEqual(message.message);
      expect((await second.pendingMessages('member_restart')).map((row) => row.id)).toEqual([
        message.message.id,
      ]);
      expect(await second.getArtifact(artifact.id)).toEqual(artifact);
      expect(await second.getIntegration(integration.id)).toEqual(integration);
      expect((await second.listEvents(run.id, 0)).map((event) => event.payload)).toEqual([
        { source: 'restart-test' },
      ]);

      // The revision guard survives the restart: this is a first claim.
      const claimed = await second.claimTask({
        taskId: task.id,
        expectedRevision: task.revision,
        memberId: member.id,
        activationId: null,
        generation: 1,
        leaseExpiresAt: null,
        baselineId: null,
        now: isoAfter(NOW, 50),
      });
      expect(claimed.ok).toBe(true);
      expect((await second.getTask(task.id))?.status).toBe('running');
    } finally {
      await second.close();
    }
  });

  it('does not duplicate data when the schema is applied twice', async () => {
    const path = await tempDatabase('eunoia-teams-reopen-');
    const first = openSqliteTeamStore(path);
    const seed = await seedRun(first);
    await first.close();

    // Opening again executes TEAM_SCHEMA a second time; it must be a no-op.
    const second = openSqliteTeamStore(path);
    try {
      expect(await second.listTeams(seed.ownerId)).toHaveLength(1);
      expect(await second.listRuns(seed.teamId)).toHaveLength(1);
      expect((await second.listTasks(seed.runId)).total).toBe(1);
      expect(await second.countMembers(seed.teamId)).toBe(0);
    } finally {
      await second.close();
    }
  });

  it('creates every team table, the partial running index, and leaves user_version alone', async () => {
    const path = await tempDatabase('eunoia-teams-schema-');
    const store = openSqliteTeamStore(path);
    try {
      const raw = new DatabaseSync(path);
      try {
        const tables = raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'team%' ORDER BY name",
          )
          .all() as { name: string }[];
        expect(tables.map((table) => table.name)).toEqual([
          'team_activations',
          'team_artifacts',
          'team_budget_entries',
          'team_events',
          'team_integrations',
          'team_members',
          'team_messages',
          'team_runs',
          'team_task_attempts',
          'team_tasks',
          'teams',
        ]);

        // One running activation per member is a partial index, not a check
        // constraint, because every other status is allowed to repeat.
        const index = raw
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'team_activations_running_idx'",
          )
          .get() as { sql: string } | undefined;
        expect(index?.sql).toContain('WHERE status = \'running\'');

        // The team schema is additive: it must not own the database version.
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(Number(version.user_version)).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      await store.close();
    }
  });

  it('cascades a team delete to its runs, tasks and events', async () => {
    const path = await tempDatabase('eunoia-teams-cascade-');
    const store = openSqliteTeamStore(path);
    try {
      const seed = await seedRun(store);
      await store.appendEvent(seed.teamId, seed.runId, { kind: 'run.created' }, NOW);

      // Foreign keys are per connection, so the raw connection has to enable
      // them too before the cascade is observable.
      const raw = new DatabaseSync(path);
      try {
        raw.exec('PRAGMA foreign_keys = ON');
        raw.prepare('DELETE FROM teams WHERE id = ?').run(seed.teamId);
        const count = (table: string): number => {
          const row = raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          };
          return Number(row.count);
        };
        expect(count('teams')).toBe(0);
        expect(count('team_runs')).toBe(0);
        expect(count('team_tasks')).toBe(0);
        expect(count('team_events')).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      await store.close();
    }
  });
});
