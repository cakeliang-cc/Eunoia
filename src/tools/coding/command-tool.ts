/**
 * The shell tool.
 *
 * The command runs inside the task's sandbox, never on the host. This module is
 * only a formatter: it hands `ToolExecutor` an argv, bounds the output it shows
 * the model, and maps the execution outcome. It does not know whether the
 * runtime is gVisor or a container, and it cannot add a timeout, a mount or an
 * environment variable that the platform did not configure.
 *
 * Output keeps the tail. A failing test's assertion, a compiler's first error and
 * a process's exit status are all at the end; a middle-out cut removes exactly
 * the part a fix depends on.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, toolError } from '../types.ts';
import { truncateTail } from '../truncate.ts';
import { guardToolResult } from './read-tools.ts';

const MAX_STREAM_CHARS = 30_000;

export const runCommandTool = defineTool({
  name: 'run_command',
  description: `在沙箱里的当前任务目录运行一条 shell 命令，返回当前目录、退出码、stdout 和 stderr。

什么时候调用：
- 跑测试、类型检查、lint、构建；
- 运行项目自己的脚本（npm run ...）；
- 需要确认一个改动是否真的生效。

规则：
- 命令在隔离的沙箱容器里执行，挂载的只有当前任务的工作目录；
- 结果第一行是执行时的当前目录。它可能已经不是工作区根目录，而 shell 里的相对路径正是从它算起——所以在命令里用相对路径之前，先看这一行；
- 删除、覆盖、移动这类不可逆操作，用 /workspace/... 的绝对路径，并在同一条命令里确认目标本身：执行前它存在，执行后它消失；
- 不要用自己打印的成功信息当作证据。退出码 0 只说明命令没有报错，不说明目标达成了；
- 需要让后续命令换目录，用 change_directory；一次性命令里的 cd 只影响这一次，不会改变任务的当前目录；
- 不要用它读文件（用 read_file）或搜索（用 grep）；
- 不要运行会等待交互输入的命令（vim、less、需要确认的安装）；
- 长输出会保留结尾，因为失败信息通常在最后；
- 不可逆或花钱的命令（安装依赖、发布、删除）先问用户。

它只能告诉你命令做了什么，不能替你判断结果是否正确。`,
  parameters: z.object({
    command: z.string().min(1).describe('要执行的 shell 命令'),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe('超时毫秒数，默认由沙箱配置决定（通常 120000）'),
  }),
  sideEffect: 'command',
  readOnly: false,
  guidelines:
    'run_command：结果第一行是当前目录；不可逆操作用绝对路径并确认目标；长输出保留结尾。',
  execute: async ({ command, timeout_ms }, context) => {
    return guardToolResult(async () => {
      const executor = context.executor;
      if (!executor) {
        return toolError(
          '当前没有可用的沙箱执行器，无法运行命令。请告诉用户需要配置 SANDBOX_* 后才能执行命令。',
        );
      }

      const result = await executor.run({
        command: [command],
        shell: true,
        ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        toolCallId: context.toolCallId ?? randomUUID(),
      });

      const stdout = truncateTail(result.stdout.split('\n'), 800, MAX_STREAM_CHARS);
      const stderr = truncateTail(result.stderr.split('\n'), 800, MAX_STREAM_CHARS);
      const parts = [
        // First, not last: a relative path in the command above is resolved
        // against this, and a wrong base is exactly how a delete of a
        // non-existent relative path can exit 0 while removing nothing.
        ...(result.cwd ? [`cwd: ${result.cwd}`] : []),
        `status: ${result.status}`,
        `exit code: ${result.exitCode ?? 'signal'}`,
        `duration: ${(result.durationMs / 1000).toFixed(1)}s`,
      ];
      if (stdout.text.trim().length > 0) parts.push(`--- stdout ---\n${stdout.text}`);
      if (stderr.text.trim().length > 0) parts.push(`--- stderr ---\n${stderr.text}`);
      if (result.timedOut) parts.push('… [command timed out and the sandbox was terminated]');

      const ok = result.status === 'SUCCEEDED';
      const error =
        result.status === 'TIMEOUT'
          ? 'command timed out'
          : result.status === 'CANCELLED'
            ? 'command was cancelled'
            : result.status === 'UNKNOWN'
              ? 'the execution outcome is unknown; do not retry it blindly'
              : `command exited with code ${result.exitCode ?? 'signal'}`;
      return {
        ok,
        output: parts.join('\n'),
        ...(ok ? {} : { error }),
        meta: {
          // The trace replaces the command with this summary, so the directory
          // leads: it is the thing a person needs to judge the command's scope.
          summary: `${result.cwd ? `${result.cwd} · ` : ''}${result.status} · 退出码 ${result.exitCode ?? 'signal'} · ${(result.durationMs / 1000).toFixed(1)}s`,
          ...(result.cwd ? { cwd: result.cwd } : {}),
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          ...(result.executionId ? { executionId: result.executionId } : {}),
          truncated: stdout.truncated || stderr.truncated,
        },
      };
    });
  },
});
