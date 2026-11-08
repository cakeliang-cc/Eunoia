/**
 * Merging member artifacts and publishing one candidate.
 *
 * Diffing a member workspace answers "what did this member change?"; it does not
 * answer "what does the team's work look like together?", and it certainly does
 * not answer "may these bytes replace the target file?". Those are two different
 * decisions with two different failure modes, so they are two functions:
 *
 *   - `integrateManifests` is pure. It merges one or two members' manifests into
 *     a candidate view and reports conflicts without touching the filesystem.
 *     Members may disagree, and the result keeps both contents so a human can
 *     choose; it never resolves a disagreement by "last writer wins".
 *   - `publishCandidate` writes. Every file is checked against the base the
 *     candidate was produced from, written through a temporary and renamed into
 *     place, and journaled so an interrupted publish has a trail.
 *
 * The conflict vocabulary is deliberately small and path-scoped. A change to a
 * file nobody touched must not block an integration; a change to the *same* file
 * must, because the candidate's diff was computed against a version that no
 * longer exists.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IntegrationJournalEntry } from './store.ts';
import type { ArtifactFile, ArtifactManifest } from './types.ts';
import { TeamError } from './types.ts';
import { artifactCandidateHash, normalizeArtifactPath } from './workspaces.ts';
import { faultPoint } from '../observability/faults.ts';

export interface ConflictReport {
  readonly path: string;
  readonly reason: 'both-modified' | 'deleted-vs-modified' | 'source-changed' | 'added-vs-added';
}

export interface IntegrateInput {
  /** The integration candidate dir. Created by the caller; unused by the merge. */
  readonly targetRoot: string;
  /** Base hashes the members branched from, keyed by target path. */
  readonly baseHashes: Readonly<Record<string, string>>;
  /** The candidate manifest, from member A. */
  readonly candidate: ArtifactManifest;
  /** An optional second member's manifest. */
  readonly other?: ArtifactManifest | null;
  /** Current hashes of the source root, for the staleness check. */
  readonly sourceHashes: Readonly<Record<string, string>>;
}

export interface IntegrateResult {
  /** The merged view: one entry per path, conflicts included. */
  readonly files: readonly ArtifactFile[];
  readonly conflicts: readonly ConflictReport[];
  readonly candidateHash: string;
  /** The base each conflicting path was expected to still have. */
  readonly baseHashOfConflicts: Readonly<Record<string, string>>;
  /**
   * Both members' text contents for a cross-member conflict, when the manifests
   * carried them. The caller shows this; nothing here picks a winner.
   */
  readonly conflictContent?: Readonly<
    Record<string, { readonly candidate: string | null; readonly other: string | null }>
  >;
}

// ---------------------------------------------------------------- integrate ---

/**
 * Merge one or two manifests and report conflicts. Pure: no filesystem access,
 * so the merge decision can be tested (and replayed) without a disk.
 */
