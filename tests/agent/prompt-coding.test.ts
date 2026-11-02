/**
 * The active prompt is a coding-agent prompt (ADR 023).
 *
 * The personality spec lives on in `companion.personality.md`, and its tests
 * still guard that file. What this file protects is the replacement: that the
 * model is told which tools it actually has, which path base each one uses, and
 * what "done" means. Those are the rules that failed in practice — a relative
 * delete at the wrong base, reported as success because the exit code was 0.
 */

import { describe, expect, it } from 'vitest';
import { STABLE_INSTRUCTIONS } from '../../src/agent/instructions.ts';

/** Split the document into level-one sections, the way it is organised. */
function sections(markdown: string): Map<string, string> {
  const found = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null) found.set(heading, body.join('\n').trim());
  };
  for (const line of markdown.split('\n')) {
    const match = /^# (.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1] as string;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return found;
}

const document = sections(STABLE_INSTRUCTIONS);

function section(heading: string): string {
  const body = document.get(heading);
  expect(body, `the prompt has no "# ${heading}" section`).toBeDefined();
  return body as string;
}

describe('the coding prompt', () => {
  it('keeps the Eunoia identity and asks for Chinese replies', () => {
    const identity = section('身份');
    expect(identity).toContain('Eunoia');
    expect(identity).toContain('回复用中文');
  });

  it('has the sections a coding turn needs', () => {
    for (const heading of ['工作方式', '工具纪律', '输出', '记忆规则', '安全', '现在的上下文']) {
      expect(document.has(heading), `missing section: # ${heading}`).toBe(true);
    }
  });

  it('names every tool the model is actually offered', () => {
    // A prompt that describes tools the model does not have is worse than one
    // that says nothing: it teaches a call the runtime will refuse.
    for (const tool of [
      'read_file',
      'list_dir',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'run_command',
      'change_directory',
      'load_skill',
      'search_memory',
      'save_memory',
      'update_memory',
    ]) {
      expect(STABLE_INSTRUCTIONS, `${tool} is not mentioned in the prompt`).toContain(tool);
    }
  });

  it('states the two path bases and the destructive-operation rule', () => {
    const tools = section('工具纪律');
    // The exact failure this guards: a relative path resolved against the task
    // directory while the model was thinking of the workspace root.
    expect(tools).toContain('工作区根目录');
    expect(tools).toContain('当前任务目录');
    expect(tools).toContain('/workspace/...');
    expect(tools).toContain('绝对路径');
    // And the other half: exit 0 is not evidence that the goal was reached.
    expect(section('工作方式')).toContain('退出码 0 不等于完成');
  });

  it('keeps memory and safety, compressed rather than dropped', () => {
    const memory = section('记忆规则');
    expect(memory).toContain('search_memory');
    expect(memory).toContain('不是全部记忆');
    expect(memory).toContain('user_explicit');

    const safety = section('安全');
    expect(safety).toContain('安全永远优先');
    expect(safety).toContain('心理治疗师');
    expect(safety).toContain('120');
  });

  it('does not carry the four lenses into the coding prompt', () => {
    // They remain in the archived document; putting them back here would make
    // this the personality prompt with extra steps.
    expect(STABLE_INSTRUCTIONS).not.toContain('# 四种视角');
    expect(STABLE_INSTRUCTIONS).not.toContain('## Fi');
  });
});
