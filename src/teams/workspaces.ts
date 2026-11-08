/**
 * Private workspaces for the members of an Agent Team.
 *
 * Two writable members must never share the user's project. The product's
 * normal single-user mode *binds* the project directory, which is correct when
 * there is one writer and wrong the moment there are two: a member's edit would
 * be another member's edit, an interrupted member would leave a half-written
 * file in the person's repository, and `git status` would stop meaning anything.
 *
 * This service gives each member a private copy under the app's storage root and
 * records it as an ordinary sandbox `Workspace` row. That is the whole trick: the
 * existing `WorkspaceManager.ensureForTask` returns a stored row instead of
 * copying, so the Sandbox Gateway mounts the member's directory without knowing
 * anything about teams.
 *
 * Three invariants are worth stating because the rest of the file exists to keep
 * them:
 *
 *   - **The source is read-only.** Nothing here writes, deletes, renames or
 *     `git stash`es inside `sourceRoot`. The person's uncommitted work is theirs.
 *   - **The baseline lives outside the workspace.** A member that could edit its
 *     own baseline could hide a change; the baseline JSON is a sibling of the
 *     workspace directory, not a file inside it.
 *   - **Ignored and credential files never enter a copy.** A sandbox should not
 *     start with `.env`, `.git`, `node_modules` or an SSH key just because the
 *     project had one, and the diff should not be able to publish them either.
 *
 * See docs/adr/034-subagent-and-agent-team.md.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_IGNORED_DIRS } from '../sandbox/paths.ts';
import type { SandboxStore } from '../sandbox/store.ts';
import type { Workspace } from '../sandbox/types.ts';
import type { SandboxToolProvider } from '../sandbox/tool-adapter.ts';
import type { ToolSandboxSession } from '../tools/types.ts';
import type { ArtifactFile, ArtifactManifest, TeamErrorCode } from './types.ts';
import { TeamError } from './types.ts';

// ------------------------------------------------------------------ options ---

export interface TeamWorkspaceOptions {
  /** The person's project. Absolute. Null means "an empty project". */
  readonly sourceRoot: string | null;
  /** Absolute, under the app's data dir. Never inside `sourceRoot`. */
  readonly storageRoot: string;
  /** Extra directory names to skip; defaults to `DEFAULT_IGNORED_DIRS`. */
  readonly ignore?: readonly string[];
  readonly now?: () => Date;
  /** Largest file whose content is kept in a manifest. Default 2 MiB. */
  readonly maxFileBytes?: number;
  /** Cap on the number of files in one workspace. Default 20000. */
  readonly maxFiles?: number;
}

export interface ProvisionInput {
  readonly teamId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly name: string;
  /** `bind` is only ever correct for the root member. */
  readonly mode: 'copy' | 'readonly' | 'bind';
}

export interface ProvisionedWorkspace {
  /** Stable id, derived from the task id. Persisted as `workspaceId`. */
  readonly workspaceId: string;
  /** The value passed to `SandboxToolProvider.forTask`. */
  readonly workspaceTaskId: string;
  /** Absolute host path the sandbox mounts. */
  readonly workspacePath: string;
  readonly baselineId: string;
  /** Hash of the source tree at provision time, or `'empty'`. */
  readonly sourceVersion: string;
  readonly baselineHashes: Readonly<Record<string, string>>;
}

export interface Baseline {
  readonly baselineId: string;
  readonly sourceVersion: string;
  readonly hashes: Readonly<Record<string, string>>;
  readonly files: Readonly<
    Record<string, { readonly hash: string; readonly bytes: number; readonly executable: boolean }>
  >;
  readonly createdAt: string;
}

/**
 * What is written to disk. The extra `workspaceTaskId` is not part of the
 * published `Baseline` contract; it lets a reader prove the file belongs to the
 * workspace it is being compared against.
 */
interface StoredBaseline extends Baseline {
  readonly workspaceTaskId?: string;
}

interface BaselineFileEntry {
  readonly hash: string;
  readonly bytes: number;
  readonly executable: boolean;
}

interface FileFacts extends BaselineFileEntry {
  readonly binary: boolean;
  readonly content?: string;
}

// -------------------------------------------------------------- the service ---

