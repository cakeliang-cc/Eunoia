/**
 * The interaction state machine: one transition, owner scoping, expiry, and a
 * waiter that resolves exactly once.
 */

import { describe, expect, it } from 'vitest';
import { InteractionBroker } from '../../src/mcp/interactions.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';

function setup() {
  let now = new Date('2026-03-01T00:00:00Z');
  const store = new MemoryMcpStore();
  const broker = new InteractionBroker({ store, now: () => now });
  return {
    store,
    broker,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

const approval = {
  userId: 'user-1',
  conversationId: 'conv-1',
  serverId: 'server-1',
  actionId: 'action-1',
  summary: 'Fixture · write_note（写入外部服务）',
  payload: { tool: 'write_note' },
};

describe('approval lifecycle', () => {
  it('resolves a waiter once and executes nothing else', async () => {
    const { broker, store } = setup();
    const record = await broker.createApproval(approval);
    const waiting = broker.awaitDecision(record.id, { timeoutMs: 60_000 });
    const resolved = await broker.resolve({
      userId: 'user-1',
      interactionId: record.id,
      status: 'accepted',
      response: { note: 'ok' },
    });
    expect(resolved?.status).toBe('accepted');
    const resolution = await waiting;
    expect(resolution.kind).toBe('allow');
    if (resolution.kind === 'allow') expect(resolution.actionId).toBe('action-1');

    // A second click changes nothing.
    const again = await broker.resolve({
      userId: 'user-1',
      interactionId: record.id,
      status: 'rejected',
    });
    expect(again?.status).toBe('accepted');
    const stored = await store.getMcpInteraction('user-1', record.id);
    expect(stored?.status).toBe('accepted');
  });

  it('expires a stale wait as unknown, not as a refusal', async () => {
    const { broker, advance } = setup();
    const record = await broker.createApproval({ ...approval, ttlMs: 1_000 });
    advance(2_000);
    const resolution = await broker.awaitDecision(record.id, { timeoutMs: 1 });
    // The waiter was not installed before the record expired; a fresh wait sees
    // an expired row and returns unknown.
    expect(['unknown']).toContain(resolution.kind);
  });

  it('never lets another user resolve an interaction', async () => {
    const { broker } = setup();
    const record = await broker.createApproval(approval);
    await expect(
      broker.resolve({
        userId: 'user-2',
        interactionId: record.id,
        status: 'accepted',
      }),
    ).rejects.toThrow(/没有这个待处理交互/);
    const stored = await broker.get('user-1', record.id);
    expect(stored?.status).toBe('pending');
  });

  it('cancels a wait when the turn is aborted', async () => {
    const { broker } = setup();
    const record = await broker.createApproval(approval);
    const controller = new AbortController();
    const waiting = broker.awaitDecision(record.id, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    const resolution = await waiting;
    expect(resolution.kind).toBe('unknown');
    if (resolution.kind === 'unknown') expect(resolution.reason).toBe('cancelled');
  });

  it('lists only pending interactions for one conversation', async () => {
    const { broker } = setup();
    await broker.createApproval(approval);
    const other = await broker.createApproval({ ...approval, conversationId: 'conv-2' });
    const pending = await broker.listPending('user-1', 'conv-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.conversationId).toBe('conv-1');
    await broker.resolve({ userId: 'user-1', interactionId: other.id, status: 'rejected' });
    expect(await broker.listPending('user-1', 'conv-2')).toHaveLength(0);
  });

  it('records a form elicitation with its schema', async () => {
    const { broker, store } = setup();
    const record = await broker.createElicitation({
      userId: 'user-1',
      conversationId: 'conv-1',
      serverId: 'server-1',
      actionId: null,
      summary: '补充信息',
      payload: { mode: 'form', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    });
    expect(record.kind).toBe('elicitation');
    const stored = await store.getMcpInteraction('user-1', record.id);
    expect(stored?.payload.mode).toBe('form');
  });
});
