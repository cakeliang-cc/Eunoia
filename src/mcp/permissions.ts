/**
 * The unified authorization port for external tool calls.
 *
 * It answers three questions in one place, which is why it is not spread through
 * the loop or the adapter:
 *
 *   - **May this call run without asking?** Only a policy the person configured
 *     can say yes, and never for a write.
 *   - **What exactly is being approved?** The durable action is created first,
 *     with the argument digest and contract hash, so the approval is bound to
 *     the bytes that will be sent.
 *   - **Who is waiting?** The interaction broker owns the state machine; this
 *     port only decides that a question is needed and forwards the wait.
 *
 * See docs/adr/033-mcp-host.md §8.1.
 */

import { randomUUID } from 'node:crypto';
import { sha256 } from '../tools/contract.ts';
import type {
  ToolPermissionDecision,
  ToolPermissionPort,
  ToolPermissionRequest,
  ToolPermissionResolution,
} from '../tools/types.ts';
import type { InteractionBroker } from './interactions.ts';
import type { McpStore } from './store.ts';
import type { McpActionRecord, McpCatalog, McpServerConfig } from './types.ts';
import { McpError } from './types.ts';
import { checkMcpScope, scopeFingerprint } from '../tools/scope.ts';

export interface McpPermissionDeps {
  readonly store: McpStore;
  readonly broker: InteractionBroker;
  readonly now?: () => Date;
  /** Description shown in the approval card; never includes the argument values. */
  readonly describeEndpoint?: (config: McpServerConfig) => string | null;
}

export class McpPermissionPort implements ToolPermissionPort {
  readonly #store: McpStore;
  readonly #broker: InteractionBroker;
  readonly #now: () => Date;
  readonly #describeEndpoint: McpPermissionDeps['describeEndpoint'];

  constructor(deps: McpPermissionDeps) {
    this.#store = deps.store;
    this.#broker = deps.broker;
    this.#now = deps.now ?? (() => new Date());
    this.#describeEndpoint = deps.describeEndpoint;
  }

  async decide(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    if (request.contract.origin.kind !== 'mcp') {
      // A builtin tool never reaches this port; the loop's own policy decides.
      return { kind: 'allow' };
    }
    const origin = request.contract.origin;
    if (!request.userId) {
      return { kind: 'deny', reason: '外部工具调用缺少用户上下文，已拒绝。' };
    }
    if (!request.conversationId) {
      return { kind: 'deny', reason: '外部工具调用必须属于一个会话。' };
    }
    if (request.scope) {
      const scoped = checkMcpScope(request.scope, {
        serverId: origin.serverId,
        toolName: origin.originalName,
        classification: origin.classification,
        arguments: request.args,
        account: (await this.#store.getMcpCatalog(request.userId, origin.serverId))?.identity ?? null,
      });
      if (!scoped.ok) {
        // Denied before an action is persisted or a byte leaves the process:
        // the remote side must observe zero calls for this decision.
        return { kind: 'deny', reason: scoped.reason };
      }
    }
    const record = await this.#store.getMcpServer(request.userId, origin.serverId);
    if (!record) {
      return { kind: 'deny', reason: '这个外部服务已经被删除，调用已拒绝。' };
    }
    const config = record.config;
    if (!config.enabled) {
      return { kind: 'deny', reason: '这个外部服务没有启用，调用已拒绝。' };
    }
    const catalog = await this.#store.getMcpCatalog(request.userId, origin.serverId);

    const argumentsJson = JSON.stringify(request.args);
    const digest = sha256(argumentsJson);
    const actionId = randomUUID();
    const classification = origin.classification;
    const now = this.#now().toISOString();

    const action: McpActionRecord = {
      id: actionId,
      userId: request.userId,
      conversationId: request.conversationId,
      turnId: null,
      step: null,
      callId: request.callId,
      serverId: origin.serverId,
      identity: catalog?.identity ?? 'unknown',
      catalogRevision: origin.catalogRevision,
      contractHash: request.contract.contractHash,
      toolName: origin.originalName,
      argumentsJson,
      argumentsDigest: digest,
      classification,
      state: 'prepared',
      conclusion: null,
      error: null,
      resultJson: null,
      sentAt: null,
      finishedAt: null,
      createdAt: now,
    };
    await this.#store.createMcpAction(action);

    const policy = config.toolPolicy;
    const override = policy.tools?.[origin.originalName];
    // A read may be auto-approved only when the person said so for reads. A
    // write is never auto-approved by a server hint or by the tool's own class.
    const autoApprovedRead =
      classification === 'external_read' && policy.autoApproveReads === true;
    const autoApprovedOverride =
      override?.autoApprove === true && classification !== 'external_write';
    if (autoApprovedRead || autoApprovedOverride) {
      await this.#store.updateMcpAction(request.userId, actionId, { state: 'prepared' });
      return { kind: 'allow', actionId };
    }

    const summary =
      classification === 'external_read'
        ? `${config.name} · ${origin.originalName}（读取外部数据）`
        : classification === 'external_write'
          ? `${config.name} · ${origin.originalName}（写入外部服务）`
          : `${config.name} · ${origin.originalName}（可能产生副作用，未分类）`;

    const interaction = await this.#broker.createApproval({
      userId: request.userId,
      conversationId: request.conversationId,
      serverId: origin.serverId,
      actionId,
      summary,
      payload: approvalPayload({
        config,
        catalog,
        request,
        digest,
        ...(request.scope ? { scopeFingerprint: scopeFingerprint(request.scope) } : {}),
        ...(this.#describeEndpoint ? { endpoint: this.#describeEndpoint(config) } : {}),
      }),
    });
    await this.#store.updateMcpAction(request.userId, actionId, { state: 'waiting_approval' });
    return {
      kind: 'wait',
      interactionId: interaction.id,
      summary: interaction.summary,
      actionId,
      expiresAt: new Date(interaction.expiresAt),
    };
  }

