/**
 * R06: the browser screenshot file adapter's trust boundary.
 *
 * Every case here is about a *decision*, not a rendering: may this tool result
 * name a host file at all, and if it may, is the named file really the one the
 * configuration permits? The filesystem is a spy, so "the host file was not
 * read" is an assertion about calls that did not happen.
 */

import { describe, expect, it } from 'vitest';
import {
  applyBrowserOutput,
  readBrowserScreenshot,
  resolveBrowserServer,
  type BrowserOutputFileStat,
  type BrowserOutputFileSystem,
  type BrowserScreenshotInput,
} from '../../src/mcp/browser-output.ts';
import type { MappedResult } from '../../src/mcp/content.ts';
import type { ImportedToolImage } from '../../src/tools/types.ts';
import {
  BROWSER_PNG_4X3,
  makeBrowserServerConfig,
  rawCallResult,
  screenshotText,
  sha256Of,
} from '../helpers/browser-output.ts';

const CWD = '/work';
const OUT = '/work/output';
const SHOT = '/work/output/shot.png';

interface FakeFile {
  readonly bytes: Uint8Array;
  readonly size?: number;
  mtimeMs?: number;
}

/** A filesystem that records every call, so "not read" is testable. */
class FakeFs implements BrowserOutputFileSystem {
  readonly calls: string[] = [];
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Set<string>();
  /** realpath overrides: a symlink's lexical path → where it really points. */
  readonly aliases = new Map<string, string>();
  /** Runs after a successful read, to simulate a concurrent writer. */
  afterRead: ((path: string) => void) | null = null;

  file(path: string, bytes: Uint8Array = BROWSER_PNG_4X3, extra: { size?: number; mtimeMs?: number } = {}): void {
    this.files.set(path, { bytes, ...extra });
  }

  dir(path: string): void {
    this.dirs.add(path);
  }

  link(path: string, target: string): void {
    this.files.set(path, { bytes: BROWSER_PNG_4X3 });
    this.aliases.set(path, target);
  }

  reads(): string[] {
    return this.calls.filter((call) => call.startsWith('readFile:'));
  }

  async realpath(path: string): Promise<string> {
    this.calls.push(`realpath:${path}`);
    const alias = this.aliases.get(path);
    if (alias !== undefined) return alias;
    if (this.files.has(path) || this.dirs.has(path)) return path;
    throw new Error(`ENOENT: ${path}`);
  }

  async stat(path: string): Promise<BrowserOutputFileStat> {
    this.calls.push(`stat:${path}`);
    const entry = this.files.get(path);
    if (entry) {
      return {
        size: entry.size ?? entry.bytes.length,
        mtimeMs: entry.mtimeMs ?? 1_000,
        isFile: true,
        isDirectory: false,
      };
    }
    if (this.dirs.has(path)) {
      return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
    }
    throw new Error(`ENOENT: ${path}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.calls.push(`readFile:${path}`);
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT: ${path}`);
    this.afterRead?.(path);
    return entry.bytes;
  }
}

function baseFs(): FakeFs {
  const fs = new FakeFs();
  fs.dir(OUT);
  return fs;
}

function playwrightConfig(args: string[] = ['--browser', 'chrome', '--output-dir', OUT]) {
  return makeBrowserServerConfig({
    command: '/opt/app/node_modules/.bin/playwright-mcp',
    args,
    runLocation: 'host',
  });
}

function inputFor(
  overrides: Partial<BrowserScreenshotInput> & { readonly fs: FakeFs },
): BrowserScreenshotInput {
  return {
    config: playwrightConfig(),
    toolName: 'browser_take_screenshot',
    result: rawCallResult([{ type: 'text', text: screenshotText('output/shot.png') }]),
    cwd: CWD,
    actionId: 'action-1',
    connectionGeneration: 3,
    ...overrides,
  };
}

function importedImage(overrides: Partial<ImportedToolImage> = {}): ImportedToolImage {
  return {
    assetId: 'asset-1',
    mediaType: 'image/png',
    width: 4,
    height: 3,
    bytes: BROWSER_PNG_4X3.length,
    name: 'shot.png',
    ...overrides,
  };
}

