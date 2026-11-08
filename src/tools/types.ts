/**
 * The tool system's vocabulary, with no vendor SDK and no I/O in it.
 *
 * A tool is a name, a schema, a side-effect class and an async function. That is
 * deliberately smaller than the Agents SDK's `FunctionTool`: the loop that calls
 * tools should not need to know how a provider serialises one, and a tool should
 * not need to know which loop is calling it.
 *
 * The side-effect class is the piece that makes approval possible without
 * trusting the model. A tool cannot describe itself as read-only at call time;
 * the class is declared where the tool is defined, and the policy is checked
 * before `execute` ever runs.
 *
 * See docs/adr/014-coding-tools-and-agent-loop.md.
 */

import type { z } from 'zod';
import type { ToolContract } from './contract.ts';
import { zodContract } from './contract.ts';

/**
 * What calling a tool can change.
 *
 * `memory_write` is separate from `workspace_write` on purpose: a memory is
 * reversible from the UI and is the companion's core job, while a workspace
 * write changes a file the person did not necessarily ask to change. Grouping
 * them would either make memory require a write approval every turn or make
 * file writes silently approved with it.
 */
export type ToolSideEffect =
  | 'none'
  | 'memory_write'
  | 'workspace_write'
  | 'command'
  /**
   * A change to the task's execution state rather than to a file (ADR 021).
   *
   * `change_directory` is the only member: it moves where later commands start
   * without touching the filesystem, so it needs its own class rather than being
   * either "read-only" (it changes ordering) or "workspace_write" (it does not
   * write anything).
   */
  | 'workspace_state'
  /**
   * An MCP call that only reads from an external service (ADR 033).
   *
   * The class is decided by the application's policy, never by the server's
   * `readOnlyHint`: a server that describes itself as harmless is still an
   * external party executing code we did not write.
   */
  | 'external_read'
  | 'external_write'
  /** An external call whose effect the application cannot classify. */
  | 'external_unknown';

/**
 * One ordered block of a tool result.
 *
 * `output` on `ToolResult` stays the stable text projection old tools and old
 * clients read. `content` is the authority when present: the text projection is
 * derived from it at the boundary, so the two can never disagree about order or
 * about which images were really returned.
 */
export type ToolContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      /** Private media asset id. Never a remote URL and never raw bytes. */
      readonly assetId: string;
      readonly mediaType: string;
      readonly width: number;
      readonly height: number;
      readonly bytes: number;
      readonly name: string;
      /** Tool results are not user uploads; the model must be able to see that. */
      readonly source: 'tool';
    }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name?: string;
      readonly mimeType?: string;
      readonly description?: string;
    }
  | {
      readonly type: 'embedded_text';
      readonly uri: string;
      readonly mimeType: string;
      readonly text: string;
    }
  | {
      /** A non-image binary kept in private storage; never a local path. */
      readonly type: 'artifact';
      readonly artifactId: string;
      readonly mimeType: string;
      readonly bytes: number;
      name?: string;
    };

/** What a tool returns to the loop. Always serialisable: it goes back to the model. */
export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
  readonly meta?: ToolResultMeta;
  /** Ordered result blocks. Absent on the legacy string-only path. */
  readonly content?: readonly ToolContentBlock[];
  /** `structuredContent` from an MCP result, kept separate from the text. */
  readonly structuredContent?: unknown;
  /**
   * Failed, but the failure is a pending human interaction rather than an
   * error the model should retry. The loop stops and the UI asks.
   */
  readonly pendingInteraction?: { readonly interactionId: string; readonly summary: string };
}

/**
 * Structured values a tool may attach.
 *
 * `summary` is the only field the UI sees. The rest is internal: a read record
 * feeds the context ledger, and a command's exit code is kept for the trace and
 * for tests. Tool output itself is never put on the wire just to draw a row.
 */
export interface ToolResultMeta {
  readonly summary?: string;
  readonly truncated?: boolean;
  readonly read?: ReadRecord;
  /**
   * Set when the call was stopped by the permission layer.
   *
   * The ids are what a person needs to approve the request, and the error text
   * alone is not a contract: it is prose the model may paraphrase. Keeping them
   * here lets the transport put them on the wire without parsing a message.
   */
  readonly approval?: {
    readonly requestId: string | null;
    readonly approvalRequestId: string | null;
  };
  readonly [key: string]: unknown;
}

/** The model-facing declaration of a tool. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** One tool call, as the model produced it. */
export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  /** JSON, exactly as the model sent it. Parsed by the loop, not by the tool. */
  readonly arguments: string;
}

