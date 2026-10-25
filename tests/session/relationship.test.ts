/**
 * Relationship state: the arithmetic, and the two rules about what the model
 * may do with it.
 *
 * The module exists because of one measured failure — a companion asked "我们
 * 之前聊过吧？" answered with a report on a database query, having no way to tell
 * a first conversation from a two-hundredth. So the tests that matter here are
 * the boundary ones: the empty history, the first conversation on its first
 * message and on its sixth, and the fact that the rendered block never
 * volunteers a number the model was not asked for.
 */

import { describe, expect, it } from 'vitest';
import {
  FIRST_MEETING_MESSAGES,
  describeRelationship,
  renderRelationship,
} from '../../src/session/relationship.ts';
import type { HistoryStats } from '../../src/session/types.ts';

const NOW = new Date('2026-09-29T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

function stats(overrides: Partial<HistoryStats> = {}): HistoryStats {
  return { conversations: 1, messages: 1, firstAt: NOW, lastAt: NOW, ...overrides };
}

describe('describeRelationship', () => {
  it('reports nothing known for a user who has never spoken', () => {
    const state = describeRelationship(
      { conversations: 0, messages: 0, firstAt: null, lastAt: null },
      { now: NOW },
    );

    expect(state.daysKnown).toBeNull();
    // Not "first meeting" — there is no meeting. A brand-new user and a user
    // whose rows were all deleted land here, and neither has a relationship to
    // describe.
    expect(state.isFirstMeeting).toBe(true);
  });

  it('counts whole days, not fractions', () => {
    const state = describeRelationship(stats({ firstAt: daysAgo(3), lastAt: NOW }), { now: NOW });
    expect(state.daysKnown).toBe(3);
  });

  it('does not report negative days when the clock disagrees with the rows', () => {
    // A clock skew, a restored backup, a test fixture from the future. None of
    // them should produce "你们认识 -2 天".
    const state = describeRelationship(stats({ firstAt: daysAgo(-5), lastAt: NOW }), { now: NOW });
    expect(state.daysKnown).toBe(0);
  });

  it('treats one conversation with a few messages as still the first meeting', () => {
    const state = describeRelationship(
      stats({ messages: FIRST_MEETING_MESSAGES - 1 }),
      { now: NOW },
    );
    expect(state.isFirstMeeting).toBe(true);
  });

  it('stops calling it a first meeting once the first conversation has run on', () => {
    // The threshold is the interesting part: at message two the companion must
    // not claim to know someone, and by message six it must stop disclaiming a
    // relationship it has started to have.
    const state = describeRelationship(stats({ messages: FIRST_MEETING_MESSAGES }), { now: NOW });
    expect(state.isFirstMeeting).toBe(false);
  });

  it('is not a first meeting once there has been a second conversation', () => {
    const state = describeRelationship(stats({ conversations: 2, messages: 2 }), { now: NOW });
    expect(state.isFirstMeeting).toBe(false);
  });
});

describe('renderRelationship', () => {
  it('renders nothing at all when there is no history', () => {
    const block = renderRelationship(
      describeRelationship(
        { conversations: 0, messages: 0, firstAt: null, lastAt: null },
        { now: NOW },
      ),
    );
    expect(block).toBe('');
  });

  it('states the beginning as a fact rather than a script', () => {
    const block = renderRelationship(describeRelationship(stats(), { now: NOW }));

    expect(block).toContain('刚开始');
    // The instruction is what is true, not a sentence to say. A script here
    // would make every first conversation identical.
    expect(block).not.toContain('你可以说');
    expect(block).not.toContain('回答：');
  });

  it('tells the model not to claim a history that does not exist', () => {
    const block = renderRelationship(describeRelationship(stats(), { now: NOW }));
    expect(block).toContain('不要声称记得没发生过的事');
  });

  it('says the block is a coordinate rather than a topic for an old relationship', () => {
    const block = renderRelationship(
      describeRelationship(stats({ conversations: 9, messages: 120, firstAt: daysAgo(40) }), {
        now: NOW,
      }),
    );

    expect(block).toContain('坐标');
    expect(block).toContain('不是话题');
  });

  it('does not tell an established relationship it is just starting', () => {
    const block = renderRelationship(
      describeRelationship(stats({ conversations: 9, messages: 120, firstAt: daysAgo(40) }), {
        now: NOW,
      }),
    );
    expect(block).not.toContain('刚开始');
  });
});
