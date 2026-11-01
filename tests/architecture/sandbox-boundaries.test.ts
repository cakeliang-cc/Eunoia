/**
 * The sandbox boundaries, enforced mechanically.
 *
 * Three rules are load-bearing enough that a comment would not survive the first
 * hurried commit:
 *
 *   1. **Only the Runtime Manager spawns a container client.** If a tool or the
 *      agent loop imported `node:child_process`, the old host-execution path
 *      would be one line away from coming back.
 *   2. **Only the Gateway exposes sandbox operations.** Service and agent code
 *      may speak `ToolExecutor`/`ToolWorkspacePort`; they must not reach for a
 *      Controller, runtime provider or store.
 *   3. **The egress proxy is the only sandbox module that speaks HTTP/Net.**
 *      Everything else stays transport-agnostic.
 */

import { describe, expect, it } from 'vitest';
import { importSpecifiers, readSources } from '../helpers/sources.ts';

// `src/workspace-ui/` is the person's workbench: a UI-initiated git reader and
// terminal helper, not an agent tool. It is allowed to spawn `git`, but it must
// stay unreachable from agent/tool code (asserted below). The agent's execution
// path has no child process outside the Runtime Manager.
const CHILD_PROCESS_ALLOWED = ['src/sandbox/runtime/', 'src/workspace-ui/'];
const NETWORK_ALLOWED = [
  'src/sandbox/network/egress-policy.ts',
  'src/sandbox/network/egress-proxy.ts',
];
const GATEWAY_ONLY = ['src/sandbox/gateway.ts', 'src/sandbox/index.ts'];

describe('sandbox boundaries', () => {
  it('only the Runtime Manager may spawn a container client', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (!relativePath.startsWith('src/')) continue;
      if (CHILD_PROCESS_ALLOWED.some((prefix) => relativePath.startsWith(prefix))) continue;
      for (const specifier of importSpecifiers(source)) {
        if (specifier === 'node:child_process' || specifier === 'child_process') {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the tools have no filesystem or subprocess path of their own', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (!relativePath.startsWith('src/tools/')) continue;
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier === 'node:child_process' ||
          specifier === 'node:fs' ||
          specifier === 'node:fs/promises'
        ) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('only the egress proxy speaks HTTP or Net inside the sandbox', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (!relativePath.startsWith('src/sandbox/')) continue;
      if (NETWORK_ALLOWED.includes(relativePath)) continue;
      for (const specifier of importSpecifiers(source)) {
        if (specifier === 'node:http' || specifier === 'node:https' || specifier === 'node:net') {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('service and agent code cannot reach a Controller, runtime or sandbox store', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (!relativePath.startsWith('src/service/') && !relativePath.startsWith('src/agent/')) continue;
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier.includes('sandbox/runtime/') ||
          specifier.endsWith('sandbox/controller.ts') ||
          specifier.includes('sandbox/store') ||
          specifier.endsWith('sandbox/gateway.ts')
        ) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the person-facing workbench is not reachable from the agent', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (
        !relativePath.startsWith('src/tools/') &&
        !relativePath.startsWith('src/agent/') &&
        !relativePath.startsWith('src/service/')
      ) {
        continue;
      }
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes('workspace-ui/')) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('tools cannot import the Gateway directly', async () => {
    const sources = await readSources();
    const violations: string[] = [];
    for (const { relativePath, source } of sources) {
      if (!relativePath.startsWith('src/tools/')) continue;
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes('sandbox/gateway.ts') || specifier.includes('sandbox/controller.ts')) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the guard would catch a synthetic regression', () => {
    expect(importSpecifiers(`import { spawn } from 'node:child_process';`)).toContain(
      'node:child_process',
    );
    expect(GATEWAY_ONLY.length).toBeGreaterThan(0);
  });
});
