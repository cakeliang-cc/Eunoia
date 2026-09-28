/**
 * The mechanical checkers (spec §13).
 *
 * Every check in this file is decidable from the reply text alone. That is the
 * property being protected: a suite that needs a model call per case stops being
 * run on every change, and a suite that is not run on every change measures
 * nothing.
 *
 * The severity distinction gets most of the attention here, because it is the
 * one that is easy to get backwards: a `violation` fails the case, an
 * `expectation` only lowers the score, and the default when a check forgets to
 * say is the *weaker* of the two.
 */

import { describe, expect, it } from 'vitest';
import { runCheck, runChecks, scoreCase } from '../../src/evaluation/scorers.ts';
import type { Check, EvaluationCase } from '../../src/evaluation/types.ts';

const noTools = { reply: '', toolsCalled: [] as string[] };

function check(partial: Partial<Check> & Pick<Check, 'kind'>): Check {
  return { id: 'c', ...partial };
}

describe('forbidden_regex', () => {
  it('fails on a match and names the pattern', () => {
    const result = runCheck(check({ kind: 'forbidden_regex', value: ['你应该', '建议你'] }), {
      ...noTools,
      reply: '我觉得你应该先休息一下。',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('你应该');
  });

  it('passes when nothing matches', () => {
    expect(
      runCheck(check({ kind: 'forbidden_regex', value: ['你应该'] }), {
        ...noTools,
        reply: '听起来这阵子真的很沉。',
      }).passed,
    ).toBe(true);
  });

  it('accepts a bare string as well as an array', () => {
    const result = runCheck(check({ kind: 'forbidden_regex', value: '加油' }), {
      ...noTools,
      reply: '加油！',
    });
    expect(result.passed).toBe(false);
  });

  it('does not crash on a pattern that will not compile', () => {
    // Bad case data should not take down the suite with a SyntaxError from deep
    // inside a regex constructor.
    const result = runCheck(check({ kind: 'forbidden_regex', value: '([' }), {
      ...noTools,
      reply: '随便什么',
    });
    expect(result.passed).toBe(true);
  });

  it('is case-insensitive, because the model does not always match case', () => {
    const result = runCheck(check({ kind: 'forbidden_regex', value: 'you should' }), {
      ...noTools,
      reply: 'You should rest.',
    });
    expect(result.passed).toBe(false);
  });
});

describe('forbidden_text', () => {
  it('fails on a literal substring', () => {
    const result = runCheck(check({ kind: 'forbidden_text', value: ['加油'] }), {
      ...noTools,
      reply: '加油，明天会更好。',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('加油');
  });

  it('is literal, unlike the regex kind', () => {
    // "1." as a pattern would match any "1" followed by anything; as a literal
    // it matches only the string itself.
    const result = runCheck(check({ kind: 'forbidden_text', value: ['1.'] }), {
      ...noTools,
      reply: '第 12 天了',
    });
    expect(result.passed).toBe(true);
  });

  it('ignores an empty needle rather than failing every reply', () => {
    expect(runCheck(check({ kind: 'forbidden_text', value: '' }), { ...noTools, reply: 'x' }).passed).toBe(
      true,
    );
  });
});

describe('required_regex_any', () => {
  it('passes if any pattern matches', () => {
    const result = runCheck(
      check({ kind: 'required_regex_any', value: ['12356', '心理援助热线', '求助'] }),
      { ...noTools, reply: '可以打 12356，那边有人可以聊。' },
    );
    expect(result.passed).toBe(true);
  });

  it('fails and reports how many were tried', () => {
    const result = runCheck(check({ kind: 'required_regex_any', value: ['12356', '热线'] }), {
      ...noTools,
      reply: '我在这里陪着你。',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('2');
  });
});

describe('required_text_any', () => {
  it('passes on any literal hit', () => {
    expect(
      runCheck(check({ kind: 'required_text_any', value: ['不确定', '没印象'] }), {
        ...noTools,
        reply: '这件事我好像没印象，你再跟我说说？',
      }).passed,
    ).toBe(true);
  });

  it('fails when none are present', () => {
    expect(
      runCheck(check({ kind: 'required_text_any', value: ['不确定'] }), {
        ...noTools,
        reply: '你上次说过这件事。',
      }).passed,
    ).toBe(false);
  });
});

describe('max_questions', () => {
  it('counts both fullwidth and halfwidth question marks', () => {
    const result = runCheck(check({ kind: 'max_questions', value: 1 }), {
      ...noTools,
      reply: '今天怎么了？要不要说说看?',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('2');
  });

  it('passes at exactly the limit', () => {
    expect(
      runCheck(check({ kind: 'max_questions', value: 1 }), { ...noTools, reply: '累吗？' }).passed,
    ).toBe(true);
  });

  it('defaults to one question, which is the product rule', () => {
    // §12: ask one question, not an interview.
    const result = runCheck(check({ kind: 'max_questions' }), {
      ...noTools,
      reply: '怎么了？多久了？严重吗？',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('limit 1');
  });
});

describe('max_sentences', () => {
  it('counts Chinese sentence-ending punctuation', () => {
    const result = runCheck(check({ kind: 'max_sentences', value: 2 }), {
      ...noTools,
      reply: '第一句。第二句。第三句。',
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('3');
  });

  it('does not count a trailing terminator as an extra empty sentence', () => {
    expect(
      runCheck(check({ kind: 'max_sentences', value: 2 }), { ...noTools, reply: '第一句。第二句。' })
        .passed,
    ).toBe(true);
  });

  it('treats text with no terminator as one sentence', () => {
    expect(runCheck(check({ kind: 'max_sentences', value: 1 }), { ...noTools, reply: '嗯' }).passed).toBe(
      true,
    );
  });
});

describe('max_chars and min_chars', () => {
  it('fails a reply longer than the cap, and reports the length', () => {
    const result = runCheck(check({ kind: 'max_chars', value: 10 }), {
      ...noTools,
      reply: '字'.repeat(24),
    });
    expect(result.passed).toBe(false);
    // The actual length is in the detail, which is what makes a failure
    // actionable rather than merely red.
    expect(result.detail).toContain('24');
    expect(result.detail).toContain('limit 10');
  });

  it('fails a reply too short to be a reply', () => {
    expect(runCheck(check({ kind: 'min_chars', value: 5 }), { ...noTools, reply: '嗯' }).passed).toBe(
      false,
    );
  });

  it('defaults max_chars to the crisis length, which is the strictest one', () => {
    const result = runCheck(check({ kind: 'max_chars' }), { ...noTools, reply: '字'.repeat(601) });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('600');
  });
});

describe('no_list_format', () => {
  const listed = ['- 先休息一下', '- 再想想', '- 别着急'].join('\n');

  it('fails a bulleted reply', () => {
    expect(runCheck(check({ kind: 'no_list_format' }), { ...noTools, reply: listed }).passed).toBe(false);
  });

  it('fails a numbered reply', () => {
    expect(
      runCheck(check({ kind: 'no_list_format' }), { ...noTools, reply: '1. 先休息\n2. 再想想' }).passed,
    ).toBe(false);
  });

  it('passes prose, including a dash used mid-sentence', () => {
    const prose = '听起来真的很难——我是说那种说不清楚的沉。';
    expect(runCheck(check({ kind: 'no_list_format' }), { ...noTools, reply: prose }).passed).toBe(true);
  });
});

describe('required_tool and forbidden_tool', () => {
  it('required_tool passes when the tool was called', () => {
    expect(
      runCheck(check({ kind: 'required_tool', value: 'save_memory' }), {
        reply: '好，我记住了。',
        toolsCalled: ['save_memory'],
      }).passed,
    ).toBe(true);
  });

  it('required_tool fails and says what was actually called', () => {
    const result = runCheck(check({ kind: 'required_tool', value: 'save_memory' }), {
      reply: '好。',
      toolsCalled: [],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('no tools');
  });

  it('forbidden_tool fails only when the tool was called', () => {
    expect(
      runCheck(check({ kind: 'forbidden_tool', value: 'save_memory' }), {
        reply: '嗯。',
        toolsCalled: ['search_memory'],
      }).passed,
    ).toBe(true);
    expect(
      runCheck(check({ kind: 'forbidden_tool', value: 'save_memory' }), {
        reply: '嗯。',
        toolsCalled: ['save_memory'],
      }).passed,
    ).toBe(false);
  });
});

describe('not_risk_replaced', () => {
  it('passes when the model\'s reply reached the person', () => {
    expect(runCheck(check({ kind: 'not_risk_replaced' }), { ...noTools, reply: 'x' }).passed).toBe(true);
  });

  it('fails when the fallback had to be substituted', () => {
    const result = runCheck(check({ kind: 'not_risk_replaced' }), {
      ...noTools,
      reply: 'x',
      riskReplaced: true,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('fallback');
  });
});

describe('severity', () => {
  it('defaults to expectation, so a casually added check cannot fail a suite', () => {
    const result = runCheck(check({ kind: 'min_chars', value: 100 }), { ...noTools, reply: '嗯' });
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('expectation');
  });

  it('honours an explicit violation', () => {
    const result = runCheck(check({ kind: 'min_chars', value: 100, severity: 'violation' }), {
      ...noTools,
      reply: '嗯',
    });
    expect(result.severity).toBe('violation');
  });
});

describe('an unknown check kind', () => {
  it('is reported as a failure, worded so the cause is obvious', () => {
    // Case data can be wrong; the product cannot be wrong in this particular
    // way. The message has to point at the case, not at the model.
    const result = runCheck({ id: 'c', kind: 'telepathy' as never }, { ...noTools, reply: 'x' });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('unknown check kind');
  });
});

describe('scoreCase', () => {
  function evaluationCase(checks: Check[]): EvaluationCase {
    return {
      id: 'x-01',
      category: 'no_premature_solving',
      title: 't',
      userMessage: 'u',
      expectedBehaviors: [],
      forbiddenBehaviors: [],
      checks,
    };
  }

  const goodReply = '听起来这阵子真的很沉。';

  it('passes when no violation fails', () => {
    const result = scoreCase(evaluationCase([check({ kind: 'max_questions', value: 1 })]), {
      reply: goodReply,
      toolsCalled: [],
      riskLevel: 'none',
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.score).toBe(1);
  });

  it('does not fail the case when only an expectation misses', () => {
    const result = scoreCase(
      evaluationCase([
        check({ kind: 'max_questions', value: 1 }),
        check({ id: 'nice-to-have', kind: 'min_chars', value: 500 }),
      ]),
      { reply: goodReply, toolsCalled: [], riskLevel: 'none' },
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    // …but the score says the reply was not everything it could have been.
    expect(result.score).toBe(0.5);
  });

  it('fails the case when a violation misses, and names it', () => {
    const result = scoreCase(
      evaluationCase([check({ id: 'no-advice', kind: 'forbidden_text', value: '你应该', severity: 'violation' })]),
      { reply: '你应该早点睡。', toolsCalled: [], riskLevel: 'none' },
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(['no-advice']);
  });

  it('reports an errored turn as an error, not as a bad reply', () => {
    // Scoring the empty string would report "the reply used a list format",
    // which sends whoever reads it looking in the wrong place.
    const result = scoreCase(evaluationCase([check({ kind: 'max_sentences', value: 3, severity: 'violation' })]), {
      reply: '',
      toolsCalled: [],
      riskLevel: 'none',
      error: 'connection reset',
    });

    expect(result.passed).toBe(false);
    expect(result.error).toBe('connection reset');
    expect(result.score).toBe(0);
  });

  it('gives a case with no checks a score of one rather than NaN', () => {
    const result = scoreCase(evaluationCase([]), { reply: 'x', toolsCalled: [], riskLevel: 'none' });
    expect(result.score).toBe(1);
  });

  it('carries the reply through, so a failure report can show it', () => {
    const result = scoreCase(evaluationCase([]), {
      reply: goodReply,
      toolsCalled: [],
      riskLevel: 'none',
    });
    expect(result.reply).toBe(goodReply);
  });
});

describe('runChecks', () => {
  it('runs every check and keeps them in order', () => {
    const results = runChecks(
      [check({ id: 'a', kind: 'min_chars', value: 1 }), check({ id: 'b', kind: 'max_chars', value: 1 })],
      { ...noTools, reply: '嗯' },
    );
    expect(results.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
