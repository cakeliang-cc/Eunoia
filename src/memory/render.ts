/**
 * Rendering retrieved memories into prompt text.
 *
 * Two decisions are encoded here, and both are about honesty rather than
 * formatting:
 *
 *   - **Provenance and confidence are always shown.** A memory the person asked
 *     us to keep and a hunch the model formed last week are rendered
 *     differently, so the model cannot state the second as though it were the
 *     first. The label is carried in the text rather than left to the model's
 *     judgement, because the model is precisely the thing that cannot be trusted
 *     to remember which is which.
 *   - **The block is framed as background, not as an instruction.** Retrieval
 *     scores relevance; it does not know whether a memory bears on *this* turn.
 *     Handing the model a scored list and calling it "what you know" would make
 *     it mention things that happen to rank highly, which is the behaviour that
 *     makes a companion feel like it is reading from a file.
 *
 * The empty case returns an empty string rather than a header saying "no
 * memories", so no prompt text is spent telling the model about an absence.
 */

import { MEMORY_SOURCE_LABELS, MEMORY_TYPE_LABELS, type Memory } from './types.ts';
import type { ScoredMemory } from './retrieval.ts';

/** Coarse importance bands, used instead of a raw float nobody can calibrate. */
function importanceLabel(importance: number): string {
  if (importance >= 0.8) return '重要';
  if (importance >= 0.5) return '一般';
  return '次要';
}

export function renderMemories(
  memories: readonly (Memory | ScoredMemory)[],
  options: { readonly maxChars?: number } = {},
): string {
  const items = memories.map((entry) => ('memory' in entry ? entry.memory : entry));
  if (items.length === 0) return '';

  const maxChars = options.maxChars ?? 1600;
  const lines: string[] = [];
  let used = 0;

  for (const memory of items) {
    const line =
      `- [${MEMORY_SOURCE_LABELS[memory.source]} · ` +
      `${MEMORY_TYPE_LABELS[memory.type]} · ${importanceLabel(memory.importance)}] ` +
      memory.content;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }

  if (lines.length === 0) return '';

  return [
    '以下是你记得的、可能和这一轮有关的片段。它们**不是全部**，只是这次检索到的：',
    ...lines,
    '',
    '使用这些片段的规则：',
    '- 只在真的相关时自然带出，不要为了显得记得而提及。',
    '- 标注为「我的推测」的，是你自己的猜测，不要说成事实；如果不确定，可以直接问。',
    '- 不要复述这个列表，也不要罗列你知道的事。',
    '- 如果一条都用不上，就完全不要提。',
  ].join('\n');
}
