/**
 * The workbench's exposure defaults.
 *
 * The terminal used to follow the bind address: loopback meant "local", local
 * meant "a shell". Loopback binding does not stop DNS rebinding, so the default
 * is now off and turning it on is an explicit operator decision. This is a
 * security default, not a preference, so it gets a test.
 */

import { describe, expect, it } from 'vitest';
import { workspaceUiConfig, workspaceUiTerminalEnabled } from '../../src/workspace-ui/config.ts';

describe('the workbench terminal default', () => {
  it('is off when nothing asks for it, even on loopback', () => {
    expect(workspaceUiTerminalEnabled({})).toBe(false);
    expect(workspaceUiConfig({ loopback: true, env: {} }).terminal).toBe(false);
  });

  it('turns on only for an explicit truthy value', () => {
    expect(workspaceUiTerminalEnabled({ WORKSPACE_TERMINAL: '1' })).toBe(true);
    expect(workspaceUiTerminalEnabled({ WORKSPACE_TERMINAL: 'true' })).toBe(true);
  });

  it('stays off for an explicit false or an unparseable value', () => {
    expect(workspaceUiTerminalEnabled({ WORKSPACE_TERMINAL: '0' })).toBe(false);
    expect(workspaceUiTerminalEnabled({ WORKSPACE_TERMINAL: 'maybe' })).toBe(false);
  });
});
