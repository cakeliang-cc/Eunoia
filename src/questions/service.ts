/**
 * The typed-question service.
 *
 * An answer is a requirement, not a permission: it is validated against the
 * declared fields, persisted, and delivered to the waiting turn. A question that
 * is answered after the turn disappeared keeps its answer but does not invent a
 * continuation.
 */

import { randomUUID } from 'node:crypto';
import type { QuestionStore } from './store.ts';
import type { QuestionField, QuestionSchema, UserQuestionRecord } from './types.ts';
import { QuestionError } from './types.ts';

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_FIELDS = 10;

export interface QuestionServiceDeps {
  readonly store: QuestionStore;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly onChange?: (question: UserQuestionRecord) => void;
}

interface Waiter {
  readonly resolve: (answer: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | null;
}

export class QuestionService {
  readonly #store: QuestionStore;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #onChange: QuestionServiceDeps['onChange'];
  readonly #waiters = new Map<string, Waiter>();
  readonly #listeners = new Set<(question: UserQuestionRecord) => void>();

  constructor(deps: QuestionServiceDeps) {
    this.#store = deps.store;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.#onChange = deps.onChange;
  }

  onChange(listener: (question: UserQuestionRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(record: UserQuestionRecord): void {
    this.#onChange?.(record);
    for (const listener of this.#listeners) listener(record);
  }

  async ask(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly turnId?: string | null;
    readonly callId?: string | null;
    readonly memberId?: string | null;
    readonly prompt: string;
    readonly schema?: QuestionSchema;
  }): Promise<UserQuestionRecord> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new QuestionError('QUESTION_INVALID', '问题不能为空。', 400);
    if (prompt.length > 2_000) {
      throw new QuestionError('QUESTION_INVALID', '问题超过 2000 字符。', 400);
    }
    const schema = normalizeSchema(input.schema);
    const callId = input.callId ?? null;
    if (callId) {
      const existing = await this.#store.getUserQuestionByCall(
        input.userId,
        input.conversationId,
        callId,
      );
      if (existing) {
        const same = existing.prompt === prompt && JSON.stringify(existing.schema) === JSON.stringify(schema);
        if (!same) {
          throw new QuestionError(
            'QUESTION_CONFLICT',
            '同一个 tool call 已经提出过不同的问题；不能产生第二份副作用。',
            409,
          );
        }
        return existing;
      }
    }
    const now = this.#now();
    const record: UserQuestionRecord = {
      id: randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      callId,
      memberId: input.memberId ?? null,
      generation: Date.now(),
      prompt,
      schema,
      status: 'pending',
      answer: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      answeredAt: null,
    };
    await this.#store.createUserQuestion(record);
    this.#notify(record);
    return record;
  }

