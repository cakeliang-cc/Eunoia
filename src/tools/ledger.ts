/**
 * The context ledger: file content enters the window once.
 *
 * A read is the one tool result that is safe to answer with a pointer, because
 * the content is already above the model in the same conversation. Re-sending it
 * costs tokens and, more importantly, makes the prompt longer without making it
 * better informed.
 *
 * The ledger is per turn. Persisting it across turns would be wrong for the same
 * reason the conversation replays from the database: the model's window is
 * rebuilt from scratch each turn, so "it is already above you" would be false.
 */

import type { ReadLedger, ReadRecord } from './types.ts';

export class TurnReadLedger implements ReadLedger {
  private readonly entries = new Map<string, ReadRecord[]>();

  check(input: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
    readonly mtimeMs: number;
    readonly size: number;
  }): ReadRecord | null {
    const records = this.entries.get(input.path);
    if (!records) return null;

    for (const record of records) {
      if (record.mtimeMs !== input.mtimeMs || record.size !== input.size) continue;
      // The delivered range must cover what is being asked for. A read of a
      // larger range is a real request for more content, not a repeat.
      if (input.start >= record.start && input.end <= record.end) return record;
    }
    return null;
  }

  record(record: ReadRecord): void {
    const records = this.entries.get(record.path) ?? [];
    // Drop records for an older version of the file: a stale pointer into
    // content that has since changed is worse than no pointer.
    const current = records.filter(
      (entry) => entry.mtimeMs === record.mtimeMs && entry.size === record.size,
    );
    current.push(record);
    this.entries.set(record.path, current);
  }

  has(path: string): boolean {
    return (this.entries.get(path)?.length ?? 0) > 0;
  }

  digestFor(path: string, version?: { mtimeMs: number; size: number }): string | null {
    const records = this.entries.get(path) ?? [];
    for (const record of records) {
      if (!record.complete || !record.sha256) continue;
      if (
        version === undefined ||
        (record.mtimeMs === version.mtimeMs && record.size === version.size)
      ) {
        return record.sha256;
      }
    }
    return null;
  }

  hasComplete(path: string, version?: { mtimeMs: number; size: number }): boolean {
    return (this.entries.get(path) ?? []).some(
      (entry) =>
        entry.complete &&
        (version === undefined ||
          (entry.mtimeMs === version.mtimeMs && entry.size === version.size)),
    );
  }

  /** Tests and the `/api` trace can ask what the turn has already paid for. */
  size(): number {
    let total = 0;
    for (const records of this.entries.values()) total += records.length;
    return total;
  }
}
