/**
 * The MCP runtime, composed once per process.
 *
 * Everything here is created from the product store and the media service the
 * process already has, so an MCP image lands in the same private library as an
 * upload and a deleted conversation cascades its pending approvals. A separate
 * database or media root would make the two halves of the product disagree about
 * ownership.
 *
 * See docs/adr/033-mcp-host.md §4 and §13.
 */

import type { Store } from '../store.ts';
import type { MediaService } from '../media/service.ts';
import type { MediaBlobStore } from '../media/blob-store.ts';
import { createMcpStore } from './store-factory.ts';
import type { McpStore } from './store.ts';
import { loadSecretBox, McpCredentialVault } from './credentials.ts';
import { InteractionBroker } from './interactions.ts';
import { McpClientManager } from './manager.ts';
import { McpService } from './service.ts';
import { McpArtifactService } from './artifacts.ts';
import { McpError, DEFAULT_MCP_LIMITS, type McpInteractionRecord, type McpServerStatus } from './types.ts';
import type { ElicitationRequest } from './client.ts';

export interface McpRuntimeOptions {
  readonly store: Store;
  readonly media: MediaService | null;
  readonly blobs: MediaBlobStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Status changes for SSE. */
  readonly onStatus?: (userId: string, serverId: string, status: McpServerStatus) => void;
  /** Pending interaction changes for SSE. */
  readonly onInteraction?: (record: McpInteractionRecord) => void;
  /** How long an elicitation may wait for a person. */
  readonly elicitationTtlMs?: number;
}

export interface McpRuntime {
  readonly service: McpService;
  readonly manager: McpClientManager;
  readonly broker: InteractionBroker;
  readonly vault: McpCredentialVault;
  readonly store: McpStore;
  readonly artifacts: McpArtifactService;
  readonly available: boolean;
  shutdown(): Promise<void>;
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const store = createMcpStore(options.store);
  const vault = new McpCredentialVault(store, loadSecretBox(env), now);
  const broker = new InteractionBroker({
    store,
    now,
    ...(options.elicitationTtlMs !== undefined ? { elicitationTtlMs: options.elicitationTtlMs } : {}),
    ...(options.onInteraction ? { onChange: options.onInteraction } : {}),
  });

  // The manager is constructed before the service, but its elicitation handler
  // needs the service's conversation-scoped broker. The holder closes that small
  // cycle without making either module import the other.
  const holder: { service: McpService | null } = { service: null };
  const manager = new McpClientManager({
    store,
    vault,
    now,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    onElicit: async ({ userId, serverId, conversationId, request }) =>
      handleElicitation(holder, broker, userId, serverId, conversationId, request, now),
  });

  const artifacts = new McpArtifactService({
    store,
    blobs: options.blobs,
    maxBytes: Math.min(DEFAULT_MCP_LIMITS.maxResultBytes, 32 * 1024 * 1024),
    now,
  });

  const service = new McpService({
    store,
    manager,
    broker,
    vault,
    media: options.media,
    artifacts,
    now,
  });
  holder.service = service;

  return {
    service,
    manager,
    broker,
    vault,
    store,
    artifacts,
    // The host works without a master key: anonymous and env-header servers
    // still connect; only persisted OAuth tokens require the key.
    available: true,
    async shutdown() {
      await manager.shutdown();
    },
  };
}

/**
 * A server-initiated elicitation.
 *
 * It becomes the same kind of persisted interaction as an approval, but the
 * form is validated against the server's schema before it is stored, and the
 * value is echoed only after the person accepted it. A decline is a valid
 * answer; silence is not, so the wait has a deadline.
 */
async function handleElicitation(
  holder: { service: McpService | null },
  broker: InteractionBroker,
  userId: string,
  serverId: string,
  conversationId: string | null,
  request: ElicitationRequest,
  now: () => Date,
): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }> {
  const service = holder.service;
  if (!service) return { action: 'decline' };
  // An ask that arrives outside a call has no conversation to attach to; asking
  // in an unrelated conversation would be worse than declining.
  if (!conversationId) return { action: 'decline' };
  if (request.mode === 'form' && request.requestedSchema) {
    if (JSON.stringify(request.requestedSchema).match(/password|secret|token|api[_-]?key/i)) {
      // A form that asks for a credential is refused rather than rendered: this
      // product has no path that should collect a password through a tool.
      return { action: 'decline' };
    }
  }
  const interaction = await broker.createElicitation({
    userId,
    conversationId,
    serverId,
    actionId: null,
    summary:
      request.mode === 'url'
        ? `${serverId} 请求打开一个网页完成交互`
        : `${serverId} 需要补充信息`,
    payload: {
      mode: request.mode,
      message: request.message,
      ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
      ...(request.url ? { url: request.url } : {}),
    },
    ttlMs: 5 * 60_000,
  });
  const answer = await broker.awaitDecision(interaction.id, {
    timeoutMs: 5 * 60_000,
  });
  if (answer.kind !== 'allow') {
    return { action: 'decline' };
  }
  const record = await broker.get(userId, interaction.id);
  const response = record?.response;
  if (!record || record.status !== 'accepted') {
    return { action: 'decline' };
  }
  const content = normalizeElicitationContent(response);
  void now;
  return content ? { action: 'accept', content } : { action: 'accept' };
}

function normalizeElicitationContent(
  response: unknown,
): Record<string, string | number | boolean | string[]> | null {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const source =
    record.content && typeof record.content === 'object'
      ? (record.content as Record<string, unknown>)
      : record;
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      content[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      content[key] = value as string[];
    }
  }
  return Object.keys(content).length > 0 ? content : null;
}

export function assertMcpAvailable(runtime: McpRuntime | null): McpRuntime {
  if (!runtime) {
    throw new McpError('MCP_UNSUPPORTED', 'MCP 在这个进程中没有启用。', 503);
  }
  return runtime;
}