function mappedText(text: string): MappedResult {
  return {
    result: {
      ok: true,
      output: text,
      content: [{ type: 'text', text }],
      meta: { mcp: { contentBlocks: 1, images: 0, structured: false } },
    },
    task: null,
    diagnostics: [],
  };
}

describe('resolveBrowserServer', () => {
  it('accepts a host Playwright MCP bin with an explicit --output-dir', () => {
    expect(resolveBrowserServer(playwrightConfig(), { cwd: CWD })).toEqual({
      state: 'eligible',
      outputDir: OUT,
      baseDir: CWD,
    });
  });

  it('accepts `node …/@playwright/mcp/cli.js`', () => {
    const config = makeBrowserServerConfig({
      command: process.execPath,
      args: ['/opt/app/node_modules/@playwright/mcp/cli.js', '--output-dir', OUT],
      runLocation: 'host',
    });
    expect(resolveBrowserServer(config, { cwd: CWD }).state).toBe('eligible');
  });

  it('resolves a relative --output-dir against stdio.cwd, as Playwright does', () => {
    const config = makeBrowserServerConfig({
      command: 'playwright-mcp',
      args: ['--output-dir', 'shots'],
      cwd: '/srv/browser',
      runLocation: 'host',
    });
    expect(resolveBrowserServer(config, { cwd: CWD })).toEqual({
      state: 'eligible',
      outputDir: '/srv/browser/shots',
      baseDir: '/srv/browser',
    });
  });

  it('does not treat a directory name containing the marker as the server identity', () => {
    const config = makeBrowserServerConfig({
      command: 'node',
      args: ['server.mjs', '--output-dir', '/tmp/@playwright/mcp'],
      runLocation: 'host',
    });
    expect(resolveBrowserServer(config, { cwd: CWD }).state).toBe('not_browser');
  });

  it('is not eligible without an explicit --output-dir', () => {
    const resolved = resolveBrowserServer(playwrightConfig(['--browser', 'chrome']), { cwd: CWD });
    expect(resolved.state).toBe('missing_output_dir');
  });

  it('refuses duplicate --output-dir rather than guessing', () => {
    const resolved = resolveBrowserServer(
      playwrightConfig(['--output-dir', '/a', '--output-dir', '/b']),
      { cwd: CWD },
    );
    expect(resolved.state).toBe('invalid_output_dir');
  });

  it('refuses a sandbox-run server: the file is inside the container, not here', () => {
    const config = makeBrowserServerConfig({
      command: 'playwright-mcp',
      args: ['--output-dir', OUT],
      runLocation: 'sandbox',
    });
    const resolved = resolveBrowserServer(config, { cwd: CWD });
    expect(resolved.state).toBe('invalid_output_dir');
    expect(resolved.state === 'invalid_output_dir' ? resolved.detail : '').toContain('沙箱');
  });

  it('accepts --output-dir=<path> as well as two argv entries', () => {
    const resolved = resolveBrowserServer(
      playwrightConfig([`--output-dir=${OUT}`]),
      { cwd: CWD },
    );
    expect(resolved.state).toBe('eligible');
  });
});

describe('readBrowserScreenshot applicability', () => {
  it('ignores a tool that is not on the image-file allowlist', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, toolName: 'browser_storage_state' }),
    );
    expect(outcome.state).toBe('not_applicable');
    expect(fs.calls).toEqual([]);
  });

  it('ignores an allowlisted tool name on a server that is not Playwright', async () => {
    const fs = baseFs();
    const config = makeBrowserServerConfig({
      command: 'node',
      args: ['server.mjs'],
      runLocation: 'host',
    });
    const outcome = await readBrowserScreenshot(inputFor({ fs, config }));
    expect(outcome.state).toBe('not_applicable');
    expect(fs.calls).toEqual([]);
  });

  it('ignores a failed call, whose text is not a new screenshot', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: {
          content: [{ type: 'text', text: screenshotText('output/shot.png') }],
          isError: true,
          task: null,
          raw: {},
        },
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.state).toBe('not_applicable');
    expect(fs.calls).toEqual([]);
  });

  it('reports a Playwright server without --output-dir instead of reading anything', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, config: playwrightConfig(['--browser', 'chrome']) }),
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.code).toBe('missing_output_dir');
    expect(outcome.note).toContain('模型没有看到');
    expect(fs.calls).toEqual([]);
  });
});

