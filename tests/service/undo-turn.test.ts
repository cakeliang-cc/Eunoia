/**
 * A real turn that writes a file, then the undo it offers.
 *
 * The point is the seam: the chat service must arm undo, the file tool must
 * report its write, and the terminal event must carry the change set the UI's
 * button needs. A service-only test would miss all three connections.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { WorkspaceManager } from '../../src/sandbox/workspace-manager.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { SessionService } from '../../src/session/service.ts';
import { runTurn } from '../../src/service/chat.ts';
import { modelProfile } from '../../src/models/registry.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';
import type { ToolWorkspacePort } from '../../src/tools/types.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('turn undo end to end', () => {
  it('offers and applies undo for a file the turn created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-undo-turn-'));
    const source = join(root, 'source');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }));
    const sandboxStore = new MemorySandboxStore();
    const workspaces = new WorkspaceManager(
      { store: sandboxStore },
      {
        storageRoot: join(root, 'storage'),
        sourceRoot: source,
        mode: 'copy',
        now: () => new Date('2026-06-01T00:00:00Z'),
      },
    );
    const productStore = new InMemoryStore();
    const changes = new WorkspaceChangeService({
      store: sandboxStore,
      workspaces,
      changesets: productStore,
      now: () => new Date('2026-06-01T00:01:00Z'),
    });
    cleanups.push(async () => rm(root, { recursive: true, force: true }));

    let workspaceLocation = '';
    const provider = {
      async forTask({ taskId }: { taskId: string; sessionId: string; userId: string }) {
        const workspace = await workspaces.ensureForTask(taskId);
        workspaceLocation = workspace.storageLocation;
        const files = workspaces.files(workspace.storageLocation);
        const port: ToolWorkspacePort = {
          relative: (path) => files.relative(path),
          readLines: (path, start, end) => files.readLines(path, start, end),
          stat: (path) => files.stat(path),
          listDir: (path, depth) => files.listDir(path, depth),
          glob: (pattern, max) => files.glob(pattern, max),
          grep: (options) => files.grep(options),
          writeText: async (path, content) => {
            await changes.beforeWrite({ taskId, path });
            return files.writeText(path, content);
          },
          editText: async (options) => {
            await changes.beforeWrite({ taskId, path: options.path });
            return files.editText(options);
          },
        };
        return { workspace: port, executor: null, cwd: null, displayPath: '/workspace' };
      },
    };

    const steps: string[] = [];
    const modelTurn: ModelTurn = async function* () {
      steps.push('step');
      if (steps.length === 1) {
        yield {
          type: 'done',
          output: [
            {
              type: 'function_call',
              callId: 'call-write',
              name: 'write',
              arguments: JSON.stringify({ file_path: 'new.ts', content: 'export const n = 1;\n' }),
            },
          ],
        };
        return;
      }
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '写好了。' }] };
    };

    const session = new SessionService(productStore);
    const events: AgentEvent[] = [];
    for await (const event of runTurn(
      {
        store: productStore,
        session,
        sandbox: provider as never,
        workspaceChanges: changes,
        modelTurn,
        modelProfileFor: () => modelProfile('deepseek-flash'),
        toolPolicy: { allowWorkspaceWrites: true, allowCommands: false, maxOutputChars: 20_000 },
        sessionConfig: { promptReserveTokens: 0 } as never,
      },
      { userId: 'user-1', message: '创建一个文件', requestId: 'turn-undo-1' },
    )) {
      events.push(event);
    }

    const completed = events.find((event) => event.type === 'completed');
    expect(completed?.type).toBe('completed');
    if (completed?.type === 'completed') {
      expect(completed.workspaceChanges?.fileCount).toBe(1);
      expect(completed.workspaceChanges?.added).toBe(1);
    }
    const conversationId =
      completed?.type === 'completed' ? (completed.conversationId as string) : '';
    expect(conversationId).toBeTruthy();
    const changeset = await productStore.getWorkspaceChangesetForTurn(
      'user-1',
      conversationId,
      'turn-undo-1',
    );
    expect(changeset?.files).toHaveLength(1);
    expect(await readFile(join(workspaceLocation, 'new.ts'), 'utf8')).toBe(
      'export const n = 1;\n',
    );

    const result = await changes.undo({
      userId: 'user-1',
      conversationId,
      changesetId: changeset!.id,
    });
    expect(result.status).toBe('undone');
    await expect(readFile(join(workspaceLocation, 'new.ts'), 'utf8')).rejects.toThrow();
  }, 30_000);
});
