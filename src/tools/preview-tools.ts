/**
 * Preview orchestration over a background process.
 *
 * A sandbox with `network: none` does not publish ports to the host. This tool
 * therefore distinguishes three facts instead of pretending they are one:
 * the process is running, the server answers on a port *inside* the container,
 * and whether a browser outside can reach it. In this deployment the last is
 * false; the tool says so and returns a null user URL.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';
import type { ProcessRunContext, ProcessService } from '../processes/service.ts';

function contextOf(context: ToolContext): ProcessRunContext | ToolResult {
  if (!context.executor) return toolError('没有沙箱执行器，预览不可用。');
  if (!context.userId || !context.conversationId) return toolError('预览缺少会话或用户上下文。');
  return {
    executor: context.executor,
    userId: context.userId,
    conversationId: context.conversationId,
    taskId: context.conversationId,
    toolCallId: context.toolCallId ?? 'preview',
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

function isResult(value: ProcessRunContext | ToolResult): value is ToolResult {
  return 'ok' in value;
}

export function createPreviewTools(service: ProcessService): ToolDefinition[] {
  return [
    defineTool({
      name: 'preview_start',
      description:
        'Start a project command and wait until it answers HTTP inside the sandbox, then return a preview handle. ' +
        'If this deployment does not publish container ports, user_url is null and that is stated explicitly.',
      parameters: z.object({
        command: z.string().min(1).max(8_000),
        port: z.number().int().min(1024).max(65535),
        cwd: z.string().optional(),
        ready_timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
      }),
      sideEffect: 'command',
      readOnly: false,
      timeoutMs: 150_000,
      async execute({ command, port, cwd, ready_timeout_ms }, context): Promise<ToolResult> {
        const ctx = contextOf(context);
        if (isResult(ctx)) return ctx;
        try {
          const job = await service.start(ctx, { command, ...(cwd ? { cwd } : {}) });
          const probe = await service.probeHttp(ctx, port, ready_timeout_ms ?? 30_000);
          const internalUrl = `http://127.0.0.1:${port}/`;
          return toolOk(
            [
              `预览进程：${job.id}（${job.status}）`,
              `容器内地址：${internalUrl}`,
              `就绪：${probe.ready ? '是' : '否'}（${probe.detail}）`,
              '宿主地址：不可用。这个部署的沙箱没有向宿主发布端口，浏览器不能在宿主打开容器内地址。',
            ].join('\n'),
            {
              summary: probe.ready ? `端口 ${port} 就绪` : `端口 ${port} 未就绪`,
              jobId: job.id,
              port,
              internalUrl,
              userUrl: null,
              ready: probe.ready,
            },
          );
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error), {
            code: (error as { code?: string }).code ?? 'PREVIEW_FAILED',
          });
        }
      },
    }),
    defineTool({
      name: 'preview_status',
      description: 'Check the preview job and whether its HTTP port answers inside the sandbox.',
      parameters: z.object({ jobId: z.string().min(1), port: z.number().int().min(1024).max(65535) }),
      sideEffect: 'none',
      readOnly: true,
      timeoutMs: 20_000,
      async execute({ jobId, port }, context): Promise<ToolResult> {
        const ctx = contextOf(context);
        if (isResult(ctx)) return ctx;
        try {
          const job = await service.status(ctx, jobId);
          const probe = await service.probeHttp(ctx, port, 2_000);
          return toolOk(
            `作业 ${job.id}：${job.status}\n容器内 HTTP：${probe.detail}\n宿主地址：不可用（端口未发布）。`,
            { summary: job.status, jobId, ready: probe.ready, userUrl: null },
          );
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error), {
            code: (error as { code?: string }).code ?? 'PREVIEW_FAILED',
          });
        }
      },
    }),
    defineTool({
      name: 'preview_stop',
      description: 'Stop the preview process group and verify it exited.',
      parameters: z.object({ jobId: z.string().min(1) }),
      sideEffect: 'command',
      readOnly: false,
      timeoutMs: 25_000,
      async execute({ jobId }, context): Promise<ToolResult> {
        const ctx = contextOf(context);
        if (isResult(ctx)) return ctx;
        try {
          const job = await service.stop(ctx, jobId);
          return toolOk(`预览已停止（${job.status}）。`, { summary: job.status, jobId });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error), {
            code: (error as { code?: string }).code ?? 'PREVIEW_FAILED',
          });
        }
      },
    }),
  ];
}
