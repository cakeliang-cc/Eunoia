/**
 * Merging member artifacts and publishing a candidate.
 *
 * The merge tests are pure and build their manifests by hand: what matters is the
 * decision (conflict or not), not how a diff produced the entry. The publish
 * tests use a real directory, because atomicity, the executable bit, symlink
 * refusal and "the retry did not write twice" are all filesystem facts.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  integrateManifests,
  publishCandidate,
  type ConflictReport,
  type IntegrateInput,
  type IntegrateResult,
  type PublishResult,
} from '../../src/teams/integration.ts';
import type { ArtifactFile, ArtifactManifest } from '../../src/teams/types.ts';
import { TeamError } from '../../src/teams/types.ts';
import { expectTeamError } from './helpers.ts';

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ fixtures ---

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactFile(
  path: string,
  change: ArtifactFile['change'],
  extra: Partial<Omit<ArtifactFile, 'path' | 'change'>> = {},
): ArtifactFile {
  return {
    path,
    change,
    baseHash: extra.baseHash ?? null,
    contentHash: extra.contentHash ?? null,
    bytes: extra.bytes ?? 0,
    executable: extra.executable ?? false,
    binary: extra.binary ?? false,
    ...(extra.fromPath === undefined ? {} : { fromPath: extra.fromPath }),
    ...(extra.content === undefined ? {} : { content: extra.content }),
  };
}

function modified(path: string, baseHash: string, content: string): ArtifactFile {
  return artifactFile(path, 'modified', {
    baseHash,
    contentHash: hashText(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

function added(
  path: string,
  content: string,
  options: { executable?: boolean; binary?: boolean } = {},
): ArtifactFile {
  return artifactFile(path, 'added', {
    contentHash: hashText(content),
    bytes: Buffer.byteLength(content),
    executable: options.executable ?? false,
    binary: options.binary ?? false,
    ...(options.binary ? {} : { content }),
  });
}

function removed(path: string, baseHash: string, bytes = 0): ArtifactFile {
  return artifactFile(path, 'deleted', { baseHash, bytes });
}

function renamed(path: string, fromPath: string, baseHash: string, content: string): ArtifactFile {
  return artifactFile(path, 'renamed', {
    fromPath,
    baseHash,
    contentHash: hashText(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

function manifestOf(files: ArtifactFile[], sourceVersion = 'sha256:source'): ArtifactManifest {
  return { files, sourceVersion, candidateHash: 'sha256:candidate' };
}

function integrate(input: Partial<IntegrateInput> & { candidate: ArtifactManifest }): IntegrateResult {
  return integrateManifests({
    targetRoot: '/tmp/integration-candidate',
    baseHashes: {},
    sourceHashes: {},
    ...input,
  });
}

function integrationError(input: Partial<IntegrateInput> & { candidate: ArtifactManifest }): TeamError {
  try {
    integrate(input);
  } catch (error) {
    return error as TeamError;
  }
  throw new Error('expected integrateManifests to throw');
}

function conflictPaths(result: IntegrateResult): ConflictReport[] {
  return [...result.conflicts];
}

// --------------------------------------------------------------------- merge ---

describe('integrateManifests', () => {
  it('merges edits to different files without a conflict', () => {
    const baseA = hashText('a1');
    const baseB = hashText('b1');
    const result = integrate({
      baseHashes: { 'src/a.ts': baseA, 'src/b.ts': baseB },
      candidate: manifestOf([modified('src/a.ts', baseA, 'a2')]),
      other: manifestOf([modified('src/b.ts', baseB, 'b2')]),
      sourceHashes: { 'src/a.ts': baseA, 'src/b.ts': baseB },
    });

    expect(result.conflicts).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.files.map((file) => file.content)).toEqual(['a2', 'b2']);
    expect(result.candidateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reports both-modified for the same file and keeps both contents', () => {
    const base = hashText('v1');
    const result = integrate({
      baseHashes: { 'src/parser.ts': base },
      candidate: manifestOf([modified('src/parser.ts', base, 'candidate version')]),
      other: manifestOf([modified('src/parser.ts', base, 'other version')]),
      sourceHashes: { 'src/parser.ts': base },
    });

    expect(conflictPaths(result)).toEqual([{ path: 'src/parser.ts', reason: 'both-modified' }]);
    expect(result.baseHashOfConflicts['src/parser.ts']).toBe(base);
    expect(result.conflictContent?.['src/parser.ts']).toEqual({
      candidate: 'candidate version',
      other: 'other version',
    });
    // The merged view keeps the candidate's entry; the caller shows both.
    expect(result.files).toHaveLength(1);
  });

  it('agrees when both members produced the same bytes', () => {
    const base = hashText('v1');
    const result = integrate({
      baseHashes: { 'src/parser.ts': base },
      candidate: manifestOf([modified('src/parser.ts', base, 'same')]),
      other: manifestOf([modified('src/parser.ts', base, 'same')]),
      sourceHashes: { 'src/parser.ts': base },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it('does not block on unrelated source changes', () => {
    const base = hashText('a1');
    const result = integrate({
      baseHashes: { 'src/a.ts': base, 'docs/notes.md': hashText('notes') },
      candidate: manifestOf([modified('src/a.ts', base, 'a2')]),
      sourceHashes: {
        'src/a.ts': base,
        // Somebody else edited a file this member never touched.
        'docs/notes.md': hashText('notes v2'),
      },
    });
    expect(result.conflicts).toEqual([]);
  });

  it('blocks when the file the member changed has moved on in the source', () => {
    const base = hashText('a1');
    const result = integrate({
      baseHashes: { 'src/a.ts': base },
      candidate: manifestOf([modified('src/a.ts', base, 'a2')]),
      sourceHashes: { 'src/a.ts': hashText('a1 plus a headline fix') },
    });

    expect(conflictPaths(result)).toEqual([{ path: 'src/a.ts', reason: 'source-changed' }]);
    expect(result.baseHashOfConflicts['src/a.ts']).toBe(base);
  });

  it('blocks when the source deleted the file the member modified', () => {
    const base = hashText('a1');
    const result = integrate({
      baseHashes: { 'src/a.ts': base },
      candidate: manifestOf([modified('src/a.ts', base, 'a2')]),
      sourceHashes: {},
    });
    expect(conflictPaths(result)).toEqual([{ path: 'src/a.ts', reason: 'deleted-vs-modified' }]);
  });

  it('reports deleted-vs-modified in both directions', () => {
    const base = hashText('a1');
    const candidateDeletes = integrate({
      baseHashes: { 'src/a.ts': base },
      candidate: manifestOf([removed('src/a.ts', base, 2)]),
      other: manifestOf([modified('src/a.ts', base, 'a2')]),
      sourceHashes: { 'src/a.ts': base },
    });
    expect(candidateDeletes.conflicts).toEqual([
      { path: 'src/a.ts', reason: 'deleted-vs-modified' },
    ]);

    const candidateModifies = integrate({
      baseHashes: { 'src/a.ts': base },
      candidate: manifestOf([modified('src/a.ts', base, 'a2')]),
      other: manifestOf([removed('src/a.ts', base, 2)]),
      sourceHashes: { 'src/a.ts': base },
    });
    expect(candidateModifies.conflicts).toEqual([
      { path: 'src/a.ts', reason: 'deleted-vs-modified' },
    ]);
  });

  it('reports added-vs-added when two members create the same path differently', () => {
    const result = integrate({
      candidate: manifestOf([added('src/new.ts', 'from candidate')]),
      other: manifestOf([added('src/new.ts', 'from other')]),
    });
    expect(result.conflicts).toEqual([{ path: 'src/new.ts', reason: 'added-vs-added' }]);
    expect(result.conflictContent?.['src/new.ts']).toEqual({
      candidate: 'from candidate',
      other: 'from other',
    });
  });

  it('keeps a rename as one entry and checks the old path', () => {
    const old = hashText('# Notes\n');
    const result = integrate({
      baseHashes: { 'src/notes.md': old },
      candidate: manifestOf([renamed('src/guide.md', 'src/notes.md', old, '# Notes\n')]),
      sourceHashes: { 'src/notes.md': old },
    });

    expect(result.conflicts).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/guide.md');
    expect(result.files[0]?.change).toBe('renamed');
    expect(result.files[0]?.fromPath).toBe('src/notes.md');

    const stale = integrate({
      baseHashes: { 'src/notes.md': old },
      candidate: manifestOf([renamed('src/guide.md', 'src/notes.md', old, '# Notes\n')]),
      sourceHashes: { 'src/notes.md': hashText('# Notes, edited upstream\n') },
    });
    expect(stale.conflicts).toEqual([{ path: 'src/notes.md', reason: 'source-changed' }]);
  });

  it('drops a deleted file that the source already deleted', () => {
    const base = hashText('gone');
    const result = integrate({
      baseHashes: { 'src/old.ts': base },
      candidate: manifestOf([removed('src/old.ts', base)]),
      sourceHashes: {},
    });
    // The deletion is already true; there is nothing to conflict about and
    // publishing it later is a no-op.
    expect(result.conflicts).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['src/old.ts']);
  });

  it('rejects absolute and escaping paths in a manifest', () => {
    const escaping = integrationError({
      candidate: manifestOf([added('../escape.ts', 'x')]),
    });
    expect(escaping).toBeInstanceOf(TeamError);
    expect(escaping.code).toBe('TEAM_INTEGRATION_CONFLICT');
    expect(escaping.message).toContain('escapes');

    const absolute = integrationError({
      candidate: manifestOf([added('/etc/passwd', 'x')]),
    });
    expect(absolute.code).toBe('TEAM_INTEGRATION_CONFLICT');

    const badRename = integrationError({
      candidate: manifestOf([renamed('src/b.ts', '../outside.ts', hashText('x'), 'x')]),
    });
    expect(badRename.code).toBe('TEAM_INTEGRATION_CONFLICT');
  });

  it('produces a candidate hash that is order independent and content sensitive', () => {
    const one = added('src/a.ts', 'a');
    const two = modified('src/b.ts', hashText('b1'), 'b2');
    const forward = integrate({ candidate: manifestOf([one, two]) });
    const backward = integrate({ candidate: manifestOf([two, one]) });
    expect(backward.candidateHash).toBe(forward.candidateHash);

    const changed = integrate({
      candidate: manifestOf([one, modified('src/b.ts', hashText('b1'), 'b3')]),
    });
    expect(changed.candidateHash).not.toBe(forward.candidateHash);
  });
});

// ------------------------------------------------------------------- publish ---

async function publishTarget(): Promise<string> {
  const base = await temporaryDirectory('eunoia-publish-');
  const target = join(base, 'target');
  await mkdir(join(target, 'src'), { recursive: true });
  return target;
}

function actions(result: PublishResult): string[] {
  return result.journal.map((entry) => entry.action);
}

describe('publishCandidate', () => {
  it('applies a candidate, preserves the executable bit and removes deletions', async () => {
    const target = await publishTarget();
    const baseContent = 'export const a = 1;\n';
    const readmeContent = '# readme\n';
    const baseHash = hashText(baseContent);
    const readmeHash = hashText(readmeContent);
    await writeFile(join(target, 'src', 'a.ts'), baseContent);
    await writeFile(join(target, 'README.md'), readmeContent);

    const files = [
      modified('src/a.ts', baseHash, 'export const a = 2;\n'),
      added('src/b.ts', 'export const b = 1;\n'),
      added('bin/run.sh', '#!/bin/sh\necho run\n', { executable: true }),
      removed('README.md', readmeHash, Buffer.byteLength(readmeContent)),
    ];

    const result = await publishCandidate({
      targetRoot: target,
      files,
      sourceHashes: {},
      expectedHashes: { 'src/a.ts': baseHash, 'README.md': readmeHash },
      idempotencyKey: 'publish-1',
    });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect([...result.applied].sort()).toEqual(
      ['README.md', 'bin/run.sh', 'src/a.ts', 'src/b.ts'].sort(),
    );
    expect(actions(result)).toEqual(['publish-start', 'published']);

    expect(await readFile(join(target, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(await readFile(join(target, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    await expect(stat(join(target, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(target, 'bin', 'run.sh'))).mode & 0o111).not.toBe(0);
    // No temporary files survive a successful publish.
    const srcEntries = await readdir(join(target, 'src'));
    expect(srcEntries.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('is idempotent: a retry with the same candidate applies nothing', async () => {
    const target = await publishTarget();
    const baseContent = 'base\n';
    const baseHash = hashText(baseContent);
    await writeFile(join(target, 'src', 'a.ts'), baseContent);
    const files = [
      modified('src/a.ts', baseHash, 'candidate\n'),
      added('src/b.ts', 'new file\n'),
    ];
    const input = {
      targetRoot: target,
      files,
      sourceHashes: {},
      expectedHashes: { 'src/a.ts': baseHash },
      idempotencyKey: 'publish-2',
    };

    const first = await publishCandidate(input);
    expect(first.ok).toBe(true);
    expect([...first.applied].sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const second = await publishCandidate(input);
    expect(second.ok).toBe(true);
    expect(second.applied).toEqual([]);
    expect([...second.skipped].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(second.conflicts).toEqual([]);
    expect(actions(second)).toEqual(['publish-start', 'published']);
    expect(await readFile(join(target, 'src', 'a.ts'), 'utf8')).toBe('candidate\n');
  });

  it('never overwrites a file whose base hash changed', async () => {
    const target = await publishTarget();
    const base = hashText('base\n');
    await writeFile(join(target, 'src', 'a.ts'), 'the user edited this after the diff\n');

    const result = await publishCandidate({
      targetRoot: target,
      files: [modified('src/a.ts', base, 'candidate\n')],
      sourceHashes: { 'src/a.ts': base },
      expectedHashes: { 'src/a.ts': base },
      idempotencyKey: 'publish-3',
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([{ path: 'src/a.ts', reason: 'source-changed' }]);
    expect(await readFile(join(target, 'src', 'a.ts'), 'utf8')).toBe(
      'the user edited this after the diff\n',
    );
  });

  it('publishes a rename as delete plus write', async () => {
    const target = await publishTarget();
    const content = '# Notes\n';
    const oldHash = hashText(content);
    await writeFile(join(target, 'src', 'notes.md'), content);

    const result = await publishCandidate({
      targetRoot: target,
      files: [renamed('src/guide.md', 'src/notes.md', oldHash, content)],
      sourceHashes: { 'src/notes.md': oldHash },
      expectedHashes: { 'src/notes.md': oldHash },
      idempotencyKey: 'publish-4',
    });

    expect(result.ok).toBe(true);
    expect([...result.applied].sort()).toEqual(['src/guide.md', 'src/notes.md']);
    await expect(stat(join(target, 'src', 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'src', 'guide.md'), 'utf8')).toBe(content);
  });

  it('refuses to delete a file whose content is not the expected base', async () => {
    const target = await publishTarget();
    await writeFile(join(target, 'src', 'old.ts'), 'edited\n');
    const base = hashText('original\n');

    const result = await publishCandidate({
      targetRoot: target,
      files: [removed('src/old.ts', base)],
      sourceHashes: { 'src/old.ts': base },
      expectedHashes: { 'src/old.ts': base },
      idempotencyKey: 'publish-5',
    });

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([{ path: 'src/old.ts', reason: 'source-changed' }]);
    expect(await readFile(join(target, 'src', 'old.ts'), 'utf8')).toBe('edited\n');
  });

  it('journals a partial failure and a recovery never overwrites a later edit', async () => {
    const target = await publishTarget();
    const staging = await temporaryDirectory('eunoia-staging-');
    const baseA = hashText('base-a\n');
    await writeFile(join(target, 'src', 'a.ts'), 'base-a\n');

    const binaryBytes = Buffer.from([0, 7, 0, 7, 0]);
    const binaryEntry = artifactFile('src/b.bin', 'added', {
      contentHash: hashBytes(binaryBytes),
      bytes: binaryBytes.length,
      binary: true,
    });
    const files = [modified('src/a.ts', baseA, 'candidate-a\n'), binaryEntry];
    const expectedHashes = { 'src/a.ts': baseA };

    // First attempt: the binary's content is not in the manifest and no content
    // root is supplied, so the publish stops after applying src/a.ts.
    const first = await publishCandidate({
      targetRoot: target,
      files,
      sourceHashes: {},
      expectedHashes,
      idempotencyKey: 'publish-6',
    });
    expect(first.ok).toBe(false);
    expect(first.applied).toEqual(['src/a.ts']);
    expect(actions(first)).toEqual(['publish-start', 'failed']);
    expect(first.journal[1]?.applied).toEqual(['src/a.ts']);
    expect(first.journal[1]?.detail).toContain('no content');
    expect(await readFile(join(target, 'src', 'a.ts'), 'utf8')).toBe('candidate-a\n');
    await expect(stat(join(target, 'src', 'b.bin'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The person edits the file the failed publish did apply.
    await writeFile(join(target, 'src', 'a.ts'), 'user edited after the failure\n');
    // The binary's bytes are staged and the same idempotency key is retried.
    await mkdir(join(staging, 'src'), { recursive: true });
    await writeFile(join(staging, 'src', 'b.bin'), binaryBytes);

    const second = await publishCandidate({
      targetRoot: target,
      files,
      sourceHashes: {},
      expectedHashes,
      idempotencyKey: 'publish-6',
      contentRoot: staging,
    });

    expect(second.ok).toBe(true);
    expect(second.applied).toEqual(['src/b.bin']);
    expect(second.skipped).toEqual(['src/a.ts']);
    expect(second.conflicts).toEqual([{ path: 'src/a.ts', reason: 'source-changed' }]);
    // The post-failure edit is preserved; the remaining file was applied.
    expect(await readFile(join(target, 'src', 'a.ts'), 'utf8')).toBe(
      'user edited after the failure\n',
    );
    expect(await readFile(join(target, 'src', 'b.bin'))).toEqual(binaryBytes);
  });

  it('rejects paths that escape the target lexically', async () => {
    const base = await temporaryDirectory('eunoia-publish-');
    const target = join(base, 'target');
    await mkdir(target, { recursive: true });

    const escaping = await expectTeamError(
      publishCandidate({
        targetRoot: target,
        files: [added('../evil.txt', 'x')],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: 'publish-7',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
    expect(escaping.message).toContain('escapes');
    await expect(stat(join(base, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expectTeamError(
      publishCandidate({
        targetRoot: target,
        files: [added('/etc/evil.txt', 'x')],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: 'publish-8',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
  });

  it('refuses to publish through a symlinked directory out of the target', async () => {
    const base = await temporaryDirectory('eunoia-publish-');
    const target = join(base, 'target');
    const outside = join(base, 'outside');
    await mkdir(target, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(target, 'sub'), 'dir');

    await expectTeamError(
      publishCandidate({
        targetRoot: target,
        files: [added('sub/escape.txt', 'escape\n')],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: 'publish-9',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
    await expect(stat(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an empty idempotency key and an unknown target', async () => {
    const target = await publishTarget();
    await expectTeamError(
      publishCandidate({
        targetRoot: target,
        files: [],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: '',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
    const missing = join(target, 'does-not-exist');
    await expectTeamError(
      publishCandidate({
        targetRoot: missing,
        files: [],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: 'publish-10',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
  });

  it('reports an unknown change instead of guessing', async () => {
    const target = await publishTarget();
    const bogus = artifactFile('src/a.ts', 'added');
    // A manifest read from storage could carry a value this build does not know.
    const corrupt = { ...bogus, change: 'moved' as ArtifactFile['change'] };
    await expectTeamError(
      publishCandidate({
        targetRoot: target,
        files: [corrupt],
        sourceHashes: {},
        expectedHashes: {},
        idempotencyKey: 'publish-11',
      }),
      'TEAM_INTEGRATION_CONFLICT',
    );
  });
});
