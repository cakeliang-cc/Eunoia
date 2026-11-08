/**
 * The tool system's public surface.
 *
 * Nothing here imports a vendor SDK. That is the boundary that makes the loop
 * replaceable and the tools testable without a model: a tool is a schema, a
 * policy class and an async function, and every one of those can be exercised
 * with a temp directory.
 */

export type {
  ReadLedger,
  ReadRecord,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPolicy,
  ToolResult,
  ToolResultMeta,
  ToolSchema,
  ToolSideEffect,
} from './types.ts';
export { DEFAULT_TOOL_POLICY, defineTool, renderToolResult, toolError, toolOk } from './types.ts';
export { ToolRegistry } from './registry.ts';
export { describePolicy, policyDenial } from './policy.ts';
export { TurnReadLedger } from './ledger.ts';
export { jsonSchemaOf, parseToolArguments } from './schema.ts';
export {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
  truncateMiddle,
  truncateTail,
} from './truncate.ts';
export { Workspace, WorkspaceError } from './workspace.ts';
export type { DirectoryListing, EditResult, FileSlice, GlobResult, GrepResult, WorkspaceOptions, WriteResult } from './workspace.ts';
export type {
  ToolDirectoryListing,
  ToolEditResult,
  ToolExecutionResult,
  ToolExecutor,
  ToolFileSlice,
  ToolGrepResult,
  ToolLanguagePort,
  ToolSandboxSession,
  ToolWorkspacePort,
  ToolWriteResult,
} from './types.ts';
export { createMemoryTools } from './memory.ts';
export { createSkillTools } from './skill.ts';
export type { SkillToolOptions } from './skill.ts';
export {
  changeDirectoryTool,
  codingTools,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runCommandTool,
  writeFileTool,
} from './coding/index.ts';
export { summarizeToolCall, summarizeToolResult } from './summary.ts';
