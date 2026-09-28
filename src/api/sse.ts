/**
 * Server-Sent Events encoding — the transport boundary (ADR 006).
 *
 * This is the only module that knows the wire format. The agent core produces
 * `AgentEvent`s and is unaware of it; a future mini-program adapter would encode
 * the same events over `wx.request({ enableChunked })` chunked reads, reusing
 * the event contract unchanged.
 *
 * Deployment note (ADR 006): SSE appears to work locally and silently breaks
 * behind a buffering proxy. The response must be HTTP/1.1 with buffering off
 * (`X-Accel-Buffering: no`), no compression, and a long read timeout — otherwise
 * the whole reply arrives at once and the streaming effect vanishes.
 *
 * Only `event:`/`data:` are emitted. No `id:` field, because there is no
 * resumption: a dropped connection mid-turn cannot be replayed in Phase 1.
 */

import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '../agent/events.ts';

/**
 * Headers that make a Node response stream SSE correctly.
 *
 * `X-Accel-Buffering` and `Cache-Control` are the ones that matter in
 * production; without them nginx and friends will buffer the whole body.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** A comment frame. Sent periodically so idle connections are not reaped. */
export const SSE_HEARTBEAT = ': keep-alive\n\n';

/**
 * Encode one event as an SSE frame.
 *
 * `JSON.stringify` never emits a raw newline inside a JSON string, so the
 * payload is always safe to place on a single `data:` line.
 */
export function sseFrame(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface PipeOptions {
  /** Interval between heartbeat comments, in ms. 0 disables heartbeats. */
  readonly heartbeatMs?: number;
  /** Called when writing finishes, for cleanup. */
  readonly onClose?: () => void;
}

/**
 * Stream events to a Node response as SSE, flushing every frame.
 *
 * Returns when the stream ends or the client disconnects. Never throws for a
 * disconnect — a user closing the tab is normal, not an error.
 */
export async function pipeEventsAsSse(
  events: AsyncIterable<AgentEvent>,
  res: ServerResponse,
  options: PipeOptions = {},
): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let closed = false;

  const onClose = () => {
    closed = true;
    options.onClose?.();
  };
  res.on('close', onClose);

  res.writeHead(200, SSE_HEADERS);

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!closed) res.write(SSE_HEARTBEAT);
        }, heartbeatMs)
      : null;

  try {
    for await (const event of events) {
      if (closed) break;
      // `drain` backpressure: writing faster than the socket drains would
      // otherwise buffer the entire reply in memory.
      if (!res.write(sseFrame(event))) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', onClose);
    if (!closed) res.end();
  }
}
