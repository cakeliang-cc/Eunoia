/**
 * A deterministic runtime for control-plane tests.
 *
 * ADR §16.3 says a mock cannot prove sandbox security, and it is right: this
 * provider is never wired by a composition root and its `probe()` reports
 * `fake` so an integration test can refuse it. What it *can* do is exercise the
 * Gateway's idempotency, state transitions, recovery and UNKNOWN reconciliation
 * without Docker, which is where the interesting bugs in this platform live.
 */

import {
  type RuntimeExecutionRequest,
  type RuntimeExecutionResult,
  type RuntimeSandboxConfig,
  type RuntimeStatus,
  type SandboxHandle,
  type SandboxRuntime,
} from '../types.ts';

export interface FakeScript {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  readonly hang?: boolean;
  readonly throwUnavailable?: boolean;
}

export class FakeRuntime implements SandboxRuntime {
  readonly type = 'fake';
  readonly created: RuntimeSandboxConfig[] = [];
  readonly destroyed: string[] = [];
  readonly interrupted: string[] = [];
  executed: RuntimeExecutionRequest[] = [];

  private readonly containers = new Map<string, { running: boolean; exitCode: number | null }>();
  private readonly markers = new Map<string, number>();
  private readonly scripts = new Map<string, FakeScript>();
  private scriptFor: ((request: RuntimeExecutionRequest) => FakeScript) | null = null;
  private probeResult: { ok: boolean; detail: string } = { ok: true, detail: 'fake runtime' };

  setProbe(result: { ok: boolean; detail: string }): void {
    this.probeResult = result;
  }

  setDefaultScript(fn: (request: RuntimeExecutionRequest) => FakeScript): void {
    this.scriptFor = fn;
  }

  setScript(command: string, script: FakeScript): void {
    this.scripts.set(command, script);
  }

  setMarker(executionId: string, exitCode: number): void {
    this.markers.set(executionId, exitCode);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return this.probeResult;
  }

  async create(config: RuntimeSandboxConfig): Promise<SandboxHandle> {
    this.created.push(config);
    this.containers.set(config.sandboxId, { running: true, exitCode: null });
    return { sandboxId: config.sandboxId, runtimeId: `fake-${config.sandboxId}`, runtimeType: this.type };
  }

  async start(): Promise<void> {
    // A fake container is started by `create`.
  }

  async execute(
    handle: SandboxHandle,
    request: RuntimeExecutionRequest,
  ): Promise<RuntimeExecutionResult> {
    this.executed.push(request);
    const container = this.containers.get(handle.sandboxId);
    if (!container?.running) {
      throw new Error(`fake container is not running: ${handle.sandboxId}`);
    }
    const script =
      this.scripts.get(request.command.join(' ')) ??
      this.scriptFor?.(request) ??
      { exitCode: 0, stdout: `ok: ${request.command.join(' ')}` };

    const startedAt = new Date().toISOString();

    if (script.throwUnavailable) {
      throw new Error('fake runtime unavailable');
    }

    if (script.hang) {
      await new Promise<void>((resolvePromise) => {
        const finish = () => resolvePromise();
        request.signal?.addEventListener('abort', finish, { once: true });
        // A hang test always aborts; a timeout would leave the promise pending
        // forever and make the failure a test-harness hang instead of an assertion.
        setTimeout(finish, 5_000).unref();
      });
      const aborted = request.signal?.aborted === true;
      return {
        status: aborted ? 'CANCELLED' : 'UNKNOWN',
        exitCode: null,
        stdout: '',
        stderr: '',
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut: false,
      };
    }

    if (script.timedOut) {
      return {
        status: 'TIMEOUT',
        exitCode: null,
        stdout: script.stdout ?? '',
        stderr: script.stderr ?? '',
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut: true,
      };
    }

    const exitCode = script.exitCode ?? 0;
    this.markers.set(request.executionId, exitCode);
    return {
      status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
      exitCode,
      stdout: script.stdout ?? '',
      stderr: script.stderr ?? '',
      startedAt,
      finishedAt: new Date().toISOString(),
      timedOut: false,
    };
  }

  async inspect(handle: SandboxHandle): Promise<RuntimeStatus> {
    const container = this.containers.get(handle.sandboxId);
    return container
      ? { exists: true, running: container.running, exitCode: container.exitCode }
      : { exists: false, running: false, exitCode: null, detail: 'missing' };
  }

  async interrupt(handle: SandboxHandle): Promise<void> {
    this.interrupted.push(handle.sandboxId);
    const container = this.containers.get(handle.sandboxId);
    if (container) container.running = false;
  }

  async readExitMarker(_handle: SandboxHandle, executionId: string): Promise<number | null> {
    return this.markers.get(executionId) ?? null;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.destroyed.push(handle.sandboxId);
    this.containers.delete(handle.sandboxId);
  }
}
