/**
 * The connection manager: generations, catalogs, reconnects and cancellation.
 *
 * One server may be connected by more than one turn at a time; one *catalog
 * revision* is fetched by exactly one connection. The manager owns the mapping
 * between those facts:
 *
 *   - every connect increments a generation; a late reply from an older
 *     generation loses, so a stale `tools/list` cannot replace a newer catalog;
 *   - a reconnect re-runs discovery but never replays `tools/call` — a write that
 *     may have been executed is not retried because the pipe closed;
 *   - a per-turn catalog lease (revision + contract hash) is checked at call
 *     time, so revoking a tool stops new executions immediately even while the
 *     turn's tool list still mentions it.
 *
 * See docs/adr/033-mcp-host.md §6.3 and §7.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildCatalog,
  collectPages,
  enabledToolCount,
  type RawCatalog,
  type RawPrompt,
  type RawResource,
  type RawResourceTemplate,
  type RawTool,
} from './catalog.ts';
import { McpConnection, describeConnectionError, type ElicitationRequest, type RawCallResult } from './client.ts';
import { mapCallResult, type MappedResult } from './content.ts';
import {
  applyBrowserOutput,
  readBrowserScreenshot,
  type BrowserOutputOptions,
} from './browser-output.ts';
import { McpCredentialVault, MCP_REDACTOR } from './credentials.ts';
import type { McpStore } from './store.ts';
import {
  DEFAULT_MCP_TIMEOUTS,
  McpError,
  initialStatus,
  type McpActionRecord,
  type McpAuthState,
  type McpCatalog,
  type McpConnectionStatus,
  type McpErrorDescription,
  type McpLimits,
  type McpServerConfig,
  type McpServerStatus,
  type McpServerView,
  type McpTaskRecord,
  type McpToolView,
} from './types.ts';

interface LiveConnection {
  readonly generation: number;
  readonly identity: string;
  readonly connection: McpConnection;
  readonly configRevision: number;
}

interface PendingAuth {
  readonly userId: string;
  readonly serverId: string;
  readonly state: string;
  readonly transport: unknown;
  readonly redirectUrl: string;
  readonly createdAt: number;
}

export interface ManagerDeps {
  readonly store: McpStore;
  readonly vault: McpCredentialVault;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  /** Called on every status change, for SSE. */
  readonly onStatus?: (userId: string, serverId: string, status: McpServerStatus) => void;
  /** Server-initiated elicitation. The default declines and reports. */
  readonly onElicit?: (input: {
    readonly userId: string;
    readonly serverId: string;
    readonly conversationId: string | null;
    readonly request: ElicitationRequest;
  }) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
  /** Injectable for tests: build a connection without the SDK. */
  readonly connect?: typeof McpConnection.open;
  /**
   * Browser screenshot file adapter (R06).
   *
   * Production leaves this empty: the adapter uses the process cwd, the media
   * byte limit supplied by the runtime, and the real filesystem. Tests inject a
   * temporary base directory and a filesystem spy.
   */
  readonly browserOutput?: BrowserOutputOptions;
}

