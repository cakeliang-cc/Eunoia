/**
 * The summary contract between the session layer and a model.
 *
 * The session layer owns *what* must survive; the agent layer owns *how* to call
 * a provider. This file is the boundary: a pure request/response shape plus the
 * prompt. No SDK import reaches the session layer.
 *
 * The prompt is deliberately about a companion, not a coding agent. A
 * task-oriented consolidator archives state such as "active objective" and
 * "next action", which would turn a conversation about someone's week into a
 * ticket. What matters here is continuity of a person: facts, preferences,
 * promises, themes, and the emotional shape of what happened.
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

export const SUMMARY_SYSTEM_PROMPT = `你是长期陪伴对话的压缩器。把「已有摘要」和「新增对话」合并成一份结构化检查点，让另一个模型在不丢失关键上下文的情况下继续这段关系。

只输出下面这个 Markdown 结构，保留每一节、按顺序；用简短 bullet，不写段落；某节没有内容就写“（无）”，不要删节。

## 当前主线
- [ta 正在经历、想解决或反复回到的事；必要时保留原话]

## 重要事实与偏好
- [稳定的事实、偏好、边界、明确纠正；带时间、人物、数字]

## 人物与关系
- [重要人物、关系变化、ta 对关系的感受；没有则（无）]

## 情绪与连续性
- [发生了什么、ta 当时怎么感受、哪些情绪还没有结束；不做诊断]

## 承诺与未完成
- [ta 说要做或答应的事、还没有结束的主题]

## 最近状态
- [检查点之前正在发生什么；具体到下一个模型能直接接上]

## 需要保留的原话
- [对语气、价值观或边界重要的原话，逐字引用；没有则（无）]

## 关键背景
- [决定及理由、约束、雷区、开放问题、继续对话需要知道的事]

规则：
- 用中文写，简洁、具体；保留时间、人物、数字和原话。
- 不编造，不把推测写成事实；不建议、不评判、不诊断。
- 不要提到“摘要”“压缩”“检查点”这些词。
- 只输出检查点正文，不要调用工具。
- 如果已有摘要，保留仍然成立的事实，删掉过时的，合并新信息；不要原样复述旧摘要。`;

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
 *
 * The framing treats the summary as context, not a new instruction. The tags
 * make the boundary visible to the model; the sentence about not acknowledging
 * it keeps the machinery out of the conversation.
 */
export function renderArchivedSummary(summary: string): string {
  return [
    '# 更早的对话',
    '',
    '这是系统自动生成的检查点，用来在上下文中保留更早的对话。把下面内容当作已经发生的背景，不要复述它，也不要提到“摘要”“压缩”或“检查点”；直接从后面的消息继续。',
    '',
    '<compacted-summary>',
    summary.trim(),
    '</compacted-summary>',
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
