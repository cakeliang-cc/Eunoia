/**
 * The MCP product service: one orchestration point for the API, the chat turn
 * and the management UI.
 *
 * It owns the composition of things that are individually simple — config
 * validation, the connection manager, the interaction broker, private media and
 * artifacts — so the HTTP layer stays a transport and the chat layer stays a
 * turn. In particular, no route and no tool constructs a connection or an
 * approval by itself.
 *
 * See docs/adr/033-mcp-host.md §14.
 */

import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.ts';
import type { ToolMediaPort } from '../tools/types.ts';
import type { MediaService } from '../media/service.ts';
import type { McpArtifactService } from './artifacts.ts';
import {
  configParseOptionsFromEnv,
  describeEndpoint,
  parseServerInput,
  previewMcpServersImport,
  type ConfigParseOptions,
  type ImportPreview,
  type ServerInput,
} from './config.ts';
import type { McpClientManager } from './manager.ts';
import type { InteractionBroker } from './interactions.ts';
import type { McpStore } from './store.ts';
import type { McpCredentialVault } from './credentials.ts';
import { McpPermissionPort } from './permissions.ts';
import type { ToolPermissionPort } from '../tools/types.ts';
import { MCP_REDACTOR } from './credentials.ts';
import { buildMcpTools, mcpGuidelines } from './tool-adapter.ts';
import type {
  McpActionRecord,
  McpCatalog,
  McpInteractionRecord,
  McpPromptEntry,
  McpResourceEntry,
  McpResourceTemplateEntry,
  McpServerConfig,
  McpServerStatus,
  McpServerView,
  McpTaskRecord,
  McpToolView,
} from './types.ts';
import { McpError } from './types.ts';

export interface McpServiceDeps {
  readonly store: McpStore;
  readonly manager: McpClientManager;
  readonly broker: InteractionBroker;
  readonly vault: McpCredentialVault;
  readonly media: MediaService | null;
  readonly artifacts: McpArtifactService | null;
  readonly now?: () => Date;
  /** Deployment switches; injectable so tests do not depend on the ambient env. */
  readonly parseOptions?: (userId: string) => ConfigParseOptions;
}

export interface McpTurnTools {
  readonly tools: readonly ToolDefinition[];
  readonly guidelines: string;
  readonly catalogs: readonly { readonly config: McpServerConfig; readonly catalog: McpCatalog }[];
  readonly diagnostics: readonly string[];
}

export class McpService {
  readonly #store: McpStore;
  readonly #manager: McpClientManager;
  readonly #broker: InteractionBroker;
  readonly #vault: McpCredentialVault;
  readonly #media: MediaService | null;
  readonly #artifacts: McpArtifactService | null;
  readonly #now: () => Date;
  readonly #parseOptions: (userId: string) => ConfigParseOptions;
  readonly #permission: McpPermissionPort;

