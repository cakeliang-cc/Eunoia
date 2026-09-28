/**
 * `npm run eval` — run the personality evaluation (spec §13).
 *
 * Usage:
 *   npm run eval                    # live, every case, records a replay file
 *   npm run eval -- --replay        # re-score the most recent recording, free
 *   npm run eval -- --case judge-01 # one case
 *   npm run eval -- --category safety
 *   npm run eval -- --no-record     # don't write a recording
 *
 * The recording is written by default because a live run is the expensive thing
 * and its output is the only way to iterate on the checks afterwards for free.
 */

import { installProvider } from '../agent/model-client.ts';
import { selectStore } from '../db/pool.ts';
import { log } from '../observability/logging.ts';
import { installTracing } from '../observability/tracing.ts';
import { EVALUATION_CASES } from './cases.ts';
import { formatReport } from './report.ts';
import { latestRecording, loadRecording, runEvaluation, saveRecording } from './runner.ts';
import type { EvaluationCategory } from './types.ts';

interface Args {
  replay: boolean;
  record: boolean;
  verbose: boolean;
  caseId: string | null;
  category: string | null;
  limit: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    replay: false,
    record: true,
    verbose: false,
    caseId: null,
    category: null,
    limit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--replay') args.replay = true;
    else if (arg === '--no-record') args.record = false;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--case') args.caseId = argv[++i] ?? null;
    else if (arg === '--category') args.category = argv[++i] ?? null;
    else if (arg === '--limit') args.limit = Number(argv[++i] ?? '0') || null;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  /**
   * This CLI is a composition root, like `startServer`.
   *
   * Installing the provider is a process-level act, and it belongs to whoever
   * starts the process rather than to the runner. Without it the SDK falls back
   * to its own default provider, which wants an OpenAI key this runtime does not
   * have — every case failed with "Missing credentials", which read like a
   * configuration mistake and was in fact a missing line here. The runner itself
   * stays provider-agnostic; see the boundary guard in
   * `tests/architecture/boundaries.test.ts`.
   *
   * Tracing is installed for the same reason. `npm run eval` is where reply
   * quality is judged, so it is exactly the run whose spans are worth having.
   */
  installTracing();
  installProvider();

  const { store, kind, detail } = await selectStore();
  process.stdout.write(`store: ${kind} (${detail})\n`);

  try {
    let cases = EVALUATION_CASES;
    if (args.caseId) cases = cases.filter((entry) => entry.id === args.caseId);
    if (args.category) {
      cases = cases.filter((entry) => entry.category === (args.category as EvaluationCategory));
    }
    if (args.limit !== null) cases = cases.slice(0, args.limit);

    if (cases.length === 0) {
      process.stderr.write('no cases matched the filter\n');
      process.exitCode = 1;
      return;
    }

    let replay: Awaited<ReturnType<typeof loadRecording>>['turns'] | undefined;

    if (args.replay) {
      const path = await latestRecording();
      if (!path) {
        process.stderr.write('no recording found; run without --replay first\n');
        process.exitCode = 1;
        return;
      }
      const recording = await loadRecording(path);
      process.stdout.write(`replaying ${path}\n`);
      if (recording.promptVersion !== (await import('../agent/instructions.ts')).PROMPT_VERSION) {
        // Not fatal — useful precisely when you want to see what the old replies
        // score under new checks — but it must not pass silently, because
        // "replay looks fine" is otherwise easy to mistake for "the prompt is
        // fine".
        process.stderr.write(
          `warning: recording was made with prompt ${recording.promptVersion}, ` +
            'not the current prompt. This scores old replies against new checks.\n',
        );
      }
      replay = recording.turns;
    }

    const { run, recording } = await runEvaluation({
      store,
      cases,
      replay,
      onProgress: (completed, total, result) => {
        const mark = result.passed ? '.' : 'F';
        process.stdout.write(`${mark}${completed === total ? ` ${completed}/${total}\n` : ''}`);
      },
    });

    process.stdout.write(`\n${formatReport(run, { verbose: args.verbose })}\n`);

    if (!args.replay && args.record) {
      if (cases.length === EVALUATION_CASES.length) {
        const path = await saveRecording(recording);
        process.stdout.write(`\nrecorded to ${path}\n`);
      } else {
        // `--case` and `--category` are for looking at a few cases, and the
        // recording they produce is not one. `--replay` picks the newest file,
        // so a partial one would silently become the baseline and every case
        // missing from it would run live on the next replay — which is the
        // opposite of what replay is for.
        process.stdout.write(
          `\nnot recorded: ${cases.length} of ${EVALUATION_CASES.length} cases ran. ` +
            'A partial recording would become the baseline `--replay` picks up.\n',
        );
      }
    }

    // Exit non-zero on failure so this can gate a change in CI without parsing
    // the output.
    if (run.summary.failed > 0) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log.error('evaluation.cli_failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
