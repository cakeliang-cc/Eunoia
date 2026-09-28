/**
 * Relationship state: how long we have known each other, and whether we have
 * (spec §25, §43).
 *
 * The spec lists Relationship State as a component of context and Relationship
 * Continuity as an evaluation dimension, and does not say what either is. What
 * follows is the smallest version that changes behaviour, chosen against a
 * measured failure rather than a design intuition.
 *
 * ## The failure this exists for
 *
 * `relationship-01` asks a brand-new user's question — "我们之前聊过吧？你还记得
 * 我说过什么吗？" — and the reply, before this module existed, was:
 *
 * > 说实话，我这边没有留下之前的记录——不是说你没说过，而是我这次打开时没检索到
 * > 存下来的东西。
 *
 * That is a report on a database query. The honest answer is "this is the first
 * time we've spoken", and the companion could not say it, because it had no way
 * to tell a first conversation from a two-hundredth. It had to interpret the
 * question as a *retrieval* problem, because retrieval was the only thing it had
 * that could be wrong.
 *
 * ## Derived, not stored
 *
 * Everything here comes from counts that already exist. A `relationship` table
 * would need a migration (spec §1), would disagree with the conversations it
 * summarises as soon as one was deleted, and would be a cache of an aggregate —
 * which is a thing that goes stale in exchange for nothing.
 *
 * ## Facts, not a stage
 *
 * There is deliberately no "new / familiar / close" taxonomy. The bands would be
 * invented numbers, and a companion that behaves differently at day 13 than at
 * day 14 is worse than one that reads the facts. What is rendered is what is
 * true; the one derived judgement is the boolean that matters — whether there is
 * any history at all.
 */

import type { HistoryStats } from './store.ts';

export interface RelationshipState {
  readonly conversations: number;
  readonly messages: number;
  readonly firstAt: Date | null;
  readonly lastAt: Date | null;
  /** Whole days since the first conversation, or null when there has been none. */
  readonly daysKnown: number | null;
  /**
   * True when there is no history to speak of.
   *
   * The only derived judgement here, and the one the failure above turned on:
   * "have we spoken before" is a question with an answer, unlike "are we close".
   */
  readonly isFirstMeeting: boolean;
}

/**
 * Below this many messages, a conversation count of one still means "we have
 * just started".
 *
 * The threshold exists because the first conversation is not over when the first
 * message is: at message two the companion should still not claim to know
 * someone, and by message six it should stop disclaiming a relationship it has
 * begun to have.
 */
export const FIRST_MEETING_MESSAGES = 6;

const MS_PER_DAY = 86_400_000;

export function describeRelationship(
  stats: HistoryStats,
  options: { readonly now?: Date } = {},
): RelationshipState {
  const now = options.now ?? new Date();
  const daysKnown =
    stats.firstAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - stats.firstAt.getTime()) / MS_PER_DAY));

  return {
    conversations: stats.conversations,
    messages: stats.messages,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    daysKnown,
    isFirstMeeting: stats.conversations <= 1 && stats.messages < FIRST_MEETING_MESSAGES,
  };
}

/** "今天" / "3 天" / "2 周" / "5 个月" — coarse on purpose. */
function spanLabel(days: number): string {
  if (days <= 0) return '今天';
  if (days < 14) return `${days} 天`;
  if (days < 60) return `${Math.round(days / 7)} 周`;
  return `${Math.round(days / 30)} 个月`;
}

/**
 * The block appended to the system prompt, or `''` when there is nothing to say.
 *
 * Two rules are encoded, and both are about what the model must not do with
 * this:
 *
 *   - **It is not to be announced.** "我们已经认识 34 天了" is a strange thing to
 *     say out loud to a person; it is a fact about the companion's situation, not
 *     a contribution to the conversation. The same rule the memory block carries,
 *     for the same reason.
 *   - **A first meeting is stated, not performed.** The instruction says what is
 *     true and lets the model find its own words — writing a script here would
 *     make every first conversation identical, which is its own failure.
 */
export function renderRelationship(state: RelationshipState): string {
  if (state.firstAt === null) return '';

  const lines: string[] = ['这是你和这个人之间已经发生的事：'];

  if (state.isFirstMeeting) {
    lines.push(
      `- 你们刚开始认识：${state.conversations} 次对话、${state.messages} 条消息。`,
      '',
      '所以：不要声称记得没发生过的事，也不要把关系说得比实际更近。如果 ta 问起"我们是不是聊过"，如实说这是刚开始——自然一点，这不是一件遗憾的事。',
    );
    return lines.join('\n');
  }

  const days = state.daysKnown ?? 0;
  lines.push(
    `- 你们认识大约 ${spanLabel(days)}（${state.conversations} 次对话、${state.messages} 条消息）。`,
    '',
    '所以：不必像第一次见面那样重新介绍自己，也不必刻意提起时间。这些只是你自己的坐标，不是话题。',
  );
  return lines.join('\n');
}
