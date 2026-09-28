/**
 * The evaluation runner, driven by a canned executor.
 *
 * The runner is where the suite's *mechanics* live — isolation, seeding, scoring,
 * summarising, persistence, the two modes — and none of that is about the model.
 * Testing it against a fake executor means a failure here is a failure of the
 * harness rather than of a reply, which is the distinction that stops "the eval
 * failed" from being ambiguous.
 *
 * Case isolation gets the most attention. Each case runs as its own throwaway
 * user, and if that ever regresses, seeded memories leak between cases and the
 * suite starts passing for reasons that have nothing to do with the product.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { PROMPT_VERSION } from '../../src/agent/instructions.ts';
import { summarise, runEvaluation, type CaseExecutor } from '../../src/evaluation/runner.ts';
import type { CaseResult, EvaluationCase } from '../../src/evaluation/types.ts';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

function makeCase(overrides: Partial<EvaluationCase> & Pick<EvaluationCase, 'id'>): EvaluationCase {
  return {
    category: 'no_premature_solving',
    title: overrides.id,
    userMessage: '今天什么都不想做。',
    expectedBehaviors: ['停住'],
    forbiddenBehaviors: ['给建议'],
    checks: [{ id: 'no-advice', kind: 'forbidden_text', value: '你应该', severity: 'violation' }],
    ...overrides,
  };
}

/** An executor that answers every case with the same reply. */
function replyingWith(reply: string): CaseExecutor {
  return async (evaluationCase) => ({
    caseId: evaluationCase.id,
    reply,
    toolsCalled: [],
    riskLevel: 'none',
    riskReplaced: false,
    error: null,
  });
}

describe('scoring a run', () => {
  it('passes a case whose violations are all clear', async () => {
    const { run } = await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('听起来真的很沉。'),
    });

    expect(run.summary.passed).toBe(1);
    expect(run.summary.failed).toBe(0);
    expect(run.mode).toBe('live');
  });

  it('fails a case that violates a forbidden behaviour', async () => {
    const { run } = await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('你应该早点睡。'),
    });

    expect(run.summary.failed).toBe(1);
    expect(run.results[0]?.violations).toEqual(['no-advice']);
    expect(run.summary.violations).toBe(1);
  });

  it('reports failures with the reply, so a failure can be read', async () => {
    const { run } = await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('你应该早点睡。'),
    });

    expect(run.results[0]?.reply).toBe('你应该早点睡。');
    expect(run.results[0]?.checks.find((check) => check.id === 'no-advice')?.detail).toContain('你应该');
  });

  it('carries the prompt version and model on the run', async () => {
    const { run, recording } = await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('嗯。'),
    });

    // Without these, a recording cannot be told apart from one made by a
    // different prompt, and replaying it would measure nothing.
    expect(run.promptVersion).toBe(PROMPT_VERSION);
    expect(recording.promptVersion).toBe(PROMPT_VERSION);
    expect(run.model).toBeTruthy();
  });

  it('reports progress as it goes', async () => {
    const seen: number[] = [];
    await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' }), makeCase({ id: 'b' })],
      executor: replyingWith('嗯。'),
      onProgress: (completed) => seen.push(completed),
    });

    expect(seen).toEqual([1, 2]);
  });

  it('reports an errored case as an error rather than as a bad reply', async () => {
    const failing: CaseExecutor = async (evaluationCase) => ({
      caseId: evaluationCase.id,
      reply: '',
      toolsCalled: [],
      riskLevel: 'none',
      riskReplaced: false,
      error: 'connection reset',
    });

    const { run } = await runEvaluation({ store, cases: [makeCase({ id: 'a' })], executor: failing });

    expect(run.summary.failed).toBe(1);
    expect(run.results[0]?.error).toBe('connection reset');
    expect(run.results[0]?.violations).toEqual([]);
  });

  it('survives an executor that throws', async () => {
    const exploding: CaseExecutor = async () => {
      throw new Error('the model is on fire');
    };

    const { run } = await runEvaluation({ store, cases: [makeCase({ id: 'a' })], executor: exploding });

    expect(run.results[0]?.error).toContain('on fire');
    expect(run.summary.failed).toBe(1);
  });
});

describe('case isolation', () => {
  it('gives each case its own user', async () => {
    const users: string[] = [];
    const capturing: CaseExecutor = async (evaluationCase, context) => {
      users.push(context.userId);
      return {
        caseId: evaluationCase.id,
        reply: '嗯。',
        toolsCalled: [],
        riskLevel: 'none',
        riskReplaced: false,
        error: null,
      };
    };

    await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' }), makeCase({ id: 'b' })],
      executor: capturing,
    });

    expect(new Set(users).size).toBe(2);
    // A plain UUID, not `eval-a-<case>`. The readable id was nicer to debug and
    // impossible to insert: `users.id` is `uuid` in Postgres and the in-memory
    // store accepts any string, so only a real database could have rejected it.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const userId of users) expect(userId, `${userId} is not a uuid`).toMatch(UUID);
  });

  it('seeds memories under the case\'s own user, not a shared one', async () => {
    const seeded: number[] = [];
    const counting: CaseExecutor = async (evaluationCase, context) => {
      seeded.push((await context.store.listMemories(context.userId)).length);
      return {
        caseId: evaluationCase.id,
        reply: '嗯。',
        toolsCalled: [],
        riskLevel: 'none',
        riskReplaced: false,
        error: null,
      };
    };

    await runEvaluation({
      store,
      cases: [
        makeCase({
          id: 'a',
          seedMemories: [{ type: 'semantic', content: '用户的母亲生病了' }],
        }),
        makeCase({ id: 'b' }),
      ],
      executor: counting,
    });

    // The second case must not see the first case's seed. Otherwise a memory
    // case can pass because an earlier case happened to plant the answer.
    expect(seeded).toEqual([1, 0]);
  });

  it('seeds prior turns into the case\'s own conversation', async () => {
    const historyLengths: number[] = [];
    const counting: CaseExecutor = async (_evaluationCase, context) => {
      historyLengths.push((await context.store.listMessages(context.userId, context.conversationId)).length);
      return {
        caseId: _evaluationCase.id,
        reply: '嗯。',
        toolsCalled: [],
        riskLevel: 'none',
        riskReplaced: false,
        error: null,
      };
    };

    await runEvaluation({
      store,
      cases: [
        makeCase({
          id: 'a',
          seedTurns: [
            { role: 'user', content: '我们上次说到哪儿了' },
            { role: 'assistant', content: '说到你妈妈住院的事' },
          ],
        }),
      ],
      executor: counting,
    });

    expect(historyLengths).toEqual([2]);
  });
});

