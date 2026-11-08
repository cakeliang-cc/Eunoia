/**
 * Where private media lives when no path is configured.
 *
 * Next to the SQLite file by default, because the two are one logical dataset:
 * a backup that copies the database and forgets the bytes is the failure this
 * task has to prove it does not have. `MEDIA_ROOT` overrides it for a deployment
 * that keeps media on a separate volume.
 */

import { dirname, join } from 'node:path';

export function mediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MEDIA_ROOT?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const sqlite = env.SQLITE_PATH?.trim();
  if (sqlite && sqlite.length > 0 && sqlite !== ':memory:') {
    return join(dirname(sqlite), 'media');
  }
  return join(process.cwd(), 'data', 'media');
}
