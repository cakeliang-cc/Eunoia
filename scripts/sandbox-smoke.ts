/**
 * End-to-end sandbox smoke test against the real SQLite store and runtime.
 *
 * `npm test` uses the in-memory store for speed, and the in-memory store does not
 * enforce foreign keys. That gap hid a real startup bug: the workspace row was
 * written before its task, which SQLite rejects with
 * `FOREIGN KEY constraint failed`. This script exercises the production store,
 * the production runtime and a real command in one go.
 *
 * It uses a throwaway SQLite file and destroys the sandbox afterwards; it never
 * touches `data/eunoia.sqlite`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxSettings } from '../src/sandbox/config.ts';
import { createSandboxPlatform } from '../src/sandbox/index.ts';
import { openSqliteStore } from '../src/db/sqlite-store.ts';
import { SqliteSandboxStore } from '../src/sandbox/store-sqlite.ts';

async function main(): Promise<number> {
  const settings = sandboxSettings();
  if (!settings) {
    process.stderr.write('sandbox is not configured; set WORKSPACE_ROOT and SANDBOX_IMAGE_DIGEST\n');
    return 2;
  }

  const dir = await mkdtemp(join(tmpdir(), 'eunoia-smoke-'));
  const sqlite = openSqliteStore(join(dir, 'sandbox.sqlite'));
  const store = new SqliteSandboxStore(sqlite.database);
  const platform = await createSandboxPlatform({
    store,
    settings: {
      ...settings,
      workspace: { ...settings.workspace, storageRoot: join(dir, 'sandboxes') },
    },
  });
  const task = {
    taskId: `smoke-${Date.now()}`,
    sessionId: 'smoke',
    userId: 'smoke',
  };
  try {
    // Use the same adapter the chat turn uses: this covers `forTask` (task →
    // workspace → sandbox), the file port and the command executor.
    const session = await platform.provider.forTask(task);
    const listing = await session.workspace.listDir('.', 1);
    const result = await session.executor.run({
      command: ['/bin/sh', '-c', 'node --version; python3 --version; git --version'],
      timeoutMs: 30_000,
      toolCallId: 'smoke',
    });
    const sandbox = await store.getSandboxForTask(task.taskId);
    process.stdout.write(
      `${JSON.stringify(
        {
          store: 'sqlite',
          task_id: task.taskId,
          sandbox_id: sandbox?.sandboxId ?? null,
          workspace_entries: listing.entries,
          status: result.status,
          exit_code: result.exitCode,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
        null,
        2,
      )}\n`,
    );
    if (sandbox) {
      await platform.gateway
        .destroy({ taskId: task.taskId, userId: task.userId }, sandbox.sandboxId)
        .catch(() => undefined);
    }
    return result.status === 'SUCCEEDED' ? 0 : 1;
  } finally {
    platform.stop();
    sqlite.database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`sandbox smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
