/**
 * The front-end workspace's data contract.
 *
 * These types are deliberately independent of the agent's sandbox types. The
 * workbench is a person looking at their own directory, not a model executing a
 * tool: it reads files, asks git what changed, and runs a command the person
 * typed. Keeping the vocabulary separate is what stops the UI from becoming a
 * second, unaudited execution path for the agent.
 */

export type WorkspaceEntryType = 'directory' | 'file' | 'other';

export interface WorkspaceEntry {
  /** Base name, as it appears in the directory. */
  readonly name: string;
  /** Workspace-relative, `/`-separated path. `''` is never an entry. */
  readonly path: string;
  readonly type: WorkspaceEntryType;
}

export interface WorkspaceListing {
  /** Workspace-relative path of the directory itself. */
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
  /** True when the directory has more entries than the response cap. */
  readonly truncated: boolean;
}

export interface WorkspaceFile {
  readonly path: string;
  /** File text without the line-number gutter. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly totalLines: number;
  /** True only when the returned slice is the whole file. */
  readonly complete: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface WorkspaceBrowseEntry {
  readonly name: string;
  /** Absolute, canonical directory path. */
  readonly path: string;
}

export interface WorkspaceBrowse {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly WorkspaceBrowseEntry[];
  /** True when navigation above this directory is refused by configuration. */
  readonly rooted: boolean;
}

export type WorkspaceRootSource = 'config' | 'selected';

export interface WorkspaceState {
  readonly configured: boolean;
  readonly root: string | null;
  /** The final path segment, for a compact title. */
  readonly name: string | null;
  readonly source: WorkspaceRootSource | null;
  /**
   * The directory the agent's file tools are pointed at, when it differs from
   * the workbench root. The UI shows this so a person can tell that they are
   * looking somewhere else.
   */
  readonly agentRoot: string | null;
  readonly terminal: boolean;
  readonly git: boolean;
  readonly maxFileBytes: number;
  /** Where the directory picker starts when no path is supplied. */
  readonly browseStart: string;
}

export type WorkspaceChangeKind =
  | 'untracked'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'conflicted'
  | 'typechange'
  | 'unknown';

export interface WorkspaceChange {
  readonly path: string;
  readonly kind: WorkspaceChangeKind;
  /** The one-line status git prints, e.g. ` M`, `??`, `R `. */
  readonly status: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly renamedFrom: string | null;
}

export interface WorkspaceGitStatus {
  readonly repo: boolean;
  readonly branch: string | null;
  readonly changes: readonly WorkspaceChange[];
  readonly truncated: boolean;
  /** Present when git exists but the command failed. */
  readonly error: string | null;
}

export interface WorkspaceDiff {
  readonly path: string;
  readonly patch: string;
  readonly binary: boolean;
  readonly untracked: boolean;
  readonly oversized: boolean;
  readonly truncated: boolean;
}

export type WorkspaceErrorCode =
  | 'no-workspace'
  | 'not-found'
  | 'not-a-directory'
  | 'outside-workspace'
  | 'ignored'
  | 'sensitive'
  | 'binary'
  | 'too-large'
  | 'invalid-path'
  | 'terminal-disabled'
  | 'git-unavailable'
  | 'unavailable';

export class WorkspaceUiError extends Error {
  override readonly name = 'WorkspaceUiError';
  readonly code: WorkspaceErrorCode;
  readonly status: number;

  constructor(code: WorkspaceErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
