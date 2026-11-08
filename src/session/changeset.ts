/**
 * Turn-scoped workspace change sets.
 *
 * Crash recovery answers "where did execution get to". This module answers a
 * different question: "what did this one turn change, and can it be safely
 * undone now?". Keeping the two apart matters because their safety rules are
 * opposite — recovery may overwrite to restore a known state, while undo must
 * *refuse* when the person has touched a file since.
 *
 * A change set stores one row per file with:
 *
 *   - the before/after digests, which are how a later edit is detected;
 *   - the before content for edits the agent performed through the file tools;
 *   - a checkpoint reference for files changed by a command;
 *   - whether the file has already been restored, so a retry is partial-safe.
 *
 * External MCP operations are deliberately out of scope: this store can only
 * describe files in the workspace. A server-side write has no generic inverse,
 * and pretending otherwise would be a destructive promise the host cannot keep.
 */

import type { WorkspaceChangeKind } from '../sandbox/workspace-files.ts';

export type ChangesetStatus = 'available' | 'undone' | 'partial';

export type ChangeRestoreSource = 'journal' | 'checkpoint' | 'none';

export interface ChangesetFileRecord {
  readonly path: string;
  readonly kind: WorkspaceChangeKind;
  readonly beforeSha: string | null;
  readonly afterSha: string | null;
  readonly beforeBytes: number | null;
  readonly afterBytes: number | null;
  /** Before content for a file the agent wrote/edited; null when restored from a checkpoint. */
  readonly beforeContent: string | null;
  readonly restoreSource: ChangeRestoreSource;
  readonly restored: boolean;
}

export interface WorkspaceChangesetSummary {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly checkpointId: string | null;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly fileCount: number;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly status: ChangesetStatus;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface WorkspaceChangesetRecord extends WorkspaceChangesetSummary {
  readonly files: readonly ChangesetFileRecord[];
}

export interface NewChangesetInput {
  readonly summary: WorkspaceChangesetSummary;
  readonly files: readonly ChangesetFileRecord[];
}

export interface ChangesetStore {
  createWorkspaceChangeset(input: NewChangesetInput): Promise<void>;
  getWorkspaceChangeset(userId: string, id: string): Promise<WorkspaceChangesetRecord | null>;
  getWorkspaceChangesetForTurn(
    userId: string,
    conversationId: string,
    turnId: string,
  ): Promise<WorkspaceChangesetRecord | null>;
  listWorkspaceChangesets(
    userId: string,
    conversationId: string,
    limit?: number,
  ): Promise<WorkspaceChangesetSummary[]>;
  /** Mark files applied; `status` is the state after this partial undo. */
  finishWorkspaceUndo(input: {
    readonly userId: string;
    readonly changesetId: string;
    readonly restoredPaths: readonly string[];
    readonly status: ChangesetStatus;
    readonly undoneAt: string;
  }): Promise<void>;
}

/** What an undo did, per file. Returned to the UI and kept out of the model. */
export interface WorkspaceUndoResult {
  readonly changesetId: string;
  readonly turnId: string;
  readonly status: ChangesetStatus;
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  readonly conflicts: readonly { readonly path: string; readonly reason: string }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly alreadyUndone: boolean;
}
