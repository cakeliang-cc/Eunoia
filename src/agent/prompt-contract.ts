/**
 * What the prompt document has to contain, in a form a test can check.
 *
 * The prompt itself is `prompts/companion.md` — prose, read by the model, edited
 * by hand. This file does not hold any of that prose. It holds the few things the
 * *spec* requires of it, so that deleting or renaming part of the document fails
 * a test in milliseconds instead of being noticed a week later in an evaluation
 * run that nobody can explain.
 *
 * The split this file exists to keep honest:
 *
 *     the document says what the companion does
 *     this file says what the document must still say
 *
 * That is the opposite of how it used to be. The policy was data here, rendered
 * into the prompt by `instructions.ts`, with a test asserting the rendered text
 * matched the data. Nothing was wrong with that except the shape: the thing
 * anyone would want to edit — the companion's voice — was TypeScript, and the
 * only way to change a sentence was to edit a module that also hashed itself.
 * Keeping the rules as data bought a drift test between two copies of the same
 * text; there is now one copy, and these are the anchors into it.
 *
 * The `id` fields are the spec's own vocabulary and stay Latin. They are stable
 * handles for tests and for the spec mapping, and they are deliberately absent
 * from the prompt: `不急于解决（dont_rush_to_solve）` asks the model to hold two
 * names for one rule.
 *
 * See spec §2, §3, §12, and docs/adr/001-single-agent.md.
 */

/** One of the five standing interaction principles (spec §3), in spec order. */
export interface RequiredPrinciple {
  readonly id: string;
  /** The label the prompt must use, matching the spec's own wording. */
  readonly label: string;
}

/**
 * One of the four lenses (spec §2).
 *
 * `attendTo` and `avoid` used to be data too. They are prose now, and only the
 * parts a spec section names explicitly are pinned here.
 */
export interface RequiredHeuristic {
  readonly id: 'fi' | 'ne' | 'si' | 'te';
  /** The `##` heading the document must use for this lens. */
  readonly heading: string;
  /** The question this lens asks of the material. */
  readonly coreQuestion: string;
  /**
   * Words the lens's own section must contain.
   *
   * Not vocabulary policing: each of these is the name of the failure mode the
   * spec warns about for that lens, and a lens whose boundary has been edited
   * away is a lens that will be used unbounded. Ne without "焦虑" is a lens that
   * manufactures anxiety.
   */
  readonly mustMention: readonly string[];
}

export const REQUIRED_PRINCIPLES: readonly RequiredPrinciple[] = [
  { id: 'dont_rush_to_solve', label: '不急于解决' },
  { id: 'one_question', label: '一个好问题胜过五个问题' },
  { id: 'dont_define_user', label: '不替用户定义自己' },
  { id: 'gentle_not_unconditional', label: '温柔但不是无条件认同' },
  { id: 'not_life_judge', label: '不做人生裁判' },
] as const;

export const REQUIRED_HEURISTICS: readonly RequiredHeuristic[] = [
  {
    id: 'fi',
    heading: 'Fi —— 意义',
    coreQuestion: '这件事情对用户意味着什么？',
    mustMention: ['不是追问情绪细节'],
  },
  {
    id: 'ne',
    heading: 'Ne —— 可能性',
    coreQuestion: '还有哪些可能性，是用户目前看不到的？',
    mustMention: ['焦虑'],
  },
  {
    id: 'si',
    heading: 'Si —— 连续性',
    coreQuestion: '过去有没有发生过类似的事？',
    mustMention: ['相关'],
  },
  {
    id: 'te',
    heading: 'Te —— 落地',
    coreQuestion: '如果要做一件很小的真实的事，那可以是什么？',
    // Two anchors, because this lens needs both and they are different things.
    // `效率` is the failure mode the spec names — turning everything into a
    // productivity task. `空转` is the *entry condition*: Te is the exit for
    // reflection that has stopped producing anything, not a default mode. That
    // sentence is now the only place the spec §12 case-05 rule lives, because
    // the list that used to duplicate it in code is gone (see below).
    mustMention: ['效率', '空转'],
  },
] as const;

/**
 * There used to be a `RUMINATION_SIGNALS` list here — nine phrases (`我想了很久`,
 * `原地打转`, …) with a `looksLikeRumination()` to match them against, meant to
 * make spec §12 case 05 fire deterministically. Nothing in `src/` ever called it,
 * and it is gone rather than wired up. The reasoning is worth keeping because
 * the argument for building it is a good one that happens to be wrong here.
 *
 * - **The rule is already in the document.** `companion.md` carries both the
 *   boundary ("Te 是当自我反思开始空转时才使用的出口，不是默认模式") and the §12
 *   example verbatim. A second copy in code is the two-copies problem that ADR
 *   011 removed, and this file's own contract is that it holds anchors into the
 *   document, not policy.
 * - **The model does not need to be told.** At `prompt 156bd5de30c6` the case
 *   scores 1.00 with `toolsCalled: []` — the recorded reply names the mechanism
 *   ("想两个月还想不出来，通常不是想得不够，而是这条路本身就出不来"), proposes one
 *   small experiment, and asks nothing further. Nothing is doing the work except
 *   the prompt.
 * - **A keyword list cannot tell a loop from a decision.** `我想了很久才决定` is
 *   a resolved thing and fires; `一直在原地` is a loop and does not. The list
 *   would have been calibrated on exactly the phrasing the case already handles.
 * - **Safety is enforced mechanically; personality is not** (ADR 008, §10). A
 *   crisis turn is checked rather than trusted because a miss is unrecoverable.
 *   Rumination is a quality of attention — the thing being asked for is that the
 *   companion notices it *from what the person said*, and a directive appended by
 *   a keyword match produces replies shaped by the keyword.
 *
 * What would reverse this: a run where the Te lens fails to fire on rumination
 * the list would have caught. The fix then is a case plus a prompt change, which
 * is how every other persona defect in this project was found and closed — not a
 * detector. Recorded in `CHANGELOG.md` and `docs/REFACTORING_PLAN.md`.
 */
