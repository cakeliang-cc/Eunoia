/**
 * The MCP host's vocabulary.
 *
 * This module is deliberately free of the vendor SDK. The SDK's `Client`,
 * `Tool` and content types stop at `transport/` and `client.ts`; the service,
 * the database, the agent loop and the web client see these types instead. That
 * is what lets the protocol revision move without touching the product, and it
 * is also what keeps a server's raw JSON Schema out of the model adapter.
 *
 * See docs/adr/033-mcp-host.md.
 */

/** How the host reaches the server. */
export type McpTransportKind = 'stdio' | 'http';

/**
 * Where a stdio server's process runs.
 *
 * `host` is a trusted-process mode that only an explicit deployment setting can
 * enable. It is never described as sandboxed.
 */
export type McpRunLocation = 'host' | 'sandbox' | 'browser';

export type McpAuthMode = 'none' | 'bearer' | 'header' | 'oauth';

export type McpConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'ready'
  | 'auth_required'
  | 'reconnecting'
  | 'failed'
  | 'closing';

/** How the application classifies a tool call, independent of server claims. */
export type McpToolClassification = 'external_read' | 'external_write' | 'external_unknown';

/** The per-tool override a person can set in the management UI. */
export interface McpToolPolicyEntry {
  readonly enabled?: boolean;
  readonly classification?: McpToolClassification;
  /** Approve every call without asking. Off by default and never for writes. */
  readonly autoApprove?: boolean;
}

export interface McpToolPolicy {
  /** Allow list by original tool name. Absent means "everything offered". */
  readonly allow?: readonly string[];
  /** Deny list by original tool name. Deny wins over allow. */
  readonly deny?: readonly string[];
  /** Per-tool overrides. */
  readonly tools?: Readonly<Record<string, McpToolPolicyEntry>>;
  /**
   * Whether `readOnlyHint` may make a tool read-only *without* a human policy.
   *
   * Off by default: a server's self-description is metadata, not authorization.
   */
  readonly trustReadOnlyHint?: boolean;
  /**
   * Read calls that need no approval. Only an explicit policy may say this; the
   * default is that even an external read is approved once.
   */
  readonly autoApproveReads?: boolean;
}

export interface McpOAuthConfig {
  /** A pre-registered client id. Absent means dynamic registration. */
  readonly clientId?: string;
  /** Reference to a client secret, for a confidential pre-registered client. */
  readonly clientSecretRef?: string;
  readonly scopes?: readonly string[];
  /** Must be a loopback callback owned by this deployment. */
  readonly redirectUri?: string;
  /** Client metadata document URL, for the CIMD registration path. */
  readonly clientMetadataUrl?: string;
}

export interface McpHttpConfig {
  readonly url: string;
  readonly auth: McpAuthMode;
  readonly oauth?: McpOAuthConfig;
  /** Reference like `env:MCP_SECRET_TOKEN`; never the secret itself. */
  readonly bearerRef?: string;
  /** Header name → reference. The value is resolved at connect time only. */
  readonly headerRefs?: Readonly<Record<string, string>>;
  /** Loopback/private addresses are refused unless this is explicitly true. */
  readonly allowPrivateNetwork?: boolean;
  /** Plain http is refused for a non-loopback host unless this is true. */
  readonly allowInsecure?: boolean;
}

export interface McpStdioConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Environment variables to pass, name → reference. Nothing is inherited. */
  readonly envRefs?: Readonly<Record<string, string>>;
  readonly runLocation: McpRunLocation;
  /** Fixed image reference for a sandbox run. */
  readonly image?: string;
}

export interface McpTimeouts {
  /** Handshake/probe bound. */
  readonly connectMs: number;
  /** A normal tools/call bound. */
  readonly callMs: number;
  /** Grace before a process tree is killed on close. */
  readonly closeMs: number;
}

export interface McpLimits {
  readonly maxTools: number;
  /** One tool's input schema, in UTF-8 bytes. */
  readonly maxSchemaBytes: number;
  /** All enabled schemas together. */
  readonly maxCatalogBytes: number;
  /** One call's decoded result, in bytes. */
  readonly maxResultBytes: number;
  /** Text projection of one call's result, in characters. */
  readonly maxTextChars: number;
}

export const DEFAULT_MCP_LIMITS: McpLimits = {
  maxTools: 100,
  maxSchemaBytes: 64 * 1024,
  maxCatalogBytes: 512 * 1024,
  maxResultBytes: 32 * 1024 * 1024,
  maxTextChars: 20_000,
};

