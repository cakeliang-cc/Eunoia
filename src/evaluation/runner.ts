/**
 * The evaluation runner (spec §13, §18 Phase 3).
 *
 * Two modes, and the distinction is what makes the suite usable:
 *
 *   - **live** — every case runs against the real model. This is the only mode
 *     that can tell you something new, and it costs a model call per case and
 *     about a minute of wall clock.
 *   - **replay** — the replies recorded from a previous live run are re-scored
 *     against the current checks. Free, instant, and the mode you use while
 *     iterating on the *checks* rather than on the prompt.
 *
 * Replay is deliberately not a way to iterate on the prompt: the recorded
 * replies came from an older prompt, so replaying them after a prompt change
 * measures nothing. `promptVersion` is recorded with each file and a mismatch is
 * reported, so that mistake is visible rather than silent.
 *
 * Each case gets its own user and conversation. That isolation is what makes
 * seeded memories meaningful — a case that seeds "the user's mother is ill"
 * cannot have that leak into the next case's context and quietly green it.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROMPT_VERSION } from '../agent/instructions.ts';
import { COMPANION_MODEL } from '../agent/model-client.ts';
import { log } from '../observability/logging.ts';
import type { Store } from '../memory/store.ts';
import { runTurn } from '../service/chat.ts';
import { EVALUATION_CASES } from './cases.ts';
import { scoreCase } from './scorers.ts';
import type { CaseResult, EvaluationCase, EvaluationRun, EvaluationSummary } from './types.ts';

export const RECORDINGS_DIR = join(process.cwd(), 'evaluation', 'recorded');

/** One case's outcome, in the form that can be written to disk and replayed. */
export interface RecordedTurn {
  readonly caseId: string;
  readonly reply: string;
  readonly toolsCalled: readonly string[];
  readonly riskLevel: 'none' | 'elevated' | 'crisis';
  readonly riskReplaced: boolean;
  readonly error: string | null;
}

export interface Recording {
  readonly promptVersion: string;
  readonly model: string;
  readonly recordedAt: string;
  readonly turns: readonly RecordedTurn[];
}

/**
 * Runs one case and reports what happened.
 *
 * Injectable so that tests can exercise the whole runner — seeding, scoring,
 * persistence, summarising — against a canned executor, with no model call.
 */
export type CaseExecutor = (
  evaluationCase: EvaluationCase,
  context: { store: Store; userId: string; conversationId: string; signal?: AbortSignal },
) => Promise<RecordedTurn>;

