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
    mustMention: ['效率'],
  },
] as const;

/**
 * Signals that introspection has stopped producing anything and is now just
 * circling. Belongs to spec §12 case 05, where the Te lens should offer a small
 * experiment instead of another reflective question.
 *
 * Deliberately a small, explicit list rather than a model judgement: this is a
 * policy decision, and it should be reviewable and testable.
 *
 * Known gap: nothing in `src/` consults this yet. It is checked by a test and
 * described by the prompt's own §12 example, but the runtime does not branch on
 * it — see the known issues in CHANGELOG.md.
 */
export const RUMINATION_SIGNALS: readonly string[] = [
  '我想了很久',
  '想了几个月',
  '想了两个月',
  '一直想不明白',
  '还是不知道',
  '反复想',
  '越想越乱',
  '原地打转',
  '分析不出来',
] as const;

/** Whether a message looks like rumination rather than fresh exploration. */
export function looksLikeRumination(message: string): boolean {
  return RUMINATION_SIGNALS.some((signal) => message.includes(signal));
}
