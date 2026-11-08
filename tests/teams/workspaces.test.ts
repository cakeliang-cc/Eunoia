/**
 * Isolated member workspaces.
 *
 * Every test uses a real temporary tree and a real filesystem: the properties
 * that matter here are "what bytes ended up on disk" and "what was touched", and
 * neither can be observed through a fake. The source fixture deliberately looks
 * like a checkout with credentials, ignored build output and an out-of-tree
 * symlink, because those are the entries that must never reach a member.
 */

import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import type { SandboxToolProvider } from '../../src/sandbox/tool-adapter.ts';
import type { ToolSandboxSession } from '../../src/tools/types.ts';
import { TeamWorkspaceService } from '../../src/teams/workspaces.ts';
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

interface Fixture {
  readonly source: string;
  readonly storage: string;
  readonly outside: string;
}

/**
 * A project with everything a copy must exclude, plus an uncommitted file that
 * must survive: the source is not a git repository in this test, which is the
 * point — the service must not depend on git to know what to copy.
 */
async function projectFixture(): Promise<Fixture> {
  const base = await temporaryDirectory('eunoia-teamws-');
  const source = join(base, 'project');
  const storage = join(base, 'data');
  const outside = join(base, 'outside');
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(source, 'bin'), { recursive: true });
  await mkdir(join(source, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(source, 'dist'), { recursive: true });
  await mkdir(join(source, '.git'), { recursive: true });
  await mkdir(storage, { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(source, 'src', 'index.ts'), 'export const answer = 41;\n');
  await writeFile(join(source, 'src', 'notes.md'), '# Notes\n');
  await writeFile(join(source, 'README.md'), '# Project\n');
  await writeFile(join(source, 'draft.txt'), 'uncommitted work in progress\n');
  await writeFile(join(source, '.env'), 'SECRET=do-not-copy\n');
  await writeFile(join(source, '.git', 'config'), '[core]\n');
  await writeFile(join(source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(source, 'dist', 'bundle.js'), 'bundle\n');
  await writeFile(join(source, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
  await writeFile(join(source, 'id_rsa'), 'PRIVATE KEY\n');
  await writeFile(join(source, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
  await chmod(join(source, 'bin', 'run.sh'), 0o755);

  await writeFile(join(outside, 'secret.txt'), 'outside the project\n');
  await symlink(join(outside, 'secret.txt'), join(source, 'link-out.txt'));

  return { source, storage, outside };
}

/**
 * A content-and-mode snapshot of a whole tree, including symlinks, ignored
 * directories and credential files.
 *
 * Comparing this before and after an operation is how the tests prove the user's
 * project was read and never written: hashing only the visible files would miss
 * a deleted `.env` or a rewritten `.git/config`.
 */
async function snapshotTree(root: string, relativePath = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const absolute = relativePath === '' ? root : join(root, relativePath);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
    const childAbsolute = join(root, child);
    const info = await lstat(childAbsolute);
    if (info.isSymbolicLink()) {
      out[child] = `link:${await readlink(childAbsolute)}`;
      continue;
    }
    if (info.isDirectory()) {
      out[`${child}/`] = `dir:${(info.mode & 0o777).toString(8)}`;
      Object.assign(out, await snapshotTree(root, child));
      continue;
    }
    out[child] = `file:${(info.mode & 0o777).toString(8)}:${await hashFile(childAbsolute)}`;
  }
  return out;
}

async function hashFile(absolute: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`;
}

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function serviceFor(store: MemorySandboxStore, source: string, storage: string): TeamWorkspaceService {
  return new TeamWorkspaceService({
    store,
    options: {
      sourceRoot: source,
      storageRoot: storage,
      now: () => new Date('2026-05-01T10:00:00.000Z'),
    },
  });
}

function copyInput(memberId = 'member_a') {
  return {
    teamId: 'team_1',
    runId: 'run_1',
    ownerId: 'user_1',
    memberId,
    name: `Worker ${memberId}`,
    mode: 'copy' as const,
  };
}

// --------------------------------------------------------------- snapshotting ---

describe('TeamWorkspaceService.provision (copy)', () => {
  it('copies a private snapshot that excludes credentials, ignored trees and out-of-tree links', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const before = await snapshotTree(source);

    const provisioned = await service.provision(copyInput());

    expect(provisioned.workspaceTaskId).toMatch(/^teamws_[0-9a-f]{32}$/);
    expect(provisioned.workspaceId).toMatch(/^ws_team_[0-9a-f]{32}$/);
    const expectedPath = await realpath(
      join(storage, 'team-workspaces', provisioned.workspaceTaskId),
    );
    expect(provisioned.workspacePath).toBe(expectedPath);
    // The snapshot lives under the storage root, not in the project.
    expect(provisioned.workspacePath.startsWith(`${await realpath(join(storage, 'team-workspaces'))}/`)).toBe(true);

    const snapshot = await snapshotTree(provisioned.workspacePath);
    const names = Object.keys(snapshot);
    expect(names).toContain('src/index.ts');
    expect(names).toContain('src/notes.md');
    expect(names).toContain('README.md');
    expect(names).toContain('bin/run.sh');
    // The uncommitted file is part of the tree and must be copied.
    expect(names).toContain('draft.txt');
    expect(await readFile(join(provisioned.workspacePath, 'draft.txt'), 'utf8')).toBe(
      'uncommitted work in progress\n',
    );
    // Nothing that looks like a credential or an ignored tree.
    expect(names.some((name) => name === '.env' || name.startsWith('.env.'))).toBe(false);
    expect(names).not.toContain('.git/');
    expect(names).not.toContain('node_modules/');
    expect(names).not.toContain('dist/');
    expect(names).not.toContain('.npmrc');
    expect(names).not.toContain('id_rsa');
    // A symlink pointing outside the project is not followed or recreated.
    expect(names).not.toContain('link-out.txt');

    // The executable bit survives the copy.
    expect((await stat(join(provisioned.workspacePath, 'bin', 'run.sh'))).mode & 0o111).not.toBe(0);

    // The sandbox row is what the Gateway mounts.
    const row = await store.getWorkspaceForTask(provisioned.workspaceTaskId);
    expect(row).not.toBeNull();
    expect(row?.workspaceId).toBe(provisioned.workspaceId);
    expect(row?.mode).toBe('copy');
    expect(row?.storageLocation).toBe(provisioned.workspacePath);

    // The baseline is a sibling of the workspace, never a file the member could edit.
    const workspaceEntries = await readdir(provisioned.workspacePath);
    expect(workspaceEntries.some((name) => name.endsWith('.baseline.json'))).toBe(false);
    const baseline = await service.baseline(provisioned.baselineId);
    expect(baseline).not.toBeNull();
    expect(baseline?.sourceVersion).toBe(provisioned.sourceVersion);
    expect(baseline?.hashes['src/index.ts']).toBe(hashText('export const answer = 41;\n'));
    expect(baseline?.files['bin/run.sh']?.executable).toBe(true);
    expect(baseline?.files['src/index.ts']?.bytes).toBe(
      Buffer.byteLength('export const answer = 41;\n'),
    );

    // Idempotent: a second provision returns the same workspace and baseline.
    const again = await service.provision(copyInput());
    expect(again.workspaceId).toBe(provisioned.workspaceId);
    expect(again.workspacePath).toBe(provisioned.workspacePath);
    expect(again.baselineId).toBe(provisioned.baselineId);
    expect(again.sourceVersion).toBe(provisioned.sourceVersion);
    expect(again.baselineHashes).toEqual(provisioned.baselineHashes);

    // The source is byte-and-mode identical: provision only read it.
    expect(await snapshotTree(source)).toEqual(before);
  });

  it('reuses an existing workspace without resetting the member\'s changes', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);

    const provisioned = await service.provision(copyInput());
    await writeFile(join(provisioned.workspacePath, 'src', 'added.ts'), 'export const added = 1;\n');

    const again = await service.provision(copyInput());
    expect(again.baselineId).toBe(provisioned.baselineId);
    // A re-provision that re-copied would erase this file and the diff with it.
    expect(await readFile(join(again.workspacePath, 'src', 'added.ts'), 'utf8')).toBe(
      'export const added = 1;\n',
    );
  });

  it('refuses a tree with more files than maxFiles', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = new TeamWorkspaceService({
      store,
      options: { sourceRoot: source, storageRoot: storage, maxFiles: 2 },
    });

    const error = await expectTeamError(
      service.provision(copyInput('member_limit')),
      'TEAM_WORKSPACE',
    );
    expect(error.message).toContain('more than 2 files');
    expect(error.detail).toEqual({ maxFiles: 2 });
  });
});

// ----------------------------------------------------------------------- diff ---

describe('TeamWorkspaceService.diff', () => {
  it('reports added, modified, deleted, renamed, binary and executable changes', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const before = await snapshotTree(source);
    const provisioned = await service.provision(copyInput());

    const workspace = provisioned.workspacePath;
    await writeFile(join(workspace, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(workspace, 'src', 'added.ts'), 'export const added = true;\n');
    await rm(join(workspace, 'README.md'));
    await rename(join(workspace, 'src', 'notes.md'), join(workspace, 'src', 'guide.md'));
    await writeFile(join(workspace, 'asset.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await writeFile(join(workspace, 'bin', 'tool'), '#!/bin/sh\necho tool\n');
    await chmod(join(workspace, 'bin', 'tool'), 0o755);
    await writeFile(join(workspace, 'bin', 'run.sh'), '#!/bin/sh\necho run twice\n');
    await chmod(join(workspace, 'bin', 'run.sh'), 0o700);
    // A member-created credential file must not become an artifact.
    await writeFile(join(workspace, '.env'), 'SECRET=member-created\n');

    const manifest = await service.diff({
      workspaceTaskId: provisioned.workspaceTaskId,
      baselineId: provisioned.baselineId,
    });
    const byPath = new Map(manifest.files.map((file) => [file.path, file]));

    const modified = byPath.get('src/index.ts');
    expect(modified?.change).toBe('modified');
    expect(modified?.baseHash).toBe(provisioned.baselineHashes['src/index.ts']);
    expect(modified?.contentHash).toBe(hashText('export const answer = 42;\n'));
    expect(modified?.content).toBe('export const answer = 42;\n');
    expect(modified?.bytes).toBe(Buffer.byteLength('export const answer = 42;\n'));
    expect(modified?.binary).toBe(false);

    const added = byPath.get('src/added.ts');
    expect(added?.change).toBe('added');
    expect(added?.baseHash).toBeNull();
    expect(added?.contentHash).toBe(hashText('export const added = true;\n'));

    const deleted = byPath.get('README.md');
    expect(deleted?.change).toBe('deleted');
    expect(deleted?.baseHash).toBe(provisioned.baselineHashes['README.md']);
    expect(deleted?.contentHash).toBeNull();
    expect(deleted?.content).toBeUndefined();
    expect(deleted?.bytes).toBe(Buffer.byteLength('# Project\n'));

    const renamed = byPath.get('src/guide.md');
    expect(renamed?.change).toBe('renamed');
    expect(renamed?.fromPath).toBe('src/notes.md');
    expect(renamed?.baseHash).toBe(provisioned.baselineHashes['src/notes.md']);
    expect(renamed?.contentHash).toBe(provisioned.baselineHashes['src/notes.md']);
    expect(renamed?.content).toBe('# Notes\n');

    const binary = byPath.get('asset.bin');
    expect(binary?.change).toBe('added');
    expect(binary?.binary).toBe(true);
    expect(binary?.content).toBeUndefined();
    expect(binary?.bytes).toBe(5);

    const executable = byPath.get('bin/tool');
    expect(executable?.executable).toBe(true);
    expect(executable?.content).toBe('#!/bin/sh\necho tool\n');
    expect(byPath.get('bin/run.sh')?.executable).toBe(true);

    expect(byPath.has('.env')).toBe(false);
    expect(manifest.sourceVersion).toBe(provisioned.sourceVersion);
    expect(manifest.candidateHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // A diff is a read of the member workspace; the project is untouched.
    expect(await snapshotTree(source)).toEqual(before);
    // A second diff of the same tree produces the same candidate hash.
    const repeated = await service.diff({
      workspaceTaskId: provisioned.workspaceTaskId,
      baselineId: provisioned.baselineId,
    });
    expect(repeated.candidateHash).toBe(manifest.candidateHash);
  });

  it('hashes the current tree for conflict checks', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const provisioned = await service.provision(copyInput());

    const hashes = await service.currentHashes(provisioned.workspaceTaskId);
    expect(hashes['src/index.ts']).toBe(provisioned.baselineHashes['src/index.ts']);
    expect(hashes['.env']).toBeUndefined();
    expect(hashes['node_modules/dep/index.js']).toBeUndefined();

    await writeFile(join(provisioned.workspacePath, 'src', 'index.ts'), 'changed\n');
    const changed = await service.currentHashes(provisioned.workspaceTaskId);
    expect(changed['src/index.ts']).toBe(hashText('changed\n'));
  });

  it('rejects a baseline that names a path outside the workspace', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const provisioned = await service.provision(copyInput());

    const baselineDirectory = join(storage, 'team-workspaces');
    await writeFile(
      join(baselineDirectory, 'evil.baseline.json'),
      JSON.stringify({
        baselineId: 'bl_evil',
        sourceVersion: 'sha256:evil',
        createdAt: '2026-05-01T10:00:00.000Z',
        hashes: { '../escape.txt': 'sha256:00' },
        files: {},
      }),
    );
    const error = await expectTeamError(
      service.diff({ workspaceTaskId: provisioned.workspaceTaskId, baselineId: 'bl_evil' }),
      'TEAM_WORKSPACE',
    );
    expect(error.message).toContain('escapes');

    await writeFile(
      join(baselineDirectory, 'evil-absolute.baseline.json'),
      JSON.stringify({
        baselineId: 'bl_evil_absolute',
        sourceVersion: 'sha256:evil',
        createdAt: '2026-05-01T10:00:00.000Z',
        hashes: { '/etc/passwd': 'sha256:00' },
        files: {},
      }),
    );
    await expectTeamError(
      service.diff({
        workspaceTaskId: provisioned.workspaceTaskId,
        baselineId: 'bl_evil_absolute',
      }),
      'TEAM_WORKSPACE',
    );
  });

  it('refuses a baseline id it has never written', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const provisioned = await service.provision(copyInput());

    await expectTeamError(
      service.diff({ workspaceTaskId: provisioned.workspaceTaskId, baselineId: 'bl_missing' }),
      'TEAM_WORKSPACE',
    );
  });
});

// -------------------------------------------------------------- modes/cleanup ---

describe('TeamWorkspaceService modes', () => {
  it('gives a read-only member its own snapshot rather than the source', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);

    const provisioned = await service.provision({
      ...copyInput('member_reader'),
      mode: 'readonly',
    });

    expect(provisioned.workspacePath).not.toBe(await realpath(source));
    expect((await store.getWorkspaceForTask(provisioned.workspaceTaskId))?.mode).toBe('copy');
    const snapshot = await snapshotTree(provisioned.workspacePath);
    expect(snapshot['src/index.ts']).toBeDefined();
    expect(snapshot['.env']).toBeUndefined();
  });

  it('binds the source for the root member and never modifies it', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);

    const provisioned = await service.provision({
      ...copyInput('member_root'),
      mode: 'bind',
    });

    expect(provisioned.workspacePath).toBe(await realpath(source));
    expect((await store.getWorkspaceForTask(provisioned.workspaceTaskId))?.mode).toBe('bind');
    expect(provisioned.baselineHashes['src/index.ts']).toBe(
      hashText('export const answer = 41;\n'),
    );
    // The baseline lives in storage even when the workspace is the project.
    expect((await service.baseline(provisioned.baselineId))?.sourceVersion).toBe(
      provisioned.sourceVersion,
    );

    // Editing the project is a modification against the bind baseline.
    await writeFile(join(source, 'README.md'), '# Project v2\n');
    const manifest = await service.diff({
      workspaceTaskId: provisioned.workspaceTaskId,
      baselineId: provisioned.baselineId,
    });
    expect(manifest.files.find((file) => file.path === 'README.md')?.change).toBe('modified');

    // Cleanup never deletes the person's repository.
    expect(
      await service.cleanup({ workspaceTaskId: provisioned.workspaceTaskId, referenced: false }),
    ).toBe(false);
    expect(await readFile(join(source, 'README.md'), 'utf8')).toBe('# Project v2\n');
  });
});

describe('TeamWorkspaceService.cleanup', () => {
  it('refuses a referenced workspace and removes an unreferenced one completely', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);
    const provisioned = await service.provision(copyInput());

    expect(
      await service.cleanup({ workspaceTaskId: provisioned.workspaceTaskId, referenced: true }),
    ).toBe(false);
    expect((await stat(provisioned.workspacePath)).isDirectory()).toBe(true);

    expect(
      await service.cleanup({ workspaceTaskId: provisioned.workspaceTaskId, referenced: false }),
    ).toBe(true);
    await expect(stat(provisioned.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.getWorkspaceForTask(provisioned.workspaceTaskId)).toBeNull();
    expect(await service.baseline(provisioned.baselineId)).toBeNull();
    // The baseline file is gone too, not just the directory.
    const leftovers = await readdir(join(storage, 'team-workspaces'));
    expect(leftovers).toEqual([]);

    // Nothing left to clean up.
    expect(
      await service.cleanup({ workspaceTaskId: provisioned.workspaceTaskId, referenced: false }),
    ).toBe(false);
  });

  it('refuses a workspace row that does not belong to this service', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const service = serviceFor(store, source, storage);

    // A row pointing at the project itself, with a copy mode, must never be
    // recursively deleted.
    await store.saveWorkspace({
      workspaceId: 'ws_team_tampered',
      taskId: 'teamws_tampered',
      storageLocation: source,
      mode: 'copy',
      currentVersion: 'sha256:tampered',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    });
    expect(
      await service.cleanup({ workspaceTaskId: 'teamws_tampered', referenced: false }),
    ).toBe(false);
    expect((await stat(source)).isDirectory()).toBe(true);
  });
});

describe('TeamWorkspaceService.session', () => {
  it('binds the tool ports to the member workspace task', async () => {
    const { source, storage } = await projectFixture();
    const store = new MemorySandboxStore();
    const calls: { taskId: string; userId: string; sessionId: string }[] = [];
    const session = { displayPath: '/workspace' } as unknown as ToolSandboxSession;
    const provider: SandboxToolProvider = {
      async forTask(target) {
        calls.push(target);
        return session;
      },
    };
    const service = new TeamWorkspaceService({
      store,
      provider,
      options: { sourceRoot: source, storageRoot: storage },
    });
    const provisioned = await service.provision(copyInput());

    const bound = await service.session({
      userId: 'user_1',
      workspaceTaskId: provisioned.workspaceTaskId,
      sessionId: 'session_1',
    });
    expect(bound).toBe(session);
    expect(calls).toEqual([
      { taskId: provisioned.workspaceTaskId, userId: 'user_1', sessionId: 'session_1' },
    ]);

    const withoutProvider = serviceFor(new MemorySandboxStore(), source, storage);
    expect(
      await withoutProvider.session({
        userId: 'user_1',
        workspaceTaskId: provisioned.workspaceTaskId,
        sessionId: 'session_1',
      }),
    ).toBeNull();
  });
});
