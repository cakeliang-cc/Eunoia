/**
 * Build and validate the machine-readable acceptance manifest (R01).
 *
 * The manifest is generated from the *original* requirement tables, so a
 * requirement cannot drift from the document while keeping a green status. The
 * status file only supplies evidence; it cannot rewrite the requirement text.
 *
 *   node --experimental-strip-types scripts/acceptance-manifest.ts --write
 *   node --experimental-strip-types scripts/acceptance-manifest.ts --check
 *
 * `--check` fails on: a missing/duplicate id, a requirement mismatch, a missing
 * evidence path, a PASS without a test command or evidence, or a status word
 * outside the fixed vocabulary. It does not decide whether a test really proves
 * the requirement; that remains a human judgement recorded in the report.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const DEV_DOC = 'docs/plans/eunoia-开发工具补齐实施清单.md';
const TEAM_DOC = 'docs/plans/eunoia-Subagent与AgentTeam实施清单.md';
const GAP_DOC = 'docs/plans/eunoia-联调缺口与受控网络整改清单.md';
const STATUS_FILE = 'docs/features/evidence/integration-acceptance/status.json';
const OUT_FILE = 'docs/features/evidence/integration-acceptance/manifest.json';
const REPORT = 'docs/features/eunoia-联调整改验收报告.md';

export type Status = 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED' | 'TODO';
const STATUSES: readonly Status[] = ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'TODO'];

interface Row {
  readonly id: string;
  readonly title: string;
  readonly requirement: string;
  readonly source: string;
}

interface StatusEntry {
  readonly status?: Status;
  readonly testCommands?: readonly string[];
  readonly evidence?: readonly string[];
  readonly implementationCommit?: string;
  readonly reason?: string;
}

interface ManifestItem extends Row {
  readonly status: Status;
  readonly testCommands: readonly string[];
  readonly evidence: readonly string[];
  readonly implementationCommit: string;
  readonly reason: string;
}

interface StatusFile {
  readonly baselineCommit?: string;
  readonly notes?: string;
  readonly items?: Readonly<Record<string, StatusEntry>>;
}

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** `| D01 | 标题 | 要求 |` — exactly three cells, the first a D/V/T/E/R id. */
function extract(path: string, prefix: string): Row[] {
  const lines = read(path).split('\n');
  const rows: Row[] = [];
  const pattern = new RegExp(`^\\| *(${prefix}\\d{2}) *\\|([^|]*)\\|([^|]*)\\|\\s*$`);
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line);
    if (!match) continue;
    const id = match[1] as string;
    const title = (match[2] ?? '').trim();
    const requirement = (match[3] ?? '').trim();
    rows.push({
      id,
      title,
      requirement,
      source: `${path}#L${index + 1}`,
    });
  }
  return rows;
}

function expectedIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
}

function main(): void {
  const write = process.argv.includes('--write');
  const rows = [
    ...extract(DEV_DOC, 'D'),
    ...extract(DEV_DOC, 'V'),
    ...extract(TEAM_DOC, 'T'),
    ...extract(TEAM_DOC, 'E'),
    ...extract(GAP_DOC, 'R'),
  ];
  const expected = [
    ...expectedIds('D', 64),
    ...expectedIds('V', 8),
    ...expectedIds('T', 60),
    ...expectedIds('E', 6),
    ...expectedIds('R', 14),
  ];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`duplicate id ${row.id}`);
    seen.add(row.id);
  }
  for (const id of expected) {
    if (!seen.has(id)) problems.push(`missing id ${id}`);
  }
  for (const row of rows) {
    if (!expected.includes(row.id)) problems.push(`unexpected id ${row.id}`);
    if (row.requirement.length === 0) problems.push(`${row.id} has no requirement text`);
  }

  const statusFile: StatusFile = existsSync(join(root, STATUS_FILE))
    ? (JSON.parse(read(STATUS_FILE)) as StatusFile)
    : {};
  const items: ManifestItem[] = rows.map((row) => {
    const entry = statusFile.items?.[row.id] ?? {};
    const status = entry.status ?? 'TODO';
    const testCommands = entry.testCommands ?? [];
    const evidence = entry.evidence ?? [];
    const implementationCommit = entry.implementationCommit ?? statusFile.baselineCommit ?? '';
    const reason = entry.reason ?? (status === 'TODO' ? '本次未单独验收' : '');
    if (!STATUSES.includes(status)) problems.push(`${row.id} has unknown status ${String(status)}`);
    for (const command of testCommands) {
      if (command.trim().length === 0) problems.push(`${row.id} has an empty test command`);
    }
    for (const path of evidence) {
      if (!existsSync(join(root, path))) problems.push(`${row.id} evidence path does not exist: ${path}`);
    }
    if (status === 'PASS') {
      if (testCommands.length === 0) problems.push(`${row.id} is PASS without a test command`);
      if (evidence.length === 0) problems.push(`${row.id} is PASS without evidence`);
      if (!/^[0-9a-f]{7,40}$/.test(implementationCommit)) {
        problems.push(`${row.id} is PASS without a real implementation commit`);
      }
    }
    return {
      ...row,
      status,
      testCommands,
      evidence,
      implementationCommit,
      reason,
    };
  });

  const counts = (prefix: string): Record<string, number> => {
    const result: Record<string, number> = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0, TODO: 0 };
    for (const item of items.filter((entry) => entry.id.startsWith(prefix))) {
      result[item.status] = (result[item.status] ?? 0) + 1;
    }
    return result;
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselineCommit: statusFile.baselineCommit ?? null,
    report: REPORT,
    statusVocabulary: STATUSES,
    totals: {
      all: counts(''),
      D: counts('D'),
      V: counts('V'),
      T: counts('T'),
      E: counts('E'),
      R: counts('R'),
    },
    items,
  };

  if (problems.length > 0) {
    process.stderr.write(`acceptance manifest: ${problems.length} problem(s)\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  if (write) {
    writeFileSync(join(root, OUT_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `wrote ${relative(root, join(root, OUT_FILE))}: ${items.length} items\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(manifest.totals, null, 2)}\n`);
}

main();
