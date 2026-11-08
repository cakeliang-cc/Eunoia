/**
 * Semantic code tools: definition, references, symbols and diagnostics.
 *
 * Text search answers "where does this string appear". These tools answer "what
 * does this identifier mean here, and who else depends on it", which is what a
 * change like "rename this function and update every caller" actually needs.
 *
 * Two backends implement the same `LanguageProvider` seam:
 *
 *   - a real `typescript-language-server` over stdio when the turn has a host
 *     workspace root (the project directory). That is the normal path: it sees
 *     the workspace's tsconfig and dependencies, versions its documents and can
 *     answer project-wide symbol queries;
 *   - the bounded in-memory TypeScript `LanguageService` otherwise (unit tests,
 *     workspaces without a host tree, or when the server cannot start).
 *
 * The tools never claim a backend they did not use. Every result carries
 * `meta.language_server` with the actual backend, server name/version, position
 * encoding, document version and any fallback reason.
 *
 * Positions are 1-based line/column where the column counts code points, or an
 * identifier name. The 1-based → LSP UTF-16 conversion belongs to the provider,
 * because the model and LSP disagree about what a "character" is for Chinese
 * text and emoji.
 *
 * Only TypeScript/JavaScript is supported. That is stated in the description and
 * enforced with an explicit error for anything else — a text-search fallback
 * would answer a different question and be wrong in the way this tool exists to
 * avoid.
 *
 * See docs/adr/037-semantic-code-tools.md.
 */

import { z } from 'zod';
import { toolError, toolOk } from '../types.ts';
import type { ToolContext, ToolLanguagePort, ToolResult, ToolResultMeta } from '../types.ts';
import { defineTool } from '../types.ts';
import {
  SEMANTIC_EXTENSIONS,
  isSemanticPath,
  normalizePath,
} from '../../semantic/code-text.ts';
import {
  LanguageServiceProvider,
  MAX_DIAGNOSTICS,
  MAX_RESULTS,
  collectWorkspaceScripts,
  workspaceDocumentReader,
} from '../../semantic/language-service-provider.ts';
import {
  SemanticProviderError,
  acquireLanguageProvider,
  type DiagnosticsResult,
  type LanguageProvider,
  type ProviderLocation,
  type ProviderSymbol,
} from '../../semantic/lsp-provider.ts';

export { SEMANTIC_EXTENSIONS, isSemanticPath };

const MAX_SYMBOLS = 200;

type ChosenProvider =
  | {
      readonly kind: 'ready';
      readonly provider: LanguageProvider;
      /** Non-null only when the language server was attempted and failed. */
      readonly fallbackReason: string | null;
      readonly release: () => void;
    }
  | { readonly kind: 'error'; readonly result: ToolResult };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pick the backend for this call.
 *
 * When the context carries a `ToolLanguagePort`, the real server is attempted
 * first. A startup failure falls back to the in-memory service with the actual
 * reason recorded; a failure *after* a successful start is reported by the tool
 * instead, because silently answering from a different engine would hide a real
 * language-server fault.
 */
async function chooseProvider(context: ToolContext): Promise<ChosenProvider> {
  const workspace = context.workspace;
  if (!workspace) return { kind: 'error', result: toolError('no workspace is configured') };
  const language: ToolLanguagePort | null = context.language ?? null;
  let fallbackReason: string | null = null;
  if (language) {
    try {
      const seed =
        language.allowMirror === true && !language.hostRoot
          ? (await collectWorkspaceScripts(workspace)).paths
          : undefined;
      const lease = await acquireLanguageProvider({
        hostRoot: language.hostRoot ?? null,
        allowMirror: language.allowMirror === true,
        ...(seed ? { seedPaths: seed } : {}),
        listDocuments: async () => (await collectWorkspaceScripts(workspace, 200)).paths,
        readDocument: workspaceDocumentReader(workspace),
      });
      return { kind: 'ready', provider: lease.provider, fallbackReason: null, release: lease.release };
    } catch (error) {
      fallbackReason = messageOf(error);
    }
  } else {
    fallbackReason = '本轮没有宿主工作区根（ToolLanguagePort 未配置）';
  }
  try {
    const provider = await LanguageServiceProvider.create(workspace);
    return {
      kind: 'ready',
      provider,
      fallbackReason,
      release: () => {
        void provider.dispose();
      },
    };
  } catch (error) {
    return {
      kind: 'error',
      result: toolError(
        `语义后端不可用：${messageOf(error)}${fallbackReason ? `（语言服务器：${fallbackReason}）` : ''}`,
      ),
    };
  }
}

