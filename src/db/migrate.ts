/**
 * Migration runner.
 *
 * Deliberately not a migration framework. The requirements are: apply numbered
 * SQL files in order, exactly once, each in a transaction, and record what ran.
 * That is this file. A framework would add a dependency, a config format, and a
 * DSL, in exchange for features (down-migrations, squashing, branching) that a
 * project of this size does not use and that are easy to get wrong.
 *
 * Applied migrations are immutable (ADR 002). This runner enforces the half of
 * that it can: it checksums each file when it applies it and refuses to start if
 * an already-applied file has changed since. Without that check, "immutable" is
 * a convention, and a convention is what someone edits at 2am.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    }),
  );
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  await pool.query(LEDGER);

  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((row) => [row.name, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of await loadMigrations(dir)) {
    const previous = alreadyApplied.get(migration.name);

    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied ` +
            `(recorded ${previous}, found ${migration.checksum}). Applied migrations are ` +
            'immutable — put the change in a new migration instead.',
        );
      }
      skipped.push(migration.name);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

/** `npm run migrate` */
async function main(): Promise<void> {
  const { createPool, describeTarget } = await import('./pool.ts');
  const pool = createPool();
  try {
    const result = await migrate(pool);
    process.stdout.write(`migrate: ${describeTarget()}\n`);
    for (const name of result.applied) process.stdout.write(`  applied ${name}\n`);
    for (const name of result.skipped) process.stdout.write(`  already applied ${name}\n`);
    if (result.applied.length === 0) process.stdout.write('  nothing to do\n');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
