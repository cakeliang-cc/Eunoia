/**
 * Lexical path handling for the task cwd (ADR 021 §4.1, §4.3).
 *
 * These are the checks that must be right *before* anything touches a disk: the
 * container prefix is not a string prefix, `..` is allowed and bounded, and an
 * absolute path is normalised rather than trusted.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPathInput,
  isWithinRoot,
  resolveTaskPath,
  toContainerPath,
  toHostPath,
  workspaceRelative,
} from '../../src/sandbox/cwd/cwd-path.ts';
import { CwdError } from '../../src/sandbox/cwd/cwd-types.ts';

describe('resolveTaskPath', () => {
  it('resolves a relative path against the current task directory', () => {
    expect(resolveTaskPath('src', '/workspace/project')).toBe('/workspace/project/src');
  });

  it('resolves .. against the current directory, not the workspace root', () => {
    expect(resolveTaskPath('../tests', '/workspace/project/src')).toBe('/workspace/project/tests');
    expect(resolveTaskPath('../../', '/workspace/project/src')).toBe('/workspace');
  });

  it('treats . as the current directory', () => {
    expect(resolveTaskPath('.', '/workspace/project')).toBe('/workspace/project');
    expect(resolveTaskPath('./', '/workspace/project')).toBe('/workspace/project');
  });

  it('normalises an absolute path', () => {
    expect(resolveTaskPath('/workspace/a/../b', '/workspace')).toBe('/workspace/b');
    expect(resolveTaskPath('/workspace/project/', '/workspace')).toBe('/workspace/project');
  });

  it('normalises an escape to outside the workspace rather than hiding it', () => {
    // The result is deliberately `/etc`, not `/workspace/etc`: it is the
    // boundary check's job to refuse it, not the resolver's job to clamp it.
    expect(resolveTaskPath('../../etc', '/workspace')).toBe('/etc');
    expect(resolveTaskPath('/', '/workspace/project')).toBe('/');
  });

  it('rejects empty, NUL and newline paths', () => {
    expect(() => resolveTaskPath('', '/workspace')).toThrow(CwdError);
    expect(() => resolveTaskPath('   ', '/workspace')).toThrow(CwdError);
    expect(() => resolveTaskPath('a\0b', '/workspace')).toThrow(CwdError);
    expect(() => resolveTaskPath('a\nb', '/workspace')).toThrow(CwdError);
  });
});

describe('isWithinRoot', () => {
  it('accepts the root itself and its children', () => {
    expect(isWithinRoot('/workspace', '/workspace')).toBe(true);
    expect(isWithinRoot('/workspace', '/workspace/src')).toBe(true);
    expect(isWithinRoot('/workspace/', '/workspace/src/app.ts')).toBe(true);
  });

  it('refuses a sibling whose name merely starts with the root', () => {
    // The exact mistake the ADR calls out: `/workspace-evil` must not pass a
    // string-prefix check for `/workspace`.
    expect(isWithinRoot('/workspace', '/workspace-evil')).toBe(false);
    expect(isWithinRoot('/workspace', '/workspace-evil/src')).toBe(false);
  });

  it('refuses the parent and unrelated absolute paths', () => {
    expect(isWithinRoot('/workspace', '/')).toBe(false);
    expect(isWithinRoot('/workspace', '/workspace/..')).toBe(false);
    expect(isWithinRoot('/workspace', '/etc/passwd')).toBe(false);
    expect(isWithinRoot('/workspace/a', '/workspace/ab')).toBe(false);
  });
});

describe('host and container mapping', () => {
  it('maps a container path onto the mounted host workspace', () => {
    expect(toHostPath('/workspace', '/srv/ws', '/workspace/src/app.ts')).toBe(
      '/srv/ws/src/app.ts',
    );
    expect(toHostPath('/workspace', '/srv/ws', '/workspace')).toBe('/srv/ws');
  });

  it('maps a relative host path back to a canonical container path', () => {
    expect(toContainerPath('/workspace', 'src/app.ts')).toBe('/workspace/src/app.ts');
    expect(toContainerPath('/workspace', '')).toBe('/workspace');
    expect(toContainerPath('/workspace', './')).toBe('/workspace');
  });

  it('reports the workspace-relative form and refuses an escape', () => {
    expect(workspaceRelative('/workspace', '/workspace/a/b')).toBe('a/b');
    expect(workspaceRelative('/workspace', '/workspace')).toBe('');
    expect(() => workspaceRelative('/workspace', '/etc')).toThrow(CwdError);
  });
});

describe('assertPathInput', () => {
  it('trims and returns the value', () => {
    expect(assertPathInput(' src ')).toBe('src');
  });

  it('rejects a non-string', () => {
    expect(() => assertPathInput(7 as unknown)).toThrow(CwdError);
  });
});
