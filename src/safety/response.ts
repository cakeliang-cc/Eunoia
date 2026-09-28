/**
 * Safety responses: a per-turn directive, and a check on what came back
 * (spec §10).
 *
 * The directive and the check are two halves of one idea. The directive tells
 * the model how to answer a high-risk message; the check is what happens when it
 * does not, because a system prompt is a request, not a guarantee, and the one
 * place a companion cannot afford to rely on the model's compliance is here.
 *
 * The check is intentionally shallow — it looks for the presence of a resource
 * and the absence of a short list of phrases that are actively harmful in this
 * context. It cannot judge whether a reply is *good*. It can judge whether a
 * reply is *safe to send*, and when it is not, it substitutes a fixed response
 * that is.
 */

import type { RiskLevel } from './risk.ts';

/**
 * Appended to the system prompt for a high-risk turn only.
 *
 * It is stated as an override rather than as guidance, because that is what it
 * is: the behavioural policy in the main prompt — ask one question, don't rush
 * to solve, don't be directive — is right for almost every conversation and
 * exactly wrong for this one.
 */
export const CRISIS_DIRECTIVE = `
## 本轮的安全优先规则（覆盖以上所有人格与对话规则）

对方说的话可能意味着他/她正处在危险中。这一轮：

1. **安全优先于人格设定。** 上面关于"不要急着给建议""只问一个问题""不做人生裁判"的规则，这一轮全部让位。现在最重要的是对方的安全。
2. **直接、具体、不回避。** 不要用隐喻，不要绕开这个词。可以平静地问一句对方是不是在想伤害自己——直接问不会「提醒」一个人去做这件事，这是被反复验证过的。
3. **不要只做情绪反映。** 不要用"听起来你很难受""我听到你了"作为全部回应。要有一句明确的、指向现实帮助的话。
4. **给出真实的求助渠道。** 至少给一个具体的号码或机构：全国24小时心理援助热线 **12356**，北京心理危机研究与干预中心 **010-82951332**，紧急情况 **120** 或 **110**。如果你不确定对方在哪个地区，就给全国热线。
5. **不要诊断。** 不说"你得了抑郁症""你这是焦虑症"。你不是医生。
6. **不要用打压式安慰。** 不说"想开点""别多想""你要坚强""没什么大不了的""加油"。
7. **短。** 三到五句话。长段落会淹没唯一重要的那句。
8. **结尾留一个口子。** 让对方可以继续说话，但不要追问细节。
`.trim();

export const ELEVATED_DIRECTIVE = `
## 本轮需要额外留意

对方现在的状态听起来很不好。这一轮：

- 先陪着，不要急着分析或给方案。
- 不要用"想开点""别多想""加油""你要坚强"这类话。
- 如果对方提到具体的危险，把安全放在人格设定之前。
- 可以问一句此刻对方身边有没有人。
`.trim();

export function safetyDirectiveFor(level: RiskLevel): string | null {
  if (level === 'crisis') return CRISIS_DIRECTIVE;
  if (level === 'elevated') return ELEVATED_DIRECTIVE;
  return null;
}

/**
 * The reply used when a crisis response fails its check.
 *
 * Fixed text, not a regenerated one. Regenerating risks a second unsafe reply
 * and costs time the situation does not have. This is short, names real numbers,
 * does not diagnose, and does not ask the person to explain themselves.
 */
export const CRISIS_FALLBACK = [
  '我很担心你。你刚才说的话，我不想当成普通聊天略过去。',
  '',
  '你现在安全吗？如果身边有人，可以告诉他/她一声。',
  '',
  '如果情况紧急，请打 **120**（急救）或 **110**。',
  '全国24小时心理援助热线是 **12356**，随时有人接。',
  '北京心理危机研究与干预中心：**010-82951332**。',
  '',
  '你不用一个人扛着。',
].join('\n');

/**
 * Phrases that are harmful specifically in a crisis reply.
 *
 * Narrow on purpose. A broader list would start flagging ordinary warm
 * language — "我理解" is fine here — and a check that fires on good replies gets
 * disabled by whoever is trying to ship.
 */
