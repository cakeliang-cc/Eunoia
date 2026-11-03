/**
 * Who an operation is for, as the Gateway sees it.
 *
 * `taskId` is the conversation id; `userId` is checked against the task row, so
 * a caller cannot act on somebody else's task by naming it. Kept in its own
 * module because both the Gateway and its file-operations collaborator need the
 * shape, and importing one from the other would make the type-only dependency
 * look like a runtime cycle.
 */

export interface SandboxContext {
  readonly taskId: string;
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly toolCallId?: string | null;
}
