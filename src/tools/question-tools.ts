/**
 * `ask_user_question`: pause the turn for a typed requirement.
 *
 * The answer is a requirement, not a capability grant. A tool call that asks
 * twice with the same id is idempotent; a different question under the same id
 * is a conflict, never a second question.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolDefinition } from './types.ts';
import { isQuestionError } from './question-errors.ts';
import type { QuestionService } from '../questions/service.ts';
import type { QuestionSchema } from '../questions/types.ts';

const fieldSchema = z.object({
  key: z.string().min(1).max(41),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'select', 'multi', 'boolean', 'number']),
  required: z.boolean().optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .max(20)
    .optional(),
  placeholder: z.string().max(200).optional(),
});

export function createQuestionTools(questions: QuestionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'ask_user_question',
      description:
        'Ask the person one focused question and wait for the answer. Use it for a missing requirement (target branch, API shape, design choice) — never for permission, which is the approval flow. ' +
        'Provide typed fields when possible; a free-text question is allowed.',
      parameters: z.object({
        question: z.string().min(1).max(2_000),
        fields: z.array(fieldSchema).max(10).optional(),
        allowOther: z.boolean().optional(),
      }),
      sideEffect: 'none',
      readOnly: false,
      guidelines:
        'ask_user_question pauses this turn until the person answers or the question expires. Do not ask a question you can answer from the workspace.',
      timeoutMs: 10 * 60_000,
      async execute({ question, fields, allowOther }, context) {
        if (!context.userId || !context.conversationId) {
          return toolError('提问缺少会话或用户上下文。');
        }
        const schema: QuestionSchema = {
          fields: (fields ?? []).map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            required: field.required !== false,
            ...(field.options ? { options: field.options } : {}),
            ...(field.placeholder ? { placeholder: field.placeholder } : {}),
          })),
          ...(allowOther ? { allowOther: true } : {}),
        };
        try {
          const record = await questions.ask({
            userId: context.userId,
            conversationId: context.conversationId,
            turnId: null,
            callId: context.toolCallId ?? context.actionId ?? null,
            prompt: question,
            schema,
          });
          const answer = await questions.wait(context.userId, record.id, {
            ...(context.signal ? { signal: context.signal } : {}),
            timeoutMs: 10 * 60_000,
          });
          const rendered = Object.entries(answer)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
            .join('\n');
          return toolOk(`用户回答了问题「${question}」：\n${rendered}`, {
            summary: '已回答',
            questionId: record.id,
          });
        } catch (error) {
          if (isQuestionError(error)) {
            return toolError(error.message, { code: error.code });
          }
          return toolError(error instanceof Error ? error.message : String(error), {
            code: 'QUESTION_FAILED',
          });
        }
      },
    }),
  ];
}
