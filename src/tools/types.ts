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
import type { Workspace } from './workspace.ts';

/**
 * What calling a tool can change.
 *
 * `memory_write` is separate from `workspace_write` on purpose: a memory is
 * reversible from the UI and is the companion's core job, while a workspace
 * write changes a file the person did not necessarily ask to change. Grouping
 * them would either make memory require a write approval every turn or make
 * file writes silently approved with it.
 */
export type ToolSideEffect = 'none' | 'memory_write' | 'workspace_write' | 'command';

/** What a tool returns to the loop. Always serialisable: it goes back to the model. */
export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
  readonly meta?: ToolResultMeta;
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
  /** Null when no workspace is configured; coding tools then refuse. */
  readonly workspace: Workspace | null;
  readonly policy: ToolPolicy;
  readonly ledger: ReadLedger;
  readonly signal?: AbortSignal;
  readonly now: Date;
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
  readonly parameters: z.ZodType;
  readonly sideEffect: ToolSideEffect;
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
