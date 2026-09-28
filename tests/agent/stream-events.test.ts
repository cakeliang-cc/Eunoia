/**
 * Text-delta extraction.
 *
 * This pins a bug that actually shipped into a first draft and was invisible in
 * every test that did not call the live endpoint: the SDK renames the provider's
 * `response.output_text.delta` to `output_text_delta`. Matching only the wire
 * name yielded zero deltas while the turn still *completed* successfully — so
 * the reply appeared correct in the final output and only the streaming was
 * broken. The smoke test caught it; this test keeps it caught.
 */

import { describe, expect, it } from 'vitest';
import { textDeltaOf } from '../../src/agent/infp-agent.ts';

describe('textDeltaOf', () => {
  it('accepts the SDK-normalised event name', () => {
    expect(textDeltaOf({ type: 'output_text_delta', delta: '你好' })).toBe('你好');
  });

  it('accepts the provider wire event name', () => {
    expect(textDeltaOf({ type: 'response.output_text.delta', delta: 'hi' })).toBe('hi');
  });

  it('handles the real observed shape, including nested providerData', () => {
    const observed = {
      type: 'output_text_delta',
      delta: '，',
      itemId: 'f5f116aa',
      providerData: { type: 'response.output_text.delta', sequence_number: 73 },
    };
    expect(textDeltaOf(observed)).toBe('，');
  });

  it('ignores other event types', () => {
    expect(textDeltaOf({ type: 'response_done' })).toBeNull();
    expect(textDeltaOf({ type: 'model', delta: 'x' })).toBeNull();
    expect(textDeltaOf({ type: 'response.reasoning_text.delta', delta: 'x' })).toBeNull();
  });

  it('ignores empty deltas, so no zero-length frames are emitted', () => {
    expect(textDeltaOf({ type: 'output_text_delta', delta: '' })).toBeNull();
  });

  it('does not throw on malformed input', () => {
    expect(textDeltaOf(null)).toBeNull();
    expect(textDeltaOf(undefined)).toBeNull();
    expect(textDeltaOf('a string')).toBeNull();
    expect(textDeltaOf({ type: 'output_text_delta' })).toBeNull();
    expect(textDeltaOf({ type: 'output_text_delta', delta: 42 })).toBeNull();
  });
});
