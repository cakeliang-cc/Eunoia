/**
 * `npm run backup` — a SQLite snapshot plus the private media it references.
 *
 * The old command proved the database file was readable and stopped there. For a
 * transcript that says "this image" that is not a backup: the rows would restore
 * and every picture would be a missing file. So this script:
 *
 *   1. takes a consistent SQLite snapshot with the online backup API;
 *   2. copies every `media_assets` directory into the backup;
 *   3. verifies the original and both variants against the SHA-256 recorded in
 *      the database, and reports anything missing rather than calling it a
 *      success;
 *   4. writes one manifest naming the snapshot and every file, which the restore
 *      instructions point at.
 *
 * A lease is placed on the assets while they are copied, so a concurrent cleanup
 * cannot remove a file between the SELECT and the copy.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { sqlitePath } from '../src/db/select.ts';
import { mediaRoot } from '../src/media/config.ts';

interface MediaRow {
  id: string;
  conversation_id: string;
  name: string;
  media_type: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  storage_key: string;
  normalized_key: string;
  normalized_sha256: string;
  normalized_bytes: number;
  request_key: string;
  request_sha256: string;
  request_bytes: number;
  status: string;
  created_at: string;
}

interface ManifestAsset {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly status: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
  readonly original: { key: string; sha256: string; bytes: number; verified: boolean };
  readonly normalized: { key: string; sha256: string; bytes: number; verified: boolean };
  readonly request: { key: string; sha256: string; bytes: number; verified: boolean };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const source = sqlitePath();
  if (source === ':memory:') throw new Error('SQLITE_PATH is :memory:; there is no file to back up');
  if (!existsSync(source)) {
    throw new Error(`database not found: ${source}. Start the server once first.`);
  }

  await mkdir('backups', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join('backups', `eunoia-${stamp}`);
  const destination = join(directory, 'eunoia.sqlite');
  await mkdir(directory, { recursive: true });

  const db = new DatabaseSync(source);
  try {
    const pages = await backup(db, destination);
    const copied = await copyMedia(db, join(directory, 'media'), mediaRoot());
    const databaseInfo = await stat(destination);
    const databaseSha = await sha256File(destination);
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      database: {
        file: 'eunoia.sqlite',
        pages,
        bytes: databaseInfo.size,
        sha256: databaseSha,
      },
      assets: copied.assets,
      missing: copied.missing,
      counts: {
        assets: copied.assets.length,
        verified: copied.assets.filter(
          (asset) =>
            asset.original.verified && asset.normalized.verified && asset.request.verified,
        ).length,
        missing: copied.missing.length,
      },
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, 'RESTORE.md'), restoreInstructions(stamp));

    process.stdout.write(
      `backup: ${directory}\n` +
        `  database: ${(databaseInfo.size / 1024).toFixed(1)} KB, ${pages} pages, sha256 ${databaseSha.slice(0, 12)}…\n` +
        `  media: ${copied.assets.length} assets, ${manifest.counts.verified} verified` +
        `${copied.missing.length > 0 ? `, ${copied.missing.length} MISSING` : ''}\n` +
        `  manifest: ${join(directory, 'manifest.json')}\n`,
    );
    if (copied.missing.length > 0) {
      process.stderr.write(
        `WARNING: ${copied.missing.length} media file(s) were missing; this backup is incomplete.\n` +
          copied.missing.map((entry) => `  - ${entry.assetId}: ${entry.key}`).join('\n') +
          '\n',
      );
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

async function copyMedia(
  db: DatabaseSync,
  destinationRoot: string,
  sourceRoot: string,
): Promise<{
  assets: ManifestAsset[];
  missing: { assetId: string; key: string }[];
}> {
  let rows: MediaRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, conversation_id, name, media_type, bytes, width, height, sha256,
                storage_key, normalized_key, normalized_sha256, normalized_bytes,
                request_key, request_sha256, request_bytes, status, created_at
           FROM media_assets ORDER BY created_at ASC`,
      )
      .all() as unknown as MediaRow[];
  } catch {
    // A pre-multimodal database has no media table; that is a complete backup of
    // a text-only history, not an error.
    return { assets: [], missing: [] };
  }

  if (rows.length > 0) {
    const until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const placeholders = rows.map(() => '?').join(', ');
    db.prepare(
      `UPDATE media_assets SET lease_expires_at = ? WHERE id IN (${placeholders})`,
    ).run(until, ...rows.map((row) => row.id));
  }

  const root = resolve(sourceRoot);
  const assets: ManifestAsset[] = [];
  const missing: { assetId: string; key: string }[] = [];

  for (const row of rows) {
    const original = await copyOne(
      root,
      sourceRoot,
      destinationRoot,
      row.storage_key,
      row.sha256,
    );
    const normalized = await copyOne(
      root,
      sourceRoot,
      destinationRoot,
      row.normalized_key,
      row.normalized_sha256,
    );
    const request = await copyOne(
      root,
      sourceRoot,
      destinationRoot,
      row.request_key,
      row.request_sha256,
    );
    for (const [key, result] of [
      [row.storage_key, original],
      [row.normalized_key, normalized],
      [row.request_key, request],
    ] as const) {
      if (!result.verified) missing.push({ assetId: row.id, key });
    }
    assets.push({
      id: row.id,
      conversationId: row.conversation_id,
      name: row.name,
      mediaType: row.media_type,
      status: row.status,
      width: Number(row.width),
      height: Number(row.height),
      createdAt: row.created_at,
      original: {
        key: row.storage_key,
        sha256: row.sha256,
        bytes: Number(row.bytes),
        verified: original.verified,
      },
      normalized: {
        key: row.normalized_key,
        sha256: row.normalized_sha256,
        bytes: Number(row.normalized_bytes),
        verified: normalized.verified,
      },
      request: {
        key: row.request_key,
        sha256: row.request_sha256,
        bytes: Number(row.request_bytes),
        verified: request.verified,
      },
    });
  }

  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ');
    db.prepare(
      `UPDATE media_assets SET lease_expires_at = NULL WHERE id IN (${placeholders})`,
    ).run(...rows.map((row) => row.id));
  }

  return { assets, missing };
}

async function copyOne(
  root: string,
  sourceRoot: string,
  destinationRoot: string,
  key: string,
  expectedSha: string,
): Promise<{ verified: boolean }> {
  const absolute = resolve(sourceRoot, key);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    // A corrupted storage key is reported, never followed outside the media
    // root.
    return { verified: false };
  }
  const target = join(destinationRoot, key);
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(absolute, target);
    const digest = await sha256File(target);
    return { verified: digest === expectedSha };
  } catch {
    return { verified: false };
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function restoreInstructions(stamp: string): string {
  return `# Restoring the ${stamp} backup

The database and the media are one dataset. Restoring only the SQLite file
leaves every image reference pointing at a file that is not there.

1. Stop the server.
2. Copy \`eunoia.sqlite\` over the configured \`SQLITE_PATH\` (default
   \`data/eunoia.sqlite\`).
3. Copy the \`media/\` directory over \`MEDIA_ROOT\` (default: the \`media/\`
   directory next to the SQLite file).
4. Run \`npm run backup:verify -- ${stamp}\` to check every recorded SHA-256
   against the manifest. The verifier reports assets that cannot be restored; it
   does not treat a database row without bytes as an empty image.
5. Start the server and open a conversation with an image; the preview must
   render from the restored media, not from an error placeholder.

The schema-version check refuses to open a database newer than the running
build. A rollback therefore needs a compatible build and its own backup, not an
older binary pointed at this file.
`;
}

main().catch((error: unknown) => {
  process.stderr.write(`backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
