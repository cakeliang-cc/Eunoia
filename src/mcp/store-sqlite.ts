/**
 * SQLite implementation of `McpStore`.
 *
 * It shares the process's one connection: a second connection would contend for
 * the WAL writer and could observe a half-written catalog. Row mapping stays
 * here; above this file there are no column names.
 */

import { DatabaseSync } from 'node:sqlite';
import type { McpArtifactRecord, McpActionPatch, McpCredentialRecord, McpServerRecord, McpStore, McpTaskPatch, McpResourceSnapshotRecord } from './store.ts';
import type {
  McpActionRecord,
  McpCatalog,
  McpConversationBinding,
  McpInteractionRecord,
  McpServerConfig,
  McpServerStatus,
  McpTaskRecord,
} from './types.ts';

type Row = Record<string, unknown>;

export class SqliteMcpStore implements McpStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // ------------------------------------------------------------- servers ---

  async listMcpServers(userId: string): Promise<McpServerRecord[]> {
    const rows = this.#all<Row>(
      'SELECT config, status FROM mcp_servers WHERE user_id = ? ORDER BY created_at',
      userId,
    );
    return rows.map(toServerRecord);
  }

  async getMcpServer(userId: string, serverId: string): Promise<McpServerRecord | null> {
    const row = this.#get<Row>(
      'SELECT config, status FROM mcp_servers WHERE user_id = ? AND id = ?',
      userId,
      serverId,
    );
    return row ? toServerRecord(row) : null;
  }

  async insertMcpServer(config: McpServerConfig): Promise<void> {
    this.#run(
      `INSERT INTO mcp_servers
         (id, user_id, name, enabled, required, transport, config, status,
          config_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      config.id,
      config.userId,
      config.name,
      config.enabled ? 1 : 0,
      config.required ? 1 : 0,
      config.transport,
      JSON.stringify(config),
      config.configRevision,
      config.createdAt,
      config.updatedAt,
    );
  }

  async updateMcpServer(config: McpServerConfig, expectedRevision: number): Promise<boolean> {
    const result = this.#run(
      `UPDATE mcp_servers
          SET name = ?, enabled = ?, required = ?, transport = ?, config = ?,
              config_revision = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND config_revision = ?`,
      config.name,
      config.enabled ? 1 : 0,
      config.required ? 1 : 0,
      config.transport,
      JSON.stringify(config),
      config.configRevision,
      config.updatedAt,
      config.userId,
      config.id,
      expectedRevision,
    );
    return result.changes > 0;
  }

  async deleteMcpServer(userId: string, serverId: string): Promise<boolean> {
    return this.#run('DELETE FROM mcp_servers WHERE user_id = ? AND id = ?', userId, serverId)
      .changes > 0;
  }

  async saveMcpServerStatus(
    userId: string,
    serverId: string,
    status: McpServerStatus,
  ): Promise<void> {
    this.#run(
      'UPDATE mcp_servers SET status = ? WHERE user_id = ? AND id = ?',
      JSON.stringify(status),
      userId,
      serverId,
    );
  }

  // ------------------------------------------------------------- catalog ---

  async getMcpCatalog(userId: string, serverId: string): Promise<McpCatalog | null> {
    const row = this.#get<Row>(
      `SELECT snapshot FROM mcp_catalogs
        WHERE user_id = ? AND server_id = ?
        ORDER BY fetched_at DESC LIMIT 1`,
      userId,
      serverId,
    );
    return row ? ((JSON.parse(String(row.snapshot)) as McpCatalog) ?? null) : null;
  }

  async getMcpCatalogForIdentity(
    userId: string,
    serverId: string,
    identity: string,
  ): Promise<McpCatalog | null> {
    const row = this.#get<Row>(
      'SELECT snapshot FROM mcp_catalogs WHERE user_id = ? AND server_id = ? AND identity = ?',
      userId,
      serverId,
      identity,
    );
    return row ? ((JSON.parse(String(row.snapshot)) as McpCatalog) ?? null) : null;
  }

  async saveMcpCatalog(userId: string, catalog: McpCatalog): Promise<void> {
    this.#run(
      `INSERT INTO mcp_catalogs
         (server_id, user_id, identity, revision, snapshot, fetched_at,
          invalidated_at, invalid_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, identity) DO UPDATE SET
         revision = excluded.revision,
         snapshot = excluded.snapshot,
         fetched_at = excluded.fetched_at,
         invalidated_at = excluded.invalidated_at,
         invalid_reason = excluded.invalid_reason`,
      catalog.serverId,
      userId,
      catalog.identity,
      catalog.revision,
      JSON.stringify(catalog),
      catalog.fetchedAt,
      catalog.invalidatedAt,
      catalog.invalidReason,
    );
  }

  async invalidateMcpCatalog(
    userId: string,
    serverId: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    this.#run(
      `UPDATE mcp_catalogs SET invalidated_at = COALESCE(invalidated_at, ?),
         invalid_reason = COALESCE(invalid_reason, ?)
       WHERE user_id = ? AND server_id = ?`,
      at.toISOString(),
      reason,
      userId,
      serverId,
    );
  }

  // -------------------------------------------------------------- actions ---

  async createMcpAction(record: McpActionRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_actions
         (id, user_id, conversation_id, turn_id, step, call_id, server_id, identity,
          catalog_revision, contract_hash, tool_name, arguments_json, arguments_digest,
          classification, state, conclusion, error, result_json, sent_at, finished_at,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.turnId,
      record.step,
      record.callId,
      record.serverId,
      record.identity,
      record.catalogRevision,
      record.contractHash,
      record.toolName,
      record.argumentsJson,
      record.argumentsDigest,
      record.classification,
      record.state,
      record.conclusion,
      record.error ? JSON.stringify(record.error) : null,
      record.resultJson,
      record.sentAt,
      record.finishedAt,
      record.createdAt,
    );
  }

  async updateMcpAction(userId: string, actionId: string, patch: McpActionPatch): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.state !== undefined) add('state', patch.state);
    if (patch.conclusion !== undefined) add('conclusion', patch.conclusion);
    if (patch.error !== undefined) add('error', patch.error === null ? null : JSON.stringify(patch.error));
    if (patch.resultJson !== undefined) add('result_json', patch.resultJson);
    if (patch.sentAt !== undefined) add('sent_at', patch.sentAt);
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    values.push(userId, actionId);
    this.#run(
      `UPDATE mcp_actions SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
      ...values,
    );
  }

  async getMcpAction(userId: string, actionId: string): Promise<McpActionRecord | null> {
    const row = this.#get<Row>(
      'SELECT * FROM mcp_actions WHERE user_id = ? AND id = ?',
      userId,
      actionId,
    );
    return row ? toAction(row) : null;
  }

  async listMcpActions(
    userId: string,
    options: {
      readonly conversationId?: string;
      readonly state?: McpActionRecord['state'];
      readonly limit?: number;
    },
  ): Promise<McpActionRecord[]> {
    const clauses = ['user_id = ?'];
    const values: (string | number)[] = [userId];
    if (options.conversationId) {
      clauses.push('conversation_id = ?');
      values.push(options.conversationId);
    }
    if (options.state) {
      clauses.push('state = ?');
      values.push(options.state);
    }
    values.push(options.limit ?? 100);
    return this.#all<Row>(
      `SELECT * FROM mcp_actions WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?`,
      ...values,
    ).map(toAction);
  }

  // --------------------------------------------------------- interactions ---

  async createMcpInteraction(record: McpInteractionRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_interactions
         (id, user_id, conversation_id, turn_id, action_id, server_id, kind, status,
          summary, payload, resume_key, expires_at, response, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.turnId,
      record.actionId,
      record.serverId,
      record.kind,
      record.status,
      record.summary,
      JSON.stringify(record.payload),
      record.resumeKey,
      record.expiresAt,
      record.response === null ? null : JSON.stringify(record.response),
      record.createdAt,
      record.resolvedAt,
    );
  }

  async getMcpInteraction(
    userId: string,
    interactionId: string,
  ): Promise<McpInteractionRecord | null> {
    const row = this.#get<Row>(
      'SELECT * FROM mcp_interactions WHERE user_id = ? AND id = ?',
      userId,
      interactionId,
    );
    return row ? toInteraction(row) : null;
  }

  async listMcpInteractions(
    userId: string,
    conversationId: string,
  ): Promise<McpInteractionRecord[]> {
    return this.#all<Row>(
      `SELECT * FROM mcp_interactions
        WHERE user_id = ? AND conversation_id = ?
        ORDER BY created_at DESC LIMIT 50`,
      userId,
      conversationId,
    ).map(toInteraction);
  }

  async resolveMcpInteraction(input: {
    readonly userId: string;
    readonly interactionId: string;
    readonly status: 'accepted' | 'rejected' | 'cancelled' | 'expired';
    readonly response: unknown;
    readonly now: Date;
  }): Promise<boolean> {
    // The WHERE clause is the concurrency control: two tabs both see "pending",
    // only one UPDATE changes a row.
    const result = this.#run(
      `UPDATE mcp_interactions
          SET status = ?, response = ?, resolved_at = ?
        WHERE user_id = ? AND id = ? AND status = 'pending'`,
      input.status,
      input.response === undefined ? null : JSON.stringify(input.response),
      input.now.toISOString(),
      input.userId,
      input.interactionId,
    );
    return result.changes > 0;
  }

  async expireMcpInteractions(now: Date): Promise<number> {
    return this.#run(
      `UPDATE mcp_interactions SET status = 'expired', resolved_at = ?
        WHERE status = 'pending' AND expires_at <= ?`,
      now.toISOString(),
      now.toISOString(),
    ).changes;
  }

  // ---------------------------------------------------------------- tasks ---

  async createMcpTask(record: McpTaskRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_tasks
         (id, user_id, conversation_id, server_id, action_id, remote_task_id, identity,
          status, poll_interval_ms, ttl_ms, deadline_at, last_checked_at, result_json,
          error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.serverId,
      record.actionId,
      record.remoteTaskId,
      record.identity,
      record.status,
      record.pollIntervalMs,
      record.ttlMs,
      record.deadlineAt,
      record.lastCheckedAt,
      record.resultJson,
      record.error ? JSON.stringify(record.error) : null,
      record.createdAt,
    );
  }

  async updateMcpTask(userId: string, taskId: string, patch: McpTaskPatch): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const add = (column: string, value: string | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.resultJson !== undefined) add('result_json', patch.resultJson);
    if (patch.error !== undefined) add('error', patch.error === null ? null : JSON.stringify(patch.error));
    if (patch.lastCheckedAt !== undefined) add('last_checked_at', patch.lastCheckedAt);
    if (patch.deadlineAt !== undefined) add('deadline_at', patch.deadlineAt);
    if (sets.length === 0) return;
    values.push(userId, taskId);
    this.#run(`UPDATE mcp_tasks SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, ...values);
  }

  async getMcpTask(userId: string, taskId: string): Promise<McpTaskRecord | null> {
    const row = this.#get<Row>('SELECT * FROM mcp_tasks WHERE user_id = ? AND id = ?', userId, taskId);
    return row ? toTask(row) : null;
  }

  async listMcpTasks(
    userId: string,
    options: { readonly conversationId?: string; readonly status?: McpTaskRecord['status'] } = {},
  ): Promise<McpTaskRecord[]> {
    const clauses = ['user_id = ?'];
    const values: string[] = [userId];
    if (options.conversationId) {
      clauses.push('conversation_id = ?');
      values.push(options.conversationId);
    }
    if (options.status) {
      clauses.push('status = ?');
      values.push(options.status);
    }
    return this.#all<Row>(
      `SELECT * FROM mcp_tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
      ...values,
    ).map(toTask);
  }

  // ---------------------------------------------------------- credentials ---

  async putMcpCredential(record: McpCredentialRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_credentials
         (id, user_id, server_id, kind, sealed, key_version, aad, scope, account,
          expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, kind) DO UPDATE SET
         sealed = excluded.sealed,
         key_version = excluded.key_version,
         aad = excluded.aad,
         scope = excluded.scope,
         account = excluded.account,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      record.id,
      record.userId,
      record.serverId,
      record.kind,
      record.sealed,
      record.keyVersion,
      record.aad,
      record.scope,
      record.account,
      record.expiresAt,
      record.createdAt,
      record.updatedAt,
    );
  }

  async getMcpCredential(
    userId: string,
    serverId: string,
    kind: string,
  ): Promise<McpCredentialRecord | null> {
    const row = this.#get<Row>(
      'SELECT * FROM mcp_credentials WHERE user_id = ? AND server_id = ? AND kind = ?',
      userId,
      serverId,
      kind,
    );
    return row ? toCredential(row) : null;
  }

  async deleteMcpCredentials(userId: string, serverId: string): Promise<void> {
    this.#run(
      'DELETE FROM mcp_credentials WHERE user_id = ? AND server_id = ?',
      userId,
      serverId,
    );
  }

  // ------------------------------------------------------------ bindings ---

  async listConversationServers(
    userId: string,
    conversationId: string,
  ): Promise<McpConversationBinding[]> {
    return this.#all<Row>(
      `SELECT conversation_id, server_id, enabled, updated_at
         FROM mcp_conversation_servers
        WHERE user_id = ? AND conversation_id = ? AND enabled = 1
        ORDER BY server_id`,
      userId,
      conversationId,
    ).map((row) => ({
      conversationId: String(row.conversation_id),
      serverId: String(row.server_id),
      enabled: Number(row.enabled) === 1,
      updatedAt: String(row.updated_at),
    }));
  }

  async setConversationServers(
    userId: string,
    conversationId: string,
    serverIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const unique = [...new Set(serverIds)];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#run(
        'DELETE FROM mcp_conversation_servers WHERE user_id = ? AND conversation_id = ?',
        userId,
        conversationId,
      );
      for (const serverId of unique) {
        this.#run(
          `INSERT INTO mcp_conversation_servers
             (user_id, conversation_id, server_id, enabled, updated_at)
           VALUES (?, ?, ?, 1, ?)`,
          userId,
          conversationId,
          serverId,
          now.toISOString(),
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------- resources ---

  async saveMcpResourceSnapshot(record: McpResourceSnapshotRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_resource_snapshots
         (id, user_id, conversation_id, server_id, uri, identity, mime_type, text,
          blob_key, bytes, sha256, fetched_at, expires_at, invalidated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.serverId,
      record.uri,
      record.identity,
      record.mimeType,
      record.text,
      record.blobKey,
      record.bytes,
      record.sha256,
      record.fetchedAt,
      record.expiresAt,
      record.invalidatedAt,
    );
  }

  async listMcpResourceSnapshots(
    userId: string,
    conversationId: string,
  ): Promise<McpResourceSnapshotRecord[]> {
    return this.#all<Row>(
      `SELECT * FROM mcp_resource_snapshots
        WHERE user_id = ? AND conversation_id = ?
        ORDER BY fetched_at DESC LIMIT 100`,
      userId,
      conversationId,
    ).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      conversationId: String(row.conversation_id),
      serverId: String(row.server_id),
      uri: String(row.uri),
      identity: String(row.identity),
      mimeType: row.mime_type === null ? null : String(row.mime_type),
      text: row.text === null ? null : String(row.text),
      blobKey: row.blob_key === null ? null : String(row.blob_key),
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      fetchedAt: String(row.fetched_at),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      invalidatedAt: row.invalidated_at === null ? null : String(row.invalidated_at),
    }));
  }

  async invalidateMcpResource(
    userId: string,
    conversationId: string,
    serverId: string,
    uri: string,
    at: Date,
  ): Promise<void> {
    this.#run(
      `UPDATE mcp_resource_snapshots SET invalidated_at = COALESCE(invalidated_at, ?)
        WHERE user_id = ? AND conversation_id = ? AND server_id = ? AND uri = ?`,
      at.toISOString(),
      userId,
      conversationId,
      serverId,
      uri,
    );
  }

  // ------------------------------------------------------------- artifacts ---

  async createMcpArtifact(record: McpArtifactRecord): Promise<void> {
    this.#run(
      `INSERT INTO mcp_artifacts
         (id, user_id, conversation_id, action_id, mime_type, bytes, sha256, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.actionId,
      record.mimeType,
      record.bytes,
      record.sha256,
      record.storageKey,
      record.createdAt,
    );
  }

  async getMcpArtifact(userId: string, artifactId: string): Promise<McpArtifactRecord | null> {
    const row = this.#get<Row>(
      'SELECT * FROM mcp_artifacts WHERE user_id = ? AND id = ?',
      userId,
      artifactId,
    );
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      conversationId: String(row.conversation_id),
      actionId: row.action_id === null ? null : String(row.action_id),
      mimeType: String(row.mime_type),
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      storageKey: String(row.storage_key),
      createdAt: String(row.created_at),
    };
  }

  // ------------------------------------------------------------- helpers ---

  #get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.#db.prepare(sql).get(...args) as T | undefined;
  }

  #all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.#db.prepare(sql).all(...args) as T[];
  }

  #run(sql: string, ...args: (string | number | null)[]): { changes: number } {
    return this.#db.prepare(sql).run(...args) as { changes: number };
  }
}

