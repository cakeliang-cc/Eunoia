/**
 * Physical cwd validation (ADR 021 §4.3, §4.4).
 *
 * A real temporary workspace is used on purpose: the point of this module is what
 * `realpath` says about symlinks and files, which a stubbed filesystem would let
 * a test fake. The lexical checks live in `cwd-path.test.ts`; these are the ones
 * that need an inode.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemCwdValidator } from '../../src/sandbox/cwd/cwd-validator.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

async function workspace(): Promise<{ hostRoot: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-cwd-'));
  roots.push(base);
  const hostRoot = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(hostRoot, 'project', 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(hostRoot, 'project', 'src', 'app.ts'), 'export {};\n');
  return { hostRoot, outside };
}

const validator = new FilesystemCwdValidator();

function validate(hostRoot: string, cwd: string) {
  return validator.validate({ workspaceRoot: '/workspace', workspaceHostRoot: hostRoot, cwd });
}

describe('FilesystemCwdValidator', () => {
  it('accepts an existing directory and returns its canonical path', async () => {
    const { hostRoot } = await workspace();
    const result = await validate(hostRoot, '/workspace/project/src');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cwd).toBe('/workspace/project/src');
    // `realpath` resolves `/var` to `/private/var` on macOS, so the assertion is
    // on the tail rather than the whole host path.
    expect(result.hostPath.endsWith(join('workspace', 'project', 'src'))).toBe(true);
  });

  it('accepts the workspace root itself', async () => {
    const { hostRoot } = await workspace();
    const result = await validate(hostRoot, '/workspace');
    expect(result.ok).toBe(true);
  });

  it('reports a missing directory', async () => {
    const { hostRoot } = await workspace();
    const result = await validate(hostRoot, '/workspace/nope');
    expect(result).toMatchObject({ ok: false, code: 'DIRECTORY_NOT_FOUND' });
  });

  it('reports a file as NOT_A_DIRECTORY', async () => {
    const { hostRoot } = await workspace();
    const result = await validate(hostRoot, '/workspace/project/src/app.ts');
    expect(result).toMatchObject({ ok: false, code: 'NOT_A_DIRECTORY' });
  });

  it('refuses a symlink that resolves outside the workspace', async () => {
    const { hostRoot, outside } = await workspace();
    await symlink(outside, join(hostRoot, 'escape'));
    const result = await validate(hostRoot, '/workspace/escape');
    expect(result).toMatchObject({ ok: false, code: 'SYMLINK_ESCAPE' });
  });

  it('canonicalises a symlink that stays inside the workspace', async () => {
    const { hostRoot } = await workspace();
    await symlink(join(hostRoot, 'project', 'src'), join(hostRoot, 'alias'));
    const result = await validate(hostRoot, '/workspace/alias');
    expect(result).toMatchObject({ ok: true, cwd: '/workspace/project/src' });
  });

  it('refuses a lexical path outside the workspace before touching the disk', async () => {
    const { hostRoot } = await workspace();
    const result = await validate(hostRoot, '/etc');
    expect(result).toMatchObject({ ok: false, code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('reports an unavailable workspace rather than a missing directory', async () => {
    const { hostRoot } = await workspace();
    const result = await validator.validate({
      workspaceRoot: '/workspace',
      workspaceHostRoot: join(hostRoot, 'gone'),
      cwd: '/workspace',
    });
    expect(result).toMatchObject({ ok: false, code: 'WORKSPACE_NOT_AVAILABLE' });
  });

  it('reports a symlink loop as an escape, not a stack overflow', async () => {
    const { hostRoot } = await workspace();
    await symlink(join(hostRoot, 'loop-a'), join(hostRoot, 'loop-b'));
    await symlink(join(hostRoot, 'loop-b'), join(hostRoot, 'loop-a'));
    const result = await validate(hostRoot, '/workspace/loop-a');
    expect(result).toMatchObject({ ok: false, code: 'SYMLINK_ESCAPE' });
  });
});
