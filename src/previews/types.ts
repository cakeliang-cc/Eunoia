/**
 * Durable preview leases.
 *
 * A preview is not "a process that happens to listen on a port". It is a lease
 * that binds one job, sandbox, workspace, owner/member, container port, route,
 * generation and TTL. The gateway routes only a live lease, so stopping it or
 * letting it expire makes the old address unreachable even if a new process
 * later reuses the same port.
 *
 * The lease is persisted as JSON in a private data file: it must survive a
 * restart, and it is small enough that a new SQLite table would add migration
 * risk without adding a query the product needs.
 */

export type PreviewStatus = 'starting' | 'ready' | 'failed' | 'stopped' | 'expired';

export interface PreviewLease {
  readonly id: string;
  /** Unguessable host label. The URL is a capability, not an authorization guess. */
  readonly routeId: string;
  readonly jobId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly memberId: string | null;
  readonly runId: string | null;
  readonly taskId: string;
  readonly sandboxId: string | null;
  readonly workspaceId: string | null;
  readonly containerPort: number;
  readonly status: PreviewStatus;
  readonly generation: number;
  readonly userUrl: string | null;
  readonly browserUrl: string | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
  readonly expiresAt: string;
  readonly lastOpenedAt: string | null;
  readonly error: string | null;
}

export interface PreviewLimits {
  readonly maxPerConversation: number;
  readonly ttlMs: number;
  readonly readyTimeoutMs: number;
}

export const DEFAULT_PREVIEW_LIMITS: PreviewLimits = {
  maxPerConversation: 2,
  ttlMs: 30 * 60_000,
  readyTimeoutMs: 30_000,
};

export class PreviewError extends Error {
  readonly code:
    | 'PREVIEW_DISABLED'
    | 'PREVIEW_NOT_FOUND'
    | 'PREVIEW_LIMIT'
    | 'PREVIEW_NOT_READY'
    | 'PREVIEW_FAILED'
    | 'PREVIEW_EXPIRED';
  readonly status: number;

  constructor(code: PreviewError['code'], message: string, status = 400) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
    this.status = status;
  }
}
