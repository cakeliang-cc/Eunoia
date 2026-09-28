/**
 * Rendering an evaluation run for a terminal.
 *
 * Written for the person deciding whether to ship a prompt change, so failures
 * come first and carry the actual reply that failed. A report that only prints
 * "18/24 passed" makes you open the database to find out what went wrong, and a
 * report nobody reads is a report that stops being produced.
 */

import { CATEGORY_LABELS, type CaseResult, type EvaluationRun } from './types.ts';

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function formatCase(result: CaseResult, verbose: boolean): string[] {
  const lines: string[] = [];
  const mark = result.error !== null ? 'ERR' : result.passed ? 'PASS' : 'FAIL';
  const score = result.score.toFixed(2);

  lines.push(`[${mark}] ${result.caseId} (${score}) — ${result.title}`);

  if (result.error !== null) {
    lines.push(`       error: ${result.error}`);
    return lines;
  }

  for (const violation of result.violations) {
    const check = result.checks.find((entry) => entry.id === violation);
    lines.push(`       violation: ${violation}${check?.detail ? ` — ${check.detail}` : ''}`);
  }

  if (result.riskLevel !== 'none') {
    lines.push(`       risk: ${result.riskLevel}`);
  }
  if (result.toolsCalled.length > 0) {
    lines.push(`       tools: ${result.toolsCalled.join(', ')}`);
  }

  if (verbose || !result.passed) {
    const failed = result.checks.filter((check) => !check.passed && check.severity === 'expectation');
    for (const expectation of failed) {
      lines.push(`       missed: ${expectation.id}${expectation.detail ? ` — ${expectation.detail}` : ''}`);
    }
    lines.push(`       reply: ${truncate(result.reply, 160)}`);
  }

  return lines;
}

export function formatReport(
  run: EvaluationRun,
  options: { verbose?: boolean; onlyFailures?: boolean } = {},
): string {
  const lines: string[] = [];
  const { summary } = run;

  lines.push(`evaluation ${run.mode} · prompt ${run.promptVersion} · ${run.model}`);
  lines.push(
    `${summary.passed}/${summary.total} passed · mean score ${summary.meanScore.toFixed(3)} · ` +
      `${summary.violations} violation(s)`,
  );
  lines.push('');

  const failing = run.results.filter((result) => !result.passed);
  const passing = run.results.filter((result) => result.passed);

  if (failing.length > 0) {
    lines.push('--- failures ---', '');
    for (const result of failing) lines.push(...formatCase(result, true), '');
  }

  if (!options.onlyFailures) {
    lines.push('--- everything else ---', '');
    for (const result of passing) lines.push(...formatCase(result, options.verbose ?? false));
    lines.push('');
  }

  lines.push('--- by category ---');
  for (const [category, bucket] of Object.entries(summary.byCategory).sort()) {
    const label = CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
    lines.push(`  ${bucket.passed}/${bucket.total}  ${label} (${category})`);
  }

  return lines.join('\n');
}
