/**
 * Recovery Manager: the part that answers "what was happening when the process
 * died?" without guessing.
 *
 * Four recoveries are kept distinct (ADR §10.3):
 *
 *   - Session recovery belongs to the conversation layer; this module does not
 *     touch messages.
 *   - Sandbox recovery inspects the runtime and either reconnects or rebuilds.
 *   - Workspace recovery verifies the persistent directory and refuses to
 *     rebuild over a workspace that is gone.
 *   - Execution recovery reconciles unfinished rows; an outcome nobody observed
 *     stays UNKNOWN.
 *
 * The one thing recovery must never do is replay a command. A retry is a new
 * decision by the model (or an operator), not something a crash handler infers.
 */

import type { SandboxStore } from './store.ts';
import type { RuntimeSandboxConfig, Sandbox, Workspace } from './types.ts';
import { ACTIVE_SANDBOX_STATES, isTerminalExecution } from './state.ts';
import type { SandboxController } from './controller.ts';
import type { WorkspaceManager } from './workspace-manager.ts';
import type { AuditLog, SandboxMetrics } from './audit.ts';

export interface RecoveryManagerDeps {
  readonly store: SandboxStore;
  readonly controller: SandboxController;
  readonly workspaces: WorkspaceManager;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  /** Provided by the Gateway: compiles policy + credentials into runtime config. */
  readonly configFor: (sandbox: Sandbox, workspace: Workspace) => Promise<RuntimeSandboxConfig>;
  /** Provided by the Gateway so recovery uses the same reconciliation rules. */
  readonly reconcileExecution: (sandboxId: string, executionId: string) => Promise<unknown>;
}

export interface RecoveryReport {
  readonly sandboxesChecked: number;
  readonly sandboxesRecovered: number;
  readonly sandboxesFailed: number;
  readonly executionsChecked: number;
  readonly executionsReconciled: number;
  readonly executionsUnknown: number;
  readonly details: readonly string[];
}

export class RecoveryManager {
  private readonly deps: RecoveryManagerDeps;

  constructor(deps: RecoveryManagerDeps) {
    this.deps = deps;
  }

  /**
   * Recover every sandbox the database still believes in.
   *
   * Called on process start and by the ops CLI. Idempotent: reconnecting an
   * already-running sandbox is a successful recovery, and a second run finds
   * nothing left to do.
   */
  async recoverAll(): Promise<RecoveryReport> {
    const sandboxes = await this.deps.store.listSandboxes(ACTIVE_SANDBOX_STATES);
    const details: string[] = [];
    let recovered = 0;
    let failed = 0;

    for (const rawSandbox of sandboxes) {
      let sandbox = rawSandbox;
      // A crash during create/terminate leaves a state that `recover()` cannot
      // transition from. Resolve it explicitly instead of leaving the row stuck.
      if (sandbox.status === 'EXPIRED' || sandbox.status === 'TERMINATING') {
        await this.deps.controller.destroy(sandbox).catch(() => undefined);
        details.push(`${sandbox.sandboxId}: ${sandbox.status} -> DESTROYED`);
        continue;
      }
      if (sandbox.status === 'CREATING') {
        const failed = await this.deps.store.updateSandbox(sandbox.sandboxId, { status: 'FAILED' });
        if (failed) sandbox = failed;
      }
      const workspace = await this.deps.store.getWorkspace(sandbox.workspaceId);
      if (!workspace) {
        failed += 1;
        details.push(`${sandbox.sandboxId}: workspace missing`);
        await this.markUnrecoverable(sandbox, 'workspace record is missing');
        continue;
      }
      const verified = await this.deps.workspaces.verify(workspace);
      if (!verified.ok) {
        failed += 1;
        details.push(`${sandbox.sandboxId}: workspace unreadable (${verified.detail})`);
        await this.markUnrecoverable(sandbox, verified.detail);
        continue;
      }
      try {
        const config = await this.deps.configFor(sandbox, workspace);
        await this.deps.controller.recover(sandbox, config);
        recovered += 1;
        details.push(`${sandbox.sandboxId}: recovered -> READY`);
      } catch (error) {
        failed += 1;
        details.push(
          `${sandbox.sandboxId}: recovery failed (${error instanceof Error ? error.message : String(error)})`,
        );
        this.deps.metrics.increment('sandbox_recovery_failed');
      }
    }

    // Executions can outlive their sandbox row only in a corrupted database, but
    // an unfinished execution in any sandbox must still be reconciled.
    const unfinished = await this.deps.store.listUnfinishedExecutions();
    let reconciled = 0;
    let unknown = 0;
    for (const execution of unfinished) {
      const sandbox = await this.deps.store.getSandbox(execution.sandboxId);
      if (!sandbox) {
        unknown += 1;
        details.push(`${execution.executionId}: sandbox missing; remains UNKNOWN`);
        continue;
      }
      try {
        const result = await this.deps.reconcileExecution(execution.sandboxId, execution.executionId);
        const current = result && typeof result === 'object' && 'status' in result
          ? String((result as { status: unknown }).status)
          : 'UNKNOWN';
        reconciled += 1;
        if (current === 'UNKNOWN' || !isTerminalExecution(current as never)) {
          unknown += 1;
        }
      } catch (error) {
        unknown += 1;
        details.push(
          `${execution.executionId}: reconciliation failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    const report: RecoveryReport = {
      sandboxesChecked: sandboxes.length,
      sandboxesRecovered: recovered,
      sandboxesFailed: failed,
      executionsChecked: unfinished.length,
      executionsReconciled: reconciled,
      executionsUnknown: unknown,
      details,
    };
    await this.deps.audit.record({
      action: 'recovery.sweep',
      outcome: failed > 0 ? 'failed' : 'succeeded',
      detail: { ...report, details: undefined },
    });
    return report;
  }

  private async markUnrecoverable(sandbox: Sandbox, reason: string): Promise<void> {
    await this.deps.store.updateSandbox(sandbox.sandboxId, { status: 'FAILED' });
    await this.deps.store.updateTask(sandbox.taskId, { status: 'PAUSED' });
    this.deps.metrics.increment('sandbox_recovery_failed');
    await this.deps.audit.record({
      taskId: sandbox.taskId,
      sandboxId: sandbox.sandboxId,
      action: 'recovery.unrecoverable',
      outcome: 'failed',
      detail: { reason },
    });
  }
}
