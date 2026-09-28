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
import { reasoningChunkOf, textDeltaOf } from '../../src/agent/infp-agent.ts';

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

/**
 * Reasoning extraction — the same class of bug as the one above, one layer
 * deeper.
 *
 * The SDK normalises text deltas but *passes reasoning deltas through
 * unnormalised*, wrapped under a generic `model` type. So the fields sit one
 * level further down than they do for text, and a matcher written by analogy
 * with `textDeltaOf` finds nothing. Measured on a real turn: 648 reasoning
 * deltas arrived, the first 12 seconds before the reply's first character, and
 * every one of them was discarded — leaving the person watching a static "…"
 * for the entire wait.
 *
 * The `observed` fixture below is copied from a live capture, not invented.
 */
describe('reasoningChunkOf', () => {
  const observed = {
    type: 'model',
    event: {
      type: 'response.reasoning_text.delta',
      content_index: 0,
      delta: '我们需要',
      item_id: '18a7a17b-4193-45c0-9f5d-642043554e27',
      output_index: 0,
      sequence_number: 4,
    },
    providerData: { type: 'response.reasoning_text.delta' },
  };

  it('reads the wrapped shape the SDK actually sends', () => {
    expect(reasoningChunkOf(observed)).toEqual({ kind: 'delta', text: '我们需要' });
  });

  it('accepts the flat shape too, in case the SDK ever normalises it', () => {
    expect(reasoningChunkOf({ type: 'response.reasoning_text.delta', delta: '嗯' })).toEqual({
      kind: 'delta',
      text: '嗯',
    });
  });

  it('recognises the end of the reasoning', () => {
    expect(reasoningChunkOf({ type: 'model', event: { type: 'response.reasoning_text.done' } })).toEqual(
      { kind: 'done' },
    );
  });

  it('does not mistake reply text for reasoning', () => {
    // The regression that would matter most: if reasoning were matched by a
    // looser pattern, the model's working-out would be rendered as the reply.
    expect(reasoningChunkOf({ type: 'output_text_delta', delta: '你好' })).toBeNull();
    expect(
      reasoningChunkOf({ type: 'model', event: { type: 'response.output_text.delta', delta: '你好' } }),
    ).toBeNull();
  });

  it('ignores the other 99% of `model` traffic', () => {
    // Nearly a thousand events a turn come through as `model`; only one type
    // among them is a reasoning delta.
    for (const type of ['response.created', 'response.created', 'response.in_progress', 'response.completed']) {
      expect(reasoningChunkOf({ type: 'model', event: { type } })).toBeNull();
    }
  });

  it('skips empty deltas, so no zero-length frames are emitted', () => {
    expect(reasoningChunkOf({ type: 'model', event: { type: 'response.reasoning_text.delta', delta: '' } })).toBeNull();
  });

  it('does not throw on malformed input', () => {
    expect(reasoningChunkOf(null)).toBeNull();
    expect(reasoningChunkOf(undefined)).toBeNull();
    expect(reasoningChunkOf('a string')).toBeNull();
    expect(reasoningChunkOf({ type: 'model' })).toBeNull();
    expect(reasoningChunkOf({ type: 'model', event: null })).toBeNull();
    expect(reasoningChunkOf({ type: 'model', event: { type: 'response.reasoning_text.delta', delta: 42 } })).toBeNull();
  });
});
