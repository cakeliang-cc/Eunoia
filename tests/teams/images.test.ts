/**
 * T43/T44 — explicit image grants and per-request image accounting.
 *
 * A member gets an image only through a recorded, expiring grant; the bytes come
 * from private media storage. Each member request plans and prices the image
 * separately, so the same asset sent to two members is counted twice.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import { MediaService } from '../../src/media/service.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { sessionConfig } from '../../src/session/config.ts';
import { imageBytes, seedAsset } from '../helpers/images.ts';
import type { ModelTurn, ModelTurnRequest } from '../../src/agent/model-port.ts';

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

async function setup() {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '图片授权', 'deepseek-flash');
  const blobs = new MemoryMediaBlobStore();
  const media = new MediaService({
    store,
    blobs,
    limits: DEFAULT_MEDIA_LIMITS,
    gate: new DecodeGate(2),
  });
  const bytes = await imageBytes(32, 32);
  const asset = await seedAsset({
    store,
    blobs,
    userId: USER,
    conversationId: conversation.id,
    bytes,
    status: 'bound',
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: ModelTurnRequest[] = [];
  const rootTurn: ModelTurn = async function* () {
    await gate;
    yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
  };
  const childTurn: ModelTurn = async function* (request) {
    requests.push(request);
    yield {
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: '看到了' }],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedTokens: 0, reported: true },
    };
  };
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: defaultTeamConfig('deepseek-flash'),
    toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
    resolveModelTurn: async (member) => (member.role === 'root' ? rootTurn : childTurn),
    transcriptMode: 'durable',
    media,
    imagePolicies: defaultImagePolicies(),
    mediaLimits: DEFAULT_MEDIA_LIMITS,
    sessionConfig: sessionConfig(),
    availableImageModels: ['deepseek-flash'],
  });
  const run = await service.createRun({
    ownerId: USER,
    conversationId: conversation.id,
    requestId: 'image-root',
    message: '图片',
  });
  return { store, teamStore, sessions, conversation, service, run, asset, requests, release, media };
}

async function waitTerminal(
  service: TeamService,
  activationId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const activation = await service.teamStore.getActivation(activationId);
    if (activation && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(activation.status)) {
      return;
    }
    if (Date.now() > deadline) throw new Error('activation did not finish');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('T43 — explicit image authorization', () => {
  it('rejects an image for a member without a grant, then accepts after grant and revoke', async () => {
    const h = await setup();
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: h.run.run.id,
      parentMemberId: h.run.rootMember!.id,
      name: '无图成员',
      message: '待命',
    });
    await waitTerminal(h.service, child.activation!.id);
    await expect(
      h.service.followupAsOwner(USER, h.run.run.id, child.member.id, '看图', [h.asset.id]),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });

    const grant = await h.service.grantImage({
      ownerId: USER,
      runId: h.run.run.id,
      memberId: child.member.id,
      assetId: h.asset.id,
      purpose: 'test',
      ttlSeconds: 60,
    });
    expect(grant['assetId']).toBe(h.asset.id);
    const active = await h.service.activeImageGrants(h.run.run.id, child.member.id);
    expect(active.map((entry) => entry['assetId'])).toContain(h.asset.id);

    const followup = await h.service.followupAsOwner(
      USER,
      h.run.run.id,
      child.member.id,
      '现在可以看图',
      [h.asset.id],
    );
    await waitTerminal(h.service, followup.id);
    const activation = await h.service.teamStore.getActivation(followup.id);
    expect(activation?.status, activation?.error ?? '').toBe('succeeded');

    await h.service.revokeImage({
      ownerId: USER,
      runId: h.run.run.id,
      memberId: child.member.id,
      assetId: h.asset.id,
    });
    expect(await h.service.activeImageGrants(h.run.run.id, child.member.id)).toHaveLength(0);
    await expect(
      h.service.followupAsOwner(USER, h.run.run.id, child.member.id, '撤销后', [h.asset.id]),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });
    h.release();
  });

  it('refuses another user\'s asset at grant time', async () => {
    const h = await setup();
    const other = '00000000-0000-4000-8000-000000000002';
    await h.store.ensureUser(other);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: h.run.run.id,
      parentMemberId: h.run.rootMember!.id,
      name: '越权图',
      message: '待命',
    });
    await waitTerminal(h.service, child.activation!.id);
    await expect(
      h.service.grantImage({
        ownerId: USER,
        runId: h.run.run.id,
        memberId: child.member.id,
        assetId: 'asset_not_owned',
        purpose: 'test',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_CAPABILITY' });
    h.release();
  });
});

describe('T44 — per-member image planning and budget', () => {
  it('counts the image in each member request and caps the budget', async () => {
    const h = await setup();
    const first = await h.service.spawnMember({
      ownerId: USER,
      runId: h.run.run.id,
      parentMemberId: h.run.rootMember!.id,
      name: '图成员甲',
      message: '看图',
      modelId: 'deepseek-flash',
      images: [h.asset.id],
    });
    await waitTerminal(h.service, first.activation!.id);
    const second = await h.service.spawnMember({
      ownerId: USER,
      runId: h.run.run.id,
      parentMemberId: h.run.rootMember!.id,
      name: '图成员乙',
      message: '也看图',
      modelId: 'deepseek-flash',
      images: [h.asset.id],
    });
    await waitTerminal(h.service, second.activation!.id);

    // Both member requests carried an encoded image plan.
    const imageRequests = h.requests.filter((request) =>
      JSON.stringify(request.input).includes(h.asset.id),
    );
    expect(imageRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of imageRequests) {
      expect(request.media?.imageTokens ?? 0).toBeGreaterThan(0);
      expect(request.media?.estimatedInputTokens ?? 0).toBeGreaterThan(0);
    }
    const entries = await h.teamStore.listBudgetEntries(h.run.run.id);
    const memberEntries = entries.filter(
      (entry) => entry.memberId === first.member.id || entry.memberId === second.member.id,
    );
    expect(memberEntries.length).toBeGreaterThanOrEqual(2);
    // Each request reserved at least the plan's image-inclusive estimate.
    expect(
      memberEntries.every(
        (entry) => entry.reservedInputTokens >= (imageRequests[0]?.media?.estimatedInputTokens ?? 0),
      ),
    ).toBe(true);
    h.release();
  });
});
