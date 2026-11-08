import type { UserQuestionRecord } from './types.ts';

export interface QuestionStore {
  createUserQuestion(record: UserQuestionRecord): Promise<void>;
  getUserQuestion(userId: string, id: string): Promise<UserQuestionRecord | null>;
  getUserQuestionByCall(
    userId: string,
    conversationId: string,
    callId: string,
  ): Promise<UserQuestionRecord | null>;
  listPendingQuestions(userId: string, conversationId: string): Promise<UserQuestionRecord[]>;
  /** Pending questions asked by one member, for close/recovery cleanup. */
  listPendingQuestionsByMember(userId: string, memberId: string): Promise<UserQuestionRecord[]>;
  /** Atomically pending → answered/cancelled/expired; false when not pending. */
  resolveUserQuestion(input: {
    readonly userId: string;
    readonly id: string;
    readonly status: Exclude<UserQuestionRecord['status'], 'pending'>;
    readonly answer: Record<string, unknown> | null;
    readonly at: string;
  }): Promise<boolean>;
  expireUserQuestions(now: Date): Promise<number>;
}