const MAX_CONNECT_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class McpClientManager {
  readonly #store: McpStore;
  readonly #vault: McpCredentialVault;
  readonly #now: () => Date;
  readonly #fetch: typeof fetch | undefined;
  readonly #onStatus: ManagerDeps['onStatus'];
  readonly #onElicit: ManagerDeps['onElicit'];
  readonly #open: typeof McpConnection.open;
  readonly #browserOutput: BrowserOutputOptions;
  readonly #live = new Map<string, LiveConnection>();
  readonly #statuses = new Map<string, McpServerStatus>();
  readonly #retry = new Map<string, { attempts: number; timer: NodeJS.Timeout | null; nextAt: Date }>();
  readonly #pendingAuth = new Map<string, PendingAuth>();
  readonly #listeners = new Set<(userId: string, serverId: string, status: McpServerStatus) => void>();
  #shuttingDown = false;
  /**
   * The call an elicitation belongs to.
   *
   * A server asks for input *inside* a tools/call; the handler is installed per
   * connection, not per call, so it has no argument carrying the conversation.
   * Async-local context follows the await chain, so concurrent calls to one
   * server still resolve to their own conversation.
   */
  readonly #callContext = new AsyncLocalStorage<{
    readonly userId: string;
    readonly conversationId: string;
    readonly serverId: string;
  }>();

  constructor(deps: ManagerDeps) {
    this.#store = deps.store;
    this.#vault = deps.vault;
    this.#now = deps.now ?? (() => new Date());
    this.#fetch = deps.fetch;
    this.#onStatus = deps.onStatus;
    this.#onElicit = deps.onElicit;
    this.#open = deps.connect ?? McpConnection.open;
    this.#browserOutput = deps.browserOutput ?? {};
  }

  onStatusChange(listener: (userId: string, serverId: string, status: McpServerStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #key(userId: string, serverId: string): string {
    return `${userId}\u0000${serverId}`;
  }

  // -------------------------------------------------------------- servers ---

  async listServers(userId: string): Promise<McpServerView[]> {
    const records = await this.#store.listMcpServers(userId);
    const views: McpServerView[] = [];
    for (const record of records) {
      const status = await this.status(userId, record.config.id);
      const catalog = await this.#store.getMcpCatalog(userId, record.config.id);
      views.push(toView(record.config, status, catalog));
    }
    return views;
  }

  async getServer(userId: string, serverId: string): Promise<McpServerView> {
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    const status = await this.status(userId, serverId);
    const catalog = await this.#store.getMcpCatalog(userId, serverId);
    return toView(record.config, status, catalog);
  }

  async insertServer(config: McpServerConfig): Promise<void> {
    await this.#store.insertMcpServer(config);
    const status = initialStatus(config);
    await this.#store.saveMcpServerStatus(config.userId, config.id, status);
    this.#statuses.set(this.#key(config.userId, config.id), status);
    this.#emit(config.userId, config.id, status);
  }

  async updateServer(
    userId: string,
    serverId: string,
    next: Omit<McpServerConfig, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'configRevision'>,
    expectedRevision: number,
  ): Promise<McpServerConfig> {
    const existing = await this.#store.getMcpServer(userId, serverId);
    if (!existing) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    if (existing.config.configRevision !== expectedRevision) {
      throw new McpError(
        'MCP_NOT_FOUND',
        '配置已经被修改过（revision 冲突），请刷新后重试。',
        409,
        { detail: { expectedRevision, currentRevision: existing.config.configRevision } },
      );
    }
    const now = this.#now().toISOString();
    const config: McpServerConfig = {
      ...next,
      id: serverId,
      userId,
      configRevision: expectedRevision + 1,
      createdAt: existing.config.createdAt,
      updatedAt: now,
    };
    const updated = await this.#store.updateMcpServer(config, expectedRevision);
    if (!updated) {
      throw new McpError('MCP_NOT_FOUND', '配置同时被修改，请刷新后重试。', 409);
    }
    // Any live connection belongs to the previous revision. Close it without
    // touching the new status: the next connect will report its own state.
    await this.#closeLive(userId, serverId, 'config-changed');
    const status = initialStatus(config);
    await this.#store.saveMcpServerStatus(userId, serverId, status);
    this.#statuses.set(this.#key(userId, serverId), status);
    this.#emit(userId, serverId, status);
    return config;
  }

  async deleteServer(userId: string, serverId: string): Promise<void> {
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    await this.#closeLive(userId, serverId, 'deleted');
    this.#clearRetry(userId, serverId);
    await this.#vault.delete(userId, serverId);
    await this.#store.deleteMcpServer(userId, serverId);
    this.#statuses.delete(this.#key(userId, serverId));
  }

  // --------------------------------------------------------------- status ---

  async status(userId: string, serverId: string): Promise<McpServerStatus> {
    const key = this.#key(userId, serverId);
    const cached = this.#statuses.get(key);
    if (cached) return cached;
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    const status = record.status ?? initialStatus(record.config);
    this.#statuses.set(key, status);
    return status;
  }

  async #setStatus(
    userId: string,
    serverId: string,
    patch: Partial<McpServerStatus> & { readonly state: McpConnectionStatus },
  ): Promise<McpServerStatus> {
    const current = await this.status(userId, serverId).catch(() => null);
    const status: McpServerStatus = {
      ...(current ?? {
        state: 'disabled',
        generation: 0,
        lastError: null,
        lastErrorAt: null,
        toolCount: 0,
        nextRetryAt: null,
        protocolRevision: null,
        serverInfo: null,
        catalogRevision: null,
        auth: { mode: 'none', state: 'none', account: null, scope: null, expiresAt: null },
      }),
      ...patch,
    };
    this.#statuses.set(this.#key(userId, serverId), status);
    await this.#store.saveMcpServerStatus(userId, serverId, status).catch(() => undefined);
    this.#emit(userId, serverId, status);
    return status;
  }

  #emit(userId: string, serverId: string, status: McpServerStatus): void {
    this.#onStatus?.(userId, serverId, status);
    for (const listener of this.#listeners) listener(userId, serverId, status);
  }

  // -------------------------------------------------------------- connect ---

  /**
   * Connect and publish a catalog. Idempotent: a ready connection for the same
   * config revision and identity is reused, not duplicated.
   */
  async connect(userId: string, serverId: string): Promise<McpServerStatus> {
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    const { config } = record;
    if (!config.enabled) {
      return this.#setStatus(userId, serverId, { state: 'disabled' });
    }
    this.#clearRetry(userId, serverId);
    const existing = this.#live.get(this.#key(userId, serverId));
    if (
      existing &&
      !existing.connection.closed &&
      existing.configRevision === config.configRevision
    ) {
      return this.status(userId, serverId);
    }

    const previousGeneration = existing?.generation ?? 0;
    const generation = previousGeneration + 1;
    if (existing) await this.#closeLive(userId, serverId, 'replaced');

    await this.#setStatus(userId, serverId, {
      state: 'connecting',
      generation,
      nextRetryAt: null,
      ...(config.transport === 'http' && config.http?.auth === 'oauth'
        ? { auth: { mode: 'oauth', state: 'needs_login', account: null, scope: null, expiresAt: null } }
        : {}),
    });

    const identity = this.#identityOf(config);
    let connection: McpConnection;
    try {
      const authProvider = await this.#oauthProvider(config, identity);
      connection = await this.#open({
        config,
        generation,
        identity,
        ...(authProvider ? { authProvider } : {}),
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
        onElicit: async (request) => {
          const answer = await this.#handleElicit(userId, serverId, request);
          return answer as never;
        },
        onListChanged: (kind) => {
          void this.#handleListChanged(userId, serverId, generation, kind);
        },
      });
    } catch (error) {
      const described = describeConnectionError(error);
      const authRequired =
        error instanceof McpError &&
        (error.code === 'MCP_AUTH_REQUIRED' || error.code === 'MCP_AUTH_SCOPE');
      // The provider may have captured an authorization URL before failing.
      const pending = this.#latestAuthFor(userId, serverId);
      const status = await this.#setStatus(userId, serverId, {
        state: authRequired ? 'auth_required' : 'failed',
        lastError: {
          code: described.code,
          message: described.message,
          ...(described.detail ? { detail: described.detail } : {}),
        },
        lastErrorAt: this.#now().toISOString(),
        ...(pending
          ? { auth: { mode: 'oauth', state: 'needs_login', account: null, scope: null, expiresAt: null } }
          : {}),
      });
      if (!authRequired) this.#scheduleRetry(userId, config, 1);
      return status;
    }

    this.#live.set(this.#key(userId, serverId), {
      generation,
      identity,
      connection,
      configRevision: config.configRevision,
    });

    try {
      const catalog = await this.#fetchCatalog(config, identity, connection, generation);
      const status = await this.#setStatus(userId, serverId, {
        state: 'ready',
        generation,
        lastError: null,
        lastErrorAt: null,
        toolCount: enabledToolCount(catalog),
        catalogRevision: catalog.revision,
        protocolRevision: connection.protocolRevision,
        serverInfo: connection.serverInfo,
        nextRetryAt: null,
        auth: this.#authState(config, identity, null),
      });
      return status;
    } catch (error) {
      const described = describeConnectionError(error);
      await connection.close('catalog-failed').catch(() => undefined);
      this.#live.delete(this.#key(userId, serverId));
      const status = await this.#setStatus(userId, serverId, {
        state: 'failed',
        lastError: { code: described.code, message: described.message },
        lastErrorAt: this.#now().toISOString(),
      });
      this.#scheduleRetry(userId, config, 1);
      return status;
    }
  }

  async disconnect(userId: string, serverId: string): Promise<void> {
    this.#clearRetry(userId, serverId);
    await this.#closeLive(userId, serverId, 'manual');
    await this.#setStatus(userId, serverId, { state: 'disabled', nextRetryAt: null });
  }

  /**
   * Re-read the catalog. A failure keeps the previous snapshot and marks it
   * stale rather than publishing half a catalog.
   */
  async refresh(userId: string, serverId: string): Promise<McpServerStatus> {
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    const live = this.#live.get(this.#key(userId, serverId));
    if (!live || live.connection.closed) {
      return this.connect(userId, serverId);
    }
    try {
      await live.connection.ping();
      const catalog = await this.#fetchCatalog(
        record.config,
        live.identity,
        live.connection,
        live.generation,
      );
      return this.#setStatus(userId, serverId, {
        state: 'ready',
        toolCount: enabledToolCount(catalog),
        catalogRevision: catalog.revision,
        lastError: null,
        lastErrorAt: null,
        nextRetryAt: null,
        protocolRevision: live.connection.protocolRevision,
        serverInfo: live.connection.serverInfo,
      });
    } catch (error) {
      const described = describeConnectionError(error);
      // Keep the old snapshot; mark it invalidated so the UI can say why.
      const current = await this.#store.getMcpCatalog(userId, serverId);
      if (current) {
        await this.#store
          .invalidateMcpCatalog(userId, serverId, described.message, this.#now())
          .catch(() => undefined);
      }
      return this.#setStatus(userId, serverId, {
        state: 'failed',
        lastError: { code: described.code, message: described.message },
        lastErrorAt: this.#now().toISOString(),
      });
    }
  }

  async #handleListChanged(
    userId: string,
    serverId: string,
    generation: number,
    kind: 'tools' | 'resources' | 'prompts',
  ): Promise<void> {
    const live = this.#live.get(this.#key(userId, serverId));
    if (!live || live.generation !== generation) return;
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) return;
    await this.#store
      .invalidateMcpCatalog(userId, serverId, `${kind} list changed`, this.#now())
      .catch(() => undefined);
    // A debounce: servers often emit several notifications for one change.
    this.#clearRetry(userId, serverId);
    const timer = setTimeout(() => {
      void this.refresh(userId, serverId).catch(() => undefined);
    }, 300);
    timer.unref();
  }

  async #closeLive(userId: string, serverId: string, reason: string): Promise<void> {
    const live = this.#live.get(this.#key(userId, serverId));
    if (!live) return;
    this.#live.delete(this.#key(userId, serverId));
    await live.connection.close(reason).catch(() => undefined);
  }

  // -------------------------------------------------------------- catalog ---

  async #fetchCatalog(
    config: McpServerConfig,
    identity: string,
    connection: McpConnection,
    generation: number,
  ): Promise<McpCatalog> {
    const capabilities = connection.capabilities;
    const tools: RawTool[] = [];
    if (capabilities.tools) {
      const collected = await collectPages<unknown>({
        maxPages: 32,
        maxItems: config.limits.maxTools * 4,
        label: 'tools/list',
        fetchPage: async (cursor) => {
          const page = await connection.listToolsPage(cursor);
          return { items: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        },
      });
      if (collected.truncated) {
        throw new McpError(
          'MCP_SCHEMA_INVALID',
          `工具目录过大：${collected.reason ?? '超过分页上限'}。请缩小允许列表。`,
          400,
        );
      }
      for (const entry of collected.items) tools.push(toRawTool(entry));
    }

    const resources: RawResource[] = [];
    const resourceTemplates: RawResourceTemplate[] = [];
    if (capabilities.resources) {
      const list = await collectPages<unknown>({
        maxPages: 32,
        maxItems: 2_000,
        label: 'resources/list',
        fetchPage: async (cursor) => {
          const page = await connection.listResourcesPage(cursor);
          return { items: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        },
      });
      for (const entry of list.items) resources.push(toRawResource(entry));
      const templates = await collectPages<unknown>({
        maxPages: 32,
        maxItems: 2_000,
        label: 'resources/templates/list',
        fetchPage: async (cursor) => {
          const page = await connection.listResourceTemplatesPage(cursor);
          return {
            items: page.resourceTemplates,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        },
      });
      for (const entry of templates.items) resourceTemplates.push(toRawTemplate(entry));
    }

    const prompts: RawPrompt[] = [];
    if (capabilities.prompts) {
      const list = await collectPages<unknown>({
        maxPages: 32,
        maxItems: 500,
        label: 'prompts/list',
        fetchPage: async (cursor) => {
          const page = await connection.listPromptsPage(cursor);
          return { items: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        },
      });
      for (const entry of list.items) prompts.push(toRawPrompt(entry));
    }

    const raw: RawCatalog = {
      tools,
      resources,
      resourceTemplates,
      prompts,
      instructions: connection.instructions,
      capabilities,
      protocolRevision: connection.protocolRevision,
      serverInfo: connection.serverInfo,
    };

    const reserved = await this.#reservedModelNames(config.userId, config.id);
    const catalog = buildCatalog({
      config,
      identity,
      fetchedAt: this.#now(),
      raw,
      reservedModelNames: reserved,
    });
    // A generation that has been superseded may not publish.
    const live = this.#live.get(this.#key(config.userId, config.id));
    if (live && live.generation !== generation) {
      throw new McpError('MCP_CATALOG_STALE', '连接代次已经更新，旧的目录没有发布。', 409);
    }
    await this.#store.saveMcpCatalog(config.userId, catalog);
    return catalog;
  }

  async #reservedModelNames(userId: string, exceptServerId: string): Promise<Set<string>> {
    const reserved = new Set<string>();
    const records = await this.#store.listMcpServers(userId);
    for (const record of records) {
      if (record.config.id === exceptServerId) continue;
      const catalog = await this.#store.getMcpCatalog(userId, record.config.id);
      if (!catalog) continue;
      for (const tool of catalog.tools) {
        if (tool.enabled) reserved.add(tool.modelName);
      }
    }
    return reserved;
  }

  async catalog(userId: string, serverId: string): Promise<McpCatalog | null> {
    return this.#store.getMcpCatalog(userId, serverId);
  }

  /**
   * The catalog lease a turn is allowed to execute against.
   *
   * It is captured once per turn (the tool registry is built from it), and the
   * adapter passes it back on every call. A refresh during the turn publishes a
   * new revision; the old lease is refused rather than silently redirected.
   */
  async lease(userId: string, serverId: string): Promise<{ readonly connection: McpConnection; readonly catalog: McpCatalog }> {
    const live = this.#live.get(this.#key(userId, serverId));
    const catalog = await this.#store.getMcpCatalog(userId, serverId);
    if (!catalog) throw new McpError('MCP_CATALOG_STALE', '服务还没有可用的工具目录。', 409);
    if (!live || live.connection.closed) {
      const status = await this.connect(userId, serverId);
      const next = await this.#store.getMcpCatalog(userId, serverId);
      const nextLive = this.#live.get(this.#key(userId, serverId));
      if (!next || !nextLive) {
        throw new McpError(
          'MCP_CONNECT_FAILED',
          `服务没有连接成功（${status.lastError?.message ?? status.state}）。`,
          502,
        );
      }
      return { connection: nextLive.connection, catalog: next };
    }
    return { connection: live.connection, catalog };
  }

  /** Create the durable action row if the caller's id is not there yet. */
  async ensureAction(record: McpActionRecord): Promise<void> {
    const existing = await this.#store.getMcpAction(record.userId, record.id);
    if (existing) return;
    await this.#store.createMcpAction(record);
  }

  // -------------------------------------------------------------- calls ---

  async callTool(input: {
    readonly userId: string;
    readonly serverId: string;
    readonly originalName: string;
    readonly arguments: Record<string, unknown>;
    readonly catalogRevision: string;
    readonly contractHash: string;
    readonly actionId: string;
    readonly conversationId: string;
    readonly identity: string;
    readonly signal?: AbortSignal;
    readonly importImage?: (image: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array }) => Promise<{
      readonly assetId: string;
      readonly mediaType: string;
      readonly width: number;
      readonly height: number;
      readonly bytes: number;
      readonly name: string;
    }>;
    readonly importArtifact?: (artifact: { readonly mimeType: string; readonly bytes: Uint8Array }) => Promise<{
      readonly artifactId: string;
      readonly mimeType: string;
      readonly bytes: number;
    }>;
  }): Promise<MappedResult> {
    const record = await this.#store.getMcpServer(input.userId, input.serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    if (!record.config.enabled) throw new McpError('MCP_DISABLED', '这个服务没有启用', 409);

    const { connection, catalog } = await this.lease(input.userId, input.serverId);
    if (catalog.revision !== input.catalogRevision) {
      throw new McpError(
        'MCP_CATALOG_STALE',
        '工具目录在本次回合中发生了变化；为避免调用到不同契约，这次调用被拒绝。请重试。',
        409,
        { detail: { leased: input.catalogRevision, current: catalog.revision } },
      );
    }
    const entry = catalog.tools.find((tool) => tool.originalName === input.originalName);
    if (!entry || !entry.enabled) {
      throw new McpError('MCP_CATALOG_STALE', '这个工具已经不可用（被移除或禁用）。', 409);
    }
    if (entry.contractHash !== input.contractHash) {
      throw new McpError('MCP_CATALOG_STALE', '工具的 schema 与授权时不一致，已拒绝执行。', 409);
    }

    // The action row exists before the request leaves this process. A crash
    // after this point is "sent, unknown", never "never happened".
    await this.#store
      .updateMcpAction(input.userId, input.actionId, {
        state: 'sending',
        sentAt: this.#now().toISOString(),
      })
      .catch(() => undefined);

    let raw: RawCallResult;
    try {
      raw = await this.#callContext.run(
        {
          userId: input.userId,
          conversationId: input.conversationId,
          serverId: input.serverId,
        },
        () =>
          connection.callTool({
            name: entry.originalName,
            arguments: input.arguments,
            // No outputSchema: the host validates structuredContent itself so a
            // schema mismatch is a recorded failure, not an unknown transport
            // error after a call that did execute.
            toolDefinition: {
              name: entry.originalName,
              description: entry.description,
              inputSchema: entry.inputSchema,
            },
            ...(input.signal ? { signal: input.signal } : {}),
          }),
      );
    } catch (error) {
      const described = describeConnectionError(error);
      const cancelled = input.signal?.aborted === true;
      // A timeout or a dropped pipe after send is an unknown side effect, not a
      // failure: the remote may have executed it.
      const unknown = !cancelled;
      await this.#store
        .updateMcpAction(input.userId, input.actionId, {
          state: 'finished',
          conclusion: unknown ? 'unknown' : 'cancelled',
          error: { code: described.code, message: described.message },
          finishedAt: this.#now().toISOString(),
        })
        .catch(() => undefined);
      throw error;
    }

    const mapped = await mapCallResult({
      result: raw,
      limits: record.config.limits,
      redactor: MCP_REDACTOR,
      outputSchema: entry.outputSchema,
      ...(input.importImage ? { importImage: input.importImage } : {}),
      ...(input.importArtifact ? { importArtifact: input.importArtifact } : {}),
    });

    // R06: a browser screenshot may arrive as a file path instead of image
    // bytes. The adapter owns its own trust rules (allowlisted tool, configured
    // --output-dir, realpath containment, real decode); it never scans arbitrary
    // text. When the server already sent an image block, nothing is added.
    let result = mapped;
    const hasImage = (mapped.result.content ?? []).some((block) => block.type === 'image');
    if (!hasImage) {
      const browser = await readBrowserScreenshot({
        config: record.config,
        toolName: entry.originalName,
        result: raw,
        arguments: input.arguments,
        ...(input.importImage ? { importImage: input.importImage } : {}),
        actionId: input.actionId,
        connectionGeneration: this.#live.get(this.#key(input.userId, input.serverId))?.generation ?? null,
        ...(this.#browserOutput.maxBytes !== undefined
          ? { maxBytes: this.#browserOutput.maxBytes }
          : {}),
        ...(this.#browserOutput.cwd !== undefined ? { cwd: this.#browserOutput.cwd } : {}),
        ...(this.#browserOutput.fs !== undefined ? { fs: this.#browserOutput.fs } : {}),
      });
      if (browser.state !== 'not_applicable') result = applyBrowserOutput(mapped, browser);
    }

    await this.#store
      .updateMcpAction(input.userId, input.actionId, {
        state: raw.task ? 'running_task' : 'finished',
        conclusion: raw.isError ? 'failed' : 'succeeded',
        resultJson: JSON.stringify(safeResultRecord(result.result)),
        finishedAt: raw.task ? null : this.#now().toISOString(),
        ...(raw.isError
          ? { error: { code: 'MCP_REMOTE_FAILED', message: result.result.error ?? '远程工具返回失败' } }
          : {}),
      })
      .catch(() => undefined);

    if (raw.task) {
      const task: McpTaskRecord = {
        id: randomUUID(),
        userId: input.userId,
        conversationId: input.conversationId,
        serverId: input.serverId,
        actionId: input.actionId,
        remoteTaskId: raw.task.taskId,
        identity: input.identity,
        status: 'working',
        pollIntervalMs: raw.task.pollInterval ?? 2_000,
        ttlMs: raw.task.ttl ?? null,
        deadlineAt:
          typeof raw.task.ttl === 'number'
            ? new Date(this.#now().getTime() + raw.task.ttl).toISOString()
            : null,
        lastCheckedAt: null,
        resultJson: null,
        error: null,
        createdAt: this.#now().toISOString(),
      };
      await this.#store.createMcpTask(task).catch(() => undefined);
    }

    return result;
  }

  // ------------------------------------------------------------- resources ---

  async readResource(userId: string, serverId: string, uri: string): Promise<{
    readonly contents: readonly {
      readonly uri: string;
      readonly mimeType: string | null;
      readonly text: string | null;
      readonly blob: Uint8Array | null;
    }[];
    readonly ttlMs?: number;
  }> {
    const { connection, catalog } = await this.lease(userId, serverId);
    const record = await this.#store.getMcpServer(userId, serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    if (!visibleResource(catalog, uri)) {
      throw new McpError('MCP_NOT_FOUND', '这个资源不在当前可见目录里。', 404);
    }
    return connection.readResource(uri);
  }

  async listResources(userId: string, serverId: string): Promise<McpCatalog> {
    const catalog = await this.#store.getMcpCatalog(userId, serverId);
    if (!catalog) throw new McpError('MCP_CATALOG_STALE', '服务还没有可用的目录。', 409);
    return catalog;
  }

  async getPrompt(
    userId: string,
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<{ readonly description: string | null; readonly messages: readonly { readonly role: string; readonly content: unknown }[] }> {
    const { connection, catalog } = await this.lease(userId, serverId);
    if (!catalog.prompts.some((prompt) => prompt.name === name)) {
      throw new McpError('MCP_NOT_FOUND', '这个提示词不在当前可见目录里。', 404);
    }
    // Arguments are schema-checked against the declared prompt, not free text
    // passed to the server.
    const prompt = catalog.prompts.find((entry) => entry.name === name);
    for (const argument of prompt?.arguments ?? []) {
      if (argument.required && (args[argument.name] ?? '').length === 0) {
        throw new McpError(
          'MCP_CONFIG_INVALID',
          `提示词参数 ${argument.name} 是必填的。`,
          400,
        );
      }
    }
    return connection.getPrompt(name, args);
  }

  async complete(
    userId: string,
    serverId: string,
    input: {
      readonly type: 'prompt' | 'resource';
      readonly name: string;
      readonly argument: { readonly name: string; readonly value: string };
    },
  ): Promise<{ readonly values: readonly string[]; readonly total?: number; readonly hasMore?: boolean }> {
    const { connection, catalog } = await this.lease(userId, serverId);
    const ref =
      input.type === 'prompt'
        ? ({ type: 'ref/prompt', name: input.name } as const)
        : ({ type: 'ref/resource', uri: input.name } as const);
    if (input.type === 'prompt' && !catalog.prompts.some((prompt) => prompt.name === input.name)) {
      throw new McpError('MCP_NOT_FOUND', '这个提示词不在当前可见目录里。', 404);
    }
    return connection.complete({ ref, argument: input.argument });
  }

  async subscribeResource(userId: string, serverId: string, uri: string): Promise<void> {
    const { connection, catalog } = await this.lease(userId, serverId);
    if (!visibleResource(catalog, uri)) {
      throw new McpError('MCP_NOT_FOUND', '这个资源不在当前可见目录里。', 404);
    }
    await connection.subscribeResource(uri);
  }

  // ----------------------------------------------------------------- tasks ---

  async getTask(userId: string, taskId: string): Promise<McpTaskRecord> {
    const task = await this.#store.getMcpTask(userId, taskId);
    if (!task) throw new McpError('MCP_NOT_FOUND', '没有这个任务句柄', 404);
    const { connection } = await this.lease(userId, task.serverId);
    try {
      const remote = await connection.getTask(task.remoteTaskId);
      const status = typeof remote.status === 'string' ? remote.status : task.status;
      const mapped = mapRemoteTaskStatus(status);
      await this.#store.updateMcpTask(userId, taskId, {
        status: mapped,
        lastCheckedAt: this.#now().toISOString(),
      });
      return (await this.#store.getMcpTask(userId, taskId)) ?? task;
    } catch (error) {
      const described = describeConnectionError(error);
      await this.#store.updateMcpTask(userId, taskId, {
        status: described.code === 'MCP_TASK_UNAVAILABLE' ? 'unknown' : task.status,
        error: { code: described.code, message: described.message },
        lastCheckedAt: this.#now().toISOString(),
      });
      return (await this.#store.getMcpTask(userId, taskId)) ?? task;
    }
  }

  async cancelTask(userId: string, taskId: string): Promise<McpTaskRecord> {
    const task = await this.#store.getMcpTask(userId, taskId);
    if (!task) throw new McpError('MCP_NOT_FOUND', '没有这个任务句柄', 404);
    const { connection } = await this.lease(userId, task.serverId);
    try {
      await connection.cancelTask(task.remoteTaskId);
      // A cancel acknowledgement is an intent delivered, not proof the remote
      // stopped. The status stays "cancelled" only after a terminal read.
      await this.#store.updateMcpTask(userId, taskId, {
        lastCheckedAt: this.#now().toISOString(),
        error: {
          code: 'MCP_UNKNOWN_RESULT',
          message: '取消请求已送达；远端终态尚未确认。',
        },
      });
      return (await this.#store.getMcpTask(userId, taskId)) ?? task;
    } catch (error) {
      const described = describeConnectionError(error);
      await this.#store.updateMcpTask(userId, taskId, {
        error: { code: described.code, message: described.message },
        lastCheckedAt: this.#now().toISOString(),
      });
      return (await this.#store.getMcpTask(userId, taskId)) ?? task;
    }
  }

  // -------------------------------------------------------------- internal ---

  #identityOf(config: McpServerConfig): string {
    if (config.transport === 'stdio') {
      return [
        'stdio',
        config.stdio?.runLocation ?? 'sandbox',
        config.stdio?.image ?? '',
        config.stdio?.command ?? '',
        (config.stdio?.args ?? []).join(' '),
      ].join('|');
    }
    const auth = config.http?.auth ?? 'none';
    if (auth === 'oauth') return `oauth|${config.http?.url ?? ''}`;
    if (auth === 'bearer') return `bearer|${config.http?.url ?? ''}|${config.http?.bearerRef ?? ''}`;
    if (auth === 'header') {
      return `header|${config.http?.url ?? ''}|${Object.keys(config.http?.headerRefs ?? {}).join(',')}`;
    }
    return `anon|${config.http?.url ?? ''}`;
  }

  #authState(config: McpServerConfig, identity: string, expiresAt: string | null): McpAuthState {
    if (config.transport !== 'http') {
      return { mode: 'none', state: 'none', account: null, scope: null, expiresAt: null };
    }
    const mode = config.http?.auth ?? 'none';
    return {
      mode,
      state: mode === 'oauth' ? 'ok' : mode === 'none' ? 'none' : 'ok',
      account: mode === 'oauth' ? identity.split('|').slice(1).join('|') || null : null,
      scope: null,
      expiresAt: mode === 'oauth' ? expiresAt : null,
    };
  }

  async #oauthProvider(
    config: McpServerConfig,
    identity: string,
  ): Promise<import('@modelcontextprotocol/client').OAuthClientProvider | undefined> {
    if (config.http?.auth !== 'oauth') return undefined;
    const { createOAuthProvider } = await import('./auth.ts');
    return createOAuthProvider({
      config,
      vault: this.#vault,
      identity,
      onAuthorizationUrl: (url, state, transport) => {
        this.#pendingAuth.set(state, {
          userId: config.userId,
          serverId: config.id,
          state,
          transport,
          redirectUrl: url,
          createdAt: this.#now().getTime(),
        });
        // Keep the map bounded: an abandoned login must not leak for a day.
        for (const [key, entry] of this.#pendingAuth) {
          if (this.#now().getTime() - entry.createdAt > 15 * 60_000) this.#pendingAuth.delete(key);
        }
      },
    });
  }

  #latestAuthFor(userId: string, serverId: string): PendingAuth | null {
    let latest: PendingAuth | null = null;
    for (const entry of this.#pendingAuth.values()) {
      if (entry.userId !== userId || entry.serverId !== serverId) continue;
      if (!latest || entry.createdAt > latest.createdAt) latest = entry;
    }
    return latest;
  }

  /** The pending authorization URL, for the management UI. */
  async authorizationUrl(userId: string, serverId: string): Promise<string | null> {
    return this.#latestAuthFor(userId, serverId)?.redirectUrl ?? null;
  }

  async beginAuth(userId: string, serverId: string): Promise<string> {
    const status = await this.connect(userId, serverId);
    if (status.state === 'auth_required') {
      const pending = this.#latestAuthFor(userId, serverId);
      if (pending) return pending.redirectUrl;
      throw new McpError(
        'MCP_AUTH_REQUIRED',
        '服务要求登录，但这次连接没有返回授权地址；请检查 OAuth 客户端配置。',
        409,
      );
    }
    if (status.state === 'ready') {
      throw new McpError('MCP_AUTH_REQUIRED', '这个服务已经授权，不需要重新登录。', 409);
    }
    throw new McpError(
      'MCP_CONNECT_FAILED',
      `登录前连接失败：${status.lastError?.message ?? status.state}`,
      502,
    );
  }

  /**
   * Complete an authorization callback.
   *
   * The state is one-shot and server-bound: the flow map is keyed by the state
   * the provider generated, so a callback for another server or a replayed state
   * cannot exchange a code.
   */
  async finishAuth(input: {
    readonly userId: string;
    readonly serverId: string;
    readonly state: string;
    readonly code: string;
  }): Promise<McpServerStatus> {
    const pending = this.#pendingAuth.get(input.state);
    if (!pending || pending.userId !== input.userId || pending.serverId !== input.serverId) {
      throw new McpError(
        'MCP_AUTH_REQUIRED',
        'OAuth 回调状态无效或已过期；请重新发起登录。',
        400,
      );
    }
    this.#pendingAuth.delete(input.state);
    const transport = pending.transport as { finishAuth?: (code: string) => Promise<void> };
    if (typeof transport.finishAuth !== 'function') {
      throw new McpError('MCP_UNSUPPORTED', '当前传输不支持完成授权。', 500);
    }
    await transport.finishAuth(input.code);
    return this.connect(input.userId, input.serverId);
  }

  async logout(userId: string, serverId: string): Promise<void> {
    await this.#closeLive(userId, serverId, 'logout');
    await this.#vault.delete(userId, serverId);
    const record = await this.#store.getMcpServer(userId, serverId);
    if (record?.config.http?.auth === 'oauth') {
      await this.#setStatus(userId, serverId, {
        state: 'auth_required',
        auth: { mode: 'oauth', state: 'needs_login', account: null, scope: null, expiresAt: null },
      });
    }
  }

  async #handleElicit(
    userId: string,
    serverId: string,
    request: ElicitationRequest,
  ): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> {
    if (!this.#onElicit) {
      return { action: 'decline' };
    }
    const context = this.#callContext.getStore();
    return this.#onElicit({
      userId,
      serverId,
      conversationId:
        context && context.userId === userId && context.serverId === serverId
          ? context.conversationId
          : null,
      request,
    });
  }

  #scheduleRetry(userId: string, config: McpServerConfig, attempt: number): void {
    if (this.#shuttingDown || attempt > MAX_CONNECT_ATTEMPTS) return;
    const key = this.#key(userId, config.id);
    this.#clearRetry(userId, config.id);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    const nextAt = new Date(this.#now().getTime() + delay + jitter);
    const timer = setTimeout(() => {
      const current = this.#retry.get(key);
      if (current) current.timer = null;
      void (async () => {
        const record = await this.#store.getMcpServer(userId, config.id).catch(() => null);
        if (!record?.config.enabled || this.#shuttingDown) return;
        const status = await this.connect(userId, config.id).catch(() => null);
        if (status && status.state !== 'ready' && status.state !== 'auth_required') {
          this.#scheduleRetry(userId, config, attempt + 1);
        }
      })();
    }, delay + jitter);
    timer.unref();
    this.#retry.set(key, { attempts: attempt, timer, nextAt });
    const scheduled = this.#statuses.get(key)?.state ?? 'reconnecting';
    void this.#setStatus(userId, config.id, {
      state: scheduled === 'ready' ? 'reconnecting' : scheduled,
      nextRetryAt: nextAt.toISOString(),
    });
  }

  #clearRetry(userId: string, serverId: string): void {
    const key = this.#key(userId, serverId);
    const current = this.#retry.get(key);
    if (current?.timer) clearTimeout(current.timer);
    this.#retry.delete(key);
  }

  /** Reconnect every enabled server on start. Never replays a tool call. */
  async startAll(userId: string): Promise<void> {
    const records = await this.#store.listMcpServers(userId);
    await Promise.all(
      records
        .filter((record) => record.config.enabled)
        .map((record) => this.connect(userId, record.config.id).catch(() => undefined)),
    );
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const key of [...this.#retry.keys()]) {
      const [userId, serverId] = key.split('\u0000') as [string, string];
      this.#clearRetry(userId, serverId);
    }
    await Promise.all(
      [...this.#live.values()].map((live) => live.connection.close('shutdown').catch(() => undefined)),
    );
    this.#live.clear();
  }
}

