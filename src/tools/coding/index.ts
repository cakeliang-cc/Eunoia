/**
 * The coding tool set.
 *
 * Exported as a list rather than a registry so the caller decides what to do
 * with it: the service composes these with memory tools, the tests can pick one,
 * and a future code-only mode can drop the memory tools without editing this
 * module.
 */

export {
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  readOnlyCodingTools,
} from './read-tools.ts';
export { editFileTool, writeFileTool } from './edit-tools.ts';
export { runCommandTool } from './command-tool.ts';

import { editFileTool, writeFileTool } from './edit-tools.ts';
import { runCommandTool } from './command-tool.ts';
import { globTool, grepTool, listDirTool, readFileTool } from './read-tools.ts';

export const codingTools = [readFileTool, listDirTool, globTool, grepTool, editFileTool, writeFileTool, runCommandTool] as const;