/**
 * What the loop knows about a file that has already been shown in this turn.
 *
 * The point is to avoid shipping the same bytes twice: a re-read of an unchanged
 * range returns a pointer to the earlier result instead of the content. WhalePod
 * calls this a context ledger, and the reason it belongs here rather than in the
 * prompt is that the model cannot reliably remember what it read two tool calls
 * ago.
 */
export interface ReadRecord {
  /** Path as the model named it, normalised to a workspace-relative path. */
  readonly path: string;
  /** 1-based inclusive line range that was actually delivered. */
  readonly start: number;
  readonly end: number;
  /** True only when the result was the complete file, not a truncated slice. */
  readonly complete: boolean;
  readonly chars: number;
  readonly mtimeMs: number;
  readonly size: number;
  /** SHA-256 of the delivered text, used for write-time version checks (R03). */
  readonly sha256?: string;
}

/** A per-turn ledger of file content already delivered to the model. */
export interface ReadLedger {
  /** A previous delivery that still answers this read, or null. */
  check(input: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
    readonly mtimeMs: number;
    readonly size: number;
  }): ReadRecord | null;
  record(record: ReadRecord): void;
  /** Whether any part of this path was delivered in this turn. */
  has(path: string): boolean;
  /**
   * Whether the whole file was delivered in this turn.
   *
   * `write` replaces the entire content, so a partial read is not enough to
   * justify it: the model has seen some of the file, not the file. When a
   * version is given, the record must match it — a complete read of the version
   * that was on disk a moment ago does not justify overwriting a file somebody
   * else has changed since.
   */
  hasComplete(path: string, version?: { readonly mtimeMs: number; readonly size: number }): boolean;
  /** Digest of a complete delivery for this version, or null (R03). */
  digestFor(
    path: string,
    version?: { readonly mtimeMs: number; readonly size: number },
  ): string | null;
}

/**
 * What the process allows tools to do.
 *
 * Fail-closed: both booleans default to false, and the loop refuses a write or a
 * command before it reaches the tool. There is no per-call callback because the
 * chat transport is a one-way SSE stream; consent is given before the turn, not
 * halfway through it.
 */
export interface ToolPolicy {
  readonly allowWorkspaceWrites: boolean;
  readonly allowCommands: boolean;
  /** Hard cap on one tool result, after the tool's own truncation. */
  readonly maxOutputChars: number;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowWorkspaceWrites: false,
  allowCommands: false,
  maxOutputChars: 60_000,
};

/** Everything a tool may use while it runs. */
export interface ToolContext {
  /**
   * The file-operation port for this turn. Null when no workspace is configured;
   * coding tools then refuse. The implementation is the Sandbox Gateway, not a
   * host directory: tools never choose where a path lands.
   */
  readonly workspace: ToolWorkspacePort | null;
  /** The command port. Null means "no sandbox configured"; commands refuse. */
  readonly executor?: ToolExecutor | null;
  /**
   * The task working-directory port (ADR 021). Null means the run has no
   * sandbox-backed cwd, so `change_directory` refuses rather than pretending.
   */
  readonly cwd?: ToolCwdPort | null;
  /** The model's call id, used as the execution idempotency key. */
  readonly toolCallId?: string;
  /** True when the ports come from the Sandbox Gateway and enforce policy. */
  readonly sandboxed?: boolean;
  readonly policy: ToolPolicy;
  readonly ledger: ReadLedger;
  readonly signal?: AbortSignal;
  readonly now: Date;
  /**
   * The unified authorization port (ADR 033).
   *
   * Present on a turn that may call an MCP tool. A tool never decides its own
   * approval: it asks this port, which knows the owner, the conversation, the
   * account and the persisted interaction.
   */
  readonly permission?: ToolPermissionPort | null;
  /** Private media import for tool-returned images. */
  readonly media?: ToolMediaPort | null;
  /** The conversation this turn belongs to, for ownership on imported media. */
  readonly conversationId?: string;
  readonly userId?: string;
  /** The persisted action id, when the turn is backed by a durable record. */
  readonly actionId?: string;
  /**
   * Who this call runs as, and the intersected ceiling (R02).
   *
   * Injected by the server; a model argument can never set or widen it.
   */
  readonly scope?: import('./scope.ts').ExecutionScope;
  /**
   * Undo journal: called before a tool overwrites or deletes a file.
   *
   * Present only when turn undo is armed. A patch that cannot journal its files
   * still applies, but the turn cannot offer a precise undo; the UI simply has
   * no button for it.
   */
  readonly changes?: ToolChangeJournal | null;
  /**
   * Where a host-side language server may run for this turn (ADR 037 / R10).
   *
   * Absent means "no host workspace root is known": the semantic tools stay on
   * the in-memory TypeScript LanguageService and say so. The value is injected by
   * the composition root from the sandbox session; a model argument can never
   * supply or widen it.
   */
  readonly language?: ToolLanguagePort | null;
}

