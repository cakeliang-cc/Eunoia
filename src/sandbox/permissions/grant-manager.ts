/**
 * Grant Manager: the lifecycle of a scoped, expiring permission.
 *
 * ADR 020 §8 is explicit that a grant is never `{ approved: true }`. Every check
 * below exists because a boolean cannot answer it:
 *
 *   1. does the grant exist?
 *   2. is it still active (not revoked, not expired)?
 *   3. does its policy version still match the policy in force?
 *   4. does it name the same task, sandbox and principal?
 *   5. does it cover this exact resource and action?
 *   6. has a `once` grant already been used?
 *
 * A grant that fails any of these is not a grant. It is a row in a table.
 */

import { randomUUID } from 'node:crypto';
import type { SandboxStore } from '../store.ts';
import type { AuditLog } from '../audit.ts';
import type { ApprovalGrant } from '../types.ts';
import type {
  ApprovalScopeLevel,
  EffectivePermissionPolicy,
  PermissionEvaluationRequest,
} from './types.ts';

export interface GrantManagerDeps {
  readonly store: SandboxStore;
  readonly audit: AuditLog;
  readonly now?: () => Date;
}

export interface GrantValidation {
  readonly valid: boolean;
  readonly reason: string;
  readonly grant: ApprovalGrant | null;
}

export interface CreateGrantInput {
  readonly request: PermissionEvaluationRequest;
  readonly effective: EffectivePermissionPolicy;
  readonly source: 'policy' | 'auto_review' | 'human_approval';
  readonly scope: ApprovalScopeLevel;
  readonly ttlSeconds: number;
  readonly approvedBy: string;
  readonly requestId: string;
  readonly approvalRequestId?: string | null;
  /** Defaults to the request's resource identifier; must be a subset. */
  readonly resourceScope?: readonly string[];
}

const MIN_TTL_SECONDS = 1;
const MAX_GRANTS_PER_TASK = 256;

export class GrantManager {
  private readonly store: SandboxStore;
  private readonly audit: AuditLog;
  private readonly now: () => Date;

  constructor(deps: GrantManagerDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Create a grant, refusing anything the request did not ask for.
   *
   * The scope check is what stops an approver (or an auto-review bug) from
   * turning "write this one file" into "write the workspace".
   */
  async create(input: CreateGrantInput): Promise<ApprovalGrant> {
    const { request, effective } = input;
    const now = this.now();
    const maxTtlSeconds = Math.floor(
      (input.source === 'auto_review'
        ? effective.autoReview.maxTtlMs
        : effective.approval.maxTtlMs) / 1_000,
    );
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds < MIN_TTL_SECONDS) {
      throw new GrantError('grant TTL must be at least one second');
    }
    if (input.ttlSeconds > maxTtlSeconds) {
      throw new GrantError(
        `grant TTL ${input.ttlSeconds}s exceeds the ${input.source} ceiling (${maxTtlSeconds}s)`,
      );
    }
    if (input.source === 'auto_review' && effective.mode === 'restricted') {
      throw new GrantError('restricted mode cannot be widened by auto-review');
    }
    if (input.source === 'auto_review' && !effective.autoReview.enabled) {
      throw new GrantError('auto-review is disabled for this policy');
    }

    const requested = request.resource.scope ?? [request.resource.identifier];
    const scope = [...(input.resourceScope ?? [request.resource.identifier])];
    if (scope.length === 0) throw new GrantError('grant scope must not be empty');
    for (const entry of scope) {
      if (!requested.some((allowed) => covers(allowed, entry, request.action.operation))) {
        throw new GrantError(
          `grant scope ${JSON.stringify(entry)} is wider than the request (${requested.join(', ')})`,
        );
      }
    }

    const existing = await this.store.listGrants({ taskId: request.taskId }, now.toISOString());
    if (existing.length >= MAX_GRANTS_PER_TASK) {
      throw new GrantError('this task has too many grants; revoke or wait for expiry');
    }

    const grantId = `gr_${randomUUID()}`;
    const grant: ApprovalGrant = {
      approvalId: grantId,
      grantId,
      organizationId: request.organizationId ?? 'default',
      projectId: request.projectId ?? 'default',
      sessionId: request.sessionId,
      sandboxId: request.sandboxId ?? null,
      taskId: request.taskId,
      principalId: request.principal.id,
      action: request.action.operation,
      resourceScope: scope,
      source: input.source,
      status: 'active',
      scope: input.scope,
      requestId: input.requestId,
      approvalRequestId: input.approvalRequestId ?? null,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
      approvedBy: input.approvedBy,
      policyVersion: effective.version,
      createdAt: now.toISOString(),
      revokedAt: null,
      usedAt: null,
    };
    await this.store.saveApproval(grant);
    await this.audit.record({
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId ?? null,
      policyVersion: effective.version,
      approvalId: grant.approvalId,
      action: 'permission.grant.created',
      outcome: 'allowed',
      detail: {
        source: grant.source,
        action: grant.action,
        scope: grant.resourceScope,
        scope_level: grant.scope,
        expires_at: grant.expiresAt,
        request_id: grant.requestId,
        approval_request_id: grant.approvalRequestId,
      },
    });
    return grant;
  }

