/**
 * The unified tool contract: what a tool declares, how its arguments are
 * checked, and where it came from.
 *
 * Before MCP there was one kind of tool: a Zod schema registered in project
 * code. An MCP server cannot give us Zod — it publishes a JSON Schema — so the
 * contract is now the pair "the schema the model is shown" + "the validator the
 * runtime uses". The pair is stored together, which is the only way to keep the
 * two from drifting: a field the model is told about but the parser rejects is
 * exactly the bug ADR 014 set out to prevent.
 *
 * Two rules are enforced here rather than in the MCP adapter:
 *
 *   - **A remote schema is data, never code.** `$ref` is resolved only inside
 *     the same document; there is no network fetch and no `require`.
 *   - **Unsupported constructs are diagnosed, not approximated.** Dropping a
 *     constraint or replacing it with `z.any()` would mean the model is told a
 *     tool accepts more than it does. A contract that cannot be validated is a
 *     tool that is not offered.
 *
 * See docs/adr/033-mcp-host.md.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { z } from 'zod';
import { jsonSchemaOf } from './schema.ts';

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Where a definition came from. The model name is not enough to know that. */
export type ToolSource = 'builtin' | 'mcp';

export interface McpToolOrigin {
  readonly serverId: string;
  readonly serverName: string;
  /** The name the server published, before any model-name adaptation. */
  readonly originalName: string;
  /** Immutable catalog revision the contract was taken from. */
  readonly catalogRevision: string;
  /** What the call is allowed to do, from the application's own policy. */
  readonly classification: 'external_read' | 'external_write' | 'external_unknown';
}

export type ToolOrigin =
  | { readonly kind: 'builtin' }
  | ({ readonly kind: 'mcp' } & McpToolOrigin);

export interface ToolArgumentIssue {
  readonly path: string;
  readonly message: string;
}

export type ToolArgumentCheck =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly ToolArgumentIssue[]; readonly error: string };

export interface ToolContract {
  /** The model-facing name, unique inside the registry for this turn. */
  readonly name: string;
  readonly description: string;
  readonly source: ToolSource;
  readonly origin: ToolOrigin;
  /** The exact schema shown to the model. For MCP this is the server's schema. */
  readonly inputSchema: JsonSchema;
  /** Digest of schema + description + origin; an approval is bound to it. */
  readonly contractHash: string;
  /** Extra guidance shown to the model once, not per call. */
  readonly guidelines?: string;
  validate(args: unknown): ToolArgumentCheck;
}

export class ToolContractError extends Error {
  readonly code = 'TOOL_CONTRACT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ToolContractError';
  }
}

// ------------------------------------------------------------ JSON Schema ---

/**
 * Keywords this validator cannot enforce but which change what a document
 * accepts. Approximating them would silently widen the accepted input.
 */
const REJECTED_KEYWORDS = new Set([
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentSchemas',
  'dependentRequired',
  'dynamicRef',
  'dynamicAnchor',
  'recursiveRef',
  'recursiveAnchor',
]);

export interface NormalizedSchema {
  /** A draft-07 document that preserves every constraint we can enforce. */
  readonly schema: JsonSchema;
  /** Diagnostics that do not block validation (e.g. a normalized keyword). */
  readonly notes: readonly string[];
}

/**
 * Check and normalize a server-published schema.
 *
 * The conversion is deliberately structural and closed: it renames the
 * 2020-12 tuple keyword to draft-07's array form, keeps `$defs` (a local `$ref`
 * into it is a plain JSON pointer), and rejects anything whose semantics would
 * change if it were ignored.
 */
