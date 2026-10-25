/**
 * Schema and argument plumbing shared by every tool.
 *
 * The schema is written once, as Zod, and serves two consumers: the model-facing
 * JSON Schema the provider receives, and the parse that runs before `execute`.
 * Keeping them in one place is what makes a tool description honest — a field
 * the model is told about but the parser rejects cannot exist.
 */

import { z } from 'zod';

/**
 * Convert a Zod schema to the JSON Schema a provider understands.
 *
 * `draft-7` rather than the newest draft because it is the one both the
 * Responses API and the compatible servers we have measured accept. `$schema` is
 * stripped: it is metadata for a validator, and the provider does not want a
 * document that declares its own dialect inside every tool definition.
 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export type ParsedArguments =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a tool call's arguments.
 *
 * A malformed JSON string is reported as a malformed JSON string. An earlier
 * version swallowed the failure into `{}`, so the model was told "path not
 * found: ''" and had no way to learn that its JSON was broken — it kept making
 * the same mistake while the error message blamed the filesystem.
 */
export function parseToolArguments(raw: string | null | undefined): ParsedArguments {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { ok: true, value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}); received: ${raw.slice(0, 300)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    };
  }
  return { ok: true, value: parsed };
}
