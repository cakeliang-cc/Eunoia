/**
 * Enforces the client/server boundary from ADR 006.
 *
 * The boundary is the whole reason a future mini-program client is an adapter
 * rather than a rewrite, so it is enforced mechanically rather than by
 * convention. A comment in a README would not survive the first hurried commit.
 */

import { describe, expect, it } from 'vitest';
import { importSpecifiers, readSources } from '../helpers/sources.ts';

/** Directories that must stay transport-agnostic. */
const CORE_DIRS = ['src/agent/', 'src/memory/', 'src/tools/', 'src/safety/', 'src/evaluation/'];

/** Modules the core must never reach for. */
const FORBIDDEN_SPECIFIERS = [
  'node:http',
  'node:https',
  'node:net',
  'express',
  'fastify',
  'hono',
  'koa',
  'next',
  'node:http2',
];

function isCore(relativePath: string): boolean {
  return CORE_DIRS.some((dir) => relativePath.startsWith(dir));
}

describe('core / transport boundary (ADR 006)', () => {
  it('every core module avoids HTTP and web-framework imports', async () => {
    const sources = await readSources();
    const violations: string[] = [];

    for (const { relativePath, source } of sources) {
      if (!isCore(relativePath)) continue;
      for (const specifier of importSpecifiers(source)) {
        const forbidden =
          FORBIDDEN_SPECIFIERS.includes(specifier) ||
          specifier.startsWith('node:http') ||
          specifier.includes('/src/api/') ||
          specifier.startsWith('../api/') ||
          specifier.startsWith('./api/');
        if (forbidden) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('the guard would actually catch a violation', async () => {
    // A guard that cannot fail is not a guard. This proves the detector works
    // against a synthetic offender, so a passing run above means something.
    const synthetic = `import { createServer } from 'node:http';\nimport x from '../api/sse.ts';`;
    const found = importSpecifiers(synthetic);
    expect(found).toContain('node:http');
    expect(found).toContain('../api/sse.ts');
  });

  /**
   * The vendor SDK is confined to the harness and observability layers.
   *
   * An earlier version of this test claimed the SDK appeared *only* in
   * `model-client.ts`. That was an overclaim, and this test caught it: the agent
   * module necessarily uses the SDK's agent primitives, and tracing necessarily
   * implements an SDK interface. Abstracting those away would mean
   * reimplementing the SDK, which is the unnecessary work spec §0 warns against.
   *
   * The invariant that is both true and worth protecting is narrower: **the
   * product-logic layers must not depend on the vendor SDK.** Memory, tools,
   * safety, and evaluation are the bulk of this product's own code, and keeping
   * them SDK-free is what makes the provider — and potentially the harness —
   * replaceable without touching them.
   */
  const SDK_IMPORT_ALLOWED_DIRS = ['src/agent/', 'src/observability/'];

  it('product-logic and transport layers do not import a vendor SDK', async () => {
    const sources = await readSources();
    const violations: string[] = [];

    for (const { relativePath, source } of sources) {
      if (SDK_IMPORT_ALLOWED_DIRS.some((dir) => relativePath.startsWith(dir))) continue;
      for (const specifier of importSpecifiers(source)) {
        if (specifier === '@openai/agents' || specifier.startsWith('openai')) {
          violations.push(`${relativePath} imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('the SDK does not leak past the transport boundary either', async () => {
    // `src/api/` is transport. It must speak AgentEvent, not SDK types.
    const sources = await readSources();
    const apiSources = sources.filter((s) => s.relativePath.startsWith('src/api/'));
    expect(apiSources.length).toBeGreaterThan(0);

    for (const { relativePath, source } of apiSources) {
      const sdkImports = importSpecifiers(source).filter(
        (s) => s === '@openai/agents' || s.startsWith('openai'),
      );
      expect(sdkImports, `${relativePath} leaks an SDK import into transport`).toEqual([]);
    }
  });
});
