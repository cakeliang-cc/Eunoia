/**
 * Source-scanning helpers for the architecture guard tests.
 *
 * These tests read the source tree as text rather than importing it, because
 * what they assert is a property of the *imports*, which importing would defeat.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
export const SRC_DIR = join(PROJECT_ROOT, 'src');

/** Every `.ts` file under `dir`, recursively, as absolute paths. */
export async function listTsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
    }
  }
  await walk(dir);
  return found.sort();
}

/**
 * Extract the module specifiers a file imports.
 *
 * Covers `import ... from 'x'`, bare `import 'x'`, `export ... from 'x'`, and
 * dynamic `import('x')`. Deliberately a regex, not a parser: this guards a
 * convention, and a guard that cannot itself break on unusual syntax is worth
 * more here than exhaustiveness.
 */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Read every source file paired with its project-relative path. */
export async function readSources(dir = SRC_DIR): Promise<
  Array<{ path: string; relativePath: string; source: string }>
> {
  const files = await listTsFiles(dir);
  return Promise.all(
    files.map(async (path) => ({
      path,
      relativePath: relative(PROJECT_ROOT, path),
      source: await readFile(path, 'utf8'),
    })),
  );
}
