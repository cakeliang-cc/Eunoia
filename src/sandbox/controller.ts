/**
 * The Sandbox Controller: the only component that owns a sandbox's lifecycle.
 *
 * Every status change goes through here, and every change is a compare-and-set
 * on the store plus an audit row. That is what makes "Controller restarted and
 * rescanned the runtime" possible: the database says what the platform believed,
 * the runtime says what actually exists, and recovery reconciles the two.
 *
 * The Controller does not receive OCI configuration from a caller. It receives a
 * resolved `RuntimeSandboxConfig` from the Gateway (already compiled from a
 * policy) and hands it to the Runtime Manager. It never sees a host path chosen
 * by the model.
 */

import type { SandboxStore } from './store.ts';
import type {
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeSandboxConfig,
  Sandbox,
  SandboxHandle,
  SandboxRuntime,
  Workspace,
} from './types.ts';
import { ACTIVE_SANDBOX_STATES, canTransitionSandbox } from './state.ts';
import { SandboxConflictError, SandboxRuntimeUnavailableError } from './errors.ts';
import type { SandboxMetrics } from './audit.ts';
import { AuditLog } from './audit.ts';
import type { WorkspaceManager } from './workspace-manager.ts';
import { sandboxContainerName } from './runtime/oci-args.ts';

/** Later layers provide this: policy + credentials → structured runtime config. */
export type RuntimeConfigResolver = (
  sandbox: Sandbox,
  workspace: Workspace,
) => Promise<RuntimeSandboxConfig>;

export interface SandboxControllerDeps {
  readonly store: SandboxStore;
  readonly runtime: SandboxRuntime;
  readonly workspaces: WorkspaceManager;
  readonly metrics: SandboxMetrics;
  readonly audit: AuditLog;
  readonly now?: () => Date;
}

export interface HeartbeatReport {
  readonly checked: number;
  readonly alive: number;
  readonly interrupted: number;
}

export class SandboxController {
  private readonly store: SandboxStore;
  private readonly runtime: SandboxRuntime;
  private readonly workspaces: WorkspaceManager;
  private readonly metrics: SandboxMetrics;
  private readonly audit: AuditLog;
  private readonly now: () => Date;
  /**
   * One lifecycle operation per sandbox at a time.
   *
   * Recovery at startup and a tool call that arrives at the same moment would
   * otherwise both decide the container is missing and both try to create it;
   * the second would remove the first's container because it holds the name.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(deps: SandboxControllerDeps) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.workspaces = deps.workspaces;
    this.metrics = deps.metrics;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * A byte tunnel to one loopback port inside a running sandbox.
   *
   * It is deliberately not an execution: it creates no execution row, gets no
   * command permission and cannot run a program. Preview service is its only
   * caller, after it has resolved a lease.
   */
  async openTunnel(
    handle: SandboxHandle,
    port: number,
    signal?: AbortSignal,
  ): Promise<import('node:stream').Duplex> {
    if (!this.runtime.openTunnel) {
      throw new SandboxRuntimeUnavailableError('the runtime does not support preview tunnels');
    }
    return this.runtime.openTunnel(handle, port, signal);
  }

  get runtimeType(): string {
    return this.runtime.type;
  }

  /** Create and start a sandbox. The caller has already persisted CREATING. */
  async create(sandbox: Sandbox, config: RuntimeSandboxConfig): Promise<Sandbox> {
    return this.withLock(sandbox.sandboxId, () => this.createUnlocked(sandbox, config));
  }

