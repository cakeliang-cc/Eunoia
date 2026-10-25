/**
 * The workspace boundary.
 *
 * Most of these tests are refusals, which is the point: a path sandbox is
 * defined by what it will not read. The lexical escape, the absolute path, the
 * symlink that points outside and the credential file are four different ways to
 * get content the model should not have, and each one is pinned here because a
 * single check that "looks right" has already been enough to ship two of them in
 * other projects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace, WorkspaceError } from '../../src/tools/workspace.ts';

let base: string;
let root: string;
let outside: string;
let workspace: Workspace;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'eunoia-workspace-'));
  root = join(base, 'repo');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  workspace = new Workspace({ root, ignore: ['secret-dir'] });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('path containment', () => {
  it('refuses a relative path that climbs out', () => {
    expect(() => workspace.resolve('../outside')).toThrow(WorkspaceError);
  });

  it('refuses an absolute path rather than silently clamping it', () => {
    expect(() => workspace.resolve('/etc/passwd')).toThrow(/relative/);
  });

  it('refuses a symlink that points outside, not just a lexical escape', async () => {
    await writeFile(join(outside, 'secret.txt'), 'do not read');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(workspace.readLines('link.txt')).rejects.toThrow(/escapes the workspace/);
  });

  it('accepts a path inside the workspace, including a nested one', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const slice = await workspace.readLines('src/a.ts');
    expect(slice.path).toBe('src/a.ts');
    expect(slice.text).toContain('export const a = 1;');
  });
});

describe('reading', () => {
  it('returns line numbers and honours a range', async () => {
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n');
    const slice = await workspace.readLines('a.ts', 2, 3);
    expect(slice.text).toContain('     2\ttwo');
    expect(slice.text).toContain('     3\tthree');
    expect(slice.text).not.toContain('one');
    expect(slice.start).toBe(2);
    expect(slice.end).toBe(3);
    expect(slice.complete).toBe(false);
    expect(slice.totalLines).toBe(5);
  });

  it('marks a whole-file read complete', async () => {
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');
    const slice = await workspace.readLines('a.ts');
    expect(slice.complete).toBe(true);
  });

  it('refuses a binary file', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    await expect(workspace.readLines('blob.bin')).rejects.toThrow(/binary/);
  });

  it('refuses credential files but allows the example', async () => {
    await writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=secret');
    await writeFile(join(root, '.env.example'), 'DEEPSEEK_API_KEY=');
    await expect(workspace.readLines('.env')).rejects.toThrow(/credential/);
    await expect(workspace.readLines('.env.example')).resolves.toBeTruthy();
  });

  it('refuses ignored directories', async () => {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'x.ts'), 'nope');
    await expect(workspace.readLines('node_modules/x.ts')).rejects.toThrow(/ignored/);
  });
});

describe('listing and searching', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1;\nconst other = 2;\n');
    await writeFile(join(root, 'src', 'b.js'), 'const needle = 3;\n');
    await writeFile(join(root, 'README.md'), 'needle in prose\n');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'x.ts'), 'needle hidden\n');
    await writeFile(join(root, '.env'), 'needle secret\n');
  });

  it('lists a tree without ignored or credential entries', async () => {
    const listing = await workspace.listDir('.', 2);
    expect(listing.text).toContain('src/');
    expect(listing.text).toContain('a.ts');
    expect(listing.text).not.toContain('node_modules');
    expect(listing.text).not.toContain('.env');
  });

  it('globs and excludes ignored trees and secrets', async () => {
    const found = await workspace.glob('**/*.ts');
    expect(found.paths).toEqual(['src/a.ts']);
  });

  it('greps with include and reports line numbers', async () => {
    const result = await workspace.grep({ pattern: 'needle', path: 'src', include: '*.ts' });
    expect(result.matches).toBe(1);
    expect(result.text).toContain('src/a.ts:1:');
  });

  it('reports an invalid regex instead of returning no matches', async () => {
    await expect(workspace.grep({ pattern: '[' })).rejects.toThrow(/invalid regular expression/);
  });

  it('refuses to grep a credential file named directly', async () => {
    await expect(workspace.grep({ pattern: 'needle', path: '.env' })).rejects.toThrow(/credential/);
  });
});

describe('writing', () => {
  it('creates parents and writes atomically', async () => {
    const result = await workspace.writeText('src/deep/new.ts', 'export const x = 1;\n');
    expect(result.created).toBe(true);
    expect(await readFile(join(root, 'src/deep/new.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('replaces an exact string only when it is unique', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\nconst a = 1;\n');
    await expect(
      workspace.editText({ path: 'a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' }),
    ).rejects.toThrow(/appears 2 times/);

    const result = await workspace.editText({
      path: 'a.ts',
      oldString: 'const a = 1;',
      newString: 'const a = 2;',
      replaceAll: true,
    });
    expect(result.replacements).toBe(2);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2;\nconst a = 2;\n');
  });

  it('reports a missing target instead of silently doing nothing', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await expect(
      workspace.editText({ path: 'a.ts', oldString: 'not here', newString: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('preserves CRLF on a round trip', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
    const result = await workspace.editText({
      path: 'a.ts',
      oldString: 'const a = 1;\nconst b = 2;',
      newString: 'const a = 9;\nconst b = 2;',
    });
    expect(result.replacements).toBe(1);
    const raw = await readFile(join(root, 'a.ts'));
    expect(raw.toString('utf8')).toBe('const a = 9;\r\nconst b = 2;\r\n');
    expect(raw.includes(Buffer.from('\r\n'))).toBe(true);
  });

  it('refuses to write outside the root', async () => {
    await expect(workspace.writeText('../outside/pwn.txt', 'x')).rejects.toThrow(WorkspaceError);
  });

  it('refuses to follow a symlink out of the workspace on write', async () => {
    await writeFile(join(outside, 'target.txt'), 'original');
    await symlink(join(outside, 'target.txt'), join(root, 'link.txt'));
    await expect(workspace.writeText('link.txt', 'changed')).rejects.toThrow(/escapes/);
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original');
  });

  it('refuses a new file under a symlinked parent before creating anything', async () => {
    await symlink(outside, join(root, 'outdir'));
    await expect(workspace.writeText('outdir/new/file.txt', 'x')).rejects.toThrow(/escapes/);
    // The pre-check must fire before `mkdir -p`, not after it has already
    // created the directory on the wrong side of the wall.
    await expect(readFile(join(outside, 'new', 'file.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('commands', () => {
  it('runs in the workspace and returns stdout and the exit code', async () => {
    await writeFile(join(root, 'marker.txt'), 'here');
    const result = await workspace.runCommand('pwd && cat marker.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(root);
    expect(result.stdout).toContain('here');
  });

  it('keeps a non-zero exit code', async () => {
    const result = await workspace.runCommand('exit 3');
    expect(result.exitCode).toBe(3);
  });
});
