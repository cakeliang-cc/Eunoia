/**
 * Browser screenshots whose MCP result is a **file path**, not image bytes.
 *
 * Playwright MCP writes a screenshot into its `--output-dir` and, when image
 * responses are omitted (or a `filename` is supplied), the tool result carries
 * only a text line pointing at that file. Turning that line into pixels is the
 * one place in this host where a tool result names a host path, so the rules are
 * deliberately narrow:
 *
 *   - **Only an allowlisted tool.** `browser_take_screenshot` is the only tool
 *     whose result this module reads. `browser_snapshot` returns an ARIA tree
 *     and `browser_pdf` returns a PDF; neither is an image, so neither is here.
 *   - **Only a configured browser server.** The stdio configuration must name a
 *     Playwright MCP entry point, run on the host (a sandboxed server writes
 *     inside its container, where this process cannot read) and pass an explicit
 *     `--output-dir`. Without all three the result is left alone and reported.
 *   - **Only a path the server put in a known field.** The reference is read
 *     from `structuredContent.filePath|outputPath|path` or from the exact
 *     Playwright markdown line `- [Screenshot of …](<path>)`. There is no regex
 *     scan over arbitrary prose: a sentence that mentions `/etc/passwd` is text.
 *   - **Containment twice.** The reported path is resolved the way Playwright
 *     resolves it (against the server's working directory), then checked
 *     lexically *and* after `realpath` against the real output directory. `..`,
 *     absolute paths outside and symlinks that escape are refused.
 *   - **Bytes, not claims.** The file must be a regular file, non-empty, under
 *     the byte cap, unchanged during the read, and its leading bytes must be a
 *     PNG/JPEG/WebP signature. The media import callback still decodes it for
 *     real; a file named `.png` that is not an image never becomes an asset.
 *
 * Nothing here writes or lists directories, and no absolute path reaches the
 * model: the text line is rewritten to the path relative to the output directory
 * and the image arrives as the same ordered `ToolContentBlock` an inline MCP
 * image would produce (`text` first, then `image`).
 *
 * See docs/plans/eunoia-联调缺口与受控网络整改清单.md §16 (R06) and
 * docs/plans/eunoia-开发工具补齐实施清单.md §5.2.
 */

import { createHash } from 'node:crypto';
import {
  readFile as readFileFromDisk,
  realpath as realpathFromDisk,
  stat as statFromDisk,
} from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ImportedToolImage, ToolContentBlock } from '../tools/types.ts';
import type { RawCallResult } from './client.ts';
import type { MappedResult } from './content.ts';
import type { McpServerConfig, McpStdioConfig } from './types.ts';

/** The only tool names whose file reference this module will read. */
export const BROWSER_IMAGE_TOOLS: readonly string[] = ['browser_take_screenshot'];

/**
 * Default byte cap for a screenshot file.
 *
 * It matches `DEFAULT_MEDIA_LIMITS.maxImageBytes`; the runtime passes the
 * media service's actual limit, so a stricter deployment is respected before a
 * single byte is read. The media import callback checks it again after reading.
 */
export const MAX_BROWSER_OUTPUT_BYTES = 10 * 1024 * 1024;

const MAX_PATH_CHARS = 4_096;

/**
 * How a Playwright MCP entry point appears in `command`/first argument.
 *
 * Only the command and the first argument are inspected on purpose: an output
 * directory, a profile path or a user-supplied value must not be able to make an
 * unrelated server look like a browser server. The three spellings cover the
 * published bin (`playwright-mcp`), `node …/@playwright/mcp/cli.js` and
 * `npx @playwright/mcp@…`.
 */
const BROWSER_SERVER_MARKERS = ['@playwright/mcp', 'playwright-mcp', 'mcp-server-playwright'] as const;

/** Playwright's screenshot result line, produced by `Response.resolveClientFile`. */
const SCREENSHOT_LINK = /^- \[Screenshot of [^\]\n]{1,200}\]\(([^()\n]{1,4096})\)$/;

