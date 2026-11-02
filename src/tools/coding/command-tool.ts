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
  name: 'bash',
  description:
    'Execute a shell command (/bin/sh -c) and return its stdout/stderr. Each call runs in a fresh shell; the first line of the result is its working directory, and cd inside the command affects only that call — use change_directory to move the task. Long output is truncated to its tail. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. Do not run commands that wait for interactive input. A permission denial is reported explicitly: do not retry another way.',
  parameters: z.object({
    command: z.string().min(1).describe('The shell command to execute.'),
    timeout: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe('Timeout in milliseconds. The sandbox applies its configured cap.'),
  }),
  sideEffect: 'command',
  readOnly: false,
  guidelines:
    'Run commands with bash; read and search with their own tools; verify destructive targets.',
  execute: async ({ command, timeout }, context) => {
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
        ...(timeout ? { timeoutMs: timeout } : {}),
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
