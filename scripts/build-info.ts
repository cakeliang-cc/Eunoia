/**
 * Record the identity of the build the process is about to run.
 *
 * A health check that only says `ok` cannot answer "which commit is actually
 * serving this port". The file is written into `dist/` by the build, so a
 * running process reads the commit that produced its own artifacts.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: root }).trim();
  } catch {
    return 'unknown';
  }
}
const info = {
  commit: process.env.EUNOIA_BUILD_COMMIT?.trim() || git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']).length > 0,
  builtAt: new Date().toISOString(),
  packageVersion: JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(join(root, 'package.json'), 'utf8')),
  ).version as string,
};
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
process.stdout.write(`build info: ${info.commit}${info.dirty ? ' (dirty)' : ''} at ${info.builtAt}\n`);