export type BrowserOutputFailureCode =
  | 'missing_output_dir'
  | 'invalid_output_dir'
  | 'sandbox_output_dir'
  | 'path_missing'
  | 'path_ambiguous'
  | 'path_invalid'
  | 'path_outside_output_dir'
  | 'output_dir_missing'
  | 'file_missing'
  | 'not_a_regular_file'
  | 'file_empty'
  | 'file_too_large'
  | 'file_changed'
  | 'not_an_image'
  | 'no_media_store'
  | 'import_failed';

export type BrowserServerEligibility =
  | {
      readonly state: 'eligible';
      /** Absolute, resolved the way Playwright resolves `--output-dir`. */
      readonly outputDir: string;
      /** The server's working directory: Playwright prints paths relative to it. */
      readonly baseDir: string;
    }
  | { readonly state: 'not_browser' }
  | { readonly state: 'missing_output_dir'; readonly detail: string }
  | { readonly state: 'invalid_output_dir'; readonly detail: string };

/** The filesystem surface this module needs, injectable for tests. */
export interface BrowserOutputFileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface BrowserOutputFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<BrowserOutputFileStat>;
  readFile(path: string): Promise<Uint8Array>;
}

export const NODE_BROWSER_OUTPUT_FS: BrowserOutputFileSystem = {
  realpath: (path) => realpathFromDisk(path),
  stat: async (path) => {
    const stats = await statFromDisk(path);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  },
  readFile: (path) => readFileFromDisk(path),
};

/** Production defaults and the test seam for the file adapter. */
export interface BrowserOutputOptions {
  readonly maxBytes?: number;
  readonly cwd?: string;
  readonly fs?: BrowserOutputFileSystem;
}

export interface BrowserScreenshotInput {
  readonly config: McpServerConfig;
  /** The original (un-namespaced) tool name, as the server declared it. */
  readonly toolName: string;
  readonly result: RawCallResult;
  /** Arguments of this call. Used for screenshot-scope metadata only. */
  readonly arguments?: Record<string, unknown>;
  /** Absent means "no media store": the file is not read at all. */
  readonly importImage?: (input: {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }) => Promise<ImportedToolImage>;
  readonly actionId?: string;
  /** The live connection generation, for the asset's instance metadata. */
  readonly connectionGeneration?: number | null;
  readonly maxBytes?: number;
  /** The process working directory, used when `stdio.cwd` is absent. */
  readonly cwd?: string;
  readonly fs?: BrowserOutputFileSystem;
}

export interface BrowserOutputOutcome {
  readonly state: 'not_applicable' | 'imported' | 'failed';
  readonly code?: BrowserOutputFailureCode;
  /** The ordered image block to append after the text block. */
  readonly image?: Extract<ToolContentBlock, { type: 'image' }>;
  /**
   * Exact strings to replace, in order, with sanitised replacements.
   *
   * The first entry is the matched reference itself; the second (when the
   * reference was spelled in text) removes any remaining copy of the same path
   * from the result — for example Playwright's echoed `page.screenshot({ path })`
   * line. Both `from` values come from the reference we already validated, not
   * from a scan for paths.
   */
  readonly rewrites?: readonly { readonly from: string; readonly to: string }[];
  /** One model-facing sentence when the adapter owned the result and failed. */
  readonly note?: string;
  readonly diagnostics: readonly string[];
  /** Internal metadata; `browser` never contains an absolute host path. */
  readonly meta: { readonly browser?: Record<string, unknown> };
}

const NOT_APPLICABLE: BrowserOutputOutcome = { state: 'not_applicable', diagnostics: [], meta: {} };

/**
 * Decide whether the *configuration* is a host-run Playwright MCP server with an
 * explicit output directory. A tool named `browser_take_screenshot` on any other
 * server is not eligible, and saying so is not a failure.
 */
