/**
 * The undo API over a real socket.
 *
 * The service has its own unit tests; this checks the route's ownership,
 * control-token and response shape, which is what the button actually calls.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { createApp } from '../../src/api/server.ts';

const TOKEN = 'undo-local-token';
let server: Server;
let base: string;
let cookie = '';
let store: InMemoryStore;
let service: WorkspaceChangeService;
let workspaces: WorkspaceManager;
let workspaceLocation = '';
let root = '';

async function api(
  path: string,
  init: RequestInit & { token?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-eunoia-token': TOKEN } : {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (!cookie && setCookie) cookie = setCookie.split(';')[0] as string;
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eunoia-undo-api-'));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.ts'), 'export const a = 1;\n');
  const sandboxStore = new MemorySandboxStore();
  workspaces = new WorkspaceManager(
    { store: sandboxStore },
    {
      storageRoot: join(root, 'storage'),
      sourceRoot: source,
      mode: 'copy',
      now: () => new Date('2026-05-01T00:00:00Z'),
    },
  );
  store = new InMemoryStore();
  service = new WorkspaceChangeService({
    store: sandboxStore,
    workspaces,
    changesets: store,
    now: () => new Date('2026-05-01T00:01:00Z'),
  });
  server = createApp({ store, localToken: TOKEN, workspaceChanges: service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cookie = '';
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function conversationAndChangeset(): Promise<{ conversationId: string; changesetId: string }> {
  const created = await api('/api/conversations', { method: 'POST', body: '{}' });
  const conversationId = created.body.conversation.id as string;
  const userId = decodeURIComponent(cookie.split('=').slice(1).join('='));
  const workspace = await workspaces.ensureForTask(conversationId);
  workspaceLocation = workspace.storageLocation;
  await service.arm({ userId, conversationId, turnId: 'turn-api-1', taskId: conversationId });
  const files = workspaces.files(workspaceLocation);
  await service.beforeWrite({ taskId: conversationId, path: 'a.ts' });
  await files.writeText('a.ts', 'export const a = 2;\n');
  await files.writeText('new.ts', 'export const n = 1;\n');
  const summary = await service.finish({ userId, turnId: 'turn-api-1' });
  if (!summary) throw new Error('no changeset');
  return { conversationId, changesetId: summary.id };
}

describe('undo endpoints', () => {
  it('lists a turn change set and undoes it', async () => {
    const { conversationId, changesetId } = await conversationAndChangeset();

    const list = await api(`/api/conversations/${conversationId}/changes`);
    expect(list.status).toBe(200);
    expect(list.body.changesets).toHaveLength(1);
    expect(list.body.changesets[0].id).toBe(changesetId);
    expect(list.body.changesets[0].fileCount).toBe(2);

    const byTurn = await api(
      `/api/conversations/${conversationId}/changes?turnId=turn-api-1`,
    );
    expect(byTurn.body.changeset.files.map((file: any) => file.path).sort()).toEqual([
      'a.ts',
      'new.ts',
    ]);

    const detail = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.changeset.added).toBe(1);
    expect(detail.body.changeset.modified).toBe(1);

    const undo = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}/undo`,
      { method: 'POST', token: true, body: '{}' },
    );
    expect(undo.status).toBe(200);
    expect(undo.body.status).toBe('undone');
    expect(await readFile(join(workspaceLocation, 'a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    await expect(readFile(join(workspaceLocation, 'new.ts'), 'utf8')).rejects.toThrow();

    const again = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}/undo`,
      { method: 'POST', token: true, body: '{}' },
    );
    expect(again.status).toBe(200);
    expect(again.body.alreadyUndone).toBe(true);
  });

  it('requires the local control token to undo', async () => {
    const { conversationId, changesetId } = await conversationAndChangeset();
    const response = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}/undo`,
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(403);
  });

  it('reports conflicts and only forces them when asked', async () => {
    const { conversationId, changesetId } = await conversationAndChangeset();
    await writeFile(join(workspaceLocation, 'a.ts'), 'human edit\n');

    const conflict = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}/undo`,
      { method: 'POST', token: true, body: '{}' },
    );
    expect(conflict.status).toBe(200);
    expect(conflict.body.status).toBe('partial');
    expect(conflict.body.conflicts.some((entry: any) => entry.path === 'a.ts')).toBe(true);
    expect(await readFile(join(workspaceLocation, 'a.ts'), 'utf8')).toBe('human edit\n');

    const forced = await api(
      `/api/conversations/${conversationId}/changes/${changesetId}/undo`,
      { method: 'POST', token: true, body: JSON.stringify({ force: true }) },
    );
    expect(forced.body.status).toBe('undone');
    expect(await readFile(join(workspaceLocation, 'a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('does not expose another conversation\'s change set', async () => {
    const { changesetId } = await conversationAndChangeset();
    const other = await api('/api/conversations', { method: 'POST', body: '{}' });
    const otherId = other.body.conversation.id as string;
    const response = await api(
      `/api/conversations/${otherId}/changes/${changesetId}/undo`,
      { method: 'POST', token: true, body: '{}' },
    );
    expect(response.status).toBe(404);
  });
});
