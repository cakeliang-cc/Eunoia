/**
 * The CLI's minute-to-millisecond conversion.
 *
 * The regression these cover: the defaults were returned unconverted, so a bare
 * `approve` granted 10 ms and a bare `gc` treated 60 ms of idleness as expiry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { minutesToMs } from '../../src/sandbox/cli-args.ts';
import { SandboxError } from '../../src/sandbox/errors.ts';
import { createTestPlatform, prepareTask, TASK, type TestPlatform } from './helpers.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

describe('minutesToMs', () => {
  it('converts the defaults, not just supplied values', () => {
    // The exact defaults `approve` and `gc` pass when the flag is absent.
    expect(minutesToMs(undefined, 10)).toBe(10 * 60_000);
    expect(minutesToMs(undefined, 60)).toBe(60 * 60_000);
  });

  it('converts a supplied value from minutes', () => {
    expect(minutesToMs('10', 10)).toBe(600_000);
    expect(minutesToMs('0.5', 10)).toBe(30_000);
    expect(minutesToMs(' 90 ', 10)).toBe(90 * 60_000);
  });

  it('leaves an explicit zero default at zero', () => {
    expect(minutesToMs(undefined, 0)).toBe(0);
    expect(minutesToMs('', 0)).toBe(0);
  });

  it('rejects a supplied value that is not a positive number', () => {
    for (const value of ['abc', '0', '-5', 'Infinity', 'NaN', '10m']) {
      expect(() => minutesToMs(value, 10)).toThrow(SandboxError);
    }
  });
});

describe('CLI defaults in the Gateway', () => {
  it('grants ten minutes when approve is called without --minutes', async () => {
    const platform = await createTestPlatform();
    platforms.push(platform);
    await platform.gateway.ensureTask(TASK);
    const grant = await platform.gateway.approve(
      { taskId: TASK.taskId, userId: TASK.userId, sessionId: TASK.sessionId },
      { action: 'fs.write', resourceScope: ['/workspace'], ttlMs: minutesToMs(undefined, 10) },
    );
    const remainingMs = Date.parse(grant.expiresAt) - platform.clock.now().getTime();
    expect(remainingMs).toBe(10 * 60_000);
  });

  it('does not reap a sandbox idle for one second when gc defaults to sixty minutes', async () => {
    const platform = await createTestPlatform();
    platforms.push(platform);
    const { sandboxId } = await prepareTask(platform);
    platform.clock.advance(1_000);
    const result = await platform.gateway.gc({
      idleMs: minutesToMs(undefined, 60),
      checkpointRetentionMs: 0,
    });
    expect(result.expired).toBe(0);
    expect((await platform.store.getSandbox(sandboxId))?.status).toBe('READY');
  });
});