export const liveExecutor: CaseExecutor = async (evaluationCase, context) => {
  const events = [];
  try {
    for await (const event of runTurn(
      { store: context.store },
      {
        userId: context.userId,
        conversationId: context.conversationId,
        message: evaluationCase.userMessage,
        // Persisted, so tools that read the conversation work — but under a
        // throwaway user, so nothing here touches a real person's history.
        persist: true,
        signal: context.signal,
      },
    )) {
      events.push(event);
    }
  } catch (error) {
    return {
      caseId: evaluationCase.id,
      reply: '',
      toolsCalled: [],
      riskLevel: 'none',
      riskReplaced: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let reply = '';
  let error: string | null = null;
  let riskLevel: 'none' | 'elevated' | 'crisis' = 'none';
  let riskReplaced = false;
  const toolsCalled: string[] = [];

  for (const event of events) {
    if (event.type === 'completed') reply = event.text;
    else if (event.type === 'error') error = event.message;
    else if (event.type === 'tool_call') toolsCalled.push(event.name);
    else if (event.type === 'safety_notice') {
      riskLevel = event.level;
      if (event.replaced) riskReplaced = true;
    }
  }

  return { caseId: evaluationCase.id, reply, toolsCalled, riskLevel, riskReplaced, error };
};

export interface RunEvaluationOptions {
  readonly store: Store;
  readonly cases?: readonly EvaluationCase[];
  readonly executor?: CaseExecutor;
  readonly signal?: AbortSignal;
  /** When set, results are scored from these turns instead of calling the model. */
  readonly replay?: readonly RecordedTurn[];
  readonly onProgress?: (completed: number, total: number, result: CaseResult) => void;
  /** Skip writing to `evaluation_results`. Used by replay-after-replay runs. */
  readonly persist?: boolean;
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<{
  run: EvaluationRun;
  recording: Recording;
}> {
  const cases = options.cases ?? EVALUATION_CASES;
  const mode: 'live' | 'recorded' = options.replay ? 'recorded' : 'live';
  const executor = options.executor ?? liveExecutor;
  const runId = randomUUID();

  if (options.persist !== false) {
    await options.store.upsertEvaluationCases(
      cases.map((entry) => ({
        id: entry.id,
        category: entry.category,
        title: entry.title,
        userMessage: entry.userMessage,
        expectedBehaviors: entry.expectedBehaviors,
        forbiddenBehaviors: entry.forbiddenBehaviors,
        checks: entry.checks,
      })),
    );
  }

  const replayById = new Map((options.replay ?? []).map((turn) => [turn.caseId, turn]));
  const results: CaseResult[] = [];
  const recorded: RecordedTurn[] = [];
  const liveDuringReplay: string[] = [];

  for (const evaluationCase of cases) {
    const replayed = replayById.get(evaluationCase.id);

    // Filling a gap in the recording beats erroring — it is how a case added
    // after the recording was made gets its first reply. It is also a model
    // call inside a run that calls itself `recorded`, so the case is named on
    // the run rather than left for someone to notice.
    if (replayed === undefined && mode === 'recorded') liveDuringReplay.push(evaluationCase.id);

    const turn =
      replayed ?? (await runCase(options.store, evaluationCase, executor, options.signal));

    recorded.push(turn);

    const result = scoreCase(evaluationCase, {
      reply: turn.reply,
      toolsCalled: turn.toolsCalled,
      riskReplaced: turn.riskReplaced,
      riskLevel: turn.riskLevel,
      error: turn.error,
    });

    results.push(result);
    options.onProgress?.(results.length, cases.length, result);
  }

  const run: EvaluationRun = {
    runId,
    promptVersion: PROMPT_VERSION,
    model: COMPANION_MODEL,
    mode,
    startedAt: new Date(),
    liveDuringReplay,
    results,
    summary: summarise(results),
  };

  if (options.persist !== false) {
    await options.store.saveEvaluationResults(
      results.map((result) => ({
        runId,
        caseId: result.caseId,
        reply: result.reply,
        passed: result.passed,
        score: result.score,
        promptVersion: PROMPT_VERSION,
        model: COMPANION_MODEL,
        mode,
        violations: result.violations,
      })),
    );
  }

  return {
    run,
    recording: {
      promptVersion: PROMPT_VERSION,
      model: COMPANION_MODEL,
      recordedAt: new Date().toISOString(),
      turns: recorded,
    },
  };
}

/** Seed the fixtures, then run the turn. */
async function runCase(
  store: Store,
  evaluationCase: EvaluationCase,
  executor: CaseExecutor,
  signal?: AbortSignal,
): Promise<RecordedTurn> {
  // A throwaway identity per case. Everything the case reads or writes —
  // memories, messages, runs — belongs to it and to nothing else.
  //
  // The id has to be a plain UUID. An earlier version embedded the case id
  // (`eval-solve-01-96c0ea29`) to make cleanup and debugging greppable, which
  // worked everywhere except against Postgres, where `users.id` is `uuid` and
  // the very first insert failed. The in-memory store accepts any string, so no
  // offline test could have caught it — the same blind spot as the missing
  // `installProvider()` call next door. The pairing is logged instead, which is
  // the part that was actually wanted.
  const userId = randomUUID();
  log.debug('evaluation.case_identity', { case_id: evaluationCase.id, user_id: userId });
  await store.ensureUser(userId);

  const conversation = await store.ensureConversation(userId);

  for (const memory of evaluationCase.seedMemories ?? []) {
    await store.createMemory(userId, {
      type: memory.type,
      content: memory.content,
      importance: memory.importance ?? 0.6,
      confidence: memory.confidence ?? 0.8,
      source: memory.source ?? 'user_stated',
    });
  }

  for (const turn of evaluationCase.seedTurns ?? []) {
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: turn.role,
      content: turn.content,
    });
  }

  try {
    return await executor(evaluationCase, { store, userId, conversationId: conversation.id, signal });
  } catch (error) {
    log.error('evaluation.case_failed', {
      case_id: evaluationCase.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      caseId: evaluationCase.id,
      reply: '',
      toolsCalled: [],
      riskLevel: 'none',
      riskReplaced: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarise(results: readonly CaseResult[]): EvaluationSummary {
  const byCategory: Record<string, { total: number; passed: number }> = {};
  let violations = 0;

  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { total: 0, passed: 0 });
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
    violations += result.violations.length;
  }

  const passed = results.filter((result) => result.passed).length;
  const meanScore =
    results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / results.length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    meanScore: Math.round(meanScore * 1000) / 1000,
    violations,
    byCategory,
  };
}

// ------------------------------------------------------------ recordings -----

export async function saveRecording(recording: Recording, dir = RECORDINGS_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = recording.recordedAt.replace(/[:.]/g, '-');
  const path = join(dir, `${recording.promptVersion}-${stamp}.json`);
  await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
  return path;
}

export async function loadRecording(path: string): Promise<Recording> {
  return JSON.parse(await readFile(path, 'utf8')) as Recording;
}

export async function latestRecording(dir = RECORDINGS_DIR): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    return files.length === 0 ? null : join(dir, files[files.length - 1] as string);
  } catch {
    return null;
  }
}
