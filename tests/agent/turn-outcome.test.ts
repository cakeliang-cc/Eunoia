/**
 * Acceptance, independent of the finish reason (ADR 029).
 *
 * The point of these tests is that the two verdicts can disagree. A turn that
 * ended abnormally can still have output; a turn that ended normally can still
 * fail acceptance because a tool errored or the model said nothing.
 */

import { describe, expect, it } from 'vitest';
import { evaluateTurnOutcome } from '../../src/agent/turn-outcome.ts';

function check(verdict: ReturnType<typeof evaluateTurnOutcome>, id: string) {
  return verdict.acceptance.find((entry) => entry.id === id);
}

describe('evaluating a turn outcome', () => {
  it('accepts a normal answer with output and no failed tools', () => {
    const verdict = evaluateTurnOutcome({ finishReason: 'completed', reply: '好。' });

    expect(verdict).toMatchObject({
      finishReason: 'completed',
      hasOutput: true,
      completedNormally: true,
      succeeded: true,
    });
    expect(verdict.acceptance.every((entry) => entry.ok)).toBe(true);
  });

  it('keeps output but refuses to call a cut stream finished', () => {
    const verdict = evaluateTurnOutcome({
      finishReason: 'incomplete_stream',
      reply: '说到一半',
    });

    expect(verdict.hasOutput).toBe(true);
    expect(verdict.completedNormally).toBe(false);
    expect(verdict.succeeded).toBe(false);
    expect(check(verdict, 'finished')?.ok).toBe(false);
    expect(check(verdict, 'has_output')?.ok).toBe(true);
    expect(check(verdict, 'finished')?.detail).toContain('incomplete_stream');
  });

  it('fails acceptance when a tool call returned an error, whatever the reason', () => {
    const verdict = evaluateTurnOutcome({
      finishReason: 'completed',
      reply: '没改成。',
      failedTools: 1,
    });

    expect(verdict.completedNormally).toBe(true);
    expect(verdict.hasOutput).toBe(true);
    expect(verdict.succeeded).toBe(false);
    expect(check(verdict, 'tools_ok')?.ok).toBe(false);
    expect(check(verdict, 'tools_ok')?.detail).toContain('1 tool call');
  });

  it('fails a completed turn that said nothing', () => {
    const verdict = evaluateTurnOutcome({ finishReason: 'completed', reply: '   ' });
    expect(verdict.succeeded).toBe(false);
    expect(verdict.hasOutput).toBe(false);
    expect(check(verdict, 'has_output')?.ok).toBe(false);
  });

  it('fails when a tool call never got a result', () => {
    const verdict = evaluateTurnOutcome({
      finishReason: 'completed',
      reply: '做完了。',
      unresolvedTools: 2,
    });
    expect(verdict.succeeded).toBe(false);
    expect(check(verdict, 'tools_resolved')?.ok).toBe(false);
  });

  it('treats every non-completed reason as failing the finished check', () => {
    for (const reason of [
      'cancelled',
      'incomplete_stream',
      'loop_exhausted',
      'budget_exhausted',
      'failed',
      'crashed',
    ] as const) {
      const verdict = evaluateTurnOutcome({ finishReason: reason, reply: '有文本' });
      expect(verdict.succeeded, reason).toBe(false);
      expect(check(verdict, 'finished')?.ok, reason).toBe(false);
    }
  });
});
