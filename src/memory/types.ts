/**
 * The vocabulary of memory (spec §5, ADR 003).
 *
 * Four layers, only three of which are persisted:
 *
 *   working    — the current session's recent turns. Session state, never
 *                written to the database. See `working-memory.ts`.
 *   episodic   — something that happened, anchored to a time.
 *   semantic   — a durable fact or preference about the person.
 *   narrative  — an ongoing story or theme they are living through.
 *
 * The three persisted layers share one shape because they share one problem:
 * every one of them needs to record how sure we are, where it came from, and
 * whether it has since been superseded. Splitting them into three tables would
 * mean solving that three times and drifting on two of them.
 */

export const MEMORY_TYPES = ['episodic', 'semantic', 'narrative'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Where a memory came from. Not decoration — the writer's admission rules are
 * keyed on this, because "the user told me" and "I concluded this" earn very
 * different levels of trust.
 */
export const MEMORY_SOURCES = ['user_explicit', 'user_stated', 'inferred'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_STATUSES = ['active', 'unconfirmed', 'superseded', 'deleted'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface Memory {
  readonly id: string;
  readonly userId: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly source: MemorySource;
  readonly status: MemoryStatus;
  readonly tags: readonly string[];
  readonly supersededBy: string | null;
  readonly sourceMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastAccessedAt: Date | null;
  readonly accessCount: number;
}

/** A memory as proposed, before the writer has applied policy to it. */
export interface MemoryDraft {
  readonly type: MemoryType;
  readonly content: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly source: MemorySource;
  readonly tags?: readonly string[];
  readonly sourceMessageId?: string | null;
  /**
   * Normally decided by the writer rather than supplied: a caller that can set
   * `status` directly can bypass the "inferences are never settled fact" rule.
   * It is settable so the store can round-trip a row faithfully.
   */
  readonly status?: MemoryStatus;
}

export interface MemoryPatch {
  readonly content?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly status?: MemoryStatus;
  readonly tags?: readonly string[];
}

export type MemoryEventAction =
  | 'created'
  | 'updated'
  | 'superseded'
  | 'deleted'
  | 'retrieved'
  | 'rejected';

export interface MemoryEvent {
  readonly memoryId: string | null;
  readonly userId: string;
  readonly action: MemoryEventAction;
  readonly actor: 'agent' | 'user' | 'system';
  readonly reason?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: Date;
}

export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly title: string | null;
  readonly startedAt: Date;
  readonly lastTurnAt: Date | null;
  readonly turnCount: number;
}

/** Human-readable labels, used when rendering memories into the prompt. */
export const MEMORY_TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  episodic: '发生过的事',
  semantic: '关于你的稳定事实',
  narrative: '你正在经历的',
};

export const MEMORY_SOURCE_LABELS: Readonly<Record<MemorySource, string>> = {
  user_explicit: '你明确让我记住的',
  user_stated: '你说过的',
  inferred: '我的推测（未经你确认）',
};
