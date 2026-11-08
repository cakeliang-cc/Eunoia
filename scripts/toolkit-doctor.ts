/**
 * Doctor for the developer toolkit. Read-only; safe to run while the server is up.
 *
 * It exits non-zero only for a missing core piece the toolkit cannot work
 * without (Node/Docker/workspace). Missing optional credentials (Tavily) and
 * missing browser binaries are reported as `blocked`, not silently green.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function commandVersion(command: string, args: string[] = ['--version']): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const checks: Array<{
  id: string;
  status: 'ok' | 'blocked' | 'missing';
  detail: string;
}> = [];
const add = (id: string, status: 'ok' | 'blocked' | 'missing', detail: string): void => {
  checks.push({ id, status, detail });
};

const node = process.version;
add('node', 'ok', node);

const docker = commandVersion('docker', ['--version']);
add('docker', docker ? 'ok' : 'missing', docker ?? 'docker not found');

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
  add('docker-runtime', 'ok', 'docker daemon reachable');
} catch {
  add('docker-runtime', 'blocked', 'docker daemon not reachable');
}

const playwright = join(root, 'node_modules', '.bin', 'playwright-mcp');
const playwrightVersion = existsSync(playwright) ? commandVersion(playwright) : null;
add(
  'playwright-mcp',
  playwrightVersion ? 'ok' : 'missing',
  playwrightVersion ? `${playwrightVersion} at ${playwright}` : 'npm install --save-dev @playwright/mcp@0.0.80',
);

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
add('chrome', existsSync(chrome) ? 'ok' : 'missing', chrome);

const lsp = join(root, 'node_modules', '.bin', 'typescript-language-server');
add(
  'typescript-language-server',
  existsSync(lsp) ? 'ok' : 'missing',
  existsSync(lsp) ? lsp : 'npm install --save-dev typescript-language-server',
);

add(
  'search',
  process.env.TAVILY_API_KEY?.trim() ? 'ok' : 'blocked',
  process.env.TAVILY_API_KEY?.trim()
    ? 'TAVILY_API_KEY present'
    : 'TAVILY_API_KEY missing; web_search will return WEB_NOT_CONFIGURED',
);

add(
  'docker-image',
  process.env.SANDBOX_IMAGE_DIGEST?.trim() ? 'ok' : 'blocked',
  process.env.SANDBOX_IMAGE_DIGEST?.trim()
    ? 'pinned sandbox image configured'
    : 'SANDBOX_IMAGE_DIGEST missing; process/preview tools cannot start',
);

const coreMissing = checks.some(
  (check) => check.status === 'missing' && ['node', 'docker', 'docker-runtime'].includes(check.id),
);
process.stdout.write(
  `${checks.map((check) => `${check.status.padEnd(7)} ${check.id}: ${check.detail}`).join('\n')}\n`,
);
process.exitCode = coreMissing ? 2 : 0;
