/**
 * Connection pool construction and target description.
 *
 * There is no default `DATABASE_URL`. A wrong-but-plausible fallback is how a
 * development process ends up quietly writing to the wrong database, so the
 * absence of configuration is an error rather than a guess.
 */

import { Pool } from 'pg';
import type { Store } from '../memory/store.ts';

export const DEFAULT_DATABASE_URL =
  'postgres://designfree:<password>@127.0.0.1:5433/designfree';

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.DATABASE_URL?.trim();
  return explicit && explicit.length > 0 ? explicit : null;
}

export function createPool(url: string = require_url()): Pool {
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

function require_url(): string {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start the database with `docker compose up -d` and set\n' +
        `  DATABASE_URL=${DEFAULT_DATABASE_URL}\n` +
        'or run without a database, in which case the in-memory store is used.',
    );
  }
  return url;
}

/** Host and database only — never the credentials, which may reach a log. */
export function describeTarget(url: string = require_url()): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

export interface StoreSelection {
  readonly store: Store;
  readonly kind: 'postgres' | 'memory';
  readonly detail: string;
}

/**
 * Choose a store.
 *
 * Falling back to the in-memory store when `DATABASE_URL` is unset is a
 * deliberate convenience for development and tests, and it is loud about it: an
 * in-memory store loses everything on restart, and a companion that forgets the
 * person overnight without saying so would be a confusing bug to chase.
 */
export async function selectStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoreSelection> {
  const url = databaseUrl(env);

  if (!url) {
    const { InMemoryStore } = await import('./in-memory-store.ts');
    return {
      store: new InMemoryStore(),
      kind: 'memory',
      detail: 'DATABASE_URL is not set — memories will not survive a restart',
    };
  }

  const { PostgresStore } = await import('./postgres-store.ts');
  const pool = createPool(url);
  await pool.query('SELECT 1');
  const { migrate } = await import('./migrate.ts');
  const result = await migrate(pool);

  return {
    store: new PostgresStore(pool),
    kind: 'postgres',
    detail:
      `postgres ${describeTarget(url)}` +
      (result.applied.length > 0 ? ` (applied ${result.applied.join(', ')})` : ''),
  };
}
