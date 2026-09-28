/**
 * Risk detection.
 *
 * The difficult part of this file is not catching crisis language — that is a
 * list of patterns. It is *not* catching all the ways Chinese uses the same
 * vocabulary as an intensifier. A companion that responds to "今天累死了" with a
 * suicide hotline is broken in a way that is worse than useless, so the idiom
 * cases below are as important as the crisis ones.
 *
 * The other direction is tested too: every pattern here leans toward caution,
 * and there are cases asserting that genuine signals are *not* swallowed by the
 * idiom guard.
 */

import { describe, expect, it } from 'vitest';
import { assessRisk, maxRisk, stripIdioms } from '../../src/safety/risk.ts';

describe('assessRisk — crisis', () => {
  const crisisMessages = [
    '我觉得活着没什么意思了，不想再撑下去了',
    '我想死',
    '我不想活了',
    '有时候真想一了百了',
    '我昨晚割了自己一下',
    '我在想要不要跳楼',
    'I want to die',
    'I keep thinking about killing myself',
    '我想杀了他',
  ];

  for (const message of crisisMessages) {
    it(`flags crisis: "${message.slice(0, 24)}"`, () => {
      expect(assessRisk(message).level).toBe('crisis');
    });
  }
});

describe('assessRisk — elevated', () => {
  const elevatedMessages = [
    '最近压力好大，快撑不下去了',
    '我觉得很绝望',
    '我快崩溃了',
    '每天喘不过气来',
    '没有人在乎我',
  ];

  for (const message of elevatedMessages) {
    it(`flags elevated: "${message.slice(0, 24)}"`, () => {
      expect(assessRisk(message).level).toBe('elevated');
    });
  }

  it('reports abuse as elevated with its own category', () => {
    const assessment = assessRisk('他在家里打我，我不知道该怎么办');
    expect(assessment.level).toBe('elevated');
    expect(assessment.categories).toContain('abuse');
  });
});

describe('assessRisk — idioms are not crisis', () => {
  const idioms = [
    '今天累死了',
    '笑死我了',
    '想死你了',
    '烦死了',
    '饿死了，什么时候吃饭',
    '气死我了',
    '困死了',
    '这破天气热死了',
  ];

  for (const message of idioms) {
    it(`does not flag: "${message}"`, () => {
      expect(assessRisk(message).level).toBe('none');
    });
  }

  it('still catches a real signal inside an idiomatic sentence', () => {
    // The guard strips the idiom, not the sentence.
    expect(assessRisk('今天累死了，而且我真的不想活了').level).toBe('crisis');
  });

  it('stripIdioms removes the idiom and leaves the rest', () => {
    expect(stripIdioms('笑死我了')).not.toContain('笑死');
    expect(stripIdioms('笑死我了，但我想死')).toContain('想死');
  });
});

describe('assessRisk — ordinary conversation is left alone', () => {
  const ordinary = [
    '今天真的什么都不想做',
    '我是不是应该辞职',
    '他三个小时没回我，是不是不在乎我',
    '我拿到offer了但是一点都不开心',
    '好累啊',
    '我最近在想要不要换工作',
  ];

  for (const message of ordinary) {
    it(`does not flag: "${message}"`, () => {
      expect(assessRisk(message).level).toBe('none');
    });
  }
});

describe('assessRisk — shape of the result', () => {
  it('returns none with no categories for empty input', () => {
    expect(assessRisk('')).toEqual({ level: 'none', categories: [] });
    expect(assessRisk('   ')).toEqual({ level: 'none', categories: [] });
  });

  it('reports the highest level when several rules match', () => {
    // Both distress and ideation present: the answer must be crisis, not
    // whichever rule happened to be checked first.
    const assessment = assessRisk('我快崩溃了，而且我不想活了');
    expect(assessment.level).toBe('crisis');
    expect(assessment.categories).toContain('acute_distress');
    expect(assessment.categories).toContain('suicidal_ideation');
  });

  it('never carries the matched text', () => {
    // The assessment reaches logs (spec §14). A person's worst moment is not
    // log material, so categories are reported and text is not.
    const assessment = assessRisk('我想死');
    const serialised = JSON.stringify(assessment);
    expect(serialised).not.toContain('想死');
    expect(serialised).toContain('suicidal_ideation');
  });

  it('does not throw on non-string input', () => {
    expect(assessRisk(undefined as unknown as string).level).toBe('none');
    expect(assessRisk(null as unknown as string).level).toBe('none');
  });
});

describe('maxRisk', () => {
  it('orders levels', () => {
    expect(maxRisk('none', 'elevated')).toBe('elevated');
    expect(maxRisk('crisis', 'elevated')).toBe('crisis');
    expect(maxRisk('elevated', 'elevated')).toBe('elevated');
  });
});
