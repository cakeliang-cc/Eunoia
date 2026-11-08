/**
 * The TeamStore contract, run against every backend.
 *
 * Each case is a statement about the *contract*, never about SQLite or a Map:
 * the memory store is the reference and the SQLite store has to produce the
 * same answers. That is why the same file is executed twice (see
 * `memory-store.test.ts` and `sqlite-store.test.ts`) and why no case sleeps:
 * concurrency is expressed with `Promise.all`, which is exactly the interleaving
 * a single-threaded process can actually produce, and the backend has to be
 * correct for it.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamStore } from '../../src/teams/store.ts';
import { TeamError } from '../../src/teams/types.ts';
import type {
  Activation,
  Member,
  Task,
  TaskSubmission,
  Team,
  TeamEvent,
  TeamMessage,
  TeamRun,
} from '../../src/teams/types.ts';
import {
  DEFAULT_RUN_BUDGET,
  NOW,
  createRunInputFrom,
  createTeamInputFrom,
  expectTeamError,
  isoAfter,
  makeActivation,
  makeArtifact,
  makeIntegration,
  makeMember,
  makeMessage,
  makeRun,
  makeTask,
  makeTeam,
  teamConfig,
} from './helpers.ts';

export interface StoreFixture {
  readonly store: TeamStore;
  /** Extra teardown after `store.close()`; the SQLite test removes its temp dir. */
  readonly close?: () => Promise<void>;
}

export type StoreFactory = () => Promise<StoreFixture>;

