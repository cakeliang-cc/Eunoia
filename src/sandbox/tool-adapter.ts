/**
 * The bridge between the tool system and the Sandbox Gateway.
 *
 * Tools speak `ToolWorkspacePort` and `ToolExecutor`; the Gateway speaks
 * `SandboxContext`. This adapter is the only place the two vocabularies meet, so
 * the agent loop does not import the sandbox module and a tool cannot acquire a
 * second execution path.
 *
 * Two laziness properties matter:
 *
 *   - **No container for a read.** A turn that only lists files never creates a
 *     container. The workspace exists after `ensureTask`, and file operations go
 *     through the Gateway's authorization without a runtime.
 *   - **No turn failure for a missing runtime.** A read on a machine without a
 *     configured runtime still works; a command fails with a model-visible
 *     "sandbox unavailable" and the loop continues, which is the fail-closed
 *     behaviour ADR §19 asks for.
 */

import { randomUUID } from 'node:crypto';
import { relative as pathRelative } from 'node:path';
import type { SandboxContext, SandboxGateway } from './gateway.ts';
import type {
  ToolCwdChange,
  ToolCwdPort,
  ToolCwdSnapshot,
  ToolDirectoryListing,
  ToolEditResult,
  ToolExecutionResult,
  ToolExecutor,
  ToolFileSlice,
  ToolGrepResult,
  ToolSandboxSession,
  ToolWorkspacePort,
  ToolWriteResult,
} from '../tools/types.ts';
import { WORKSPACE_MOUNT_PATH } from './types.ts';

export interface SandboxToolTarget {
  readonly taskId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SandboxToolProvider {
  forTask(target: SandboxToolTarget): Promise<ToolSandboxSession>;
}

/**
 * Create the provider the composition root hands to the chat service.
 *
 * The task id is the conversation id. Keeping that mapping here — rather than in
 * the tool schemas — is why a model cannot address another task's files: no tool
 * argument names a task.
 */
export function createSandboxToolProvider(gateway: SandboxGateway): SandboxToolProvider {
  return {
    async forTask(target: SandboxToolTarget): Promise<ToolSandboxSession> {
      const session = new GatewayToolSession(gateway, {
        taskId: target.taskId,
        sessionId: target.sessionId,
        userId: target.userId,
      });
      // Ensure the task/workspace eagerly so `load_skill` can map a host path to
      // a workspace path synchronously. This does not create a container: a
      // read-only turn still runs without a runtime.
      try {
        await gateway.ensureTask({
          taskId: target.taskId,
          sessionId: target.sessionId,
          userId: target.userId,
        });
        session.setWorkspaceRoot(await gateway.workspaceLocation(session.context));
      } catch {
        // The first tool call reports the concrete failure. A turn must not die
        // before the model has a chance to say what went wrong.
      }
      return session;
    },
  };
}

class GatewayToolSession implements ToolWorkspacePort, ToolExecutor, ToolCwdPort {
  readonly displayPath = WORKSPACE_MOUNT_PATH;
  readonly workspace: ToolWorkspacePort;
  readonly executor: ToolExecutor;
  readonly cwd: ToolCwdPort;

  private readonly gateway: SandboxGateway;
  readonly context: SandboxContext;
  private sandboxId: string | null = null;
  private taskReady = false;
  private workspaceRoot: string | null = null;

  constructor(gateway: SandboxGateway, context: SandboxContext) {
    this.gateway = gateway;
    this.context = context;
    this.workspace = this;
    this.executor = this;
    this.cwd = this;
  }

  /** Called by the provider once the task's workspace is known. */
  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  relative(hostPath: string): string {
    if (!this.workspaceRoot) return hostPath;
    return pathRelative(this.workspaceRoot, hostPath);
  }

  async readLines(input: string, start?: number, end?: number): Promise<ToolFileSlice> {
    return this.gateway.readFile(await this.ready(), input, start ?? 1, end ?? 0);
  }

  async listDir(input = '.', depth = 2): Promise<ToolDirectoryListing> {
    return this.gateway.listDir(await this.ready(), input, depth);
  }

  async glob(pattern: string, maxResults = 200): Promise<{ paths: string[]; truncated: boolean }> {
    return this.gateway.glob(await this.ready(), pattern, maxResults);
  }

  async grep(options: {
    pattern: string;
    path?: string;
    include?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<ToolGrepResult> {
    return this.gateway.grep(await this.ready(), options);
  }

  async writeText(input: string, content: string): Promise<ToolWriteResult> {
    return this.gateway.writeFile(await this.ready(), input, content);
  }

  async editText(options: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<ToolEditResult> {
    return this.gateway.editFile(await this.ready(), options);
  }

  // --------------------------------------------------------- task cwd (021) ---

  async change(input: { readonly path: string; readonly operationId?: string }): Promise<ToolCwdChange> {
    // Warm the task/workspace first so the error a first call reports is about
    // the directory, not about a workspace that was never created.
    await this.ready().catch(() => undefined);
    return this.gateway.changeDirectory(this.call(), {
      path: input.path,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
  }

  async current(): Promise<ToolCwdSnapshot> {
    return this.gateway.currentDirectory(this.call());
  }

  async run(input: {
    readonly command: readonly string[];
    readonly shell?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly toolCallId: string;
  }): Promise<ToolExecutionResult> {
    const started = Date.now();
    const sandboxId = await this.ensureSandbox();
    // ADR 021 §6.2: the cwd is read from the task context *here*, at execution
    // creation, and frozen into the execution. The model never passes one.
    const cwd = await this.gateway.currentDirectory(this.call());
    const result = await this.gateway.execute(
      this.call(input.toolCallId),
      {
        sandboxId,
        executionId: `exec_${randomUUID()}`,
        idempotencyKey: input.toolCallId,
        command: input.command,
        cwd: cwd.cwd,
        cwdVersion: cwd.cwdVersion,
        timeoutMs: input.timeoutMs ?? 120_000,
        shell: input.shell ?? false,
        toolCallId: input.toolCallId,
      },
      input.signal ? { signal: input.signal } : {},
    );
    return {
      status: result.status,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.status === 'TIMEOUT',
      durationMs: Date.now() - started,
      executionId: result.executionId,
    };
  }

  private call(toolCallId?: string): SandboxContext {
    return {
      ...this.context,
      ...(toolCallId ? { toolCallId } : {}),
    };
  }

  /** Ensure the task and workspace once; file reads do not need a container. */
  private async ready(): Promise<SandboxContext> {
    if (!this.taskReady) {
      await this.gateway.ensureTask({
        taskId: this.context.taskId,
        sessionId: this.context.sessionId ?? this.context.taskId,
        userId: this.context.userId ?? 'unknown',
      });
      this.taskReady = true;
      this.workspaceRoot ??= await this.gateway.workspaceLocation(this.context);
    }
    return this.call();
  }

  private async ensureSandbox(): Promise<string> {
    if (this.sandboxId) return this.sandboxId;
    await this.ready();
    const sandbox = await this.gateway.ensureSandbox(this.call());
    this.sandboxId = sandbox.sandboxId;
    return sandbox.sandboxId;
  }
}
