/**
 * R12 fault child: a real Node process with a real SQLite database.
 *
 * The parent starts this file with an IPC channel, watches for `{type:'fault'}`,
 * then kills it. Nothing here is an API; `EUNOIA_TEST_FAULT_POINTS` is set only
 * by the test parent.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { runTurn } from '../../src/service/chat.ts';
import { TurnCoordinator, turnRequestHash } from '../../src/service/turns.ts';
import { recoverInterruptedTurns } from '../../src/service/recovery.ts';
import { defineTool } from '../../src/tools/types.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';
import { publishCandidate } from '../../src/teams/integration.ts';
import { openSqliteTeamStore } from '../../src/teams/store-sqlite.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { SessionService } from '../../src/session/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import { makeMember, makeMessage, makeRun, makeTeam, createRunInputFrom, createTeamInputFrom } from '../teams/helpers.ts';
import type { ArtifactFile } from '../../src/teams/types.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function toolEffect(): Promise<void> {
  const store = openSqliteStore(arg('db'));
  try {
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER, 'fault-tool');
    const counter = arg('counter');
    const tool = defineTool({
      name: 'fault_effect',
      description: 'test-only: perform an external effect and pause',
      parameters: z.object({ value: z.string() }),
      sideEffect: 'command',
      readOnly: false,
      async execute({ value }) {
        appendFileSync(counter, `${value}\n`);
        await (await import('../../src/observability/faults.ts')).faultPoint('tool.effect.done', {
          counter,
        });
        return { ok: true, output: 'effect done' };
      },
    });
    let step = 0;
    const model: ModelTurn = async function* () {
      step += 1;
      if (step === 1) {
        yield {
          type: 'done',
          output: [
            {
              type: 'function_call',
              callId: 'call_fault_1',
              name: 'fault_effect',
              arguments: JSON.stringify({ value: 'one' }),
            },
          ],
          responseId: 'resp_fault_1',
        };
        return;
      }
      yield {
        type: 'done',
        output: [{ type: 'message', role: 'assistant', content: 'done' }],
        responseId: `resp_fault_${step}`,
      };
    };
    const requestId = arg('request');
    const admission = await new TurnCoordinator(store).begin({
      requestId,
      turnId: requestId,
      userId: USER,
      conversationId: conversation.id,
      requestHash: turnRequestHash({
        kind: 'chat',
        userId: USER,
        conversationId: conversation.id,
        message: 'perform the effect',
      }),
    });
    if (admission.kind !== 'started') throw new Error(`admission refused: ${admission.kind}`);
    for await (const event of runTurn(
      {
        store,
        transcriptMode: 'durable',
        modelTurn: model,
        additionalTools: [tool],
        toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
      },
      {
        userId: USER,
        conversationId: conversation.id,
        message: 'perform the effect',
        requestId,
      },
    )) {
      process.stdout.write(`${JSON.stringify({ event: event.type })}\n`);
    }
    writeFileSync(arg('done'), 'completed');
  } finally {
    await store.close();
  }
}

async function recover(): Promise<void> {
  const store = openSqliteStore(arg('db'));
  try {
    const report = await recoverInterruptedTurns({ store });
    const running = await store.listRunningTurns();
    const conversations = await store.listConversations(USER);
    process.stdout.write(
      `${JSON.stringify({ report, running: running.length, conversations: conversations.length })}\n`,
    );
  } finally {
    await store.close();
  }
}

const TEAM_USER = '00000000-0000-4000-8000-000000000099';

const workspaceStub: TeamWorkspacePort = {
  async provision(input) {
    return {
      workspaceId: `ws_${input.memberId}`,
      workspaceTaskId: `ws_${input.memberId}`,
      workspacePath: `/tmp/${input.memberId}`,
      baselineId: `base_${input.memberId}`,
      sourceVersion: 'sha256:empty',
      baselineHashes: {},
    };
  },
  async session() { return null; },
  async diff() { return { files: [], sourceVersion: 'sha256:empty', candidateHash: 'sha256:empty' }; },
  async currentHashes() { return {}; },
};

async function teamStart(): Promise<void> {
  const product = openSqliteStore(arg('db'));
  const teamStore = openSqliteTeamStore(arg('team-db'));
  try {
    await product.ensureUser(TEAM_USER);
    const sessions = new SessionService(product);
    const conversation = await sessions.create(TEAM_USER, 'fault team', 'deepseek-flash');
    const model: ModelTurn = async function* () {
      await (await import('../../src/observability/faults.ts')).faultPoint('team.model', {});
      yield { type: 'text_delta', text: 'late' };
      yield {
        type: 'done',
        output: [{ type: 'message', role: 'assistant', content: 'late' }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, reported: true },
      };
    };
    const service = new TeamService({
      teamStore,
      store: product,
      sessions,
      workspace: workspaceStub,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => model,
      transcriptMode: 'durable',
    });
    const created = await service.createRun({
      ownerId: TEAM_USER,
      conversationId: conversation.id,
      requestId: 'fault-team-run',
      message: '做一件需要重启的事',
    });
    if (!created.activation || !created.rootMember) throw new Error('no activation');
    await service.createTask(
      { run: created.run, member: null, userId: TEAM_USER },
      { title: '未完成的写任务', specification: '写文件', acceptance: '有文件', required: true },
    );
    await teamStore.updateActivation(created.activation.id, ['running', 'queued'], {
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    writeFileSync(arg('ids'), JSON.stringify({
      runId: created.run.id,
      activationId: created.activation.id,
      memberId: created.rootMember.id,
    }));
    await (await import('../../src/observability/faults.ts')).faultPoint('team.started', {});
  } finally {
    await teamStore.close();
    await product.close();
  }
}

async function teamLate(): Promise<void> {
  const product = openSqliteStore(arg('db'));
  const teamStore = openSqliteTeamStore(arg('team-db'));
  try {
    await product.ensureUser(TEAM_USER);
    const sessions = new SessionService(product);
    const conversation = await sessions.create(TEAM_USER, 'late team', 'deepseek-flash');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ModelTurn = async function* () {
      await gate;
      yield { type: 'text_delta', text: 'late response' };
      yield {
        type: 'done',
        output: [{ type: 'message', role: 'assistant', content: 'late response' }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, reported: true },
      };
    };
    const service = new TeamService({
      teamStore,
      store: product,
      sessions,
      workspace: workspaceStub,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => model,
      transcriptMode: 'durable',
    });
    const created = await service.createRun({
      ownerId: TEAM_USER,
      conversationId: conversation.id,
      requestId: 'fault-team-late',
      message: '停止后迟到',
    });
    if (!created.activation || !created.rootMember) throw new Error('no activation');
    await service.interruptMember(TEAM_USER, created.rootMember.id);
    release();
    let status = 'unknown';
    for (let i = 0; i < 100; i += 1) {
      const current = await teamStore.getActivation(created.activation.id);
      if (current) status = current.status;
      if (['succeeded', 'failed', 'interrupted', 'unknown'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = await teamStore.getRun(created.run.id);
    process.stdout.write(`${JSON.stringify({ status, runStatus: run?.status ?? null })}\n`);
    // Let the interrupted runtime unwind its late generator before closing the
    // SQLite handles; otherwise late persistence races the close and the child
    // exits 1 after already producing the assertion.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    await teamStore.close();
    await product.close();
  }
}

async function teamRecover(): Promise<void> {
  const product = openSqliteStore(arg('db'));
  const teamStore = openSqliteTeamStore(arg('team-db'));
  try {
    const ids = JSON.parse(readFileSync(arg('ids'), 'utf8')) as { runId: string; activationId: string; memberId: string };
    const service = new TeamService({
      teamStore,
      store: product,
      sessions: new SessionService(product),
      workspace: workspaceStub,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => {
        throw new Error('model configuration is missing after restart');
      },
      transcriptMode: 'durable',
    });
    await recoverInterruptedTurns({ store: product }).catch(() => undefined);
    const recovered = await service.recover();
    const run = await teamStore.getRun(ids.runId);
    const activation = await teamStore.getActivation(ids.activationId);
    const member = await teamStore.getMember(ids.memberId);
    const tasks = await teamStore.listTasks(ids.runId, { limit: 100 });
    const activations = await teamStore.listActivations(ids.runId);
    process.stdout.write(`${JSON.stringify({
      recovered,
      runStatus: run?.status ?? null,
      activationStatus: activation?.status ?? null,
      memberStatus: member?.status ?? null,
      tasks: tasks.items.map((task) => task.status),
      activationCount: activations.length,
    })}\n`);
    if (process.argv.includes('--followup') && arg('followup') === '1') {
      const follow = await service.followupAsOwner(TEAM_USER, ids.runId, ids.memberId, '继续');
      for (let i = 0; i < 100; i += 1) {
        const current = await teamStore.getActivation(follow.id);
        if (current && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(current.status)) {
          process.stdout.write(`${JSON.stringify({ followStatus: current.status, followError: current.error })}\n`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    await teamStore.close();
    await product.close();
  }
}

async function mailboxAccepted(): Promise<void> {
  const store = openSqliteTeamStore(arg('db'));
  try {
    const team = await store.createTeam(createTeamInputFrom(makeTeam()));
    const run = (await store.createRun(createRunInputFrom(makeRun({
      teamId: team.id,
      ownerId: team.ownerId,
      rootConversationId: team.rootConversationId,
    })))).run;
    const member = await store.createMember({ member: makeMember({ teamId: team.id }) });
    const message = makeMessage({
      teamId: team.id,
      runId: run.id,
      recipientId: member.id,
      senderId: team.ownerId,
      senderKind: 'user',
      clientMessageId: 'fault-mailbox-1',
      state: 'accepted',
      sequence: 1,
    });
    await store.appendMessage({ message, maxMessages: 100, maxQueuedPerMember: 100 });
    writeFileSync(arg('ids'), JSON.stringify({ teamId: team.id, runId: run.id, memberId: member.id, messageId: message.id }));
    await (await import('../../src/observability/faults.ts')).faultPoint('mailbox.accepted', {
      messageId: message.id,
    });
  } finally {
    await store.close();
  }
}

async function mailboxDrain(): Promise<void> {
  const store = openSqliteTeamStore(arg('db'));
  try {
    const ids = JSON.parse(readFileSync(arg('ids'), 'utf8')) as { memberId: string };
    const pending = await store.pendingMessages(ids.memberId, 10);
    const injected: string[] = [];
    for (const message of pending) {
      const changed = await store.markMessage(message.id, ['accepted'], {
        state: 'injected',
        injectedAt: new Date().toISOString(),
        activationId: 'act_fault_recovery',
      });
      if (changed) injected.push(changed.id);
    }
    const second = await store.pendingMessages(ids.memberId, 10);
    process.stdout.write(`${JSON.stringify({ injected, secondPending: second.length })}\n`);
  } finally {
    await store.close();
  }
}

async function mailboxInjected(): Promise<void> {
  const store = openSqliteTeamStore(arg('db'));
  try {
    const team = await store.createTeam(createTeamInputFrom(makeTeam()));
    const run = (await store.createRun(createRunInputFrom(makeRun({
      teamId: team.id,
      ownerId: team.ownerId,
      rootConversationId: team.rootConversationId,
    })))).run;
    const member = await store.createMember({ member: makeMember({ teamId: team.id }) });
    const message = makeMessage({
      teamId: team.id,
      runId: run.id,
      recipientId: member.id,
      senderId: team.ownerId,
      senderKind: 'user',
      clientMessageId: 'fault-mailbox-2',
      state: 'accepted',
      sequence: 1,
    });
    await store.appendMessage({ message, maxMessages: 100, maxQueuedPerMember: 100 });
    await store.markMessage(message.id, ['accepted'], {
      state: 'injected',
      injectedAt: new Date().toISOString(),
      activationId: 'act_fault_recovery',
    });
    writeFileSync(arg('ids'), JSON.stringify({ memberId: member.id, messageId: message.id }));
    await (await import('../../src/observability/faults.ts')).faultPoint('mailbox.injected', {
      messageId: message.id,
    });
  } finally {
    await store.close();
  }
}

async function mailboxInjectedRecover(): Promise<void> {
  const store = openSqliteTeamStore(arg('db'));
  try {
    const ids = JSON.parse(readFileSync(arg('ids'), 'utf8')) as { memberId: string; messageId: string };
    const pending = await store.pendingMessages(ids.memberId, 10);
    const before = await store.getMessage(ids.messageId);
    const processed = await store.markMessage(ids.messageId, ['injected'], {
      state: 'processed',
      processedAt: new Date().toISOString(),
    });
    process.stdout.write(
      `${JSON.stringify({ pending: pending.length, before: before?.state ?? null, after: processed?.state ?? null })}\n`,
    );
  } finally {
    await store.close();
  }
}

async function publish(): Promise<void> {
  const spec = JSON.parse(readFileSync(arg('spec'), 'utf8')) as {
    targetRoot: string;
    files: ArtifactFile[];
    sourceHashes: Record<string, string>;
    expectedHashes: Record<string, string>;
    idempotencyKey: string;
    journalPath: string;
  };
  const result = await publishCandidate({
    targetRoot: spec.targetRoot,
    files: spec.files,
    sourceHashes: spec.sourceHashes,
    expectedHashes: spec.expectedHashes,
    idempotencyKey: spec.idempotencyKey,
    journalPath: spec.journalPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  writeFileSync(arg('done'), 'published');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'tool-effect') return toolEffect();
  if (command === 'recover') return recover();
  if (command === 'team-start') return teamStart();
  if (command === 'team-late') return teamLate();
  if (command === 'team-recover') return teamRecover();
  if (command === 'mailbox-accepted') return mailboxAccepted();
  if (command === 'mailbox-drain') return mailboxDrain();
  if (command === 'mailbox-injected') return mailboxInjected();
  if (command === 'mailbox-injected-recover') return mailboxInjectedRecover();
  if (command === 'publish') return publish();
  throw new Error(`unknown command ${String(command)}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