export function resolveBrowserServer(
  config: McpServerConfig,
  options: { readonly cwd?: string } = {},
): BrowserServerEligibility {
  const stdio = config.stdio;
  if (config.transport !== 'stdio' || !stdio) return { state: 'not_browser' };
  if (!isBrowserServer(stdio)) return { state: 'not_browser' };

  const parsed = outputDirArgument(stdio.args);
  if (parsed.state === 'missing') {
    return {
      state: 'missing_output_dir',
      detail: '这个浏览器服务没有配置 --output-dir，截图文件路径不会被当作图片来源',
    };
  }
  if (parsed.state === 'ambiguous') {
    return { state: 'invalid_output_dir', detail: '--output-dir 出现了多次，拒绝猜测该读哪个目录' };
  }
  const value = parsed.value;
  if (value.trim().length === 0) {
    return { state: 'invalid_output_dir', detail: '--output-dir 的值为空' };
  }
  if (value.includes('\0')) {
    return { state: 'invalid_output_dir', detail: '--output-dir 含有非法字符' };
  }
  if (stdio.runLocation !== 'host') {
    // A sandbox writes into its own container; the host path is not the file.
    return {
      state: 'invalid_output_dir',
      detail: '沙箱运行的浏览器把截图写在容器内，宿主无法用这个路径读取，未导入',
    };
  }
  const baseDir = resolve(stdio.cwd ?? options.cwd ?? process.cwd());
  return { state: 'eligible', outputDir: resolve(baseDir, value), baseDir };
}

function isBrowserServer(stdio: McpStdioConfig): boolean {
  // The executable plus the module/package it runs: `playwright-mcp`,
  // `node …/@playwright/mcp/cli.js`, `npx @playwright/mcp@…`. Values of flags
  // (`--output-dir`, `--user-data-dir`) are deliberately not inspected, so a
  // directory name cannot make an unrelated server look like a browser server.
  const tokens = [stdio.command];
  for (const arg of stdio.args) {
    if (arg.startsWith('-')) break;
    tokens.push(arg);
  }
  return tokens.some((token) => BROWSER_SERVER_MARKERS.some((marker) => token.includes(marker)));
}

function outputDirArgument(
  args: readonly string[],
): { state: 'missing' } | { state: 'ambiguous' } | { state: 'found'; value: string } {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--output-dir') {
      const next = args[index + 1];
      if (next !== undefined) values.push(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--output-dir=')) values.push(arg.slice('--output-dir='.length));
  }
  if (values.length === 0) return { state: 'missing' };
  if (values.length > 1) return { state: 'ambiguous' };
  return { state: 'found', value: values[0] as string };
}

/**
 * Read the trusted file reference and import it as a tool image.
 *
 * The outcome is always safe to merge: `imported` appends one image block after
 * the text, `failed` appends one explicit note, and `not_applicable` changes
 * nothing at all.
 */
