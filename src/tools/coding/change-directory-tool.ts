/**
 * The `change_directory` tool (ADR 021 §5).
 *
 * `bash` is stateless: every call is a fresh shell, so a `cd` inside one
 * command cannot affect the next. This tool is the explicit, audited way to move
 * the *task* instead. It is a formatter and a translator: it validates its own
 * input shape, delegates every decision to the `ToolCwdPort`, and turns the
 * structured outcome into a model-readable result.
 *
 * The model supplies a path and nothing else. `taskId`, `workspaceRoot` and the
 * cwd version belong to the runtime context — a tool that accepted them would let
 * the agent name its own context (ADR §5.1).
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from '../types.ts';

export const changeDirectoryTool = defineTool({
  name: 'change_directory',
  description:
    'Change the task working directory for subsequent bash calls. Relative paths resolve against the current task directory; absolute paths must stay inside the workspace; the target must be an existing directory.',
  parameters: z.object({
    path: z
      .string()
      .min(1)
      .describe('Directory path: relative to the current task directory, or absolute under /workspace.'),
  }),
  sideEffect: 'workspace_state',
  readOnly: false,
  guidelines: 'Move the task directory with change_directory; a cd inside one bash call does not persist.',
  execute: async ({ path }, context) => {
    const cwd = context.cwd;
    if (!cwd) {
      return toolError('当前没有可用的沙箱工作目录，无法切换目录。请告诉用户需要配置 SANDBOX_* 后才能切换。');
    }

    const result = await cwd.change({
      path,
      ...(context.toolCallId ? { operationId: context.toolCallId } : {}),
    });

    if (!result.ok) {
      const details = [`${result.error}: ${result.message}`];
      if (result.currentCwd) details.push(`当前目录：${result.currentCwd}`);
      if (result.resolvedPath) details.push(`解析目标：${result.resolvedPath}`);
      if (result.error === 'DIRECTORY_NOT_FOUND') {
        details.push(
          '相对路径基于当前目录解析，不是基于 /workspace。若要从工作区根开始，请改用 /workspace/... 开头的绝对路径。',
        );
      }
      return {
        ok: false,
        output: '',
        error: details.join('\n'),
        meta: {
          summary: `切换目录失败 · ${result.error}`,
          error: result.error,
          cwdError: true,
          ...(result.currentCwd ? { currentCwd: result.currentCwd } : {}),
          ...(result.resolvedPath ? { resolvedPath: result.resolvedPath } : {}),
        },
      };
    }

    return toolOk(
      `当前目录：${result.cwd}（之前：${result.previousCwd}，版本 ${result.cwdVersion}）\n` +
        `后续 bash 会从 ${result.cwd} 开始。`,
      {
        summary: `cd ${result.cwd}`,
        cwd: result.cwd,
        previousCwd: result.previousCwd,
        cwdVersion: result.cwdVersion,
        workspaceRoot: result.workspaceRoot,
      },
    );
  },
});
