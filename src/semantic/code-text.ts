/**
 * Text and position rules shared by every semantic backend.
 *
 * The model speaks 1-based line/column where a column counts Unicode code
 * points ("characters" as a person sees them). LSP speaks 0-based line/character
 * where a character is a UTF-16 code unit by default. A Chinese name, a combining
 * mark and an emoji all make those two numbers disagree, so the conversion lives
 * in one place and both the in-memory LanguageService and the real language
 * server use it.
 *
 * `ToolWorkspacePort.readLines` returns model-facing text with a line-number
 * gutter. The compiler must see the file's real content, so the gutter is
 * stripped here rather than in each backend.
 */

import type * as TS from 'typescript';
import { loadTypeScript } from './toolchain.ts';

/** Extensions this service understands. A `.py` file is refused, not guessed at. */
export const SEMANTIC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export const SCRIPT_PATTERNS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
] as const;

export interface ModelPosition {
  /** 1-based. */
  readonly line: number;
  /** 1-based, counting Unicode code points. */
  readonly column: number;
}

export interface ModelRange {
  readonly start: ModelPosition;
  readonly end: ModelPosition;
}

export function isSemanticPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SEMANTIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Workspace paths are relative with `/`; a service may answer absolute-ish ones. */
export function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Remove the `\`     12\t\`` gutter that the read port adds for the model. */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

/** Offsets where each line starts; only `\n` ends a line, as in the compiler. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** One line without its terminator (`\n` or `\r\n`). */
export function lineTextAt(text: string, lineIndex: number): string {
  const starts = computeLineStarts(text);
  const start = starts[lineIndex];
  if (start === undefined) return '';
  const end = lineIndex + 1 < starts.length ? (starts[lineIndex + 1] as number) : text.length;
  return text.slice(start, end).replace(/\r?\n$/, '');
}

/** Character offset → 1-based line and 1-based code-point column. */
export function offsetToPosition(text: string, offset: number): ModelPosition {
  const starts = computeLineStarts(text);
  let low = 0;
  let high = starts.length - 1;
  let line = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((starts[mid] as number) <= offset) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const lineStart = starts[line] as number;
  const prefix = text.slice(lineStart, Math.max(lineStart, offset));
  return { line: line + 1, column: [...prefix].length + 1 };
}

/**
 * 1-based line/code-point column → UTF-16 offset.
 *
 * Returns null instead of clamping: a model that names column 40 in a 10-column
 * line has the wrong position, and silently using column 10 would answer a
 * different question than the one asked.
 */
export function positionToOffset(text: string, position: ModelPosition): number | null {
  const starts = computeLineStarts(text);
  const index = position.line - 1;
  if (index < 0 || index >= starts.length) return null;
  const line = lineTextAt(text, index);
  const characters = [...line];
  const column = position.column - 1;
  if (column < 0 || column > characters.length) return null;
  const lineStart = starts[index] as number;
  return lineStart + characters.slice(0, column).join('').length;
}

/**
 * Find the first identifier token with exactly this text.
 *
 * The scanner is a token match, not a substring search: `add` does not match
 * `address`, and a name in a string literal is not an identifier.
 */
export function resolveSymbolPosition(text: string, symbol: string): ModelPosition | null {
  const needle = symbol.trim();
  if (needle.length === 0) return null;
  const ts: typeof TS = loadTypeScript();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return null;
    if (scanner.getTokenText() === needle) return offsetToPosition(text, scanner.getTokenStart());
  }
}

/** The trimmed first line at an offset, bounded for model output. */
export function snippetAt(text: string | null, position: ModelPosition): string {
  if (text === null) return '';
  return lineTextAt(text, position.line - 1).trim().slice(0, 240);
}

/**
 * Convert a model position to an LSP UTF-16 position.
 *
 * LSP lines are 0-based and its character is a UTF-16 code unit. The model
 * column counts code points, so `[...line]` is used for the prefix length.
 */
export function toLspPosition(
  text: string,
  position: ModelPosition,
): { readonly line: number; readonly character: number } | null {
  const line = lineTextAt(text, position.line - 1);
  const characters = [...line];
  const column = position.column - 1;
  if (column < 0 || column > characters.length) return null;
  return {
    line: position.line - 1,
    character: characters.slice(0, column).join('').length,
  };
}

/** Convert an LSP UTF-16 position to a 1-based model position. */
export function fromLspPosition(
  text: string,
  position: { readonly line: number; readonly character: number },
): ModelPosition {
  const line = lineTextAt(text, position.line);
  // `character` can split a surrogate pair only if a server is buggy; counting
  // the prefix still gives a stable, in-range column.
  const prefix = line.slice(0, Math.max(0, position.character));
  return { line: position.line + 1, column: [...prefix].length + 1 };
}
