/**
 * The approval policy, in one place.
 *
 * There is no interactive approval because the chat transport is a one-way SSE
 * stream: the server cannot ask a question halfway through a turn. Consent is
 * therefore given *before* the turn, by the process, and is fail-closed. A tool
 * that needs a permission it was not granted returns a model-visible refusal and
 * never touches the filesystem.
 *
 * This is deliberately coarser than a per-call prompt and deliberately finer
 * than "the workspace is configured": file writes and shell commands are
 * separate permissions, because a person who wants the agent to read a repo does
 * not thereby want it to run `npm install`.
 */

import type { ToolDefinition, ToolPolicy } from './types.ts';

/** Why a call is refused, or null when it may run. */
export function policyDenial(tool: ToolDefinition, policy: ToolPolicy): string | null {
  switch (tool.sideEffect) {
    case 'none':
    case 'memory_write':
      return null;
    case 'workspace_write':
      return policy.allowWorkspaceWrites
        ? null
        : '文件写入在当前服务中没有开启（WORKSPACE_WRITES）。不要重试；请告诉用户需要开启它才能修改文件。';
    case 'command':
      return policy.allowCommands
        ? null
        : '运行命令在当前服务中没有开启（WORKSPACE_COMMANDS）。不要重试；请告诉用户需要开启它才能执行命令。';
  }
}

/** The policy implied by configuration, in one sentence each. */
export function describePolicy(policy: ToolPolicy): string {
  const writes = policy.allowWorkspaceWrites ? '可写' : '只读';
  const commands = policy.allowCommands ? '可执行命令' : '禁止命令';
  return `${writes} · ${commands}`;
}
