/**
 * T06/T08 at the orchestration level.
 *
 * Two independent provider configurations — different base URLs, credentials
 * and wire protocols — run through the *same* Team runtime. The members are
 * created by `TeamService`, their transcripts are durable, and the model turn is
 * resolved by the production `providerFor()` path; no test-injected turn is
 * used. Each fixture records the exact request the SDK sent.
 *
 * The fork case uses the same setup: a parent whose transcript holds a complete
 * tool group is forked onto the other protocol, and separately a parent with a
 * vendor-private reasoning payload is refused with a `fresh` recommendation.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { Activation } from '../../src/teams/types.ts';
import { modelProfile } from '../../src/models/registry.ts';
import type { ModelProfile } from '../../src/models/types.ts';
import { closeFixtureProviders, registerFixtureProvider } from '../helpers/protocol.ts';
import {
  startProtocolFixture,
  type CapturedRequest,
} from '../fixtures/protocol-servers.ts';

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
  async session() {
    return null;
  },
  async diff() {
    return { files: [], sourceVersion: 'sha256:empty', candidateHash: 'sha256:empty' };
  },
  async currentHashes() {
    return {};
  },
};

function fixtureProfile(id: string, providerId: string): ModelProfile {
  // Same capability budget as the product default; the provider id is what
  // selects the transport and the model id is what the fixture sees on the wire.
  return { ...modelProfile('deepseek-flash'), id, providerId, displayName: `${id} @ ${providerId}` };
}

interface Harness {
  readonly service: TeamService;
  readonly store: InMemoryStore;
  readonly teamStore: MemoryTeamStore;
  readonly sessions: SessionService;
  readonly conversationId: string;
}

async function harness(
  rootModelId: string,
  profiles: ReadonlyMap<string, ModelProfile>,
): Promise<Harness> {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const resolveModel = (id: string): ModelProfile => {
    const profile = profiles.get(id);
    if (!profile) throw new Error(`unknown fixture model ${id}`);
    return profile;
  };
  const sessions = new SessionService(store, {
    // The session layer pins a conversation's model; the fixture ids are not in
    // the shipped catalog, so the resolver is the same map the Team uses.
    resolveModel,
    model: profiles.get(rootModelId)!,
    summaryModel: profiles.get(rootModelId)!,
  });
  const conversation = await sessions.create(USER, '双 Provider 验收', rootModelId);
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: { ...defaultTeamConfig(rootModelId), mode: 'team' },
    toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
    modelProfileFor: resolveModel,
    transcriptMode: 'durable',
  });
  return { service, store, teamStore, sessions, conversationId: conversation.id };
}

async function startRun(
  h: Harness,
  requestId: string,
  message: string,
): Promise<Awaited<ReturnType<TeamService['createRun']>>> {
  const created = await h.service.createRun({
    ownerId: USER,
    conversationId: h.conversationId,
    requestId,
    message,
    // Auto-dispatch is off so a required task does not start a second
    // activation on its own; the run stays `waiting_user` and the explicit
    // spawn calls below are the only model requests.
    config: { autoDispatch: false },
  });
  // A required task keeps the run open after the root's committed turn, which
  // is the state a fork is allowed to inherit from.
  await h.service.createTask(
    { run: created.run, member: null, userId: USER },
    { title: '保持运行', specification: '', acceptance: 'root 完成后仍可创建成员', required: true },
  );
  return created;
}

async function waitTerminal(
  service: TeamService,
  activation: Activation | null,
  timeoutMs = 8_000,
): Promise<Activation> {
  if (!activation) throw new Error('no activation');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await service.teamStore.getActivation(activation.id);
    if (current && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(current.status)) {
      return current;
    }
    if (Date.now() > deadline) throw new Error(`activation stuck in ${current?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function bodyOf(request: CapturedRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasToolResult(protocol: 'responses' | 'chat-completions', request: CapturedRequest): boolean {
  const body = bodyOf(request);
  if (protocol === 'responses') {
    return arrayOf(body.input).some(
      (item) => (item as { type?: unknown }).type === 'function_call_output',
    );
  }
  return arrayOf(body.messages).some(
    (message) => (message as { role?: unknown }).role === 'tool',
  );
}

afterAll(async () => {
  await closeFixtureProviders();
});

describe('T06 — two provider configurations run through the same orchestration', () => {
  it('runs a root and two members across two protocols and captures each wire request', async () => {
    const responsesPlan = (request: CapturedRequest) => ({
      textChunks: [`responses:${String(bodyOf(request).model)}`],
      usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 4 },
    });
    const chatPlan = (request: CapturedRequest) => ({
      textChunks: [`chat:${String(bodyOf(request).model)}`],
      usage: { inputTokens: 12, outputTokens: 5, cachedTokens: 6 },
    });
    const responses = await startProtocolFixture({ protocol: 'responses', plan: responsesPlan });
    const chat = await startProtocolFixture({ protocol: 'chat-completions', plan: chatPlan });
    const responsesHandle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: responses.baseURL,
      apiKey: 'responses-secret',
    });
    const chatHandle = registerFixtureProvider({
      protocol: 'chat-completions',
      baseURL: chat.baseURL,
      apiKey: 'chat-secret',
    });

    const rootModelId = 'fixture-root';
    const responsesChildModelId = 'fixture-child-responses';
    const chatChildModelId = 'fixture-child-chat';
    const profiles = new Map<string, ModelProfile>([
      [rootModelId, fixtureProfile(rootModelId, responsesHandle.id)],
      [responsesChildModelId, fixtureProfile(responsesChildModelId, responsesHandle.id)],
      [chatChildModelId, fixtureProfile(chatChildModelId, chatHandle.id)],
    ]);

    const h = await harness(rootModelId, profiles);
    try {
      const created = await startRun(h, 'dual-root', '开始。');
      const root = await waitTerminal(h.service, created.activation);
      expect(root.status).toBe('succeeded');
      expect(root.result?.summary).toBe(`responses:${rootModelId}`);

      const responsesChild = await h.service.spawnMember({
        ownerId: USER,
        runId: created.run.id,
        parentMemberId: created.rootMember!.id,
        name: '响应协议成员',
        modelId: responsesChildModelId,
        message: '你在哪个协议上回答？',
      });
      const chatChild = await h.service.spawnMember({
        ownerId: USER,
        runId: created.run.id,
        parentMemberId: created.rootMember!.id,
        name: '聊天协议成员',
        modelId: chatChildModelId,
        message: '你在哪个协议上回答？',
      });
      const responsesActivation = await waitTerminal(h.service, responsesChild.activation);
      const chatActivation = await waitTerminal(h.service, chatChild.activation);
      expect(responsesActivation.status).toBe('succeeded');
      expect(chatActivation.status).toBe('succeeded');
      expect(responsesActivation.result?.summary).toBe(`responses:${responsesChildModelId}`);
      expect(chatActivation.result?.summary).toBe(`chat:${chatChildModelId}`);

      // Each fixture only saw requests encoded for its own protocol.
      expect(responses.requests).toHaveLength(2);
      expect(chat.requests).toHaveLength(1);
      expect(responses.requests.map((request) => bodyOf(request).model)).toEqual([
        rootModelId,
        responsesChildModelId,
      ]);
      expect(chat.requests.map((request) => bodyOf(request).model)).toEqual([chatChildModelId]);
      expect(responses.requests[0]!.headers.authorization).toBe('Bearer responses-secret');
      expect(chat.requests[0]!.headers.authorization).toBe('Bearer chat-secret');

      // The request *shape* differs because the protocol differs, not because a
      // model id was swapped.
      for (const request of responses.requests) {
        const body = bodyOf(request);
        expect(request.path).toBe('/v1/responses');
        expect(body).toHaveProperty('instructions');
        expect(body).not.toHaveProperty('messages');
        expect(body.stream).toBe(true);
        const tool = (arrayOf(body.tools) as Record<string, unknown>[])[0]!;
        expect(tool).toHaveProperty('name');
        expect(tool).not.toHaveProperty('function');
      }
      const chatBody = bodyOf(chat.requests[0]!);
      expect(chat.requests[0]!.path).toBe('/v1/chat/completions');
      expect(chatBody).toHaveProperty('messages');
      expect(chatBody).not.toHaveProperty('instructions');
      expect(chatBody.stream_options).toEqual({ include_usage: true });
      const chatMessages = arrayOf(chatBody.messages) as Record<string, unknown>[];
      expect(chatMessages[0]).toMatchObject({ role: 'system' });
      const chatTool = (arrayOf(chatBody.tools) as Record<string, unknown>[])[0]!;
      expect(chatTool).toHaveProperty('function');
      expect(chatTool).not.toHaveProperty('name');

      // The two child members are genuinely independent: separate
      // conversations, separate provider ids, and no shared transcript.
      const members = await h.service.listMembers(USER, created.run.id);
      const responsesMember = members.find((member) => member.name === '响应协议成员')!;
      const chatMember = members.find((member) => member.name === '聊天协议成员')!;
      expect(responsesMember.profile.providerId).toBe(responsesHandle.id);
      expect(chatMember.profile.providerId).toBe(chatHandle.id);
      expect(responsesMember.internalConversationId).not.toBe(chatMember.internalConversationId);
    } finally {
      await responses.close();
      await chat.close();
    }
  });
});

describe('T08 — cross-protocol fork', () => {
  it('converts a committed tool group into the child protocol and skips later turns', async () => {
    const responses = await startProtocolFixture({
      protocol: 'responses',
      plan: (request) =>
        hasToolResult('responses', request)
          ? { textChunks: ['已查。'], usage: { inputTokens: 20, outputTokens: 4 } }
          : {
              textChunks: ['先查。'],
              reasoningChunks: ['查一下任务板。'],
              toolCalls: [
                { callId: 'call_board', name: 'team_task_list', arguments: '{"limit":5}' },
              ],
              usage: { inputTokens: 20, outputTokens: 6 },
            },
    });
    const chat = await startProtocolFixture({
      protocol: 'chat-completions',
      plan: { textChunks: ['已从父轨迹继续。'], usage: { inputTokens: 30, outputTokens: 5 } },
    });
    const responsesHandle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: responses.baseURL,
      apiKey: 'responses-secret',
    });
    const chatHandle = registerFixtureProvider({
      protocol: 'chat-completions',
      baseURL: chat.baseURL,
      apiKey: 'chat-secret',
    });

    const rootModelId = 'fork-root';
    const chatChildModelId = 'fork-chat-child';
    const profiles = new Map<string, ModelProfile>([
      [rootModelId, fixtureProfile(rootModelId, responsesHandle.id)],
      [chatChildModelId, fixtureProfile(chatChildModelId, chatHandle.id)],
    ]);
    const h = await harness(rootModelId, profiles);
    try {
      const created = await startRun(h, 'fork-root-turn', '查一下任务板。');
      const root = await waitTerminal(h.service, created.activation);
      expect(root.status).toBe('succeeded');
      expect(root.result?.summary).toBe('先查。已查。');
      const rootMember = created.rootMember!;
      const rootMessages = await h.sessions.messages(USER, rootMember.internalConversationId);
      const committedSeq = rootMessages.at(-1)!.seq;

      // A trailing message written after the fork point must not be inherited.
      await h.sessions.append({
        conversationId: rootMember.internalConversationId,
        userId: USER,
        role: 'user',
        content: '这是 fork 之后父成员才收到的话。',
      });

      const child = await h.service.spawnMember({
        ownerId: USER,
        runId: created.run.id,
        parentMemberId: rootMember.id,
        name: '跨协议 fork',
        contextMode: 'fork',
        modelId: chatChildModelId,
        message: '继续。',
      });
      const activation = await waitTerminal(h.service, child.activation);
      expect(activation.status).toBe('succeeded');
      expect(child.member.contextMode).toBe('fork');
      expect(child.member.forkSeq).toBe(committedSeq);

      // The child made exactly one request, and it went to the Chat
      // Completions fixture; the parent's Responses fixture saw only the two
      // parent steps.
      expect(responses.requests).toHaveLength(2);
      expect(chat.requests).toHaveLength(1);
      const chatBody = bodyOf(chat.requests[0]!);
      const messages = arrayOf(chatBody.messages) as Record<string, unknown>[];
      console.log('CHAT MSGS', JSON.stringify(messages, null, 2));
      // The last five are the member's own background blocks, encoded as user
      // messages in Chat Completions (the transcript marks their source).
      expect(messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
        'user',
        'user',
        'user',
      ]);
      expect(messages[1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: '查一下任务板。' }],
      });
      // The parent's multi-step reply is one session row; the fork seeds the
      // tool group after it, and Chat Completions carries both on one assistant
      // message with `tool_calls`.
      expect(messages[2]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: '先查。已查。' }],
        tool_calls: [
          {
            id: 'call_board',
            type: 'function',
            function: { name: 'team_task_list', arguments: '{"limit":5}' },
          },
        ],
      });
      expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_board' });
      expect(String(messages[3]!.content)).toContain('tasks');
      expect(messages[4]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: '继续。' }],
      });

      // The parent turn written after the fork cut is absent.
      expect(JSON.stringify(chatBody)).not.toContain('fork 之后');
      // No vendor-private reasoning field crosses the protocol boundary.
      expect(JSON.stringify(chatBody)).not.toContain('encrypted');
      expect(JSON.stringify(chatBody)).not.toContain('"reasoning"');
    } finally {
      await responses.close();
      await chat.close();
    }
  });

  it('refuses a parent with vendor-private reasoning and points at fresh', async () => {
    const responses = await startProtocolFixture({
      protocol: 'responses',
      plan: (request) =>
        hasToolResult('responses', request)
          ? { textChunks: ['已查。'], usage: { inputTokens: 20, outputTokens: 4 } }
          : {
              textChunks: ['先查。'],
              reasoningChunks: ['查一下任务板。'],
              privateReasoning: true,
              toolCalls: [
                { callId: 'call_board', name: 'team_task_list', arguments: '{"limit":5}' },
              ],
              usage: { inputTokens: 20, outputTokens: 6 },
            },
    });
    const chat = await startProtocolFixture({
      protocol: 'chat-completions',
      plan: { textChunks: ['不应到达。'] },
    });
    const responsesHandle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: responses.baseURL,
      apiKey: 'responses-secret',
    });
    const chatHandle = registerFixtureProvider({
      protocol: 'chat-completions',
      baseURL: chat.baseURL,
      apiKey: 'chat-secret',
    });

    const rootModelId = 'refuse-root';
    const chatChildModelId = 'refuse-chat-child';
    const profiles = new Map<string, ModelProfile>([
      [rootModelId, fixtureProfile(rootModelId, responsesHandle.id)],
      [chatChildModelId, fixtureProfile(chatChildModelId, chatHandle.id)],
    ]);
    const h = await harness(rootModelId, profiles);
    try {
      const created = await startRun(h, 'refuse-root-turn', '查一下任务板。');
      const root = await waitTerminal(h.service, created.activation);
      expect(root.status).toBe('succeeded');

      let refusal: unknown;
      try {
        await h.service.spawnMember({
          ownerId: USER,
          runId: created.run.id,
          parentMemberId: created.rootMember!.id,
          name: '私有推理 fork',
          contextMode: 'fork',
          modelId: chatChildModelId,
          message: '继续。',
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        code: 'TEAM_FORK_INCOMPATIBLE',
        detail: {
          code: 'private_reasoning',
          recommendation: 'fresh',
        },
      });

      // The refusal is recorded on a member that can never run, and the target
      // provider was never called with the private payload.
      const members = await h.service.listMembers(USER, created.run.id);
      const failed = members.find((member) => member.name === '私有推理 fork');
      expect(failed?.status).toBe('failed');
      expect(failed?.error ?? '').toMatch(/fresh/);
      expect(chat.requests).toHaveLength(0);
    } finally {
      await responses.close();
      await chat.close();
    }
  });

  it('refuses a parent whose last turn has an incomplete tool group', async () => {
    const responses = await startProtocolFixture({
      protocol: 'responses',
      plan: { textChunks: ['普通回复。'], usage: { inputTokens: 5, outputTokens: 2 } },
    });
    const chat = await startProtocolFixture({
      protocol: 'chat-completions',
      plan: { textChunks: ['不应到达。'] },
    });
    const responsesHandle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: responses.baseURL,
      apiKey: 'responses-secret',
    });
    const chatHandle = registerFixtureProvider({
      protocol: 'chat-completions',
      baseURL: chat.baseURL,
      apiKey: 'chat-secret',
    });

    const rootModelId = 'orphan-root';
    const chatChildModelId = 'orphan-chat-child';
    const profiles = new Map<string, ModelProfile>([
      [rootModelId, fixtureProfile(rootModelId, responsesHandle.id)],
      [chatChildModelId, fixtureProfile(chatChildModelId, chatHandle.id)],
    ]);
    const h = await harness(rootModelId, profiles);
    try {
      const created = await startRun(h, 'orphan-root-turn', '普通回复。');
      const root = await waitTerminal(h.service, created.activation);
      expect(root.status).toBe('succeeded');
      const rootMember = created.rootMember!;

      // Construct the half-turn the recovery path would see after a crash: a
      // committed tool call whose result was never written.
      const epoch = await h.store.activeEpoch(rootMember.internalConversationId);
      if (!epoch) throw new Error('no parent epoch');
      const [call] = await h.store.appendItems([
        {
          conversationId: rootMember.internalConversationId,
          epochId: epoch.id,
          idempotencyKey: 'test:orphan-call',
          kind: 'tool_call',
          source: 'assistant',
          scope: 'conversation',
          callId: 'call_orphan',
          payload: {
            type: 'function_call',
            callId: 'call_orphan',
            name: 'team_task_list',
            arguments: '{"limit":5}',
          },
        },
      ]);
      await h.store.updateWindow(epoch.id, epoch.windowRevision, [
        ...epoch.windowItemIds,
        call!.id,
      ]);

      await expect(
        h.service.spawnMember({
          ownerId: USER,
          runId: created.run.id,
          parentMemberId: rootMember.id,
          name: '半组 fork',
          contextMode: 'fork',
          modelId: chatChildModelId,
          message: '继续。',
        }),
      ).rejects.toMatchObject({
        code: 'TEAM_FORK_INCOMPATIBLE',
        detail: { code: 'incomplete_tool_group', recommendation: 'fresh' },
      });
      expect(chat.requests).toHaveLength(0);
    } finally {
      await responses.close();
      await chat.close();
    }
  });
});
