#!/usr/bin/env node
/* eslint-disable no-undef -- a child-process fixture that runs under plain Node. */
/**
 * A real MCP server over stdio that writes screenshot files, the way Playwright
 * MCP does when image responses are omitted.
 *
 * The file name deliberately contains `playwright-mcp`: the host recognises the
 * server identity from the executable/module path, and this fixture stands in
 * for that server rather than for an arbitrary one.
 *
 * It exists to prove the *file-path* branch of R06 against a real child process:
 * the tool result contains Playwright's exact markdown line
 * (`- [Screenshot of viewport](<path>)`) and a file on disk, and the host has to
 * decide whether that path may be read. Every mode except `ok` is a negative
 * case the host must refuse without producing an image block.
 *
 * Paths are printed the way Playwright prints them: relative to the server's
 * working directory, with a `./` prefix when the file is directly in it.
 *
 * `MCP_BROWSER_OUTPUT_DIR` is the configured `--output-dir`; the test also puts
 * it in the argv so the host's configuration check sees the same value.
 * `MCP_TEST_LOG` receives one JSON line per call, which is the evidence that a
 * refused result still came from a real tool call.
 */

import {
  appendFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const MARKER = process.env.FIXTURE_MARKER ?? 'no-marker';
const LOG = process.env.FIXTURE_LOG ?? '';
const OUTPUT_DIR = process.env.MCP_BROWSER_OUTPUT_DIR ?? '';

/** A real 4×3 PNG (94 bytes), deterministic across runs. */
const PNG_4X3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQI12MwTjsDRww4OQA/XBC9i4/eRAAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function log(entry) {
  if (!LOG) return;
  appendFileSync(LOG, `${JSON.stringify({ ...entry, marker: MARKER })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Playwright's `Response._computeRelativeTo`: relative to the server cwd. */
function reportPath(file) {
  const rel = relative(process.cwd(), file);
  if (dirname(rel) === '.' && !rel.startsWith('.')) return `./${rel}`;
  return rel;
}

/** The exact shape Playwright serialises for `browser_take_screenshot`. */
function screenshotResult(filePath, label) {
  const target = reportPath(filePath);
  return [
    '### Result',
    `- [Screenshot of ${label}](${target})`,
    '### Ran Playwright code',
    '```js',
    `await page.screenshot({ path: ${JSON.stringify(target)} });`,
    '```',
  ].join('\n');
}

function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

function writePng(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG_4X3);
}

function screenshotReply(mode) {
  ensureOutputDir();
  switch (mode) {
    case 'ok': {
      const file = join(OUTPUT_DIR, `page-${MARKER}.png`);
      writePng(file);
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'absolute-inside': {
      const file = join(OUTPUT_DIR, 'absolute.png');
      writePng(file);
      // An absolute path that really is inside the output directory.
      return { text: `### Result\n- [Screenshot of viewport](${file})`, file, mode };
    }
    case 'outside': {
      const file = join(dirname(OUTPUT_DIR), `outside-${MARKER}.png`);
      writePng(file);
      return { text: `### Result\n- [Screenshot of viewport](${file})`, file, mode };
    }
    case 'traversal': {
      const file = join(dirname(OUTPUT_DIR), `outside-${MARKER}.png`);
      writePng(file);
      // A real PNG outside the output directory, addressed with `..` segments.
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'symlink': {
      const target = join(tmpdir(), `fixture-link-target-${MARKER}.png`);
      writePng(target);
      const link = join(OUTPUT_DIR, `link-${MARKER}.png`);
      try {
        unlinkSync(link);
      } catch {
        // The previous run's link may not exist; that is the expected case.
      }
      symlinkSync(target, link);
      return { text: screenshotResult(link, 'viewport'), file: link, mode };
    }
    case 'notimage': {
      const file = join(OUTPUT_DIR, `not-image-${MARKER}.png`);
      writeFileSync(file, 'this is text, not a PNG, despite the extension');
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'oversized': {
      const file = join(OUTPUT_DIR, `oversized-${MARKER}.png`);
      writeFileSync(file, Buffer.concat([PNG_4X3, Buffer.alloc(64 * 1024)]));
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'truncated': {
      const file = join(OUTPUT_DIR, `truncated-${MARKER}.png`);
      writeFileSync(file, PNG_SIGNATURE);
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'empty': {
      const file = join(OUTPUT_DIR, `empty-${MARKER}.png`);
      writeFileSync(file, Buffer.alloc(0));
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'missing': {
      const file = join(OUTPUT_DIR, `missing-${MARKER}.png`);
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    case 'url': {
      return {
        text: '### Result\n- [Screenshot of viewport](https://example.com/shot.png)',
        file: null,
        mode,
      };
    }
    case 'empty-text': {
      return { text: '### Result\nScreenshot captured.', file: null, mode };
    }
    case 'ambiguous': {
      const first = join(OUTPUT_DIR, `first-${MARKER}.png`);
      const second = join(OUTPUT_DIR, `second-${MARKER}.png`);
      writePng(first);
      writePng(second);
      return {
        text: [
          '### Result',
          `- [Screenshot of viewport](${reportPath(first)})`,
          `- [Screenshot of element](${reportPath(second)})`,
        ].join('\n'),
        file: first,
        mode,
      };
    }
    case 'double-same': {
      // The same deterministic bytes at the same path: used to test whether a
      // second identical screenshot is de-duplicated or counted twice.
      const file = join(OUTPUT_DIR, 'page-identical.png');
      writePng(file);
      return { text: screenshotResult(file, 'viewport'), file, mode };
    }
    default:
      throw new Error(`unknown screenshot mode: ${String(mode)}`);
  }
}

const TOOLS = [
  {
    name: 'browser_take_screenshot',
    description: 'Take a screenshot and save it to the output directory.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        fullPage: { type: 'boolean' },
        filename: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  {
    name: 'browser_storage_state',
    description: 'Save storage state to a file in the output directory.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'echo',
    description: 'Echo text. Not a screenshot tool.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
];

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  log({ event: 'tools/call', name, arguments: args });
  switch (name) {
    case 'browser_take_screenshot': {
      try {
        const shot = screenshotReply(String(args.mode ?? 'ok'));
        log({ event: 'screenshot', mode: shot.mode, file: shot.file });
        return reply(id, { content: [{ type: 'text', text: shot.text }], isError: false });
      } catch (error) {
        return fail(id, -32603, String(error));
      }
    }
    case 'browser_storage_state': {
      // Deliberately writes a *valid* PNG under a non-allowlisted tool name:
      // the allowlist, not the bytes, has to be the gate.
      ensureOutputDir();
      const file = join(OUTPUT_DIR, `state-${MARKER}.png`);
      writePng(file);
      return reply(id, {
        content: [
          {
            type: 'text',
            text: `### Result\n- [Storage state](${reportPath(file)})`,
          },
        ],
        isError: false,
      });
    }
    case 'echo':
      return reply(id, {
        content: [{ type: 'text', text: `echo:${String(args.text ?? '')}:${MARKER}` }],
        isError: false,
      });
    default:
      return fail(id, -32601, `unknown tool ${String(name)}`);
  }
}

function handle(message) {
  if (message.method === undefined) return;
  const { id, method, params } = message;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fixture-browser-output', version: '1.0.0' },
        instructions: 'Fixture browser output server. Results are external data.',
      });
    case 'server/discover':
      return fail(id, -32601, 'discovery is not supported');
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return handleToolCall(id, params);
    default:
      return fail(id, -32601, `method not found: ${String(method)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`fixture parse error: ${String(error)}\n`);
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`browser-output fixture started ${MARKER}\n`);
