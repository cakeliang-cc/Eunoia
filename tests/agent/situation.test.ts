/**
 * The clock the model is handed, as a fact rather than a guess.
 *
 * Two ways this can be wrong, and both are worse than omitting it: a date in
 * the wrong zone names a different day around midnight, and a thrown error on
 * a bad zone would fail a turn over a line of context. The assertions pin the
 * rendered fact and the fallback.
 */

import { describe, expect, it } from 'vitest';
import { renderSituation, resolveTimeZone } from '../../src/agent/situation.ts';

const SUNDAY_EVENING = new Date('2026-10-25T12:33:00Z');

describe('renderSituation', () => {
  it('names the day, the weekday, the clock and the zone', () => {
    const text = renderSituation({ now: SUNDAY_EVENING, timeZone: 'Asia/Shanghai' });
    expect(text).toContain('2026年10月25日 星期日 20:33（中国标准时间）');
    expect(text).toContain('这是你的坐标，不是话题');
  });

  it('follows the zone, so the same instant is a different clock', () => {
    const text = renderSituation({ now: SUNDAY_EVENING, timeZone: 'UTC' });
    expect(text).toContain('2026年10月25日 星期日 12:33（协调世界时）');
  });

  it('falls back to the process zone when the given one is not a zone', () => {
    expect(renderSituation({ now: SUNDAY_EVENING, timeZone: 'Not/AZone' })).toBe(
      renderSituation({ now: SUNDAY_EVENING }),
    );
    expect(resolveTimeZone('Not/AZone')).toBe(resolveTimeZone());
  });

  it('ignores a clock that is not a time', () => {
    const text = renderSituation({ now: new Date(Number.NaN), timeZone: 'UTC' });
    expect(text).toContain('协调世界时');
    expect(text).not.toContain('NaN');
  });
});