  async awaitDecision(
    interactionId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<ToolPermissionResolution> {
    return this.#broker.awaitDecision(interactionId, options);
  }
}

function approvalPayload(input: {
  readonly config: McpServerConfig;
  readonly catalog: McpCatalog | null;
  readonly request: ToolPermissionRequest;
  readonly digest: string;
  readonly endpoint?: string | null;
}): Record<string, unknown> {
  const origin = input.request.contract.origin;
  if (origin.kind !== 'mcp') return {};
  return {
    serverId: input.config.id,
    serverName: input.config.name,
    transport: input.config.transport,
    endpoint: input.endpoint ?? null,
    runLocation: input.config.stdio?.runLocation ?? null,
    account: input.catalog?.identity ?? null,
    accountLabel: input.catalog?.serverInfo?.name ?? null,
    tool: origin.originalName,
    modelName: input.request.contract.name,
    classification: origin.classification,
    contractHash: input.request.contract.contractHash,
    argumentsDigest: input.digest,
    // Keys are useful for the decision; values may contain a person's data or a
    // token, and an approval card is not a reason to show them.
    argumentKeys: Object.keys(input.request.args).sort(),
    catalogRevision: origin.catalogRevision,
    execution: input.request.scope
      ? {
          role: input.request.scope.identity.role,
          teamId: input.request.scope.identity.teamId ?? null,
          runId: input.request.scope.identity.runId ?? null,
          memberId: input.request.scope.identity.memberId ?? null,
          activationId: input.request.scope.identity.activationId ?? null,
          generation: input.request.scope.identity.generation ?? null,
          scopeFingerprint: scopeFingerprint(input.request.scope),
        }
      : null,
  };
}

/** Fail closed when an MCP tool somehow reaches the loop without a port. */
export function requireMcpPermission(port: ToolPermissionPort | null | undefined): ToolPermissionPort {
  if (!port) {
    throw new McpError('MCP_PERMISSION_DENIED', '这个回合没有外部工具授权通道。', 403);
  }
  return port;
}
