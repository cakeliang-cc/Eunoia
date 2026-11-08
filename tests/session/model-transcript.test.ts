/**
 * A01–A04, A28: the model-transcript port contract.
 *
 * Both stores must answer the same way. The SQLite-specific migration is in
 * `tests/db/model-transcript.test.ts`; this file is about semantics a caller can
 * rely on: idempotent items, one step per attempt, window revisions, context
 * states and deletion.
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import type { ModelTranscriptStore } from '../../src/session/model-transcript-store.ts';
import type { NewModelItem } from '../../src/session/model-transcript.ts';
import { TranscriptRevisionConflictError } from '../../src/session/model-transcript-store.ts';

const USER = '00000000-0000-4000-8000-000000000001';

async function conversation(store: InMemoryStore): Promise<string> {
  await store.ensureUser(USER);
  return (await store.createConversation(USER)).id;
}

function epochInput(conversationId: string, userId = USER) {
  return {
    id: randomUUID(),
    userId,
    conversationId,
    parentEpochId: null,
    reason: 'new-conversation' as const,
    instructions: 'stable prompt',
    promptVersion: 'p1',
    tools: [],
    toolsHash: 'hash',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    protocolRevision: 'responses@1',
    encoderRevision: 'sdk@1',
    windowItemIds: [],
    windowRevision: 0,
    seededThroughSeq: 0,
    createdAt: new Date('2026-11-08T00:00:00Z'),
  };
}

function item(
  conversationId: string,
  epochId: string,
  key: string,
  overrides: Partial<NewModelItem> = {},
): NewModelItem {
  return {
    conversationId,
    epochId,
    idempotencyKey: key,
    kind: 'user',
    source: 'user',
    scope: 'conversation',
    payload: { type: 'message', role: 'user', content: key },
    ...overrides,
  };
}

describe.each([
  ['in-memory', () => new InMemoryStore()],
] as const)('the transcript port (%s)', (_name, make) => {
  it('A02: the same idempotency key appends exactly one item, in order', async () => {
    const store = make();
    const conversationId = await conversation(store);
    const epoch = await store.createEpoch(epochInput(conversationId));

    const first = await store.appendItems([
      item(conversationId, epoch.id, 'user:1'),
      item(conversationId, epoch.id, 'user:2'),
    ]);
    const again = await store.appendItems([
      item(conversationId, epoch.id, 'user:1'),
      item(conversationId, epoch.id, 'user:3'),
    ]);
    expect(again[0]?.id).toBe(first[0]?.id);
    expect(again[1]?.id).not.toBe(first[1]?.id);

    const items = await store.listItems(conversationId);
    expect(items.map((entry) => entry.payload.type === 'message' && entry.payload.content)).toEqual([
      'user:1',
      'user:2',
      'user:3',
    ]);
    expect(items.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('A02: rejects an item from a different conversation', async () => {
    const store = make();
    const one = await conversation(store);
    const two = await conversation(store);
    const epoch = await store.createEpoch(epochInput(one));
    await expect(
      store.appendItems([item(two, epoch.id, 'cross')]),
    ).rejects.toThrow();
  });

  it('A02: one step row per (requestId, step, attemptNo)', async () => {
    const store = make();
    const conversationId = await conversation(store);
    const epoch = await store.createEpoch(epochInput(conversationId));
    const it1 = item(conversationId, epoch.id, 'user:1');
    const [stored] = await store.appendItems([it1]);
    const step = {
      attemptId: randomUUID(),
      requestId: 'req-1',
      turnId: 'turn-1',
      conversationId,
      step: 1,
      attemptNo: 1,
      epochId: epoch.id,
      epochRevision: 0,
      inputItemIds: [stored!.id],
      requestConfigDigest: 'digest',
      projection: null,
      status: 'prepared' as const,
      createdAt: new Date(),
    };
    const first = await store.prepareStep({ items: [], step });
    const second = await store.prepareStep({ items: [], step });
    expect(second.step.attemptId).toBe(first.step.attemptId);
    expect((await store.listSteps('req-1')).length).toBe(1);
  });

  it('A02: a stale window revision is a conflict, not a silent overwrite', async () => {
    const store = make();
    const conversationId = await conversation(store);
    const epoch = await store.createEpoch(epochInput(conversationId));
    const [stored] = await store.appendItems([item(conversationId, epoch.id, 'user:1')]);
    await store.updateWindow(epoch.id, 0, [stored!.id]);
    await expect(store.updateWindow(epoch.id, 0, [stored!.id])).rejects.toBeInstanceOf(
      TranscriptRevisionConflictError,
    );
  });

  it('A04: a seed epoch is idempotent across repeated durable activation', async () => {
    const store = make();
    const conversationId = await conversation(store);
    await store.ensureUser(USER);
    const firstEpoch = await store.createEpoch(epochInput(conversationId));
    const seed = item(conversationId, firstEpoch.id, 'seed:message-1', {
      messageId: 'message-1',
    });
    await store.appendItems([seed]);
    // A new epoch reuses the immutable item; it does not duplicate it.
    const secondEpoch = await store.createEpoch({
      ...epochInput(conversationId),
      parentEpochId: firstEpoch.id,
      reason: 'legacy-seed',
    });
    const reused = await store.appendItems([
      item(conversationId, secondEpoch.id, 'seed:message-1', { messageId: 'message-1' }),
    ]);
    const all = await store.listItems(conversationId);
    expect(all.length).toBe(1);
    expect(reused[0]?.id).toBe(all[0]?.id);
    expect(await store.knownMessageIds(conversationId)).toEqual(new Set(['message-1']));
  });

  it('A28: deleting a conversation removes its transcript and state', async () => {
    const store = make();
    const conversationId = await conversation(store);
    const epoch = await store.createEpoch(epochInput(conversationId));
    const [stored] = await store.appendItems([item(conversationId, epoch.id, 'user:1')]);
    await store.saveContextState([
      {
        conversationId,
        epochId: epoch.id,
        key: 'workspace',
        scope: 'persistent',
        contentHash: 'h',
        revision: 1,
        latestItemId: stored!.id,
        cleared: false,
      },
    ]);
    expect(await store.deleteConversation(USER, conversationId)).toBe(true);
    expect(await store.listEpochs(conversationId)).toEqual([]);
    expect(await store.listItems(conversationId)).toEqual([]);
    expect(await store.contextState(conversationId, epoch.id)).toEqual([]);
  });

  it('A28: deleting the user removes every transcript row', async () => {
    const store = make();
    const conversationId = await conversation(store);
    const epoch = await store.createEpoch(epochInput(conversationId));
    await store.appendItems([item(conversationId, epoch.id, 'user:1')]);
    expect(await store.deleteUser(USER)).toBe(true);
    expect(await store.listEpochs(conversationId)).toEqual([]);
    expect(await store.listItems(conversationId)).toEqual([]);
  });
});

describe('the transcript port is not satisfied by omission', () => {
  it('declares the methods the service needs', () => {
    const store = new InMemoryStore();
    const port: ModelTranscriptStore = store;
    for (const method of [
      'createEpoch',
      'activeEpoch',
      'appendItems',
      'prepareStep',
      'updateStep',
      'updateWindow',
      'saveContextState',
      'deleteTranscript',
    ] as const) {
      expect(typeof port[method]).toBe('function');
    }
  });
});
