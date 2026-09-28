/**
 * The build exists, and it produces something that runs.
 *
 * `npm run build` was a command in `package.json` that failed for anyone who
 * tried it, because `tsconfig.build.json` had never been in the repository. That
 * was recorded as a known issue rather than left to be discovered, and this file
 * is the part of the fix that keeps it fixed — a script nothing runs rots, and
 * the way it rots is silent.
 *
 * ## What is checked, and what is not
 *
 * Running the build here would make the offline suite depend on `tsc` and take
 * several seconds, which is the trade `tests/README`-style reasoning in
 * `docs/implementation-plan.md` deliberately refuses. So the build itself is
 * verified by hand and recorded in `CHANGELOG.md`, and what is checked here is
 * the pair of things that can drift back:
 *
 * 1. **The config is there and it emits.** The recorded failure was exactly
 *    "the specified path does not exist", so the file's presence is the
 *    regression to guard. Its `include` is checked too, because a config that
 *    exists and compiles nothing produces an empty `dist/` that starts and then
 *    fails on the first import.
 * 2. **The assets land where the modules look for them.** `tsc` does not emit
 *    the prompt document, and `instructions.ts` resolves it relative to itself,
 *    so the copy is what stands between a successful build and a server that
 *    throws on startup. This is checked against `PROMPT_FILE` — the path the
 *    code actually uses — rather than a hardcoded `dist/...` string, so moving
 *    the prompt moves the expectation with it.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT_DIR, SRC_DIR, planAssets } from '../../scripts/copy-assets.ts';
import { PROMPT_FILE } from '../../src/agent/instructions.ts';
import { PROJECT_ROOT } from '../helpers/sources.ts';

/**
 * `tsconfig.build.json` is JSONC — it carries the reasoning in comments.
 *
 * **Only comments that own their lines are removed**, which is not the general
 * rule for stripping comments and is the right one here. The general
 * block-comment pattern eats the opening of a glob like `src/**` + `/*.ts`,
 * because an empty block comment and the start of a glob are spelled identically
 * up to the closing slash — and the result still parses as JSON, with a silently
 * different `include`. That is not hypothetical: it is what the first version of
 * this function did, and the assertion below is what caught it. These files are
 * written with comments on their own lines, so that is the rule; a comment
 * sharing a line with a value is one this test will not see rather than one it
 * will misread.
 */
function stripJsonComments(source: string): string {
  return source.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
}

const CONFIG = join(PROJECT_ROOT, 'tsconfig.build.json');

/**
 * Where a source-relative path ends up after the build.
 *
 * The build maps `src/` onto `dist/` one-for-one, so the emitted path of a file
 * is its path with the source root swapped for the output root. Expressed as a
 * function of the two constants rather than as a literal, so a change to either
 * has to be a change to both.
 */
function emittedPath(projectRelative: string): string {
  const fromSrc = posix.relative(SRC_DIR, projectRelative.split(sep).join('/'));
  return posix.join(OUT_DIR, fromSrc);
}

/** The repo-relative path of a file URL, or of an absolute path already on disk. */
function projectRelative(file: URL | string): string {
  const absolute = file instanceof URL ? file.pathname : file;
  return relative(PROJECT_ROOT, absolute).split(sep).join('/');
}

