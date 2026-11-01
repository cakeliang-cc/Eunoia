/**
 * Git path mapping for a workspace that is a repository subdirectory.
 *
 * `git status --porcelain` reports paths relative to the repository root even
 * when git runs in a subdirectory. The workbench addresses the directory it was
 * given, so these tests pin the translation and the refusal to walk above it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitDiff, gitSnapshot } from '../../src/workspace-ui/git.ts';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
let base: string;
let repo: string;
let sub: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'eunoia-git-'));
  repo = join(base, 'repo');
  sub = join(repo, 'pkg');
  await mkdir(join(sub, 'src'), { recursive: true });
  await writeFile(join(sub, 'src', 'a.ts'), 'a\n');
  await writeFile(join(repo, 'root.txt'), 'r\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('a workspace inside a repository', () => {
  it.skipIf(!hasGit)('reports only paths inside the workspace, relative to it', async () => {
    await writeFile(join(sub, 'src', 'a.ts'), 'b\n');
    await writeFile(join(repo, 'root.txt'), 'outside\n');

    const snapshot = await gitSnapshot(sub, {
      timeoutMs: 5_000,
      maxBytes: 100_000,
      maxChanges: 100,
    });

    expect(snapshot.repo).toBe(true);
    expect(snapshot.changes).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'modified' }),
    ]);
  });

  it.skipIf(!hasGit)('diffs a workspace-relative path from a subdirectory', async () => {
    await writeFile(join(sub, 'src', 'a.ts'), 'b\n');

    const diff = await gitDiff(sub, 'src/a.ts', { timeoutMs: 5_000, maxBytes: 100_000 });

    expect(diff.error).toBeNull();
    expect(diff.patch).toContain('-a');
    expect(diff.patch).toContain('+b');
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}