// ------------------------------------------------------------- adapters ---

function toRawTool(entry: unknown): RawTool {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : '',
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    inputSchema: record.inputSchema ?? { type: 'object', properties: {} },
    ...(record.outputSchema !== undefined ? { outputSchema: record.outputSchema } : {}),
    ...(record.annotations !== undefined
      ? { annotations: record.annotations as RawTool['annotations'] }
      : {}),
  };
}

function toRawResource(entry: unknown): RawResource {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    uri: typeof record.uri === 'string' ? record.uri : '',
    name: typeof record.name === 'string' ? record.name : String(record.uri ?? ''),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
  };
}

function toRawTemplate(entry: unknown): RawResourceTemplate {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    uriTemplate: typeof record.uriTemplate === 'string' ? record.uriTemplate : '',
    name: typeof record.name === 'string' ? record.name : 'template',
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
  };
}

function toRawPrompt(entry: unknown): RawPrompt {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : '',
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(Array.isArray(record.arguments)
      ? {
          arguments: record.arguments.map((argument) => {
            const item = (argument ?? {}) as Record<string, unknown>;
            return {
              name: typeof item.name === 'string' ? item.name : '',
              ...(typeof item.description === 'string' ? { description: item.description } : {}),
              required: item.required === true,
            };
          }),
        }
      : {}),
  };
}

