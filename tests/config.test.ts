/**
 * Process configuration, which is the entire consent surface for file access.
 *
 * The defaults are the test: no `WORKSPACE_ROOT` means no file tools, and a
 * root without the two explicit switches means reads only. A regression here
 * would not fail loudly — it would quietly hand a model a writable directory —
 * so it gets its own file.
 */

import { describe, expect, it } from 'vitest';
import { agentMaxSteps, envFlag, workspaceConfig } from '../src/config.ts';

describe('workspaceConfig', () => {
  it('returns null when no root is configured', () => {
    expect(workspaceConfig({})).toBeNull();
    expect(workspaceConfig({ WORKSPACE_ROOT: '   ' })).toBeNull();
  });

  it('defaults writes and commands to off', () => {
    const config = workspaceConfig({ WORKSPACE_ROOT: '/tmp/repo' });
    expect(config).toMatchObject({
      root: '/tmp/repo',
      writes: false,
      commands: false,
      allowSensitive: false,
    });
  });

  it('reads the two permissions separately', () => {
    expect(workspaceConfig({ WORKSPACE_ROOT: '/tmp/repo', WORKSPACE_WRITES: '1' })?.writes).toBe(
      true,
    );
    expect(
      workspaceConfig({ WORKSPACE_ROOT: '/tmp/repo', WORKSPACE_WRITES: '1' })?.commands,
    ).toBe(false);
    expect(
      workspaceConfig({ WORKSPACE_ROOT: '/tmp/repo', WORKSPACE_COMMANDS: 'true' })?.commands,
    ).toBe(true);
  });

  it('splits and trims the ignore list', () => {
    const config = workspaceConfig({
      WORKSPACE_ROOT: '/tmp/repo',
      WORKSPACE_IGNORE: ' reference, vendor , ',
    });
    expect(config?.ignore).toEqual(['reference', 'vendor']);
  });

  it('only accepts affirmative boolean spellings', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) expect(envFlag(value)).toBe(true);
    for (const value of ['0', 'false', 'no', 'off', '', undefined]) expect(envFlag(value)).toBe(false);
  });
});

describe('agentMaxSteps', () => {
  it('defaults to 12', () => {
    expect(agentMaxSteps({})).toBe(12);
  });

  it('clamps rather than accepting a runaway or a zero', () => {
    expect(agentMaxSteps({ AGENT_MAX_STEPS: '0' })).toBe(1);
    expect(agentMaxSteps({ AGENT_MAX_STEPS: '1000' })).toBe(50);
    expect(agentMaxSteps({ AGENT_MAX_STEPS: 'nonsense' })).toBe(12);
  });
});
