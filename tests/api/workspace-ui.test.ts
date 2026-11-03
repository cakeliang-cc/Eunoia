/**
 * The workbench's HTTP surface.
 *
 * These tests are mostly refusals, because the interesting part of a file API
 * is what it will not read. A directory traversal, an absolute path, a
 * credential file, an ignored tree and a binary file are five different ways to
 * get content a page should not show, and each is pinned here.
 *
 * The terminal is the other boundary: a plain HTML form must not be able to run
 * a command, so the `X-Workspace-UI` header and same-origin check are exercised
 * alongside the happy path.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import { WorkspaceUiService } from '../../src/workspace-ui/service.ts';
import { workspaceUiConfig } from '../../src/workspace-ui/config.ts';

let base: string;
let root: string;
let statePath: string;
let server: Server;
let service: WorkspaceUiService;
let http: string;

/** The per-process token `createApp` normally mints; tests pin one. */
const TOKEN = 'test-token';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, any>;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const response = await fetch(`${http}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function jsonRequest(
  path: string,
  options: { method: string; body: unknown; headers?: Record<string, string> },
): Promise<ApiResponse> {
  return api(path, {
    method: options.method,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(options.body),
  });
}

async function start(options: { terminal?: boolean; browseRoots?: string; git?: boolean } = {}) {
  statePath = join(base, 'state', 'workspace.json');
  const env: NodeJS.ProcessEnv = {
    WORKSPACE_UI_STATE: statePath,
    WORKSPACE_TERMINAL: options.terminal ? '1' : '0',
    WORKSPACE_MAX_FILE_BYTES: '2048',
    ...(options.browseRoots ? { WORKSPACE_BROWSE_ROOTS: options.browseRoots } : {}),
  };
  service = await WorkspaceUiService.create({
    configuredRoot: root,
    config: workspaceUiConfig({ loopback: true, env }),
    git: options.git ?? true,
  });
  server = createApp({ store: new InMemoryStore(), workspaceUi: service, localToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  http = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  // macOS reports the temp directory through `/var`, a symlink to `/private/var`.
  // The service stores the canonical root, so the fixture does too.
  base = await realpath(await mkdtemp(join(tmpdir(), 'eunoia-workspace-ui-')));
  root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# repo\n');
  await writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=secret\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'x.js'), 'hidden');
  await mkdir(join(root, 'binary'));
  await writeFile(join(root, 'binary', 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  await rm(base, { recursive: true, force: true });
});

describe('workspace state', () => {
  it('reports the configured root without exposing it as a request input', async () => {
    const response = await api('/api/workspace');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: true,
      root,
      name: 'repo',
      source: 'config',
      terminal: false,
    });
  });

  it('reports no workspace when the server has none', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    service = await WorkspaceUiService.create({
      configuredRoot: null,
      config: workspaceUiConfig({ loopback: true, env: { WORKSPACE_UI_STATE: statePath } }),
      git: false,
    });
    server = createApp({ store: new InMemoryStore(), workspaceUi: service, localToken: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    http = `http://127.0.0.1:${port}`;

    const response = await api('/api/workspace');
    expect(response.body).toMatchObject({ configured: false, root: null });
    expect((await api('/api/workspace/files?path=.')).status).toBe(409);
  });
});

describe('listing and reading', () => {
  it('lists a level and hides ignored trees and credential files', async () => {
    const response = await api('/api/workspace/files?path=.');
    expect(response.status).toBe(200);
    expect(response.body.path).toBe('.');
    const names = response.body.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.env');
  });

  it('returns file text without the model-facing line-number gutter', async () => {
    const response = await api('/api/workspace/file?path=src/a.ts');
    expect(response.status).toBe(200);
    expect(response.body.text).toBe('export const a = 1;\n');
    expect(response.body.path).toBe('src/a.ts');
  });

  it('honours a line range', async () => {
    await writeFile(join(root, 'src', 'lines.txt'), 'one\ntwo\nthree\n');
    const response = await api('/api/workspace/file?path=src/lines.txt&start=2&end=3');
    expect(response.body.text).toBe('two\nthree');
    expect(response.body.complete).toBe(false);
    expect(response.body.start).toBe(2);
  });

  it('refuses an absolute path instead of clamping it', async () => {
    const response = await api('/api/workspace/file?path=%2Fetc%2Fpasswd');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('outside-workspace');
  });

  it('refuses a path that climbs out', async () => {
    const response = await api('/api/workspace/file?path=..%2Foutside.txt');
    expect(response.status).toBe(403);
  });

  it('refuses a credential file', async () => {
    const response = await api('/api/workspace/file?path=.env');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('sensitive');
  });

  it('refuses a directory symlink that resolves outside the workspace', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'do not show');
    await symlink(outside, join(root, 'escape'));

    const response = await api('/api/workspace/files?path=escape');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('outside-workspace');
  });

  it('refuses an ignored tree', async () => {
    const response = await api('/api/workspace/file?path=node_modules%2Fx.js');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ignored');
  });

  it('refuses a binary file', async () => {
    const response = await api('/api/workspace/file?path=binary%2Fblob.bin');
    expect(response.status).toBe(415);
    expect(response.body.code).toBe('binary');
  });

  it('refuses a file larger than the configured cap', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(8192));
    const response = await api('/api/workspace/file?path=big.txt');
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('too-large');
  });
});

