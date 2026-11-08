/**
 * R09 — an answered member question has an explicit, idempotent continuation.
 *
 * The original waiter died with its process. Resuming creates a new activation
 * on the same member with the persisted answer; it does not replay the old
 * activation or its tool effects.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import { QuestionService } from '../../src/questions/service.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const workspace: TeamWorkspacePort = {
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

async function setup() {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '根会话', 'deepseek-flash');
  const questions = new QuestionService({ store });
  let releaseRoot!: () => void;
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const turn: ModelTurn = async function* (request) {
    if (request.instructions.includes('根成员')) await rootGate;
    yield { type: 'text_delta', text: '完成。' };
    yield {
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: '完成。' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 0, reported: true },
    };
  };
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: defaultTeamConfig('deepseek-flash'),
    toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
    resolveModelTurn: async () => turn,
    transcriptMode: 'durable',
    questions,
  });
  return { store, service, questions, conversation, releaseRoot };
}

async function settle(service: TeamService, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const activation = await service.teamStore.getActivation(id);
    if (activation && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(activation.status)) return;
    if (Date.now() > deadline) throw new Error('activation did not settle');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('R09 — question resume', () => {
  it('creates one new resume activation with the persisted answer and no old side effects', async () => {
    const h = await setup();
    const created = await h.service.createRun({
      ownerId: USER,
      conversationId: h.conversation.id,
      requestId: 'root-resume',
      message: '开始',
    });
    const run = await h.service.getRun(USER, created.run.id);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: run.id,
      parentMemberId: created.rootMember!.id,
      name: '提问成员',
      message: '待命',
    });
    await settle(h.service, child.activation!.id);
    const member = await h.service.getMember(USER, child.member.id);
    expect(member.status).toBe('idle');

    const question = await h.questions.ask({
      userId: USER,
      conversationId: run.rootConversationId,
      memberId: member.id,
      generation: 7,
      prompt: '选择哪个方案？',
      schema: { fields: [{ key: 'choice', label: '选择', type: 'text', required: true }] },
    });
    await h.questions.answer({
      userId: USER,
      questionId: question.id,
      answer: { choice: 'B' },
      generation: 7,
    });

    const first = await h.service.resumeFromQuestion({
      ownerId: USER,
      runId: run.id,
      questionId: question.id,
    });
    expect(first.input.kind).toBe('resume');
    expect(first.input.text).toContain('choice: B');
    await settle(h.service, first.id);

    const second = await h.service.resumeFromQuestion({
      ownerId: USER,
      runId: run.id,
      questionId: question.id,
    });
    expect(second.id).toBe(first.id);
    h.releaseRoot();
    await settle(h.service, created.activation!.id);
  });

  it('refuses an unanswered question or a question from another run', async () => {
    const h = await setup();
    const created = await h.service.createRun({
      ownerId: USER,
      conversationId: h.conversation.id,
      requestId: 'root-unanswered',
      message: '开始',
    });
    const run = await h.service.getRun(USER, created.run.id);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: run.id,
      parentMemberId: created.rootMember!.id,
      name: '提问成员',
      message: '待命',
    });
    await settle(h.service, child.activation!.id);
    const question = await h.questions.ask({
      userId: USER,
      conversationId: run.rootConversationId,
      memberId: child.member.id,
      generation: 2,
      prompt: '未回答',
      schema: { fields: [] },
    });
    await expect(
      h.service.resumeFromQuestion({ ownerId: USER, runId: run.id, questionId: question.id }),
    ).rejects.toMatchObject({ code: 'TEAM_QUESTION_CONFLICT' });
    h.releaseRoot();
    await settle(h.service, created.activation!.id);
  });
});
