/**
 * Store selection (ADR 016).
 *
 * The default is a SQLite file next to the process. `STORE=memory` remains the
 * test and throwaway mode; it is explicit because a server that silently forgets
 * everything on restart is the failure this project already had to explain once.
 *
 * Postgres is gone: `DATABASE_URL` is deliberately ignored rather than treated
 * as a fallback. A leftover environment variable should not bring back a stack
 * that needs Docker, a password and a migration runner.
 */

import { join } from 'node:path';
import type { Store } from '../store.ts';
import type { SandboxStore } from '../sandbox/store.ts';
import { MemorySandboxStore } from '../sandbox/store-memory.ts';
import { SqliteSandboxStore } from '../sandbox/store-sqlite.ts';
import { log } from '../observability/logging.ts';
import { openSqliteStore } from './sqlite-store.ts';

export type StoreKind = 'sqlite' | 'memory';

export interface StoreSelection {
  readonly store: Store;
  /**
   * The sandbox platform's persistence port.
   *
   * It shares the SQLite connection (one file, one writer) but not the `Store`
   * interface: conversation history and execution bookkeeping have different
   * lifetime and different recovery rules, and merging them would make the
   * product store carry columns it never reads.
   */
  readonly sandboxStore: SandboxStore;
  readonly kind: StoreKind;
  readonly detail: string;
}

/** Where the SQLite file lives unless `SQLITE_PATH` says otherwise. */
export function sqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SQLITE_PATH?.trim();
  return explicit && explicit.length > 0 ? explicit : join(process.cwd(), 'data', 'eunoia.sqlite');
}

export async function selectStore(env: NodeJS.ProcessEnv = process.env): Promise<StoreSelection> {
  if (env.DATABASE_URL?.trim()) {
    log.warn('store.database_url_ignored', {
      note: 'Postgres was removed in ADR 016; using the SQLite store',
    });
  }

  const mode = env.STORE?.trim().toLowerCase();
  const explicitPath = env.SQLITE_PATH?.trim();
  if (mode === 'memory' || explicitPath === ':memory:') {
    const { InMemoryStore } = await import('./in-memory-store.ts');
    return {
      store: new InMemoryStore(),
      sandboxStore: new MemorySandboxStore(),
      kind: 'memory',
      detail: 'STORE=memory — everything is lost on restart',
    };
  }

  const path = sqlitePath(env);
  const sqlite = openSqliteStore(path);
  return {
    store: sqlite,
    sandboxStore: new SqliteSandboxStore(sqlite.database),
    kind: 'sqlite',
    detail: `sqlite ${path}`,
  };
}