function languageServerMeta(
  provider: LanguageProvider,
  fallbackReason: string | null,
  summary: string,
  extra: Record<string, unknown> = {},
): ToolResultMeta {
  const info = provider.info();
  return {
    summary,
    backend: info.backend,
    language_server: {
      backend: info.backend,
      transport: info.transport ?? null,
      server: info.server ?? null,
      version: info.serverVersion ?? null,
      pid: info.pid ?? null,
      position_encoding: info.positionEncoding ?? null,
      capabilities: info.capabilities ?? [],
      scope: info.scope ?? null,
      reconnects: info.reconnects,
      cancellations: info.cancellations,
      refused_server_requests: info.refusedServerRequests ?? 0,
      open_documents: info.openDocuments ?? 0,
      fallback_reason: fallbackReason,
      ...extra,
    },
    ...extra,
  };
}

function backendNote(provider: LanguageProvider, fallbackReason: string | null, notes: readonly string[]): string {
  const all = [...notes];
  if (provider.backend === 'language_service') {
    all.unshift(
      `后端：内存 TypeScript LanguageService（未使用语言服务器${
        fallbackReason ? `；原因：${fallbackReason}` : ''
      }）`,
    );
  }
  const unique = [...new Set(all.filter((note) => note.trim().length > 0))];
  return unique.length > 0 ? `（${unique.join('；')}）` : '';
}

function providerFailure(
  error: unknown,
  provider: LanguageProvider,
  fallbackReason: string | null,
  extra: Record<string, unknown> = {},
): ToolResult {
  const message = messageOf(error);
  const meta = languageServerMeta(provider, fallbackReason, 'semantic error', {
    code: error instanceof SemanticProviderError ? error.code : 'ERROR',
    ...extra,
  });
  return toolError(message, meta);
}