describe('readBrowserScreenshot negatives', () => {
  it('does not touch the host filesystem when no media store is configured', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(inputFor({ fs }));
    expect(outcome.state).toBe('failed');
    expect(outcome.code).toBe('no_media_store');
    expect(outcome.note).toContain('没有被读取');
    expect(fs.calls).toEqual([]);
    expect(outcome.image).toBeUndefined();
  });

  it('reports a result with no screenshot link', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([{ type: 'text', text: '### Result\nScreenshot captured.' }]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_missing');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses two screenshot links instead of converting one of them', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([
          { type: 'text', text: `${screenshotText('output/a.png')}\n- [Screenshot of element](output/b.png)` },
        ]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_ambiguous');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses a URL in the file field', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([
          { type: 'text', text: screenshotText('https://example.com/shot.png') },
        ]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_invalid');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses an absolute path outside the output directory', async () => {
    const fs = baseFs();
    fs.file('/work/outside.png');
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([
          { type: 'text', text: screenshotText('/work/outside.png') },
        ]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_outside_output_dir');
    expect(fs.reads()).toEqual([]);
    expect(outcome.meta.browser).toMatchObject({ status: 'failed' });
  });

  it('refuses a `..` path that resolves to a real file outside the directory', async () => {
    const fs = baseFs();
    fs.file('/work/outside.png');
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([{ type: 'text', text: screenshotText('../outside.png') }]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_outside_output_dir');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses a symlink inside the output directory that escapes it', async () => {
    const fs = baseFs();
    fs.link('/work/output/link.png', '/work/secret/target.png');
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([{ type: 'text', text: screenshotText('output/link.png') }]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.code).toBe('path_outside_output_dir');
    expect(fs.reads()).toEqual([]);
  });

  it('requires a regular file, not a directory', async () => {
    const fs = baseFs();
    fs.dir(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('not_a_regular_file');
    expect(fs.reads()).toEqual([]);
  });

  it('reports a file that is not there', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('file_missing');
  });

  it('refuses an empty file', async () => {
    const fs = baseFs();
    fs.file(SHOT, Buffer.alloc(0));
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('file_empty');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses an oversized file before reading it', async () => {
    const fs = baseFs();
    fs.file(SHOT, BROWSER_PNG_4X3, { size: 2_048 });
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, maxBytes: 1_024, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('file_too_large');
    expect(fs.reads()).toEqual([]);
  });

  it('refuses bytes that grew past the cap between stat and read', async () => {
    const fs = baseFs();
    fs.file(SHOT, Buffer.concat([BROWSER_PNG_4X3, Buffer.alloc(2_048)]), { size: 100 });
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, maxBytes: 1_024, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('file_too_large');
  });

  it('refuses a file that changed while it was read', async () => {
    const fs = baseFs();
    fs.file(SHOT, BROWSER_PNG_4X3, { mtimeMs: 1_000 });
    fs.afterRead = (path) => {
      const entry = fs.files.get(path);
      if (entry) entry.mtimeMs = 2_000;
    };
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, importImage: async () => importedImage() }),
    );
    expect(outcome.code).toBe('file_changed');
  });

  it('refuses a non-image with a .png extension without importing it', async () => {
    const fs = baseFs();
    fs.file(SHOT, Buffer.from('this is not a png', 'utf8'));
    let imported = 0;
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        importImage: async () => {
          imported += 1;
          return importedImage();
        },
      }),
    );
    expect(outcome.code).toBe('not_an_image');
    expect(imported).toBe(0);
    expect(outcome.note).toContain('扩展名不是证据');
  });

  it('reports a decode failure without leaking the host path into the note', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        importImage: async () => {
          throw new Error(`无法解码 ${SHOT}`);
        },
      }),
    );
    expect(outcome.code).toBe('import_failed');
    expect(outcome.note).toContain('媒体导入失败');
    expect(outcome.note).not.toContain(SHOT);
    expect(outcome.note).toContain('<output>');
  });
});