export function integrateManifests(input: IntegrateInput): IntegrateResult {
  const candidate = manifestSide(input.candidate, 'candidate');
  const other = input.other
    ? manifestSide(input.other, 'other')
    : { writes: new Map<string, ArtifactFile>(), deletes: new Map<string, ArtifactFile>() };

  const baseHashes = input.baseHashes;
  const sourceHashes = input.sourceHashes;
  const paths = new Set<string>([
    ...candidate.writes.keys(),
    ...candidate.deletes.keys(),
    ...other.writes.keys(),
    ...other.deletes.keys(),
  ]);

  const files: ArtifactFile[] = [];
  const conflicts = new Map<string, ConflictReport>();
  const baseOfConflict = new Map<string, string>();
  const conflictContent: Record<string, { candidate: string | null; other: string | null }> = {};

  const addConflict = (
    path: string,
    reason: ConflictReport['reason'],
    baseHash: string | null | undefined,
  ): void => {
    if (conflicts.has(path)) return;
    conflicts.set(path, { path, reason });
    baseOfConflict.set(path, baseHash ?? '');
  };

  for (const path of [...paths].sort()) {
    const candidateWrite = candidate.writes.get(path);
    const otherWrite = other.writes.get(path);
    const candidateDelete = candidate.deletes.get(path);
    const otherDelete = other.deletes.get(path);

    // Both members wrote the same path.
    if (candidateWrite && otherWrite) {
      if (
        candidateWrite.contentHash !== null &&
        candidateWrite.contentHash === otherWrite.contentHash
      ) {
        files.push(mergeContents(candidateWrite, otherWrite));
        continue;
      }
      const bothAdded =
        candidateWrite.change === 'added' && otherWrite.change === 'added';
      addConflict(
        path,
        bothAdded ? 'added-vs-added' : 'both-modified',
        candidateWrite.baseHash ?? otherWrite.baseHash ?? baseHashes[path],
      );
      files.push(candidateWrite);
      if (
        candidateWrite.content !== undefined &&
        otherWrite.content !== undefined &&
        candidateWrite.content !== otherWrite.content
      ) {
        conflictContent[path] = {
          candidate: candidateWrite.content,
          other: otherWrite.content,
        };
      }
      continue;
    }

    // One member deleted what the other edited: never resolved silently, in
    // either direction.
    if (candidateWrite && otherDelete) {
      addConflict(
        path,
        'deleted-vs-modified',
        candidateWrite.baseHash ?? otherDelete.baseHash ?? baseHashes[path],
      );
      files.push(candidateWrite);
      continue;
    }
    if (candidateDelete && otherWrite) {
      addConflict(
        path,
        'deleted-vs-modified',
        otherWrite.baseHash ?? candidateDelete.baseHash ?? baseHashes[path],
      );
      files.push(otherWrite);
      continue;
    }

    // Both deleted the same file: agreement, not a conflict.
    if (candidateDelete && otherDelete) {
      files.push(candidateDelete);
      continue;
    }

    // Only the candidate changed this path.
    if (candidateWrite) {
      const reason = sourceConflict(candidateWrite, baseHashes, sourceHashes);
      if (reason) {
        addConflict(path, reason, candidateWrite.baseHash ?? baseHashes[path]);
      }
      files.push(candidateWrite);
      continue;
    }
    if (candidateDelete) {
      const expected = candidateDelete.baseHash ?? baseHashes[path] ?? null;
      const current = sourceHashes[path] ?? null;
      if (current !== null && (expected === null || current !== expected)) {
        addConflict(path, 'source-changed', expected);
      }
      // A rename's deletion is represented by its single `renamed` entry.
      if (candidateDelete.change !== 'renamed') files.push(candidateDelete);
      continue;
    }

    // Only the other member changed this path.
    if (otherWrite) {
      const reason = sourceConflict(otherWrite, baseHashes, sourceHashes);
      if (reason) addConflict(path, reason, otherWrite.baseHash ?? baseHashes[path]);
      files.push(otherWrite);
      continue;
    }
    if (otherDelete) {
      const expected = otherDelete.baseHash ?? baseHashes[path] ?? null;
      const current = sourceHashes[path] ?? null;
      if (current !== null && (expected === null || current !== expected)) {
        addConflict(path, 'source-changed', expected);
      }
      if (otherDelete.change !== 'renamed') files.push(otherDelete);
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const resolvedConflicts = [...conflicts.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return {
    files,
    conflicts: resolvedConflicts,
    candidateHash: artifactCandidateHash(files),
    baseHashOfConflicts: Object.fromEntries(baseOfConflict),
    ...(Object.keys(conflictContent).length === 0 ? {} : { conflictContent }),
  };
}

// ------------------------------------------------------------------ publish ---

export interface PublishInput {
  /** The directory files are published into. Created by the caller. */
  readonly targetRoot: string;
  readonly files: readonly ArtifactFile[];
  /** Current source hashes, used as a fallback base and a staleness warning. */
  readonly sourceHashes: Readonly<Record<string, string>>;
  /** The base hash each path is expected to still have. Authoritative. */
  readonly expectedHashes: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  /**
   * Where the candidate's bytes live when a manifest omits `content` (binary or
   * oversized files). Optional: a text-only candidate publishes without it.
   */
  readonly contentRoot?: string;
  /**
   * Optional durable journal file. Production callers do not need it; a fault
   * test reads it after the publishing process is killed, when the in-memory
   * array is gone.
   */
  readonly journalPath?: string;
}

export interface PublishResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly conflicts: readonly ConflictReport[];
  readonly journal: readonly IntegrationJournalEntry[];
  /** False when the publish stopped on a filesystem or content error. */
  readonly ok: boolean;
}

type PublishOperation =
  | { readonly kind: 'delete'; readonly path: string; readonly file: ArtifactFile }
  | { readonly kind: 'write'; readonly path: string; readonly file: ArtifactFile };

/**
 * Apply a candidate to a target directory.
 *
 * Ordering and recovery are the two properties that matter. Deletions run before
 * writes so a rename is literally "remove the old path, then create the new one",
 * and a retry with the same candidate sees files whose content already matches
 * and skips them — which is why re-running an interrupted publish cannot
 * duplicate an edit. A file whose current hash is not the expected base is never
 * overwritten; it becomes a conflict for the caller to resolve.
 */
export async function publishCandidate(input: PublishInput): Promise<PublishResult> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    throw new TeamError('TEAM_INTEGRATION_CONFLICT', 'idempotencyKey is required');
  }

  const operations = buildOperations(input.files);
  const root = await realpath(input.targetRoot).catch(() => null);
  if (!root) {
    throw new TeamError(
      'TEAM_INTEGRATION_CONFLICT',
      `publish target does not exist: ${input.targetRoot}`,
    );
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new TeamError('TEAM_INTEGRATION_CONFLICT', `publish target is not a directory: ${root}`);
  }

  // Validate every path before writing anything: a partial publish caused by a
  // bad path in the middle of the batch is exactly the state the journal is meant
  // to avoid.
  for (const operation of operations) await assertTargetPath(root, operation.path);

  const contentRoot = input.contentRoot
    ? await realpath(input.contentRoot).catch(() => null)
    : null;
  if (input.contentRoot && !contentRoot) {
    throw new TeamError(
      'TEAM_INTEGRATION_CONFLICT',
      `candidate content root does not exist: ${input.contentRoot}`,
    );
  }

  let applied: string[] = [];
  if (input.journalPath) {
    try {
      const { readFile } = await import('node:fs/promises');
      const prior = JSON.parse(await readFile(input.journalPath, 'utf8')) as {
        applied?: unknown;
      };
      if (Array.isArray(prior.applied)) {
        applied = prior.applied.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      // No prior journal: a fresh publish.
    }
  }
  const skipped: string[] = [];
  const conflicts: ConflictReport[] = [];
  const journal: IntegrationJournalEntry[] = [];
  const at = (): string => new Date().toISOString();

  journal.push({
    at: at(),
    action: 'publish-start',
    files: operations.map((operation) => operation.path),
    detail: input.idempotencyKey,
  });
  const persist = async (): Promise<void> => {
    if (!input.journalPath) return;
    const { writeFile, rename } = await import('node:fs/promises');
    const temporary = `${input.journalPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ applied, journal }, null, 2)}\n`,
      { mode: 0o600, encoding: 'utf8' },
    );
    await rename(temporary, input.journalPath);
  };
  await persist();

  const fail = (detail: string): PublishResult => {
    journal.push({ at: at(), action: 'failed', applied: [...applied], detail });
    return {
      ok: false,
      applied: [...applied],
      skipped: [...skipped],
      conflicts: [...conflicts],
      journal: [...journal],
    };
  };

  for (const operation of operations) {
    try {
      if (operation.kind === 'delete') {
        const outcome = await applyDelete(root, operation, input);
        if (outcome.conflict) conflicts.push(outcome.conflict);
        if (outcome.applied) {
          if (!applied.includes(operation.path)) applied.push(operation.path);
          await persist();
          await faultPoint('team.publish.after-file', {
            path: operation.path,
            applied: [...applied],
          });
        } else skipped.push(operation.path);
        continue;
      }
      const outcome = await applyWrite(root, operation, input, contentRoot);
      if (outcome.conflict) conflicts.push(outcome.conflict);
      if (outcome.applied) {
        if (!applied.includes(operation.path)) applied.push(operation.path);
        await persist();
        await faultPoint('team.publish.after-file', {
          path: operation.path,
          applied: [...applied],
        });
      } else skipped.push(operation.path);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  journal.push({
    at: at(),
    action: 'published',
    files: [...applied],
    detail: input.idempotencyKey,
  });
  await persist();

  return {
    ok: true,
    applied: [...applied],
    skipped: [...skipped],
    conflicts: [...conflicts],
    journal: [...journal],
  };
}

// ------------------------------------------------------------- merge helpers ---

interface ManifestSide {
  readonly writes: Map<string, ArtifactFile>;
  readonly deletes: Map<string, ArtifactFile>;
}

/**
 * Split a manifest into "paths whose content this member produced" and "paths this
 * member removed". A rename contributes to both, which is what makes
 * delete-vs-modified detectable against a second member.
 */
function manifestSide(manifest: ArtifactManifest, label: string): ManifestSide {
  const writes = new Map<string, ArtifactFile>();
  const deletes = new Map<string, ArtifactFile>();
  const fail = (message: string): never => {
    throw new TeamError('TEAM_INTEGRATION_CONFLICT', `${label} manifest: ${message}`);
  };

  for (const file of manifest.files) {
    const path = normalizeArtifactPath(file.path, 'TEAM_INTEGRATION_CONFLICT');
    switch (file.change) {
      case 'added':
      case 'modified': {
        if (writes.has(path)) fail(`lists ${path} twice`);
        writes.set(path, file);
        break;
      }
      case 'deleted': {
        if (deletes.has(path)) fail(`deletes ${path} twice`);
        deletes.set(path, file);
        break;
      }
      case 'renamed': {
        const from = file.fromPath;
        if (typeof from !== 'string' || from.length === 0) {
          fail(`renamed entry ${path} has no fromPath`);
          break;
        }
        const fromPath = normalizeArtifactPath(from, 'TEAM_INTEGRATION_CONFLICT');
        if (fromPath === path) fail(`renamed entry ${path} names itself as its source`);
        if (writes.has(path) || deletes.has(fromPath)) fail(`lists ${path} twice`);
        writes.set(path, file);
        deletes.set(fromPath, file);
        break;
      }
      default:
        fail(`has an unknown change ${JSON.stringify(file.change)}`);
    }
  }
  return { writes, deletes };
}

/** Keep both contents if only one side carried text. */
function mergeContents(left: ArtifactFile, right: ArtifactFile): ArtifactFile {
  if (left.content !== undefined || right.content === undefined) return left;
  return { ...left, content: right.content };
}

function sourceConflict(
  file: ArtifactFile,
  baseHashes: Readonly<Record<string, string>>,
  sourceHashes: Readonly<Record<string, string>>,
): ConflictReport['reason'] | null {
  const current = sourceHashes[file.path] ?? null;
  // Already applied: the source already holds exactly the candidate's bytes.
  if (current !== null && current === file.contentHash) return null;

  // A rename's new path and an addition have no base of their own; the base hash
  // on a renamed entry describes the *old* path, which is checked separately.
  const expected = file.baseHash ?? baseHashes[file.path] ?? null;
  if (file.change === 'added' || file.change === 'renamed' || expected === null) {
    if (current === null) return null;
    return 'added-vs-added';
  }
  if (current === null) return 'deleted-vs-modified';
  return current === expected ? null : 'source-changed';
}

// ----------------------------------------------------------- publish helpers ---

function buildOperations(files: readonly ArtifactFile[]): PublishOperation[] {
  const deletes: PublishOperation[] = [];
  const writes: PublishOperation[] = [];
  const written = new Set<string>();
  const deleted = new Set<string>();

  const pushDelete = (path: string, file: ArtifactFile): void => {
    if (deleted.has(path)) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', `the candidate deletes ${path} twice`);
    }
    deleted.add(path);
    deletes.push({ kind: 'delete', path, file });
  };
  const pushWrite = (path: string, file: ArtifactFile): void => {
    if (written.has(path)) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', `the candidate writes ${path} twice`);
    }
    written.add(path);
    writes.push({ kind: 'write', path, file });
  };

  for (const file of files) {
    const path = normalizeArtifactPath(file.path, 'TEAM_INTEGRATION_CONFLICT');
    switch (file.change) {
      case 'added':
      case 'modified':
        pushWrite(path, file);
        break;
      case 'deleted':
        pushDelete(path, file);
        break;
      case 'renamed': {
        if (typeof file.fromPath !== 'string' || file.fromPath.length === 0) {
          throw new TeamError(
            'TEAM_INTEGRATION_CONFLICT',
            `renamed entry ${path} has no fromPath`,
          );
        }
        const fromPath = normalizeArtifactPath(file.fromPath, 'TEAM_INTEGRATION_CONFLICT');
        if (fromPath === path) {
          throw new TeamError(
            'TEAM_INTEGRATION_CONFLICT',
            `renamed entry ${path} names itself as its source`,
          );
        }
        // Rename is delete plus write, in that order: the new path is created
        // only after the old one is gone, so a retry is unambiguous.
        pushDelete(fromPath, file);
        pushWrite(path, file);
        break;
      }
      default:
        throw new TeamError(
          'TEAM_INTEGRATION_CONFLICT',
          `unknown change ${JSON.stringify(file.change)} for ${path}`,
        );
    }
  }

  const byPath = (left: PublishOperation, right: PublishOperation): number =>
    left.path.localeCompare(right.path);
  return [...deletes.sort(byPath), ...writes.sort(byPath)];
}

