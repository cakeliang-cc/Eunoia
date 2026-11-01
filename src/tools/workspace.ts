/**
 * Compatibility shim: the file workspace used by tests and tools.
 *
 * The implementation moved to `src/sandbox/workspace-files.ts` when the tools
 * were migrated to the Sandbox Gateway. Two things changed in the move and both
 * are load-bearing:
 *
 *   - **`runCommand` is gone.** The old class spawned a host shell with the real
 *     environment. That was the bypass ADR 017 §12.1 forbids, and leaving it as a
 *     convenience would have kept the whole refactor cosmetic. Commands now go
 *     through `ToolExecutor`, which is implemented by the Gateway.
 *   - **Path resolution is the sandbox path guard.** Reads open with
 *     `O_NOFOLLOW`; writes are atomic and re-check the nearest real ancestor.
 *
 * The name is kept because tests and skill discovery construct `new Workspace({
 * root })`; production code receives a `ToolWorkspacePort` from the Gateway and
 * never constructs one of these directly.
 */

export {
  WorkspaceFiles as Workspace,
  WorkspaceError,
  type DirectoryListing,
  type EditResult,
  type FileSlice,
  type GlobResult,
  type GrepResult,
  type ReadLinesOptions,
  type WriteResult,
} from '../sandbox/workspace-files.ts';
export type { PathGuardOptions as WorkspaceOptions } from '../sandbox/paths.ts';