describe('the build config', () => {
  it('exists, which is what it did not do', () => {
    expect(existsSync(CONFIG), 'npm run build is `tsc -p tsconfig.build.json`; that file must exist').toBe(true);
  });

  it('emits, and emits `src/`', async () => {
    const config = JSON.parse(stripJsonComments(await readFile(CONFIG, 'utf8'))) as {
      compilerOptions?: Record<string, unknown>;
      include?: string[];
    };

    // The base config sets `noEmit`, which is right for `--noEmit` runs and for
    // every editor, and fatal for a build that inherited it silently.
    expect(config.compilerOptions?.noEmit).not.toBe(true);
    expect(config.compilerOptions?.outDir).toBe(OUT_DIR);
    expect(config.compilerOptions?.rootDir).toBe(SRC_DIR);
    expect(config.include).toEqual([`${SRC_DIR}/**/*.ts`]);
  });

  it('keeps the emitted depth, which the server depends on', () => {
    // `src/api/server.ts` finds the web client with
    // `join(import.meta.dirname, '..', '..', 'web')` — two levels up. That
    // resolves to the repository root from `dist/api/server.js` only because
    // `dist` sits where `src` sits. An outDir of `dist/server` or `build/out`
    // would point at a directory with no `web/` in it, and the failure would be
    // a 404 on the page rather than anything that looks like a build problem.
    const depth = (path: string): number => path.split('/').filter(Boolean).length;
    expect(depth(OUT_DIR)).toBe(depth(SRC_DIR));
  });
});

describe('the assets', () => {
  it('are mapped to the paths the code resolves at runtime', () => {
    const prompt = projectRelative(PROMPT_FILE);
    expect(prompt, 'the prompt document should be under src/').toMatch(/^src\//);

    const planned = planAssets(PROJECT_ROOT).find((asset) => asset.from === prompt);
    // `instructions.ts` reads this file at startup and throws if it is empty.
    // A build without it is a server that starts and dies on the first turn.
    expect(planned?.to).toBe(emittedPath(prompt));
  });

  it('cover every non-TypeScript file under src/', async () => {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.name.endsWith('.ts')) found.push(full);
      }
    };
    await walk(join(PROJECT_ROOT, SRC_DIR));

    const planned = planAssets(PROJECT_ROOT).map((asset) => asset.from);
    expect(found.map(projectRelative).sort()).toEqual(planned);
  });

  it('are found by walking, not by a list someone has to remember', async () => {
    // The falsifier for the check above. If `planAssets` ever becomes a list of
    // known files, it still passes on today's tree and fails the first time
    // someone adds an asset — which is the failure it exists to prevent. So it
    // is fed a tree it has never seen.
    const scratch = await mkdtemp(join(tmpdir(), 'designfree-build-'));
    try {
      await mkdir(join(scratch, 'src', 'deep', 'deeper'), { recursive: true });
      await writeFile(join(scratch, 'src', 'code.ts'), 'export const x = 1;\n');
      await writeFile(join(scratch, 'src', 'deep', 'note.md'), '# hi\n');
      await writeFile(join(scratch, 'src', 'deep', 'deeper', 'table.sql'), 'select 1;\n');

      expect(planAssets(scratch)).toEqual([
        { from: 'src/deep/deeper/table.sql', to: 'dist/deep/deeper/table.sql' },
        { from: 'src/deep/note.md', to: 'dist/deep/note.md' },
      ]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('has something to copy, or the build is a lie', () => {
    // Vacuously true checks are worse than none: `toEqual([])` passes just as
    // happily on a tree with no assets as on a broken walk.
    expect(planAssets(PROJECT_ROOT).length).toBeGreaterThan(0);
  });
});

describe('the script half', () => {
  it('copies only when run, not when imported', async () => {
    // This file imports `planAssets` from a file that is also a program, so the
    // two halves have to be kept apart. If they are not, importing it here means
    // `npm test` writes into `dist/` as a side effect of running — a test suite
    // quietly mutating the working tree, which is worth a check rather than a
    // hope. The check is on the source because that is where the difference is:
    // by the time the import returns, the damage is done and invisible.
    const source = await readFile(join(PROJECT_ROOT, 'scripts', 'copy-assets.ts'), 'utf8');

    expect(source).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    // The falsifier: a bare call at module scope is exactly what the guard is
    // there to prevent, and it is one deleted line away.
    const unguarded = `${source}\nmain();\n`;
    expect(unguarded).toMatch(/^main\(\);$/m);
    expect(source).not.toMatch(/^main\(\);$/m);
  });
});
