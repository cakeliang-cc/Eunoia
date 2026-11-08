/**
 * Preview tools over the durable lease service.
 *
 * `preview_start` answers four separate questions: did the job start, does the
 * port answer inside the container, is there a host route, and what are the user
 * and browser URLs. A null URL is only returned with the reason, never as a
 * silent success.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';
import type { ProcessRunContext } from '../processes/service.ts';
import type { PreviewService } from '../previews/service.ts';
import type { PreviewLease } from '../previews/types.ts';

function contextOf(context: ToolContext): ProcessRunContext | ToolResult {
  if (!context.executor) return toolError('没有沙箱执行器，预览不可用。');
  if (!context.userId || !context.conversationId) return toolError('预览缺少会话或用户上下文。');
  const identity = context.scope?.identity;
  return {
    executor: context.executor,
    userId: context.userId,
    conversationId: context.conversationId,
    taskId: identity?.taskAttemptId ?? context.conversationId,
    toolCallId: context.toolCallId ?? 'preview',
    ...(identity?.memberId ? { memberId: identity.memberId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

function isResult(value: ProcessRunContext | ToolResult): value is ToolResult {
  return 'ok' in value;
}

function describeLease(lease: PreviewLease): string {
  const lines = [
    `预览 ${lease.id}：${lease.status}`,
    `作业：${lease.jobId}`,
    `容器内端口：${lease.containerPort}`,
  ];
  if (lease.userUrl) lines.push(`用户地址：${lease.userUrl}`);
  if (lease.browserUrl) lines.push(`浏览器地址：${lease.browserUrl}`);
  if (!lease.userUrl) lines.push('用户地址：不可用（未就绪或已停止）');
  lines.push(`租约到期：${lease.expiresAt}`);
  if (lease.error) lines.push(`原因：${lease.error}`);
  return lines.join('\n');
}

export function createPreviewTools(service: PreviewService): ToolDefinition[] {
  return [
    defineTool({
      name: 'preview_start',
      description:
        'Start a project command, wait until it answers HTTP inside the sandbox, create a durable preview lease and return separate user and browser URLs. ' +
        'The gateway routes only this lease; no container port is published on the host.',
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
          const started = await service.start(ctx, {
            command,
            port,
            ...(cwd ? { cwd } : {}),
            ...(ready_timeout_ms !== undefined ? { readyTimeoutMs: ready_timeout_ms } : {}),
          });
          if (!started.ready) {
            return toolError(
              `预览没有就绪。${started.detail}\n${describeLease(started.lease)}`,
              {
                code: 'PREVIEW_NOT_READY',
                previewId: started.lease.id,
                jobId: started.job.id,
                userUrl: null,
                browserUrl: null,
                ready: false,
                logs: started.logs.text.slice(-2_000),
              },
            );
          }
          return toolOk(
            [
              '预览已就绪。',
              describeLease(started.lease),
              `容器内地址：${started.internalUrl}`,
              `就绪证据：${started.detail}`,
            ].join('\n'),
            {
              summary: `预览就绪 ${started.lease.routeId.slice(0, 8)}`,
              previewId: started.lease.id,
              jobId: started.job.id,
              userUrl: started.lease.userUrl,
              browserUrl: started.lease.browserUrl,
              internalUrl: started.internalUrl,
              ready: true,
              expiresAt: started.lease.expiresAt,
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
      description:
        'Check a preview lease, its job status, whether it is still routable and its current URLs.',
      parameters: z.object({ previewId: z.string().min(1) }),
      sideEffect: 'none',
      readOnly: true,
      timeoutMs: 20_000,
      async execute({ previewId }, context): Promise<ToolResult> {
        const ctx = contextOf(context);
        if (isResult(ctx)) return ctx;
        try {
          const current = await service.status(ctx, previewId);
          return toolOk(describeLease(current.lease), {
            summary: current.lease.status,
            previewId,
            jobId: current.lease.jobId,
            ready: current.ready,
            userUrl: current.lease.userUrl,
            browserUrl: current.lease.browserUrl,
            jobStatus: current.job?.status ?? null,
            detail: current.detail,
          });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error), {
            code: (error as { code?: string }).code ?? 'PREVIEW_FAILED',
          });
        }
      },
    }),
    defineTool({
      name: 'preview_stop',
      description: 'Revoke a preview route and stop its process group, verifying it exited.',
      parameters: z.object({ previewId: z.string().min(1) }),
      sideEffect: 'command',
      readOnly: false,
      timeoutMs: 25_000,
      async execute({ previewId }, context): Promise<ToolResult> {
        const ctx = contextOf(context);
        if (isResult(ctx)) return ctx;
        try {
          const stopped = await service.stop(ctx, previewId);
          return toolOk(`预览已停止（${stopped.status}），旧地址不再路由。`, {
            summary: stopped.status,
            previewId,
            jobId: stopped.jobId,
            userUrl: null,
            ready: false,
          });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error), {
            code: (error as { code?: string }).code ?? 'PREVIEW_FAILED',
          });
        }
      },
    }),
  ];
}