function toServerRecord(row: Row): McpServerRecord {
  const config = JSON.parse(String(row.config)) as McpServerConfig;
  const statusRaw = row.status === undefined ? '{}' : String(row.status);
  let status: McpServerStatus | null = null;
  try {
    const parsed = JSON.parse(statusRaw) as McpServerStatus | Record<string, never>;
    status = Object.keys(parsed).length > 0 ? (parsed as McpServerStatus) : null;
  } catch {
    status = null;
  }
  return { config, status };
}

function toAction(row: Row): McpActionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    step: row.step === null ? null : Number(row.step),
    callId: String(row.call_id),
    serverId: String(row.server_id),
    identity: String(row.identity),
    catalogRevision: String(row.catalog_revision),
    contractHash: String(row.contract_hash),
    toolName: String(row.tool_name),
    argumentsJson: String(row.arguments_json),
    argumentsDigest: String(row.arguments_digest),
    classification: String(row.classification) as McpActionRecord['classification'],
    state: String(row.state) as McpActionRecord['state'],
    conclusion: row.conclusion === null ? null : (String(row.conclusion) as McpActionRecord['conclusion']),
    error: row.error === null ? null : (JSON.parse(String(row.error)) as McpActionRecord['error']),
    resultJson: row.result_json === null ? null : String(row.result_json),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    createdAt: String(row.created_at),
  };
}