describe('readBrowserScreenshot positive', () => {
  it('imports the real bytes and appends one tool image after the text', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const seen: { name: string; mediaType: string; hash: string }[] = [];
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        importImage: async ({ name, mediaType, bytes }) => {
          seen.push({ name, mediaType, hash: sha256Of(bytes) });
          return importedImage();
        },
      }),
    );

    expect(outcome.state).toBe('imported');
    expect(seen).toEqual([
      { name: 'shot.png', mediaType: 'image/png', hash: sha256Of(BROWSER_PNG_4X3) },
    ]);
    expect(outcome.image).toEqual({
      type: 'image',
      source: 'tool',
      assetId: 'asset-1',
      mediaType: 'image/png',
      width: 4,
      height: 3,
      bytes: BROWSER_PNG_4X3.length,
      name: 'shot.png',
    });
    expect(outcome.rewrites?.[0]?.from).toBe('- [Screenshot of viewport](output/shot.png)');
    expect(outcome.rewrites?.[0]?.to).toContain('(shot.png)');
    expect(outcome.rewrites?.[0]?.to).toContain('已导入媒体库');
    expect(outcome.rewrites?.[1]).toEqual({ from: 'output/shot.png', to: 'shot.png' });
    // No absolute host path anywhere in the model-facing or internal metadata.
    expect(JSON.stringify(outcome)).not.toContain(OUT);
    expect(outcome.meta.browser).toMatchObject({
      status: 'imported',
      source: 'file',
      tool: 'browser_take_screenshot',
      serverId: 'server-browser-1',
      instanceId: 'server-browser-1#g3',
      action: 'action-1',
      file: 'shot.png',
      outputDirName: 'output',
      scope: 'viewport',
      sha256: sha256Of(BROWSER_PNG_4X3),
    });
  });

  it('records full-page scope from the call arguments', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        arguments: { fullPage: true },
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.meta.browser).toMatchObject({ scope: 'full-page' });
  });

  it('accepts an absolute path that really is inside the output directory', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult([{ type: 'text', text: screenshotText(SHOT) }]),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.state).toBe('imported');
    expect(outcome.meta.browser).toMatchObject({ file: 'shot.png' });
  });

  it('accepts an explicit structuredContent field as the reference', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const outcome = await readBrowserScreenshot(
      inputFor({
        fs,
        result: rawCallResult(
          [{ type: 'text', text: '### Result\nScreenshot saved.' }],
          { filePath: SHOT },
        ),
        importImage: async () => importedImage(),
      }),
    );
    expect(outcome.state).toBe('imported');
    expect(outcome.meta.browser).toMatchObject({ file: 'shot.png' });
  });
});

describe('applyBrowserOutput', () => {
  it('appends the image block after the text and rewrites the host path away', async () => {
    const fs = baseFs();
    fs.file(SHOT);
    const text = screenshotText('output/shot.png');
    const outcome = await readBrowserScreenshot(
      inputFor({ fs, importImage: async () => importedImage() }),
    );
    const applied = applyBrowserOutput(mappedText(text), outcome);

    expect(applied.result.content?.map((block) => block.type)).toEqual(['text', 'image']);
    expect(applied.result.content?.[1]).toMatchObject({ type: 'image', source: 'tool' });
    expect(applied.result.output).not.toContain('output/shot.png');
    expect(applied.result.output).toContain('已导入媒体库');
    expect(applied.result.output).not.toContain(OUT);
    expect(applied.result.meta?.mcp).toMatchObject({ images: 1, contentBlocks: 2 });
    expect(applied.result.meta?.browser).toMatchObject({ status: 'imported' });
  });

  it('appends one explicit note and no image when the adapter failed', async () => {
    const fs = baseFs();
    const outcome = await readBrowserScreenshot(inputFor({ fs }));
    const text = screenshotText('output/shot.png');
    const applied = applyBrowserOutput(mappedText(text), outcome);

    expect(applied.result.content?.map((block) => block.type)).toEqual(['text', 'text']);
    expect(applied.result.output.endsWith(outcome.note ?? '')).toBe(true);
    expect(applied.result.meta?.mcp).toMatchObject({ images: 0 });
    expect((applied.result.meta?.mcpDiagnostics as string[]).length).toBe(1);
    expect(applied.result.meta?.browser).toMatchObject({ status: 'failed', code: 'no_media_store' });
  });

  it('changes nothing when the adapter does not apply', () => {
    const mapped = mappedText('### Result\n- [Storage state](./state.json)');
    expect(applyBrowserOutput(mapped, { state: 'not_applicable', diagnostics: [], meta: {} })).toBe(
      mapped,
    );
  });
});
