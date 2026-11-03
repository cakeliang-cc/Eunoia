/**
 * Operator configuration for the front-end workbench.
 *
 * The workbench is deliberately separable from the agent sandbox. It reads the
 * directory a person selected, asks git what changed, and (when enabled) runs a
 * command the person typed. None of that is a model tool call, so none of it is
 * governed by the sandbox's tool policy; the knobs here are the workbench's own
 * exposure controls.
 *
 * Defaults are local-first:
 *
 *   - terminal is on only when the server is bound to loopback;
 *   - the directory picker starts at `$HOME` and may walk the filesystem unless
 *     `WORKSPACE_BROWSE_ROOTS` narrows it;
 *   - file previews use the same ignored/credential rules as the file tools.
 */

import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { envFlag } from '../config.ts';

export interface WorkspaceUiConfig {
  readonly statePath: string;
  readonly terminal: boolean;
  readonly browseRoots: readonly string[];
  readonly browseStart: string;
  readonly allowSensitive: boolean;
  readonly ignore: readonly string[];
  readonly maxFileBytes: number;
  readonly maxListingEntries: number;
  readonly maxGitChanges: number;
  readonly maxDiffBytes: number;
  readonly terminalTimeoutMs: number;
  readonly terminalMaxOutputBytes: number;
  readonly gitTimeoutMs: number;
}

function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function listEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(new RegExp(`[${delimiter === ';' ? ';' : ':'},]`))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Where the chosen root survives a restart. Kept next to the SQLite file. */
export function workspaceUiStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.WORKSPACE_UI_STATE?.trim();
  return explicit && explicit.length > 0
    ? resolve(explicit)
    : join(process.cwd(), 'data', 'workspace-ui.json');
}

/**
 * Whether the workbench terminal is available.
 *
 * Off unless `WORKSPACE_TERMINAL` says otherwise. It used to follow the bind
 * address — "loopback means local, local means a shell" — but a loopback bind
 * does not stop DNS rebinding, so "reachable from this machine" was not the
 * same claim it looked like. The terminal now has to be asked for explicitly,
 * and the route additionally requires the per-process control token.
 */
export function workspaceUiTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.WORKSPACE_TERMINAL);
}

/**
 * `loopback` is retained in the options for callers that already compute it
 * (the server logs it), but it no longer turns the terminal on.
 */
export function workspaceUiConfig(
  options: { readonly loopback: boolean; readonly env?: NodeJS.ProcessEnv } = { loopback: true },
): WorkspaceUiConfig {
  const env = options.env ?? process.env;
  const roots = listEnv(env.WORKSPACE_BROWSE_ROOTS).map((entry) => resolve(entry));
  const home = homedir();
  return {
    statePath: workspaceUiStatePath(env),
    terminal: workspaceUiTerminalEnabled(env),
    browseRoots: roots,
    browseStart: roots[0] ?? home,
    allowSensitive: envFlag(env.WORKSPACE_ALLOW_SENSITIVE),
    ignore: (env.WORKSPACE_IGNORE ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    maxFileBytes: intEnv(env, 'WORKSPACE_MAX_FILE_BYTES', 2 * 1024 * 1024, 4 * 1024, 32 * 1024 * 1024),
    maxListingEntries: intEnv(env, 'WORKSPACE_MAX_ENTRIES', 1_000, 50, 10_000),
    maxGitChanges: intEnv(env, 'WORKSPACE_MAX_GIT_CHANGES', 500, 20, 5_000),
    maxDiffBytes: intEnv(env, 'WORKSPACE_MAX_DIFF_BYTES', 512 * 1024, 4 * 1024, 8 * 1024 * 1024),
    terminalTimeoutMs: intEnv(
      env,
      'WORKSPACE_TERMINAL_TIMEOUT_MS',
      120_000,
      1_000,
      30 * 60_000,
    ),
    terminalMaxOutputBytes: intEnv(
      env,
      'WORKSPACE_TERMINAL_MAX_OUTPUT_BYTES',
      256 * 1024,
      4 * 1024,
      8 * 1024 * 1024,
    ),
    gitTimeoutMs: intEnv(env, 'WORKSPACE_GIT_TIMEOUT_MS', 10_000, 1_000, 120_000),
  };
}