async function applyDelete(
  root: string,
  operation: Extract<PublishOperation, { kind: 'delete' }>,
  input: PublishInput,
): Promise<{ applied: boolean; conflict: ConflictReport | null }> {
  const absolute = join(root, operation.path);
  const info = await lstat(absolute).catch(() => null);
  if (!info) return { applied: false, conflict: null };
  if (info.isDirectory()) {
    return { applied: false, conflict: { path: operation.path, reason: 'source-changed' } };
  }
  // `rm` unlinks a symbolic link rather than following it, so removing a link
  // whose target is outside the target root is safe.
  if (info.isSymbolicLink()) {
    await rm(absolute, { force: true });
    return { applied: true, conflict: null };
  }

  const current = await hashFileDigest(absolute);
  const expected = expectedBase(operation.path, operation.file, input, 'delete');
  if (expected === null || current !== expected) {
    return { applied: false, conflict: { path: operation.path, reason: 'source-changed' } };
  }
  await rm(absolute, { force: true });
  return { applied: true, conflict: null };
}

async function applyWrite(
  root: string,
  operation: Extract<PublishOperation, { kind: 'write' }>,
  input: PublishInput,
  contentRoot: string | null,
): Promise<{ applied: boolean; conflict: ConflictReport | null }> {
  const absolute = join(root, operation.path);
  const info = await lstat(absolute).catch(() => null);
  if (info?.isDirectory()) {
    return { applied: false, conflict: { path: operation.path, reason: 'source-changed' } };
  }
  const current = info ? await hashFileDigest(absolute) : null;

  // Already applied: the retry path. Compared by content, not by key, so even a
  // recovery call that only remembers the candidate cannot write twice.
  if (current !== null && current === operation.file.contentHash) {
    return { applied: false, conflict: null };
  }

  const expected = expectedBase(operation.path, operation.file, input, 'write');
  if (expected !== null && current !== expected) {
    return {
      applied: false,
      conflict: {
        path: operation.path,
        reason: current === null ? 'deleted-vs-modified' : 'source-changed',
      },
    };
  }
  if (expected === null && current !== null) {
    return { applied: false, conflict: { path: operation.path, reason: 'added-vs-added' } };
  }

  const bytes = await resolveContent(operation.file, contentRoot);
  await writeAtomically(absolute, bytes, operation.file.executable);
  return { applied: true, conflict: null };
}

