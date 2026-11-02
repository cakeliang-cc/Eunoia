/**
 * The coding tool descriptions are contracts, not essays.
 *
 * ADR 023 moved the "when to call" prose into the system prompt's tool
 * discipline. What stays here is what the schema cannot say: what the tool
 * returns, and the one or two hard constraints a wrong call violates. These
 * tests keep that shape — a description that grows a "什么时候调用" section
 * again has started duplicating the prompt.
 */

import { describe, expect, it } from 'vitest';
import { codingTools } from '../../src/tools/coding/index.ts';
import { jsonSchemaOf } from '../../src/tools/schema.ts';

const byName = new Map(codingTools.map((tool) => [tool.name, tool.description]));

describe('coding tool descriptions', () => {
  it('are short contracts, not when-to-call essays', () => {
    for (const tool of codingTools) {
      expect(tool.description.length, `${tool.name} description is too long`).toBeLessThan(400);
      expect(tool.description, `${tool.name} restates a when-to-call section`).not.toContain(
        '什么时候调用',
      );
    }
  });

  it('keep the facts the schema cannot express', () => {
    // What the result looks like.
    expect(byName.get('read_file')).toContain('行号');
    expect(byName.get('glob')).toContain('200');
    expect(byName.get('grep')).toContain('100');

    // The failure modes a wrong call hits.
    expect(byName.get('write_file')).toContain('edit_file');
    expect(byName.get('edit_file')).toContain('replace_all');

    // The two path bases and the destructive-command rule, which a relative
    // delete at the wrong base made expensive to learn.
    expect(byName.get('run_command')).toContain('当前目录');
    expect(byName.get('run_command')).toContain('change_directory');
    expect(byName.get('run_command')).toContain('绝对');
    expect(byName.get('change_directory')).toContain('当前任务目录');
  });

  it('tell the model the file tools are workspace-root relative', () => {
    // The base belongs on the path parameter, not in the description: that is
    // where a model looks while filling the argument in.
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      const tool = codingTools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      const schema = jsonSchemaOf(tool!.parameters) as {
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.properties?.path?.description, `${name} path has no base`).toContain(
        '工作区根目录',
      );
    }
  });
});
