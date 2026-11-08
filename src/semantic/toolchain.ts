/**
 * The compiler toolchain the semantic tools borrow.
 *
 * `src/tools/` is not allowed to import `node:fs` (see the sandbox-boundary
 * test): a tool must reach files through the workspace port, not the host disk.
 * The compiler itself is different — its own `lib.*.d.ts` and `@types/node` are
 * part of the installed toolchain, not workspace data. This module owns that
 * one exception and exposes it as data, so the tool code stays port-only.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);

let tsModule: typeof TS | null = null;

export function loadTypeScript(): typeof TS {
  if (tsModule) return tsModule;
  try {
    tsModule = require('typescript') as typeof TS;
    return tsModule;
  } catch (error) {
    throw new Error(
      `TypeScript is not installed, so semantic tools are unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

let libDirCache: string | null | undefined;
let ambientRootCache: string | null | undefined;

export function typescriptLibDir(): string | null {
  if (libDirCache !== undefined) return libDirCache;
  try {
    libDirCache = dirname(require.resolve('typescript'));
  } catch {
    libDirCache = null;
  }
  return libDirCache;
}

/** `node_modules/@types`, or null when `@types/node` is not installed. */
export function ambientTypesRoot(): string | null {
  if (ambientRootCache !== undefined) return ambientRootCache;
  try {
    ambientRootCache = dirname(dirname(require.resolve('@types/node/package.json')));
  } catch {
    ambientRootCache = null;
  }
  return ambientRootCache;
}

/**
 * Read a compiler-facing file that is not workspace data.
 *
 * Accepts either a `lib.*.d.ts` name or a compiler path containing
 * `/node_modules/…` (which the type resolution asks for). Anything else returns
 * undefined, so a workspace path can never be read through this door.
 */
export function readCompilerFile(fileName: string): string | undefined {
  const name = basename(fileName);
  const libDir = typescriptLibDir();
  if (libDir && (name === 'lib.d.ts' || /^lib\..+\.d\.ts$/.test(name))) {
    try {
      return readFileSync(join(libDir, name), 'utf8');
    } catch {
      return undefined;
    }
  }
  const ambientRoot = ambientTypesRoot();
  if (!ambientRoot) return undefined;
  const normalized = fileName.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  try {
    return readFileSync(join(dirname(ambientRoot), normalized.slice(index + marker.length)), 'utf8');
  } catch {
    return undefined;
  }
}

/** Compiler options for ambient types, or an empty list when none are installed. */
export function ambientTypeOptions(): { readonly types: string[]; readonly typeRoots?: string[] } {
  return ambientTypesRoot()
    ? { types: ['node'], typeRoots: ['/node_modules/@types'] }
    : { types: [] };
}
