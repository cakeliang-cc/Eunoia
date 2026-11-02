/**
 * The coding tool descriptions are contracts, not essays.
 *
 * ADR 023 moved the "when to call" prose into the system prompt's tool
 * discipline and aligned the catalog with DSH: English, one short paragraph per
 * tool. What stays here is what the schema cannot say: what the tool returns,
 * and the one or two hard constraints a wrong call violates.
 */

import { describe, expect, it } from 'vitest';
import { codingTools } from '../../src/tools/coding/index.ts';
import { jsonSchemaOf } from '../../src/tools/schema.ts';

const byName = new Map(codingTools.map((tool) => [tool.name, tool.description]));

describe('coding tool descriptions', () => {
  it('are short contracts, not when-to-call essays', () => {
    for (const tool of codingTools) {
      // bash is a paragraph by design: its constraints (fresh shell, cwd line,
      // destructive targets) do not fit in one sentence.
      const limit = tool.name === 'bash' ? 800 : 400;
      expect(tool.description.length, `${tool.name} description is too long`).toBeLessThan(limit);
      expect(tool.description, `${tool.name} restates a when-to-call section`).not.toContain(
        '什么时候调用',
      );
    }
  });

  it('keep the facts the schema cannot express', () => {
    // What the result looks like.
    expect(byName.get('read')).toContain('line-numbered');
    expect(byName.get('glob')).toContain('200');
    expect(byName.get('grep')).toContain('100');

    // What a wrong call hits.
    expect(byName.get('write')).toContain('fully replace');
    const edit = codingTools.find((tool) => tool.name === 'edit');
    const editSchema = jsonSchemaOf(edit!.parameters) as {
      properties?: Record<string, { description?: string }>;
    };
    expect(editSchema.properties?.replace_all?.description).toContain('exactly once');

    // The two path bases and the destructive-command rule, which a relative
    // delete at the wrong base made expensive to learn.
    expect(byName.get('bash')).toContain('working directory');
    expect(byName.get('bash')).toContain('change_directory');
    expect(byName.get('bash')).toContain('absolute');
    expect(byName.get('change_directory')).toContain('task directory');
  });

  it('tell the model the file tools are workspace-root relative', () => {
    // The base belongs on the path parameter, not in the description: that is
    // where a model looks while filling the argument in.
    for (const name of ['read', 'write', 'edit']) {
      const tool = codingTools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      const schema = jsonSchemaOf(tool!.parameters) as {
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.properties?.file_path?.description, `${name} path has no base`).toContain(
        'workspace root',
      );
    }
  });
});
