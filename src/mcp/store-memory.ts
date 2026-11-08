/**
 * In-memory `McpStore` for `STORE=memory`, tests and throwaway runs.
 *
 * It preserves the *semantics* the SQL store enforces, not just the shapes:
 * optimistic revision checks, single-transition interaction resolution, owner
 * scoping and identity-scoped catalogs. A test that passes here and would fail
 * on SQLite is a test that proved nothing.
 */

import type {
  McpActionPatch,
  McpArtifactRecord,
  McpCredentialRecord,
  McpResourceSnapshotRecord,
  McpServerRecord,
  McpStore,
  McpTaskPatch,
} from './store.ts';
import type {
  McpActionRecord,
  McpCatalog,
  McpConversationBinding,
  McpInteractionRecord,
  McpServerStatus,
  McpTaskRecord,
} from './types.ts';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryMcpStore implements McpStore {
  readonly #servers = new Map<string, McpServerRecord>();
  readonly #status = new Map<string, McpServerStatus>();
  readonly #catalogs = new Map<string, McpCatalog>();
  readonly #actions = new Map<string, McpActionRecord>();
  readonly #interactions = new Map<string, McpInteractionRecord>();
  readonly #tasks = new Map<string, McpTaskRecord>();
  readonly #credentials = new Map<string, McpCredentialRecord>();
  readonly #bindings = new Map<string, McpConversationBinding[]>();
  readonly #resources = new Map<string, McpResourceSnapshotRecord[]>();
  readonly #artifacts = new Map<string, McpArtifactRecord>();

  #serverKey(userId: string, serverId: string): string {
    return `${userId}\u0000${serverId}`;
  }

  async listMcpServers(userId: string): Promise<McpServerRecord[]> {
    return [...this.#servers.entries()]
      .filter(([key]) => key.startsWith(`${userId}\u0000`))
      .map(([, record]) => clone(record))
      .sort((a, b) => a.config.createdAt.localeCompare(b.config.createdAt));
  }

  async getMcpServer(userId: string, serverId: string): Promise<McpServerRecord | null> {
    const record = this.#servers.get(this.#serverKey(userId, serverId));
    if (!record) return null;
    const status = this.#status.get(this.#serverKey(userId, serverId)) ?? null;
    return clone({ config: record.config, status });
  }

  async insertMcpServer(config: McpServerRecord['config']): Promise<void> {
    this.#servers.set(this.#serverKey(config.userId, config.id), {
      config: clone(config),
      status: null,
    });
  }

  async updateMcpServer(
    config: McpServerRecord['config'],
    expectedRevision: number,
  ): Promise<boolean> {
    const key = this.#serverKey(config.userId, config.id);
    const existing = this.#servers.get(key);
    if (!existing || existing.config.configRevision !== expectedRevision) return false;
    this.#servers.set(key, { config: clone(config), status: existing.status });
    return true;
  }

  async deleteMcpServer(userId: string, serverId: string): Promise<boolean> {
    const key = this.#serverKey(userId, serverId);
    this.#servers.delete(key);
    this.#status.delete(key);
    this.#catalogs.delete(key);
    this.#credentials.delete(key);
    return true;
  }

  async saveMcpServerStatus(
    userId: string,
    serverId: string,
    status: McpServerStatus,
  ): Promise<void> {
    const key = this.#serverKey(userId, serverId);
    if (!this.#servers.has(key)) return;
    this.#status.set(key, clone(status));
  }

  async getMcpCatalog(userId: string, serverId: string): Promise<McpCatalog | null> {
    let latest: McpCatalog | null = null;
    for (const [key, catalog] of this.#catalogs) {
      if (!key.startsWith(`${this.#serverKey(userId, serverId)}\u0000`)) continue;
      if (!latest || catalog.fetchedAt > latest.fetchedAt) latest = catalog;
    }
    return latest ? clone(latest) : null;
  }

  async getMcpCatalogForIdentity(
    userId: string,
    serverId: string,
    identity: string,
  ): Promise<McpCatalog | null> {
    const catalog = this.#catalogs.get(`${this.#serverKey(userId, serverId)}\u0000${identity}`);
    return catalog ? clone(catalog) : null;
  }

  async saveMcpCatalog(userId: string, catalog: McpCatalog): Promise<void> {
    this.#catalogs.set(
      `${this.#serverKey(userId, catalog.serverId)}\u0000${catalog.identity}`,
      clone(catalog),
    );
  }

  async invalidateMcpCatalog(
    userId: string,
    serverId: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    for (const [key, catalog] of this.#catalogs) {
      if (!key.startsWith(`${this.#serverKey(userId, serverId)}\u0000`)) continue;
      this.#catalogs.set(key, {
        ...catalog,
        invalidatedAt: catalog.invalidatedAt ?? at.toISOString(),
        invalidReason: catalog.invalidReason ?? reason,
      });
    }
  }

  async createMcpAction(record: McpActionRecord): Promise<void> {
    this.#actions.set(record.id, clone(record));
  }

  async updateMcpAction(userId: string, actionId: string, patch: McpActionPatch): Promise<void> {
    const existing = this.#actions.get(actionId);
    if (!existing || existing.userId !== userId) return;
    this.#actions.set(actionId, {
      ...existing,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.conclusion !== undefined ? { conclusion: patch.conclusion } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.resultJson !== undefined ? { resultJson: patch.resultJson } : {}),
      ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    });
  }

  async getMcpAction(userId: string, actionId: string): Promise<McpActionRecord | null> {
    const record = this.#actions.get(actionId);
    return record && record.userId === userId ? clone(record) : null;
  }

  async listMcpActions(
    userId: string,
    options: {
      readonly conversationId?: string;
      readonly state?: McpActionRecord['state'];
      readonly limit?: number;
    },
  ): Promise<McpActionRecord[]> {
    return [...this.#actions.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          (options.conversationId === undefined || record.conversationId === options.conversationId) &&
          (options.state === undefined || record.state === options.state),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit ?? 100)
      .map(clone);
  }

  async createMcpInteraction(record: McpInteractionRecord): Promise<void> {
    for (const existing of this.#interactions.values()) {
      if (existing.resumeKey === record.resumeKey) {
        throw new Error('duplicate resume key');
      }
    }
    this.#interactions.set(record.id, clone(record));
  }

  async getMcpInteraction(
    userId: string,
    interactionId: string,
  ): Promise<McpInteractionRecord | null> {
    const record = this.#interactions.get(interactionId);
    return record && record.userId === userId ? clone(record) : null;
  }

  async listMcpInteractions(
    userId: string,
    conversationId: string,
  ): Promise<McpInteractionRecord[]> {
    return [...this.#interactions.values()]
      .filter((record) => record.userId === userId && record.conversationId === conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(clone);
  }

  async resolveMcpInteraction(input: {
    readonly userId: string;
    readonly interactionId: string;
    readonly status: 'accepted' | 'rejected' | 'cancelled' | 'expired';
    readonly response: unknown;
    readonly now: Date;
  }): Promise<boolean> {
    const existing = this.#interactions.get(input.interactionId);
    if (!existing || existing.userId !== input.userId || existing.status !== 'pending') {
      return false;
    }
    this.#interactions.set(input.interactionId, {
      ...existing,
      status: input.status,
      response: (input.response ?? null) as McpInteractionRecord['response'],
      resolvedAt: input.now.toISOString(),
    });
    return true;
  }

  async expireMcpInteractions(now: Date): Promise<number> {
    let expired = 0;
    for (const [id, record] of this.#interactions) {
      if (record.status !== 'pending') continue;
      if (record.expiresAt > now.toISOString()) continue;
      this.#interactions.set(id, {
        ...record,
        status: 'expired',
        resolvedAt: now.toISOString(),
      });
      expired += 1;
    }
    return expired;
  }

  async createMcpTask(record: McpTaskRecord): Promise<void> {
    this.#tasks.set(record.id, clone(record));
  }

  async updateMcpTask(userId: string, taskId: string, patch: McpTaskPatch): Promise<void> {
    const existing = this.#tasks.get(taskId);
    if (!existing || existing.userId !== userId) return;
    this.#tasks.set(taskId, { ...existing, ...patch });
  }

  async getMcpTask(userId: string, taskId: string): Promise<McpTaskRecord | null> {
    const record = this.#tasks.get(taskId);
    return record && record.userId === userId ? clone(record) : null;
  }

  async listMcpTasks(
    userId: string,
    options: { readonly conversationId?: string; readonly status?: McpTaskRecord['status'] } = {},
  ): Promise<McpTaskRecord[]> {
    return [...this.#tasks.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          (options.conversationId === undefined || record.conversationId === options.conversationId) &&
          (options.status === undefined || record.status === options.status),
      )
      .map(clone);
  }

  async putMcpCredential(record: McpCredentialRecord): Promise<void> {
    this.#credentials.set(`${record.userId}\u0000${record.serverId}\u0000${record.kind}`, clone(record));
  }

  async getMcpCredential(
    userId: string,
    serverId: string,
    kind: string,
  ): Promise<McpCredentialRecord | null> {
    const record = this.#credentials.get(`${userId}\u0000${serverId}\u0000${kind}`);
    return record ? clone(record) : null;
  }

  async deleteMcpCredentials(userId: string, serverId: string): Promise<void> {
    for (const key of [...this.#credentials.keys()]) {
      if (key.startsWith(`${userId}\u0000${serverId}\u0000`)) this.#credentials.delete(key);
    }
  }

  async listConversationServers(
    userId: string,
    conversationId: string,
  ): Promise<McpConversationBinding[]> {
    return (this.#bindings.get(`${userId}\u0000${conversationId}`) ?? []).map(clone);
  }

  async setConversationServers(
    userId: string,
    conversationId: string,
    serverIds: readonly string[],
    now: Date,
  ): Promise<void> {
    this.#bindings.set(
      `${userId}\u0000${conversationId}`,
      [...new Set(serverIds)].map((serverId) => ({
        conversationId,
        serverId,
        enabled: true,
        updatedAt: now.toISOString(),
      })),
    );
  }

  async saveMcpResourceSnapshot(record: McpResourceSnapshotRecord): Promise<void> {
    const key = `${record.userId}\u0000${record.conversationId}`;
    const list = this.#resources.get(key) ?? [];
    list.unshift(clone(record));
    this.#resources.set(key, list.slice(0, 100));
  }

  async listMcpResourceSnapshots(
    userId: string,
    conversationId: string,
  ): Promise<McpResourceSnapshotRecord[]> {
    return (this.#resources.get(`${userId}\u0000${conversationId}`) ?? []).map(clone);
  }

  async invalidateMcpResource(
    userId: string,
    conversationId: string,
    serverId: string,
    uri: string,
    at: Date,
  ): Promise<void> {
    const key = `${userId}\u0000${conversationId}`;
    const list = this.#resources.get(key);
    if (!list) return;
    this.#resources.set(
      key,
      list.map((record) =>
        record.serverId === serverId && record.uri === uri
          ? { ...record, invalidatedAt: record.invalidatedAt ?? at.toISOString() }
          : record,
      ),
    );
  }

  async createMcpArtifact(record: McpArtifactRecord): Promise<void> {
    this.#artifacts.set(record.id, clone(record));
  }

  async getMcpArtifact(userId: string, artifactId: string): Promise<McpArtifactRecord | null> {
    const record = this.#artifacts.get(artifactId);
    return record && record.userId === userId ? clone(record) : null;
  }
}