/**
 * The host location a language server may use as its workspace root.
 *
 * `hostRoot` is the real project directory when the workspace is bound to one.
 * When only a copy or mirror exists, `allowMirror` asks the semantic layer to
 * create a bounded temporary mirror and label every result as a mirror; it is
 * never presented as the real project.
 */
export interface ToolLanguagePort {
  /** Absolute host directory of the workspace, when tools share the host tree. */
  readonly hostRoot?: string | null;
  /** Permit a bounded temp mirror when `hostRoot` is absent. */
  readonly allowMirror?: boolean;
}

export interface ToolChangeJournal {
  beforeWrite(path: string): Promise<void>;
  /**
   * R03: version-checked write/edit under the workspace lock.
   *
   * Absent means the caller has no undo/journal context; the tool falls back to
   * the workspace port, which still enforces path and policy checks.
   */
  writeText?(input: {
    readonly path: string;
    readonly content: string;
    readonly expectedSha: string | null;
  }): Promise<{ readonly path: string; readonly bytes: number; readonly lines: number; readonly created: boolean }>;
  editText?(input: {
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll: boolean;
    readonly expectedSha: string | null;
  }): Promise<{ readonly path: string; readonly replacements: number; readonly bytes: number }>;
  /** Hold the internal write locks for every target path, in stable order. */
  lockPaths?<T>(paths: readonly string[], run: () => Promise<T>): Promise<T>;
  beginBatch?(input: {
    readonly batchId: string;
    readonly paths: readonly string[];
    readonly before: Readonly<Record<string, string | null>>;
    readonly after: Readonly<Record<string, string | null>>;
  }): Promise<void>;
  markBatchApplied?(batchId: string, path: string, afterSha: string | null): Promise<void>;
  completeBatch?(batchId: string): Promise<void>;
  markBatchReconciliation?(batchId: string, reasons: readonly string[]): Promise<void>;
}

// ------------------------------------------------------------------- ports ---

/**
 * What a coding tool needs from a workspace.
 *
 * Structurally satisfied by `WorkspaceFiles` (the host-side file engine the
 * Gateway owns) and by the Gateway-backed adapter. Defining it here rather than
 * importing the sandbox module keeps the dependency pointing one way: tools do
 * not know that a sandbox exists, only that something can answer these calls.
 */
