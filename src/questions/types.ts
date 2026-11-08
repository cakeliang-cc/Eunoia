/**
 * Typed questions to the person.
 *
 * A question is not an approval: approving grants a capability, answering
 * supplies a requirement. They share the idea of a paused turn but not their
 * lifecycle, so they have their own table, status and API.
 */

export type QuestionFieldType = 'text' | 'select' | 'multi' | 'boolean' | 'number';

export interface QuestionField {
  readonly key: string;
  readonly label: string;
  readonly type: QuestionFieldType;
  readonly required: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}

export interface QuestionSchema {
  readonly fields: readonly QuestionField[];
  readonly allowOther?: boolean;
}

export type QuestionStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

export interface UserQuestionRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly callId: string | null;
  readonly memberId: string | null;
  readonly generation: number;
  readonly prompt: string;
  readonly schema: QuestionSchema;
  readonly status: QuestionStatus;
  readonly answer: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly answeredAt: string | null;
}

export class QuestionError extends Error {
  readonly code:
    | 'QUESTION_INVALID'
    | 'QUESTION_NOT_FOUND'
    | 'QUESTION_ALREADY_ANSWERED'
    | 'QUESTION_EXPIRED'
    | 'QUESTION_CANCELLED'
    | 'QUESTION_TIMEOUT'
    | 'QUESTION_CONFLICT';
  readonly status: number;

  constructor(code: QuestionError['code'], message: string, status = 400) {
    super(message);
    this.name = 'QuestionError';
    this.code = code;
    this.status = status;
  }
}
