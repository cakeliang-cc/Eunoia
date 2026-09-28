/**
 * SSE encoding (ADR 006).
 *
 * Frame format is the contract a future mini-program client must parse by hand
 * (`wx.request` + `enableChunked` + a custom parser), so it is pinned by test
 * rather than left to whatever `JSON.stringify` happens to produce.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.ts';
import { SSE_HEADERS, sseFrame } from '../../src/api/sse.ts';

describe('sseFrame', () => {
  it('emits a named event with a single-line JSON payload', () => {
    const frame = sseFrame({ type: 'text_delta', text: '你好' });
    expect(frame).toBe('event: text_delta\ndata: {"type":"text_delta","text":"你好"}\n\n');
  });

  it('terminates every frame with a blank line', () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'completed', text: 'a' },
      { type: 'error', message: 'boom', retryable: true },
    ];
    for (const event of events) {
      expect(sseFrame(event).endsWith('\n\n')).toBe(true);
    }
  });

  it('keeps multi-line content on one data line, so no frame is split', () => {
    // A newline inside the payload would otherwise terminate the frame early
    // and corrupt the stream — the classic hand-rolled-SSE bug.
    const frame = sseFrame({ type: 'completed', text: 'first\nsecond\n\nthird' });
    const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
    expect(dataLines).toHaveLength(1);
    expect(sseFrame({ type: 'completed', text: 'a\nb' })).not.toContain('\ndata: \ndata: ');
  });

  it('round-trips through JSON', () => {
    const original: AgentEvent = { type: 'tool_call', callId: 'c1', name: 'save_memory', displayable: false };
    const payload = sseFrame(original).split('data: ')[1]?.trim();
    expect(JSON.parse(payload ?? '')).toEqual(original);
  });
});

describe('SSE_HEADERS', () => {
  it('disables proxy buffering, which is what silently breaks streaming', () => {
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
    expect(SSE_HEADERS['Cache-Control']).toContain('no-transform');
  });

  it('declares the event-stream content type with an explicit charset', () => {
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream; charset=utf-8');
  });
});
