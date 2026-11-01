/**
 * Credential Broker.
 *
 * The rule from ADR §6 is absolute: a long-lived host credential is never
 * injected into a sandbox. This broker is the only path a credential can take,
 * and it enforces four properties the previous "pass `process.env` to the shell"
 * approach could not:
 *
 *   1. a task must be granted a named credential explicitly;
 *   2. the value is short-lived (the grant has an expiry);
 *   3. only the scopes the grant names are exposed;
 *   4. every issuance and revocation is auditable, and the value is registered
 *      with the redactor so it cannot reach a log.
 *
 * Values live in process memory, not in SQLite. Persisting a secret in the same
 * file as conversation history would be a worse trade than losing it on restart:
 * the broker can re-issue, but it cannot un-leak a database backup.
 */

import { randomUUID } from 'node:crypto';
import type { AuditLog } from './audit.ts';
import { Redactor } from './redact.ts';

export interface CredentialGrant {
  readonly grantId: string;
  readonly credentialId: string;
  readonly taskId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly issuedAt: string;
}

export interface ShortLivedCredential {
  readonly grantId: string;
  readonly credentialId: string;
  /** The environment variable name the sandbox sees, never the host's name. */
  readonly envName: string;
  readonly value: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

interface StoredCredential {
  readonly credentialId: string;
  readonly value: string;
  readonly scopes: readonly string[];
  readonly ttlMs: number;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_PREFIX = 'EUNOIA_CRED_';

/**
 * The broker.
 *
 * A deployment that needs cloud or Git credentials registers them at startup
 * from its own secret store (not from `process.env` of the agent process) and
 * grants them to a task for a bounded time. This build exposes the interface and
 * the enforcement; the concrete secret-store adapter is an operator concern.
 */
export class CredentialBroker {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly grants = new Map<string, { grant: CredentialGrant; value: string }>();
  private readonly audit: AuditLog | null;
  private readonly now: () => Date;
  private readonly redactor: Redactor;
  readonly maxTtlMs: number;

  constructor(deps: { audit?: AuditLog; now?: () => Date; redactor?: Redactor; maxTtlMs?: number } = {}) {
    this.audit = deps.audit ?? null;
    this.now = deps.now ?? (() => new Date());
    this.redactor = deps.redactor ?? new Redactor();
    this.maxTtlMs = deps.maxTtlMs ?? 15 * 60_000;
  }

  /** Register a credential's value and its allowed scopes. Never logged. */
  register(input: {
    readonly credentialId: string;
    readonly value: string;
    readonly scopes: readonly string[];
    readonly ttlMs?: number;
  }): void {
    if (!ENV_NAME_PATTERN.test(input.credentialId)) {
      throw new Error(`credential id must be an upper-case environment name: ${input.credentialId}`);
    }
    if (input.value.trim().length === 0) throw new Error('credential value must not be empty');
    this.credentials.set(input.credentialId, {
      credentialId: input.credentialId,
      value: input.value,
      scopes: [...input.scopes],
      ttlMs: Math.min(Math.max(input.ttlMs ?? this.maxTtlMs, 1_000), this.maxTtlMs),
    });
    this.redactor.addSecret(input.value);
  }

  /** Grant one task a credential for a bounded time. */
  async issue(input: {
    readonly credentialId: string;
    readonly taskId: string;
    readonly requestedScopes?: readonly string[];
    readonly ttlMs?: number;
    readonly approvedBy: string;
    readonly approvalId?: string;
  }): Promise<CredentialGrant> {
    const credential = this.credentials.get(input.credentialId);
    if (!credential) {
      await this.audit?.record({
        taskId: input.taskId,
        action: 'credential.issue',
        outcome: 'denied',
        detail: { credential_id: input.credentialId, reason: 'unknown credential' },
      });
      throw new Error(`unknown credential ${input.credentialId}`);
    }
    const scopes = input.requestedScopes ?? credential.scopes;
    const unauthorized = scopes.filter((scope) => !credential.scopes.includes(scope));
    if (unauthorized.length > 0) {
      await this.audit?.record({
        taskId: input.taskId,
        action: 'credential.issue',
        outcome: 'denied',
        detail: { credential_id: input.credentialId, reason: 'scope not allowed', scopes: unauthorized },
      });
      throw new Error(`credential ${input.credentialId} does not allow scope(s): ${unauthorized.join(', ')}`);
    }

    const ttl = Math.min(
      Math.max(input.ttlMs ?? credential.ttlMs, 1_000),
      credential.ttlMs,
      this.maxTtlMs,
    );
    const grant: CredentialGrant = {
      grantId: `cred_${randomUUID()}`,
      credentialId: credential.credentialId,
      taskId: input.taskId,
      scopes,
      expiresAt: new Date(this.now().getTime() + ttl).toISOString(),
      issuedAt: this.now().toISOString(),
    };
    this.grants.set(grant.grantId, { grant, value: credential.value });
    await this.audit?.record({
      taskId: input.taskId,
      action: 'credential.issue',
      outcome: 'allowed',
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      detail: {
        credential_id: credential.credentialId,
        grant_id: grant.grantId,
        scopes,
        expires_at: grant.expiresAt,
      },
    });
    return grant;
  }

  /**
   * The environment for one execution.
   *
   * Expired grants are dropped and reported, not silently renewed: a command that
   * needed a token five minutes ago does not get a fresh one because it ran late.
   */
  async resolveForTask(taskId: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const now = this.now().getTime();
    for (const [grantId, entry] of this.grants) {
      if (entry.grant.taskId !== taskId) continue;
      if (Date.parse(entry.grant.expiresAt) <= now) {
        this.grants.delete(grantId);
        await this.audit?.record({
          taskId,
          action: 'credential.expire',
          outcome: 'failed',
          detail: { grant_id: grantId, credential_id: entry.grant.credentialId },
        });
        continue;
      }
      env[`${ENV_PREFIX}${entry.grant.credentialId}`] = entry.value;
    }
    return env;
  }

  async revoke(grantId: string): Promise<boolean> {
    const entry = this.grants.get(grantId);
    if (!entry) return false;
    this.grants.delete(grantId);
    await this.audit?.record({
      taskId: entry.grant.taskId,
      action: 'credential.revoke',
      outcome: 'allowed',
      detail: { grant_id: grantId, credential_id: entry.grant.credentialId },
    });
    return true;
  }

  /** Values to register with a redactor before any execution output is written. */
  secrets(): string[] {
    return [...this.grants.values()].map((entry) => entry.value);
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }
}
