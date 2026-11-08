/**
 * The persistent interaction broker: approvals and elicitation.
 *
 * The chat transport is one-way. An approval therefore cannot be "a modal that
 * waits"; it is a persisted state machine with four observable facts:
 *
 *   1. the exact action (owner, conversation, server, account, tool, argument
 *      digest, contract hash) is recorded *before* anybody is asked;
 *   2. a pending row is what the UI reads, so refreshing the page loses nothing;
 *   3. only one transition from `pending` can succeed, so two tabs, a double
 *      click or a retried request cannot execute the action twice;
 *   4. the answer resolves the *original* action — it never asks the model to
 *      produce the tool call again.
 *
 * A wait whose process died is not resolved by a later click. The click marks
 * the interaction accepted and the persisted action is what an explicit resume
 * executes; it never runs because a page happened to be open.
 *
 * See docs/adr/033-mcp-host.md §8.2 and §8.3.
 */

import { randomUUID } from 'node:crypto';
import type { McpStore } from './store.ts';
import type {
  McpInteractionKind,
  McpInteractionRecord,
  McpInteractionStatus,
  McpTaskRecord,
} from './types.ts';
import { McpError } from './types.ts';
import type { ToolPermissionResolution } from '../tools/types.ts';

const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

export interface InteractionBrokerDeps {
  readonly store: McpStore;
  readonly now?: () => Date;
  readonly approvalTtlMs?: number;
  readonly elicitationTtlMs?: number;
  /** Called when a pending interaction is created or resolved, for SSE. */
  readonly onChange?: (record: McpInteractionRecord) => void;
}

export interface CreateApprovalInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId?: string | null;
  readonly serverId: string;
  readonly actionId: string | null;
  /** "服务名 · 工具名", shown before the decision. */
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly ttlMs?: number;
}

export interface CreateElicitationInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly serverId: string;
  readonly actionId: string | null;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly ttlMs?: number;
}

interface Waiter {
  readonly resolve: (resolution: ToolPermissionResolution) => void;
  readonly timer: NodeJS.Timeout | null;
}

export class InteractionBroker {
  readonly #store: McpStore;
  readonly #now: () => Date;
  readonly #approvalTtlMs: number;
  readonly #elicitationTtlMs: number;
  readonly #onChange: InteractionBrokerDeps['onChange'];
  readonly #waiters = new Map<string, Waiter>();
  readonly #listeners = new Set<(record: McpInteractionRecord) => void>();

  constructor(deps: InteractionBrokerDeps) {
    this.#store = deps.store;
    this.#now = deps.now ?? (() => new Date());
    this.#approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#elicitationTtlMs = deps.elicitationTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#onChange = deps.onChange;
  }

