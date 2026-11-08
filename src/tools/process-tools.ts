/**
 * Long-running development jobs, inside the sandbox.
 *
 * These tools manage the job lifecycle only. Execution goes through the same
 * `ToolExecutor` as `bash`; there is no host fallback. Preview tools are honest
 * about the port boundary: a port bound inside a network-isolated container has
 * no host URL unless the deployment publishes one.
 *
 * See docs/adr/038-developer-toolkit.md.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';
import type { DevJobRecord } from '../processes/types.ts';
import type { ProcessRunContext, ProcessService } from '../processes/service.ts';

function contextOf(context: ToolContext): ProcessRunContext | ToolResult {
  if (!context.executor) {
    return toolError('这个进程没有可用的沙箱执行器，长期进程工具不可用。');
  }
  if (!context.userId || !context.conversationId) {
    return toolError('进程工具缺少会话或用户上下文。');
  }
  return {
    executor: context.executor,
    userId: context.userId,
    conversationId: context.conversationId,
    taskId: context.conversationId,
    toolCallId: context.toolCallId ?? 'process',
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

function isToolResult(value: ProcessRunContext | ToolResult): value is ToolResult {
  return 'ok' in value;
}

function describe(job: DevJobRecord): string {
  return [
    `作业 ${job.id}`,
    `状态：${job.status}`,
    job.pid ? `PID：${job.pid}` : null,
    job.exitCode !== null ? `退出码：${job.exitCode}` : null,
    `命令：${job.command.slice(0, 200)}`,
    `开始：${job.startedAt}`,
    job.endedAt ? `结束：${job.endedAt}` : null,
    job.error ? `说明：${job.error}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function createProcessTools(service: ProcessService): ToolDefinition[] {
  const processStart = defineTool({
    name: 'process_start',
    description:
      'Start a long-running development process (dev server, watcher, test runner) inside the sandbox and return immediately with a job id. ' +
      'Use process_read/status/wait/stop on the id. One-shot commands should keep using bash.',
    parameters: z.object({
      command: z.string().min(1).max(8_000),
      cwd: z.string().optional(),
      stdin: z.boolean().optional().describe('Open a FIFO for process_input.'),
    }),
    sideEffect: 'command',
    readOnly: false,
    guidelines:
      'process_start returns before the program exits. Logs are read with process_read and are not truncated silently; a cursor addresses the same append-only stream.',
    timeoutMs: 25_000,
    async execute(input, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const job = await service.start(ctx, input);
        return toolOk(`已启动。\n${describe(job)}`, {
          summary: `启动 ${job.id}（${job.status}）`,
          jobId: job.id,
          status: job.status,
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processStatus = defineTool({
    name: 'process_status',
    description: 'Check one background job: running/exited/stopped/unknown, exit code and PID.',
    parameters: z.object({ jobId: z.string().min(1) }),
    sideEffect: 'none',
    readOnly: true,
    timeoutMs: 15_000,
    async execute({ jobId }, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const job = await service.status(ctx, jobId);
        return toolOk(describe(job), {
          summary: `${job.status}${job.exitCode !== null ? ` (${job.exitCode})` : ''}`,
          jobId: job.id,
          status: job.status,
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processRead = defineTool({
    name: 'process_read',
    description:
      'Read stdout/stderr of a background job from a cursor. Returns a cursor for the next read. A gap is explicit, never presented as complete output.',
    parameters: z.object({
      jobId: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      stream: z.enum(['stdout', 'stderr', 'both']).optional(),
    }),
    sideEffect: 'none',
    readOnly: true,
    timeoutMs: 15_000,
    async execute({ jobId, cursor, stream }, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const read = await service.read(ctx, { jobId, cursor, stream });
        const chosen = stream ?? 'both';
        const parts: string[] = [];
        if (chosen !== 'stderr') parts.push(`--- stdout ---\n${read.text || '(空)'}`);
        if (chosen !== 'stdout') parts.push(`--- stderr ---\n${read.stderrText || '(空)'}`);
        if (read.gap) {
          parts.unshift('注意：日志已经发生滚动/截断，无法保证从 cursor 起的连续性。');
        }
        parts.push(`cursor=${read.nextCursor}`);
        return toolOk(parts.join('\n\n'), {
          summary: `${read.nextCursor} 字节`,
          jobId,
          nextCursor: read.nextCursor,
          gap: read.gap,
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processWait = defineTool({
    name: 'process_wait',
    description:
      'Wait for a background job to exit, up to a timeout. A timeout leaves the job running; it is not a failure.',
    parameters: z.object({
      jobId: z.string().min(1),
      timeoutMs: z.number().int().min(100).max(300_000).optional(),
    }),
    sideEffect: 'none',
    readOnly: true,
    timeoutMs: 310_000,
    async execute({ jobId, timeoutMs }, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const job = await service.wait(ctx, jobId, { timeoutMs: timeoutMs ?? 60_000 });
        return toolOk(
          job.status === 'running' ? `${describe(job)}\n等待超时，作业仍在运行。` : describe(job),
          { summary: job.status, jobId: job.id, status: job.status },
        );
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processInput = defineTool({
    name: 'process_input',
    description:
      'Send text to a background job started with stdin. Success means the bytes were written, not that the program acted on them.',
    parameters: z.object({ jobId: z.string().min(1), text: z.string().max(4_000) }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 10_000,
    async execute({ jobId, text }, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const job = await service.input(ctx, jobId, text);
        return toolOk(`输入已写入。\n${describe(job)}`, {
          summary: '已发送',
          jobId,
          status: job.status,
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processStop = defineTool({
    name: 'process_stop',
    description:
      'Stop a background job: SIGTERM to its process group, then SIGKILL after a grace period. Verifies the process is gone.',
    parameters: z.object({ jobId: z.string().min(1) }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 25_000,
    async execute({ jobId }, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const job = await service.stop(ctx, jobId);
        return toolOk(describe(job), { summary: '已停止', jobId, status: job.status });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  const processList = defineTool({
    name: 'process_list',
    description: 'List this conversation’s background jobs with their current status.',
    parameters: z.object({}),
    sideEffect: 'none',
    readOnly: true,
    timeoutMs: 20_000,
    async execute(_input, context): Promise<ToolResult> {
      const ctx = contextOf(context);
      if (isToolResult(ctx)) return ctx;
      try {
        const jobs = await service.list(ctx);
        if (jobs.length === 0) return toolOk('没有后台作业。', { summary: '0 个作业', jobs: 0 });
        return toolOk(jobs.map(describe).join('\n\n'), {
          summary: `${jobs.length} 个作业`,
          jobs: jobs.length,
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error), {
          code: (error as { code?: string }).code ?? 'PROCESS_FAILED',
        });
      }
    },
  });

  return [
    processStart,
    processStatus,
    processRead,
    processWait,
    processInput,
    processStop,
    processList,
  ];
}
