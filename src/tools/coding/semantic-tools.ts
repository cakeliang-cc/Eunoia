/**
 * Semantic code tools: definition, references and diagnostics.
 *
 * Text search answers "where does this string appear". These tools answer "what
 * does this identifier mean here, and who else depends on it", which is what a
 * change like "rename this function and update every caller" actually needs.
 *
 * The implementation runs the TypeScript language service over a bounded,
 * in-memory snapshot of the workspace. It deliberately does not spawn a language
 * server or index the project on disk:
 *
 *   - the sandbox owns the files; reading them through `ToolWorkspacePort` means
 *     the same path guards, ignore rules and size limits apply as for `read_file`;
 *   - a per-call program keeps the tool read-only and disappearable, with no
 *     daemon to supervise;
 *   - the loaded file set is bounded, and the tools say so instead of pretending
 *     to know about files they did not load.
 *
 * Only TypeScript/JavaScript is supported. That is stated in the description and
 * enforced with `SEMANTIC_UNSUPPORTED` for anything else — a text-search fallback
 * would answer a different question and be wrong in the way this tool exists to
 * avoid. The `SemanticProject` seam is where an LSP adapter for other languages
 * would plug in without changing the tool contract.
 *
 * See docs/adr/037-semantic-code-tools.md.
 */

import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import { z } from 'zod';
import { toolError, toolOk } from '../types.ts';
import type { ToolContext, ToolResult } from '../types.ts';
import { defineTool } from '../types.ts';

const require = createRequire(import.meta.url);
let tsModule: typeof TS | null = null;

