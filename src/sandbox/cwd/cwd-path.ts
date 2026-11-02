/**
 * Lexical path handling for the task working directory (ADR 021 §4.1, §4.3).
 *
 * This module is deliberately *only* lexical. It normalises and it answers
 * "is this path inside that root?" using `path.relative`, never a string prefix:
 * `/workspace-evil` must not pass a check for `/workspace`. It never touches the
 * filesystem, so it cannot be the security boundary — the physical check lives in
 * `cwd-validator.ts` and, again, in the execution launcher inside the container.
 *
 * Keeping the two apart is what makes the wrong implementation the hard one:
 * a caller that wants to know whether a directory exists has to reach for the
 * validator, which resolves symlinks.
 */

import { join, posix } from 'node:path';
import { CwdError } from './cwd-types.ts';

/** Reject the inputs that are dangerous before they become a path. */
export function assertPathInput(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CwdError('INVALID_PATH', 'path must be a string');
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new CwdError('INVALID_PATH', 'path must not be empty');
  }
  if (value.includes('\0')) {
    throw new CwdError('INVALID_PATH', 'path must not contain NUL bytes');
  }
  // A newline is a shell-injection primitive for anything that later interpolates
  // the value; a working directory never needs one.
  if (/[\r\n]/.test(value)) {
    throw new CwdError('INVALID_PATH', 'path must not contain newlines');
  }
  return value;
}

/**
 * Resolve `input` against the task's current cwd.
 *
 * Absolute paths are normalised, relative ones are resolved against the current
 * directory. `..` is allowed here and is bounded by `isWithinRoot` afterwards —
 * unlike the file tools, where `..` is refused outright, because a working
 * directory request has to be able to mean "the parent directory".
 */
export function resolveTaskPath(input: string, currentCwd: string): string {
  const value = assertPathInput(input);
  const resolved = posix.isAbsolute(value)
    ? posix.normalize(value)
    : posix.resolve(currentCwd, value);
  // `posix.normalize` keeps a trailing slash; `/workspace/src/` and
  // `/workspace/src` have to compare equal, because they are the same directory.
  const trimmed = resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
  return trimmed.length === 0 ? currentCwd : trimmed;
}

/** True when `target` is `root` itself or below it. Lexical only. */
export function isWithinRoot(root: string, target: string): boolean {
  const relative = posix.relative(posix.normalize(root), posix.normalize(target));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${posix.sep}`) && !posix.isAbsolute(relative))
  );
}

/** The workspace-relative form of a container path; `''` for the root itself. */
export function workspaceRelative(root: string, target: string): string {
  if (!isWithinRoot(root, target)) {
    throw new CwdError('PATH_OUTSIDE_WORKSPACE', `${target} is outside ${root}`);
  }
  return posix.relative(posix.normalize(root), posix.normalize(target));
}

/** Container path (`/workspace/src`) → host path inside the mounted workspace. */
export function toHostPath(workspaceRoot: string, workspaceHostRoot: string, target: string): string {
  const relative = workspaceRelative(workspaceRoot, target);
  return relative.length === 0 ? workspaceHostRoot : join(workspaceHostRoot, relative);
}

/** Host path relative to the workspace → canonical container path. */
export function toContainerPath(workspaceRoot: string, relativePath: string): string {
  const cleaned = relativePath.replace(/^[./]+/, '').replace(/\/+$/, '');
  return cleaned.length === 0 ? workspaceRoot : `${workspaceRoot}/${cleaned}`;
}

/** Normalise a container path that arrived from a trusted runtime surface. */
export function normalizeContainerCwd(value: string): string {
  const path = assertPathInput(value);
  if (!posix.isAbsolute(path)) {
    throw new CwdError('INVALID_PATH', `cwd must be absolute, got ${JSON.stringify(path)}`);
  }
  return posix.normalize(path);
}