export async function readBrowserScreenshot(
  input: BrowserScreenshotInput,
): Promise<BrowserOutputOutcome> {
  if (!BROWSER_IMAGE_TOOLS.includes(input.toolName)) return NOT_APPLICABLE;
  // A failed call produced no new file. Any path in its error text is stale or
  // untrusted, and the error itself is the explanation the model needs.
  if (input.result.isError) return NOT_APPLICABLE;

  const baseMeta = {
    serverId: input.config.id,
    serverName: input.config.name,
    instanceId: `${input.config.id}#g${String(input.connectionGeneration ?? 0)}`,
    ...(input.connectionGeneration !== undefined && input.connectionGeneration !== null
      ? { connectionGeneration: input.connectionGeneration }
      : {}),
    tool: input.toolName,
    action: input.actionId ?? null,
  };

  const eligibility = resolveBrowserServer(input.config, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (eligibility.state === 'not_browser') return NOT_APPLICABLE;
  if (eligibility.state !== 'eligible') {
    return failure(
      eligibility.state === 'missing_output_dir' ? 'missing_output_dir' : 'invalid_output_dir',
      eligibility.detail,
      baseMeta,
    );
  }

  const reference = findReference(input.toolName, input.result);
  if (!reference.ok) return failure(reference.code, reference.detail, baseMeta);

  // No media store means no reason to touch the host filesystem at all.
  if (!input.importImage) {
    return failure(
      'no_media_store',
      '本进程没有配置媒体存储，截图的宿主文件没有被读取',
      baseMeta,
    );
  }

  const fs = input.fs ?? NODE_BROWSER_OUTPUT_FS;
  const maxBytes = input.maxBytes ?? MAX_BROWSER_OUTPUT_BYTES;
  const { outputDir, baseDir } = eligibility;

  let dirReal: string;
  let dirStat: BrowserOutputFileStat;
  try {
    dirReal = await fs.realpath(outputDir);
    dirStat = await fs.stat(dirReal);
  } catch {
    // The error message would contain the host path; do not copy it into text.
    return failure('output_dir_missing', '浏览器输出目录不存在或不可访问', baseMeta);
  }
  if (!dirStat.isDirectory) {
    return failure('output_dir_missing', '浏览器输出目录不是一个目录', baseMeta);
  }

  const lexical = isAbsolute(reference.target)
    ? resolve(reference.target)
    : resolve(baseDir, reference.target);
  if (relativeInside(resolve(outputDir), lexical) === null) {
    return failure(
      'path_outside_output_dir',
      '截图路径不在 --output-dir 里（拒绝了目录外或含 .. 的路径）',
      baseMeta,
    );
  }

  let canonical: string;
  try {
    canonical = await fs.realpath(lexical);
  } catch {
    return failure('file_missing', '截图文件不存在', baseMeta);
  }
  const relPath = relativeInside(dirReal, canonical);
  if (relPath === null) {
    return failure(
      'path_outside_output_dir',
      '截图路径经符号链接解析后不在 --output-dir 里',
      baseMeta,
    );
  }

  let before: BrowserOutputFileStat;
  try {
    before = await fs.stat(canonical);
  } catch {
    return failure('file_missing', '截图文件无法读取', baseMeta);
  }
  if (!before.isFile) {
    return failure('not_a_regular_file', '截图路径不是一个普通文件', baseMeta);
  }
  if (before.size === 0) {
    return failure('file_empty', '截图文件是空的', baseMeta);
  }
  if (before.size > maxBytes) {
    return failure(
      'file_too_large',
      `截图 ${String(before.size)} 字节，超过 ${String(maxBytes)} 字节上限`,
      baseMeta,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(canonical);
  } catch {
    return failure('file_missing', '截图文件读取失败', baseMeta);
  }
  if (bytes.length === 0) return failure('file_empty', '截图文件是空的', baseMeta);
  if (bytes.length > maxBytes) {
    return failure(
      'file_too_large',
      `截图 ${String(bytes.length)} 字节，超过 ${String(maxBytes)} 字节上限`,
      baseMeta,
    );
  }

  // The file was written by another process; read what was hashed, not whatever
  // it became while it was being read.
  let after: BrowserOutputFileStat;
  try {
    after = await fs.stat(canonical);
  } catch {
    return failure('file_missing', '截图文件在读取后消失', baseMeta);
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) {
    return failure('file_changed', '截图文件在读取过程中发生了变化，已拒绝导入', baseMeta);
  }

  const mediaType = sniffImage(bytes);
  if (mediaType === null) {
    return failure(
      'not_an_image',
      '截图文件的字节不是 PNG/JPEG/WebP 图片（扩展名不是证据）',
      baseMeta,
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let imported: ImportedToolImage;
  try {
    imported = await input.importImage({
      name: safeFileName(canonical),
      mediaType,
      bytes,
    });
  } catch (error) {
    return failure(
      'import_failed',
      `媒体导入失败：${scrubPaths(errorMessage(error), [outputDir, dirReal, canonical])}`,
      baseMeta,
    );
  }

  const scope = screenshotScope(input.arguments);
  const replacement =
    reference.source === 'line'
      ? `- [${reference.label}](${relPath}) — 已导入媒体库（${String(imported.width)}×${String(imported.height)}），模型以图片查看`
      : relPath;
  const rewrites =
    reference.source === 'line' && reference.target !== reference.rewriteFrom
      ? [
          { from: reference.rewriteFrom, to: replacement },
          { from: reference.target, to: relPath },
        ]
      : [{ from: reference.rewriteFrom, to: replacement }];
  const image: Extract<ToolContentBlock, { type: 'image' }> = {
    type: 'image',
    source: 'tool',
    assetId: imported.assetId,
    mediaType: imported.mediaType,
    width: imported.width,
    height: imported.height,
    bytes: imported.bytes,
    name: imported.name,
  };
  return {
    state: 'imported',
    image,
    rewrites,
    diagnostics: [],
    meta: {
      browser: {
        ...baseMeta,
        status: 'imported',
        source: 'file',
        file: relPath,
        outputDirName: basename(dirReal),
        scope,
        mediaType: imported.mediaType,
        width: imported.width,
        height: imported.height,
        bytes: imported.bytes,
        sha256,
      },
    },
  };
}

/**
 * Merge an outcome into a mapped result.
 *
 * Block order is the contract: the server's text stays where it was, the image
 * block is appended after it, and a failure note is appended as text. The text
 * projection is rewritten in the same pass so history never shows an absolute
 * host path that the blocks no longer contain.
 */
export function applyBrowserOutput(
  mapped: MappedResult,
  outcome: BrowserOutputOutcome,
): MappedResult {
  if (outcome.state === 'not_applicable') return mapped;

  const blocks: ToolContentBlock[] = [...(mapped.result.content ?? [])];
  let output = mapped.result.output;

  for (const rewrite of outcome.rewrites ?? []) {
    if (rewrite.from.length === 0) continue;
    output = output.split(rewrite.from).join(rewrite.to);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block && block.type === 'text') {
        blocks[index] = { type: 'text', text: block.text.split(rewrite.from).join(rewrite.to) };
      }
    }
  }
  if (outcome.image) blocks.push(outcome.image);
  if (outcome.note) {
    output = output.length > 0 ? `${output}\n${outcome.note}` : outcome.note;
    blocks.push({ type: 'text', text: outcome.note });
  }

  const diagnostics = [
    ...stringList(mapped.result.meta?.mcpDiagnostics),
    ...outcome.diagnostics,
  ];
  const images = blocks.filter((block) => block.type === 'image').length;
  const priorMcp = isRecord(mapped.result.meta?.mcp) ? mapped.result.meta.mcp : {};
  return {
    ...mapped,
    result: {
      ...mapped.result,
      output,
      ...(blocks.length > 0 ? { content: blocks } : {}),
      meta: {
        ...mapped.result.meta,
        ...(diagnostics.length > 0 ? { mcpDiagnostics: diagnostics } : {}),
        ...(outcome.meta.browser ? { browser: outcome.meta.browser } : {}),
        mcp: {
          ...priorMcp,
          contentBlocks: blocks.length,
          images,
        },
      },
    },
  };
}

// ------------------------------------------------------------- reference ---

type ReferenceResult =
  | {
      readonly ok: true;
      readonly target: string;
      /** 'line' means the whole markdown line is replaced; 'field' means the path. */
      readonly source: 'line' | 'field';
      readonly rewriteFrom: string;
      readonly label: string;
    }
  | {
      readonly ok: false;
      readonly code: BrowserOutputFailureCode;
      readonly detail: string;
    };

/**
 * Read the reference from a known field only.
 *
 * `structuredContent` is checked first because it is an explicit field. The text
 * form must be exactly Playwright's own screenshot line; a path mentioned in a
 * page's prose is not a reference and is never opened.
 */
function findReference(toolName: string, result: RawCallResult): ReferenceResult {
  const structured = structuredTarget(result.structuredContent);
  if (structured !== null) {
    const valid = validateTarget(structured);
    if (!valid.ok) return valid;
    return {
      ok: true,
      target: structured,
      source: 'field',
      rewriteFrom: structured,
      label: 'Screenshot',
    };
  }

  const matches: { target: string; line: string }[] = [];
  for (const block of result.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    for (const rawLine of block.text.split('\n')) {
      const line = rawLine.trimEnd();
      const match = SCREENSHOT_LINK.exec(line);
      const target = match?.[1];
      if (!target) continue;
      matches.push({ target, line });
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'path_missing',
      detail: `${toolName} 的结果里没有 Playwright 的 “Screenshot of …” 文件链接`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'path_ambiguous',
      detail: `${toolName} 的结果里有多个截图链接，拒绝猜测该导入哪一个`,
    };
  }
  const only = matches[0] as { target: string; line: string };
  const valid = validateTarget(only.target);
  if (!valid.ok) return valid;
  const title = /^- \[(Screenshot of [^\]\n]{0,200})\]\(/.exec(only.line)?.[1];
  return {
    ok: true,
    target: only.target,
    source: 'line',
    rewriteFrom: only.line,
    label: title ?? 'Screenshot',
  };
}

function structuredTarget(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ['filePath', 'outputPath', 'path']) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
  }
  return null;
}

