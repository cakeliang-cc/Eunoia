/**
 * A bounded cache of prepared statements.
 *
 * `node:sqlite` compiles every `prepare(sql)` call; unlike a connection pool it
 * does not remember the statement for the next caller. The stores issue the
 * same dozen statements on every turn, so recompiling them per call is pure
 * overhead — measured at roughly 4× the cost of a cached `get()` on a trivial
 * query in this project.
 *
 * The cache is deliberately simple: a `Map` with a cap, and a full clear when
 * the cap is reached. Most SQL here is static; the only variant is the number
 * of `?` placeholders in `IN (...)`, so the number of distinct strings is small
 * and bounded. Clearing is safe: a `StatementSync` may be finalized while the
 * database is open, and it is never used after the call that fetched it.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Enough for every static statement plus a few placeholder-count variants. */
const MAX_CACHED_STATEMENTS = 200;

export class StatementCache {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(sql: string): StatementSync {
    const cached = this.#cache.get(sql);
    if (cached) return cached;

    const statement = this.#db.prepare(sql);
    if (this.#cache.size >= MAX_CACHED_STATEMENTS) this.#cache.clear();
    this.#cache.set(sql, statement);
    return statement;
  }

  /** For tests and for a schema change that invalidates compiled SQL. */
  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}
