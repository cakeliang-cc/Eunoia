/**
 * The shell tool.
 *
 * `command` side effect, so it is refused unless the process explicitly enabled
 * it. Unlike the path guard, this is not a sandbox at all: the command runs with
 * the real shell, the real environment and the real user. Enabling it is a
 * statement that this machine is the person's own and the agent is trusted with
 * it; the only thing this module bounds is time and output, not capability.
 *
 * Output keeps the tail. A failing test's assertion, a compiler's first error and
 * a process's exit status are all at the end; a middle-out cut removes exactly
 * the part a fix depends on.
 */

import { z } from 'zod';
import { defineTool } from '../types.ts';
import { truncateTail } from '../truncate.ts';
import { guardToolResult, requireWorkspace } from './read-tools.ts';

const MAX_STREAM_CHARS = 30_000;

export const runCommandTool = defineTool({
  name: 'run_command',
  description: `在工作目录里运行一条 shell 命令，返回退出码、stdout 和 stderr。

什么时候调用：
- 跑测试、类型检查、lint、构建；
- 运行项目自己的脚本（npm run ...）；
- 需要确认一个改动是否真的生效。

规则：
- 命令在当前工作目录执行，不是整个磁盘；
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
      .describe('超时毫秒数，默认 120000'),
  }),
  sideEffect: 'command',
  readOnly: false,
  guidelines: 'run_command：跑测试/构建/脚本；长输出保留结尾；危险命令先问用户。',
  execute: async ({ command, timeout_ms }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const result = await workspace.runCommand(command, {
        ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });

      const stdout = truncateTail(result.stdout.split('\n'), 800, MAX_STREAM_CHARS);
      const stderr = truncateTail(result.stderr.split('\n'), 800, MAX_STREAM_CHARS);
      const parts = [`exit code: ${result.exitCode ?? 'signal'}`, `duration: ${(result.durationMs / 1000).toFixed(1)}s`];
      if (stdout.text.trim().length > 0) parts.push(`--- stdout ---\n${stdout.text}`);
      if (stderr.text.trim().length > 0) parts.push(`--- stderr ---\n${stderr.text}`);
      if (result.timedOut) parts.push('… [command timed out and was killed]');

      const ok = result.exitCode === 0 && !result.timedOut;
      return {
        ok,
        output: parts.join('\n'),
        ...(ok
          ? {}
          : {
              error: result.timedOut
                ? 'command timed out'
                : `command exited with code ${result.exitCode ?? 'signal'}`,
            }),
        meta: {
          summary: `退出码 ${result.exitCode ?? 'signal'} · ${(result.durationMs / 1000).toFixed(1)}s`,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          truncated: stdout.truncated || stderr.truncated,
        },
      };
    });
  },
});