describe('choosing a root', () => {
  it('requires the workbench header on the mutation', async () => {
    const response = await jsonRequest('/api/workspace', {
      method: 'POST',
      body: { path: join(base, 'other') },
    });
    expect(response.status).toBe(403);
  });

  it('switches the root, persists it, and lists the new directory', async () => {
    const other = join(base, 'other');
    await mkdir(other);
    await writeFile(join(other, 'only.txt'), 'here\n');

    const switched = await jsonRequest('/api/workspace', {
      method: 'POST',
      body: { path: other },
      headers: { 'x-workspace-ui': '1' },
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ configured: true, root: other, source: 'selected' });

    const listed = await api('/api/workspace/files?path=.');
    expect(listed.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['only.txt']);

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { root: string };
    expect(persisted.root).toBe(other);
  });

  it('refuses a file as a root', async () => {
    const response = await jsonRequest('/api/workspace', {
      method: 'POST',
      body: { path: join(root, 'README.md') },
      headers: { 'x-workspace-ui': '1' },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('not-a-directory');
  });
});

describe('the directory picker', () => {
  it('lists only directories', async () => {
    const response = await api(`/api/workspace/browse?path=${encodeURIComponent(root)}`);
    expect(response.status).toBe(200);
    const names = response.body.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('src');
    expect(names).toContain('node_modules');
    expect(names).not.toContain('README.md');
  });

  it('refuses to browse outside configured roots', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start({ browseRoots: root });
    const outside = await api(`/api/workspace/browse?path=${encodeURIComponent(base)}`);
    expect(outside.status).toBe(403);
  });

  it('refuses to switch to a directory outside configured roots', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start({ browseRoots: root });

    const response = await jsonRequest('/api/workspace', {
      method: 'POST',
      body: { path: base },
      headers: { 'x-workspace-ui': '1' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('outside-workspace');
  });

  it('refuses a file path', async () => {
    const response = await api(`/api/workspace/browse?path=${encodeURIComponent(join(root, 'README.md'))}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('not-a-directory');
  });
});

describe('git changes', () => {
  it.skipIf(!hasGit)('lists modified files and returns a unified diff', async () => {
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');

    const status = await api('/api/workspace/git/status');
    expect(status.status).toBe(200);
    expect(status.body.repo).toBe(true);
    expect(status.body.changes).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'modified' }),
    ]);

    const diff = await api(`/api/workspace/git/diff?path=${encodeURIComponent('src/a.ts')}`);
    expect(diff.status).toBe(200);
    expect(diff.body.patch).toContain('-export const a = 1;');
    expect(diff.body.patch).toContain('+export const a = 2;');
  });

  it.skipIf(!hasGit)('presents an untracked file as an addition', async () => {
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    await writeFile(join(root, 'src', 'new.ts'), 'export const fresh = true;\n');

    const status = await api('/api/workspace/git/status');
    expect(status.body.changes).toEqual([
      expect.objectContaining({ path: 'src/new.ts', kind: 'untracked' }),
    ]);

    const diff = await api(`/api/workspace/git/diff?path=${encodeURIComponent('src/new.ts')}`);
    expect(diff.body.untracked).toBe(true);
    expect(diff.body.patch).toContain('+++ b/src/new.ts');
    expect(diff.body.patch).toContain('+export const fresh = true;');
  });

  it.skipIf(!hasGit)('reports a directory that is not a repository', async () => {
    const status = await api('/api/workspace/git/status');
    expect(status.body.repo).toBe(false);
    expect(status.body.error).toBeNull();
  });
});

describe('the terminal', () => {
  it('is refused without the UI header', async () => {
    const response = await jsonRequest('/api/workspace/terminal', {
      method: 'POST',
      body: { command: 'printf hello' },
    });
    expect(response.status).toBe(403);
  });

  it('is refused without the local token', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start({ terminal: true });

    const response = await jsonRequest('/api/workspace/terminal', {
      method: 'POST',
      body: { command: 'printf hello' },
      headers: { 'x-workspace-ui': '1' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('terminal-disabled');
  });

  it('streams output and an exit code when enabled', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start({ terminal: true });

    const response = await fetch(`${http}/api/workspace/terminal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workspace-ui': '1',
        'x-eunoia-token': TOKEN,
      },
      body: JSON.stringify({ command: "printf 'hello'; printf 'oops' >&2" }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).toContain('hello');
    expect(raw).toContain('oops');
    expect(raw).toContain('"type":"terminal_exit"');
    expect(raw).toContain('"code":0');
  });

  it('is refused when the operator turned it off', async () => {
    const response = await jsonRequest('/api/workspace/terminal', {
      method: 'POST',
      body: { command: 'printf hello' },
      headers: { 'x-workspace-ui': '1', 'x-eunoia-token': TOKEN },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('terminal-disabled');
  });
});

describe('cross-origin requests', () => {
  it('refuses a request whose Origin does not match the Host', async () => {
    const response = await api('/api/workspace', {
      headers: { origin: 'https://example.com' },
    });
    expect(response.status).toBe(403);
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