export const DEFAULT_MCP_TIMEOUTS: McpTimeouts = {
  connectMs: 15_000,
  callMs: 60_000,
  closeMs: 5_000,
};

/** A fully validated server configuration. */
export interface McpServerConfig {
  /** Application-assigned stable id. Never the server's self-reported name. */
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly transport: McpTransportKind;
  readonly http?: McpHttpConfig;
  readonly stdio?: McpStdioConfig;
  readonly timeouts: McpTimeouts;
  readonly limits: McpLimits;
  readonly toolPolicy: McpToolPolicy;
  /** Optimistic-lock revision. Incremented on every accepted update. */
  readonly configRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a management response may contain: references, never secret values. */
/** The configuration a person may edit, with references (never values). */
export interface McpEditableConfig {
  readonly http?: {
    readonly url: string;
    readonly auth: McpAuthMode;
    readonly bearerRef?: string;
    readonly headerRefs?: Readonly<Record<string, string>>;
    readonly allowPrivateNetwork?: boolean;
    readonly allowInsecure?: boolean;
  };
  readonly stdio?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly runLocation: McpRunLocation;
    readonly image?: string;
    readonly envRefs?: Readonly<Record<string, string>>;
  };
}

export interface McpServerView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly transport: McpTransportKind;
  readonly endpoint: string | null;
  readonly runLocation: McpRunLocation | null;
  readonly auth: McpAuthMode;
  readonly configRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly policy: McpToolPolicy;
  readonly timeouts: McpTimeouts;
  readonly limits: McpLimits;
  readonly tools: readonly McpToolView[];
  /** Round-trips every non-secret field an editor needs. */
  readonly editable: McpEditableConfig;
}

export interface McpErrorDescription {
  readonly code: string;
  readonly message: string;
  /** Safe, bounded detail. Never a secret and never a raw response body. */
  readonly detail?: Record<string, unknown>;
}

export interface McpServerStatus {
  readonly state: McpConnectionStatus;
  /** The generation this status belongs to; a late reply from an older one loses. */
  readonly generation: number;
  readonly lastError: McpErrorDescription | null;
  readonly lastErrorAt: string | null;
  readonly toolCount: number;
  readonly nextRetryAt: string | null;
  readonly protocolRevision: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null;
  readonly catalogRevision: string | null;
  readonly auth: McpAuthState;
}

export interface McpAuthState {
  readonly mode: McpAuthMode;
  readonly state: 'none' | 'ok' | 'needs_login' | 'expired' | 'insufficient_scope';
  readonly account: string | null;
  readonly scope: string | null;
  readonly expiresAt: string | null;
}

export interface McpToolView {
  readonly originalName: string;
  readonly modelName: string;
  readonly description: string;
  readonly classification: McpToolClassification;
  readonly enabled: boolean;
  readonly readOnlyHint: boolean | null;
  readonly destructiveHint: boolean | null;
  readonly idempotentHint: boolean | null;
  readonly contractHash: string;
}

/** One tool in the immutable catalog snapshot. */
export interface McpToolEntry {
  readonly originalName: string;
  readonly modelName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> | null;
  readonly annotations: {
    readonly readOnlyHint: boolean | null;
    readonly destructiveHint: boolean | null;
    readonly idempotentHint: boolean | null;
  };
  readonly contractHash: string;
  readonly classification: McpToolClassification;
  readonly enabled: boolean;
}

export interface McpResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string | null;
  readonly mimeType: string | null;
}

export interface McpResourceTemplateEntry {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string | null;
  readonly mimeType: string | null;
}

export interface McpPromptEntry {
  readonly name: string;
  readonly description: string | null;
  readonly arguments: readonly {
    readonly name: string;
    readonly description: string | null;
    readonly required: boolean;
  }[];
}

export interface McpCatalog {
  readonly serverId: string;
  readonly userId: string;
  /** Account/scope the snapshot was fetched under (never a token). */
  readonly identity: string;
  readonly revision: string;
  readonly fetchedAt: string;
  readonly invalidatedAt: string | null;
  readonly invalidReason: string | null;
  readonly tools: readonly McpToolEntry[];
  readonly resources: readonly McpResourceEntry[];
  readonly resourceTemplates: readonly McpResourceTemplateEntry[];
  readonly prompts: readonly McpPromptEntry[];
  readonly instructions: string | null;
  readonly capabilities: McpCapabilities;
  readonly protocolRevision: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null;
}

