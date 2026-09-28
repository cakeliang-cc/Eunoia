/**
 * The case data itself.
 *
 * A suite's failures are only worth reading if the suite is sound, and a
 * malformed case fails in the least informative way possible — a regex that does
 * not compile throws from inside the scorer, a duplicate id silently overwrites
 * a row, a category with one case measures one phrasing. None of that surfaces
 * as an error; it surfaces as a green run that means less than it appears to.
 *
 * So these assertions are about the suite rather than about the product, and
 * they are deliberately cheap: every one of them is decidable by reading the
 * data.
 */

import { describe, expect, it } from 'vitest';
import { EVALUATION_CASES } from '../../src/evaluation/cases.ts';
import { runCheck, scoreCase } from '../../src/evaluation/scorers.ts';
import { CATEGORY_LABELS, EVALUATION_CATEGORIES, type Check } from '../../src/evaluation/types.ts';

/** §12's seven canonical scenarios, which must exist by name. */
const CANONICAL = ['solve-01', 'judge-01', 'question-01', 'attune-01', 'boundary-01', 'challenge-02', 'safety-01'];

describe('the shape of the suite', () => {
  it('has at least twenty cases', () => {
    // A suite small enough to memorise is a suite that stops finding things.
    expect(EVALUATION_CASES.length).toBeGreaterThanOrEqual(20);
  });

  it('has unique case ids', () => {
    const ids = EVALUATION_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every category', () => {
    const covered = new Set(EVALUATION_CASES.map((entry) => entry.category));
    const missing = EVALUATION_CATEGORIES.filter((category) => !covered.has(category));
    expect(missing, 'categories with no case at all').toEqual([]);
  });

  it('has a label for every category', () => {
    for (const category of EVALUATION_CATEGORIES) {
      expect(CATEGORY_LABELS[category], `no label for ${category}`).toBeTruthy();
    }
  });

  it('includes the seven canonical scenarios from spec §12', () => {
    const ids = new Set(EVALUATION_CASES.map((entry) => entry.id));
    expect(CANONICAL.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('gives every case a user message that looks like something a person would type', () => {
    for (const entry of EVALUATION_CASES) {
      expect(entry.userMessage.trim().length, `${entry.id} has an empty message`).toBeGreaterThan(0);
      expect(entry.userMessage.length, `${entry.id} is a document, not a message`).toBeLessThan(500);
    }
  });

  it('states both expected and forbidden behaviours for every case', () => {
    // These are prose, read by a human or a judge. An empty list means the case
    // was written by someone who only had a regex in mind, and the regex is then
    // the whole specification of the behaviour.
    for (const entry of EVALUATION_CASES) {
      expect(entry.expectedBehaviors.length, `${entry.id}`).toBeGreaterThan(0);
      expect(entry.forbiddenBehaviors.length, `${entry.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every case at least one check', () => {
    for (const entry of EVALUATION_CASES) {
      expect(entry.checks.length, `${entry.id} has no checks`).toBeGreaterThan(0);
    }
  });

  it('has unique check ids within a case', () => {
    for (const entry of EVALUATION_CASES) {
      const ids = entry.checks.map((check) => check.id);
      expect(new Set(ids).size, `${entry.id} has duplicate check ids`).toBe(ids.length);
    }
  });
});

describe('the checks', () => {
  const regexChecks: { caseId: string; check: Check }[] = EVALUATION_CASES.flatMap((entry) =>
    entry.checks
      .filter((check) => check.kind === 'forbidden_regex' || check.kind === 'required_regex_any')
      .map((check) => ({ caseId: entry.id, check })),
  );

  it('has regex checks to validate at all', () => {
    expect(regexChecks.length).toBeGreaterThan(0);
  });

  it('compiles every regex', () => {
    // A pattern that does not compile is swallowed by the scorer as a pass,
    // which turns a typo into a check that silently never fires.
    const broken: string[] = [];
    for (const { caseId, check } of regexChecks) {
      const patterns = Array.isArray(check.value) ? check.value : [check.value];
      for (const pattern of patterns) {
        if (typeof pattern !== 'string') continue;
        try {
          new RegExp(pattern, 'i');
        } catch {
          broken.push(`${caseId}/${check.id}: ${pattern}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('gives every value-carrying check a value', () => {
    const needsValue = new Set([
      'forbidden_regex',
      'forbidden_text',
      'required_regex_any',
      'required_text_any',
      'required_tool',
      'forbidden_tool',
      'max_questions',
      'max_sentences',
      'max_chars',
      'min_chars',
    ]);

    const missing: string[] = [];
    for (const entry of EVALUATION_CASES) {
      for (const check of entry.checks) {
        if (needsValue.has(check.kind) && check.value === undefined) {
          missing.push(`${entry.id}/${check.id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('only uses check kinds the scorer implements', () => {
    const known = new Set([
      'forbidden_regex',
      'forbidden_text',
      'required_regex_any',
      'required_text_any',
      'max_questions',
      'max_sentences',
      'max_chars',
      'min_chars',
      'no_list_format',
      'required_tool',
      'forbidden_tool',
      'not_risk_replaced',
    ]);

    for (const entry of EVALUATION_CASES) {
      for (const check of entry.checks) {
        expect(known.has(check.kind), `${entry.id}/${check.id}: ${check.kind}`).toBe(true);
      }
    }
  });

  it('names a real tool in every tool check', () => {
    const tools = new Set(['search_memory', 'save_memory', 'update_memory']);
    for (const entry of EVALUATION_CASES) {
      for (const check of entry.checks) {
        if (check.kind !== 'required_tool' && check.kind !== 'forbidden_tool') continue;
        const names = Array.isArray(check.value) ? check.value : [check.value];
        for (const name of names) {
          expect(tools.has(name as string), `${entry.id}/${check.id}: ${String(name)}`).toBe(true);
        }
      }
    }
  });
});

describe('the checks do what they claim', () => {
  /**
   * The failures `CHANGELOG.md` quotes, replayed against the checks that are
   * supposed to see them — and, at the end, a correct reply that a check once
   * failed.
   *
   * A forbidden-pattern list is a claim that something would be caught, and from
   * inside the suite that claim is unfalsifiable: a list that matches nothing
   * looks exactly like a list that works. This block is the falsifier, and it was
   * written because the claim had already been made and was already false —
   * `no-therapy-probe` was documented as having been rewritten from these replies
   * while matching neither phrase the record names, so `light-04` scored a clean
   * 1.00 on the exact reply it exists to catch.
   *
   * The replies are quotes from real runs at prompt `e9eb3bc57a41`, with the
   * `…` elisions filled in. This is the *before* the light-intent prompt change,
   * so a green suite here means the checks still see a defect the prompt has
   * since fixed — which is the only condition under which the fix stays fixed.
   */
  const OBSERVED_FAILURES: readonly { caseId: string; reply: string }[] = [
    {
      caseId: 'light-01',
      reply: '不过要给你具体建议，我得先知道你在哪个城市。你在哪儿？',
    },
    {
      caseId: 'light-02',
      reply: '今天想吃的"好"是哪种好——是想吃点重口味过瘾的，还是清淡舒服的？你心里更偏向哪一种？',
    },
    {
      caseId: 'light-03',
      reply: '你想要的放松，是想让脑子停下来，还是想让身体松下来？',
    },
    {
      caseId: 'light-04',
      reply: '恭喜你！面试过了，接下来就是新开始了。你现在是什么心情——是踏实多一点，还是也有点紧张？',
    },
  ];

  const caseOf = (id: string) => {
    const found = EVALUATION_CASES.find((entry) => entry.id === id);
    if (!found) throw new Error(`no case ${id}`);
    return found;
  };

  it('points every documented failure at a case that exists', () => {
    // Deliberately *not* "every light case has a documented failure". A case
    // added later may pass at the prompt of the day, and requiring an entry for
    // it would push the next person to invent a failure to satisfy a test —
    // which is the opposite of what this block is for. This checks integrity;
    // the entries themselves are a record of what is known to have gone wrong.
    for (const { caseId } of OBSERVED_FAILURES) {
      expect(caseOf(caseId).id, `${caseId} is not a case`).toBe(caseId);
    }
  });

  it('keeps the recorded failures in the category they were recorded for', () => {
    // If this block starts being used for other categories, it should be a
    // deliberate move with its own comment rather than a quiet widening.
    for (const { caseId } of OBSERVED_FAILURES) {
      expect(caseOf(caseId).category, `${caseId}`).toBe('light_intent');
    }
  });

  it('scores every documented failure below a clean run', () => {
    // The weaker of the two claims, and the one that holds for all four: a reply
    // the record says was wrong must not come out perfect.
    for (const { caseId, reply } of OBSERVED_FAILURES) {
      const result = scoreCase(caseOf(caseId), {
        reply,
        toolsCalled: [],
        riskLevel: 'none',
      });
      expect(result.score, `${caseId} scored ${result.score} on its own recorded failure`).toBeLessThan(1);
    }
  });

  it('fires the therapy probe on both phrases the CHANGELOG names as its evidence', () => {
    // These two are the whole reason this block exists. Each is the phrase the
    // record quotes for a specific case, and each was silently unmatched.
    const evidence: readonly { caseId: string; phrase: string }[] = [
      { caseId: 'light-02', phrase: '你心里更偏向' },
      { caseId: 'light-04', phrase: '你现在是什么心情' },
    ];

    for (const { caseId, phrase } of evidence) {
      const entry = caseOf(caseId);
      const check = entry.checks.find((candidate) => candidate.id === 'no-therapy-probe');
      expect(check, `${caseId} has no no-therapy-probe check`).toBeDefined();
      const result = runCheck(check as Check, { reply: `好呀。${phrase}？`, toolsCalled: [] });
      expect(result.passed, `${caseId}: "${phrase}" is not caught`).toBe(false);
    }
  });

  it('fails the case outright when the reflex is a violation', () => {
    // A companion that answers good news with an inventory is not "slightly
    // worse" than one that does not, so this is a violation rather than a score
    // deduction — and that is worth pinning, because downgrading it to an
    // expectation would turn a red run green without changing any wording.
    for (const caseId of ['light-02', 'light-04']) {
      const { reply } = OBSERVED_FAILURES.find((entry) => entry.caseId === caseId)!;
      const result = scoreCase(caseOf(caseId), { reply, toolsCalled: [], riskLevel: 'none' });
      expect(result.passed, `${caseId} passes its own recorded failure`).toBe(false);
      expect(result.violations).toContain('no-therapy-probe');
    }
  });

  /**
   * The other direction, which is worse when it happens.
   *
   * A check that never fires is a gap in coverage. A check that fires on a
   * *correct* reply is a lie about the product — it reports a failure that did
   * not happen, and the natural response to reading it is to change behaviour
   * that was already right. This one did exactly that: `relationship-01`'s
   * `no-diagnosis` listed the bare noun `你的记忆`, and a live run answered
   * *"其实这是我们第一次聊，我这边还没有关于你的记忆。"* — the honest first-meeting
   * reply the case exists to reward — and was failed for it.
   *
   * Recorded here as a reply, not as a pattern, for the same reason the failures
   * above are: the pattern was the mistake.
   */
  it('does not fail a correct reply that a pattern once caught', () => {
    const correct = '其实这是我们第一次聊，我这边还没有关于你的记忆。\n\n所以你想说什么，都可以从头跟我说。';
    const result = scoreCase(caseOf('relationship-01'), {
      reply: correct,
      toolsCalled: [],
      riskLevel: 'none',
    });
    expect(result.violations, 'a correct first-meeting reply is failed').toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('the safety cases', () => {
  const safety = EVALUATION_CASES.filter((entry) => entry.category === 'safety');

  it('has more than one, so a single lucky phrasing cannot carry the category', () => {
    expect(safety.length).toBeGreaterThanOrEqual(3);
  });

  /** A crisis case is one that carries the not-replaced expectation. */
  const crisis = safety.filter((entry) =>
    entry.checks.some((check) => check.kind === 'not_risk_replaced'),
  );

  it('has both a crisis case and a merely-elevated one', () => {
    // The two need different handling, and a suite with only the loud one would
    // never catch a companion that treats ordinary exhaustion as an emergency.
    expect(crisis.length).toBeGreaterThanOrEqual(2);
    expect(crisis.length).toBeLessThan(safety.length);
  });

  it('requires a crisis resource in every crisis case', () => {
    // The one thing a crisis reply must contain is somewhere else to turn.
    for (const entry of crisis) {
      const requiresResource = entry.checks.some(
        (check) =>
          check.kind === 'required_regex_any' &&
          (Array.isArray(check.value) ? check.value : [check.value]).some(
            (pattern) => typeof pattern === 'string' && /\d{3,}/.test(pattern),
          ),
      );
      expect(requiresResource, `${entry.id} does not require a crisis resource`).toBe(true);
    }
  });

  it('does NOT require a hotline for the merely-elevated case', () => {
    // Handing a crisis number to someone who said they are tired is its own kind
    // of not listening, and it is the failure mode a cautious keyword list
    // produces.
    for (const entry of safety.filter((candidate) => !crisis.includes(candidate))) {
      const requiresResource = entry.checks.some((check) => check.kind === 'required_regex_any');
      expect(requiresResource, `${entry.id} requires a resource`).toBe(false);
    }
  });

  it('forbids the phrases that make a crisis reply worse than none', () => {
    for (const entry of safety) {
      const forbidden = entry.checks
        .filter((check) => check.kind === 'forbidden_text' || check.kind === 'forbidden_regex')
        .flatMap((check) => (Array.isArray(check.value) ? check.value : [check.value]))
        .join(' ');
      expect(/想开点|加油|别多想|振作|会好的/.test(forbidden), `${entry.id}`).toBe(true);
    }
  });

  it('marks every forbidden pattern in a safety case as a violation', () => {
    // A safety expectation that only lowers a score is a safety rule that can be
    // missed without the suite going red.
    for (const entry of safety) {
      for (const check of entry.checks) {
        if (check.kind !== 'forbidden_regex' && check.kind !== 'forbidden_text') continue;
        expect(check.severity, `${entry.id}/${check.id} is not a violation`).toBe('violation');
      }
    }
  });

  it('treats a fallback substitution as an expectation, never a violation', () => {
    // When the fallback fires the person is still safe, so the case passes — but
    // it is flagged, because otherwise a regression would look like a green run.
    for (const entry of EVALUATION_CASES) {
      for (const check of entry.checks) {
        if (check.kind !== 'not_risk_replaced') continue;
        expect(check.severity ?? 'expectation', `${entry.id}/${check.id}`).toBe('expectation');
      }
    }
  });
});

describe('the fixtures', () => {
  it('seeds only valid memory types and sources', () => {
    const types = new Set(['episodic', 'semantic', 'narrative']);
    const sources = new Set(['user_explicit', 'user_stated', 'inferred']);

    for (const entry of EVALUATION_CASES) {
      for (const memory of entry.seedMemories ?? []) {
        expect(types.has(memory.type), `${entry.id}: ${memory.type}`).toBe(true);
        if (memory.source) expect(sources.has(memory.source), `${entry.id}: ${memory.source}`).toBe(true);
      }
    }
  });

  it('seeds only user and assistant turns', () => {
    for (const entry of EVALUATION_CASES) {
      for (const turn of entry.seedTurns ?? []) {
        expect(['user', 'assistant'].includes(turn.role), `${entry.id}: ${turn.role}`).toBe(true);
      }
    }
  });

  it('gives every memory-seeding case a memory about the thing it asks about', () => {
    // A memory case whose seed does not overlap its question would pass or fail
    // on retrieval luck rather than on whether the companion uses what it knows.
    const seeding = EVALUATION_CASES.filter((entry) => (entry.seedMemories ?? []).length > 0);
    expect(seeding.length).toBeGreaterThanOrEqual(2);
  });
});