  /** Subscribe to created/resolved interactions, for SSE. */
  onChange(listener: (record: McpInteractionRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(record: McpInteractionRecord): void {
    this.#onChange?.(record);
    for (const listener of this.#listeners) listener(record);
  }

  async createApproval(input: CreateApprovalInput): Promise<McpInteractionRecord> {
    return this.#create('approval', input, input.ttlMs ?? this.#approvalTtlMs);
  }

  async createElicitation(input: CreateElicitationInput): Promise<McpInteractionRecord> {
    return this.#create('elicitation', input, input.ttlMs ?? this.#elicitationTtlMs);
  }

  async #create(
    kind: McpInteractionKind,
    input: CreateApprovalInput | CreateElicitationInput,
    ttlMs: number,
  ): Promise<McpInteractionRecord> {
    const now = this.#now();
    const record: McpInteractionRecord = {
      id: randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      turnId: 'turnId' in input ? (input.turnId ?? null) : null,
      actionId: input.actionId,
      serverId: input.serverId,
      kind,
      status: 'pending',
      summary: input.summary,
      payload: input.payload,
      // One key per question. A retry that reaches the insert twice fails on the
      // unique constraint rather than creating a second question.
      resumeKey: randomUUID(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      response: null,
      createdAt: now.toISOString(),
      resolvedAt: null,
    };
    await this.#store.createMcpInteraction(record);
    this.#index.set(record.id, { userId: record.userId });
    this.#notify(record);
    return record;
  }

  /**
   * Wait for a person.
   *
   * A timeout is `unknown`, not `deny`: the person did not answer, and treating
   * silence as refusal would be a decision they never made. The caller turns
   * `unknown` into a refusal for the model, but the action row keeps the true
   * fact.
   */
  async awaitDecision(
    interactionId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<ToolPermissionResolution> {
    const owner = this.#index.get(interactionId);
    if (!owner) {
      return { kind: 'unknown', reason: 'interaction not found in this process' };
    }
    // The answer may already be in the store: a person can click before this
    // call registers its waiter. Returning the recorded decision closes that
    // race instead of hanging until the deadline.
    const current = await this.#store.getMcpInteraction(owner.userId, interactionId);
    if (!current) return { kind: 'unknown', reason: 'interaction not found' };
    if (current.status === 'accepted') {
      return {
        kind: 'allow',
        grantId: current.id,
        ...(current.actionId ? { actionId: current.actionId } : {}),
      };
    }
    if (current.status !== 'pending') {
      return {
        kind: 'unknown',
        reason:
          current.status === 'expired'
            ? 'expired'
            : current.status === 'rejected'
              ? 'rejected'
              : 'cancelled',
      };
    }
    return new Promise<ToolPermissionResolution>((resolve) => {
      let settled = false;
      const finish = (resolution: ToolPermissionResolution): void => {
        if (settled) return;
        settled = true;
        const waiter = this.#waiters.get(interactionId);
        if (waiter?.timer) clearTimeout(waiter.timer);
        this.#waiters.delete(interactionId);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(resolution);
      };
      const onAbort = (): void => {
        finish({ kind: 'unknown', reason: 'cancelled' });
      };
      const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
      const timer = setTimeout(() => {
        void this.#expireOne(interactionId).finally(() => {
          finish({ kind: 'unknown', reason: 'expired' });
        });
      }, timeoutMs);
      timer.unref();
      this.#waiters.set(interactionId, { resolve: finish, timer });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  async #expireOne(interactionId: string): Promise<void> {
    const record = await this.#lookupForExpiry(interactionId);
    if (!record || record.status !== 'pending') return;
    const changed = await this.#store.resolveMcpInteraction({
      userId: record.userId,
      interactionId,
      status: 'expired',
      response: null,
      now: this.#now(),
    });
    if (changed) {
      const next = await this.#store.getMcpInteraction(record.userId, interactionId);
      if (next) this.#notify(next);
    }
  }

  async #lookupForExpiry(interactionId: string): Promise<McpInteractionRecord | null> {
    // Owner-scoped stores need the owner; the broker keeps a small index from
    // creation so expiry does not scan every conversation.
    const indexed = this.#index.get(interactionId);
    if (!indexed) return null;
    return this.#store.getMcpInteraction(indexed.userId, interactionId);
  }

  /** Owner index for interactions this process created. */
  readonly #index = new Map<string, { readonly userId: string }>();

  /** Record the owner of an interaction created elsewhere (resume paths). */
  rememberOwner(interactionId: string, userId: string): void {
    this.#index.set(interactionId, { userId });
  }

  /**
   * Accept, reject, cancel or expire.
   *
   * Returns the interaction after the transition, or null when it was not
   * pending. The waiter, if any, is resolved exactly once.
   */
  async resolve(input: {
    readonly userId: string;
    readonly interactionId: string;
    readonly status: Exclude<McpInteractionStatus, 'pending'>;
    readonly response?: unknown;
  }): Promise<McpInteractionRecord | null> {
    const expected = await this.#store.getMcpInteraction(input.userId, input.interactionId);
    if (!expected) throw new McpError('MCP_NOT_FOUND', '没有这个待处理交互', 404);
    if (expected.status !== 'pending') return expected;
    if (expected.expiresAt <= this.#now().toISOString()) {
      await this.#store.resolveMcpInteraction({
        userId: input.userId,
        interactionId: input.interactionId,
        status: 'expired',
        response: null,
        now: this.#now(),
      });
      this.#settle(input.interactionId, { kind: 'unknown', reason: 'expired' });
      const expired = await this.#store.getMcpInteraction(input.userId, input.interactionId);
      if (expired) this.#notify(expired);
      return expired;
    }
    const changed = await this.#store.resolveMcpInteraction({
      userId: input.userId,
      interactionId: input.interactionId,
      status: input.status,
      response: input.response ?? null,
      now: this.#now(),
    });
    const record = await this.#store.getMcpInteraction(input.userId, input.interactionId);
    if (!changed) return record;
    if (record) {
      this.#index.set(record.id, { userId: record.userId });
      this.#notify(record);
    }
    if (input.status === 'accepted') {
      this.#settle(input.interactionId, {
        kind: 'allow',
        grantId: input.interactionId,
        ...(expected.actionId ? { actionId: expected.actionId } : {}),
      });
    } else {
      this.#settle(input.interactionId, {
        kind: 'deny',
        reason:
          input.status === 'rejected'
            ? '用户拒绝了这次外部调用。'
            : input.status === 'cancelled'
              ? '这次外部调用已被取消。'
              : '这次外部调用的确认已经过期。',
      });
    }
    return record;
  }

  #settle(interactionId: string, resolution: ToolPermissionResolution): void {
    const waiter = this.#waiters.get(interactionId);
    if (!waiter) return;
    waiter.resolve(resolution);
  }

  async listPending(userId: string, conversationId: string): Promise<McpInteractionRecord[]> {
    const all = await this.#store.listMcpInteractions(userId, conversationId);
    return all.filter((record) => record.status === 'pending');
  }

  async get(userId: string, interactionId: string): Promise<McpInteractionRecord | null> {
    return this.#store.getMcpInteraction(userId, interactionId);
  }

  /** Expire stale pending rows on startup, and mark their actions unknown. */
  async expireStale(): Promise<number> {
    const count = await this.#store.expireMcpInteractions(this.#now());
    void count;
    return count;
  }

  /** Task rows are part of the same UI surface; delegated for convenience. */
  async listTasks(userId: string, conversationId: string): Promise<McpTaskRecord[]> {
    return this.#store.listMcpTasks(userId, { conversationId });
  }
}