export class TeamWorkspaceService {
  private readonly store: SandboxStore;
  private readonly provider: SandboxToolProvider | null;
  private readonly now: () => Date;
  private readonly sourceRoot: string | null;
  /** `<storageRoot>/team-workspaces`. Workspaces are its children. */
  private readonly workspaceRoot: string;
  private readonly ignored: ReadonlySet<string>;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;

  constructor(deps: {
    readonly store: SandboxStore;
    readonly provider?: SandboxToolProvider;
    readonly options: TeamWorkspaceOptions;
  }) {
    this.store = deps.store;
    this.provider = deps.provider ?? null;
    this.now = deps.options.now ?? (() => new Date());

    const storageRoot = deps.options.storageRoot;
    if (typeof storageRoot !== 'string' || !isAbsolute(storageRoot)) {
      throw new TeamError('TEAM_WORKSPACE', 'team workspace storage root must be absolute');
    }
    const resolvedStorage = resolve(storageRoot);
    this.workspaceRoot = join(resolvedStorage, 'team-workspaces');
    this.sourceRoot = deps.options.sourceRoot ? resolve(deps.options.sourceRoot) : null;
    // A storage root inside the project would make every copy include the copies
    // and would put member data inside the user's repository.
    if (this.sourceRoot && isInside(this.sourceRoot, resolvedStorage)) {
      throw new TeamError(
        'TEAM_WORKSPACE',
        'team workspace storage root must not be inside the source root',
      );
    }

    this.ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(deps.options.ignore ?? [])]);
    const maxFileBytes = deps.options.maxFileBytes ?? 2 * 1024 * 1024;
    if (!Number.isFinite(maxFileBytes) || maxFileBytes < 0) {
      throw new TeamError('TEAM_WORKSPACE', 'maxFileBytes must be a non-negative number');
    }
    this.maxFileBytes = Math.floor(maxFileBytes);
    const maxFiles = deps.options.maxFiles ?? 20_000;
    if (!Number.isFinite(maxFiles) || maxFiles < 1) {
      throw new TeamError('TEAM_WORKSPACE', 'maxFiles must be a positive number');
    }
    this.maxFiles = Math.floor(maxFiles);
  }

  // ------------------------------------------------------------- provision ---

  async provision(input: ProvisionInput): Promise<ProvisionedWorkspace> {
    requireNonEmpty(input.teamId, 'teamId');
    requireNonEmpty(input.runId, 'runId');
    requireNonEmpty(input.memberId, 'memberId');
    requireNonEmpty(input.ownerId, 'ownerId');
    requireNonEmpty(input.name, 'member name');

    const workspaceTaskId = teamWorkspaceTaskId(input.teamId, input.runId, input.memberId);
    const workspaceId = teamWorkspaceId(workspaceTaskId);
    const at = this.now().toISOString();
    await mkdir(this.workspaceRoot, { recursive: true });

    if (input.mode === 'bind') {
      return await this.provisionBind(input, workspaceId, workspaceTaskId, at);
    }
    // `readonly` is a permission statement about the member, not a different
    // kind of directory: it still needs a private copy, and the sandbox row has
    // only `bind | copy` to describe it.
    return await this.provisionCopy(input, workspaceId, workspaceTaskId, at);
  }

  private async provisionCopy(
    input: ProvisionInput,
    workspaceId: string,
    workspaceTaskId: string,
    at: string,
  ): Promise<ProvisionedWorkspace> {
    // The destination is derived from our own generated id under our own storage
    // root. The source directory is never a destination, so it is never touched.
    const destination = join(this.workspaceRoot, sanitizeName(workspaceTaskId));
    const existing = await this.store.getWorkspaceForTask(workspaceTaskId);
    if (existing && existing.workspaceId === workspaceId && existing.mode === 'copy') {
      // Reuse only the directory provision itself created. A row that points
      // somewhere else (a tampered row, or a workspace the Gateway made) must not
      // become a member's private directory without a copy.
      const realDestination = await realpath(destination).catch(() => null);
      const realExisting = await realpath(existing.storageLocation).catch(() => null);
      const entries =
        realDestination && realExisting === realDestination
          ? await readdir(realDestination).catch(() => [])
          : [];
      // A row without a directory is a half-finished provision; so is a
      // directory without files. Both are re-copied rather than trusted.
      if (realDestination && realExisting === realDestination && entries.length > 0) {
        const stored = await this.ensureBaseline(workspaceTaskId, realDestination, at);
        return {
          workspaceId,
          workspaceTaskId,
          workspacePath: realDestination,
          baselineId: stored.baselineId,
          sourceVersion: stored.sourceVersion,
          baselineHashes: stored.hashes,
        };
      }
    }

    const sourceRoot = this.sourceRoot ? await this.requireSourceDirectory() : null;
    // Safe: `destination` is derived from our own generated id under our own
    // storage root. The source directory is never touched.
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });

    const copied: Record<string, BaselineFileEntry> = sourceRoot
      ? await this.copyTree(sourceRoot, destination)
      : {};
    const stored = await this.writeBaseline(workspaceTaskId, copied, at);
    const workspacePath = await realpath(destination);

    await this.ensureTaskRow(workspaceTaskId, workspaceId, input, at);
    const workspace: Workspace = {
      workspaceId,
      taskId: workspaceTaskId,
      storageLocation: workspacePath,
      mode: 'copy',
      currentVersion: stored.sourceVersion,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveWorkspace(workspace);

    return {
      workspaceId,
      workspaceTaskId,
      workspacePath,
      baselineId: stored.baselineId,
      sourceVersion: stored.sourceVersion,
      baselineHashes: stored.hashes,
    };
  }

  private async provisionBind(
    input: ProvisionInput,
    workspaceId: string,
    workspaceTaskId: string,
    at: string,
  ): Promise<ProvisionedWorkspace> {
    if (!this.sourceRoot) {
      throw new TeamError('TEAM_WORKSPACE', 'bind workspace mode needs a source root');
    }
    const sourcePath = await realpath(this.sourceRoot).catch(() => null);
    if (!sourcePath) {
      throw new TeamError('TEAM_WORKSPACE', `source root does not exist: ${this.sourceRoot}`);
    }
    const info = await stat(sourcePath);
    if (!info.isDirectory()) {
      throw new TeamError('TEAM_WORKSPACE', `source root is not a directory: ${sourcePath}`);
    }

    const existing = await this.store.getWorkspaceForTask(workspaceTaskId);
    if (
      existing &&
      existing.workspaceId === workspaceId &&
      existing.mode === 'bind' &&
      resolve(existing.storageLocation) === sourcePath
    ) {
      const stored = await this.ensureBaseline(workspaceTaskId, sourcePath, at);
      return {
        workspaceId,
        workspaceTaskId,
        workspacePath: sourcePath,
        baselineId: stored.baselineId,
        sourceVersion: stored.sourceVersion,
        baselineHashes: stored.hashes,
      };
    }

    const { hashes, files } = await this.inspectTree(sourcePath);
    const stored = await this.writeBaseline(workspaceTaskId, files, at, hashes);
    await this.ensureTaskRow(workspaceTaskId, workspaceId, input, at);
    const workspace: Workspace = {
      workspaceId,
      taskId: workspaceTaskId,
      storageLocation: sourcePath,
      mode: 'bind',
      currentVersion: stored.sourceVersion,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveWorkspace(workspace);

    return {
      workspaceId,
      workspaceTaskId,
      workspacePath: sourcePath,
      baselineId: stored.baselineId,
      sourceVersion: stored.sourceVersion,
      baselineHashes: stored.hashes,
    };
  }

  // -------------------------------------------------------------- baseline ---

  async baseline(baselineId: string): Promise<Baseline | null> {
    if (typeof baselineId !== 'string' || baselineId.length === 0) return null;
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.baseline.json')) continue;
      const stored = await this.readBaselineFile(join(this.workspaceRoot, entry.name));
      if (stored && stored.baselineId === baselineId) return stored;
    }
    return null;
  }

  /** The user's source root, when this deployment is bound to one. */
  sourceRootPath(): string | null {
    return this.sourceRoot;
  }

  /** Where a member's private copy lives, from the persisted workspace row. */
  async workspacePathFor(workspaceTaskId: string): Promise<string | null> {
    const workspace = await this.store.getWorkspaceForTask(workspaceTaskId);
    return workspace?.storageLocation ?? null;
  }

  /** The baseline written at provision time, for a member workspace. */
  async baselineForWorkspace(workspaceTaskId: string): Promise<Baseline | null> {
    return await this.readBaselineFile(this.baselinePath(workspaceTaskId));
  }

  private async ensureBaseline(
    workspaceTaskId: string,
    workspacePath: string,
    at: string,
  ): Promise<StoredBaseline> {
    const existing = await this.readBaselineFile(this.baselinePath(workspaceTaskId));
    if (
      existing &&
      (existing.workspaceTaskId === undefined || existing.workspaceTaskId === workspaceTaskId)
    ) {
      // Deliberately *not* recomputed: the whole point of a baseline is that it
      // describes the tree as it was at provision time, not as the member left it.
      return existing;
    }
    const { hashes, files } = await this.inspectTree(workspacePath);
    return await this.writeBaseline(workspaceTaskId, files, at, hashes);
  }

  private async writeBaseline(
    workspaceTaskId: string,
    files: Record<string, BaselineFileEntry>,
    at: string,
    precomputedHashes?: Record<string, string>,
  ): Promise<StoredBaseline> {
    const hashes: Record<string, string> = precomputedHashes ?? {};
    if (!precomputedHashes) {
      for (const [path, entry] of Object.entries(files)) hashes[path] = entry.hash;
    }
    const sourceVersion = treeVersion(hashes);
    const baseline: Baseline = {
      baselineId: baselineIdFor(workspaceTaskId, sourceVersion),
      sourceVersion,
      hashes,
      files,
      createdAt: at,
    };
    const stored: StoredBaseline = { ...baseline, workspaceTaskId };
    await mkdir(this.workspaceRoot, { recursive: true });
    await writeFile(this.baselinePath(workspaceTaskId), `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return stored;
  }

  private baselinePath(workspaceTaskId: string): string {
    return join(this.workspaceRoot, `${sanitizeName(workspaceTaskId)}.baseline.json`);
  }

  private async readBaselineFile(path: string): Promise<StoredBaseline | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return parseBaseline(parsed);
  }

  // ---------------------------------------------------------------- session ---

  /** Tool ports bound to this member workspace; null when no provider. */
  async session(input: {
    userId: string;
    workspaceTaskId: string;
    sessionId: string;
  }): Promise<ToolSandboxSession | null> {
    if (!this.provider) return null;
    requireNonEmpty(input.userId, 'userId');
    requireNonEmpty(input.workspaceTaskId, 'workspaceTaskId');
    requireNonEmpty(input.sessionId, 'sessionId');
    return await this.provider.forTask({
      taskId: input.workspaceTaskId,
      userId: input.userId,
      sessionId: input.sessionId,
    });
  }

  // ------------------------------------------------------------------- diff ---

  /** Hash the current member workspace and diff it against its baseline. */
  async diff(input: { workspaceTaskId: string; baselineId: string }): Promise<ArtifactManifest> {
    const workspace = await this.workspaceFor(input.workspaceTaskId);
    const root = await this.workspaceDirectory(workspace);
    const baseline = await this.baseline(input.baselineId);
    if (!baseline) {
      throw new TeamError('TEAM_WORKSPACE', `baseline ${input.baselineId} was not found`);
    }
    const current = await this.hashTree(root);
    const files = await this.buildManifest(root, baseline, current);
    return {
      files,
      sourceVersion: baseline.sourceVersion,
      candidateHash: artifactCandidateHash(files),
    };
  }

  /** Read the current tree (for conflict checks). */
  async currentHashes(workspaceTaskId: string): Promise<Record<string, string>> {
    const workspace = await this.workspaceFor(workspaceTaskId);
    const root = await this.workspaceDirectory(workspace);
    return await this.hashTree(root);
  }

  private async workspaceFor(workspaceTaskId: string): Promise<Workspace> {
    requireNonEmpty(workspaceTaskId, 'workspaceTaskId');
    const workspace = await this.store.getWorkspaceForTask(workspaceTaskId);
    if (!workspace) {
      throw new TeamError('TEAM_WORKSPACE', `no workspace is recorded for ${workspaceTaskId}`);
    }
    return workspace;
  }

  private async workspaceDirectory(workspace: Workspace): Promise<string> {
    const root = await realpath(workspace.storageLocation).catch(() => null);
    if (!root) {
      throw new TeamError(
        'TEAM_WORKSPACE',
        `workspace directory is missing: ${workspace.storageLocation}`,
      );
    }
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new TeamError('TEAM_WORKSPACE', `workspace is not a directory: ${root}`);
    }
    return root;
  }

  private async buildManifest(
    root: string,
    baseline: Baseline,
    current: Readonly<Record<string, string>>,
  ): Promise<ArtifactFile[]> {
    const currentPaths = new Set(Object.keys(current));
    const basePaths = new Set(Object.keys(baseline.hashes));

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const path of [...currentPaths].sort()) {
      const currentHash = current[path];
      if (currentHash === undefined) continue;
      const baseHash = baseline.hashes[path];
      if (baseHash === undefined) added.push(path);
      else if (baseHash !== currentHash) modified.push(path);
    }
    for (const path of [...basePaths].sort()) {
      if (!currentPaths.has(path)) deleted.push(path);
    }

    // Renames are delete+add with the same content, paired deterministically:
    // sorted new paths take the first still-unclaimed deleted path with the same
    // hash. A rename that cannot be paired is an ordinary add and delete.
    const deletedByHash = new Map<string, string[]>();
    for (const path of deleted) {
      const hash = baseline.hashes[path];
      if (hash === undefined) continue;
      const bucket = deletedByHash.get(hash);
      if (bucket) bucket.push(path);
      else deletedByHash.set(hash, [path]);
    }
    const renamedFrom = new Map<string, string>();
    const consumedDeletes = new Set<string>();
    const renamedAdds = new Set<string>();
    for (const path of added) {
      const hash = current[path];
      if (hash === undefined) continue;
      const fromPath = deletedByHash.get(hash)?.shift();
      if (fromPath === undefined) continue;
      renamedFrom.set(path, fromPath);
      renamedAdds.add(path);
      consumedDeletes.add(fromPath);
    }

    const files: ArtifactFile[] = [];
    for (const path of added) {
      if (renamedAdds.has(path)) continue;
      files.push(await this.presentFile(root, path, 'added', null));
    }
    for (const path of modified) {
      files.push(await this.presentFile(root, path, 'modified', baseline.hashes[path] ?? null));
    }
    for (const path of deleted) {
      if (consumedDeletes.has(path)) continue;
      files.push(this.deletedFile(path, baseline));
    }
    for (const [path, fromPath] of renamedFrom) {
      files.push(
        await this.presentFile(
          root,
          path,
          'renamed',
          baseline.hashes[fromPath] ?? null,
          fromPath,
        ),
      );
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  }

  private async presentFile(
    root: string,
    path: string,
    change: ArtifactFile['change'],
    baseHash: string | null,
    fromPath?: string,
  ): Promise<ArtifactFile> {
    const facts = await inspectFile(join(root, path), this.maxFileBytes);
    return {
      path,
      change,
      baseHash,
      contentHash: facts.hash,
      bytes: facts.bytes,
      executable: facts.executable,
      binary: facts.binary,
      ...(fromPath === undefined ? {} : { fromPath }),
      ...(facts.content === undefined ? {} : { content: facts.content }),
    };
  }

  private deletedFile(path: string, baseline: Baseline): ArtifactFile {
    const entry = baseline.files[path];
    return {
      path,
      change: 'deleted',
      baseHash: baseline.hashes[path] ?? null,
      contentHash: null,
      bytes: entry?.bytes ?? 0,
      executable: entry?.executable ?? false,
      // A deleted file's bytes are gone; the baseline deliberately keeps only a
      // hash, so "binary" cannot be recovered and is reported as false.
      binary: false,
    };
  }

  // --------------------------------------------------------------- cleanup ---

  /**
   * Remove a workspace only when nobody references it.
   *
   * A bind workspace is never removed: it *is* the person's repository, and this
   * service must not own that decision. A row whose directory is already gone is
   * still cleaned up so the bookkeeping does not accumulate.
   */
  async cleanup(input: { workspaceTaskId: string; referenced: boolean }): Promise<boolean> {
    if (input.referenced) return false;
    if (typeof input.workspaceTaskId !== 'string' || input.workspaceTaskId.length === 0) return false;

    const workspace = await this.store.getWorkspaceForTask(input.workspaceTaskId);
    if (!workspace) return false;
    if (workspace.mode === 'bind') return false;

    const location = resolve(workspace.storageLocation);
    const realRoot = await realpath(this.workspaceRoot).catch(() => null);
    if (!realRoot) return false;
    // Only ever delete a directory this service created, named by the id it
    // generated. A tampered row must not turn cleanup into a recursive delete of
    // the person's project.
    if (basename(location) !== sanitizeName(input.workspaceTaskId)) return false;

    const realLocation = await realpath(location).catch(() => null);
    if (realLocation) {
      if (!isInside(realRoot, realLocation) || realLocation === realRoot) return false;
      await rm(realLocation, { recursive: true, force: true });
    } else if (!isInside(realRoot, location) || location === realRoot) {
      return false;
    }

    await rm(this.baselinePath(input.workspaceTaskId), { force: true });
    await this.store.deleteWorkspace(workspace.workspaceId);
    return true;
  }

  // ---------------------------------------------------------------- private ---

  private async requireSourceDirectory(): Promise<string> {
    if (!this.sourceRoot) throw new TeamError('TEAM_WORKSPACE', 'workspace has no source root');
    const real = await realpath(this.sourceRoot).catch(() => null);
    if (!real) {
      throw new TeamError('TEAM_WORKSPACE', `source root does not exist: ${this.sourceRoot}`);
    }
    const info = await stat(real);
    if (!info.isDirectory()) {
      throw new TeamError('TEAM_WORKSPACE', `source root is not a directory: ${real}`);
    }
    return real;
  }

  /**
   * Copy the source tree without ever following a link out of it.
   *
   * Sockets, FIFOs and device nodes are skipped rather than copied: they cannot be
   * materialised as regular files, and a member workspace has no use for them.
   * Links whose real target is outside the source root are skipped for the reason
   * the workspace manager states — a checkout can contain a link to `/` or to a
   * home directory, and copying it would put host credentials in the sandbox.
   */
  private async copyTree(from: string, to: string): Promise<Record<string, BaselineFileEntry>> {
    const files: Record<string, BaselineFileEntry> = {};
    let count = 0;

    const walk = async (relativeDir: string): Promise<void> => {
      const sourceDir = relativeDir === '' ? from : join(from, relativeDir);
      const entries = await readdir(sourceDir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (this.ignored.has(entry.name)) continue;
        if (isSensitiveName(entry.name)) continue;

        const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        const source = join(from, relativePath);
        const target = join(to, relativePath);

        if (entry.isSymbolicLink()) {
          const real = await realpath(source).catch(() => null);
          if (!real || !isInside(from, real)) continue;
          const info = await stat(real).catch(() => null);
          // A symlinked directory is skipped: following links while walking is
          // how a copy acquires a cycle it cannot finish.
          if (!info || !info.isFile()) continue;
        } else if (entry.isDirectory()) {
          await mkdir(target, { recursive: true });
          await walk(relativePath);
          continue;
        } else if (!entry.isFile()) {
          continue;
        }

        count += 1;
        if (count > this.maxFiles) {
          throw new TeamError(
            'TEAM_WORKSPACE',
            `the source tree has more than ${this.maxFiles} files`,
            400,
            { maxFiles: this.maxFiles },
          );
        }

        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { force: true, dereference: true });
        const info = await stat(source);
        await chmod(target, info.mode & 0o777);
        files[relativePath] = {
          hash: await hashFileDigest(target),
          bytes: Number(info.size),
          executable: (info.mode & 0o111) !== 0,
        };
      }
    };

    await walk('');
    return files;
  }

  /** Relative paths of every regular file a caller may see. */
  private async walkFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    let count = 0;

    const walk = async (relativeDir: string): Promise<void> => {
      const absoluteDir = relativeDir === '' ? root : join(root, relativeDir);
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (this.ignored.has(entry.name)) continue;
        if (isSensitiveName(entry.name)) continue;

        const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        const absolute = join(root, relativePath);

        if (entry.isSymbolicLink()) {
          const real = await realpath(absolute).catch(() => null);
          if (!real || !isInside(root, real)) continue;
          const info = await stat(real).catch(() => null);
          if (!info || !info.isFile()) continue;
        } else if (entry.isDirectory()) {
          await walk(relativePath);
          continue;
        } else if (!entry.isFile()) {
          continue;
        }

        count += 1;
        if (count > this.maxFiles) {
          throw new TeamError(
            'TEAM_WORKSPACE',
            `the workspace has more than ${this.maxFiles} files`,
            400,
            { maxFiles: this.maxFiles },
          );
        }
        out.push(relativePath);
      }
    };

    await walk('');
    out.sort((left, right) => left.localeCompare(right));
    return out;
  }

  private async hashTree(root: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const path of await this.walkFiles(root)) {
      hashes[path] = await hashFileDigest(join(root, path));
    }
    return hashes;
  }

  private async inspectTree(
    root: string,
  ): Promise<{ hashes: Record<string, string>; files: Record<string, BaselineFileEntry> }> {
    const hashes: Record<string, string> = {};
    const files: Record<string, BaselineFileEntry> = {};
    for (const path of await this.walkFiles(root)) {
      const facts = await inspectFile(join(root, path), this.maxFileBytes);
      hashes[path] = facts.hash;
      files[path] = { hash: facts.hash, bytes: facts.bytes, executable: facts.executable };
    }
    return { hashes, files };
  }

  /**
   * Put a sandbox task row in place before the workspace row.
   *
   * `sandbox_workspaces.task_id` is a foreign key, and the Gateway's mount path
   * starts from `ensureTask`. Creating the placeholder task here is what makes
   * `SandboxToolProvider.forTask({taskId: workspaceTaskId})` find this workspace
   * instead of copying the source a second time. `ensureTask` is idempotent, so a
   * task the Gateway already created is left exactly as it is.
   */
  private async ensureTaskRow(
    workspaceTaskId: string,
    workspaceId: string,
    input: ProvisionInput,
    at: string,
  ): Promise<void> {
    const existing = await this.store.getTask(workspaceTaskId).catch(() => null);
    if (existing) return;
    await this.store.ensureTask({
      taskId: workspaceTaskId,
      sessionId: input.teamId,
      userId: input.ownerId,
      status: 'ACTIVE',
      workspaceId,
      sandboxId: null,
      createdAt: at,
      updatedAt: at,
    });
  }
}

// ------------------------------------------------------------------ helpers ---

/**
 * Sort-and-hash of a manifest's changed paths.
 *
 * The candidate hash has to change whenever the set of changes changes, and has
 * to be stable across two callers that produced the same changes: it is the
 * value a submission and a review compare.
 */
export function artifactCandidateHash(files: readonly ArtifactFile[]): string {
  const canonical = files
    .map((file) => {
      const path = normalizeArtifactPath(file.path, 'TEAM_WORKSPACE');
      return `${path}\u0000${file.change}\u0000${file.contentHash ?? '-'}\u0000${file.fromPath ?? '-'}`;
    })
    .sort();
  const hash = createHash('sha256');
  for (const line of canonical) {
    hash.update(line);
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Normalize a manifest path and refuse anything that could leave the root.
 *
 * Backslashes are treated as separators on purpose: a manifest produced on one
 * platform must not become an escape on another. `.` segments are dropped and
 * `..` is refused rather than clamped, because `a/../../etc/passwd` and
 * `etc/passwd` are different requests.
 */
export function normalizeArtifactPath(
  input: string,
  code: TeamErrorCode = 'TEAM_WORKSPACE',
): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TeamError(code, 'artifact path must be a non-empty string');
  }
  if (input.includes('\0')) throw new TeamError(code, 'artifact path must not contain NUL bytes');
  if (/[\r\n]/.test(input)) throw new TeamError(code, 'artifact path must not contain newlines');
  if (isAbsolute(input)) {
    throw new TeamError(code, `artifact path must be relative, got ${JSON.stringify(input)}`);
  }
  const parts: string[] = [];
  for (const part of input.split(/[\\/]+/)) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      throw new TeamError(code, `artifact path escapes its root: ${JSON.stringify(input)}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new TeamError(code, `artifact path is empty after normalization: ${JSON.stringify(input)}`);
  }
  return parts.join('/');
}