function loadTypeScript(): typeof TS {
  if (tsModule) return tsModule;
  try {
    tsModule = require('typescript') as typeof TS;
    return tsModule;
  } catch (error) {
    throw new Error(
      `TypeScript is not installed, so semantic tools are unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Extensions this service understands. A `.py` file is refused, not guessed at. */
export const SEMANTIC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** How many files and bytes one call may load. */
const MAX_FILES = 800;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 100;
const MAX_DIAGNOSTICS = 50;

/**
 * Diagnostics caused by not loading the standard library.
 *
 * A project-wide index would resolve `lib.d.ts`; this bounded snapshot does not,
 * and reporting "Cannot find name 'Promise'" for every file would bury the real
 * errors. These codes are filtered only when no lib file was loaded.
 */
const MISSING_LIB_CODES = new Set([2304, 2318, 2583, 2584, 2792, 7016, 2307]);

interface SemanticFile {
  readonly path: string;
  readonly text: string;
}

interface SemanticProject {
  readonly ts: typeof TS;
  readonly service: TS.LanguageService;
  readonly files: ReadonlyMap<string, SemanticFile>;
  readonly truncated: boolean;
  readonly skipped: number;
  readonly hasLib: boolean;
}

const SCRIPT_PATTERNS = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];

export function isSemanticPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SEMANTIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function loadProject(context: ToolContext): Promise<SemanticProject | null> {
  const workspace = context.workspace;
  if (!workspace) return null;
  const ts = loadTypeScript();

  const paths = new Set<string>();
  for (const pattern of SCRIPT_PATTERNS) {
    const found = await workspace.glob(pattern, MAX_FILES);
    for (const path of found.paths) paths.add(path);
    if (paths.size >= MAX_FILES) break;
  }
  const limited = [...paths].sort().slice(0, MAX_FILES);
  const files = new Map<string, SemanticFile>();
  let totalBytes = 0;
  let skipped = 0;
  for (const path of limited) {
    if (!isSemanticPath(path)) continue;
    let text: string;
    try {
      const slice = await workspace.readLines(path, 1, 0);
      // `readLines` returns model-facing text with a line-number gutter. The
      // compiler must see the file's actual bytes, so the gutter is removed.
      text = stripLineNumbers(slice.text);
    } catch {
      skipped += 1;
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      skipped += 1;
      continue;
    }
    totalBytes += bytes;
    files.set(normalize(path), { path: normalize(path), text });
  }

  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const file = files.get(normalize(fileName));
      if (file) return ts.ScriptSnapshot.fromString(file.text);
      // The standard library is not part of the workspace. Returning undefined
      // is honest; the diagnostics that follow are filtered accordingly.
      return undefined;
    },
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    }),
    getDefaultLibFileName: () => '/lib.d.ts',
    fileExists: (fileName) => files.has(normalize(fileName)),
    readFile: (fileName) => files.get(normalize(fileName))?.text,
    readDirectory: () => [...files.keys()],
  };
  return {
    ts,
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files,
    truncated: paths.size >= MAX_FILES,
    skipped,
    hasLib: [...files.keys()].some((path) => /(^|\/)lib\.[^/]*\.d\.ts$/.test(path)),
  };
}

/** Remove the `\`   12\t\`` gutter that the read port adds for the model. */
function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

/** Workspace paths are relative with `/`; the service may answer absolute-ish ones. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

function assertSupported(project: SemanticProject, path: string): { readonly path: string; readonly file: SemanticFile } | ToolResult {
  const normalized = normalize(path);
  if (!isSemanticPath(normalized)) {
    return toolError(
      `语义工具只支持 TypeScript/JavaScript（${SEMANTIC_EXTENSIONS.join(', ')}）。${normalized} 需要语言服务适配器，当前不会用文本搜索冒充。`,
      { unsupported: true },
    );
  }
  const file = project.files.get(normalized);
  if (!file) {
    return toolError(
      `没有加载 ${normalized}：它可能超过了本次上限（${MAX_FILES} 个文件 / ${Math.floor(
        MAX_TOTAL_BYTES / 1024 / 1024,
      )} MB），或不在工作区内。`,
    );
  }
  return { path: normalized, file };
}

interface ResolvedPosition {
  readonly path: string;
  readonly offset: number;
}

/**
 * Resolve a position from line/column or from an identifier in the file.
 *
 * `symbol` is a convenience for the model, which often knows the name but not
 * the cursor: the first identifier token with that text is used. It is a token
 * match, not a substring search, so `add` does not match `address`.
 */
function resolvePosition(
  project: SemanticProject,
  input: { readonly path: string; readonly line?: number; readonly column?: number; readonly symbol?: string },
): ResolvedPosition | null {
  const file = project.files.get(normalize(input.path));
  if (!file) return null;
  if (input.symbol && input.symbol.trim().length > 0) {
    const needle = input.symbol.trim();
    const scanner = project.ts.createScanner(
      project.ts.ScriptTarget.Latest,
      true,
      project.ts.LanguageVariant.Standard,
      file.text,
    );
    for (;;) {
      const token = scanner.scan();
      if (token === project.ts.SyntaxKind.EndOfFileToken) break;
      if (scanner.getTokenText() === needle) {
        return { path: file.path, offset: scanner.getTokenStart() };
      }
    }
    return null;
  }
  if (!input.line || !input.column) return null;
  const lineStarts = computeLineStarts(file.text);
  const index = input.line - 1;
  if (index < 0 || index >= lineStarts.length) return null;
  const offset = (lineStarts[index] as number) + Math.max(0, input.column - 1);
  if (offset > file.text.length) return null;
  return { path: file.path, offset };
}

function formatLocation(project: SemanticProject, fileName: string, position: number): string {
  const normalized = normalize(fileName);
  const file = project.files.get(normalized);
  if (!file) return `${normalized}:?`;
  const { line, column } = lineAndColumn(file.text, position);
  return `${normalized}:${line}:${column}`;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 1-based line and column, which is what a person and the model both use. */
function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const starts = computeLineStarts(text);
  let low = 0;
  let high = starts.length - 1;
  let line = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((starts[mid] as number) <= position) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { line: line + 1, column: position - (starts[line] as number) + 1 };
}

function lineAt(file: SemanticFile | undefined, position: number): string {
  if (!file) return '';
  const starts = computeLineStarts(file.text);
  const { line } = lineAndColumn(file.text, position);
  const start = starts[line - 1] as number;
  const end = line < starts.length ? (starts[line] as number) : file.text.length;
  return file.text.slice(start, end).trim().slice(0, 240);
}

function describeSymbol(project: SemanticProject, path: string, offset: number): string {
  try {
    const quick = project.service.getQuickInfoAtPosition(path, offset);
    if (!quick) return '';
    const name = project.ts.displayPartsToString(quick.displayParts ?? []);
    return name.length > 0 ? name : '';
  } catch {
    return '';
  }
}

function countSkippedNote(project: SemanticProject): string {
  const notes: string[] = [];
  if (project.truncated) notes.push(`只加载了前 ${MAX_FILES} 个文件`);
  if (project.skipped > 0) notes.push(`${project.skipped} 个文件因大小/读取失败被跳过`);
  return notes.length > 0 ? `（${notes.join('；')}）` : '';
}

export const findDefinitionTool = defineTool({
  name: 'find_definition',
  description:
    'Find the semantic definition of a symbol at a TypeScript/JavaScript position or by name. ' +
    'Use this instead of text search when you need what an identifier means, not where a string appears. ' +
    'Provide either line + column (1-based) or symbol.',
  parameters: z.object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    symbol: z.string().min(1).optional(),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'find_definition / find_references / diagnostics are semantic tools for TypeScript and JavaScript. ' +
    'They read the workspace through the same guard as read_file and are bounded to a snapshot; they do not run a language server.',
  timeoutMs: 20_000,
  async execute(raw, context): Promise<ToolResult> {
    const input = raw as Record<string, unknown>;
    const path = typeof input.path === 'string' ? input.path : '';
    if (path.length === 0) return toolError('path is required');
    const loaded = await loadProject(context).catch((error: unknown) =>
      toolError(error instanceof Error ? error.message : String(error)),
    );
    if (loaded === null) return toolError('no workspace is configured');
    if ('ok' in loaded) return loaded;
    const project = loaded;
    const supported = assertSupported(project, path);
    if ('ok' in supported) return supported;
    const position = resolvePosition(project, {
      path: supported.path,
      ...(typeof input.line === 'number' ? { line: input.line } : {}),
      ...(typeof input.column === 'number' ? { column: input.column } : {}),
      ...(typeof input.symbol === 'string' ? { symbol: input.symbol } : {}),
    });
    if (!position) {
      return toolError(
        'could not resolve a position: pass line + column (1-based) or a symbol that appears in the file',
      );
    }
    const definitions = project.service.getDefinitionAtPosition(position.path, position.offset) ?? [];
    if (definitions.length === 0) {
      return toolOk(`没有找到 ${supported.path} 中该位置的语义定义。${countSkippedNote(project)}`, {
        summary: 'no definition',
      });
    }
    const symbol = describeSymbol(project, position.path, position.offset);
    const lines = definitions.slice(0, MAX_RESULTS).map((definition) => {
      const location = formatLocation(project, definition.fileName, definition.textSpan.start);
      const file = project.files.get(normalize(definition.fileName));
      const snippet = lineAt(file, definition.textSpan.start);
      return `${location}${symbol ? ` — ${symbol}` : ''}${snippet ? `\n  ${snippet}` : ''}`;
    });
    return toolOk(
      `定义（${definitions.length}）：\n${lines.join('\n')}${countSkippedNote(project)}`,
      { summary: `${definitions.length} definition(s)`, definitions: definitions.length },
    );
  },
});

export const findReferencesTool = defineTool({
  name: 'find_references',
  description:
    'Find semantic references to a symbol in TypeScript/JavaScript, including callers across files. ' +
    'Use this before changing a signature or renaming. Provide line + column (1-based) or symbol.',
  parameters: z.object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    symbol: z.string().min(1).optional(),
    includeDeclaration: z.boolean().optional(),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'find_references is semantic, not textual: same-named identifiers in unrelated scopes are not reported as callers.',
  timeoutMs: 20_000,
  async execute(raw, context): Promise<ToolResult> {
    const input = raw as Record<string, unknown>;
    const path = typeof input.path === 'string' ? input.path : '';
    if (path.length === 0) return toolError('path is required');
    const loaded = await loadProject(context).catch((error: unknown) =>
      toolError(error instanceof Error ? error.message : String(error)),
    );
    if (loaded === null) return toolError('no workspace is configured');
    if ('ok' in loaded) return loaded;
    const project = loaded;
    const supported = assertSupported(project, path);
    if ('ok' in supported) return supported;
    const position = resolvePosition(project, {
      path: supported.path,
      ...(typeof input.line === 'number' ? { line: input.line } : {}),
      ...(typeof input.column === 'number' ? { column: input.column } : {}),
      ...(typeof input.symbol === 'string' ? { symbol: input.symbol } : {}),
    });
    if (!position) {
      return toolError(
        'could not resolve a position: pass line + column (1-based) or a symbol that appears in the file',
      );
    }
    const groups = project.service.findReferences(position.path, position.offset) ?? [];
    const includeDeclaration = input.includeDeclaration !== false;
    const rows: string[] = [];
    let total = 0;
    for (const group of groups) {
      for (const reference of group.references) {
        if (!includeDeclaration && reference.isDefinition) continue;
        total += 1;
        if (rows.length >= MAX_RESULTS) continue;
        const location = formatLocation(project, reference.fileName, reference.textSpan.start);
        const file = project.files.get(normalize(reference.fileName));
        const snippet = lineAt(file, reference.textSpan.start);
        rows.push(`${location}${snippet ? ` — ${snippet}` : ''}`);
      }
    }
    if (total === 0) {
      return toolOk(`没有找到 ${supported.path} 中该符号的引用。${countSkippedNote(project)}`, {
        summary: 'no references',
      });
    }
    const bounded = total > rows.length ? `\n[只显示前 ${MAX_RESULTS} 个，共 ${total} 个]` : '';
    return toolOk(
      `引用（${total}）：\n${rows.join('\n')}${bounded}${countSkippedNote(project)}`,
      { summary: `${total} reference(s)`, references: total, truncated: total > rows.length },
    );
  },
});

export const diagnosticsTool = defineTool({
  name: 'diagnostics',
  description:
    'Type-check TypeScript/JavaScript files in the workspace and report syntactic and semantic diagnostics. ' +
    'Optionally pass one path; otherwise checks up to 20 loaded files. Use after edits to find what broke.',
  parameters: z.object({ path: z.string().min(1).optional() }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'diagnostics reports TypeScript compiler diagnostics. It is not a linter: style rules and project-specific lint configs are out of scope.',
  timeoutMs: 30_000,
  async execute(raw, context): Promise<ToolResult> {
    const input = raw as Record<string, unknown>;
    const loaded = await loadProject(context).catch((error: unknown) =>
      toolError(error instanceof Error ? error.message : String(error)),
    );
    if (loaded === null) return toolError('no workspace is configured');
    if ('ok' in loaded) return loaded;
    const project = loaded;

    let targets: string[];
    if (typeof input.path === 'string' && input.path.length > 0) {
      const supported = assertSupported(project, input.path);
      if ('ok' in supported) return supported;
      targets = [supported.path];
    } else {
      targets = [...project.files.keys()].slice(0, 20);
    }
    const rows: string[] = [];
    let count = 0;
    for (const target of targets) {
      const all = [
        ...project.service.getSyntacticDiagnostics(target),
        ...project.service.getSemanticDiagnostics(target),
      ];
      for (const diagnostic of all) {
        if (!project.hasLib && MISSING_LIB_CODES.has(diagnostic.code)) continue;
        count += 1;
        if (rows.length >= MAX_DIAGNOSTICS) continue;
        const message = project.ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        if (diagnostic.start === undefined) {
          rows.push(`${target} TS${diagnostic.code}: ${message}`);
          continue;
        }
        const location = formatLocation(project, target, diagnostic.start);
        rows.push(`${location} TS${diagnostic.code}: ${message}`);
      }
    }
    if (count === 0) {
      return toolOk(`没有诊断错误（检查了 ${targets.length} 个文件）。${countSkippedNote(project)}`, {
        summary: 'no diagnostics',
        checked: targets.length,
      });
    }
    const bounded = count > rows.length ? `\n[只显示前 ${MAX_DIAGNOSTICS} 条，共 ${count} 条]` : '';
    return toolOk(
      `诊断（${count}）：\n${rows.join('\n')}${bounded}${countSkippedNote(project)}`,
      { summary: `${count} diagnostic(s)`, diagnostics: count, truncated: count > rows.length },
    );
  },
});

export const semanticTools = [findDefinitionTool, findReferencesTool, diagnosticsTool] as const;
