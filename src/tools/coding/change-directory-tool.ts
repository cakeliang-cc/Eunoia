/**
 * The `change_directory` tool (ADR 021 §5).
 *
 * `run_command` is stateless: every call is a fresh shell, so a `cd` inside one
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
  description: `改变当前任务的工作目录，之后每次 run_command 都从新目录开始。

什么时候调用：
- 需要在某个子目录里连续跑几条命令，每条都 cd 很啰嗦；
- 上一条命令里的 cd 没有生效，下一次又在原地。

规则：
- 相对路径基于当前任务目录解析，不是基于工作区根目录；
- 绝对路径必须落在任务工作区内；
- 成功之后后续 run_command 自动使用新目录，不需要每次再 cd；
- 只改变任务的工作目录，不改变宿主机目录，也不扩大文件权限；
- 目标必须是已经存在的目录，不能是文件；指向工作区外面的符号链接会被拒绝。

失败时会返回结构化错误码和说明：换个路径重试即可，不要反复重试同一个路径。`,
  parameters: z.object({
    path: z
      .string()
      .min(1)
      .describe('目录路径：相对当前工作目录，或以 /workspace 开头的绝对路径'),
  }),
  sideEffect: 'workspace_state',
  readOnly: false,
  guidelines:
    'change_directory：改变任务工作目录，后续 run_command 从新目录开始；run_command 里的 cd 不会改变任务目录。',
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
      return {
        ok: false,
        output: '',
        error: `${result.error}: ${result.message}`,
        meta: { summary: `切换目录失败 · ${result.error}`, error: result.error, cwdError: true },
      };
    }

    return toolOk(
      `当前目录：${result.cwd}（之前：${result.previousCwd}，版本 ${result.cwdVersion}）\n` +
        `后续 run_command 会从 ${result.cwd} 开始。`,
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
