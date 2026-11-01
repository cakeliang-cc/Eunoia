/**
 * The path guard, exercised against a real filesystem.
 *
 * A pure string test cannot prove this module: the escapes that matter are
 * symlinks, symlinked parents, and a write through a link. Each case here creates
 * a directory outside the root and asserts that the outside file is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFiles } from '../../src/sandbox/workspace-files.ts';
import { WorkspaceError } from '../../src/sandbox/errors.ts';

let base: string;
let root: string;
let outside: string;
let files: WorkspaceFiles;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'eunoia-paths-'));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(outside, 'secret.txt'), 'do not read me\n');
  files = new WorkspaceFiles({ root, ignore: ['ignored'] });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('path containment', () => {
  it('accepts a relative path and reports the container path', async () => {
    const resolved = files.resolve('src/a.ts');
    expect(resolved.relative).toBe('src/a.ts');
    expect(resolved.container).toBe('/workspace/src/a.ts');
    // The root is canonicalised at construction (`/private/var` on macOS), so
    // the expected host path is the canonical one, not the configured string.
    expect(resolved.host).toBe(join(await realpath(root), 'src', 'a.ts'));
  });

  it.each(['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', ''])(
    'refuses %s',
    (path) => {
      expect(() => files.resolve(path)).toThrow(WorkspaceError);
    },
  );

  it('refuses a NUL byte and a newline', () => {
    expect(() => files.resolve('a\0b')).toThrow(WorkspaceError);
    expect(() => files.resolve('a\nb')).toThrow(WorkspaceError);
  });

  it('refuses reading through a symlink', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(files.readLines('link.txt')).rejects.toThrow(/symbolic link|escapes/);
  });

  it('refuses a directory that is a symlink', async () => {
    await symlink(outside, join(root, 'outdir'));
    await expect(files.listDir('outdir')).rejects.toThrow(/symbolic link|escapes/);
  });

  it('refuses writing through a symlink and leaves the target intact', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(files.writeText('link.txt', 'pwned')).rejects.toThrow(/symbolic link|escapes/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('do not read me\n');
  });

  it('refuses a new file under a symlinked parent before creating it', async () => {
    await symlink(outside, join(root, 'outdir'));
    await expect(files.writeText('outdir/new/file.txt', 'x')).rejects.toThrow(/symbolic link|escapes/);
    await expect(readFile(join(outside, 'new', 'file.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses an ignored directory', async () => {
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'x.txt'), 'x');
    await expect(files.readLines('ignored/x.txt')).rejects.toThrow(/ignored/);
    await expect(files.listDir('ignored')).rejects.toThrow(/ignored/);
  });

  it('refuses credential files by default and allows the example file', async () => {
    await writeFile(join(root, '.env'), 'TOKEN=secret\n');
    await writeFile(join(root, '.env.example'), 'TOKEN=\n');
    await writeFile(join(root, 'server.pem'), 'key');
    await expect(files.readLines('.env')).rejects.toThrow(/credential/);
    await expect(files.readLines('server.pem')).rejects.toThrow(/credential/);
    await expect(files.grep({ pattern: 'TOKEN', path: '.env' })).rejects.toThrow(/credential/);
    const example = await files.readLines('.env.example');
    expect(example.text).toContain('TOKEN=');
  });

  it('never follows a symlink out of the workspace while greedily listing', async () => {
    await symlink(outside, join(root, 'out'));
    const listing = await files.listDir('.', 2);
    // Symlinks are skipped entirely rather than rendered as a directory the
    // model might then ask to read.
    expect(listing.text).not.toContain('secret.txt');
    expect(listing.text).toContain('src/');
  });
});

describe('file operations', () => {
  it('reads a numbered range', async () => {
    await writeFile(join(root, 'many.txt'), 'one\ntwo\nthree\nfour\n');
    const slice = await files.readLines('many.txt', 2, 3);
    expect(slice.text).toContain('     2\ttwo');
    expect(slice.text).toContain('     3\tthree');
    expect(slice.complete).toBe(false);
    expect(slice.totalLines).toBe(5);
  });

  it('writes atomically and reports created vs replaced', async () => {
    const created = await files.writeText('new/file.txt', 'hello');
    expect(created.created).toBe(true);
    const replaced = await files.writeText('new/file.txt', 'hello again');
    expect(replaced.created).toBe(false);
    expect(await readFile(join(root, 'new', 'file.txt'), 'utf8')).toBe('hello again');
  });

  it('refuses to overwrite a directory', async () => {
    await mkdir(join(root, 'dir'));
    await expect(files.writeText('dir', 'x')).rejects.toThrow(/regular file/);
  });

  it('edits exact text and refuses an ambiguous match', async () => {
    await writeFile(join(root, 'edit.txt'), 'alpha\nbeta\nalpha\n');
    await expect(files.editText({ path: 'edit.txt', oldString: 'alpha', newString: 'gamma' })).rejects.toThrow(
      /appears 2 times/,
    );
    const result = await files.editText({
      path: 'edit.txt',
      oldString: 'alpha',
      newString: 'gamma',
      replaceAll: true,
    });
    expect(result.replacements).toBe(2);
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('gamma\nbeta\ngamma\n');
  });

  it('refuses binary files', async () => {
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await expect(files.readLines('bin.dat')).rejects.toThrow(/binary/);
  });

  it('computes a content-sensitive digest', async () => {
    const before = await files.contentDigest();
    await files.writeText('src/a.ts', 'export const a = 2;\n');
    const after = await files.contentDigest();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