  constructor(deps: McpServiceDeps) {
    this.#store = deps.store;
    this.#manager = deps.manager;
    this.#broker = deps.broker;
    this.#vault = deps.vault;
    this.#media = deps.media;
    this.#artifacts = deps.artifacts;
    this.#now = deps.now ?? (() => new Date());
    this.#parseOptions = deps.parseOptions ?? ((userId) => configParseOptionsFromEnv(userId));
    this.#permission = new McpPermissionPort({
      store: deps.store,
      broker: deps.broker,
      now: this.#now,
      describeEndpoint,
    });
  }

  /** The loop's authorization port for external calls. */
  permissionPort(): ToolPermissionPort {
    return this.#permission;
  }

  get manager(): McpClientManager {
    return this.#manager;
  }

  get broker(): InteractionBroker {
    return this.#broker;
  }

  // ------------------------------------------------------------- servers ---

  async listServers(userId: string): Promise<McpServerView[]> {
    return this.#manager.listServers(userId);
  }

  async getServer(userId: string, serverId: string): Promise<McpServerView> {
    return this.#manager.getServer(userId, serverId);
  }

  async createServer(userId: string, raw: ServerInput): Promise<McpServerView> {
    const existing = await this.#store.listMcpServers(userId);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (existing.some((record) => record.config.name === name)) {
      throw new McpError('MCP_CONFIG_INVALID', `已经有一个名为「${name}」的服务。`, 409);
    }
    const parsed = parseServerInput(raw, this.#parseOptions(userId));
    await this.#manager.insertServer(parsed.config);
    return this.#manager.getServer(userId, parsed.config.id);
  }

  async updateServer(
    userId: string,
    serverId: string,
    raw: ServerInput,
  ): Promise<McpServerView> {
    const current = await this.#store.getMcpServer(userId, serverId);
    if (!current) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    if (!Number.isInteger(raw.configRevision as number)) {
      throw new McpError(
        'MCP_CONFIG_INVALID',
        '更新配置必须带上 configRevision（乐观锁）。',
        400,
      );
    }
    const expected = raw.configRevision as number;
    const parsed = parseServerInput(
      { ...raw, id: serverId },
      this.#parseOptions(userId),
    );
    const updated = await this.#manager.updateServer(
      userId,
      serverId,
      {
        name: parsed.config.name,
        enabled: parsed.config.enabled,
        required: parsed.config.required,
        transport: parsed.config.transport,
        ...(parsed.config.http ? { http: parsed.config.http } : {}),
        ...(parsed.config.stdio ? { stdio: parsed.config.stdio } : {}),
        timeouts: parsed.config.timeouts,
        limits: parsed.config.limits,
        toolPolicy: parsed.config.toolPolicy,
      },
      expected,
    );
    return this.#manager.getServer(userId, updated.id);
  }

  async deleteServer(userId: string, serverId: string): Promise<void> {
    await this.#manager.deleteServer(userId, serverId);
  }

  async previewImport(userId: string, raw: unknown): Promise<ImportPreview> {
    return previewMcpServersImport(raw, this.#parseOptions(userId));
  }

  async connect(userId: string, serverId: string): Promise<McpServerStatus> {
    return this.#manager.connect(userId, serverId);
  }

  async disconnect(userId: string, serverId: string): Promise<void> {
    await this.#manager.disconnect(userId, serverId);
  }

  async refresh(userId: string, serverId: string): Promise<McpServerStatus> {
    return this.#manager.refresh(userId, serverId);
  }

  async status(userId: string, serverId: string): Promise<McpServerStatus> {
    return this.#manager.status(userId, serverId);
  }

  async authorizationUrl(userId: string, serverId: string): Promise<string | null> {
    return this.#manager.authorizationUrl(userId, serverId);
  }

  async beginAuth(userId: string, serverId: string): Promise<{ readonly url: string }> {
    const url = await this.#manager.beginAuth(userId, serverId);
    return { url };
  }

  async finishAuth(input: {
    readonly userId: string;
    readonly serverId: string;
    readonly state: string;
    readonly code: string;
  }): Promise<McpServerStatus> {
    return this.#manager.finishAuth(input);
  }

  async logout(userId: string, serverId: string): Promise<void> {
    await this.#manager.logout(userId, serverId);
  }

  // ----------------------------------------------------------- bindings ---

  async conversationServers(userId: string, conversationId: string): Promise<string[]> {
    const bindings = await this.#store.listConversationServers(userId, conversationId);
    return bindings.filter((binding) => binding.enabled).map((binding) => binding.serverId);
  }

  async setConversationServers(
    userId: string,
    conversationId: string,
    serverIds: readonly string[],
  ): Promise<string[]> {
    // Only servers this owner can see may be bound; a request naming somebody
    // else's id fails rather than silently binding nothing.
    const owned = new Set((await this.#store.listMcpServers(userId)).map((record) => record.config.id));
    for (const id of serverIds) {
      if (!owned.has(id)) throw new McpError('MCP_NOT_FOUND', '没有这个 MCP 服务', 404);
    }
    await this.#store.setConversationServers(userId, conversationId, serverIds, this.#now());
    return [...new Set(serverIds)];
  }

  // --------------------------------------------------------------- tools ---

  /**
   * The tools one turn may use.
   *
   * A required server that cannot connect is a hard error; an optional one is
   * skipped with a diagnostic. Both outcomes are visible to the caller — a
   * server that is not connected is never described as available.
   */
  async toolsForTurn(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly signal?: AbortSignal;
  }): Promise<McpTurnTools> {
    const records = await this.#store.listMcpServers(input.userId);
    if (records.length === 0) {
      return { tools: [], guidelines: '', catalogs: [], diagnostics: [] };
    }
    const bound = await this.conversationServers(input.userId, input.conversationId);
    const selected =
      bound.length > 0
        ? records.filter((record) => bound.includes(record.config.id))
        : records.filter((record) => record.config.enabled);

    const diagnostics: string[] = [];
    const catalogs: { config: McpServerConfig; catalog: McpCatalog }[] = [];
    const mediaPort = this.#mediaPort();

    for (const record of selected) {
      const { config } = record;
      if (!config.enabled) continue;
      let status: McpServerStatus;
      try {
        status = await this.#manager.status(input.userId, config.id);
        if (status.state !== 'ready') {
          status = await this.#manager.connect(input.userId, config.id);
        }
      } catch (error) {
        status = await this.#manager.status(input.userId, config.id).catch(() => ({
          state: 'failed',
        })) as McpServerStatus;
        void error;
      }
      if (status.state !== 'ready') {
        const reason = status.lastError?.message ?? status.state;
        if (config.required) {
          throw new McpError(
            'MCP_CONNECT_FAILED',
            `必需的外部服务「${config.name}」不可用：${reason}`,
            502,
            { detail: { serverId: config.id, state: status.state } },
          );
        }
        diagnostics.push(`外部服务「${config.name}」当前不可用（${reason}），本轮没有它的工具。`);
        continue;
      }
      const catalog = await this.#store.getMcpCatalog(input.userId, config.id);
      if (!catalog) {
        diagnostics.push(`外部服务「${config.name}」还没有工具目录，本轮没有它的工具。`);
        continue;
      }
      catalogs.push({ config, catalog });
    }

    const tools: ToolDefinition[] = [];
    for (const { config, catalog } of catalogs) {
      try {
        tools.push(
          ...buildMcpTools({
            manager: this.#manager,
            config,
            catalog,
            media: mediaPort,
            artifacts: this.#artifacts,
            now: this.#now,
          }),
        );
      } catch (error) {
        diagnostics.push(
          `外部服务「${config.name}」的工具没有加载：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      tools,
      guidelines: mcpGuidelines(catalogs),
      catalogs,
      diagnostics,
    };
  }

  /** The settings surface's per-tool availability, across servers. */
  async tools(userId: string, serverId: string): Promise<readonly McpToolView[]> {
    const view = await this.#manager.getServer(userId, serverId);
    return view.tools;
  }

  // --------------------------------------------------------- interactions ---

  async listInteractions(
    userId: string,
    conversationId: string,
  ): Promise<McpInteractionRecord[]> {
    return this.#broker.listPending(userId, conversationId);
  }

  async resolveInteraction(input: {
    readonly userId: string;
    readonly interactionId: string;
    readonly action: 'accept' | 'reject' | 'cancel';
    readonly response?: unknown;
  }): Promise<McpInteractionRecord | null> {
    const status =
      input.action === 'accept' ? 'accepted' : input.action === 'reject' ? 'rejected' : 'cancelled';
    const record = await this.#broker.resolve({
      userId: input.userId,
      interactionId: input.interactionId,
      status,
      ...(input.response !== undefined ? { response: input.response } : {}),
    });
    if (record?.kind === 'approval' && record.actionId) {
      if (status === 'accepted') {
        // The action stays waiting; an explicit resume (or the live waiter)
        // executes it. Marking it "sending" here would claim a request that has
        // not been made.
      } else {
        await this.#store
          .updateMcpAction(input.userId, record.actionId, {
            state: 'finished',
            conclusion: status === 'rejected' ? 'cancelled' : 'cancelled',
            finishedAt: this.#now().toISOString(),
            error: {
              code: status === 'rejected' ? 'MCP_PERMISSION_DENIED' : 'MCP_INTERACTION_CANCELLED',
              message: status === 'rejected' ? '用户拒绝了这次调用' : '用户取消了这次调用',
            },
          })
          .catch(() => undefined);
      }
    }
    return record;
  }

  /**
   * Execute an action that was approved while no live turn was waiting.
   *
   * This is the restart path. It runs the *original* persisted action — it does
   * not ask the model to produce the call again — and refuses when the action is
   * no longer the one that was approved.
   */
  async resumeAction(input: {
    readonly userId: string;
    readonly actionId: string;
    readonly conversationId: string;
  }): Promise<{ readonly ok: boolean; readonly output: string; readonly action: McpActionRecord }> {
    const action = await this.#store.getMcpAction(input.userId, input.actionId);
    if (!action) throw new McpError('MCP_NOT_FOUND', '没有这个外部调用记录', 404);
    if (action.conversationId !== input.conversationId) {
      throw new McpError('MCP_NOT_FOUND', '没有这个外部调用记录', 404);
    }
    if (action.state === 'finished') {
      return {
        ok: action.conclusion === 'succeeded',
        output: `这次调用已经结束（${action.conclusion ?? 'unknown'}），不会重复执行。`,
        action,
      };
    }
    if (action.state !== 'waiting_approval' && action.state !== 'prepared') {
      throw new McpError(
        'MCP_APPROVAL_REQUIRED',
        `这次调用状态是 ${action.state}，不能在这里恢复。`,
        409,
      );
    }
    const interactions = await this.#store.listMcpInteractions(input.userId, action.conversationId);
    const approved = interactions.find(
      (interaction) =>
        interaction.actionId === action.id && interaction.status === 'accepted',
    );
    if (!approved) {
      throw new McpError('MCP_APPROVAL_REQUIRED', '这次调用还没有被批准。', 409);
    }
    const record = await this.#store.getMcpServer(input.userId, action.serverId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '这个外部服务已经被删除。', 404);
    const catalog = await this.#store.getMcpCatalog(input.userId, action.serverId);
    if (!catalog) throw new McpError('MCP_CATALOG_STALE', '工具目录已经不存在。', 409);
    if (catalog.revision !== action.catalogRevision) {
      throw new McpError(
        'MCP_CATALOG_STALE',
        '工具目录在这次批准之后发生了变化；原授权已失效，请重新发起。',
        409,
      );
    }
    const entry = catalog.tools.find(
      (tool) => tool.originalName === action.toolName && tool.contractHash === action.contractHash,
    );
    if (!entry) {
      throw new McpError('MCP_CATALOG_STALE', '这个工具或它的契约已经改变，原授权已失效。', 409);
    }
    const tools = buildMcpTools({
      manager: this.#manager,
      config: record.config,
      catalog,
      media: this.#mediaPort(),
      artifacts: this.#artifacts,
      now: this.#now,
    });
    const tool = tools.find((candidate) => candidate.name === entry.modelName);
    if (!tool) throw new McpError('MCP_CATALOG_STALE', '这个工具已经不可用。', 409);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(action.argumentsJson) as Record<string, unknown>;
    } catch {
      throw new McpError('MCP_CONFIG_INVALID', '原始参数无法解析；不能执行。', 409);
    }
    const result = await tool.execute(args, {
      workspace: null,
      policy: {
        allowWorkspaceWrites: false,
        allowCommands: false,
        maxOutputChars: record.config.limits.maxTextChars,
      },
      ledger: {
        check: () => null,
        record: () => undefined,
        has: () => false,
        hasComplete: () => false,
      },
      now: this.#now(),
      userId: input.userId,
      conversationId: input.conversationId,
      actionId: action.id,
      toolCallId: action.callId,
    });
    const latest = (await this.#store.getMcpAction(input.userId, action.id)) ?? action;
    return { ok: result.ok, output: result.output, action: latest };
  }

  async listActions(
    userId: string,
    conversationId: string,
  ): Promise<McpActionRecord[]> {
    return this.#store.listMcpActions(userId, { conversationId, limit: 100 });
  }

  async getAction(userId: string, actionId: string): Promise<McpActionRecord | null> {
    return this.#store.getMcpAction(userId, actionId);
  }

  // ------------------------------------------------------ resources/prompts ---

  async listResources(
    userId: string,
    serverId: string,
  ): Promise<{
    readonly resources: readonly McpResourceEntry[];
    readonly templates: readonly McpResourceTemplateEntry[];
    readonly revision: string;
    readonly invalidated: boolean;
  }> {
    const catalog = await this.#manager.catalog(userId, serverId);
    if (!catalog) throw new McpError('MCP_CATALOG_STALE', '服务还没有可用的目录。', 409);
    return {
      resources: catalog.resources,
      templates: catalog.resourceTemplates,
      revision: catalog.revision,
      invalidated: catalog.invalidatedAt !== null,
    };
  }

  async readResource(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly serverId: string;
    readonly uri: string;
    readonly select?: boolean;
  }): Promise<{
    readonly uri: string;
    readonly mimeType: string | null;
    readonly text: string | null;
    readonly bytes: number;
    readonly selected: boolean;
    readonly snapshotId: string | null;
    readonly revision: string;
  }> {
    const read = await this.#manager.readResource(input.userId, input.serverId, input.uri);
    const first = read.contents[0];
    if (!first) throw new McpError('MCP_REMOTE_FAILED', '服务没有返回资源内容。', 502);
    const catalog = await this.#manager.catalog(input.userId, input.serverId);
    const text = first.text !== null ? MCP_REDACTOR.redact(first.text) : null;
    const bytes = first.blob?.length ?? (text !== null ? Buffer.byteLength(text, 'utf8') : 0);
    let snapshotId: string | null = null;
    if (input.select) {
      // The selection is a snapshot: the conversation keeps the content the
      // person saw even after the server says the resource changed.
      snapshotId = randomUUID();
      await this.#store.saveMcpResourceSnapshot({
        id: snapshotId,
        userId: input.userId,
        conversationId: input.conversationId,
        serverId: input.serverId,
        uri: input.uri,
        identity: catalog?.identity ?? 'unknown',
        mimeType: first.mimeType,
        text,
        blobKey: null,
        bytes,
        sha256: (await import('../tools/contract.ts')).sha256(
          text ?? Buffer.from(first.blob ?? new Uint8Array()).toString('base64'),
        ),
        fetchedAt: this.#now().toISOString(),
        expiresAt: null,
        invalidatedAt: null,
      });
    }
    return {
      uri: first.uri,
      mimeType: first.mimeType,
      text,
      bytes,
      selected: input.select === true,
      snapshotId,
      revision: catalog?.revision ?? '',
    };
  }

  async selectedResources(
    userId: string,
    conversationId: string,
  ): Promise<readonly { readonly serverId: string; readonly uri: string; readonly text: string | null }[]> {
    const snapshots = await this.#store.listMcpResourceSnapshots(userId, conversationId);
    return snapshots.map((snapshot) => ({
      serverId: snapshot.serverId,
      uri: snapshot.uri,
      text: snapshot.text,
    }));
  }

  async listPrompts(
    userId: string,
    serverId: string,
  ): Promise<{ readonly prompts: readonly McpPromptEntry[]; readonly revision: string }> {
    const catalog = await this.#manager.catalog(userId, serverId);
    if (!catalog) throw new McpError('MCP_CATALOG_STALE', '服务还没有可用的目录。', 409);
    return { prompts: catalog.prompts, revision: catalog.revision };
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
    return this.#manager.complete(userId, serverId, input);
  }

  async getPrompt(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly serverId: string;
    readonly name: string;
    readonly arguments: Record<string, string>;
  }): Promise<{
    readonly description: string | null;
    readonly messages: readonly { readonly role: string; readonly content: unknown }[];
    readonly preview: string;
  }> {
    const result = await this.#manager.getPrompt(
      input.userId,
      input.serverId,
      input.name,
      input.arguments,
    );
    // A prompt is a template the person applies; it is previewed as sourced
    // text and never inserted as a fake assistant turn.
    const preview = result.messages
      .map((message) => {
        const content = message.content as Record<string, unknown> | null;
        const text = content && typeof content.text === 'string' ? content.text : '';
        return `[${message.role}] ${MCP_REDACTOR.redact(text)}`;
      })
      .join('\n');
    return { ...result, preview };
  }

  // -------------------------------------------------------------- tasks ---

  async listTasks(userId: string, conversationId: string): Promise<McpTaskRecord[]> {
    return this.#store.listMcpTasks(userId, { conversationId });
  }

  async getTask(userId: string, taskId: string): Promise<McpTaskRecord> {
    return this.#manager.getTask(userId, taskId);
  }

  async cancelTask(userId: string, taskId: string): Promise<McpTaskRecord> {
    return this.#manager.cancelTask(userId, taskId);
  }

  // ------------------------------------------------------------- helpers ---

  #mediaPort(): ToolMediaPort | null {
    const media = this.#media;
    if (!media) return null;
    return {
      async importToolImage(input) {
        const asset = await media.putToolImage({
          userId: input.userId,
          conversationId: input.conversationId,
          name: input.name,
          declaredMediaType: input.mediaType,
          bytes: input.bytes,
        });
        return {
          assetId: asset.id,
          mediaType: asset.mediaType,
          width: asset.width,
          height: asset.height,
          bytes: asset.bytes,
          name: asset.name,
        };
      },
    };
  }

  /** Used by the composition root's server-initiated elicitation handler. */
  async createElicitation(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly serverId: string;
    readonly actionId: string | null;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
  }): Promise<McpInteractionRecord> {
    return this.#broker.createElicitation(input);
  }

  get vault(): McpCredentialVault {
    return this.#vault;
  }

  get store(): McpStore {
    return this.#store;
  }

  get now(): Date {
    return this.#now();
  }
}

/** The endpoint text shown in a management response. */
export function endpointOf(config: McpServerConfig): string | null {
  return describeEndpoint(config);
}
