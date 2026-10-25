/**
 * The agent's situation for this turn: when it is.
 *
 * A place — a working directory, an open file — belongs in this block the day
 * the agent can act in one. Until then the only fact that is both true and
 * useful is the clock. Inventing a directory would tell the model it can edit
 * files it cannot see, which is a worse prompt than an honest gap.
 *
 * The string changes with the minute, so it is assembled per turn and is not
 * part of `STABLE_INSTRUCTIONS`. `PROMPT_VERSION` must not move because the
 * clock did. `buildRuntimeContext` places the block after the summary and
 * before the retrieved memories, and the whole block is sent after the user
 * message so the cached history stays a prefix.
 */

export interface SituationOptions {
  readonly now?: Date;
  /**
   * IANA zone, such as `Asia/Shanghai`.
   *
   * Defaults to the process zone. On the single-user machine this product
   * runs on today, that is the person's zone. A later client — the mini
   * program in particular — should pass the zone it actually knows, because
   * a server in another zone will name the wrong day around midnight.
   */
  readonly timeZone?: string;
}

/** The zone to render in, or the process zone when the given one is unusable. */
export function resolveTimeZone(timeZone?: string): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const candidate = timeZone?.trim() || fallback;
  try {
    // RangeError on a zone Intl does not know. A bad zone must not fail a turn.
    Intl.DateTimeFormat('zh-CN', { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
}

function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

/**
 * The block appended to the system prompt.
 *
 * Always non-empty: there is always a now, unlike a relationship that has not
 * started. The closing line is the same rule the standing prompt states under
 * `# 现在`, repeated next to the fact so the model does not have to look up
 * what it is allowed to do with a date it was just handed.
 */
export function renderSituation(options: SituationOptions = {}): string {
  const now =
    options.now !== undefined && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const timeZone = resolveTimeZone(options.timeZone);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'long',
  }).formatToParts(now);

  const when = `${part(parts, 'year')}年${part(parts, 'month')}月${part(parts, 'day')}日 ${part(parts, 'weekday')} ${part(parts, 'hour')}:${part(parts, 'minute')}`;
  const zoneName = part(parts, 'timeZoneName');
  const zone = zoneName.length > 0 ? `（${zoneName}）` : '';

  return [
    '现在是：',
    '',
    `- ${when}${zone}。`,
    '',
    '所以：用户说「今天」「今晚」「这周末」「下周一」时，按这个时间理解。这是你的坐标，不是话题——不要主动报日期，除非对方问的就是时间，或者这个日期本身就是回答的一部分。',
  ].join('\n');
}
