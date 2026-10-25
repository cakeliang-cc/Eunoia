/**
 * The summary contract between the session layer and a model.
 *
 * The session layer owns *what* must survive; the agent layer owns *how* to call
 * a provider. This file is the boundary: a pure request/response shape plus the
 * prompt. No SDK import reaches the session layer.
 *
 * The prompt is deliberately about a companion, not a coding agent. nanobot's
 * consolidator archives task state ("active objective", "next action"), which
 * would turn a conversation about someone's week into a ticket. What matters
 * here is continuity of a person: facts, preferences, promises, themes, and the
 * emotional shape of what happened.
 */

import { createHash } from 'node:crypto';
import type { Message } from './types.ts';
import { truncateToTokens, type TokenEstimatorMode } from './tokens.ts';

export interface SummaryRequest {
  readonly previousSummary: string | null;
  readonly messages: readonly Message[];
  /** Hard cap for the summary model; also bounds the stored checkpoint. */
  readonly maxOutputTokens: number;
}

export type SummaryGenerator = (request: SummaryRequest) => Promise<string>;

export const SUMMARY_SYSTEM_PROMPT = `你是长期陪伴对话的摘要器。把“已有摘要”和“新增对话”合并成一份紧凑、可继续对话的中文摘要。

保留：
- 用户的稳定事实、偏好、边界和明确纠正
- 重要事件、时间、人物、承诺和未完成的主题
- 情绪与关系的连续性：发生了什么，ta 当时怎么感受
- 对后续对话有用的具体细节

不要：
- 给建议、评判或诊断
- 编造对话里没有出现的内容
- 保留寒暄、重复、无长期价值的细节
- 输出标题、列表符号或元评论

直接输出摘要正文。如果没有任何值得保留的内容，只输出“（没有需要保留的内容）”。`;

export const SUMMARY_PROMPT_VERSION = createHash('sha256')
  .update(SUMMARY_SYSTEM_PROMPT)
  .digest('hex')
  .slice(0, 12);

const ROLE_LABEL: Readonly<Record<Message['role'], string>> = {
  user: '用户',
  assistant: '陪伴者',
  system: '系统',
};

export function renderSummaryPrompt(request: SummaryRequest): string {
  const previous = request.previousSummary?.trim();
  const transcript = request.messages
    .map((message) => `${ROLE_LABEL[message.role]}：${message.content}`)
    .join('\n\n');

  return [
    '[已有摘要]',
    previous && previous.length > 0 ? previous : '（无）',
    '',
    '[新增对话]',
    transcript,
  ].join('\n');
}

/**
 * The system-prompt block. It is a block, not a fake message: a synthetic user
 * turn would be visible to the model as something the person said and would
 * pollute the transcript the UI renders.
 */
export function renderArchivedSummary(summary: string): string {
  return [
    '# 更早的对话',
    '',
    '以下是这段对话更早部分的摘要。它不是逐字记录，但那些事发生过。',
    '',
    summary.trim(),
  ].join('\n');
}

/** Normalise model output before it becomes a stored checkpoint. */
export function cleanSummary(raw: string, maxTokens: number, mode: TokenEstimatorMode): string {
  const text = raw
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return truncateToTokens(text, maxTokens, mode);
}