function validateTarget(target: string): ReferenceResult {
  if (target.length === 0 || target.length > MAX_PATH_CHARS) {
    return { ok: false, code: 'path_invalid', detail: '截图路径长度不合法' };
  }
  if (hasControlCharacter(target)) {
    return { ok: false, code: 'path_invalid', detail: '截图路径含有控制字符' };
  }
  if (/^(?:https?|data|blob|about|file):/i.test(target)) {
    return {
      ok: false,
      code: 'path_invalid',
      detail: '结果里是 URL/URI，不是输出目录里的本地文件路径',
    };
  }
  return {
    ok: true,
    target,
    source: 'field',
    rewriteFrom: target,
    label: 'Screenshot',
  };
}

// ----------------------------------------------------------------- utils ---

function failure(
  code: BrowserOutputFailureCode,
  detail: string,
  baseMeta: Record<string, unknown>,
): BrowserOutputOutcome {
  const note = `[浏览器截图没有进入媒体库：${detail}；模型没有看到这张截图，不能据此给出视觉结论。]`;
  return {
    state: 'failed',
    code,
    note,
    diagnostics: [note],
    meta: { browser: { ...baseMeta, status: 'failed', code, detail } },
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `null` when `candidate` is not strictly inside `directory`. */
function relativeInside(directory: string, candidate: string): string | null {
  const rel = relative(directory, candidate);
  if (rel.length === 0) return null;
  if (isAbsolute(rel)) return null;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let text = '';
  for (let index = offset; index < offset + length; index += 1) {
    text += String.fromCharCode(bytes[index] as number);
  }
  return text;
}

function safeFileName(filePath: string): string {
  const cleaned = basename(filePath)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) return 'screenshot.png';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function screenshotScope(args: Record<string, unknown> | undefined): string {
  if (!args) return 'viewport';
  if (args.target !== undefined && args.target !== null) return 'element';
  if (args.fullPage === true) return 'full-page';
  return 'viewport';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove concrete host paths from an error message before it becomes text. */
function scrubPaths(message: string, paths: readonly string[]): string {
  let scrubbed = message;
  for (const path of paths) {
    if (path.length > 1) scrubbed = scrubbed.split(path).join('<output>');
  }
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