function formatLocation(location: ProviderLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

function formatSymbol(symbol: ProviderSymbol): string {
  return `${'  '.repeat(symbol.depth)}${symbol.kind} ${symbol.name} @${symbol.line}:${symbol.column}`;
}

function checkSemanticPath(path: string): ToolResult | null {
  const normalized = normalizePath(path);
  if (!isSemanticPath(normalized)) {
    return toolError(
      `语义工具只支持 TypeScript/JavaScript（${SEMANTIC_EXTENSIONS.join(', ')}）。${normalized} 需要语言服务适配器，当前不会用文本搜索冒充。`,
      { unsupported: true },
    );
  }
  return null;
}

async function collectTargets(context: ToolContext, limit: number): Promise<string[]> {
  const workspace = context.workspace;
  if (!workspace) return [];
  return (await collectWorkspaceScripts(workspace, limit)).paths.slice(0, limit);
}

export const findDefinitionTool = defineTool({
  name: 'find_definition',
  description:
    'Find the semantic definition of a TypeScript/JavaScript symbol by 1-based line+column or name. ' +
    'Uses the real typescript-language-server when a host workspace is available, otherwise an in-memory LanguageService; the result names the backend. ' +
    'Use it instead of text search to learn what an identifier means.',
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
    'They read the workspace through the same guard as read_file. The language server is the live backend; ' +
    'if it is unavailable the tools say so and use the in-memory LanguageService instead of pretending.',
  timeoutMs: 20_000,
  async execute(raw, context): Promise<ToolResult> {
    const input = raw as Record<string, unknown>;
    const path = typeof input.path === 'string' ? input.path : '';
    if (path.length === 0) return toolError('path is required');
    const unsupported = checkSemanticPath(path);
    if (unsupported) return unsupported;
    const chosen = await chooseProvider(context);
    if (chosen.kind === 'error') return chosen.result;
    const { provider, fallbackReason, release } = chosen;
    try {
      const result = await provider.definition(
        {
          path,
          ...(typeof input.line === 'number' ? { line: input.line } : {}),
          ...(typeof input.column === 'number' ? { column: input.column } : {}),
          ...(typeof input.symbol === 'string' ? { symbol: input.symbol } : {}),
        },
        context.signal ? { signal: context.signal } : {},
      );
      const note = backendNote(provider, fallbackReason, result.notes);
      const { locations, symbol } = result.value;
      if (locations.length === 0) {
        return toolOk(`没有找到 ${normalizePath(path)} 中该位置的语义定义。${note}`, {
          ...languageServerMeta(provider, fallbackReason, 'no definition', {
            document_version: result.documentVersion,
          }),
        });
      }
      const signature = symbol?.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
      const rows = locations.slice(0, MAX_RESULTS).map((location) => {
        const snippet = location.snippet ? `\n  ${location.snippet}` : '';
        return `${formatLocation(location)}${signature ? ` — ${signature}` : ''}${snippet}`;
      });
      return toolOk(`定义（${locations.length}）：\n${rows.join('\n')}${note}`, {
        ...languageServerMeta(provider, fallbackReason, `${locations.length} definition(s)`, {
          definitions: locations.length,
          document_version: result.documentVersion,
        }),
      });
    } catch (error) {
      return providerFailure(error, provider, fallbackReason);
    } finally {
      release();
    }
  },
});

export const findReferencesTool = defineTool({
  name: 'find_references',
  description:
    'Find semantic references to a symbol in TypeScript/JavaScript, including callers across files. ' +
    'Runs the installed typescript-language-server when available (or the in-memory TypeScript LanguageService otherwise) ' +
    'and reports which backend answered. Use this before changing a signature or renaming. Provide line + column (1-based) or symbol.',
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
    const unsupported = checkSemanticPath(path);
    if (unsupported) return unsupported;
    const chosen = await chooseProvider(context);
    if (chosen.kind === 'error') return chosen.result;
    const { provider, fallbackReason, release } = chosen;
    try {
      const result = await provider.references(
        {
          path,
          ...(typeof input.line === 'number' ? { line: input.line } : {}),
          ...(typeof input.column === 'number' ? { column: input.column } : {}),
          ...(typeof input.symbol === 'string' ? { symbol: input.symbol } : {}),
        },
        {
          includeDeclaration: input.includeDeclaration !== false,
          limit: MAX_RESULTS,
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
      const note = backendNote(provider, fallbackReason, result.notes);
      const { locations, total, truncated } = result.value;
      if (total === 0) {
        return toolOk(`没有找到 ${normalizePath(path)} 中该符号的引用。${note}`, {
          ...languageServerMeta(provider, fallbackReason, 'no references', {
            document_version: result.documentVersion,
          }),
        });
      }
      const rows = locations.map((location) => {
        const snippet = location.snippet ? ` — ${location.snippet}` : '';
        return `${formatLocation(location)}${snippet}`;
      });
      const bounded = truncated ? `\n[只显示前 ${rows.length} 个，共 ${total} 个]` : '';
      return toolOk(`引用（${total}）：\n${rows.join('\n')}${bounded}${note}`, {
        ...languageServerMeta(provider, fallbackReason, `${total} reference(s)`, {
          references: total,
          truncated,
          document_version: result.documentVersion,
        }),
      });
    } catch (error) {
      return providerFailure(error, provider, fallbackReason);
    } finally {
      release();
    }
  },
});

export const listSymbolsTool = defineTool({
  name: 'list_symbols',
  description:
    'List the declarations in one TypeScript/JavaScript file with their kind and 1-based position. ' +
    'Uses the installed typescript-language-server (documentSymbol) when available. ' +
    'Use it to navigate a file by structure instead of reading every line.',
  parameters: z.object({
    path: z.string().min(1),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'list_symbols reads the declarations the backend sees. It does not list local variables inside function bodies.',
  timeoutMs: 20_000,
  async execute({ path }, context) {
    if (!context.workspace) return toolError('没有配置工作区。');
    const unsupported = checkSemanticPath(path);
    if (unsupported) return unsupported;
    const chosen = await chooseProvider(context);
    if (chosen.kind === 'error') return chosen.result;
    const { provider, fallbackReason, release } = chosen;
    try {
      const result = await provider.documentSymbols({
        path,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const note = backendNote(provider, fallbackReason, result.notes);
      const symbols = result.value.symbols;
      if (symbols.length === 0) {
        return toolOk(`没有找到声明：${normalizePath(path)}${note}`, {
          ...languageServerMeta(provider, fallbackReason, 'no symbols', {
            document_version: result.documentVersion,
          }),
        });
      }
      return toolOk(`符号（最多 ${MAX_SYMBOLS} 个）：\n${symbols.map(formatSymbol).join('\n')}${note}`, {
        ...languageServerMeta(provider, fallbackReason, `${symbols.length} 个符号`, {
          path: normalizePath(path),
          symbols: symbols.length,
          document_version: result.documentVersion,
        }),
      });
    } catch (error) {
      return providerFailure(error, provider, fallbackReason);
    } finally {
      release();
    }
  },
});

export const diagnosticsTool = defineTool({
  name: 'diagnostics',
  description:
    'Type-check TypeScript/JavaScript files and report syntactic and semantic diagnostics. ' +
    'Runs the installed typescript-language-server when available (diagnostics carry the document version), ' +
    'and the in-memory TypeScript LanguageService otherwise; the result names the backend. ' +
    'Optionally pass one path; otherwise checks up to 20 workspace files. Use after edits to find what broke.',
  parameters: z.object({ path: z.string().min(1).optional() }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'diagnostics reports TypeScript diagnostics. It is not a linter: style rules and project-specific lint configs are out of scope. ' +
    'A missing or not-ready language-server response is an error, never "zero errors".',
  timeoutMs: 30_000,
  async execute(raw, context): Promise<ToolResult> {
    const input = raw as Record<string, unknown>;
    const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : null;
    if (requested) {
      const unsupported = checkSemanticPath(requested);
      if (unsupported) return unsupported;
    }
    if (!context.workspace) return toolError('no workspace is configured');
    const targets = requested ? [normalizePath(requested)] : await collectTargets(context, 20);
    if (targets.length === 0) return toolOk('没有可检查的 TypeScript/JavaScript 文件。');
    const chosen = await chooseProvider(context);
    if (chosen.kind === 'error') return chosen.result;
    const { provider, fallbackReason, release } = chosen;
    try {
      const result = await provider.diagnostics({
        paths: targets,
        limit: 20,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const note = backendNote(provider, fallbackReason, result.notes);
      const value: DiagnosticsResult = result.value;
      const { diagnostics, checked, stale } = value;
      if (diagnostics.length === 0) {
        return toolOk(`没有诊断错误（检查了 ${checked} 个文件）。${note}`, {
          ...languageServerMeta(provider, fallbackReason, 'no diagnostics', {
            checked,
            stale,
            versions: value.versions,
          }),
        });
      }
      const rows = diagnostics
        .slice(0, MAX_DIAGNOSTICS)
        .map((diagnostic) => `${formatLocation(diagnostic)} ${diagnostic.code}: ${diagnostic.message}`);
      const bounded =
        diagnostics.length > rows.length
          ? `\n[只显示前 ${MAX_DIAGNOSTICS} 条，共 ${diagnostics.length} 条]`
          : '';
      const staleLabel = stale ? `，stale` : '';
      const staleNote = stale ? '\n[这些诊断来自旧文档版本，不是当前内容的结论]' : '';
      return toolOk(`诊断（${diagnostics.length}${staleLabel}）：\n${rows.join('\n')}${bounded}${staleNote}${note}`, {
        ...languageServerMeta(provider, fallbackReason, `${diagnostics.length} diagnostic(s)`, {
          diagnostics: diagnostics.length,
          checked,
          truncated: diagnostics.length > rows.length,
          stale,
          versions: value.versions,
        }),
      });
    } catch (error) {
      return providerFailure(error, provider, fallbackReason);
    } finally {
      release();
    }
  },
});

export const workspaceSymbolsTool = defineTool({
  name: 'workspace_symbols',
  description:
    'Search declarations across the whole TypeScript/JavaScript workspace by name. ' +
    'Requires the real typescript-language-server backend (workspace/symbol); the in-memory LanguageService ' +
    'cannot answer it, and the tool says so instead of returning an empty list. Bounded to 50 results.',
  parameters: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'workspace_symbols is a bounded query, not a full index. It returns matching declarations with file and 1-based position.',
  timeoutMs: 20_000,
  async execute({ query, limit }, context): Promise<ToolResult> {
    if (!context.workspace) return toolError('没有配置工作区。');
    const chosen = await chooseProvider(context);
    if (chosen.kind === 'error') return chosen.result;
    const { provider, fallbackReason, release } = chosen;
    try {
      const result = await provider.workspaceSymbols({
        query,
        ...(limit ? { limit } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const note = backendNote(provider, fallbackReason, result.notes);
      const symbols = result.value.symbols;
      if (symbols.length === 0) {
        return toolOk(`没有找到匹配的工作区符号：${query}${note}`, {
          ...languageServerMeta(provider, fallbackReason, 'no workspace symbols'),
        });
      }
      const rows = symbols.map((symbol) =>
        symbol.path
          ? `${symbol.kind} ${symbol.name} — ${symbol.path}:${symbol.line}:${symbol.column}`
          : `${formatSymbol(symbol)}`,
      );
      const bounded = result.value.truncated ? '\n[结果已截断到 50 个]' : '';
      return toolOk(`工作区符号（${symbols.length}）：\n${rows.join('\n')}${bounded}${note}`, {
        ...languageServerMeta(provider, fallbackReason, `${symbols.length} workspace symbol(s)`, {
          symbols: symbols.length,
          truncated: result.value.truncated,
        }),
      });
    } catch (error) {
      return providerFailure(error, provider, fallbackReason);
    } finally {
      release();
    }
  },
});

export const semanticTools = [
  findDefinitionTool,
  findReferencesTool,
  listSymbolsTool,
  diagnosticsTool,
  workspaceSymbolsTool,
] as const;