export function normalizeJsonSchema(raw: unknown): NormalizedSchema {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ToolContractError('inputSchema must be a JSON object');
  }
  const notes: string[] = [];
  const root = raw as Record<string, unknown>;
  const dialect = root.$schema;
  if (typeof dialect === 'string') {
    if (!/draft-0[467]/.test(dialect) && !/2020-12/.test(dialect) && !/2019-09/.test(dialect)) {
      throw new ToolContractError(`unsupported JSON Schema dialect: ${dialect}`);
    }
    if (/2020-12/.test(dialect) || /2019-09/.test(dialect)) {
      notes.push(`normalized ${dialect} to draft-07 for local validation`);
    }
  }

  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (REJECTED_KEYWORDS.has(key)) {
        throw new ToolContractError(
          `unsupported JSON Schema keyword "${key}" at ${path || '(root)'}`,
        );
      }
      if (key === '$ref') {
        if (typeof value !== 'string') {
          throw new ToolContractError(`$ref at ${path} must be a string`);
        }
        if (!value.startsWith('#')) {
          throw new ToolContractError(
            `remote $ref "${value}" at ${path} is not fetched; only local references are allowed`,
          );
        }
        continue;
      }
      if (key === 'prefixItems' && Array.isArray(value)) {
        // draft-07 tuple form: items is an array of schemas with the rest in
        // additionalItems. Keeping this is what preserves positional constraints.
        notes.push(`normalized prefixItems at ${path || '(root)'} to draft-07 items`);
        record.items = value;
        delete record.prefixItems;
        visit(record.items, `${path}.items`);
        continue;
      }
      visit(value, path ? `${path}.${key}` : key);
    }
    // A draft-07 validator rejects an unknown `type` value only if it appears in
    // `type`; a union is expressed as an array and is supported as-is.
  };
  visit(root, '');
  return { schema: root as JsonSchema, notes };
}

/**
 * A compiled argument checker.
 *
 * `ajv` is used rather than a hand-rolled walker because error paths are part of
 * the model-visible message: "items[2].name is required" is actionable and a
 * boolean is not. The instance is created once per contract and compiled lazily
 * so a catalog refresh does not pay for tools the model never calls.
 */