  private async createUnlocked(sandbox: Sandbox, config: RuntimeSandboxConfig): Promise<Sandbox> {
    const startedAt = Date.now();
    let handle: SandboxHandle | null = null;
    try {
      handle = await this.runtime.create(config);
      await this.runtime.start(handle);
      const status = await this.runtime.inspect(handle);
      if (!status.exists || !status.running) {
        throw new SandboxRuntimeUnavailableError(
          `sandbox container did not start (${status.detail ?? 'not running'})`,
        );
      }
      const updated = await this.store.updateSandbox(sandbox.sandboxId, {
        status: 'READY',
        runtimeId: handle.runtimeId,
        runtimeType: handle.runtimeType,
        configDigest: config.configDigest,
        lastHeartbeatAt: this.now().toISOString(),
      });
      this.metrics.increment('sandbox_created');
      this.metrics.increment('sandbox_start_total_ms', Date.now() - startedAt);
      await this.audit.record({
        taskId: sandbox.taskId,
        sandboxId: sandbox.sandboxId,
        policyVersion: sandbox.policyVersion,
        action: 'sandbox.create',
        outcome: 'succeeded',
        detail: {
          runtime: handle.runtimeType,
          runtime_id: handle.runtimeId,
          image: sandbox.imageDigest,
          start_ms: Date.now() - startedAt,
        },
      });
      return updated as Sandbox;
    } catch (error) {
      if (handle) await this.runtime.destroy(handle).catch(() => undefined);
      await this.store
        .updateSandbox(sandbox.sandboxId, { status: 'FAILED' })
        .catch(() => undefined);
      this.metrics.increment('sandbox_create_failed');
      await this.audit.record({
        taskId: sandbox.taskId,
        sandboxId: sandbox.sandboxId,
        policyVersion: sandbox.policyVersion,
        action: 'sandbox.create',
        outcome: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /**
   * Return a running handle, recovering the sandbox when it is not running.
   *
   * `FAILED` is recoverable here on purpose: a failed container can be rebuilt
   * from the same workspace and metadata, which is the whole point of keeping
   * workspace identity separate from sandbox identity.
   */
  async ensureRunning(sandbox: Sandbox, config: RuntimeSandboxConfig): Promise<SandboxHandle> {
    return this.withLock(sandbox.sandboxId, () => this.ensureRunningUnlocked(sandbox, config));
  }

  private async ensureRunningUnlocked(
    sandbox: Sandbox,
    config: RuntimeSandboxConfig,
  ): Promise<SandboxHandle> {
    if (sandbox.status === 'READY' || sandbox.status === 'RUNNING') {
      const handle = this.handleOf(sandbox);
      const status = await this.runtime.inspect(handle);
      if (status.exists && status.running) {
        if (sandbox.configDigest && sandbox.configDigest !== config.configDigest) {
          // The policy changed while this container was alive (for example a
          // switch to read-only). Reconnecting would keep the old, wider mount;
          // destroy and rebuild under the current config (ADR 020 §12.2).
          await this.runtime.destroy(handle).catch(() => undefined);
          const marked = await this.store.updateSandbox(sandbox.sandboxId, {
            status: 'INTERRUPTED',
          });
          return this.recoverUnlocked(marked ?? { ...sandbox, status: 'INTERRUPTED' }, config);
        }
        if (sandbox.status === 'RUNNING') {
          await this.store.updateSandbox(sandbox.sandboxId, { status: 'READY' });
        }
        await this.runtime.configureNetwork?.(handle, config);
        return handle;
      }
    }
    return this.recoverUnlocked(sandbox, config);
  }

  /** Inspect the real runtime, reconnect or rebuild, and return a live handle. */
  async recover(sandbox: Sandbox, config: RuntimeSandboxConfig): Promise<SandboxHandle> {
    return this.withLock(sandbox.sandboxId, () => this.recoverUnlocked(sandbox, config));
  }

  private async recoverUnlocked(sandbox: Sandbox, config: RuntimeSandboxConfig): Promise<SandboxHandle> {
    if (!canTransitionSandbox(sandbox.status, 'RECOVERING')) {
      throw new SandboxConflictError(
        `sandbox ${sandbox.sandboxId} cannot recover from ${sandbox.status}`,
      );
    }
    await this.store.updateSandbox(sandbox.sandboxId, { status: 'RECOVERING' });

    const workspace = await this.store.getWorkspace(sandbox.workspaceId);
    if (!workspace) {
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'FAILED' });
      this.metrics.increment('sandbox_recovery_failed');
      throw new SandboxConflictError(`workspace ${sandbox.workspaceId} is missing`);
    }
    const verified = await this.workspaces.verify(workspace);
    if (!verified.ok) {
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'FAILED' });
      this.metrics.increment('sandbox_recovery_failed');
      await this.audit.record({
        taskId: sandbox.taskId,
        sandboxId: sandbox.sandboxId,
        action: 'sandbox.recover',
        outcome: 'failed',
        detail: { reason: 'workspace unavailable', detail: verified.detail },
      });
      throw new SandboxConflictError(`workspace is unavailable: ${verified.detail}`);
    }

    const existing = this.handleOf(sandbox);
    const status = await this.runtime.inspect(existing).catch(() => ({
      exists: false,
      running: false,
      exitCode: null,
    }));
    if (status.exists && status.running) {
      if (sandbox.configDigest && sandbox.configDigest !== config.configDigest) {
        // Same rule as `ensureRunning`: a container that does not match the
        // current policy is not a valid recovery target.
        await this.runtime.destroy(existing).catch(() => undefined);
      } else {
        await this.runtime.configureNetwork?.(existing, config);
        const updated = await this.store.updateSandbox(sandbox.sandboxId, {
          status: 'READY',
          configDigest: config.configDigest,
          lastHeartbeatAt: this.now().toISOString(),
        });
        this.metrics.increment('sandbox_recovered');
        await this.audit.record({
          taskId: sandbox.taskId,
          sandboxId: sandbox.sandboxId,
          action: 'sandbox.recover',
          outcome: 'succeeded',
          detail: { mode: 'reconnect', runtime_id: existing.runtimeId },
        });
        return this.handleOf(updated as Sandbox);
      }
    }

    // Missing or stopped: the workspace is intact, so the runtime can be rebuilt
    // under the same sandbox identity and the same mount.
    let handle: SandboxHandle | null = null;
    try {
      handle = await this.runtime.create(config);
      await this.runtime.start(handle);
      const started = await this.runtime.inspect(handle);
      if (!started.exists || !started.running) {
        throw new SandboxRuntimeUnavailableError('rebuilt sandbox did not start');
      }
      const updated = await this.store.updateSandbox(sandbox.sandboxId, {
        status: 'READY',
        runtimeId: handle.runtimeId,
        runtimeType: handle.runtimeType,
        configDigest: config.configDigest,
        lastHeartbeatAt: this.now().toISOString(),
      });
      this.metrics.increment('sandbox_recovered');
      await this.audit.record({
        taskId: sandbox.taskId,
        sandboxId: sandbox.sandboxId,
        action: 'sandbox.recover',
        outcome: 'succeeded',
        detail: { mode: 'rebuild', runtime_id: handle.runtimeId },
      });
      return this.handleOf(updated as Sandbox);
    } catch (error) {
      if (handle) await this.runtime.destroy(handle).catch(() => undefined);
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'FAILED' }).catch(() => undefined);
      this.metrics.increment('sandbox_recovery_failed');
      await this.audit.record({
        taskId: sandbox.taskId,
        sandboxId: sandbox.sandboxId,
        action: 'sandbox.recover',
        outcome: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async execute(
    handle: SandboxHandle,
    request: RuntimeExecutionRequest,
  ): Promise<RuntimeExecutionResult> {
    return this.runtime.execute(handle, request);
  }

  async inspect(sandbox: Sandbox): Promise<{
    readonly exists: boolean;
    readonly running: boolean;
    readonly detail: string;
  }> {
    const status = await this.runtime.inspect(this.handleOf(sandbox));
    return {
      exists: status.exists,
      running: status.running,
      detail: status.detail ?? '',
    };
  }

  async interrupt(sandbox: Sandbox, executionId: string): Promise<void> {
    return this.withLock(sandbox.sandboxId, () => this.interruptUnlocked(sandbox, executionId));
  }

  private async interruptUnlocked(sandbox: Sandbox, executionId: string): Promise<void> {
    await this.runtime.interrupt(this.handleOf(sandbox), executionId);
    if (sandbox.status === 'RUNNING' || sandbox.status === 'READY') {
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'INTERRUPTED' });
    }
    await this.audit.record({
      taskId: sandbox.taskId,
      sandboxId: sandbox.sandboxId,
      executionId,
      action: 'sandbox.interrupt',
      outcome: 'allowed',
      detail: { execution_id: executionId },
    });
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    return this.withLock(sandbox.sandboxId, () => this.destroyUnlocked(sandbox));
  }

