/**
 * Enforces the client/server boundary from ADR 006.
 *
 * The boundary is the whole reason a future mini-program client is an adapter
 * rather than a rewrite, so it is enforced mechanically rather than by
 * convention. A comment in a README would not survive the first hurried commit.
 */

import { describe, expect, it } from 'vitest';
import { importSpecifiers, readSources } from '../helpers/sources.ts';

/**
 * Directories that must stay transport-agnostic.
 *
 * `src/service/` (turn orchestration) and `src/db/` (persistence) were added
 * when Phase 2 introduced them. Both are product logic that a different client —
 * a mini-program, a CLI, a batch job — would need to reuse verbatim, so neither
 * may reach for HTTP.
 */
const CORE_DIRS = [
  'src/agent/',
  'src/memory/',
  'src/tools/',
  'src/safety/',
  'src/evaluation/',
  'src/service/',
  'src/db/',
];

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

/**
 * The names a file imports from a given module.
 *
 * `import { type Store }` and `import { Store as S }` both yield `Store`: the
 * guard asks which *things* a file depends on, and an alias is the same thing
 * under another name.
 */
function importedNamesFrom(source: string, moduleSuffix: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${moduleSuffix}['"]`,
    'g',
  );
  for (const match of source.matchAll(pattern)) {
    for (const entry of (match[1] ?? '').split(',')) {
      const name = entry
        .replace(/\btype\b/g, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
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

  /**
   * Only a process entry point may install the model provider.
   *
   * This guard exists because its absence cost a debugging session: `npm run
   * eval` never called `installProvider()`, so the SDK fell back to its own
   * default provider, which wants an OpenAI key this runtime does not have.
   * Every one of the 24 cases failed with "Missing credentials", which reads
   * like a misconfigured key and was in fact a missing line in an entry point.
   *
   * It is a rule about *where* a process-level side effect happens, so it is
   * checked on the imports rather than on behaviour — a test that ran the CLI
   * would need a live credential, and would therefore be skipped by exactly the
   * people who need it.
   */
  const COMPOSITION_ROOTS = ['src/api/server.ts', 'src/evaluation/cli.ts'];

  it('only composition roots install the model provider', async () => {
    const sources = await readSources();
    const violations = sources
      .filter(
        ({ relativePath, source }) =>
          importedNamesFrom(source, 'model-client.ts').includes('installProvider') &&
          !COMPOSITION_ROOTS.includes(relativePath),
      )
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });

  it('every composition root installs it, which is the half that actually broke', async () => {
    // The other half of the same rule. Without this, deleting the call from
    // `cli.ts` would still pass the guard above — the failure mode is an
    // omission, not an excess.
    const sources = await readSources();
    for (const root of COMPOSITION_ROOTS) {
      const source = sources.find((entry) => entry.relativePath === root)?.source ?? '';
      expect(source, `${root} is missing from the tree`).not.toBe('');
      expect(source, `${root} never calls installProvider()`).toContain('installProvider()');
    }
  });

  it('the composition-root guard would actually catch a violation', () => {
    const synthetic = `import { installProvider } from '../agent/model-client.ts';`;
    expect(importedNamesFrom(synthetic, 'model-client.ts')).toContain('installProvider');
    expect(importedNamesFrom(`import { type Store } from './store.ts';`, 'store.ts')).toEqual([
      'Store',
    ]);
  });
});