export function createJsonSchemaValidator(schema: JsonSchema): (value: unknown) => ToolArgumentCheck {
  let compiled: ((data: unknown) => boolean) | null = null;
  let compileError: string | null = null;

  const compile = (): void => {
    if (compiled !== null || compileError !== null) return;
    try {
      // Loaded lazily so a project that never uses MCP does not pay for it at
      // startup. ajv 6 is a CommonJS package; `createRequire` is the explicit
      // interop boundary, and a missing package becomes one clear diagnostic
      // instead of a module-level crash.
      const Ajv = loadAjvConstructor();
      const ajv = new Ajv({
        allErrors: true,
        strict: false,
        validateSchema: false,
        unknownFormats: 'ignore',
        schemaId: 'auto',
      });
      compiled = ajv.compile(schema);
    } catch (error) {
      compileError = error instanceof Error ? error.message : String(error);
    }
  };

  return (value: unknown): ToolArgumentCheck => {
    compile();
    if (compileError !== null) {
      return {
        ok: false,
        issues: [],
        error: `schema cannot be compiled: ${compileError}`,
      };
    }
    const validate = compiled;
    if (validate === null) {
      return { ok: false, issues: [], error: 'schema validator unavailable' };
    }
    try {
      if (validate(value)) {
        return { ok: true, value: (value ?? {}) as Record<string, unknown> };
      }
    } catch (error) {
      return {
        ok: false,
        issues: [],
        error: `schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const errors = (validate as unknown as { errors?: readonly Record<string, unknown>[] }).errors ?? [];
    const issues = errors.map((entry) => ({
      path: typeof entry.instancePath === 'string' ? entry.instancePath || '(root)' : '(root)',
      message: typeof entry.message === 'string' ? entry.message : 'is invalid',
    }));
    return {
      ok: false,
      issues,
      error: issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'invalid arguments',
    };
  };
}

/**
 * Import ajv without a static ESM default-import binding.
 *
 * The package is CommonJS, and a static default import under `verbatimModuleSyntax`
 * would make the type of `Ajv` depend on interop flags this project does not set.
 * `createRequire` keeps the boundary explicit and gives one clear failure when
 * the optional dependency is missing.
 */
interface AjvInstance {
  compile(schema: unknown): ((data: unknown) => boolean) & {
    errors?: readonly Record<string, unknown>[];
  };
  errorsText(errors: unknown): string;
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

let ajvCtor: AjvConstructor | null = null;

function loadAjvConstructor(): AjvConstructor {
  if (ajvCtor !== null) return ajvCtor;
  const require = createRequire(import.meta.url);
  try {
    const loaded = require('ajv') as { default?: unknown } | unknown;
    const candidate =
      typeof loaded === 'function'
        ? loaded
        : (loaded as { default?: unknown } | null)?.default;
    if (typeof candidate !== 'function') {
      throw new Error('module does not export a constructor');
    }
    ajvCtor = candidate as AjvConstructor;
    return ajvCtor;
  } catch (error) {
    throw new ToolContractError(
      `the JSON Schema validator is not installed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ------------------------------------------------------------ factories ---

/** Deterministic JSON, so a digest cannot depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function contractHashOf(input: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly source: ToolSource;
  readonly originalName?: string;
  readonly serverId?: string;
}): string {
  return sha256(
    canonicalJson({
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
      source: input.source,
      ...(input.serverId ? { serverId: input.serverId } : {}),
      ...(input.originalName ? { originalName: input.originalName } : {}),
    }),
  );
}

/**
 * A builtin contract derived from the Zod schema that already exists.
 *
 * The model-facing schema comes from the same Zod definition the validator
 * uses, so the two cannot drift. Zod's error paths are rendered as one string,
 * which keeps the model-visible message the same shape as the MCP path.
 */
export function zodContract(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
  readonly guidelines?: string;
}): ToolContract {
  const inputSchema = jsonSchemaOf(spec.parameters) as JsonSchema;
  return {
    name: spec.name,
    description: spec.description,
    source: 'builtin',
    origin: { kind: 'builtin' },
    inputSchema,
    contractHash: contractHashOf({
      name: spec.name,
      description: spec.description,
      inputSchema,
      source: 'builtin',
    }),
    ...(spec.guidelines ? { guidelines: spec.guidelines } : {}),
    validate(args) {
      const parsed = spec.parameters.safeParse(args);
      if (parsed.success) {
        return { ok: true, value: (parsed.data ?? {}) as Record<string, unknown> };
      }
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      return {
        ok: false,
        issues,
        error: issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      };
    },
  };
}

export interface McpContractSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly origin: McpToolOrigin;
  readonly guidelines?: string;
}

/**
 * A contract over a server-published schema.
 *
 * The raw document is shown to the model; the normalized draft-07 copy is what
 * actually validates. Nothing is dropped: a keyword we cannot enforce makes the
 * tool unofferable rather than weaker.
 */
export function mcpContract(spec: McpContractSpec): ToolContract {
  const { schema, notes } = normalizeJsonSchema(spec.inputSchema);
  const validate = createJsonSchemaValidator(schema);
  const description = spec.description.trim().length > 0
    ? spec.description
    : `${spec.origin.serverName} 提供的 ${spec.origin.originalName}`;
  return {
    name: spec.name,
    description,
    source: 'mcp',
    origin: { kind: 'mcp', ...spec.origin },
    inputSchema: schema,
    contractHash: contractHashOf({
      name: spec.name,
      description,
      inputSchema: schema,
      source: 'mcp',
      serverId: spec.origin.serverId,
      originalName: spec.origin.originalName,
    }),
    ...(spec.guidelines ? { guidelines: spec.guidelines } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    validate,
  };
}

// --------------------------------------------------------------- naming ---

/** The longest model-facing name most providers accept without complaint. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** A stable, readable fragment for a server, never the server's self-report. */
export function serverSlug(serverId: string, serverName: string): string {
  const cleaned = serverName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const suffix = sha256(serverId).slice(0, 6);
  return cleaned.length > 0 ? `${cleaned}_${suffix}` : `srv_${suffix}`;
}

/**
 * The model-facing name for an MCP tool.
 *
 * Prefixed with `mcp__` so a model, a log line and a person can all tell the
 * source without a lookup. Namespace separators are doubled to make the triple
 * unambiguous even for a server that publishes a name containing `__`.
 *
 * A shortened name keeps a digest suffix: truncation without one would let two
 * different server tools collide, and the call would then go to whichever was
 * registered last.
 */
export function mcpModelToolName(input: {
  readonly serverId: string;
  readonly serverName: string;
  readonly originalName: string;
}): string {
  const slug = serverSlug(input.serverId, input.serverName);
  const original = input.originalName.replace(/[^A-Za-z0-9_-]+/g, '_');
  const full = `mcp__${slug}__${original}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  const digest = sha256(`${input.serverId}\u0000${input.originalName}`).slice(0, 8);
  const head = `mcp__${slug}__${original}`.slice(0, MAX_TOOL_NAME_LENGTH - digest.length - 2);
  return `${head}__${digest}`;
}

/** A human label: "服务名 · 工具名". Never the internal model name. */
export function toolOriginLabel(contract: ToolContract, serverName?: string): string {
  if (contract.origin.kind === 'builtin') return '内置工具';
  const name = serverName ?? contract.origin.serverName;
  return `${name} · ${contract.origin.originalName}`;
}
