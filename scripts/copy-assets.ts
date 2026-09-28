/**
 * Copy the files `tsc` does not emit.
 *
 * The build is not only JavaScript. `src/agent/prompts/companion.md` is the
 * system prompt, read at startup and deliberately a document rather than a
 * string in a module (ADR 011). `tsc` has no opinion about `.md` files, so a
 * `dist/` built by `tsc` alone starts and then throws on the first turn —
 * `instructions.ts` resolves the prompt relative to itself, so it looks for
 * `dist/agent/prompts/companion.md` and finds nothing. That is a startup
 * failure rather than a silently empty system message, which is the better of
 * the two ways for it to be wrong, but it is still wrong.
 *
 * **The walk is over the tree rather than over a list of known files.** A list
 * would need updating the first time someone adds an asset, and the failure
 * mode of forgetting is the one above — a build that succeeds and a server that
 * will not start. Walking `src/` means anything new is carried by default.
 *
 * The planning half is exported and pure so `tests/architecture/build.test.ts`
 * can check it against the paths the modules actually resolve at runtime,
 * instead of a build being run to find out.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where the compiled sources go. Mirrors `tsconfig.build.json`'s `outDir`. */
export const OUT_DIR = 'dist';

/** Where the sources come from. Mirrors `tsconfig.build.json`'s `rootDir`. */
export const SRC_DIR = 'src';

export interface Asset {
  /** Path relative to the repository root, e.g. `src/agent/prompts/companion.md`. */
  readonly from: string;
  /** Path relative to the repository root, e.g. `dist/agent/prompts/companion.md`. */
  readonly to: string;
}

/**
 * Every file under `src/` that `tsc` will not produce, paired with where it has
 * to land for the emitted module to find it.
 *
 * `.ts` is the only extension skipped, which is the whole rule: whatever `tsc`
 * emits is its business, and everything else is this function's.
 */
export function planAssets(root: string): Asset[] {
  const sourceRoot = join(root, SRC_DIR);
  if (!existsSync(sourceRoot)) return [];

  const assets: Asset[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.name.endsWith('.ts')) continue;
      // Relative paths are built with `posix` on purpose: the mapping is checked
      // against module specifiers, which are always forward-slashed, so a
      // Windows build should not be the thing that disagrees with the test.
      const from = posix.join(SRC_DIR, relative(sourceRoot, absolute).split(sep).join('/'));
      assets.push({ from, to: posix.join(OUT_DIR, posix.relative(SRC_DIR, from)) });
    }
  };

  walk(sourceRoot);
  return assets.sort((a, b) => a.from.localeCompare(b.from));
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const assets = planAssets(root);

  for (const asset of assets) {
    cpSync(join(root, asset.from), join(root, asset.to), { recursive: true });
  }

  console.log(
    assets.length === 0
      ? 'assets · none to copy'
      : `assets · ${assets.length} copied\n${assets.map((a) => `  ${a.from} → ${a.to}`).join('\n')}`,
  );
}

// Only when run as a script. The test imports `planAssets` from here, and an
// import that also copies files would be a surprise.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
