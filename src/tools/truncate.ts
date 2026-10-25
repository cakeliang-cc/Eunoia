/**
 * Truncation, and the one decision that matters about it: which end to keep.
 *
 * A file read keeps the beginning, because line 1 is the top of the file and the
 * model can ask for the rest by line number. Command output keeps the end,
 * because the exit status, the traceback and the test summary are all at the
 * bottom. A middle-out cut is only for text a human reads (a diff preview),
 * where "…" is readable and nobody acts on the missing part programmatically.
 *
 * The distinction is not cosmetic. An earlier middle-out cut on command output
 * removed the failing assertion and kept the build banner, and the model then
 * answered confidently about the wrong thing.
 */

export interface Truncation {
  readonly lines: readonly string[];
  readonly text: string;
  readonly truncated: boolean;
  /** Which limit ended the cut: the line count, the character count, or neither. */
  readonly by: 'lines' | 'chars' | '';
  readonly totalLines: number;
  readonly keptLines: number;
  /** 1-based inclusive positions of the kept slice. */
  readonly first: number;
  readonly last: number;
}

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_CHARS = 60_000;

export function truncateHead(
  lines: readonly string[],
  maxLines = DEFAULT_MAX_LINES,
  maxChars = DEFAULT_MAX_CHARS,
): Truncation {
  return cut(lines, maxLines, maxChars, false);
}

export function truncateTail(
  lines: readonly string[],
  maxLines = DEFAULT_MAX_LINES,
  maxChars = DEFAULT_MAX_CHARS,
): Truncation {
  return cut(lines, maxLines, maxChars, true);
}

/**
 * Keep both ends. Only for text shown to a person, never for tool output a model
 * has to act on: the model cannot ask for "the middle".
 */
export function truncateMiddle(text: string, limit = 60_000): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [truncated ${text.length - limit} chars] …\n${text.slice(-half)}`;
}

/** Bound one line — a grep hit from a minified file is not a readable match. */
export function truncateLine(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [+${text.length - limit} chars]`;
}

function cut(
  lines: readonly string[],
  maxLines: number,
  maxChars: number,
  fromEnd: boolean,
): Truncation {
  const total = lines.length;
  if (total === 0) {
    return {
      lines: [],
      text: '',
      truncated: false,
      by: '',
      totalLines: 0,
      keptLines: 0,
      first: 0,
      last: 0,
    };
  }

  const lineLimit = Math.max(1, maxLines);
  const charLimit = Math.max(1, maxChars);
  const order = fromEnd ? Array.from({ length: total }, (_, i) => total - 1 - i) : Array.from({ length: total }, (_, i) => i);
  const kept: number[] = [];
  let used = 0;
  let by: 'lines' | 'chars' | '' = '';

  for (const index of order) {
    if (kept.length >= lineLimit) {
      by = 'lines';
      break;
    }
    const line = lines[index] as string;
    const cost = line.length + 1;
    // The first line is taken unconditionally, so a budget smaller than one line
    // still returns something instead of an empty result.
    if (kept.length > 0 && used + cost > charLimit) {
      by = 'chars';
      break;
    }
    kept.push(index);
    used += cost;
  }

  if (fromEnd) kept.reverse();
  let out = kept.map((index) => lines[index] as string);
  if (used > charLimit) {
    // Whole-line granularity is a preference, not a licence to blow the budget:
    // one minified line can be megabytes.
    const first = out[0] as string;
    out = [fromEnd ? first.slice(-charLimit) : first.slice(0, charLimit)];
    by = 'chars';
  }

  const first = (kept[0] ?? 0) + 1;
  const last = (kept[kept.length - 1] ?? 0) + 1;
  return {
    lines: out,
    text: out.join('\n'),
    truncated: by !== '',
    by,
    totalLines: total,
    keptLines: out.length,
    first,
    last,
  };
}