  private async destroyUnlocked(sandbox: Sandbox): Promise<void> {
    if (sandbox.status === 'DESTROYED') return;
    await this.store.updateSandbox(sandbox.sandboxId, { status: 'TERMINATING' });
    await this.runtime.destroy(this.handleOf(sandbox)).catch(() => undefined);
    await this.store.updateSandbox(sandbox.sandboxId, { status: 'DESTROYED' });
    this.metrics.increment('sandbox_destroyed');
    await this.audit.record({
      taskId: sandbox.taskId,
      sandboxId: sandbox.sandboxId,
      action: 'sandbox.destroy',
      outcome: 'succeeded',
      detail: { workspace: sandbox.workspaceId, note: 'workspace is retained' },
    });
  }

  /**
   * Periodic inspection.
   *
   * A heartbeat timeout is not a task failure. The Controller asks the runtime
   * what it actually has and moves a sandbox to `INTERRUPTED` only when the
   * runtime says it is gone or stopped. The next execution then recovers it.
   */
  async heartbeat(): Promise<HeartbeatReport> {
    const sandboxes = await this.store.listSandboxes(ACTIVE_SANDBOX_STATES);
    let alive = 0;
    let interrupted = 0;
    for (const sandbox of sandboxes) {
      // EXPIRED/TERMINATING are already being retired; a missing container is
      // expected and must not be rewritten to INTERRUPTED.
      if (sandbox.status === 'EXPIRED' || sandbox.status === 'TERMINATING') continue;
      // Heartbeat must not race a create/recover: an empty runtime during
      // CREATING is normal, and marking it INTERRUPTED mid-create would make the
      // next execution rebuild a container that is already being built.
      await this.withLock(sandbox.sandboxId, async () => {
        const status = await this.runtime.inspect(this.handleOf(sandbox)).catch(() => ({
          exists: false,
          running: false,
          exitCode: null,
          detail: 'inspect failed',
        }));
        if (status.exists && status.running) {
          alive += 1;
          await this.store.touchSandboxHeartbeat(sandbox.sandboxId, this.now().toISOString());
          return;
        }
        interrupted += 1;
        if (sandbox.status !== 'INTERRUPTED' && sandbox.status !== 'FAILED') {
          await this.store.updateSandbox(sandbox.sandboxId, { status: 'INTERRUPTED' });
          await this.audit.record({
            taskId: sandbox.taskId,
            sandboxId: sandbox.sandboxId,
            action: 'sandbox.heartbeat',
            outcome: 'failed',
            detail: { reason: status.detail ?? 'runtime not running' },
          });
        }
      });
    }
    return { checked: sandboxes.length, alive, interrupted };
  }

  /** Read the exit marker an execution wrapper wrote, for reconciliation. */
  async readExitMarker(sandbox: Sandbox, executionId: string): Promise<number | null> {
    return this.runtime.readExitMarker(this.handleOf(sandbox), executionId);
  }

  /** Serialise lifecycle work for one sandbox. */
  private async withLock<T>(sandboxId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sandboxId) ?? Promise.resolve();
    const current = previous.then(
      () => run(),
      () => run(),
    );
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sandboxId, tail);
    try {
      return await current;
    } finally {
      if (this.locks.get(sandboxId) === tail) this.locks.delete(sandboxId);
    }
  }

  handleOf(sandbox: Sandbox): SandboxHandle {
    return {
      sandboxId: sandbox.sandboxId,
      runtimeId: sandbox.runtimeId || sandboxContainerName(sandbox.sandboxId),
      runtimeType: sandbox.runtimeType || this.runtime.type,
    };
  }
}
