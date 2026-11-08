/**
 * The port the sandbox uses to report a change to the active turn.
 *
 * The sandbox does not know what a "turn" is, and must not import the session
 * layer to find out. This interface is the whole dependency: before a write it
 * offers the file's prior content; before a command it asks for a checkpoint.
 * A deployment without undo simply omits it.
 */

export interface WorkspaceChangeRecorder {
  /** Capture this file's current bytes before the agent overwrites them. */
  beforeWrite(input: { readonly taskId: string; readonly path: string }): Promise<void>;
  /** Take one checkpoint before the first command of the turn. */
  beforeCommand(input: { readonly taskId: string }): Promise<void>;
}