/** Deterministic workspace task id; the value the sandbox mounts by. */
export function teamWorkspaceTaskId(teamId: string, runId: string, memberId: string): string {
  const digest = createHash('sha256')
    .update(`${teamId}\u0000${runId}\u0000${memberId}`)
    .digest('hex')
    .slice(0, 32);
  return `teamws_${digest}`;
}

/** Deterministic workspace row id for a workspace task id. */
export function teamWorkspaceId(workspaceTaskId: string): string {
  return `ws_team_${createHash('sha256').update(workspaceTaskId).digest('hex').slice(0, 32)}`;
}

function baselineIdFor(workspaceTaskId: string, sourceVersion: string): string {
  return `bl_${createHash('sha256')
    .update(`${workspaceTaskId}\u0000${sourceVersion}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function treeVersion(hashes: Readonly<Record<string, string>>): string {
  const paths = Object.keys(hashes).sort();
  if (paths.length === 0) return 'empty';
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\u0000');
    hash.update(hashes[path] ?? '');
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function sanitizeName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  if (safe === value) return safe;
  return `${safe}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/**
 * Files whose contents are credentials, not code.
 *
 * Deliberately close to `WorkspacePathGuard.isSensitive`, with `.env*` treated as
 * a prefix so an unexpected `.env.local.bak` is excluded too.
 */
function isSensitiveName(name: string): boolean {
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name === '.npmrc' || name === '.netrc' || name === '.pypirc') return true;
  if (name === 'id_rsa' || name === 'id_ed25519' || name === 'id_dsa' || name === 'id_ecdsa') {
    return true;
  }
  if (name === 'credentials' || name === 'credentials.json' || name === 'secrets.json') {
    return true;
  }
  return ['.pem', '.key', '.p12', '.pfx', '.cer'].some((suffix) => name.endsWith(suffix));
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0);
}

async function inspectFile(absolute: string, maxContentBytes: number): Promise<FileFacts> {
  const info = await stat(absolute);
  const bytes = Number(info.size);
  const executable = (info.mode & 0o111) !== 0;

  if (bytes <= maxContentBytes) {
    const buffer = await readFile(absolute);
    const binary = hasNulByte(buffer);
    return {
      hash: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
      bytes,
      executable,
      binary,
      ...(binary ? {} : { content: buffer.toString('utf8') }),
    };
  }

  const head = await readHead(absolute, 8_000);
  return {
    hash: await hashFileDigest(absolute),
    bytes,
    executable,
    binary: head.includes(0),
  };
}

async function readHead(absolute: string, length: number): Promise<Buffer> {
  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashFileDigest(absolute: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error: Error) => reject(error));
    stream.on('end', () => resolveDigest(`sha256:${hash.digest('hex')}`));
  });
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TeamError('TEAM_WORKSPACE', `${label} must be a non-empty string`);
  }
  return value;
}

function parseBaseline(raw: unknown): StoredBaseline {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline file is not an object');
  }
  const record = raw as Record<string, unknown>;
  const baselineId = record.baselineId;
  if (typeof baselineId !== 'string' || baselineId.length === 0) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline file has no baselineId');
  }
  const sourceVersion = record.sourceVersion;
  if (typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline file has no sourceVersion');
  }
  const createdAt = record.createdAt;
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline file has no createdAt');
  }

  const rawHashes = record.hashes;
  if (typeof rawHashes !== 'object' || rawHashes === null || Array.isArray(rawHashes)) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline file has no hashes map');
  }
  const hashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHashes as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TeamError('TEAM_WORKSPACE', `baseline hash for ${JSON.stringify(key)} is not a string`);
    }
    const path = normalizeArtifactPath(key, 'TEAM_WORKSPACE');
    if (Object.prototype.hasOwnProperty.call(hashes, path)) {
      throw new TeamError('TEAM_WORKSPACE', `baseline lists ${path} twice`);
    }
    hashes[path] = value;
  }

  const rawFiles = record.files;
  if (rawFiles !== undefined && (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles))) {
    throw new TeamError('TEAM_WORKSPACE', 'baseline files map is not an object');
  }
  const files: Record<string, BaselineFileEntry> = {};
  for (const [key, value] of Object.entries(
    (rawFiles ?? {}) as Record<string, unknown>,
  )) {
    const path = normalizeArtifactPath(key, 'TEAM_WORKSPACE');
    if (typeof value !== 'object' || value === null) {
      throw new TeamError('TEAM_WORKSPACE', `baseline file entry for ${path} is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const hash = typeof entry.hash === 'string' ? entry.hash : hashes[path];
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new TeamError('TEAM_WORKSPACE', `baseline file entry for ${path} has no hash`);
    }
    const bytes = typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) ? entry.bytes : 0;
    files[path] = { hash, bytes, executable: entry.executable === true };
  }
  for (const [path, hash] of Object.entries(hashes)) {
    if (!files[path]) files[path] = { hash, bytes: 0, executable: false };
  }

  const workspaceTaskId =
    typeof record.workspaceTaskId === 'string' ? record.workspaceTaskId : undefined;

  return {
    baselineId,
    sourceVersion,
    hashes,
    files,
    createdAt,
    ...(workspaceTaskId === undefined ? {} : { workspaceTaskId }),
  };
}