function expectedBase(
  path: string,
  file: ArtifactFile,
  input: PublishInput,
  operation: 'delete' | 'write',
): string | null {
  const explicit = input.expectedHashes[path];
  if (explicit !== undefined) return explicit;
  if (operation === 'write' && (file.change === 'added' || file.change === 'renamed')) {
    // The destination of an addition or a rename has no base of its own. The
    // `baseHash` on a renamed entry describes the file at `fromPath`.
    return null;
  }
  return file.baseHash ?? input.sourceHashes[path] ?? null;
}

async function resolveContent(
  file: ArtifactFile,
  contentRoot: string | null,
): Promise<Buffer> {
  if (file.content !== undefined) {
    const bytes = Buffer.from(file.content, 'utf8');
    verifyContentHash(file, bytes, 'manifest content');
    return bytes;
  }
  if (contentRoot) {
    const candidate = resolve(contentRoot, file.path);
    if (!isInside(contentRoot, candidate)) {
      throw new TeamError(
        'TEAM_INTEGRATION_CONFLICT',
        `candidate path escapes the content root: ${file.path}`,
      );
    }
    const bytes = await readFile(candidate).catch(() => null);
    if (!bytes) {
      throw new TeamError(
        'TEAM_INTEGRATION_STALE',
        `candidate content is missing for ${file.path}`,
      );
    }
    verifyContentHash(file, bytes, 'candidate content');
    return bytes;
  }
  throw new TeamError(
    'TEAM_INTEGRATION_STALE',
    `no content is available for ${file.path}; the manifest omits it (binary or oversized)`,
  );
}

