/**
 * Audit trail and metrics.
 *
 * Every decision the platform makes is recorded with the correlation ids the ADR
 * lists (`session_id`, `task_id`, `sandbox_id`, `execution_id`, `tool_call_id`,
 * `policy_version`, `approval_id`). The audit row is written *after* the state
 * change it describes, and it is append-only: there is no update or delete path
 * in `SandboxStore` for it.
 *
 * Metrics are in-process counters rather than a metrics client. This product is
 * one process on one machine; exporting to Prometheus would be more moving parts
 * than the measurement is worth, while a counter snapshot in `/health` and the
 * ops CLI answers the question that actually gets asked — "is it failing?".
 */

import { randomUUID } from 'node:crypto';
import type { SandboxStore } from './store.ts';
import type { AuditEvent } from './types.ts';
import { Redactor } from './redact.ts';
import { log } from '../observability/logging.ts';

export interface AuditContext {
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly sandboxId?: string | null;
  readonly executionId?: string | null;
  readonly toolCallId?: string | null;
  readonly policyVersion?: string | null;
  readonly approvalId?: string | null;
}

export interface AuditInput extends AuditContext {
  readonly action: string;
  readonly outcome: AuditEvent['outcome'];
  readonly detail?: unknown;
}

export class AuditLog {
  private readonly store: SandboxStore;
  private readonly redactor: Redactor;
  private readonly now: () => Date;

  constructor(
    deps: { readonly store: SandboxStore; readonly now?: () => Date },
    redactor: Redactor = new Redactor(),
  ) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.redactor = redactor;
  }

  async record(input: AuditInput): Promise<void> {
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      timestamp: this.now().toISOString(),
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      sandboxId: input.sandboxId ?? null,
      executionId: input.executionId ?? null,
      toolCallId: input.toolCallId ?? null,
      policyVersion: input.policyVersion ?? null,
      approvalId: input.approvalId ?? null,
      action: input.action,
      outcome: input.outcome,
      detail: this.redactor.redactValue(input.detail ?? {}),
    };
    try {
      await this.store.appendAudit(event);
    } catch (error) {
      // An audit write failure must be visible, but it must not turn a correct
      // execution into a failed one. The structured log is the second copy.
      log.error('sandbox.audit_write_failed', {
        error: error instanceof Error ? error.message : String(error),
        action: event.action,
        execution_id: event.executionId,
      });
    }
    log[input.outcome === 'failed' || input.outcome === 'denied' ? 'warn' : 'info'](
      `sandbox.${input.action}`,
      {
        outcome: input.outcome,
        task_id: event.taskId,
        sandbox_id: event.sandboxId,
        execution_id: event.executionId,
        policy_version: event.policyVersion,
      },
    );
  }
}

// ------------------------------------------------------------------ metrics ---

export type MetricName =
  | 'sandbox_created'
  | 'sandbox_create_failed'
  | 'sandbox_started'
  | 'sandbox_start_total_ms'
  | 'sandbox_destroyed'
  | 'sandbox_recovered'
  | 'sandbox_recovery_failed'
  | 'execution_total'
  | 'execution_succeeded'
  | 'execution_failed'
  | 'execution_timeout'
  | 'execution_cancelled'
  | 'execution_unknown'
  | 'execution_duplicate'
  | 'policy_denied'
  | 'approval_required'
  | 'approval_granted'
  | 'resource_limit_triggered'
  | 'network_blocked'
  | 'reconciliation_succeeded'
  | 'reconciliation_failed'
  | 'permission_allowed'
  | 'permission_denied'
  | 'permission_escalated'
  | 'permission_auto_approved'
  | 'permission_auto_denied'
  | 'permission_human_approved'
  | 'permission_human_denied'
  | 'permission_grant_revoked'
  | 'permission_fail_closed';

export class SandboxMetrics {
  private readonly counters = new Map<MetricName, number>();
  private readonly startedAt = Date.now();

  increment(name: MetricName, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  /**
   * Rate helper. Every metric is a counter; a rate is only meaningful when the
   * denominator is present, so `null` is returned rather than `0` for an empty
   * denominator. "No executions" and "0% succeeded" are different facts.
   */
  snapshot(): Record<string, number | null> {
    const get = (name: MetricName) => this.counters.get(name) ?? 0;
    const total = get('execution_total');
    const created = get('sandbox_created');
    const recovered = get('sandbox_recovered');
    return {
      uptime_ms: Date.now() - this.startedAt,
      sandbox_created: created,
      sandbox_create_failed: get('sandbox_create_failed'),
      sandbox_creation_success_rate: created + get('sandbox_create_failed') === 0
        ? null
        : Number((created / (created + get('sandbox_create_failed'))).toFixed(4)),
      sandbox_start_total_ms: get('sandbox_start_total_ms'),
      sandbox_start_latency_ms: created === 0 ? null : Number((get('sandbox_start_total_ms') / created).toFixed(1)),
      sandbox_destroyed: get('sandbox_destroyed'),
      sandbox_recovered: recovered,
      sandbox_recovery_success_rate: recovered + get('sandbox_recovery_failed') === 0
        ? null
        : Number((recovered / (recovered + get('sandbox_recovery_failed'))).toFixed(4)),
      execution_total: total,
      execution_success_rate: total === 0 ? null : Number((get('execution_succeeded') / total).toFixed(4)),
      execution_unknown: get('execution_unknown'),
      execution_duplicate: get('execution_duplicate'),
      duplicate_execution_rate: total === 0 ? null : Number((get('execution_duplicate') / total).toFixed(4)),
      unauthorized_access_block_rate:
        get('policy_denied') + get('network_blocked') === 0
          ? null
          : Number(
              (
                (get('policy_denied') + get('network_blocked')) /
                Math.max(1, total + get('policy_denied') + get('network_blocked'))
              ).toFixed(4),
            ),
      resource_limit_triggered: get('resource_limit_triggered'),
      permission_allowed: get('permission_allowed'),
      permission_denied: get('permission_denied'),
      permission_escalated: get('permission_escalated'),
      permission_auto_approved: get('permission_auto_approved'),
      permission_auto_denied: get('permission_auto_denied'),
      permission_human_approved: get('permission_human_approved'),
      permission_human_denied: get('permission_human_denied'),
      permission_fail_closed: get('permission_fail_closed'),
    };
  }
}
