/**
 * The tool registry: what this turn can call, and what the model is told about
 * it.
 *
 * Two properties are enforced here rather than left to callers:
 *
 *   - **Names are unique.** Two tools with one name make dispatch depend on
 *     registration order, which is the kind of bug that looks like a model
 *     failure.
 *   - **The schema shown to the model is derived from the parser.** There is no
 *     hand-maintained JSON Schema that can drift from the Zod schema actually
 *     used to validate the call.
 *
 * The registry holds definitions, not executions. Policy, timeouts, the ledger
 * and the event stream belong to the loop; a tool cannot approve itself.
 */

import { jsonSchemaOf } from './schema.ts';
import type { ToolDefinition, ToolSchema } from './types.ts';

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[] = []) {
    this.registerAll(definitions);
  }

  register(tool: ToolDefinition): this {
    if (this.byName.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
    return this;
  }

  registerAll(definitions: readonly ToolDefinition[]): this {
    for (const tool of definitions) this.register(tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Registration order, which is stable for a given factory. */
  list(): readonly ToolDefinition[] {
    return [...this.byName.values()];
  }

  names(): readonly string[] {
    return this.list().map((tool) => tool.name);
  }

  isEmpty(): boolean {
    return this.byName.size === 0;
  }

  /** The declarations sent to the model. */
  schemas(): readonly ToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaOf(tool.parameters),
    }));
  }

  /**
   * A "Using the tools" section derived from what is actually on offer.
   *
   * WhalePod's point, adopted: a readonly session should not carry instructions
   * for a write tool it does not have. A static block always lists every tool,
   * so the model is told about capabilities that will refuse it.
   */
  guidelines(): string {
    const entries = this.list()
      .map((tool) => tool.guidelines?.trim())
      .filter((line): line is string => Boolean(line));
    return entries.join('\n');
  }
}