describe('persistence', () => {
  it('writes the case list and the results', async () => {
    const { run } = await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('嗯。'),
    });

    expect(store.evaluationCases).toHaveLength(1);
    expect(store.evaluationResults).toHaveLength(1);
    expect(store.evaluationResults[0]?.runId).toBe(run.runId);
    expect(store.evaluationResults[0]?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('writes nothing when persist is false', async () => {
    await runEvaluation({
      store,
      cases: [makeCase({ id: 'a' })],
      executor: replyingWith('嗯。'),
      persist: false,
    });

    expect(store.evaluationResults).toEqual([]);
    expect(store.evaluationCases).toEqual([]);
  });
});

describe('replay', () => {
  const cases = [makeCase({ id: 'a' }), makeCase({ id: 'b' })];

  it('scores recorded turns instead of calling the model', async () => {
    let called = 0;
    const counting: CaseExecutor = async (evaluationCase) => {
      called += 1;
      return {
        caseId: evaluationCase.id,
        reply: 'live reply',
        toolsCalled: [],
        riskLevel: 'none',
        riskReplaced: false,
        error: null,
      };
    };

    const { run } = await runEvaluation({
      store,
      cases,
      executor: counting,
      replay: [
        { caseId: 'a', reply: 'recorded A', toolsCalled: [], riskLevel: 'none', riskReplaced: false, error: null },
        { caseId: 'b', reply: '你应该这样。', toolsCalled: [], riskLevel: 'none', riskReplaced: false, error: null },
      ],
    });

    expect(called).toBe(0);
    expect(run.mode).toBe('recorded');
    expect(run.results.map((result) => result.reply)).toEqual(['recorded A', '你应该这样。']);
    expect(run.results[1]?.passed).toBe(false);
  });

  it('only replays cases it has a recording for, and runs the rest live', async () => {
    const answered: string[] = [];
    const capturing: CaseExecutor = async (evaluationCase) => {
      answered.push(evaluationCase.id);
      return {
        caseId: evaluationCase.id,
        reply: 'live',
        toolsCalled: [],
        riskLevel: 'none',
        riskReplaced: false,
        error: null,
      };
    };

    const { run } = await runEvaluation({
      store,
      cases,
      executor: capturing,
      replay: [
        { caseId: 'a', reply: 'recorded A', toolsCalled: [], riskLevel: 'none', riskReplaced: false, error: null },
      ],
    });

    // A partial recording fills the gap rather than erroring — useful when a
    // case was added after the recording was made.
    expect(answered).toEqual(['b']);
    expect(run.results).toHaveLength(2);
  });

  it('passes the recorded risk substitution through to the check', async () => {
    const { run } = await runEvaluation({
      store,
      cases: [
        makeCase({
          id: 'a',
          checks: [{ id: 'not-replaced', kind: 'not_risk_replaced', severity: 'expectation' }],
        }),
      ],
      replay: [
        { caseId: 'a', reply: 'fallback', toolsCalled: [], riskLevel: 'crisis', riskReplaced: true, error: null },
      ],
    });

    expect(run.results[0]?.riskLevel).toBe('crisis');
    expect(run.results[0]?.checks[0]?.passed).toBe(false);
    // Expectation, not violation: the person still got a safe reply.
    expect(run.results[0]?.passed).toBe(true);
  });
});

describe('summarise', () => {
  function result(partial: Partial<CaseResult>): CaseResult {
    return {
      caseId: 'x',
      category: 'safety',
      title: 't',
      reply: '',
      toolsCalled: [],
      riskLevel: 'none',
      passed: true,
      score: 1,
      checks: [],
      violations: [],
      error: null,
      ...partial,
    };
  }

  it('groups by category', () => {
    const summary = summarise([
      result({ caseId: 'a', category: 'safety' }),
      result({ caseId: 'b', category: 'safety', passed: false }),
      result({ caseId: 'c', category: 'memory' }),
    ]);

    expect(summary.byCategory.safety).toEqual({ total: 2, passed: 1 });
    expect(summary.byCategory.memory).toEqual({ total: 1, passed: 1 });
  });

  it('counts violations separately from failures', () => {
    // A failing case can violate more than one rule, and "how many rules were
    // broken" is a different question from "how many cases failed".
    const summary = summarise([
      result({ passed: false, violations: ['a', 'b'] }),
      result({ passed: false, violations: ['c'] }),
    ]);

    expect(summary.failed).toBe(2);
    expect(summary.violations).toBe(3);
  });

  it('rounds the mean score', () => {
    const summary = summarise([result({ score: 1 / 3 }), result({ score: 1 / 3 })]);
    expect(summary.meanScore).toBe(0.333);
  });

  it('handles an empty run without dividing by zero', () => {
    expect(summarise([])).toMatchObject({ total: 0, passed: 0, failed: 0, meanScore: 0 });
  });
});
