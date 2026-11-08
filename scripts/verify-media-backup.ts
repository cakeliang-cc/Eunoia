/**
 * `npm run backup:verify -- <backup>` — check a snapshot's files against its
 * manifest.
 *
 * A backup is a claim until something reads it back. This verifier checks the
 * database digest and every recorded original/variant, and exits non-zero when
 * anything is missing. It never writes to the backup.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Manifest {
  readonly database: { file: string; sha256: string };
  readonly assets: readonly {
    readonly id: string;
    readonly original: { key: string; sha256: string };
    readonly normalized: { key: string; sha256: string };
    readonly request: { key: string; sha256: string };
  }[];
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  if (!name) {
    throw new Error('usage: npm run backup:verify -- <backup-directory-name>');
  }
  const directory = name.includes('/') ? name : join('backups', name);
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;

  const problems: string[] = [];
  const databasePath = join(directory, manifest.database.file);
  if (!existsSync(databasePath)) {
    problems.push(`database missing: ${manifest.database.file}`);
  } else if ((await digest(databasePath)) !== manifest.database.sha256) {
    problems.push(`database digest mismatch: ${manifest.database.file}`);
  }

  let checked = 0;
  for (const asset of manifest.assets) {
    for (const [kind, entry] of [
      ['original', asset.original],
      ['normalized', asset.normalized],
      ['request', asset.request],
    ] as const) {
      const path = join(directory, 'media', entry.key);
      if (!existsSync(path)) {
        problems.push(`${asset.id} ${kind}: missing ${entry.key}`);
        continue;
      }
      if ((await digest(path)) !== entry.sha256) {
        problems.push(`${asset.id} ${kind}: digest mismatch`);
        continue;
      }
      checked += 1;
    }
  }

  process.stdout.write(
    `verify: ${directory}\n` +
      `  database: ${problems.some((entry) => entry.startsWith('database')) ? 'FAILED' : 'ok'}\n` +
      `  media: ${checked}/${manifest.assets.length * 3} files verified\n`,
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`verify failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
