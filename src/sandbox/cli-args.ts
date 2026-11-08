/**
 * CLI argument parsing shared by `src/sandbox/cli.ts` and its tests.
 *
 * Kept apart from the command implementation so the conversions can be tested
 * without running a command: importing `cli.ts` would execute the operator
 * entrypoint.
 */

import { SandboxError } from './errors.ts';

/**
 * Convert a `--minutes`-style flag into milliseconds.
 *
 * The default is expressed in the same unit as the flag, so it has to be
 * converted as well: returning it unchanged made a bare `approve` grant 10 ms
 * (the Gateway floors that to 1 s) and made a bare `gc` reap every sandbox idle
 * for more than 60 ms.
 *
 * A value that was supplied but is not a positive number is an operator error,
 * not a request for a different duration; falling back silently would grant
 * whatever the default happens to be. An absent (or blank) flag still uses
 * `fallbackMinutes`, which is also why a fallback of 0 stays 0.
 */
export function minutesToMs(value: string | undefined, fallbackMinutes: number): number {
  if (value === undefined || value.trim() === '') return fallbackMinutes * 60_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SandboxError('invalid_input', `expected a positive number of minutes, got "${value}"`);
  }
  return parsed * 60_000;
}
