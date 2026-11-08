/**
 * The in-memory TypeScript backend for the semantic tools.
 *
 * This is the original implementation: a bounded snapshot of workspace files
 * plus `ts.createLanguageService`. It is kept as a real, reusable backend rather
 * than a fallback stub because it has properties the language server does not:
 * it needs no process, no host directory and no dependency install, which is
 * exactly the situation in a unit test or a sandbox copy.
 *
 * The tool output is produced from `LanguageProvider` results, so both backends
 * answer in the same vocabulary. When this backend answers, `info().backend` is
 * `language_service` and no result ever claims a language server ran.
 */

import type * as TS from 'typescript';
import type { ToolWorkspacePort } from '../tools/types.ts';
import {
  SCRIPT_PATTERNS,
  isSemanticPath,
  normalizePath,
  offsetToPosition,
  positionToOffset,
  resolveSymbolPosition,
  snippetAt,
  stripLineNumbers,
} from './code-text.ts';
import type {
  DiagnosticsOptions,
  DiagnosticsResult,
  DocumentReader,
  DefinitionResult,
  LanguageCallOptions,
  LanguageProvider,
  LanguageProviderInfo,
  ProviderDiagnostic,
  ProviderLocation,
  ProviderResult,
  ProviderSymbol,
  ReferencesOptions,
  ReferenceResult,
  SemanticTarget,
  SymbolsResult,
} from './lsp-provider.ts';
import { SemanticProviderError } from './lsp-provider.ts';
import {
  ambientTypeOptions,
  loadTypeScript,
  readCompilerFile,
  typescriptLibDir,
} from './toolchain.ts';

export const MAX_SNAPSHOT_FILES = 800;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_RESULTS = 100;
export const MAX_DIAGNOSTICS = 50;

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

/**
 * Diagnostics caused by not loading the standard library.
 *
 * A project-wide index would resolve `lib.d.ts`; this bounded snapshot does not,
 * and reporting "Cannot find name 'Promise'" for every file would bury the real
 * errors. These codes are filtered only when no lib file was loaded.
 */
const MISSING_LIB_CODES = new Set([2304, 2318, 2583, 2584, 2792, 7016]);
/** Package-resolution diagnostics this snapshot cannot avoid. */
const UNRESOLVED_PACKAGE_CODES = new Set([2307, 2792, 7016]);

/** A reader that returns the file's real text, without the model-facing gutter. */
export function workspaceDocumentReader(workspace: ToolWorkspacePort): DocumentReader {
  return async (path: string): Promise<string> => {
    const slice = await workspace.readLines(path, 1, 0);
    return stripLineNumbers(slice.text);
  };
}

/** Collect the workspace's TypeScript/JavaScript files within the snapshot bound. */
export async function collectWorkspaceScripts(
  workspace: ToolWorkspacePort,
  maxFiles = MAX_SNAPSHOT_FILES,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths = new Set<string>();
  for (const pattern of SCRIPT_PATTERNS) {
    const found = await workspace.glob(pattern, maxFiles);
    for (const path of found.paths) {
      if (isSemanticPath(path)) paths.add(normalizePath(path));
    }
    if (paths.size >= maxFiles) break;
  }
  const limited = [...paths].sort().slice(0, maxFiles);
  return { paths: limited, truncated: paths.size >= maxFiles };
}

async function loadProject(workspace: ToolWorkspacePort): Promise<SemanticProject> {
  const ts = loadTypeScript();
  const { paths, truncated } = await collectWorkspaceScripts(workspace);
  const files = new Map<string, SemanticFile>();
  let totalBytes = 0;
  let skipped = 0;
  for (const path of paths) {
    let text: string;
    try {
      text = await workspaceDocumentReader(workspace)(path);
    } catch {
      skipped += 1;
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (totalBytes + bytes > MAX_SNAPSHOT_BYTES) {
      skipped += 1;
      continue;
    }
    totalBytes += bytes;
    files.set(path, { path, text });
  }

  const hasLib = typescriptLibDir() !== null;
  const ambientTypes = ambientTypeOptions();
  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const file = files.get(normalizePath(fileName));
      if (file) return ts.ScriptSnapshot.fromString(file.text);
      const compilerFile = readCompilerFile(fileName);
      return compilerFile ? ts.ScriptSnapshot.fromString(compilerFile) : undefined;
    },
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // This repository imports `./x.ts` directly (Node type stripping).
      allowImportingTsExtensions: true,
      ...ambientTypes,
    }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) =>
      files.has(normalizePath(fileName)) || readCompilerFile(fileName) !== undefined,
    readFile: (fileName) => files.get(normalizePath(fileName))?.text ?? readCompilerFile(fileName),
    readDirectory: () => [...files.keys()],
  };
  return {
    ts,
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files,
    truncated,
    skipped,
    hasLib,
  };
}

