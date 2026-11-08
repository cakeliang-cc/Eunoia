/**
 * Print the exact developer-toolkit setup, without installing anything silently.
 *
 * Running this script is the explicit setup step: it creates the dedicated
 * browser cache/profile/output directories (mode 0700) and prints a
 * copy-pasteable Playwright MCP configuration. It never downloads a browser or
 * writes a server config.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserPaths, defaultChromePath, prepareBrowserDirectories } from '../src/browser/environment.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const playwright = join(root, 'node_modules', '.bin', 'playwright-mcp');
const cli = join(root, 'node_modules', '.bin', 'typescript-language-server');
const chrome = defaultChromePath();
const paths = browserPaths({ repoRoot: root });
await prepareBrowserDirectories(paths);

const report = {
  playwrightMcp: {
    installed: existsSync(playwright),
    command: playwright,
    config: {
      name: 'Playwright',
      transport: 'stdio',
      enabled: false,
      stdio: {
        command: playwright,
        args: [
          '--browser',
          'chrome',
          '--headless',
          '--isolated',
          '--output-dir',
          paths.output,
        ],
        runLocation: 'host',
        envRefs: {
          PLAYWRIGHT_BROWSERS_PATH: 'env:PLAYWRIGHT_BROWSERS_PATH',
        },
      },
      toolPolicy: {
        deny: ['browser_run_code_unsafe', 'browser_file_upload'],
        autoApproveReads: true,
      },
    },
    environment: {
      PLAYWRIGHT_BROWSERS_PATH: paths.cache,
      EUNOIA_BROWSER_ROOT: paths.root,
      profiles: paths.profiles,
      output: paths.output,
      downloads: paths.downloads,
      note: 'Each browser instance gets --isolated; its profile is a fresh temporary directory. The cache/output roots are dedicated to Eunoia, not the user profile.',
    },
    requirements: [
      'MCP_ALLOW_HOST_PROCESS=1 (local deployment only)',
      `Chrome installed at ${chrome}`,
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