  /** Find the narrowest grant that covers this request, or none. */
  async findValidGrant(
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
  ): Promise<ApprovalGrant | null> {
    const now = this.now();
    const nowIso = now.toISOString();
    const taskGrants = await this.store.listGrants({ taskId: request.taskId }, nowIso);
    const sessionGrants = request.sessionId
      ? await this.store.listGrants({ sessionId: request.sessionId }, nowIso)
      : [];
    const seen = new Set<string>();
    const candidates = [...taskGrants, ...sessionGrants]
      .filter((grant) => {
        if (seen.has(grant.approvalId)) return false;
        seen.add(grant.approvalId);
        return true;
      })
      // Tightest scope first: a `once` grant should win over a task grant.
      .sort((left, right) => scopeRank(left) - scopeRank(right));

    for (const grant of candidates) {
      const validation = validateGrant(grant, request, effective, now);
      if (validation.valid) return grant;
    }
    return null;
  }

  /** Re-check a grant by id. Used by the Gateway immediately before execution. */
  async revalidate(
    grantId: string,
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
  ): Promise<GrantValidation> {
    const grant = await this.store.getApproval(grantId);
    if (!grant) return { valid: false, reason: 'grant does not exist', grant: null };
    return validateGrant(grant, request, effective, this.now());
  }

  /** Consume a `once` grant. Returns false when it was already consumed. */
  async consume(grant: ApprovalGrant): Promise<boolean> {
    if (grant.scope !== 'once') return true;
    const used = await this.store.markGrantUsed(grant.approvalId, this.now().toISOString());
    if (!used) return false;
    return true;
  }

  async revoke(grantId: string, reason: string, actor: string): Promise<boolean> {
    const grant = await this.store.getApproval(grantId);
    if (!grant) return false;
    const revoked = await this.store.setGrantStatus(grantId, 'revoked', this.now().toISOString());
    if (revoked) {
      await this.audit.record({
        taskId: grant.taskId,
        sessionId: grant.sessionId ?? null,
        policyVersion: grant.policyVersion,
        approvalId: grantId,
        action: 'permission.grant.revoked',
        outcome: 'denied',
        detail: { reason, by: actor, action: grant.action, scope: grant.resourceScope },
      });
    }
    return revoked;
  }

  /** Revoke every grant a task owns; called when a task is cancelled/destroyed. */
  async revokeTaskGrants(taskId: string, reason: string, actor: string): Promise<number> {
    const grants = await this.store.listGrants({ taskId }, this.now().toISOString());
    let revoked = 0;
    for (const grant of grants) {
      if (grant.status === 'revoked') continue;
      const ok = await this.revoke(grant.approvalId, reason, actor);
      if (ok) revoked += 1;
    }
    return revoked;
  }