export interface McpCapabilities {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
  readonly logging: boolean;
  readonly completions: boolean;
  readonly subscriptions: boolean;
  readonly tasks: boolean;
  readonly elicitation: boolean;
}

export const EMPTY_CAPABILITIES: McpCapabilities = {
  tools: false,
  resources: false,
  prompts: false,
  logging: false,
  completions: false,
  subscriptions: false,
  tasks: false,
  elicitation: false,
};

// --------------------------------------------------------------- actions ---

/** Where a persisted call is in its local lifecycle. */
export type McpActionState =
  | 'prepared'
  | 'waiting_approval'
  | 'sending'
  | 'waiting_input'
  | 'running_task'
  | 'finished';

/** The remote conclusion. `unknown` is terminal until reconciled. */
export type McpActionConclusion = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface McpActionRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly step: number | null;
  readonly callId: string;
  readonly serverId: string;
  /** Account/scope the action was prepared under. */
  readonly identity: string;
  readonly catalogRevision: string;
  readonly contractHash: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly argumentsDigest: string;
  readonly classification: McpToolClassification;
  readonly state: McpActionState;
  readonly conclusion: McpActionConclusion | null;
  readonly error: McpErrorDescription | null;
  readonly resultJson: string | null;
  readonly sentAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface McpConversationBinding {
  readonly conversationId: string;
  readonly serverId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export type McpInteractionKind = 'approval' | 'elicitation';

export type McpInteractionStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

export interface McpInteractionRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly actionId: string | null;
  readonly serverId: string;
  readonly kind: McpInteractionKind;
  readonly status: McpInteractionStatus;
  /** What the person is deciding: tool, server, account, args digest, effect. */
  readonly summary: string;
  /** Approval context, or the elicitation schema. Never a secret. */
  readonly payload: Record<string, unknown>;
  /** The one-shot resume key; a repeated click must not execute twice. */
  readonly resumeKey: string;
  readonly expiresAt: string;
  readonly response: JsonValue | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface McpTaskRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly serverId: string;
  readonly actionId: string;
  readonly remoteTaskId: string;
  readonly identity: string;
  readonly status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'unknown';
  readonly pollIntervalMs: number;
  readonly ttlMs: number | null;
  readonly deadlineAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly resultJson: string | null;
  readonly error: McpErrorDescription | null;
  readonly createdAt: string;
}

// ----------------------------------------------------------------- errors ---

export type McpErrorCode =
  | 'MCP_CONFIG_INVALID'
  | 'MCP_NOT_FOUND'
  | 'MCP_DISABLED'
  | 'MCP_UNSUPPORTED'
  | 'MCP_SCHEMA_INVALID'
  | 'MCP_CATALOG_STALE'
  | 'MCP_AUTH_REQUIRED'
  | 'MCP_AUTH_EXPIRED'
  | 'MCP_AUTH_SCOPE'
  | 'MCP_PERMISSION_DENIED'
  | 'MCP_APPROVAL_REQUIRED'
  | 'MCP_INTERACTION_CANCELLED'
  | 'MCP_INTERACTION_EXPIRED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_REMOTE_FAILED'
  | 'MCP_RESULT_TOO_LARGE'
  | 'MCP_MEDIA_UNSUPPORTED'
  | 'MCP_UNKNOWN_RESULT'
  | 'MCP_STORE_FAILED'
  | 'MCP_TASK_UNAVAILABLE';

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: McpErrorCode,
    message: string,
    status = 400,
    options: { readonly retryable?: boolean; readonly detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? {};
  }

  describe(): McpErrorDescription {
    return { code: this.code, message: this.message, ...(Object.keys(this.detail).length > 0 ? { detail: this.detail } : {}) };
  }
}

export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}

/** A status object for a server that has never connected. */
export function initialStatus(config: Pick<McpServerConfig, 'enabled' | 'transport' | 'http'>): McpServerStatus {
  return {
    state: config.enabled ? 'connecting' : 'disabled',
    generation: 0,
    lastError: null,
    lastErrorAt: null,
    toolCount: 0,
    nextRetryAt: null,
    protocolRevision: null,
    serverInfo: null,
    catalogRevision: null,
    auth: {
      mode: config.http?.auth ?? 'none',
      state: config.http?.auth === 'oauth' ? 'needs_login' : 'none',
      account: null,
      scope: null,
      expiresAt: null,
    },
  };
}
