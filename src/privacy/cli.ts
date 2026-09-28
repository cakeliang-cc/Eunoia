/**
 * `npm run cleanup` — the retention sweep (spec §44).
 *
 * Usage:
 *   npm run cleanup              # delete evaluation users past the window
 *   npm run cleanup -- --dry-run # report what it would delete, change nothing
 *   npm run cleanup -- --all     # ignore the window
 *
 * `--dry-run` exists because the safe way to first run a command that deletes
 * rows is to watch it not delete them, and because the count it prints is the
 * only thing that distinguishes "nothing to clean" from "the sweep is looking in
 * the wrong place". `--all` exists because the window is a race guard rather
 * than a data policy (see `retention.ts`), and there is no race when a person is
 * typing the command.
 */

import { selectStore } from '../db/pool.ts';
import { log } from '../observability/logging.ts';
import { RETENTION_WINDOW_HOURS, sweepEvaluationUsers } from './retention.ts';

interface Args {
  dryRun: boolean;
  all: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  return {
    dryRun: argv.includes('--dry-run'),
    all: argv.includes('--all'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { store, kind, detail } = await selectStore();

  try {
    process.stdout.write(`\nstore: ${kind} · ${detail}\n`);
    const result = await sweepEvaluationUsers(store, {
      dryRun: args.dryRun,
      // `--all` means the window is not applied: every marked user is past
      // whatever cutoff is supplied, so the cutoff is now.
      ...(args.all ? { olderThan: new Date() } : {}),
    });

    const verb = args.dryRun ? 'would delete' : 'deleted';
    process.stdout.write(
      `\nretention · evaluation users\n` +
        `${result.scanned} found · ${verb} ${args.dryRun ? result.scanned : result.deleted}` +
        `${args.all ? ' (window ignored)' : ` · older than ${RETENTION_WINDOW_HOURS}h`}\n\n`,
    );

    if (args.dryRun && result.scanned > 0) {
      process.stdout.write('Nothing was changed. Re-run without --dry-run to delete.\n\n');
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log.error('cleanup.failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
