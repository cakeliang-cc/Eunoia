/**
 * Container-backed development jobs.
 *
 * Jobs run through the sandbox's existing `ToolExecutor`, so the same path,
 * permission, cgroup and audit rules apply as for one-shot `bash`. A job is a
 * detached process group; its pid, marker, output and exit code live in
 * `/tmp/eunoia-jobs/<id>` inside the same container, which is what lets a later
 * status call tell "running", "exited" and "unknown" apart without replaying the
 * command.
 *
 * There is no host execution path. If the deployment has no sandbox, the tool
 * refuses; it does not fall back to the server's own shell.
 */

import { randomUUID } from 'node:crypto';
import type { ToolExecutionResult, ToolExecutor } from '../tools/types.ts';
import type { ProcessStore } from './store.ts';
import {
  DEFAULT_PROCESS_LIMITS,
  ProcessError,
  type DevJobRecord,
  type ProcessLimits,
} from './types.ts';

export interface ProcessRunContext {
  readonly executor: ToolExecutor;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId?: string | null;
  readonly memberId?: string | null;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}

export interface ProcessServiceDeps {
  readonly store: ProcessStore;
  readonly limits?: Partial<ProcessLimits>;
  readonly now?: () => Date;
}

export class ProcessService {
  readonly #store: ProcessStore;
  readonly #limits: ProcessLimits;
  readonly #now: () => Date;

  constructor(deps: ProcessServiceDeps) {
    this.#store = deps.store;
    this.#limits = { ...DEFAULT_PROCESS_LIMITS, ...deps.limits };
    this.#now = deps.now ?? (() => new Date());
  }

  get limits(): ProcessLimits {
    return this.#limits;
  }

