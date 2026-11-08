/**
 * The persistence port for the model transcript.
 *
 * Kept separate from `SessionStore` and `TurnStore` on purpose: message rows are
 * what the UI reads, turn rows are execution bookkeeping, and transcript rows
 * are the model's own replay facts. They share ids, not tables.
 *
 * The important operation is `prepareStep`: appending new items, recording the
 * attempt and advancing the context baseline happen in one transaction. A
 * prepared step that exists without its items (or a baseline that advanced
 * before the items were durable) is exactly the state restart cannot reason
 * about.
 */

import type {
  ModelContextState,
  ModelEpoch,
  ModelItem,
  ModelStepRecord,
  NewModelContextState,
  NewModelItem,
  RequestProjection,
  StepStatus,
} from './model-transcript.ts';

export interface CreateEpochInput {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly parentEpochId: string | null;
  readonly reason: ModelEpoch['reason'];
  readonly instructions: string;
  readonly promptVersion: string;
  readonly tools: ModelEpoch['tools'];
  readonly toolsHash: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly encoderRevision: string;
  readonly windowItemIds: readonly string[];
  readonly windowRevision: number;
  readonly seededThroughSeq: number;
  readonly createdAt: Date;
}

export interface NewStepAttempt {
  readonly attemptId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly step: number;
  readonly attemptNo: number;
  readonly epochId: string;
  readonly epochRevision: number;
  readonly inputItemIds: readonly string[];
  readonly outputItemIds?: readonly string[];
  readonly requestConfigDigest: string;
  readonly projection: RequestProjection | null;
  readonly status: StepStatus;
  readonly createdAt: Date;
}

export interface PrepareStepInput {
  /** New items to append in the same transaction as the step and the baseline. */
  readonly items: readonly NewModelItem[];
  readonly step: NewStepAttempt;
  /** Advance the active window only when this request's view changed. */
  readonly window?: {
    readonly epochId: string;
    readonly expectedRevision: number;
    readonly itemIds: readonly string[];
  };
  readonly state?: readonly NewModelContextState[];
}

export interface PrepareStepResult {
  readonly items: readonly ModelItem[];
  readonly step: ModelStepRecord;
  readonly epoch: ModelEpoch | null;
}

export interface StepPatch {
  readonly status?: StepStatus;
  readonly outputItemIds?: readonly string[];
  readonly usage?: ModelStepRecord['usage'];
  readonly responseId?: string | null;
  readonly error?: string | null;
  readonly finishReason?: string | null;
  readonly projection?: RequestProjection | null;
  readonly completedAt?: Date | null;
}

export class TranscriptRevisionConflictError extends Error {
  readonly code = 'MODEL_TRANSCRIPT_REVISION_CONFLICT';
  readonly retryable = true;
  readonly epochId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(epochId: string, expected: number, actual: number) {
    super(`model epoch ${epochId} revision is ${actual}, expected ${expected}`);
    this.name = 'TranscriptRevisionConflictError';
    this.epochId = epochId;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ModelTranscriptStore {
  createEpoch(input: CreateEpochInput): Promise<ModelEpoch>;

  activeEpoch(conversationId: string): Promise<ModelEpoch | null>;

  listEpochs(conversationId: string): Promise<ModelEpoch[]>;

  getEpoch(epochId: string): Promise<ModelEpoch | null>;

  /** Idempotent on `(conversationId, idempotencyKey)`. Returns stored order. */
  appendItems(items: readonly NewModelItem[]): Promise<ModelItem[]>;

  listItems(conversationId: string, ids?: readonly string[]): Promise<ModelItem[]>;

  listEpochItems(epochId: string): Promise<ModelItem[]>;

  /** Message ids already represented by an item in any epoch. */
  knownMessageIds(conversationId: string): Promise<Set<string>>;

  contextState(conversationId: string, epochId: string): Promise<ModelContextState[]>;

  /**
   * Write comparison rows without appending a request. Used when a tool changes
   * authoritative state between model steps (a successful `change_directory`).
   */
  saveContextState(states: readonly NewModelContextState[]): Promise<void>;

  /**
   * Replace the active window view. Used when a tool result or a background
   * update is appended between model steps; the expected revision makes two
   * writers race visibly instead of silently discarding one view.
   */
  updateWindow(
    epochId: string,
    expectedRevision: number,
    itemIds: readonly string[],
  ): Promise<ModelEpoch>;

  /**
   * Append items, record the attempt and advance the baseline atomically.
   *
   * A stale window revision is a conflict, not a silent overwrite: two writers
   * may not both claim to have advanced the same view.
   */
  prepareStep(input: PrepareStepInput): Promise<PrepareStepResult>;

  updateStep(attemptId: string, patch: StepPatch): Promise<ModelStepRecord | null>;

  getStep(attemptId: string): Promise<ModelStepRecord | null>;

  listSteps(requestId: string): Promise<ModelStepRecord[]>;

  /** Newest first, bounded. Used by diagnostics, never by replay. */
  listRecentSteps(conversationId: string, limit: number): Promise<ModelStepRecord[]>;

  /**
   * Bind the UI assistant message to the model item that produced it.
   *
   * The UI message id is only known after the reply is persisted, so this is a
   * metadata update, not a content rewrite. The link is what lets a later
   * durable activation tell "this chat message is already in the transcript".
   */
  linkAssistantMessage(
    conversationId: string,
    requestId: string,
    messageId: string,
  ): Promise<void>;

  deleteTranscript(conversationId: string): Promise<void>;
}
