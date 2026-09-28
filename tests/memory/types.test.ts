/**
 * Naming a conversation after the message that opened it.
 *
 * Small enough to look trivial, which is exactly why it is worth a test: the
 * function is the only thing standing between a list of conversations and a list
 * of paragraphs, and its failure mode — a title that renders as three lines of a
 * message someone typed in a bad moment — is one nobody would notice in a unit
 * test that only checked the happy path.
 */

import { describe, expect, it } from 'vitest';
import { CONVERSATION_TITLE_CHARS, conversationTitle } from '../../src/memory/types.ts';

describe('conversationTitle', () => {
  it('keeps a short message whole', () => {
    expect(conversationTitle('今天不想上班')).toBe('今天不想上班');
  });

  it('cuts a long one at the budget and marks the cut', () => {
    const long = '我'.repeat(CONVERSATION_TITLE_CHARS + 10);
    const title = conversationTitle(long);

    // The ellipsis is a character of its own, so the visible text is the budget
    // plus one — the alternative is a title that silently drops the signal that
    // there is more.
    expect(title).toBe(`${'我'.repeat(CONVERSATION_TITLE_CHARS)}…`);
    expect(title.length).toBe(CONVERSATION_TITLE_CHARS + 1);
  });

  it('does not cut a message that is exactly at the budget', () => {
    const exact = '我'.repeat(CONVERSATION_TITLE_CHARS);
    expect(conversationTitle(exact)).toBe(exact);
  });

  it('collapses a multi-line opener onto one line', () => {
    // A first message is often several lines. In a list row they would render as
    // a broken paragraph rather than a name.
    expect(conversationTitle('第一行\n第二行\n\n第三行')).toBe('第一行 第二行 第三行');
  });

  it('trims, so a message that opens with blank lines still names something', () => {
    expect(conversationTitle('  \n 你好  \n ')).toBe('你好');
  });

  it('counts characters, not bytes, because the text is Chinese', () => {
    // A byte budget would cut a Chinese title at eight characters. UTF-16 units
    // are the right count for CJK, where one character is one unit — an emoji is
    // two, so a title made of them is cut sooner than the budget suggests. That
    // is the accepted cost of not reaching for a grapheme splitter to name a
    // list row; the worst case is a short title, not a wrong one.
    expect(conversationTitle('今天很开心')).toBe('今天很开心');
    expect(conversationTitle('🫠'.repeat(30))).toBe(`${'🫠'.repeat(12)}…`);
  });

  it('returns an empty string for a message that is only whitespace', () => {
    // Not a title, but the caller decides what to do with that; the store's
    // `title IS NULL` guard is what keeps an empty name from being written.
    expect(conversationTitle('   \n  ')).toBe('');
  });
});
