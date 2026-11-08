/**
 * The trace → ledger join.
 *
 * `buildWorkLedger` and the SQLite query are tested on their own; this pins the
 * adapter that joins them, especially the `before` cutoff. A checkpoint that
 * included the kept tail's tool calls would claim work the summary does not
 * cover, which is worse than missing evidence.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createTurnEvidenceSource } from '../../src/service/checkpoint-evidence.ts';
import type { TurnRecord } from '../../src/session/turn-types.ts';

function turn(conversationId: string): TurnRecord {
  return {
    id: 'turn-1',
    turnId: 'turn-1',
    userId: 'u1',
    conversationId,
    requestHash: 'hash',
    status: 'running',
    finishReason: null,
    reply: '',
    messageId: null,
    error: null,
    model: 'deepseek-flash',
    steps: 0,
    contextTokens: null,
    accepted: null,
    acceptance: [],
    usage: null,
    startedAt: new Date(),
    endedAt: null,
  };
}

async function seeded(): Promise<{ store: InMemoryStore; conversationId: string }> {
  const store = new InMemoryStore();
  await store.ensureUser('u1');
  const conversation = await store.createConversation('u1');
  await store.createTurn(turn(conversation.id));
  return { store, conversationId: conversation.id };
}

describe('createTurnEvidenceSource', () => {
  it('pairs calls and results from the conversation trace', async () => {
    const { store, conversationId } = await seeded();
    await store.appendTurnEvent({
      turnId: 'turn-1',
      conversationId,
      kind: 'tool_call',
      callId: 'c1',
      toolName: 'edit',
      status: 'running',
      payload: { arguments: '{"file_path":"src/a.ts"}' },
    });
    await store.appendTurnEvent({
      turnId: 'turn-1',
      conversationId,
      kind: 'tool_result',
      callId: 'c1',
      toolName: 'edit',
      status: 'succeeded',
      payload: { ok: true },
    });

    const ledger = await createTurnEvidenceSource(store).collect(conversationId);
    expect(ledger.toolCalls).toBe(1);
    expect(ledger.files[0]).toMatchObject({
      path: 'src/a.ts',
      operation: 'edit',
      lastStatus: 'passed',
    });
    expect(ledger.pending).toEqual([]);
  });

  it('keeps only events that happened before the boundary', async () => {
    const { store, conversationId } = await seeded();
    await store.appendTurnEvent({
      turnId: 'turn-1',
      conversationId,
      kind: 'tool_call',
      callId: 'c1',
      toolName: 'bash',
      status: 'running',
      payload: { arguments: '{"command":"npm test"}' },
    });

    const source = createTurnEvidenceSource(store);
    expect(
      (await source.collect(conversationId, { before: new Date('2000-01-01T00:00:00Z') })).toolCalls,
    ).toBe(0);
    expect(
      (await source.collect(conversationId, { before: new Date(Date.now() + 60_000) })).toolCalls,
    ).toBe(1);
  });

  it('bounds the number of events it reads', async () => {
    const { store, conversationId } = await seeded();
    for (let index = 0; index < 3; index += 1) {
      await store.appendTurnEvent({
        turnId: 'turn-1',
        conversationId,
        kind: 'tool_call',
        callId: `c${index}`,
        toolName: 'read',
        status: 'running',
        payload: { arguments: '{"file_path":"src/a.ts"}' },
      });
    }

    const ledger = await createTurnEvidenceSource(store, { limit: 2 }).collect(conversationId);
    expect(ledger.toolCalls).toBe(2);
    expect(ledger.pending).toHaveLength(2);
  });
});
