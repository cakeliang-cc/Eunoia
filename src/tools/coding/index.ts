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
export { changeDirectoryTool } from './change-directory-tool.ts';
export {
  diagnosticsTool,
  findDefinitionTool,
  findReferencesTool,
  isSemanticPath,
  SEMANTIC_EXTENSIONS,
  semanticTools,
} from './semantic-tools.ts';

import { editFileTool, writeFileTool } from './edit-tools.ts';
import { runCommandTool } from './command-tool.ts';
import { changeDirectoryTool } from './change-directory-tool.ts';
import { semanticTools } from './semantic-tools.ts';
import { globTool, grepTool, listDirTool, readFileTool } from './read-tools.ts';

/**
 * The coding tool set. `change_directory` sits next to `bash` because the
 * two are one workflow: the command is stateless, the directory is not.
 */
export const codingTools = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  changeDirectoryTool,
  ...semanticTools,
] as const;
