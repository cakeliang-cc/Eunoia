/**
 * `npm run migrate` — make sure the SQLite schema exists.
 *
 * There is no separate migration service anymore. The store applies schema
 * version 1 on first open and records it in `PRAGMA user_version`; this command
 * is a way to initialise a database without starting the HTTP server, and to
 * print where it lives. A future schema change adds a numbered step to
 * `sqlite-store.ts` rather than editing the existing tables in place.
 */

import { log } from '../observability/logging.ts';
import { selectStore, sqlitePath } from './select.ts';

async function main(): Promise<void> {
  const path = sqlitePath();
  const { store, kind, detail } = await selectStore();
  try {
    process.stdout.write(`schema ready · ${kind} · ${detail}\n`);
    if (kind === 'sqlite') process.stdout.write(`database: ${path}\n`);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log.error('migrate.failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