function verifyContentHash(file: ArtifactFile, bytes: Buffer, label: string): void {
  if (file.contentHash === null) {
    throw new TeamError('TEAM_INTEGRATION_STALE', `no content hash for ${file.path}`);
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== file.contentHash) {
    throw new TeamError(
      'TEAM_INTEGRATION_STALE',
      `${label} for ${file.path} does not match its content hash`,
    );
  }
}

/**
 * Write through a temporary in the destination directory and rename into place.
 *
 * The mode is set on the temporary before the rename: `writeFile`'s `mode` is
 * filtered by the process umask, which would silently drop the executable bit.
 */
async function writeAtomically(
  absolute: string,
  bytes: Buffer,
  executable: boolean,
): Promise<void> {
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true });
  const mode = executable ? 0o755 : 0o644;
  const temporary = join(directory, `.eunoia-publish-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Refuse a path whose real location is outside the target root.
 *
 * The nearest existing ancestor is resolved, so a symlinked parent cannot be used
 * to create a file somewhere else; the final component is refused when it is a
 * link, because a write through it would escape no matter what the parent says.
 */
async function assertTargetPath(root: string, path: string): Promise<void> {
  const absolute = resolve(root, path);
  if (absolute === root || !isInside(root, absolute)) {
    throw new TeamError(
      'TEAM_INTEGRATION_CONFLICT',
      `path escapes the publish target: ${JSON.stringify(path)}`,
    );
  }
  let current = dirname(absolute);
  while (true) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) {
      if (!isInside(root, real)) {
        throw new TeamError(
          'TEAM_INTEGRATION_CONFLICT',
          `${JSON.stringify(path)} resolves outside the publish target`,
        );
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing = await lstat(absolute).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new TeamError(
      'TEAM_INTEGRATION_CONFLICT',
      `${JSON.stringify(path)} is a symbolic link; refusing to publish through it`,
    );
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
