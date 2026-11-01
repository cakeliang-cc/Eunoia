/**
 * The front-end workbench's public surface.
 *
 * `WorkspaceUiService` owns a person-selected directory and the read-only git
 * inspection around it. `handleWorkspaceRoute` is the HTTP adapter. Neither is
 * imported by the agent loop or by the coding tools; the workbench is a view,
 * not a second tool executor.
 */

export { WorkspaceUiService } from './service.ts';
export type { WorkspaceUiServiceOptions } from './service.ts';
export { handleWorkspaceRoute } from './routes.ts';
export {
  workspaceUiConfig,
  workspaceUiStatePath,
  workspaceUiTerminalEnabled,
} from './config.ts';
export type { WorkspaceUiConfig } from './config.ts';
export { WorkspaceUiError } from './types.ts';
export type {
  WorkspaceBrowse,
  WorkspaceBrowseEntry,
  WorkspaceChange,
  WorkspaceChangeKind,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceEntryType,
  WorkspaceErrorCode,
  WorkspaceFile,
  WorkspaceGitStatus,
  WorkspaceListing,
  WorkspaceRootSource,
  WorkspaceState,
} from './types.ts';