export function runStoreContract(name: string, make: StoreFactory): void {
  describe(`TeamStore contract: ${name}`, () => {
    let fixture: StoreFixture;
    let store: TeamStore;
    let team: Team;
    let run: TeamRun;
    let root: Member;

    beforeEach(async () => {
      fixture = await make();
      store = fixture.store;

      team = await store.createTeam(createTeamInputFrom(makeTeam()));
      root = await store.createMember({ member: makeMember({ teamId: team.id }) });
      const created = await store.createRun(
        createRunInputFrom(
          makeRun({
            teamId: team.id,
            ownerId: team.ownerId,
            rootConversationId: team.rootConversationId,
          }),
        ),
      );
      run = created.run;
    });

    afterEach(async () => {
      await store.close();
      await fixture.close?.();
    });

    // ------------------------------------------------------------- teams -----

    describe('teams', () => {
      it('creates, reads and lists a team', async () => {
        expect(await store.getTeam(team.id)).toEqual(team);
        expect(await store.getTeamForRoot(team.ownerId, team.rootConversationId)).toEqual(team);
        expect(await store.getTeamForRoot(team.ownerId, 'another_conversation')).toBeNull();
        expect(await store.getTeam('missing_team')).toBeNull();

        const teams = await store.listTeams(team.ownerId);
        expect(teams.map((candidate) => candidate.id)).toContain(team.id);
        expect(await store.listTeams('a_different_owner')).toEqual([]);
      });

      it('treats a second create for the same root as the same team', async () => {
        const replay = await store.createTeam({
          id: `team_${randomUUID()}`,
          ownerId: team.ownerId,
          rootConversationId: team.rootConversationId,
          enabled: true,
          config: teamConfig({ mode: 'delegation' }),
          now: isoAfter(NOW, 1_000),
        });
        expect(replay.id).toBe(team.id);
        expect(replay.config.mode).toBe('team');
        expect(replay.configRevision).toBe(1);
      });

      it('updates config with compare-and-set on the revision', async () => {
        const stale = await store.updateTeam({
          id: team.id,
          expectedRevision: team.configRevision + 4,
          enabled: false,
          config: teamConfig({ mode: 'delegation' }),
          now: isoAfter(NOW, 1_000),
        });
        expect(stale).toBeNull();
        expect((await store.getTeam(team.id))?.configRevision).toBe(1);
        expect((await store.getTeam(team.id))?.enabled).toBe(true);

        const updated = await store.updateTeam({
          id: team.id,
          expectedRevision: team.configRevision,
          enabled: false,
          config: teamConfig({ mode: 'delegation' }),
          now: isoAfter(NOW, 2_000),
        });
        expect(updated).not.toBeNull();
        expect(updated?.configRevision).toBe(2);
        expect(updated?.enabled).toBe(false);
        expect(updated?.config.mode).toBe('delegation');
        expect(updated?.updatedAt).toBe(isoAfter(NOW, 2_000));
        expect((await store.getTeam(team.id))?.configRevision).toBe(2);

        expect(
          await store.updateTeam({
            id: 'missing_team',
            expectedRevision: 1,
            enabled: true,
            config: teamConfig(),
            now: NOW,
          }),
        ).toBeNull();
      });
    });

    // -------------------------------------------------------------- runs -----

    describe('runs', () => {
      it('is idempotent by (owner, root, input hash)', async () => {
        const replay = await store.createRun(createRunInputFrom(makeRun({ ...run })));
        expect(replay.created).toBe(false);
        expect(replay.run.id).toBe(run.id);

        expect(await store.listRuns(team.id)).toEqual([run]);
        expect(await store.activeRunForRoot(team.ownerId, team.rootConversationId)).toEqual(run);
        expect(await store.activeRunForRoot(team.ownerId, 'another_conversation')).toBeNull();
        expect(await store.getRun('missing_run')).toBeNull();
      });

      it('refuses a second active run for the same root with a different input hash', async () => {
        const error = await expectTeamError(
          store.createRun(
            createRunInputFrom(
              makeRun({
                teamId: team.id,
                ownerId: team.ownerId,
                rootConversationId: team.rootConversationId,
                inputHash: 'a_different_hash',
              }),
            ),
          ),
          'TEAM_RUN_BUSY',
        );
        expect(error.status).toBe(409);
        expect(error.detail).toMatchObject({ runId: run.id, status: 'queued' });
      });

      it('allows a new run once the previous one is terminal', async () => {
        await store.transitionRun(run.id, ['queued'], { status: 'running' }, undefined, NOW);
        await store.transitionRun(
          run.id,
          ['running'],
          { status: 'succeeded' },
          undefined,
          isoAfter(NOW, 100),
        );

        const second = await store.createRun(
          createRunInputFrom(
            makeRun({
              teamId: team.id,
              ownerId: team.ownerId,
              rootConversationId: team.rootConversationId,
              inputHash: 'a_different_hash',
              createdAt: isoAfter(NOW, 200),
            }),
          ),
        );
        expect(second.created).toBe(true);
        expect(second.run.id).not.toBe(run.id);
        expect(await store.activeRunForRoot(team.ownerId, team.rootConversationId)).toEqual(
          second.run,
        );
      });

      it('transitions only from a status the caller expects, and stamps terminal runs', async () => {
        const moved = await store.transitionRun(
          run.id,
          ['queued'],
          { status: 'running' },
          undefined,
          isoAfter(NOW, 1_000),
        );
        expect(moved?.status).toBe('running');
        expect(moved?.updatedAt).toBe(isoAfter(NOW, 1_000));
        expect(moved?.finishedAt).toBeNull();

        // The same call again sees `running`, not `queued`: no move, not an error.
        expect(await store.transitionRun(run.id, ['queued'], { status: 'failed' })).toBeNull();

        const finished = await store.transitionRun(
          run.id,
          ['running'],
          { status: 'succeeded', reason: 'all tasks accepted', rootMemberId: root.id },
          undefined,
          isoAfter(NOW, 2_000),
        );
        expect(finished?.finishedAt).toBe(isoAfter(NOW, 2_000));
        expect(finished?.reason).toBe('all tasks accepted');
        expect(finished?.rootMemberId).toBe(root.id);

        // `RUN_TRANSITIONS.succeeded` is empty: a caller that only offers a
        // non-terminal source status gets nothing back.
        expect(
          await store.transitionRun(run.id, ['running'], { status: 'running' }, undefined, NOW),
        ).toBeNull();
        expect((await store.getRun(run.id))?.status).toBe('succeeded');
      });

      it('writes the event and the transition together', async () => {
        await store.transitionRun(
          run.id,
          ['queued'],
          { status: 'running' },
          { kind: 'run.status', payload: { to: 'running' } },
          NOW,
        );
        const events = await store.listEvents(run.id, 0);
        expect(events).toHaveLength(1);
        expect(events.at(0)?.kind).toBe('run.status');
        expect(events.at(0)?.payload).toEqual({ to: 'running' });
      });
    });

    // ----------------------------------------------------------- members -----

    describe('members', () => {
      it('creates, reads, counts and lists members', async () => {
        const child = await store.createMember({
          member: makeMember({
            teamId: team.id,
            parentMemberId: root.id,
            name: 'worker-1',
            role: 'worker',
            depth: 2,
            createdAt: isoAfter(NOW, 10),
            updatedAt: isoAfter(NOW, 10),
          }),
        });

        expect(await store.getMember(child.id)).toEqual(child);
        expect(child.profile.modelId).toBe('deepseek-chat');
        expect(child.permissions.allowedTools).toEqual(['file_read', 'file_write']);
        expect(await store.countMembers(team.id)).toBe(2);
        expect(await store.countMembers('another_team')).toBe(0);
        expect((await store.listMembers(team.id)).map((member) => member.id)).toEqual([
          root.id,
          child.id,
        ]);
        expect(await store.getMember('missing_member')).toBeNull();

        // A replay with the same conversation id must not create a second row.
        const replay = await store.createMember({
          member: makeMember({
            teamId: team.id,
            internalConversationId: child.internalConversationId,
          }),
        });
        expect(replay.id).toBe(child.id);
        expect(await store.countMembers(team.id)).toBe(2);
      });

      it('updates a member and returns null for an unknown id', async () => {
        const updated = await store.updateMember(root.id, {
          status: 'active',
          currentActivationId: 'activation_1',
          now: isoAfter(NOW, 500),
        });
        expect(updated?.status).toBe('active');
        expect(updated?.currentActivationId).toBe('activation_1');
        expect(updated?.updatedAt).toBe(isoAfter(NOW, 500));

        const closed = await store.updateMember(root.id, {
          status: 'closed',
          closedAt: isoAfter(NOW, 900),
          currentActivationId: null,
          error: null,
          now: isoAfter(NOW, 900),
        });
        expect(closed?.status).toBe('closed');
        expect(closed?.closedAt).toBe(isoAfter(NOW, 900));
        expect(closed?.currentActivationId).toBeNull();

        expect(await store.updateMember('missing_member', { status: 'idle', now: NOW })).toBeNull();
      });
    });

    // ------------------------------------------------------- activations -----

    describe('activations', () => {
      it('enforces the per-run activation limit', async () => {
        const first = await store.createActivation({
          activation: makeActivation({ runId: run.id, memberId: root.id, status: 'running' }),
          maxActivations: 10,
        });
        expect(await store.countActivations(run.id)).toBe(1);
        expect(await store.countActivations('another_run')).toBe(0);

        // A replay of the same activation id is idempotent even at the limit.
        expect(
          await store.createActivation({ activation: first, maxActivations: 1 }),
        ).toEqual(first);

        const error = await expectTeamError(
          store.createActivation({
            activation: makeActivation({ runId: run.id, memberId: 'member_b', status: 'queued' }),
            maxActivations: 1,
          }),
          'TEAM_ACTIVATION_LIMIT',
        );
        expect(error.detail).toMatchObject({ runId: run.id, count: 1, max: 1 });

        const unknownRun = await expectTeamError(
          store.createActivation({
            activation: makeActivation({ runId: 'missing_run', memberId: root.id, status: 'queued' }),
            maxActivations: 10,
          }),
          'TEAM_RUN_NOT_FOUND',
        );
        expect(unknownRun.status).toBe(404);
      });

      it('allows one running activation per member while queueing more work', async () => {
        const running = await store.createActivation({
          activation: makeActivation({
            runId: run.id,
            memberId: root.id,
            status: 'running',
            startedAt: NOW,
          }),
          maxActivations: 10,
        });

        const conflict = await expectTeamError(
          store.createActivation({
            activation: makeActivation({ runId: run.id, memberId: root.id, status: 'running' }),
            maxActivations: 10,
          }),
          'TEAM_ACTIVATION_CONFLICT',
        );
        expect(conflict.detail).toMatchObject({ memberId: root.id });

        // A queued activation for the busy member is fine: it is not running.
        const queued = await store.createActivation({
          activation: makeActivation({
            runId: run.id,
            memberId: root.id,
            status: 'queued',
            createdAt: isoAfter(NOW, 100),
          }),
          maxActivations: 10,
        });

        expect(await store.getActivation(running.id)).toEqual(running);
        expect((await store.nextQueuedActivation(root.id))?.id).toBe(queued.id);
        expect(await store.nextQueuedActivation('member_without_queue')).toBeNull();

        const byMember = await store.listActivations(run.id, root.id);
        expect(byMember.map((activation) => activation.id)).toEqual([running.id, queued.id]);
        expect(await store.listActivations(run.id)).toHaveLength(2);
        expect(await store.listActivations('another_run')).toEqual([]);
      });

      it('transitions only from expected statuses and stamps terminal activations', async () => {
        const running = await store.createActivation({
          activation: makeActivation({ runId: run.id, memberId: root.id, status: 'running' }),
          maxActivations: 10,
        });

        const finished = await store.updateActivation(
          running.id,
          ['running'],
          { status: 'succeeded', result: { summary: 'done', steps: 3 }, checkpoint: { step: 3 } },
          undefined,
          isoAfter(NOW, 1_000),
        );
        expect(finished?.status).toBe('succeeded');
        expect(finished?.finishedAt).toBe(isoAfter(NOW, 1_000));
        expect(finished?.result).toEqual({ summary: 'done', steps: 3 });
        expect(finished?.checkpoint).toEqual({ step: 3 });

        expect(
          await store.updateActivation(running.id, ['running'], { status: 'failed' }, undefined, NOW),
        ).toBeNull();

        const patched = await store.updateActivation(
          running.id,
          ['succeeded'],
          { generation: 2, leaseExpiresAt: null, error: 'stale lease' },
          undefined,
          isoAfter(NOW, 2_000),
        );
        expect(patched?.generation).toBe(2);
        expect(patched?.leaseExpiresAt).toBeNull();
        expect(patched?.error).toBe('stale lease');
        expect(patched?.finishedAt).toBe(isoAfter(NOW, 1_000));

        expect(
          await store.updateActivation('missing_activation', ['running'], { status: 'failed' }),
        ).toBeNull();
      });

      it('finds only running activations whose lease has passed', async () => {
        const expired = await store.createActivation({
          activation: makeActivation({
            runId: run.id,
            memberId: 'member_expired',
            status: 'running',
            createdAt: isoAfter(NOW, 10),
            leaseExpiresAt: isoAfter(NOW, 20),
          }),
          maxActivations: 10,
        });
        const live = await store.createActivation({
          activation: makeActivation({
            runId: run.id,
            memberId: 'member_live',
            status: 'running',
            createdAt: isoAfter(NOW, 10),
            leaseExpiresAt: isoAfter(NOW, 10_000),
          }),
          maxActivations: 10,
        });
        await store.createActivation({
          activation: makeActivation({
            runId: run.id,
            memberId: 'member_idle',
            status: 'queued',
            createdAt: isoAfter(NOW, 10),
            leaseExpiresAt: isoAfter(NOW, 20),
          }),
          maxActivations: 10,
        });

        const found = await store.expiredActivations(isoAfter(NOW, 100));
        expect(found.map((activation) => activation.id)).toEqual([expired.id]);
        expect(found.map((activation) => activation.id)).not.toContain(live.id);
      });
    });

    // ------------------------------------------------------------- tasks -----

    describe('tasks', () => {
      it('creates tasks, enforces the run limit and pages the list', async () => {
        const first = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id, createdAt: NOW }),
          maxTasks: 10,
        });
        const second = await store.createTask({
          task: makeTask({
            teamId: team.id,
            runId: run.id,
            title: 'Second',
            createdAt: isoAfter(NOW, 10),
          }),
          maxTasks: 10,
        });
        const third = await store.createTask({
          task: makeTask({
            teamId: team.id,
            runId: run.id,
            title: 'Third',
            createdAt: isoAfter(NOW, 20),
          }),
          maxTasks: 10,
        });

        expect(await store.getTask(first.id)).toEqual(first);
        expect(await store.getTask('missing_task')).toBeNull();
        expect(await store.countTasks(run.id)).toBe(3);
        expect(await store.countTasks('another_run')).toBe(0);

        const limitError = await expectTeamError(
          store.createTask({
            task: makeTask({ teamId: team.id, runId: run.id }),
            maxTasks: 3,
          }),
          'TEAM_TASK_LIMIT',
        );
        expect(limitError.detail).toMatchObject({ runId: run.id, count: 3, max: 3 });

        const page = await store.listTasks(run.id, { limit: 2, offset: 0 });
        expect(page.total).toBe(3);
        expect(page.items.map((task) => task.id)).toEqual([first.id, second.id]);

        const rest = await store.listTasks(run.id, { limit: 2, offset: 2 });
        expect(rest.total).toBe(3);
        expect(rest.items.map((task) => task.id)).toEqual([third.id]);

        const pending = await store.listTasks(run.id, { status: 'pending' });
        expect(pending.total).toBe(3);
        const running = await store.listTasks(run.id, { status: 'running' });
        expect(running.total).toBe(0);
        expect(running.items).toEqual([]);

        expect(
          (await store.listTasksByIds(run.id, [third.id, first.id, 'missing_task'])).map(
            (task) => task.id,
          ),
        ).toEqual([third.id, first.id]);
        expect(await store.listTasksByIds(run.id, [])).toEqual([]);
      });

      it('applies updates with compare-and-set on the revision', async () => {
        const task = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
        });

        const stale = await store.updateTask({
          taskId: task.id,
          expectedRevision: task.revision + 7,
          patch: { title: 'should not apply' },
          now: isoAfter(NOW, 100),
        });
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.current.id).toBe(task.id);
        expect((await store.getTask(task.id))?.title).toBe(task.title);

        const updated = await store.updateTask({
          taskId: task.id,
          expectedRevision: task.revision,
          patch: {
            title: 'Renamed',
            dependencies: ['task_dep_1'],
            writeScopes: ['src/a.ts', 'src/b.ts'],
            required: false,
          },
          now: isoAfter(NOW, 200),
        });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          expect(updated.value.revision).toBe(task.revision + 1);
          expect(updated.value.title).toBe('Renamed');
          expect(updated.value.dependencies).toEqual(['task_dep_1']);
          expect(updated.value.writeScopes).toEqual(['src/a.ts', 'src/b.ts']);
          expect(updated.value.required).toBe(false);
          expect(updated.value.updatedAt).toBe(isoAfter(NOW, 200));
        }

        await expectTeamError(
          store.updateTask({
            taskId: 'missing_task',
            expectedRevision: 1,
            patch: { title: 'nope' },
            now: NOW,
          }),
          'TEAM_TASK_NOT_FOUND',
        );
      });

      it('claims a pending task once and creates an attempt', async () => {
        const task = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
        });

        const stale = await store.claimTask({
          taskId: task.id,
          expectedRevision: task.revision + 1,
          memberId: root.id,
          activationId: null,
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: NOW,
        });
        expect(stale.ok).toBe(false);

        const claimed = await store.claimTask({
          taskId: task.id,
          expectedRevision: task.revision,
          memberId: root.id,
          activationId: 'activation_claim',
          generation: 1,
          leaseExpiresAt: isoAfter(NOW, 60_000),
          baselineId: 'baseline_1',
          now: isoAfter(NOW, 100),
        });
        expect(claimed.ok).toBe(true);
        if (!claimed.ok) return;

        expect(claimed.value.task.status).toBe('running');
        expect(claimed.value.task.revision).toBe(task.revision + 1);
        expect(claimed.value.task.ownerId).toBe(root.id);
        expect(claimed.value.task.currentAttemptId).toBe(claimed.value.attempt.id);
        expect(claimed.value.attempt.id.startsWith('att_')).toBe(true);
        expect(claimed.value.attempt.activationId).toBe('activation_claim');
        expect(claimed.value.attempt.generation).toBe(1);
        expect(claimed.value.attempt.leaseExpiresAt).toBe(isoAfter(NOW, 60_000));
        expect(claimed.value.attempt.baselineId).toBe('baseline_1');
        expect(claimed.value.attempt.submission).toBeNull();
        expect(claimed.value.attempt.review).toBeNull();

        expect(await store.getAttempt(claimed.value.attempt.id)).toEqual(claimed.value.attempt);
        expect(await store.listAttempts(task.id)).toEqual([claimed.value.attempt]);
        expect(await store.findAttemptByActivation('activation_claim')).toEqual(
          claimed.value.attempt,
        );
        expect(await store.findAttemptByActivation('no_such_activation')).toBeNull();

        // Running is not pending: a second claim loses even with the new revision.
        const second = await store.claimTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision,
          memberId: root.id,
          activationId: null,
          generation: 2,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 200),
        });
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.current.status).toBe('running');
        expect(await store.listAttempts(task.id)).toHaveLength(1);
      });

      it('submits only from a running task with the current attempt', async () => {
        const task = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
        });
        const claimed = await store.claimTask({
          taskId: task.id,
          expectedRevision: task.revision,
          memberId: root.id,
          activationId: 'activation_submit',
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 100),
        });
        if (!claimed.ok) throw new Error('expected claim to succeed');
        const submission: TaskSubmission = {
          summary: 'implemented the parser',
          artifactIds: ['artifact_1'],
          testEvidence: ['npx vitest run tests/teams'],
          candidateHash: 'candidate_1',
          submittedAt: isoAfter(NOW, 300),
          submittedBy: root.id,
        };

        const wrongAttempt = await store.submitTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision,
          attemptId: 'att_wrong',
          submission,
          now: isoAfter(NOW, 300),
        });
        expect(wrongAttempt.ok).toBe(false);

        const stale = await store.submitTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision - 1,
          attemptId: claimed.value.attempt.id,
          submission,
          now: isoAfter(NOW, 300),
        });
        expect(stale.ok).toBe(false);

        const submitted = await store.submitTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision,
          attemptId: claimed.value.attempt.id,
          submission,
          now: isoAfter(NOW, 300),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.task.status).toBe('submitted');
        expect(submitted.value.task.submittedAt).toBe(isoAfter(NOW, 300));
        expect(submitted.value.task.revision).toBe(claimed.value.task.revision + 1);
        expect(submitted.value.attempt.submission).toEqual(submission);

        const again = await store.submitTask({
          taskId: task.id,
          expectedRevision: submitted.value.task.revision,
          attemptId: claimed.value.attempt.id,
          submission,
          now: isoAfter(NOW, 400),
        });
        expect(again.ok).toBe(false);
        if (!again.ok) expect(again.current.status).toBe('submitted');
      });

      it('keeps the rejected attempt and returns the task to pending', async () => {
        const task = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
        });
        const claimed = await store.claimTask({
          taskId: task.id,
          expectedRevision: task.revision,
          memberId: root.id,
          activationId: 'activation_reject',
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 100),
        });
        if (!claimed.ok) throw new Error('expected claim to succeed');
        const submitted = await store.submitTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision,
          attemptId: claimed.value.attempt.id,
          submission: {
            summary: 'first try',
            artifactIds: [],
            testEvidence: [],
            candidateHash: null,
            submittedAt: isoAfter(NOW, 200),
            submittedBy: root.id,
          },
          now: isoAfter(NOW, 200),
        });
        if (!submitted.ok) throw new Error('expected submit to succeed');

        const reviewed = await store.reviewTask({
          taskId: task.id,
          expectedRevision: submitted.value.task.revision,
          attemptId: claimed.value.attempt.id,
          review: {
            decision: 'rejected',
            reviewerId: root.id,
            reason: 'no test evidence',
            evidence: ['acceptance requires a test'],
            candidateHash: null,
            reviewedAt: isoAfter(NOW, 300),
          },
          now: isoAfter(NOW, 300),
        });
        expect(reviewed.ok).toBe(true);
        if (!reviewed.ok) return;
        expect(reviewed.value.task.status).toBe('pending');
        expect(reviewed.value.task.currentAttemptId).toBeNull();
        expect(reviewed.value.task.acceptedAt).toBeNull();
        expect(reviewed.value.task.revision).toBe(submitted.value.task.revision + 1);
        expect(reviewed.value.attempt.review?.decision).toBe('rejected');

        // The old attempt is retained, with its submission and its review.
        const attempts = await store.listAttempts(task.id);
        expect(attempts).toHaveLength(1);
        expect(attempts.at(0)?.id).toBe(claimed.value.attempt.id);
        expect(attempts.at(0)?.submission?.summary).toBe('first try');
        expect(attempts.at(0)?.review?.reason).toBe('no test evidence');

        // Reviewing a pending task is a conflict, not a second decision.
        const pendingReview = await store.reviewTask({
          taskId: task.id,
          expectedRevision: reviewed.value.task.revision,
          attemptId: claimed.value.attempt.id,
          review: {
            decision: 'accepted',
            reviewerId: root.id,
            reason: 'late',
            evidence: [],
            candidateHash: null,
            reviewedAt: isoAfter(NOW, 400),
          },
          now: isoAfter(NOW, 400),
        });
        expect(pendingReview.ok).toBe(false);

        // A re-claim creates a new attempt and the old one stays for the record.
        const reclaimed = await store.claimTask({
          taskId: task.id,
          expectedRevision: reviewed.value.task.revision,
          memberId: root.id,
          activationId: 'activation_retry',
          generation: 2,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 500),
        });
        expect(reclaimed.ok).toBe(true);
        if (!reclaimed.ok) return;
        expect(reclaimed.value.attempt.id).not.toBe(claimed.value.attempt.id);
        expect(await store.listAttempts(task.id)).toHaveLength(2);
        expect(await store.findAttemptByActivation('activation_reject')).toEqual(
          attempts.at(0),
        );
      });

      it('accepts a submission and leaves the task terminal', async () => {
        const task = await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
        });
        const claimed = await store.claimTask({
          taskId: task.id,
          expectedRevision: task.revision,
          memberId: root.id,
          activationId: null,
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 100),
        });
        if (!claimed.ok) throw new Error('expected claim to succeed');
        const submitted = await store.submitTask({
          taskId: task.id,
          expectedRevision: claimed.value.task.revision,
          attemptId: claimed.value.attempt.id,
          submission: {
            summary: 'done',
            artifactIds: [],
            testEvidence: ['npx vitest run tests/teams'],
            candidateHash: 'candidate_1',
            submittedAt: isoAfter(NOW, 200),
            submittedBy: root.id,
          },
          now: isoAfter(NOW, 200),
        });
        if (!submitted.ok) throw new Error('expected submit to succeed');

        const accepted = await store.reviewTask({
          taskId: task.id,
          expectedRevision: submitted.value.task.revision,
          attemptId: claimed.value.attempt.id,
          review: {
            decision: 'accepted',
            reviewerId: 'member_reviewer',
            reason: 'tests pass',
            evidence: ['npx vitest run tests/teams: 42 passed'],
            candidateHash: 'candidate_1',
            reviewedAt: isoAfter(NOW, 300),
          },
          now: isoAfter(NOW, 300),
        });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) return;
        expect(accepted.value.task.status).toBe('accepted');
        expect(accepted.value.task.acceptedAt).toBe(isoAfter(NOW, 300));
        expect(accepted.value.attempt.review?.decision).toBe('accepted');

        const terminalClaim = await store.claimTask({
          taskId: task.id,
          expectedRevision: accepted.value.task.revision,
          memberId: root.id,
          activationId: null,
          generation: 1,
          leaseExpiresAt: null,
          baselineId: null,
          now: isoAfter(NOW, 400),
        });
        expect(terminalClaim.ok).toBe(false);
      });

      it('writes an event with the task mutation', async () => {
        await store.createTask({
          task: makeTask({ teamId: team.id, runId: run.id }),
          maxTasks: 10,
          event: { kind: 'task.created', payload: { title: 'Write the parser' } },
        });
        const events = await store.listEvents(run.id, 0);
        expect(events).toHaveLength(1);
        expect(events.at(0)?.kind).toBe('task.created');
      });
    });

    // ---------------------------------------------------------- messages -----

    describe('messages', () => {
      it('is idempotent per (sender, recipient, clientMessageId) and conflicts on a new body', async () => {
        const message = makeMessage({
          teamId: team.id,
          runId: run.id,
          senderId: root.id,
          recipientId: 'member_a',
          clientMessageId: 'client_key_1',
          body: 'first body',
        });

        const first = await store.appendMessage({
          message,
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        expect(first.duplicate).toBe(false);
        expect(first.message.sequence).toBe(1);
        expect(first.message.id).toBe(message.id);

        const replay = await store.appendMessage({
          message: makeMessage({ ...message, id: `msg_${randomUUID()}` }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        expect(replay.duplicate).toBe(true);
        expect(replay.message.id).toBe(message.id);
        expect(replay.message.sequence).toBe(1);

        const conflict = await expectTeamError(
          store.appendMessage({
            message: makeMessage({ ...message, body: 'a different body' }),
            maxMessages: 100,
            maxQueuedPerMember: 100,
          }),
          'TEAM_MESSAGE_CONFLICT',
        );
        expect(conflict.status).toBe(409);

        const second = await store.appendMessage({
          message: makeMessage({
            teamId: team.id,
            runId: run.id,
            senderId: root.id,
            recipientId: 'member_a',
            clientMessageId: 'client_key_2',
            body: 'second body',
            createdAt: isoAfter(NOW, 10),
          }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        expect(second.message.sequence).toBe(2);

        expect(await store.getMessage(message.id)).toEqual(first.message);
        expect(await store.getMessage('missing_message')).toBeNull();
      });

      it('pages messages by sequence and lists pending ones oldest first', async () => {
        const first = await store.appendMessage({
          message: makeMessage({
            teamId: team.id,
            runId: run.id,
            recipientId: 'member_a',
            clientMessageId: 'page_1',
            createdAt: NOW,
          }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        const second = await store.appendMessage({
          message: makeMessage({
            teamId: team.id,
            runId: run.id,
            recipientId: 'member_a',
            clientMessageId: 'page_2',
            createdAt: isoAfter(NOW, 10),
          }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });

        expect(
          (await store.pendingMessages('member_a')).map((message) => message.id),
        ).toEqual([first.message.id, second.message.id]);

        const page = await store.listMessages(run.id, 1);
        expect(page.total).toBe(1);
        expect(page.items.map((message) => message.sequence)).toEqual([2]);

        const all = await store.listMessages(run.id, 0);
        expect(all.total).toBe(2);
        expect(all.items.map((message) => message.sequence)).toEqual([1, 2]);
        expect(await store.listMessages('another_run', 0)).toEqual({ items: [], total: 0 });
      });

      it('marks messages through the accepted → injected → processed path only', async () => {
        const appended = await store.appendMessage({
          message: makeMessage({ teamId: team.id, runId: run.id, recipientId: 'member_a' }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        const id = appended.message.id;

        const injected = await store.markMessage(
          id,
          ['accepted'],
          { state: 'injected', activationId: 'activation_1' },
          undefined,
          isoAfter(NOW, 100),
        );
        expect(injected?.state).toBe('injected');
        expect(injected?.injectedAt).toBe(isoAfter(NOW, 100));
        expect(injected?.activationId).toBe('activation_1');

        // The same accepted → injected transition cannot run twice.
        expect(
          await store.markMessage(id, ['accepted'], { state: 'injected' }, undefined, NOW),
        ).toBeNull();
        // Skipping a step is not allowed either.
        expect(
          await store.markMessage(id, ['accepted'], { state: 'processed' }, undefined, NOW),
        ).toBeNull();

        expect(await store.pendingMessages('member_a')).toEqual([]);

        const processed = await store.markMessage(
          id,
          ['injected'],
          { state: 'processed' },
          undefined,
          isoAfter(NOW, 200),
        );
        expect(processed?.state).toBe('processed');
        expect(processed?.processedAt).toBe(isoAfter(NOW, 200));

        expect(await store.markMessage('missing_message', ['accepted'], { state: 'failed' })).toBeNull();
      });

      it('enforces the per-recipient queue limit', async () => {
        for (const key of ['queue_1', 'queue_2']) {
          await store.appendMessage({
            message: makeMessage({
              teamId: team.id,
              runId: run.id,
              recipientId: 'member_queue',
              clientMessageId: key,
            }),
            maxMessages: 100,
            maxQueuedPerMember: 2,
          });
        }
        const error = await expectTeamError(
          store.appendMessage({
            message: makeMessage({
              teamId: team.id,
              runId: run.id,
              recipientId: 'member_queue',
              clientMessageId: 'queue_3',
            }),
            maxMessages: 100,
            maxQueuedPerMember: 2,
          }),
          'TEAM_MESSAGE_LIMIT',
        );
        expect(error.detail).toMatchObject({ recipientId: 'member_queue', queued: 2, max: 2 });
        expect((await store.pendingMessages('member_queue')).length).toBe(2);
      });

      it('enforces the per-run message limit', async () => {
        await store.appendMessage({
          message: makeMessage({ teamId: team.id, runId: run.id, recipientId: 'member_a' }),
          maxMessages: 100,
          maxQueuedPerMember: 100,
        });
        const total = (await store.listMessages(run.id, 0)).total;
        expect(total).toBe(1);

        const error = await expectTeamError(
          store.appendMessage({
            message: makeMessage({
              teamId: team.id,
              runId: run.id,
              recipientId: 'member_b',
              clientMessageId: 'run_limit_1',
            }),
            maxMessages: total,
            maxQueuedPerMember: 100,
          }),
          'TEAM_MESSAGE_LIMIT',
        );
        expect(error.detail).toMatchObject({ runId: run.id, count: 1, max: 1 });
      });
    });

    // --------------------------------------------------------- artifacts -----

    describe('artifacts', () => {
      it('creates artifacts and filters them by run, task and attempt', async () => {
        const fromTask = await store.createArtifact({
          artifact: makeArtifact({
            teamId: team.id,
            runId: run.id,
            taskId: 'task_1',
            attemptId: 'attempt_1',
            createdAt: NOW,
          }),
        });
        const second = await store.createArtifact({
          artifact: makeArtifact({
            teamId: team.id,
            runId: run.id,
            taskId: 'task_1',
            attemptId: 'attempt_1',
            kind: 'test',
            createdAt: isoAfter(NOW, 10),
          }),
        });
        const other = await store.createArtifact({
          artifact: makeArtifact({
            teamId: team.id,
            runId: run.id,
            taskId: 'task_2',
            attemptId: 'attempt_2',
            createdAt: isoAfter(NOW, 20),
          }),
        });

        expect(await store.getArtifact(fromTask.id)).toEqual(fromTask);
        expect(await store.getArtifact('missing_artifact')).toBeNull();
        expect(fromTask.manifest.files).toHaveLength(1);
        expect(fromTask.manifest.files.at(0)?.contentHash).toBe('content_1');

        expect((await store.listArtifacts({ runId: run.id })).map((a) => a.id)).toEqual([
          fromTask.id,
          second.id,
          other.id,
        ]);
        expect(
          (await store.listArtifacts({ runId: run.id, taskId: 'task_1' })).map((a) => a.id),
        ).toEqual([fromTask.id, second.id]);
        expect(
          (await store.listArtifacts({ runId: run.id, attemptId: 'attempt_1' })).map((a) => a.id),
        ).toEqual([fromTask.id, second.id]);
        expect((await store.listArtifacts({ runId: run.id, limit: 1 })).map((a) => a.id)).toEqual([
          fromTask.id,
        ]);
        expect(await store.listArtifacts({ runId: 'another_run' })).toEqual([]);
      });
    });

    // ------------------------------------------------------------ events -----

    describe('events', () => {
      it('assigns a monotonic per-run sequence and honours idempotency keys', async () => {
        const first = await store.appendEvent(
          team.id,
          run.id,
          { kind: 'run.created', payload: { step: 1 } },
          NOW,
        );
        expect(first.sequence).toBe(1);
        expect(first.payload).toEqual({ step: 1 });
        expect(first.idempotencyKey).toBeNull();

        const second = await store.appendEvent(
          team.id,
          run.id,
          { kind: 'run.status', payload: { to: 'running' }, idempotencyKey: 'key_1' },
          isoAfter(NOW, 10),
        );
        expect(second.sequence).toBe(2);

        const replay = await store.appendEvent(
          team.id,
          run.id,
          { kind: 'run.status', payload: { to: 'succeeded' }, idempotencyKey: 'key_1' },
          isoAfter(NOW, 20),
        );
        expect(replay.id).toBe(second.id);
        expect(replay.sequence).toBe(2);
        expect(replay.payload).toEqual({ to: 'running' });

        const third = await store.appendEvent(
          team.id,
          run.id,
          { kind: 'run.summary' },
          isoAfter(NOW, 30),
        );
        expect(third.sequence).toBe(3);

        expect(await store.latestEventSequence(run.id)).toBe(3);
        expect(await store.latestEventSequence('a_run_without_events')).toBe(0);

        expect((await store.listEvents(run.id, 0)).map((event) => event.sequence)).toEqual([
          1, 2, 3,
        ]);
        expect((await store.listEvents(run.id, 1)).map((event) => event.sequence)).toEqual([2, 3]);
        expect((await store.listEvents(run.id, 0, 2)).map((event) => event.sequence)).toEqual([
          1, 2,
        ]);
        expect(await store.listEvents('another_run', 0)).toEqual([]);
      });

      it('supports the team-scoped event stream used for team lifecycle events', async () => {
        // The service writes team.created/config under the literal scope
        // `team`, which is not a run id. That must not require a run row.
        const first = await store.appendEvent(
          team.id,
          'team',
          { kind: 'team.created', payload: { teamId: team.id } },
          NOW,
        );
        expect(first.sequence).toBe(1);
        expect(first.runId).toBe('team');

        const second = await store.appendEvent(
          team.id,
          'team',
          { kind: 'team.config', payload: { configRevision: 2 } },
          isoAfter(NOW, 10),
        );
        expect(second.sequence).toBe(2);
        expect(await store.latestEventSequence('team')).toBe(2);
        expect((await store.listEvents('team', 0)).map((event) => event.kind)).toEqual([
          'team.created',
          'team.config',
        ]);

        // The run-scoped cursor is independent of the team-scoped one.
        expect(await store.latestEventSequence(run.id)).toBe(0);
      });
    });

    // ------------------------------------------------------------ budget -----

    describe('budget', () => {
      it('never oversubscribes tokens under concurrent reservations', async () => {
        expect(run.budget).toEqual(DEFAULT_RUN_BUDGET);

        // Ten callers, each asking for a quarter of the input budget. Four fit;
        // the rest must be refused, never partially reserved.
        const outcomes = await Promise.all(
          Array.from({ length: 10 }, async (_unused, index) => {
            try {
              await store.reserveBudget({
                id: `budget_${randomUUID()}`,
                runId: run.id,
                memberId: root.id,
                activationId: null,
                requestKey: `request_${index}`,
                generation: 1,
                inputTokens: 250,
                outputTokens: 10,
                estimatedCostUsd: null,
                priceVersion: 'price_v1',
                now: isoAfter(NOW, index),
              });
              return null;
            } catch (error) {
              return error as TeamError;
            }
          }),
        );

        const failures = outcomes.filter((outcome): outcome is TeamError => outcome !== null);
        expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(4);
        expect(failures).toHaveLength(6);
        for (const failure of failures) {
          expect(failure).toBeInstanceOf(TeamError);
          expect(failure.code).toBe('TEAM_BUDGET_EXHAUSTED');
          expect(failure.detail).toMatchObject({ dimension: 'input', runId: run.id });
        }

        const entries = await store.listBudgetEntries(run.id);
        expect(entries).toHaveLength(4);
        const reserved = entries.reduce((sum, entry) => sum + entry.reservedInputTokens, 0);
        expect(reserved).toBe(DEFAULT_RUN_BUDGET.maxInputTokens);

        const snapshot = await store.budgetSnapshot(run.id);
        expect(snapshot.remainingInputTokens).toBe(0);
        expect(snapshot.reservedRequests).toBe(4);
        expect(snapshot.settledRequests).toBe(0);
        expect(snapshot.exhausted).toBe(true);
        expect(snapshot.limits).toEqual(DEFAULT_RUN_BUDGET);
      });

      it('treats a repeated request key as the same reservation', async () => {
        const first = await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: run.id,
          memberId: root.id,
          activationId: null,
          requestKey: 'request_idempotent',
          generation: 1,
          inputTokens: 100,
          outputTokens: 20,
          estimatedCostUsd: null,
          priceVersion: 'price_v1',
          now: NOW,
        });
        const replay = await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: run.id,
          memberId: root.id,
          activationId: null,
          requestKey: 'request_idempotent',
          generation: 1,
          inputTokens: 900,
          outputTokens: 400,
          estimatedCostUsd: null,
          priceVersion: 'price_v1',
          now: isoAfter(NOW, 10),
        });
        expect(replay.entry.id).toBe(first.entry.id);
        expect(replay.entry.reservedInputTokens).toBe(100);
        expect(replay.snapshot.reservedInputTokens).toBe(100);
        expect(await store.listBudgetEntries(run.id)).toHaveLength(1);
      });

      it('refuses an over-limit output reservation with the output dimension', async () => {
        const error = await expectTeamError(
          store.reserveBudget({
            id: `budget_${randomUUID()}`,
            runId: run.id,
            memberId: root.id,
            activationId: null,
            requestKey: 'request_output',
            generation: 1,
            inputTokens: 10,
            outputTokens: DEFAULT_RUN_BUDGET.maxOutputTokens + 1,
            estimatedCostUsd: null,
            priceVersion: null,
            now: NOW,
          }),
          'TEAM_BUDGET_EXHAUSTED',
        );
        expect(error.detail).toMatchObject({ dimension: 'output' });
        expect(await store.listBudgetEntries(run.id)).toEqual([]);
      });

      it('refuses a reservation past the request budget', async () => {
        const limited = await store.createRun(
          createRunInputFrom(
            makeRun({
              teamId: team.id,
              ownerId: team.ownerId,
              rootConversationId: `conv_limited_${randomUUID()}`,
              budget: { ...DEFAULT_RUN_BUDGET, maxRequests: 1 },
            }),
          ),
        );
        await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: limited.run.id,
          memberId: root.id,
          activationId: null,
          requestKey: 'request_1',
          generation: 1,
          inputTokens: 10,
          outputTokens: 10,
          estimatedCostUsd: null,
          priceVersion: null,
          now: NOW,
        });
        const error = await expectTeamError(
          store.reserveBudget({
            id: `budget_${randomUUID()}`,
            runId: limited.run.id,
            memberId: root.id,
            activationId: null,
            requestKey: 'request_2',
            generation: 1,
            inputTokens: 10,
            outputTokens: 10,
            estimatedCostUsd: null,
            priceVersion: null,
            now: isoAfter(NOW, 10),
          }),
          'TEAM_BUDGET_EXHAUSTED',
        );
        expect(error.detail).toMatchObject({ dimension: 'requests' });
      });

      it('settles a reservation and reports run usage', async () => {
        const reservation = await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: run.id,
          memberId: root.id,
          activationId: 'activation_1',
          requestKey: 'request_settle',
          generation: 1,
          inputTokens: 400,
          outputTokens: 100,
          estimatedCostUsd: 0.05,
          priceVersion: 'price_v1',
          now: NOW,
        });
        expect(reservation.entry.status).toBe('reserved');
        expect(reservation.entry.inputTokens).toBeNull();
        expect(reservation.snapshot.reservedInputTokens).toBe(400);

        const settled = await store.settleBudget({
          entryId: reservation.entry.id,
          usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 10 },
          incomplete: false,
          estimatedCostUsd: 0.02,
          now: isoAfter(NOW, 100),
        });
        expect(settled?.status).toBe('settled');
        expect(settled?.inputTokens).toBe(120);
        expect(settled?.outputTokens).toBe(30);
        expect(settled?.cachedTokens).toBe(10);
        expect(settled?.estimatedCostUsd).toBe(0.02);
        expect(settled?.settledAt).toBe(isoAfter(NOW, 100));

        // A settled entry cannot be settled twice.
        expect(
          await store.settleBudget({
            entryId: reservation.entry.id,
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 1 },
            incomplete: false,
            now: isoAfter(NOW, 200),
          }),
        ).toBeNull();
        expect(
          await store.settleBudget({
            entryId: 'missing_entry',
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 1 },
            incomplete: false,
            now: isoAfter(NOW, 200),
          }),
        ).toBeNull();

        const snapshot = await store.budgetSnapshot(run.id);
        expect(snapshot.settledInputTokens).toBe(120);
        expect(snapshot.settledOutputTokens).toBe(30);
        expect(snapshot.reservedInputTokens).toBe(0);
        expect(snapshot.remainingInputTokens).toBe(DEFAULT_RUN_BUDGET.maxInputTokens - 120);
        expect(snapshot.settledRequests).toBe(1);
        expect(snapshot.exhausted).toBe(false);

        const usage = await store.runUsage(run.id);
        expect(usage.inputTokens).toBe(120);
        expect(usage.outputTokens).toBe(30);
        expect(usage.cachedTokens).toBe(10);
        expect(usage.requests).toBe(1);
        expect(usage.measuredRequests).toBe(1);
        expect(usage.incomplete).toBe(false);
      });

      it('keeps the reservation when settlement reports an incomplete usage', async () => {
        const reservation = await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: run.id,
          memberId: root.id,
          activationId: null,
          requestKey: 'request_incomplete',
          generation: 1,
          inputTokens: 200,
          outputTokens: 50,
          estimatedCostUsd: null,
          priceVersion: null,
          now: NOW,
        });

        const settled = await store.settleBudget({
          entryId: reservation.entry.id,
          usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
          incomplete: true,
          now: isoAfter(NOW, 100),
        });
        expect(settled?.status).toBe('incomplete');
        expect(settled?.inputTokens).toBeNull();

        const snapshot = await store.budgetSnapshot(run.id);
        expect(snapshot.incompleteEntries).toBe(1);
        expect(snapshot.reservedInputTokens).toBe(200);
        expect(snapshot.remainingInputTokens).toBe(DEFAULT_RUN_BUDGET.maxInputTokens - 200);

        const usage = await store.runUsage(run.id);
        expect(usage.incomplete).toBe(true);
        expect(usage.inputTokens).toBe(200);
        expect(usage.outputTokens).toBe(50);
        expect(usage.requests).toBe(1);
        // Nothing was measured: the provider never answered.
        expect(usage.measuredRequests).toBe(0);
      });

      it('flags exhaustion when the estimated cost passes its ceiling', async () => {
        const capped = await store.createRun(
          createRunInputFrom(
            makeRun({
              teamId: team.id,
              ownerId: team.ownerId,
              rootConversationId: `conv_cost_${randomUUID()}`,
              budget: { ...DEFAULT_RUN_BUDGET, maxEstimatedCostUsd: 0.05 },
            }),
          ),
        );
        await store.reserveBudget({
          id: `budget_${randomUUID()}`,
          runId: capped.run.id,
          memberId: root.id,
          activationId: null,
          requestKey: 'request_cost',
          generation: 1,
          inputTokens: 10,
          outputTokens: 10,
          estimatedCostUsd: 0.2,
          priceVersion: 'price_v1',
          now: NOW,
        });
        const snapshot = await store.budgetSnapshot(capped.run.id);
        expect(snapshot.estimatedCostUsd).toBeCloseTo(0.2);
        expect(snapshot.exhausted).toBe(true);
      });

      it('returns an empty snapshot for a run with no entries', async () => {
        const snapshot = await store.budgetSnapshot(run.id);
        expect(snapshot.reservedInputTokens).toBe(0);
        expect(snapshot.settledInputTokens).toBe(0);
        expect(snapshot.remainingInputTokens).toBe(DEFAULT_RUN_BUDGET.maxInputTokens);
        expect(snapshot.remainingRequests).toBe(DEFAULT_RUN_BUDGET.maxRequests);
        expect(snapshot.incompleteEntries).toBe(0);
        expect(snapshot.exhausted).toBe(false);
        expect(await store.listBudgetEntries(run.id)).toEqual([]);
        expect(await store.runUsage(run.id)).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          requests: 0,
          measuredRequests: 0,
          incomplete: false,
        });
        await expectTeamError(store.budgetSnapshot('missing_run'), 'TEAM_RUN_NOT_FOUND');
      });
    });

    // ------------------------------------------------------- integrations -----

    describe('integrations', () => {
      it('creates, lists and updates an integration', async () => {
        const first = await store.createIntegration({
          integration: makeIntegration({ teamId: team.id, runId: run.id }),
        });
        const second = await store.createIntegration({
          integration: makeIntegration({
            teamId: team.id,
            runId: run.id,
            createdAt: isoAfter(NOW, 10),
            updatedAt: isoAfter(NOW, 10),
          }),
        });

        expect(await store.getIntegration(first.id)).toEqual(first);
        expect(await store.getIntegration('missing_integration')).toBeNull();
        expect(
          await store.createIntegration({
            integration: makeIntegration({ ...first, taskId: 'task_ignored' }),
          }),
        ).toEqual(first);

        expect((await store.listIntegrations(run.id)).map((row) => row.id)).toEqual([
          first.id,
          second.id,
        ]);
        expect(await store.listIntegrations('another_run')).toEqual([]);

        const updated = await store.updateIntegration({
          integrationId: first.id,
          patch: {
            status: 'conflict',
            conflicts: ['src/parser.ts'],
            journal: [
              { at: NOW, action: 'created' },
              { at: isoAfter(NOW, 100), action: 'failed', detail: 'overlapping hunk' },
            ],
          },
          now: isoAfter(NOW, 100),
        });
        expect(updated?.status).toBe('conflict');
        expect(updated?.conflicts).toEqual(['src/parser.ts']);
        expect(updated?.journal).toHaveLength(2);
        expect(updated?.updatedAt).toBe(isoAfter(NOW, 100));
        expect(updated?.publishedAt).toBeNull();

        const published = await store.updateIntegration({
          integrationId: first.id,
          patch: { status: 'published', verification: { tests: 'pass' } },
          now: isoAfter(NOW, 200),
        });
        expect(published?.status).toBe('published');
        expect(published?.publishedAt).toBe(isoAfter(NOW, 200));
        expect(published?.verification).toEqual({ tests: 'pass' });

        expect(
          await store.updateIntegration({ integrationId: 'missing', patch: {}, now: NOW }),
        ).toBeNull();
      });
    });

    // ---------------------------------------------------------- plumbing -----

    describe('plumbing', () => {
      it('answers a ping', async () => {
        expect(await store.ping()).toBe(true);
      });

      it('does not hand out state that a caller can mutate', async () => {
        const read = await store.getTask(
          (
            await store.createTask({
              task: makeTask({ teamId: team.id, runId: run.id }),
              maxTasks: 10,
            })
          ).id,
        );
        if (!read) throw new Error('expected a task');
        const mutable = read as { title: string };
        mutable.title = 'mutated by the caller';
        expect((await store.getTask(read.id))?.title).toBe('Write the parser');

        const events: readonly TeamEvent[] = await store.listEvents(run.id, 0);
        expect(events).toEqual([]);
        const messages: readonly TeamMessage[] = await store.pendingMessages('member_a');
        expect(messages).toEqual([]);
        const tasks: readonly Task[] = (await store.listTasks(run.id)).items;
        expect(tasks).toHaveLength(1);
        const activations: readonly Activation[] = await store.listActivations(run.id);
        expect(activations).toEqual([]);
      });
    });
  });
}