function toView(
  config: McpServerConfig,
  status: McpServerStatus,
  catalog: McpCatalog | null,
): McpServerView {
  const tools: McpToolView[] = (catalog?.tools ?? []).map((tool) => ({
    originalName: tool.originalName,
    modelName: tool.modelName,
    description: tool.description,
    classification: tool.classification,
    enabled: tool.enabled,
    readOnlyHint: tool.annotations.readOnlyHint,
    destructiveHint: tool.annotations.destructiveHint,
    idempotentHint: tool.annotations.idempotentHint,
    contractHash: tool.contractHash,
  }));
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    required: config.required,
    transport: config.transport,
    endpoint: describeEndpointOf(config),
    runLocation: config.stdio?.runLocation ?? null,
    auth: config.http?.auth ?? 'none',
    configRevision: config.configRevision,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    status,
    toolCount: tools.filter((tool) => tool.enabled).length,
    policy: config.toolPolicy,
    timeouts: config.timeouts ?? DEFAULT_MCP_TIMEOUTS,
    limits: config.limits,
    tools,
    editable: {
      ...(config.http
        ? {
            http: {
              url: config.http.url,
              auth: config.http.auth,
              ...(config.http.bearerRef ? { bearerRef: config.http.bearerRef } : {}),
              ...(config.http.headerRefs ? { headerRefs: config.http.headerRefs } : {}),
              ...(config.http.allowPrivateNetwork !== undefined
                ? { allowPrivateNetwork: config.http.allowPrivateNetwork }
                : {}),
              ...(config.http.allowInsecure !== undefined
                ? { allowInsecure: config.http.allowInsecure }
                : {}),
            },
          }
        : {}),
      ...(config.stdio
        ? {
            stdio: {
              command: config.stdio.command,
              args: config.stdio.args,
              ...(config.stdio.cwd ? { cwd: config.stdio.cwd } : {}),
              runLocation: config.stdio.runLocation,
              ...(config.stdio.image ? { image: config.stdio.image } : {}),
              ...(config.stdio.envRefs ? { envRefs: config.stdio.envRefs } : {}),
            },
          }
        : {}),
    },
  };
}

