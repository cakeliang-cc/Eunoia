/**
 * Print the exact developer-toolkit setup, without installing anything silently.
 *
 * This script prints a copy-pasteable managed Playwright MCP configuration. It never downloads a browser or
 * writes a server config.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const playwright = join(root, 'node_modules', '.bin', 'playwright-mcp');
const cli = join(root, 'node_modules', '.bin', 'typescript-language-server');

const report = {
  playwrightMcp: {
    installed: existsSync(playwright),
    localCli: playwright,
    config: {
      name: 'Playwright',
      transport: 'stdio',
      enabled: false,
      stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' },
      toolPolicy: {
        deny: ['browser_run_code_unsafe', 'browser_file_upload'],
        autoApproveReads: true,
      },
    },
    environment: {
      imageDigest: process.env.EUNOIA_BROWSER_IMAGE_DIGEST?.trim() || null,
      publicDomains: (process.env.EUNOIA_BROWSER_ALLOWED_DOMAINS ?? '').split(',').filter(Boolean),
      hostBrowserRequired: false,
      isolation: 'network:none; per-conversation/member tmpfs; control-pipe proxy',
    },
    requirements: [
      'Build scripts/browser-image/Dockerfile and set EUNOIA_BROWSER_IMAGE_DIGEST to its sha256 ID',
      'Docker reachable; no host Chrome required',
      'Add the server in 外部服务, connect, then enable it for the conversation',
      'Remote/browser-container deployments must use the controlled network policy; --isolated is profile isolation, not network isolation',
    ],
  },
  languageServer: {
    installed: existsSync(cli),
    command: cli,
    note: 'Semantic tools spawn the real typescript-language-server (R10); the compiler LanguageService remains a fallback when no workspace root is available.',
  },
  search: {
    configured: Boolean(process.env.TAVILY_API_KEY?.trim()),
    variable: 'TAVILY_API_KEY',
  },
  docker: {
    note: 'Long-running jobs and previews require SANDBOX_ENABLED=1; preview ingress uses the loopback gateway tunnel, not a published container port.',
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
