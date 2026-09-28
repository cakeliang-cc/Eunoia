/**
 * Application-level structured logging (spec §14).
 *
 * The hard rule this module exists to enforce: **raw user content must never be
 * written to ordinary logs.** A companion product accumulates some of the most
 * sensitive text a person will ever type. Logs get shipped, indexed, and read by
 * people who are not the user, so conversation content does not belong in them.
 *
 * When a log needs to refer to content — to correlate two events, or to debug a
 * truncation bug — it records a fingerprint instead: length plus a short hash.
 * That is enough to tell "same message" from "different message" without
 * retaining the message.
 */

import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

/** Fields that must never appear in a log record, whatever the caller passes. */
const FORBIDDEN_KEYS = new Set([
  'text',
  'content',
  'message',
  'messages',
  'prompt',
  'instructions',
  'input',
  'output',
  'apiKey',
  'authorization',
]);

/**
 * A content fingerprint safe to log: identifies a string without retaining it.
 *
 * @param text - the sensitive string being referenced
 * @returns a short, stable identifier such as `len=42 sha256=9f2a1c3b4d5e`
 */
export function contentFingerprint(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return `len=${text.length} sha256=${digest.slice(0, 12)}`;
}

/**
 * Strip forbidden keys from a field bag, replacing each with a fingerprint when
 * the value is a string. Defensive: callers should not pass these at all.
 */
function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[`${key}_redacted`] =
        typeof value === 'string' ? contentFingerprint(value) : '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};