export class LanguageServiceProvider implements LanguageProvider {
  readonly backend = 'language_service' as const;
  readonly #project: SemanticProject;
  readonly #notes: string[];

  private constructor(project: SemanticProject) {
    this.#project = project;
    this.#notes = [
      `内存 TypeScript LanguageService 快照（${project.files.size} 个文件）：没有加载项目依赖，不能作为完整项目零错误证明`,
    ];
  }

  static async create(workspace: ToolWorkspacePort): Promise<LanguageServiceProvider> {
    return new LanguageServiceProvider(await loadProject(workspace));
  }

  info(): LanguageProviderInfo {
    return {
      backend: 'language_service',
      server: 'typescript',
      serverVersion: this.#project.ts.version,
      positionEncoding: 'utf-16',
      scope: {
        rootKind: 'host',
        root: '/',
        tsconfig: false,
        dependencies: false,
        typescriptVersion: this.#project.ts.version,
        openDocuments: this.#project.files.size,
      },
      capabilities: ['definition', 'references', 'documentSymbol', 'hover'],
      reconnects: 0,
      cancellations: 0,
      openDocuments: this.#project.files.size,
      notes: this.#notesWithBounds(),
    };
  }

  #notesWithBounds(): string[] {
    const notes = [...this.#notes];
    if (this.#project.truncated) notes.push(`只加载了前 ${MAX_SNAPSHOT_FILES} 个文件`);
    if (this.#project.skipped > 0) notes.push(`${this.#project.skipped} 个文件因大小/读取失败被跳过`);
    return notes;
  }

  #file(path: string): SemanticFile {
    const normalized = normalizePath(path);
    if (!isSemanticPath(normalized)) {
      throw new SemanticProviderError(
        'UNSUPPORTED_LANGUAGE',
        `语义工具只支持 TypeScript/JavaScript。${normalized} 需要语言服务适配器，当前不会用文本搜索冒充。`,
      );
    }
    const file = this.#project.files.get(normalized);
    if (!file) {
      throw new SemanticProviderError(
        'FILE_NOT_LOADED',
        `没有加载 ${normalized}：它可能超过了本次上限（${MAX_SNAPSHOT_FILES} 个文件 / ${Math.floor(
          MAX_SNAPSHOT_BYTES / 1024 / 1024,
        )} MB），或不在工作区内。`,
      );
    }
    return file;
  }

  #resolve(target: SemanticTarget): { file: SemanticFile; offset: number } {
    const file = this.#file(target.path);
    if (target.symbol && target.symbol.trim().length > 0) {
      const position = resolveSymbolPosition(file.text, target.symbol);
      if (!position) {
        throw new SemanticProviderError(
          'POSITION_NOT_RESOLVED',
          'could not resolve a position: pass line + column (1-based) or a symbol that appears in the file',
        );
      }
      const offset = positionToOffset(file.text, position);
      if (offset === null) {
        throw new SemanticProviderError('POSITION_NOT_RESOLVED', 'could not resolve a position');
      }
      return { file, offset };
    }
    if (!target.line || !target.column) {
      throw new SemanticProviderError(
        'POSITION_NOT_RESOLVED',
        'could not resolve a position: pass line + column (1-based) or a symbol that appears in the file',
      );
    }
    const offset = positionToOffset(file.text, { line: target.line, column: target.column });
    if (offset === null) {
      throw new SemanticProviderError(
        'POSITION_NOT_RESOLVED',
        'could not resolve a position: line/column is outside the document',
      );
    }
    return { file, offset };
  }

  #location(fileName: string, position: number, primary: SemanticFile): ProviderLocation {
    const normalized = normalizePath(fileName);
    const file = this.#project.files.get(normalized);
    if (!file) {
      return { path: normalized, line: 1, column: 1 };
    }
    const model = offsetToPosition(file.text, position);
    return {
      path: normalized,
      line: model.line,
      column: model.column,
      snippet: snippetAt(file.path === primary.path ? primary.text : file.text, model),
    };
  }

  async sync(path: string): Promise<{ readonly path: string; readonly version: number }> {
    this.#file(path);
    return { path: normalizePath(path), version: 1 };
  }

  async definition(target: SemanticTarget): Promise<ProviderResult<DefinitionResult>> {
    const { file, offset } = this.#resolve(target);
    const definitions = this.#project.service.getDefinitionAtPosition(file.path, offset) ?? [];
    let symbol: string | null = null;
    try {
      const quick = this.#project.service.getQuickInfoAtPosition(file.path, offset);
      if (quick) {
        const display = this.#project.ts.displayPartsToString(quick.displayParts ?? []);
        symbol = display.length > 0 ? display : null;
      }
    } catch {
      symbol = null;
    }
    return {
      value: {
        locations: definitions.slice(0, MAX_RESULTS).map((entry) =>
          this.#location(entry.fileName, entry.textSpan.start, file),
        ),
        symbol,
      },
      documentVersion: 1,
      stale: false,
      info: this.info(),
      notes: this.#notesWithBounds(),
    };
  }

  async references(
    target: SemanticTarget,
    options: ReferencesOptions = {},
  ): Promise<ProviderResult<ReferenceResult>> {
    const { file, offset } = this.#resolve(target);
    const groups = this.#project.service.findReferences(file.path, offset) ?? [];
    const includeDeclaration = options.includeDeclaration !== false;
    const limit = Math.max(1, Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS));
    const all: TS.ReferenceEntry[] = [];
    for (const group of groups) {
      for (const reference of group.references) {
        if (!includeDeclaration && reference.isDefinition) continue;
        all.push(reference);
      }
    }
    return {
      value: {
        locations: all.slice(0, limit).map((entry) =>
          this.#location(entry.fileName, entry.textSpan.start, file),
        ),
        total: all.length,
        truncated: all.length > limit,
      },
      documentVersion: 1,
      stale: false,
      info: this.info(),
      notes: this.#notesWithBounds(),
    };
  }

  async documentSymbols(
    input: { readonly path: string } & LanguageCallOptions,
  ): Promise<ProviderResult<SymbolsResult>> {
    const file = this.#file(input.path);
    const tree = this.#project.service.getNavigationTree(file.path);
    const symbols: ProviderSymbol[] = [];
    const flatten = (node: typeof tree, depth: number): void => {
      if (symbols.length >= 200) return;
      for (const child of node.childItems ?? []) {
        const span = child.spans[0];
        if (span) {
          const model = offsetToPosition(file.text, span.start);
          symbols.push({
            name: child.text,
            kind: child.kind,
            line: model.line,
            column: model.column,
            depth,
          });
        }
        flatten(child, depth + 1);
      }
    };
    flatten(tree, 0);
    return {
      value: { symbols, truncated: symbols.length >= 200 },
      documentVersion: 1,
      stale: false,
      info: this.info(),
      notes: this.#notesWithBounds(),
    };
  }

  async workspaceSymbols(): Promise<ProviderResult<SymbolsResult>> {
    throw new SemanticProviderError(
      'UNSUPPORTED_CAPABILITY',
      '工作区符号查询需要真实语言服务器后端；当前回退到内存 TypeScript LanguageService，不能提供有界工作区符号查询',
    );
  }

  async diagnostics(
    options: DiagnosticsOptions = {},
  ): Promise<ProviderResult<DiagnosticsResult>> {
    const targets =
      options.paths && options.paths.length > 0
        ? [...new Set(options.paths.map(normalizePath))].slice(0, 20)
        : [...this.#project.files.keys()].slice(0, 20);
    const diagnostics: ProviderDiagnostic[] = [];
    const versions: Record<string, number | null> = {};
    for (const target of targets) {
      const file = this.#file(target);
      versions[file.path] = 1;
      const all = [
        ...this.#project.service.getSyntacticDiagnostics(file.path),
        ...this.#project.service.getSemanticDiagnostics(file.path),
      ];
      for (const diagnostic of all) {
        if (UNRESOLVED_PACKAGE_CODES.has(diagnostic.code)) continue;
        if (!this.#project.hasLib && MISSING_LIB_CODES.has(diagnostic.code)) continue;
        const message = this.#project.ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        if (diagnostic.start === undefined) {
          diagnostics.push({ path: file.path, line: 1, column: 1, severity: 'error', code: `TS${diagnostic.code}`, message });
          continue;
        }
        const model = offsetToPosition(file.text, diagnostic.start);
        const end =
          diagnostic.length === undefined
            ? undefined
            : offsetToPosition(file.text, diagnostic.start + diagnostic.length);
        diagnostics.push({
          path: file.path,
          line: model.line,
          column: model.column,
          ...(end ? { endLine: end.line, endColumn: end.column } : {}),
          severity: 'error',
          code: `TS${diagnostic.code}`,
          message,
        });
      }
    }
    return {
      value: { diagnostics, versions, stale: false, checked: targets.length },
      documentVersion: 1,
      stale: false,
      info: this.info(),
      notes: this.#notesWithBounds(),
    };
  }

  async hover(target: SemanticTarget): Promise<ProviderResult<string | null>> {
    const { file, offset } = this.#resolve(target);
    const quick = this.#project.service.getQuickInfoAtPosition(file.path, offset);
    const display = quick ? this.#project.ts.displayPartsToString(quick.displayParts ?? []) : '';
    return {
      value: display.length > 0 ? display : null,
      documentVersion: 1,
      stale: false,
      info: this.info(),
      notes: this.#notesWithBounds(),
    };
  }

  async dispose(): Promise<void> {
    // The snapshot is owned by this instance and disappears with it.
  }
}

export { isSemanticPath };