  /** Wait for an answer. A stored answer wins even if it arrived first. */
  async wait(
    userId: string,
    questionId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const current = await this.#store.getUserQuestion(userId, questionId);
    if (!current) throw new QuestionError('QUESTION_NOT_FOUND', '没有这个问题。', 404);
    if (current.status === 'answered' && current.answer) return current.answer;
    if (current.status === 'expired') throw new QuestionError('QUESTION_EXPIRED', '问题已经过期。', 410);
    if (current.status === 'cancelled') throw new QuestionError('QUESTION_CANCELLED', '问题已经取消。', 409);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        const waiter = this.#waiters.get(questionId);
        if (waiter?.timer) clearTimeout(waiter.timer);
        this.#waiters.delete(questionId);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      const finish = (answer: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        const waiter = this.#waiters.get(questionId);
        if (waiter?.timer) clearTimeout(waiter.timer);
        this.#waiters.delete(questionId);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = (): void => finishReject(new QuestionError('QUESTION_CANCELLED', '等待被取消。', 409));
      const timeoutMs = options.timeoutMs ?? this.#ttlMs;
      const timer = setTimeout(() => {
        void this.#expireOne(userId, questionId).finally(() => {
          finishReject(new QuestionError('QUESTION_TIMEOUT', '等待回答超时。', 408));
        });
      }, timeoutMs);
      timer.unref();
      this.#waiters.set(questionId, { resolve: finish, reject: finishReject, timer });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  async answer(input: {
    readonly userId: string;
    readonly questionId: string;
    readonly answer: unknown;
  }): Promise<UserQuestionRecord> {
    const record = await this.#store.getUserQuestion(input.userId, input.questionId);
    if (!record) throw new QuestionError('QUESTION_NOT_FOUND', '没有这个问题。', 404);
    if (record.status !== 'pending') {
      throw new QuestionError(
        'QUESTION_ALREADY_ANSWERED',
        record.status === 'expired' ? '问题已经过期。' : '问题已经处理过了。',
        409,
      );
    }
    const answer = validateAnswer(record.schema, input.answer);
    const changed = await this.#store.resolveUserQuestion({
      userId: input.userId,
      id: record.id,
      status: 'answered',
      answer,
      at: this.#now().toISOString(),
    });
    if (!changed) throw new QuestionError('QUESTION_ALREADY_ANSWERED', '问题已经处理过了。', 409);
    const next = (await this.#store.getUserQuestion(input.userId, record.id)) as UserQuestionRecord;
    this.#waiters.get(record.id)?.resolve(answer);
    this.#notify(next);
    return next;
  }

  async cancel(userId: string, questionId: string): Promise<UserQuestionRecord> {
    const record = await this.#store.getUserQuestion(userId, questionId);
    if (!record) throw new QuestionError('QUESTION_NOT_FOUND', '没有这个问题。', 404);
    if (record.status === 'pending') {
      await this.#store.resolveUserQuestion({
        userId,
        id: questionId,
        status: 'cancelled',
        answer: null,
        at: this.#now().toISOString(),
      });
      this.#waiters.get(questionId)?.reject(
        new QuestionError('QUESTION_CANCELLED', '问题被用户取消。', 409),
      );
    }
    const next = (await this.#store.getUserQuestion(userId, questionId)) as UserQuestionRecord;
    this.#notify(next);
    return next;
  }

  async pending(userId: string, conversationId: string): Promise<UserQuestionRecord[]> {
    await this.#store.expireUserQuestions(this.#now());
    return this.#store.listPendingQuestions(userId, conversationId);
  }

  async expireStale(): Promise<number> {
    return this.#store.expireUserQuestions(this.#now());
  }

  async #expireOne(userId: string, questionId: string): Promise<void> {
    await this.#store.resolveUserQuestion({
      userId,
      id: questionId,
      status: 'expired',
      answer: null,
      at: this.#now().toISOString(),
    });
  }
}

function normalizeSchema(schema: QuestionSchema | undefined): QuestionSchema {
  if (!schema) return { fields: [] };
  if (schema.fields.length > MAX_FIELDS) {
    throw new QuestionError('QUESTION_INVALID', `最多 ${MAX_FIELDS} 个字段。`, 400);
  }
  const seen = new Set<string>();
  for (const field of schema.fields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(field.key)) {
      throw new QuestionError('QUESTION_INVALID', `字段 key 不合法：${field.key}`, 400);
    }
    if (seen.has(field.key)) {
      throw new QuestionError('QUESTION_INVALID', `字段 key 重复：${field.key}`, 400);
    }
    seen.add(field.key);
    if ((field.type === 'select' || field.type === 'multi') && (!field.options || field.options.length === 0)) {
      throw new QuestionError('QUESTION_INVALID', `字段 ${field.key} 缺少选项。`, 400);
    }
  }
  return schema;
}

function validateAnswer(schema: QuestionSchema, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new QuestionError('QUESTION_INVALID', '答案必须是一个对象。', 400);
  }
  const input = raw as Record<string, unknown>;
  if (schema.fields.length === 0) {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length === 0) throw new QuestionError('QUESTION_INVALID', '答案不能为空。', 400);
    if (text.length > 4_000) throw new QuestionError('QUESTION_INVALID', '答案超过 4000 字符。', 400);
    return { text };
  }
  const answer: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const value = input[field.key];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) {
        throw new QuestionError('QUESTION_INVALID', `缺少必填字段：${field.label}`, 400);
      }
      continue;
    }
    answer[field.key] = validateField(field, value);
  }
  if (schema.allowOther === true && typeof input.other === 'string' && input.other.trim().length > 0) {
    answer.other = input.other.trim().slice(0, 4_000);
  }
  return answer;
}

function validateField(field: QuestionField, value: unknown): unknown {
  const options = new Set((field.options ?? []).map((option) => option.value));
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 需要是/否。`, 400);
      }
      return value;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 需要数字。`, 400);
      }
      return value;
    }
    case 'select': {
      if (typeof value !== 'string' || !options.has(value)) {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 不是允许的选项。`, 400);
      }
      return value;
    }
    case 'multi': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !options.has(entry))) {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 包含不允许的选项。`, 400);
      }
      return [...new Set(value as string[])];
    }
    case 'text':
    default: {
      if (typeof value !== 'string') {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 需要文本。`, 400);
      }
      if (value.length > 4_000) {
        throw new QuestionError('QUESTION_INVALID', `${field.label} 超过 4000 字符。`, 400);
      }
      return value;
    }
  }
}
