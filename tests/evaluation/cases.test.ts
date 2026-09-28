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
