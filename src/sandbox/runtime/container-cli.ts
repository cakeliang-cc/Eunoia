/**
 * A thin, auditable wrapper around the container CLI.
 *
 * Only this module and `oci-runtime.ts` spawn a container client. Everything
 * above them deals in structured config, never in argv. That boundary is what
 * makes "the Runtime Manager is the only component that may touch the container
 * runtime" a property a test can check.
 *
 * Credentials are passed through a mode-0600 environment *file*, never `--env`
 * on the command line: argv is visible in `ps` and in shell history.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SandboxRuntimeUnavailableError } from '../errors.ts';

export interface CliRunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
}

export class ContainerCli {
  readonly binary: string;
  readonly kind: 'docker' | 'nerdctl';
  readonly globalArgs: readonly string[];

  constructor(input: { binary: string; kind: 'docker' | 'nerdctl'; globalArgs?: readonly string[] }) {
    this.binary = input.binary;
    this.kind = input.kind;
    this.globalArgs = input.globalArgs ?? [];
  }

  async run(args: readonly string[], options: CliRunOptions = {}): Promise<CliResult> {
    const startedAt = Date.now();
    const limit = Math.max(1_024, options.maxOutputBytes ?? 512 * 1024);

    return new Promise<CliResult>((resolvePromise, reject) => {
      const child = spawn(this.binary, [...this.globalArgs, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          LANG: 'C.UTF-8',
        },
      });

      const stdout = new BoundedTail(limit);
      const stderr = new BoundedTail(limit);
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, Math.max(1, options.timeoutMs))
        : null;
      timer?.unref();

      const onAbort = () => {
        aborted = true;
        child.kill('SIGKILL');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const finish = (result: CliResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const code = (error as NodeJS.ErrnoException).code;
        reject(
          new SandboxRuntimeUnavailableError(
            code === 'ENOENT'
              ? `container runtime client not found: ${this.binary}`
              : `could not start ${this.binary}: ${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        finish({
          code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  /**
   * Start a long-lived byte stream (`exec -i`) for the preview tunnel.
   *
   * The caller owns the child and must kill it. Only the tunnel helper uses
   * this; no lifecycle call and no model-facing tool reaches it.
   */
  spawnStream(args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(this.binary, [...this.globalArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? tmpdir(),
        LANG: 'C.UTF-8',
      },
    });
  }

  /** Run and throw on a non-zero exit; used by lifecycle calls. */
  async runChecked(args: readonly string[], options: CliRunOptions = {}): Promise<CliResult> {
    const result = await this.run(args, options);
    if (result.timedOut) {
      throw new SandboxRuntimeUnavailableError(`${this.binary} ${args[0] ?? ''} timed out`);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 500);
      throw new SandboxRuntimeUnavailableError(
        `${this.binary} ${args[0] ?? ''} failed with ${result.code}: ${detail}`,
      );
    }
    return result;
  }

  /**
   * Write an environment file for `--env-file`, mode 0600.
   *
   * Returns null for an empty environment so the caller can omit the flag. The
   * file is deleted by `withEnvFile` immediately after the command starts.
   */
  async writeEnvFile(env: Readonly<Record<string, string>>): Promise<string | null> {
    const entries = Object.entries(env);
    if (entries.length === 0) return null;
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env key ${key}`);
      if (/[\r\n\0]/.test(value)) throw new Error(`env value for ${key} contains a newline`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-sbx-env-'));
    const file = join(dir, 'env');
    await writeFile(file, entries.map(([key, value]) => `${key}=${value}`).join('\n'), {
      mode: 0o600,
      encoding: 'utf8',
    });
    return file;
  }

  async withEnvFile<T>(
    env: Readonly<Record<string, string>>,
    run: (file: string | null) => Promise<T>,
  ): Promise<T> {
    const file = await this.writeEnvFile(env);
    try {
      return await run(file);
    } finally {
      if (file) await rm(dirname(file), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Best-effort cleanup path used by the Gateway on a failed create. */
  static temporaryName(prefix: string): string {
    return `${prefix}-${randomBytes(6).toString('hex')}`;
  }
}

/**
 * A byte buffer that keeps the *head* of a stream.
 *
 * Command output keeps its tail in the tool layer (a test summary is at the
 * bottom), but the CLI's own diagnostics are usually at the beginning. The cap
 * is a memory bound; the semantic truncation happens once, in the tool.
 */
class BoundedTail {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.size >= this.limit) return;
    const room = this.limit - this.size;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
