/**
 * Print the exact developer-toolkit setup, without installing anything silently.
 *
 * Install, detect and enable are three different steps in the UI/docs; this
 * script reports what is present and prints a copy-pasteable Playwright MCP
 * configuration. It never downloads a browser or writes a server config.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const playwright = join(root, 'node_modules', '.bin', 'playwright-mcp');
const cli = join(root, 'node_modules', '.bin', 'typescript-language-server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
          join(root, 'data', 'browser-output'),
        ],
        runLocation: 'host',
      },
      toolPolicy: {
        deny: ['browser_run_code_unsafe', 'browser_file_upload'],
        autoApproveReads: true,
      },
    },
    requirements: [
      'MCP_ALLOW_HOST_PROCESS=1 (local deployment only)',
      `Chrome installed at ${chrome}`,
      'Add the server in 外部服务, connect, then enable it for the conversation',
    ],
  },
  languageServer: {
    installed: existsSync(cli),
    command: cli,
    note: 'The semantic tools use the project TypeScript language service; the LSP binary is installed for a future adapter and doctor checks.',
  },
  search: {
    configured: Boolean(process.env.TAVILY_API_KEY?.trim()),
    variable: 'TAVILY_API_KEY',
  },
  docker: {
    note: 'Long-running jobs require SANDBOX_ENABLED=1; previews need a published container port.',
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
