/**
 * R05 — the browser environment diagnosis proves writability and identity
 * instead of assuming that an EPERM is a Chrome bug.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserPaths,
  defaultChromePath,
  diagnoseBrowserEnvironment,
  prepareBrowserDirectories,
} from '../../src/browser/environment.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('R05 — browser environment', () => {
  it('creates 0700 cache/profile/output/download directories and reports them writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-browser-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const paths = browserPaths({ repoRoot: root, env: { EUNOIA_BROWSER_ROOT: join(root, 'browser') } });
    await prepareBrowserDirectories(paths);
    const diagnosis = await diagnoseBrowserEnvironment({
      repoRoot: root,
      env: { EUNOIA_BROWSER_ROOT: join(root, 'browser') },
      chromePath: defaultChromePath(),
    });
    for (const id of ['browser-cache', 'browser-profiles', 'browser-output', 'browser-downloads']) {
      const check = diagnosis.checks.find((entry) => entry.id === id);
      expect(check?.status).toBe('ok');
      expect(check?.writable).toBe(true);
      expect(check?.uid).toBe(process.getuid?.());
      expect((check?.mode ?? 0) & 0o777).toBe(0o700);
    }
    expect(diagnosis.browsersPath).toBe(paths.cache);
  });

  it('reports a non-writable cache with the real path, owner and error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-browser-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const paths = browserPaths({ repoRoot: root, env: { EUNOIA_BROWSER_ROOT: join(root, 'browser') } });
    await prepareBrowserDirectories(paths);
    await chmod(paths.cache, 0o500);
    cleanups.push(async () => chmod(paths.cache, 0o700));
    const diagnosis = await diagnoseBrowserEnvironment({
      repoRoot: root,
      env: { EUNOIA_BROWSER_ROOT: join(root, 'browser') },
    });
    const cache = diagnosis.checks.find((entry) => entry.id === 'browser-cache');
    expect(cache?.status).toBe('blocked');
    expect(cache?.writable).toBe(false);
    expect(cache?.error).toBeTruthy();
    expect(cache?.realpath).toBeTruthy();
  });

  it('does not leak an unrelated credential into the diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-browser-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const paths = browserPaths({ repoRoot: root, env: { EUNOIA_BROWSER_ROOT: join(root, 'browser') } });
    await prepareBrowserDirectories(paths);
    const diagnosis = await diagnoseBrowserEnvironment({
      repoRoot: root,
      env: {
        EUNOIA_BROWSER_ROOT: join(root, 'browser'),
        TAVILY_API_KEY: 'tvly-super-secret',
        DEEPSEEK_API_KEY: 'sk-super-secret',
      },
    });
    const text = JSON.stringify(diagnosis);
    expect(text).not.toContain('tvly-super-secret');
    expect(text).not.toContain('sk-super-secret');
    expect((await stat(paths.output)).isDirectory()).toBe(true);
  });
});
