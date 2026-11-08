/**
 * The MCP host's persistence port.
 *
 * Kept separate from `Store` on purpose: MCP has its own lifetime (catalog
 * snapshots, approvals, remote task handles) and its own recovery rules, and
 * folding it into the conversation store would make the product interface carry
 * columns the chat path never reads.
 *
 * Every method is owner-scoped. A read for another user's id returns null, not
 * a permission error: distinguishing the two would leak which ids exist.
 */

import type {
  McpActionRecord,
  McpCatalog,
  McpConversationBinding,
  McpInteractionRecord,
  McpServerConfig,
  McpServerStatus,
  McpTaskRecord,
} from './types.ts';

export interface McpServerRecord {
  readonly config: McpServerConfig;
  readonly status: McpServerStatus | null;
}

export interface McpCredentialRecord {
  readonly id: string;
  readonly userId: string;
  readonly serverId: string;
  /** `oauth` or `header`. */
  readonly kind: string;
  /** Base64 of iv + tag + ciphertext. Never plaintext. */
  readonly sealed: string;
  readonly keyVersion: number;
  /** Additional authenticated data that binds the row to its owner. */
  readonly aad: string;
  readonly scope: string | null;
  readonly account: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpResourceSnapshotRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly serverId: string;
  readonly uri: string;
  readonly identity: string;
  readonly mimeType: string | null;
  readonly text: string | null;
  readonly blobKey: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly fetchedAt: string;
  readonly expiresAt: string | null;
  readonly invalidatedAt: string | null;
}

export interface McpArtifactRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly actionId: string | null;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly createdAt: string;
}

export interface McpActionPatch {
  readonly state?: McpActionRecord['state'];
  readonly conclusion?: McpActionRecord['conclusion'];
  readonly error?: McpActionRecord['error'];
  readonly resultJson?: string | null;
  readonly sentAt?: string | null;
  readonly finishedAt?: string | null;
}

export interface McpTaskPatch {
  readonly status?: McpTaskRecord['status'];
  readonly resultJson?: string | null;
  readonly error?: McpTaskRecord['error'];
  readonly lastCheckedAt?: string | null;
  readonly deadlineAt?: string | null;
}

export interface McpStore {
  listMcpServers(userId: string): Promise<McpServerRecord[]>;
  getMcpServer(userId: string, serverId: string): Promise<McpServerRecord | null>;
  insertMcpServer(config: McpServerConfig): Promise<void>;
  /** Optimistic update: false when the stored revision is not `expectedRevision`. */
  updateMcpServer(config: McpServerConfig, expectedRevision: number): Promise<boolean>;
  deleteMcpServer(userId: string, serverId: string): Promise<boolean>;
  saveMcpServerStatus(userId: string, serverId: string, status: McpServerStatus): Promise<void>;

  /** The most recent snapshot for the server, whichever identity owns it. */
  getMcpCatalog(userId: string, serverId: string): Promise<McpCatalog | null>;
  getMcpCatalogForIdentity(
    userId: string,
    serverId: string,
    identity: string,
  ): Promise<McpCatalog | null>;
  saveMcpCatalog(userId: string, catalog: McpCatalog): Promise<void>;
  invalidateMcpCatalog(
    userId: string,
    serverId: string,
    reason: string,
    at: Date,
  ): Promise<void>;

  createMcpAction(record: McpActionRecord): Promise<void>;
  updateMcpAction(userId: string, actionId: string, patch: McpActionPatch): Promise<void>;
  getMcpAction(userId: string, actionId: string): Promise<McpActionRecord | null>;
  listMcpActions(
    userId: string,
    options: { readonly conversationId?: string; readonly state?: McpActionRecord['state']; readonly limit?: number },
  ): Promise<McpActionRecord[]>;

  createMcpInteraction(record: McpInteractionRecord): Promise<void>;
  getMcpInteraction(userId: string, interactionId: string): Promise<McpInteractionRecord | null>;
  listMcpInteractions(
    userId: string,
    conversationId: string,
  ): Promise<McpInteractionRecord[]>;
  /**
   * Move a pending interaction to a final state, atomically.
   *
   * False means it was not pending: already resolved, expired, or somebody
   * else's. The caller must not execute the action on false.
   */
  resolveMcpInteraction(input: {
    readonly userId: string;
    readonly interactionId: string;
    readonly status: 'accepted' | 'rejected' | 'cancelled' | 'expired';
    readonly response: unknown;
    readonly now: Date;
  }): Promise<boolean>;
  expireMcpInteractions(now: Date): Promise<number>;

  createMcpTask(record: McpTaskRecord): Promise<void>;
  updateMcpTask(userId: string, taskId: string, patch: McpTaskPatch): Promise<void>;
  getMcpTask(userId: string, taskId: string): Promise<McpTaskRecord | null>;
  listMcpTasks(
    userId: string,
    options?: { readonly conversationId?: string; readonly status?: McpTaskRecord['status'] },
  ): Promise<McpTaskRecord[]>;

  putMcpCredential(record: McpCredentialRecord): Promise<void>;
  getMcpCredential(
    userId: string,
    serverId: string,
    kind: string,
  ): Promise<McpCredentialRecord | null>;
  deleteMcpCredentials(userId: string, serverId: string): Promise<void>;

  listConversationServers(userId: string, conversationId: string): Promise<McpConversationBinding[]>;
  setConversationServers(
    userId: string,
    conversationId: string,
    serverIds: readonly string[],
    now: Date,
  ): Promise<void>;

  saveMcpResourceSnapshot(record: McpResourceSnapshotRecord): Promise<void>;
  listMcpResourceSnapshots(
    userId: string,
    conversationId: string,
  ): Promise<McpResourceSnapshotRecord[]>;
  invalidateMcpResource(
    userId: string,
    conversationId: string,
    serverId: string,
    uri: string,
    at: Date,
  ): Promise<void>;

  createMcpArtifact(record: McpArtifactRecord): Promise<void>;
  getMcpArtifact(userId: string, artifactId: string): Promise<McpArtifactRecord | null>;
}