export interface ToolWorkspacePort {
  /** Host path → workspace-relative path, for skill resource paths. */
  relative(hostPath: string): string;
  readLines(input: string, start?: number, end?: number): Promise<ToolFileSlice>;
  /**
   * Resolve a path and report whether it exists, without reading its content.
   *
   * `write` needs this before it overwrites anything: the guard is "an existing
   * file must have been read this turn", and deciding that requires knowing
   * whether the target exists. A path that does not exist is a create, which
   * needs no prior read.
   */
  stat(input: string): Promise<ToolFileStat | null>;
  /** Raw bytes under the same path guard; used by image reads, never by write. */
  readBytes?(input: string, maxBytes?: number): Promise<Uint8Array>;
  /** Delete one file; absent means the workspace is read-only. */
  deleteFile?(input: string): Promise<{ readonly path: string }>;
  listDir(input?: string, depth?: number): Promise<ToolDirectoryListing>;
  glob(pattern: string, maxResults?: number): Promise<{ paths: string[]; truncated: boolean }>;
  grep(options: {
    pattern: string;
    path?: string;
    include?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<ToolGrepResult>;
  writeText(input: string, content: string): Promise<ToolWriteResult>;
  editText(options: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<ToolEditResult>;
}

export interface ToolFileSlice {
  readonly text: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly totalLines: number;
  readonly complete: boolean;
  readonly chars: number;
  readonly mtimeMs: number;
  readonly size: number;
}

/** What `stat` returns for a path that exists; `null` means it does not. */
export interface ToolFileStat {
  /** Workspace-relative path, already normalised by the path guard. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ToolDirectoryListing {
  readonly text: string;
  readonly path: string;
  readonly entries: number;
  readonly truncated: boolean;
}

export interface ToolGrepResult {
  readonly text: string;
  readonly matches: number;
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface ToolWriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
  readonly created: boolean;
}

export interface ToolEditResult {
  readonly path: string;
  readonly replacements: number;
  readonly bytes: number;
}

/**
 * The command boundary.
 *
 * A tool asks for a command; the implementation decides whether it runs, where,
 * and with what timeout. The sandbox is the only implementation wired in
 * production. There is no `cwd` or environment field here on purpose: the model
 * does not choose a host directory or a process environment.
 */
export interface ToolExecutor {
  run(input: {
    readonly command: readonly string[];
    readonly shell?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly toolCallId: string;
  }): Promise<ToolExecutionResult>;
  /**
   * A raw TCP tunnel to one loopback port inside the execution environment.
   *
   * Preview ingress uses it; no model-facing tool exposes it. Implementations
   * must keep the same sandbox boundary as `run` and must refuse a port outside
   * the configured preview range.
   */
  tunnel?(input: {
    readonly port: number;
    readonly signal?: AbortSignal;
  }): Promise<import('node:stream').Duplex>;
}

/**
 * The task working-directory boundary (ADR 021 §5).
 *
 * The model supplies a path and nothing else. `taskId`, `workspaceRoot` and the
 * current version are runtime state: a tool that accepted them would let the
 * agent name its own context, which is exactly what the ADR forbids.
 */
export interface ToolCwdPort {
  change(input: { readonly path: string; readonly operationId?: string }): Promise<ToolCwdChange>;
  current(): Promise<ToolCwdSnapshot>;
}

export interface ToolCwdSnapshot {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly cwdVersion: number;
}

export type ToolCwdChange =
  | {
      readonly ok: true;
      readonly previousCwd: string;
      readonly cwd: string;
      readonly cwdVersion: number;
      readonly workspaceRoot: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message: string;
      /** The directory the task was in when the request was made. */
      readonly currentCwd?: string;
      /** The absolute path the requested relative path resolved to. */
      readonly resolvedPath?: string;
      readonly workspaceRoot?: string;
    };

export interface ToolSandboxSession {
  readonly workspace: ToolWorkspacePort;
  readonly executor: ToolExecutor;
  /** The task's working directory (ADR 021); `change_directory` acts on it. */
  readonly cwd: ToolCwdPort;
  /** The path shown to the model; always the container mount, never a host path. */
  readonly displayPath: string;
  /**
   * Host root for the language server, when the sandbox has a real workspace
   * directory. Optional so a test double that only reads files stays valid.
   */
  readonly language?: ToolLanguagePort | null;
}

export interface ToolExecutionResult {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'UNKNOWN';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly executionId?: string;
  /**
   * The task directory the command ran in (ADR 021).
   *
   * Relative paths inside a shell command resolve against this, not against the
   * workspace root the file tools use. The tool puts it in the result so the
   * model — and the trace — can see which base a relative path had.
   */
  readonly cwd?: string;
}

/**
 * A tool the loop can offer to a model.
 *
 * `execute` receives already-parsed arguments. The registry parses them once,
 * so a tool never has to decide whether a missing field means "the model omitted
 * it" or "the JSON was broken".
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /**
   * The validator for this tool.
   *
   * Builtin tools carry a Zod schema; an MCP tool carries a JSON Schema and a
   * `contract`, and this field is a passthrough so the two kinds share one
   * definition shape. The registry and the loop always prefer `contract`, which
   * is why the passthrough can never weaken an MCP tool.
   */
  readonly parameters: z.ZodType;
  /** The authoritative declaration and validator (ADR 033). */
  readonly contract?: ToolContract;
  /** Provenance when `contract` is absent or when the UI needs it cheaply. */
  readonly origin?: import('./contract.ts').ToolOrigin;
  readonly sideEffect: ToolSideEffect;
  /** Whether the application has declared the call safe to retry. */
  readonly idempotent?: boolean;
  /**
   * Whether several calls of this tool may run concurrently within one model
   * step. Reads are; writes are not, because two writes to one file racing is
   * not a theoretical problem.
   */
  readonly readOnly: boolean;
  /** Derived from the tool actually on offer, and shown to the model once. */
  readonly guidelines?: string;
  /** Wall-clock bound for one call. Omitted means the loop's default. */
  readonly timeoutMs?: number;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/**
 * Define a tool with a typed schema and check its arguments in the registry.
 *
 * The cast is the one place the type of `args` is asserted rather than inferred:
 * `ToolDefinition` holds a `z.ZodType` so definitions with different schemas can
 * share a list, and the registry validates against that schema before calling
 * `execute`. A tool that skipped the registry would be the only way to see
 * unchecked arguments.
 */
export function defineTool<Schema extends z.ZodType>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Schema;
  readonly sideEffect: ToolSideEffect;
  readonly readOnly: boolean;
  readonly guidelines?: string;
  readonly timeoutMs?: number;
  execute(args: z.infer<Schema>, context: ToolContext): Promise<ToolResult>;
}): ToolDefinition {
  return {
    ...spec,
    contract: zodContract({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      ...(spec.guidelines ? { guidelines: spec.guidelines } : {}),
    }),
    origin: { kind: 'builtin' },
    execute: (args, context) => spec.execute(args as z.infer<Schema>, context),
  };
}

export function toolOk(output: string, meta?: ToolResultMeta): ToolResult {
  return { ok: true, output, ...(meta ? { meta } : {}) };
}

export function toolError(error: string, meta?: ToolResultMeta): ToolResult {
  return { ok: false, output: '', error, ...(meta ? { meta } : {}) };
}

/**
 * The model-facing text of a result.
 *
 * An error is prefixed rather than sent as bare prose: the model has to be able
 * to tell "the command returned this" from "the command did not run", and the
 * loop keeps the tool result and the tool error in separate fields for the UI.
 */
export function renderToolResult(result: ToolResult): string {
  if (result.ok) return result.output;
  const error = `ERROR: ${result.error?.trim() || result.output || 'tool failed'}`;
  // A failed command still has stdout/stderr worth reading: the failing
  // assertion lives in the output, not in the exit code. Dropping it because
  // `ok` is false is how the model ends up fixing the wrong thing.
  return result.output.trim().length > 0 ? `${error}\n${result.output}` : error;
}


// -------------------------------------------------- authorization contract ---

/**
 * One authorization question, already bound to the exact action.
 *
 * The digest of the arguments is part of the request on purpose: an approval
 * for `write(file="a")` must not authorize `write(file="b")` if the model's
 * call was edited between the question and the answer.
 */
export interface ToolPermissionRequest {
  readonly tool: ToolDefinition;
  readonly contract: ToolContract;
  readonly args: Record<string, unknown>;
  readonly callId: string;
  readonly userId: string | null;
  readonly conversationId: string | null;
  readonly summary: string;
  /** The server-resolved execution identity; never taken from tool arguments. */
  readonly scope?: import('./scope.ts').ExecutionScope;
}

/**
 * What the policy says about one call.
 *
 * `wait` is not a denial: it means a person must decide, and the loop is
 * expected to stop and surface the interaction rather than ask the model to try
 * again. That distinction is the difference between an approval flow and a
 * model that keeps retrying a blocked call.
 */
export type ToolPermissionDecision =
  | { readonly kind: 'allow'; readonly grantId?: string; readonly actionId?: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | {
      readonly kind: 'wait';
      readonly interactionId: string;
      readonly summary: string;
      readonly expiresAt?: Date;
      /** The persisted action this decision is about. */
      readonly actionId?: string;
    };

export type ToolPermissionResolution =
  | { readonly kind: 'allow'; readonly grantId?: string; readonly actionId?: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | {
      readonly kind: 'unknown';
      /** Why the wait ended without a decision (expired, cancelled, restart). */
      readonly reason: string;
    };

export interface ToolPermissionPort {
  decide(request: ToolPermissionRequest): Promise<ToolPermissionDecision>;
  /**
   * Block until the person answers, the interaction expires, or the turn is
   * cancelled. A restart cannot resolve a wait: the interaction stays persisted
   * and an explicit resume action answers it.
   */
  awaitDecision(
    interactionId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<ToolPermissionResolution>;
}

// ------------------------------------------------------------ media import ---

export interface ImportedToolImage {
  readonly assetId: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly name: string;
}

export interface ToolMediaPort {
  /**
   * Store bytes a server returned as a private, conversation-scoped asset.
   *
   * The caller supplies the action id so the asset can be traced back to the
   * call that produced it, and so a cleanup can find it. The bytes are decoded
   * and bounded by the same limits as an upload; a corrupt or unsupported image
   * is reported, never stored as if it were valid.
   */
  importToolImage(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly actionId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }): Promise<ImportedToolImage>;
}
