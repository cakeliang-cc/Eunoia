/**
 * Risk detection (spec §10).
 *
 * The companion is not a therapist and must not behave like one. The whole point
 * of this file is that when someone writes something that suggests they may be
 * in danger, the reply stops being a reflective conversation and becomes a
 * short, concrete, human response that points at real help.
 *
 * Two things this deliberately does **not** do:
 *
 *   - It does not try to assess severity. Deciding whether someone is "really"
 *     at risk is a clinical judgement, and a regex is not qualified to make it.
 *     `crisis` means "a phrase that must never be met with 'and how did that
 *     make you feel'" — it is a floor on the response, not a diagnosis.
 *   - It does not store what it matched. The assessment carries category names,
 *     never the text, because this value reaches logs (spec §14) and a person's
 *     worst moment is not log material.
 *
 * False positives are cheap here and false negatives are not. Being briefly
 * over-careful with someone who used an idiom costs a slightly odd reply; the
 * reverse costs something that does not bear describing. So the idiom guards
 * below exist to keep obvious figures of speech out, and everything else leans
 * toward caution.
 */

export const RISK_LEVELS = ['none', 'elevated', 'crisis'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type RiskCategory =
  | 'self_harm'
  | 'suicidal_ideation'
  | 'harm_to_others'
  | 'abuse'
  | 'acute_distress';

export interface RiskAssessment {
  readonly level: RiskLevel;
  /** Category names only. Never the matched text. */
  readonly categories: readonly RiskCategory[];
}

const NO_RISK: RiskAssessment = { level: 'none', categories: [] };

/**
 * Idioms that contain risk vocabulary but carry none of its meaning.
 *
 * Chinese uses 死 as an intensifier constantly — 笑死, 累死, 烦死 — and 想死你
 * ("miss you to death") is affectionate. Without these, "今天累死了" would
 * trigger a crisis response, which would be both wrong and alarming.
 */
const IDIOM_PATTERNS: readonly RegExp[] = [
  /想死你了?/g,
  /(?:笑|累|气|困|饿|烦|热|冷|美|吓|疼|痛|忙|急|乐|爽)死/g,
  /死[了一样]?[人党]/g,
  /该死的/g,
];

/** Applied before scanning. Removing the idiom is the point. */
export function stripIdioms(text: string): string {
  let result = text;
  for (const pattern of IDIOM_PATTERNS) result = result.replace(pattern, '');
  return result;
}

interface RiskRule {
  readonly category: RiskCategory;
  readonly level: RiskLevel;
  readonly patterns: readonly RegExp[];
}

const RULES: readonly RiskRule[] = [
  {
    category: 'suicidal_ideation',
    level: 'crisis',
    patterns: [
      // 活着没什么意思 puts 什么 between 没 and 意思, and it is the commonest
      // phrasing of the lot — the softener has to be optional, not absent.
      /自杀|轻生|了结(?:自己|生命)|结束(?:自己的)?生命|不想活|不活了|活不下去|活着没(?:有)?(?:什么|啥)?(?:意义|意思)/,
      /想死|去死|求死|一了百了|消失掉|从(?:这个)?世界(?:上)?消失/,
      /suicid|kill(?:ing)?\s+myself|end\s+my\s+life|want(?:ing)?\s+to\s+die|better\s+off\s+dead|no\s+reason\s+to\s+live/i,
    ],
  },
  {
    category: 'self_harm',
    level: 'crisis',
    patterns: [
      // 割了自己一下 is how someone actually says it; requiring the object to be
      // a body part ("割手", "割腕") misses the sentence that matters most.
      /自残|自伤|割腕|割(?:了)?(?:自己|手|腕|手臂|腿)|烫(?:了)?自己|跳楼|跳(?:河|桥|轨)|上吊|吞药|吃安眠药|烧伤自己/,
      /self[\s-]?harm|cut(?:ting)?\s+myself|hurt\s+myself|overdose/i,
    ],
  },
  {
    category: 'harm_to_others',
    level: 'crisis',
    patterns: [
      /想杀|要杀|杀(?:了)?(?:他|她|它|你)们?|报复(?:他|她|他们)|让他(?:们)?(?:付出代价|不得好死)|伤害(?:他|她)们?/,
      /kill\s+(?:him|her|them|you)|hurt\s+(?:him|her|them)/i,
    ],
  },
  {
    category: 'abuse',
    level: 'elevated',
    patterns: [
      // 他在家里打我 is the sentence, and 被打 is not in it. Reporting abuse is
      // rarely phrased in the passive.
      /家暴|被打|打(?:了)?我|动手打|被虐待|性侵|猥亵|被强迫|威胁我|跟踪我/,
      /abus(?:e|ed)|assault|domestic\s+violence|threaten(?:ed|ing)\s+me|hit(?:s)?\s+me/i,
    ],
  },
  {
    category: 'acute_distress',
    level: 'elevated',
    patterns: [
      /撑不下去|扛不住|崩溃(?:了)?|绝望|活得好累|没有人在乎|没人在乎|想逃离一切|喘不过气/,
      /can'?t\s+go\s+on|falling\s+apart|hopeless|breaking\s+down|no\s+one\s+cares/i,
    ],
  },
];

/**
 * Scan text for risk signals.
 *
 * Returns the **highest** level found, with every category that contributed, so
 * a message containing both distress and ideation reports `crisis` and both
 * categories rather than whichever rule happened to run first.
 */
export function assessRisk(text: string): RiskAssessment {
  if (typeof text !== 'string' || text.trim().length === 0) return NO_RISK;

  const scanned = stripIdioms(text);
  const categories: RiskCategory[] = [];
  let level: RiskLevel = 'none';

  for (const rule of RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(scanned))) continue;
    categories.push(rule.category);
    if (rule.level === 'crisis') level = 'crisis';
    else if (level === 'none') level = 'elevated';
  }

  return categories.length === 0 ? NO_RISK : { level, categories };
}

/** Ordering helper, for combining an input assessment with an output check. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { none: 0, elevated: 1, crisis: 2 };
  return order[a] >= order[b] ? a : b;
}
