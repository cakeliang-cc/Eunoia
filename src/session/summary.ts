/**
 * The summary contract between the session layer and a model.
 *
 * The session layer owns *what* must survive; the agent layer owns *how* to call
 * a provider. This file is the boundary: a pure request/response shape plus the
 * prompts. No SDK import reaches the session layer.
 *
 * There are two templates because two kinds of conversation lose different
 * things. The companion template preserves a person: facts, preferences,
 * promises, and the emotional shape of what happened. The coding template
 * preserves work: the requirement, the files, what the tests said, what is still
 * unconfirmed, and the next step. Using the companion template for a coding task
 * produces a warm paragraph that cannot resume anything; using the coding
 * template for a conversation about someone's week turns it into a ticket.
 *
 * The checkpoint's facts are not all model-written. `checkpoint.ts` appends a
 * system-recorded work-evidence block after the model's narrative, and the
 * prompt shows the model that evidence so the narrative agrees with it.
 */

import { createHash } from 'node:crypto';
import type { Message } from './types.ts';
import type { CheckpointMode, WorkLedger } from './checkpoint.ts';
import { renderWorkEvidence, splitCheckpoint } from './checkpoint.ts';
import type { TaskBoardSnapshot } from './task-board.ts';
import { truncateToTokens, type TokenEstimatorMode } from './tokens.ts';

export interface SummaryRequest {
  readonly previousSummary: string | null;
  readonly messages: readonly Message[];
  /** Hard cap for the summary model; also bounds the stored checkpoint. */
  readonly maxOutputTokens: number;
  /** Which template to write. Missing means companion, the legacy behaviour. */
  readonly mode?: CheckpointMode;
  /** System-recorded work state for a coding checkpoint. */
  readonly ledger?: WorkLedger | null;
  /** The Team task board, when the conversation belongs to one. */
  readonly board?: TaskBoardSnapshot | null;
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

/**
 * The coding template.
 *
 * Every section answers a question a resumed agent has to ask before it can act:
 * what is the job, what changed, what is proven, what is unknown, what next, and
 * which board task does it belong to. "What was proven" is deliberately separate
 * from "what was done" — a changed file is not a passing test.
 */
export const CODING_SUMMARY_PROMPT = `你是编码任务的检查点压缩器。把「已有检查点」「系统记录的工作证据」和「新增对话」合并成一份检查点，让另一个模型在不丢失工作状态的情况下继续这个代码任务。

只输出下面这个 Markdown 结构，保留每一节、按顺序；用简短 bullet，不写段落；某节没有内容就写“（无）”，不要删节。

## 任务与约束
- [用户要什么、验收标准、明确的约束、禁止事项、必须保留的行为；带原话]

## 已完成
- [已经实现或修改的行为，按结果写；没做完的写清停在哪一步]

## 文件与改动理由
- [真实改动过的路径 — 改了什么、为什么这样改；只写证据里出现过的文件，不猜路径]

## 验证
- [命令或检查 — 通过/失败/未确认；失败保留失败原因；没有运行就写“未验证”]

## 待确认
- [没有返回结果的工具调用、未知的外部副作用、尚未验证的假设]

## 下一步
- [下一个具体动作，以及依据（文件、命令或证据序号）]

## 任务板
- [任务 id — 状态 — 验收条件或未完成原因；没有任务板就写（无）]

## 关键决定与原话
- [用户明确要求、纠正、边界；逐字引用；没有则（无）]

规则：
- 用中文写，简洁、具体；保留路径、命令、退出码、任务 id 和原话。
- 「工作证据」是系统记录的事实：与对话冲突时以证据为准并写明差异；不要编造文件、测试结果或退出码。
- 不要把计划写成已完成；没做的事放进「下一步」或「待确认」。
- 不要提到“摘要”“压缩”“检查点”“证据”这些词，也不要解释你在压缩。
- 只输出检查点正文，不要调用工具。
- 已有检查点里仍然成立的内容保留，过时的删掉；不要原样复述旧检查点。`;

export function summarySystemPrompt(mode: CheckpointMode = 'companion'): string {
  return mode === 'coding' ? CODING_SUMMARY_PROMPT : SUMMARY_SYSTEM_PROMPT;
}

/**
 * A prompt version per template.
 *
 * One shared constant would make an evaluation recording unable to say which
 * template produced it, which is exactly the comparison the version exists for.
 */
export function summaryPromptVersion(mode: CheckpointMode = 'companion'): string {
  return createHash('sha256')
    .update(`${mode}\n${summarySystemPrompt(mode)}`)
    .digest('hex')
    .slice(0, 12);
}

/** The legacy export: the companion template's version. */
export const SUMMARY_PROMPT_VERSION = summaryPromptVersion('companion');

const ROLE_LABEL: Readonly<Record<Message['role'], string>> = {
  user: '用户',
  assistant: '陪伴者',
  system: '系统',
};

/**
 * What the summariser sees for one message.
 *
 * An image cannot be replayed to the summary model as pixels, and pretending it
 * was never there would let a later text route silently "forget" a picture. The
 * marker keeps the fact and the source id so a future route can decide to re-open
 * the original; it is explicitly *not* a description of the image.
 */
function summaryText(message: Message): string {
  if (message.role !== 'user' || !message.contentParts) return message.content;
  return message.contentParts.parts
    .map((part) =>
      part.type === 'text' ? part.text : `[图片附件（原图仍保存在媒体库，其 id 为 ${part.assetId}）]`,
    )
    .join('\n');
}

export function renderSummaryPrompt(request: SummaryRequest): string {
  const mode = request.mode ?? 'companion';
  const previous = splitCheckpoint(request.previousSummary?.trim() ?? '').narrative.trim();
  const transcript = request.messages
    .map((message) => `${ROLE_LABEL[message.role]}：${summaryText(message)}`)
    .join('\n\n');

  const sections = ['[已有检查点]', previous.length > 0 ? previous : '（无）', ''];

  // Only the coding template has a work-evidence contract. Sending an empty
  // section to a companion summary would invite the model to invent one.
  if (mode === 'coding') {
    const evidence = renderWorkEvidence(request.ledger ?? null, request.board ?? null);
    sections.push('[系统记录的工作证据]', evidence.length > 0 ? evidence : '（无工具记录）', '');
  }

  sections.push('[新增对话]', transcript);
  return sections.join('\n');
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
    '这是系统自动生成的检查点，用来在上下文中保留更早的对话和工作状态。把下面内容当作已经发生的背景，不要复述它，也不要提到“摘要”“压缩”或“检查点”；直接从后面的消息继续。',
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
