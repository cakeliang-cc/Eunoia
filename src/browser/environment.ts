/**
 * The browser runtime environment, diagnosed rather than assumed.
 *
 * An EPERM opening a browser cache is not fixed by chmod on a user directory:
 * the diagnosis must record who the process runs as, the real path of the
 * cache/profile, its owner and mode, whether a write actually succeeds, which
 * browser binary is used and which Playwright/MCP versions are installed.
 *
 * The default layout is under the repository's `data/` (gitignored) or an
 * explicit `EUNOIA_BROWSER_ROOT`; nothing here writes outside it.
 */

import { access, mkdir, realpath, stat, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BrowserPaths {
  readonly root: string;
  readonly cache: string;
  readonly profiles: string;
  readonly output: string;
  readonly downloads: string;
}

export interface BrowserDiagnosis {
  readonly process: { readonly uid: number; readonly gid: number; readonly platform: string };
  readonly paths: BrowserPaths;
  readonly browsersPath: string;
  readonly chrome: { readonly path: string; readonly exists: boolean };
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly status: 'ok' | 'blocked' | 'missing';
    readonly detail: string;
    readonly realpath?: string;
    readonly uid?: number;
    readonly gid?: number;
    readonly mode?: number;
    readonly writable?: boolean;
    readonly error?: string;
  }>;
}

export function browserPaths(input: {
  readonly root?: string;
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): BrowserPaths {
  const env = input.env ?? process.env;
  const root = resolve(env.EUNOIA_BROWSER_ROOT?.trim() || join(input.repoRoot, 'data', 'browser'));
  return {
    root,
    cache: join(root, 'cache'),
    profiles: join(root, 'profiles'),
    output: join(root, 'output'),
    downloads: join(root, 'downloads'),
  };
}

/** The Chrome the local Playwright MCP uses by default on macOS. */
export function defaultChromePath(platform = process.platform): string {
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return '/usr/bin/google-chrome';
}

/**
 * Create the dedicated directories. This is an explicit setup action, never a
 * side effect of a model tool call.
 */
export async function prepareBrowserDirectories(paths: BrowserPaths): Promise<void> {
  for (const directory of [paths.cache, paths.profiles, paths.output, paths.downloads]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export async function diagnoseBrowserEnvironment(input: {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly chromePath?: string;
  readonly now?: () => Date;
}): Promise<BrowserDiagnosis> {
  const env = input.env ?? process.env;
  const paths = browserPaths({ repoRoot: input.repoRoot, env });
  const chromePath = input.chromePath ?? defaultChromePath();
  const browsersPath = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || paths.cache;
  const checks: BrowserDiagnosis['checks'][number][] = [];
  for (const [id, directory] of [
    ['browser-cache', paths.cache],
    ['browser-profiles', paths.profiles],
    ['browser-output', paths.output],
    ['browser-downloads', paths.downloads],
  ] as const) {
    checks.push(await inspectDirectory(id, directory));
  }
  checks.push(await inspectDirectory('playwright-browsers', browsersPath));
  let chromeExists = false;
  try {
    await access(chromePath, constants.X_OK);
    chromeExists = true;
  } catch {
    chromeExists = false;
  }
  checks.push({
    id: 'chrome',
    status: chromeExists ? 'ok' : 'missing',
    detail: chromePath,
  });
  return {
    process: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, platform: process.platform },
    paths,
    browsersPath,
    chrome: { path: chromePath, exists: chromeExists },
    checks,
  };
}

async function inspectDirectory(
  id: string,
  directory: string,
): Promise<BrowserDiagnosis['checks'][number]> {
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    return {
      id,
      status: 'missing',
      detail: directory,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!info.isDirectory()) {
    return { id, status: 'blocked', detail: `${directory} is not a directory` };
  }
  let real = directory;
  try {
    real = await realpath(directory);
  } catch {
    // A missing parent is reported below by the write probe.
  }
  const probe = join(real, `.eunoia-write-${process.pid}-${Date.now()}`);
  let writable = false;
  let error: string | undefined;
  try {
    await writeFile(probe, 'probe', { mode: 0o600 });
    await rm(probe, { force: true });
    writable = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    id,
    status: writable ? 'ok' : 'blocked',
    detail: directory,
    realpath: real,
    uid: info.uid,
    gid: info.gid,
    mode: info.mode,
    writable,
    ...(error ? { error } : {}),
  };
}