function toInteraction(row: Row): McpInteractionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    actionId: row.action_id === null ? null : String(row.action_id),
    serverId: String(row.server_id),
    kind: String(row.kind) as McpInteractionRecord['kind'],
    status: String(row.status) as McpInteractionRecord['status'],
    summary: String(row.summary),
    payload: JSON.parse(String(row.payload)) as McpInteractionRecord['payload'],
    resumeKey: String(row.resume_key),
    expiresAt: String(row.expires_at),
    response: row.response === null ? null : (JSON.parse(String(row.response)) as McpInteractionRecord['response']),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

function toTask(row: Row): McpTaskRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    serverId: String(row.server_id),
    actionId: String(row.action_id),
    remoteTaskId: String(row.remote_task_id),
    identity: String(row.identity),
    status: String(row.status) as McpTaskRecord['status'],
    pollIntervalMs: Number(row.poll_interval_ms),
    ttlMs: row.ttl_ms === null ? null : Number(row.ttl_ms),
    deadlineAt: row.deadline_at === null ? null : String(row.deadline_at),
    lastCheckedAt: row.last_checked_at === null ? null : String(row.last_checked_at),
    resultJson: row.result_json === null ? null : String(row.result_json),
    error: row.error === null ? null : (JSON.parse(String(row.error)) as McpTaskRecord['error']),
    createdAt: String(row.created_at),
  };
}

function toCredential(row: Row): McpCredentialRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    serverId: String(row.server_id),
    kind: String(row.kind),
    sealed: String(row.sealed),
    keyVersion: Number(row.key_version),
    aad: String(row.aad),
    scope: row.scope === null ? null : String(row.scope),
    account: row.account === null ? null : String(row.account),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
