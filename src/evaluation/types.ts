/**
 * The evaluation vocabulary (spec §13).
 *
 * The framework makes one distinction that everything else follows from:
 *
 *   - A **forbidden behaviour** is a statement about what the product must never
 *     do — "do not give productivity advice here", "do not affirm a fabricated
 *     memory", "do not omit a crisis hotline". These are *violations*, and a
 *     violation fails the case.
 *   - An **expected behaviour** is a statement about what a good reply tends to
 *     do. These become individual expectations, and failing one lowers the score
 *     without failing the case.
 *
 * The reason is not leniency. Measuring "did it propose something small" by
 * regex is a guess about phrasing, and a suite that fails on phrasing gets
 * tuned until it passes and then measures nothing. Measuring "did it say 加油 to
 * someone in crisis" is not a guess — it is the thing itself. So the hard
 * assertions are the ones that can be stated exactly, and everything softer is
 * reported with a number instead of a verdict.
 */

/** How a reply is checked. Every kind is decidable without a model. */
export type CheckKind =
  | 'forbidden_regex'
  | 'forbidden_text'
  | 'required_regex_any'
  | 'required_text_any'
  | 'max_questions'
  | 'max_sentences'
  | 'max_chars'
  | 'min_chars'
  | 'no_list_format'
  | 'required_tool'
  | 'forbidden_tool'
  /**
   * The reply reached the person unchanged, rather than being swapped for the
   * crisis fallback.
   *
   * Always an `expectation`, never a `violation`: when the fallback fires, the
   * person still received a safe reply, which is the outcome that matters most.
   * But it *is* a signal that the model failed and the net caught it, and
   * without this check a regression in crisis handling would look like a green
   * suite — the substitution would quietly hide it.
   */
  | 'not_risk_replaced';

/**
 * `violation` fails the case; `expectation` only reduces the score.
 *
 * Defaults to `expectation` when omitted, so a check added casually cannot
 * accidentally start failing a suite.
 */
export type CheckSeverity = 'violation' | 'expectation';

export interface Check {
  readonly id: string;
  readonly kind: CheckKind;
  readonly severity?: CheckSeverity;
  /** Pattern, literal, count, or tool name, depending on `kind`. */
  readonly value?: string | number | readonly string[];
  readonly note?: string;
}

export interface EvaluationCase {
  readonly id: string;
  readonly category: EvaluationCategory;
  readonly title: string;
  readonly userMessage: string;
  /** Prose, for a human or a judge model. Not mechanically checked. */
  readonly expectedBehaviors: readonly string[];
  readonly forbiddenBehaviors: readonly string[];
  readonly checks: readonly Check[];

  // ---- optional fixtures -------------------------------------------------

  /**
   * Memories written before the turn. Cases get their own user id, so seeding
   * here cannot leak into another case's context.
   */
  readonly seedMemories?: readonly {
    readonly type: 'episodic' | 'semantic' | 'narrative';
    readonly content: string;
    readonly importance?: number;
    readonly confidence?: number;
    readonly source?: 'user_explicit' | 'user_stated' | 'inferred';
  }[];

  /** Prior turns, for cases that are about a conversation rather than a line. */
  readonly seedTurns?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];

  readonly notes?: string;
}

export const EVALUATION_CATEGORIES = [
  'no_premature_solving',
  'emotional_attunement',
  'no_judgment',
  'question_discipline',
  'memory',
  'no_fabricated_memory',
  'boundary',
  'safety',
  'gentle_challenge',
  'persona_consistency',
] as const;

export type EvaluationCategory = (typeof EVALUATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<EvaluationCategory, string>> = {
  no_premature_solving: '不急着解决',
  emotional_attunement: '情绪在场',
  no_judgment: '不评判',
  question_discipline: '提问节制',
  memory: '记忆使用',
  no_fabricated_memory: '不编造记忆',
  boundary: '边界',
  safety: '安全',
  gentle_challenge: '温和的挑战',
  persona_consistency: '人格稳定',
};

export interface CheckResult {
  readonly id: string;
  readonly kind: CheckKind;
  readonly severity: CheckSeverity;
  readonly passed: boolean;
  readonly detail: string | null;
}

export interface CaseResult {
  readonly caseId: string;
  readonly category: EvaluationCategory;
  readonly title: string;
  readonly reply: string;
  readonly toolsCalled: readonly string[];
  readonly riskLevel: 'none' | 'elevated' | 'crisis';
  readonly passed: boolean;
  readonly score: number;
  readonly checks: readonly CheckResult[];
  /** IDs of failed `violation` checks. Empty means the case passed. */
  readonly violations: readonly string[];
  readonly error: string | null;
}

export interface EvaluationRun {
  readonly runId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly mode: 'live' | 'recorded';
  readonly startedAt: Date;
  readonly results: readonly CaseResult[];
  readonly summary: EvaluationSummary;
}

export interface EvaluationSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly meanScore: number;
  readonly violations: number;
  readonly byCategory: Readonly<Record<string, { total: number; passed: number }>>;
}
