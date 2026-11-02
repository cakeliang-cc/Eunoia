/**
 * Physical validation of a task working directory (ADR 021 §4.3, §4.4).
 *
 * The lexical check in `cwd-path.ts` is a vocabulary check; this is the part
 * that resolves the real inode. The workspace is bind-mounted into the sandbox,
 * so the host directory that backs `/workspace` is the same tree the container
 * sees; resolving it here is how a symlink such as
 *
 *     /workspace/project/link -> /etc
 *
 * is refused even though the string starts with the workspace prefix.
 *
 * TOCTOU note. Two checks exist on purpose:
 *
 *   1. this pre-flight check, so a request never becomes a container process;
 *   2. the execution launcher inside the container (`runtime/oci-args.ts`), which
 *      resolves and `cd`s in the *same shell process* that then runs the command.
 *
 * No file descriptor is passed across the `docker exec` boundary — the ADR's
 * `openat2`/`fchdir` option is not available through this runtime API — so the
 * launcher is the equivalent control the ADR asks for when it cannot be used.
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative as hostRelative, sep } from 'node:path';
import { CwdError, type CwdErrorCode } from './cwd-types.ts';
import { isWithinRoot as isWithinContainerRoot, toContainerPath, toHostPath } from './cwd-path.ts';

export interface CwdFilesystem {
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
}

export const nodeCwdFilesystem: CwdFilesystem = {
  realpath: (path) => realpath(path),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
};

export interface CwdValidationInput {
  /** Container workspace root, e.g. `/workspace`. */
  readonly workspaceRoot: string;
  /** Host directory bind-mounted at {@link workspaceRoot}. */
  readonly workspaceHostRoot: string;
  /** Container path to validate. */
  readonly cwd: string;
}

export type CwdValidationResult =
  | {
      readonly ok: true;
      /** Canonical container path after symlink resolution. */
      readonly cwd: string;
      readonly hostPath: string;
    }
  | { readonly ok: false; readonly code: CwdErrorCode; readonly message: string };

export interface CwdValidator {
  validate(input: CwdValidationInput): Promise<CwdValidationResult>;
}

export class FilesystemCwdValidator implements CwdValidator {
  private readonly fs: CwdFilesystem;

  constructor(fs: CwdFilesystem = nodeCwdFilesystem) {
    this.fs = fs;
  }

  async validate(input: CwdValidationInput): Promise<CwdValidationResult> {
    // 1. Lexical boundary first, so a hostile absolute path is refused without a
    //    filesystem round trip and cannot be probed for existence.
    if (!isWithinContainerRoot(input.workspaceRoot, input.cwd)) {
      return {
        ok: false,
        code: 'PATH_OUTSIDE_WORKSPACE',
        message: 'the requested directory is outside the task workspace',
      };
    }

    const hostPath = toHostPath(input.workspaceRoot, input.workspaceHostRoot, input.cwd);

    // 2. The workspace itself must still be mounted; a vanished workspace is not
    //    a missing directory, it is an unavailable one.
    const realRoot = await this.fs.realpath(input.workspaceHostRoot).catch(() => null);
    if (realRoot === null) {
      return {
        ok: false,
        code: 'WORKSPACE_NOT_AVAILABLE',
        message: 'the task workspace is not available',
      };
    }

    // 3. Resolve the target, following symlinks.
    let realTarget: string;
    try {
      realTarget = await this.fs.realpath(hostPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === 'ELOOP'
        ? {
            ok: false,
            code: 'SYMLINK_ESCAPE',
            message: 'the requested directory resolves through a symlink loop',
          }
        : {
            ok: false,
            code: 'DIRECTORY_NOT_FOUND',
            message: 'the requested directory does not exist',
          };
    }

    // 4. It has to be a directory, not a file or a device.
    const directory = await this.fs.isDirectory(hostPath).catch(() => false);
    if (!directory) {
      return {
        ok: false,
        code: 'NOT_A_DIRECTORY',
        message: 'the requested path is not a directory',
      };
    }

    // 5. The physical path must still be inside the physical workspace. The
    //    lexical check passed, so this branch means a symlink was followed out.
    if (!isWithinHostRoot(realRoot, realTarget)) {
      return {
        ok: false,
        code: 'SYMLINK_ESCAPE',
        message: 'the requested directory resolves outside the task workspace',
      };
    }

    const relative = hostRelative(realRoot, realTarget).split(sep).join('/');
    return {
      ok: true,
      cwd: toContainerPath(input.workspaceRoot, relative),
      hostPath: realTarget,
    };
  }
}

/** True when `target` is `root` or below it, on the host's path semantics. */
function isWithinHostRoot(root: string, target: string): boolean {
  const relative = hostRelative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${sep}`) && !isAbsolute(relative))
  );
}

/** Throw the stable `CwdError` for a failed validation. */
export function assertValidCwd(
  result: CwdValidationResult,
): asserts result is Extract<CwdValidationResult, { ok: true }> {
  if (!result.ok) throw new CwdError(result.code, result.message);
}