  async start(
    context: ProcessRunContext,
    input: { readonly command: string; readonly cwd?: string; readonly stdin?: boolean },
  ): Promise<DevJobRecord> {
    const command = input.command.trim();
    if (command.length === 0) throw new ProcessError('PROCESS_INVALID', '命令不能为空。');
    if (command.length > this.#limits.maxCommandChars) {
      throw new ProcessError('PROCESS_INVALID', `命令超过 ${this.#limits.maxCommandChars} 字符。`);
    }
    const existing = await this.#store.getDevJobByCall(
      context.userId,
      context.conversationId,
      context.toolCallId,
    );
    if (existing) {
      if (existing.command !== command) {
        throw new ProcessError(
          'PROCESS_CONFLICT',
          '同一个 tool call 已经启动过不同的命令；不能产生第二个作业。',
          409,
        );
      }
      return this.status(context, existing.id);
    }
    const running = await this.#store.listDevJobs(context.userId, context.conversationId);
    if (running.filter((job) => job.status === 'running' || job.status === 'starting').length >= this.#limits.maxJobsPerConversation) {
      throw new ProcessError(
        'PROCESS_LIMIT',
        `这个会话最多同时运行 ${this.#limits.maxJobsPerConversation} 个作业；先停止一个。`,
        409,
      );
    }
    const id = `job_${randomUUID()}`;
    const base = `/tmp/eunoia-jobs/${id}`;
    const cwd = input.cwd?.trim() || '.';
    const stdin = input.stdin === true;
    const marker = randomUUID();
    const script = [
      'set -e',
      `base='${base}'`,
      'mkdir -p "$base"',
      `cd '${shellQuote(cwd)}' || { echo "cwd not found" >&2; exit 12; }`,
      `if base64 -d </dev/null >/dev/null 2>&1; then printf '%s' '${Buffer.from(command, 'utf8').toString('base64')}' | base64 -d > "$base/command.sh"; else printf '%s' '${Buffer.from(command, 'utf8').toString('base64')}' | base64 -D > "$base/command.sh"; fi`,
      'chmod +x "$base/command.sh"',
      `echo '${marker}' > "$base/marker"`,
      stdin ? 'rm -f "$base/in"; mkfifo "$base/in"' : 'rm -f "$base/in"',
      'if command -v setsid >/dev/null 2>&1; then RUNNER=setsid; else RUNNER=nohup; fi',
      stdin
        ? '$RUNNER sh -c \'sh "$0"; echo $? > "$1"\' "$base/command.sh" "$base/exit" <> "$base/in" > "$base/out" 2> "$base/err" &'
        : '$RUNNER sh -c \'sh "$0"; echo $? > "$1"\' "$base/command.sh" "$base/exit" < /dev/null > "$base/out" 2> "$base/err" &',
      'pid=$!',
      'echo $pid > "$base/pid"',
      'echo started',
    ].join('\n');
    const result = await context.executor.run({
      command: ['sh', '-c', script],
      timeoutMs: 15_000,
      toolCallId: context.toolCallId,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.status !== 'SUCCEEDED' || !result.stdout.includes('started')) {
      throw new ProcessError(
        'PROCESS_INVALID',
        `作业启动失败：${(result.stderr || result.stdout).slice(0, 500) || result.status}`,
        502,
      );
    }
    const now = this.#now();
    const record: DevJobRecord = {
      id,
      userId: context.userId,
      conversationId: context.conversationId,
      turnId: context.turnId ?? null,
      memberId: context.memberId ?? null,
      taskId: context.taskId,
      toolCallId: context.toolCallId,
      command,
      cwd,
      marker,
      pid: null,
      status: 'starting',
      exitCode: null,
      stdoutPath: `${base}/out`,
      stderrPath: `${base}/err`,
      stdinFifo: stdin ? `${base}/in` : null,
      startedAt: now.toISOString(),
      endedAt: null,
      expiresAt: new Date(now.getTime() + this.#limits.ttlMs).toISOString(),
      error: null,
    };
    await this.#store.createDevJob(record);
    const status = await this.status(context, id);
    return status;
  }

  async status(context: ProcessRunContext, id: string): Promise<DevJobRecord> {
    const record = await this.get(context, id);
    if (!record) throw new ProcessError('PROCESS_NOT_FOUND', '没有这个作业。', 404);
    const base = `/tmp/eunoia-jobs/${id}`;
    const probe = await this.#run(
      context,
      [
        `base='${base}'`,
        'pid=$(cat "$base/pid" 2>/dev/null || echo "")',
        'running=no',
        'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
        '  if [ -d /proc/$pid ]; then',
        '    if tr "\\0" "\\n" < /proc/$pid/cmdline 2>/dev/null | grep -F "$base" >/dev/null; then running=yes; fi',
        '  else running=yes; fi',
        'fi',
        'echo "running:$running"',
        'if [ -f "$base/exit" ]; then echo "exit:$(cat "$base/exit")"; else echo "exit:"; fi',
        'echo "out:$(wc -c < "$base/out" 2>/dev/null || echo 0)"',
        'echo "err:$(wc -c < "$base/err" 2>/dev/null || echo 0)"',
        'echo "pid:$pid"',
      ].join('\n'),
      10_000,
    ).catch((error: unknown) => {
      return {
        status: 'FAILED',
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        durationMs: 0,
      } as ToolExecutionResult;
    });
    const running = /running:yes/.test(probe.stdout);
    const exitMatch = /exit:(-?\d+)/.exec(probe.stdout);
    const pidMatch = /pid:(\d+)/.exec(probe.stdout);
    let status = record.status;
    let exitCode = record.exitCode;
    let endedAt = record.endedAt;
    if (running) {
      status = 'running';
    } else if (exitMatch) {
      status = 'exited';
      exitCode = Number(exitMatch[1]);
      endedAt = endedAt ?? this.#now().toISOString();
    } else if (record.status === 'running' || record.status === 'starting') {
      // A command can exit between the start acknowledgement and this probe,
      // before the wrapper has written the exit file. Do not call that
      // "unknown" for the first seconds: it is still starting/finishing, and the
      // next status call will see the real exit code.
      const age = Date.now() - Date.parse(record.startedAt);
      status = age < 3_000 ? 'starting' : 'unknown';
    }
    const next: DevJobRecord = {
      ...record,
      status,
      exitCode,
      endedAt,
      pid: pidMatch ? Number(pidMatch[1]) : record.pid,
      error:
        status === 'unknown'
          ? '进程已不在，但没有退出码；容器可能重启过，不能确认结果。'
          : record.error,
    };
    await this.#store.updateDevJob(context.userId, id, {
      status,
      exitCode,
      ...(endedAt ? { endedAt } : {}),
      ...(next.pid ? { pid: next.pid } : {}),
      ...(next.error ? { error: next.error } : {}),
    });
    return next;
  }

  async read(
    context: ProcessRunContext,
    input: { readonly jobId: string; readonly stream?: 'stdout' | 'stderr' | 'both'; readonly cursor?: number },
  ): Promise<{
    readonly job: DevJobRecord;
    readonly text: string;
    readonly stderrText: string;
    readonly nextCursor: number;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly gap: boolean;
  }> {
    const job = await this.get(context, input.jobId);
    if (!job) throw new ProcessError('PROCESS_NOT_FOUND', '没有这个作业。', 404);
    const base = `/tmp/eunoia-jobs/${job.id}`;
    const cursor = Math.max(0, Math.floor(input.cursor ?? 0));
    const max = this.#limits.maxReadChars;
    const script = [
      `base='${base}'`,
      `out=$(wc -c < "$base/out" 2>/dev/null || echo 0)`,
      `err=$(wc -c < "$base/err" 2>/dev/null || echo 0)`,
      'echo "out:$out"',
      'echo "err:$err"',
      'echo "---stdout---"',
      `tail -c +${cursor + 1} "$base/out" 2>/dev/null | head -c ${max}`,
      'echo ""',
      'echo "---stderr---"',
      `tail -c +${cursor + 1} "$base/err" 2>/dev/null | head -c ${max}`,
    ].join('\n');
    const result = await this.#run(context, script, 10_000);
    const stdoutBytes = Number(/out:(\d+)/.exec(result.stdout)?.[1] ?? 0);
    const stderrBytes = Number(/err:(\d+)/.exec(result.stdout)?.[1] ?? 0);
    const [stdoutPart, stderrPart] = result.stdout.split('---stdout---')[1]?.split('---stderr---') ?? ['', ''];
    const gap = cursor > Math.max(stdoutBytes, stderrBytes);
    return {
      job,
      text: (stdoutPart ?? '').replace(/\n$/, ''),
      stderrText: (stderrPart ?? '').replace(/\n$/, ''),
      nextCursor: Math.max(stdoutBytes, stderrBytes),
      stdoutBytes,
      stderrBytes,
      gap,
    };
  }

  async wait(
    context: ProcessRunContext,
    id: string,
    options: { readonly timeoutMs: number },
  ): Promise<DevJobRecord> {
    const deadline = Date.now() + Math.min(Math.max(options.timeoutMs, 100), 5 * 60_000);
    for (;;) {
      const job = await this.status(context, id);
      if (job.status === 'exited' || job.status === 'stopped' || job.status === 'unknown') return job;
      if (Date.now() >= deadline) return job;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
        context.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (context.signal?.aborted) return this.status(context, id);
    }
  }

  async input(
    context: ProcessRunContext,
    id: string,
    text: string,
  ): Promise<DevJobRecord> {
    const job = await this.get(context, id);
    if (!job) throw new ProcessError('PROCESS_NOT_FOUND', '没有这个作业。', 404);
    if (!job.stdinFifo) {
      throw new ProcessError('PROCESS_NO_INPUT', '这个作业启动时没有开启输入（stdin=false）。', 409);
    }
    if (text.length > this.#limits.maxInputChars) {
      throw new ProcessError('PROCESS_INVALID', `输入超过 ${this.#limits.maxInputChars} 字符。`, 400);
    }
    if (job.status !== 'running') {
      throw new ProcessError('PROCESS_NOT_RUNNING', '作业已经不在运行。', 409);
    }
    const base = `/tmp/eunoia-jobs/${id}`;
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    const result = await this.#run(
      context,
      [
        `base='${base}'`,
        '[ -p "$base/in" ] || { echo NO_FIFO; exit 3; }',
        `printf '%s' '${encoded}' | base64 -d > "$base/in"`,
        'echo sent',
      ].join('\n'),
      5_000,
    );
    if (!result.stdout.includes('sent')) {
      throw new ProcessError('PROCESS_NO_INPUT', '输入没有送达：作业没有读取 stdin 的管道。', 409);
    }
    return this.status(context, id);
  }

  async stop(context: ProcessRunContext, id: string): Promise<DevJobRecord> {
    const job = await this.get(context, id);
    if (!job) throw new ProcessError('PROCESS_NOT_FOUND', '没有这个作业。', 404);
    if (job.status !== 'running' && job.status !== 'starting') return job;
    await this.#store.updateDevJob(context.userId, id, { status: 'stopping' });
    const base = `/tmp/eunoia-jobs/${id}`;
    await this.#run(
      context,
      [
        `base='${base}'`,
        'pid=$(cat "$base/pid" 2>/dev/null || echo "")',
        'kill_tree() {',
        '  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done',
        '  kill -TERM "$1" 2>/dev/null || true',
        '}',
        'if [ -n "$pid" ]; then',
        '  kill -TERM -"$pid" 2>/dev/null || kill_tree "$pid"',
        '  i=0',
        '  while [ $i -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; i=$((i+1)); done',
        '  if kill -0 "$pid" 2>/dev/null; then kill -KILL -"$pid" 2>/dev/null || kill_tree "$pid" || true; fi',
        'fi',
        'echo stopped',
      ].join('\n'),
      15_000,
    );
    const final = await this.status(context, id);
    if (final.status === 'unknown' || final.status === 'running') {
      throw new ProcessError('PROCESS_UNKNOWN', '无法确认进程已经结束；没有假装停止成功。', 502);
    }
    const endedAt = final.endedAt ?? this.#now().toISOString();
    await this.#store.updateDevJob(context.userId, id, {
      status: 'stopped',
      endedAt,
      ...(final.exitCode !== null ? { exitCode: final.exitCode } : {}),
    });
    return { ...final, status: 'stopped', endedAt };
  }

  /**
   * Probe an HTTP endpoint *inside* the container.
   *
   * The host cannot reach a container port in this sandbox, so readiness is
   * checked where the server actually listens. The result says "ready inside";
   * it is not a promise that a host browser can open it.
   */
  async probeHttp(
    context: ProcessRunContext,
    port: number,
    timeoutMs: number,
  ): Promise<{ readonly ready: boolean; readonly status: number | null; readonly detail: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.#run(
        context,
        `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null || true); echo "code:$code"`,
        8_000,
      ).catch(() => null);
      const code = Number(/code:(\d{3})/.exec(result?.stdout ?? '')?.[1] ?? 0);
      if (code >= 200 && code < 400) {
        return { ready: true, status: code, detail: `容器内 HTTP ${code}` };
      }
      if (Date.now() >= deadline) {
        return { ready: false, status: code || null, detail: code ? `容器内 HTTP ${code}` : '容器内无法连接' };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      });
      if (context.signal?.aborted) return { ready: false, status: null, detail: '已取消' };
    }
  }

  async list(context: ProcessRunContext): Promise<DevJobRecord[]> {
    const jobs = await this.#store.listDevJobs(context.userId, context.conversationId);
    const refreshed: DevJobRecord[] = [];
    for (const job of jobs.slice(0, 10)) {
      if (job.status === 'running' || job.status === 'starting') {
        refreshed.push(await this.status(context, job.id).catch(() => job));
      } else {
        refreshed.push(job);
      }
    }
    return refreshed;
  }

  async get(context: ProcessRunContext, id: string): Promise<DevJobRecord | null> {
    return this.#store.getDevJob(context.userId, id);
  }

  async #run(
    context: ProcessRunContext,
    script: string,
    timeoutMs: number,
  ): Promise<ToolExecutionResult> {
    const result = await context.executor.run({
      command: ['sh', '-c', script],
      timeoutMs,
      // A status/probe command is not the user's mutating tool call. Using the
      // same idempotency key as `start` made a second probe return the cached
      // start result (a real bug the preview readiness loop exposed).
      toolCallId: `proc_control_${randomUUID()}`,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.status === 'TIMEOUT') {
      throw new ProcessError('PROCESS_TIMEOUT', '作业控制命令超时。', 504);
    }
    return result;
  }
}

function shellQuote(value: string): string {
  return value.replace(/'/g, `'\\''`);
}
