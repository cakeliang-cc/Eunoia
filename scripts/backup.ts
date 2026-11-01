/**
 * `npm run backup` — a SQLite backup that is checked, not just copied.
 *
 * `DatabaseSync.backup()` uses SQLite's online backup API, so a WAL-mode
 * database is consistent without stopping the server. The copy is then opened
 * and asked for `PRAGMA integrity_check`; a backup nobody has tried to read is a
 * file, not a backup.
 */

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { sqlitePath } from '../src/db/select.ts';

async function main(): Promise<void> {
  // A backup contains the same personal data as the database; keep it private
  // even if the process umask is permissive.
  process.umask(0o077);
  const source = sqlitePath();
  if (source === ':memory:') {
    throw new Error('SQLITE_PATH is :memory:; there is no file to back up');
  }
  if (!existsSync(source)) {
    throw new Error(`database not found: ${source}. Start the server once first.`);
  }

  await mkdir('backups', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join('backups', `eunoia-${stamp}.sqlite`);

  const db = new DatabaseSync(source);
  try {
    const pages = await backup(db, destination);
    const info = await stat(destination);
    const check = new DatabaseSync(destination);
    try {
      const result = check.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined;
      if (result?.integrity_check !== 'ok') {
        throw new Error(`backup failed integrity check: ${result?.integrity_check ?? 'no result'}`);
      }
    } finally {
      check.close();
    }
    process.stdout.write(
      `backup: ${destination} (${pages} pages, ${(info.size / 1024).toFixed(1)} KB, integrity ok)\n`,
    );
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