function describeEndpointOf(config: McpServerConfig): string | null {
  if (config.transport === 'http') return config.http?.url ?? null;
  return [config.stdio?.command ?? '', ...(config.stdio?.args ?? [])].join(' ').trim() || null;
}

function visibleResource(catalog: McpCatalog, uri: string): boolean {
  if (catalog.resources.some((resource) => resource.uri === uri)) return true;
  // A URI produced by a visible template is allowed. The check is deliberately
  // structural: the template's scheme and authority must match, and the URI must
  // be at least as specific as the template.
  return catalog.resourceTemplates.some((template) => {
    const prefix = template.uriTemplate.split('{')[0] ?? '';
    return prefix.length > 0 && uri.startsWith(prefix);
  });
}

function mapRemoteTaskStatus(status: string): McpTaskRecord['status'] {
  switch (status) {
    case 'working':
    case 'input_required':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'expired':
      return status;
    default:
      return 'unknown';
  }
}

function safeResultRecord(result: { readonly output: string; readonly ok: boolean }): Record<string, unknown> {
  // The full private record is deliberately not persisted here: the model
  // transcript already stores the exact sent bytes, and duplicating base64 into
  // the action table would double the storage of every image result.
  return { ok: result.ok, outputChars: result.output.length };
}

export type { McpErrorDescription, McpLimits };