  /**
   * Mark expired grants and stale-policy grants.
   *
   * A grant whose policy version no longer matches is as invalid as an expired
   * one: the consent was given under rules that no longer apply (ADR 020 §12.3).
   */
  async expire(input: {
    readonly effectiveFor: (grant: ApprovalGrant) => Promise<EffectivePermissionPolicy | null>;
  }): Promise<{ expired: number; stale: number }> {
    const now = this.now();
    const grants = await this.store.listGrants({}, now.toISOString());
    let expired = 0;
    let stale = 0;
    for (const grant of grants) {
      if (grant.status === 'revoked') continue;
      const expiredAt = Date.parse(grant.expiresAt) <= now.getTime();
      if (expiredAt) {
        if (await this.store.setGrantStatus(grant.approvalId, 'expired', now.toISOString())) {
          expired += 1;
          await this.audit.record({
            taskId: grant.taskId,
            sessionId: grant.sessionId ?? null,
            approvalId: grant.approvalId,
            policyVersion: grant.policyVersion,
            action: 'permission.grant.expired',
            outcome: 'denied',
            detail: { reason: 'ttl', expires_at: grant.expiresAt },
          });
        }
        continue;
      }
      const effective = await input.effectiveFor(grant).catch(() => null);
      if (!effective) continue;
      if (grant.policyVersion !== effective.version) {
        if (await this.store.setGrantStatus(grant.approvalId, 'expired', now.toISOString())) {
          stale += 1;
          await this.audit.record({
            taskId: grant.taskId,
            sessionId: grant.sessionId ?? null,
            approvalId: grant.approvalId,
            policyVersion: grant.policyVersion,
            action: 'permission.grant.expired',
            outcome: 'denied',
            detail: {
              reason: 'policy_changed',
              grant_policy_version: grant.policyVersion,
              current_policy_version: effective.version,
            },
          });
        }
      }
    }
    return { expired, stale };
  }
}

export class GrantError extends Error {
  override readonly name = 'GrantError';
}

export function validateGrant(
  grant: ApprovalGrant,
  request: PermissionEvaluationRequest,
  effective: EffectivePermissionPolicy,
  now: Date,
): GrantValidation {
  if (grant.status !== undefined && grant.status !== 'active') {
    return invalid(`grant is ${grant.status}`, grant);
  }
  if (grant.revokedAt !== null) return invalid('grant was revoked', grant);
  if (Date.parse(grant.expiresAt) <= now.getTime()) return invalid('grant has expired', grant);
  if (grant.policyVersion !== effective.version) {
    return invalid('grant was issued under a different policy version', grant);
  }
  if (grant.taskId !== request.taskId) return invalid('grant belongs to a different task', grant);
  if (grant.principalId && grant.principalId !== request.principal.id) {
    return invalid('grant belongs to a different principal', grant);
  }
  if (grant.sandboxId && request.sandboxId && grant.sandboxId !== request.sandboxId) {
    return invalid('grant belongs to a different sandbox', grant);
  }
  if (grant.action !== request.action.operation) {
    return invalid(`grant covers ${grant.action}, not ${request.action.operation}`, grant);
  }
  if (grant.scope === 'once' && grant.usedAt) return invalid('once grant was already used', grant);
  const scopes = request.resource.scope ?? [request.resource.identifier];
  const covered = scopes.every((scope) =>
    grant.resourceScope.some((entry) => covers(entry, scope, request.action.operation)),
  );
  if (!covered) return invalid('grant scope does not cover this resource', grant);
  return { valid: true, reason: 'grant covers this request', grant };
}

function invalid(reason: string, grant: ApprovalGrant | null): GrantValidation {
  return { valid: false, reason, grant };
}

function scopeRank(grant: ApprovalGrant): number {
  return grant.scope === 'once' ? 0 : grant.scope === 'task' ? 1 : 2;
}

/**
 * Does `scope` cover `resource`?
 *
 * Paths use prefix semantics (with a normalised trailing slash); domains use
 * suffix semantics so `example.com` covers `api.example.com` but not
 * `notexample.com`.
 */
export function covers(scope: string, resource: string, action: string): boolean {
  if (scope === resource) return true;
  if (action === 'network.connect') {
    const host = hostOf(resource);
    const domain = scope.toLowerCase().replace(/^\*\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  }
  if (resource.startsWith(`${scope.replace(/\/+$/, '')}/`)) return true;
  return false;
}

function hostOf(value: string): string {
  try {
    const withScheme = value.includes('://') ? value : `https://${value}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return value.toLowerCase().split(':')[0] ?? value.toLowerCase();
  }
}