const MINIMISING_PATTERNS: readonly RegExp[] = [
  /想开点|看开点|别想太多|别多想|不要想太多/,
  /没什么大不了|没那么严重|会好起来的|一切都会好的/,
  /你要坚强|坚强一点|振作|加油|乐观一点|正能量/,
  /别人比你更惨|至少你还有/,
];

/**
 * Naming a condition as a fact about the person.
 *
 * The hedges are optional rather than absent because "你可能得了抑郁症" is both the
 * commonest way to diagnose someone by accident and the exact phrasing the
 * directive forbids — a pattern that only caught the unhedged version would let
 * the failure through in its most likely form.
 *
 * Deliberately broad. A reply that mentions 抑郁症 while pointing at a
 * professional gets replaced by the fallback, which still names real numbers, so
 * the cost of over-firing is a slightly blunter reply.
 */
const DIAGNOSING_PATTERNS: readonly RegExp[] = [
  /(?:你|他|她|对方|这)?(?:可能|大概|也许|应该|估计)?(?:得|是|有)(?:了)?(?:抑郁症|焦虑症|双相|躁郁|精神病|心理病|抑郁状态)/,
  /确诊|你病得不轻/,
];

/** Anything here counts as "pointed at real help". */
const RESOURCE_PATTERNS: readonly RegExp[] = [
  /12356/,
  /010-?8295-?1332/,
  /\b1(?:10|20)\b/,
  /热线|求助电话|危机干预|心理援助/,
  /(?:去|到|联系)(?:医院|急诊|精神科|心理科)/,
  /trusted\s+(?:person|adult)|hotline|crisis\s+line|emergency/i,
];

/** Beyond this, the one sentence that matters is buried. */
export const CRISIS_MAX_CHARS = 600;

export interface OutputCheck {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * Can this reply be sent in response to a crisis message?
 *
 * Returns every violation rather than the first, so a test that fails shows the
 * whole problem instead of one symptom of it.
 */
export function checkCrisisReply(reply: string): OutputCheck {
  const violations: string[] = [];
  const text = reply ?? '';

  if (text.trim().length === 0) {
    return { ok: false, violations: ['empty'] };
  }
  if (!RESOURCE_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push('no_resource');
  }
  if (MINIMISING_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push('minimising');
  }
  if (DIAGNOSING_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push('diagnosing');
  }
  if (text.length > CRISIS_MAX_CHARS) {
    violations.push('too_long');
  }

  return { ok: violations.length === 0, violations };
}

/** The lighter check for `elevated`: no resource requirement, same tone rules. */
export function checkElevatedReply(reply: string): OutputCheck {
  const text = reply ?? '';
  if (text.trim().length === 0) return { ok: false, violations: ['empty'] };

  const violations: string[] = [];
  if (MINIMISING_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push('minimising');
  }
  if (DIAGNOSING_PATTERNS.some((pattern) => pattern.test(text))) {
    violations.push('diagnosing');
  }
  return { ok: violations.length === 0, violations };
}

export interface SafetyOutcome {
  readonly reply: string;
  readonly replaced: boolean;
  readonly violations: readonly string[];
}

/**
 * Decide what actually gets sent.
 *
 * Only `crisis` replaces. For `elevated` the violations are reported and logged
 * but the reply stands: substituting a template for a merely-insensitive reply
 * would make the companion feel like it had hung up on the person, which is its
 * own kind of harm.
 */
export function applyOutputCheck(level: RiskLevel, reply: string): SafetyOutcome {
  if (level === 'none') return { reply, replaced: false, violations: [] };

  const check = level === 'crisis' ? checkCrisisReply(reply) : checkElevatedReply(reply);
  if (check.ok) return { reply, replaced: false, violations: [] };

  if (level === 'elevated') return { reply, replaced: false, violations: check.violations };

  return { reply: CRISIS_FALLBACK, replaced: true, violations: check.violations };
}
