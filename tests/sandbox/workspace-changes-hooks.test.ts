/**
 * The sandbox reports mutations to the undo recorder.
 *
 * Without these hooks the change-set diff has no before content: it would see
 * that a file changed but be unable to say what to restore. The hooks must fire
 * before the write and before the command, not after.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestPlatform, prepareTask, TASK, type TestPlatform } from './helpers.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

function context() {
  return {
    taskId: TASK.taskId,
    sessionId: TASK.sessionId,
    userId: TASK.userId,
    toolCallId: 'call-1',
  };
}

describe('undo recorder hooks', () => {
  it('reports a write and an edit before they happen', async () => {
    const platform = await createTestPlatform();
    platforms.push(platform);
    const events: string[] = [];
    platform.gateway.setChangeRecorder({
      beforeWrite: async ({ taskId, path }) => {
        events.push(`write:${taskId}:${path}`);
      },
      beforeCommand: async ({ taskId }) => {
        events.push(`command:${taskId}`);
      },
    });
    await platform.gateway.ensureTask(TASK);

    await platform.gateway.writeFile(context(), 'src/app.ts', 'const answer = 1;\n');
    await platform.gateway.editFile(context(), {
      path: 'src/app.ts',
      oldString: 'answer = 1',
      newString: 'answer = 2',
    });

    expect(events).toEqual([
      'write:task-1:src/app.ts',
      'write:task-1:src/app.ts',
    ]);
  });

  it('takes a checkpoint before the first command of a turn', async () => {
    const platform = await createTestPlatform();
    platforms.push(platform);
    const events: string[] = [];
    platform.gateway.setChangeRecorder({
      beforeWrite: async ({ path }) => {
        events.push(`write:${path}`);
      },
      beforeCommand: async ({ taskId }) => {
        events.push(`command:${taskId}`);
      },
    });
    const { sandboxId } = await prepareTask(platform);

    await platform.gateway.execute(context(), {
      sandboxId,
      executionId: 'exec_undo_1',
      idempotencyKey: 'undo-command-1',
      command: ['echo', 'hi'],
      cwd: '/workspace',
      timeoutMs: 5_000,
    });

    expect(events).toContain('command:task-1');
    expect(events.filter((entry) => entry.startsWith('command:'))).toHaveLength(1);
  });

  it('works without a recorder', async () => {
    const platform = await createTestPlatform();
    platforms.push(platform);
    await platform.gateway.ensureTask(TASK);
    await expect(
      platform.gateway.writeFile(context(), 'src/app.ts', 'still works\n'),
    ).resolves.toMatchObject({ bytes: 12 });
  });
});
