/**
 * Turn-scoped workspace undo (ADR 036).
 *
 * Three facts are combined here, and each answers a question the others cannot:
 *
 *   1. **A manifest diff** says what the turn changed, including files created by
 *      a command. It is content-based, so a rewrite that changed nothing is not
 *      a change.
 *   2. **A write journal** keeps the exact prior bytes of files the agent
 *      overwrote through the file tools. That is what makes restoring them
 *      precise rather than "check out the old tree".
 *   3. **A checkpoint** is taken before the first command of a turn, because a
 *      command can change any file and no write hook sees it.
 *
 * Undo is deliberately conservative. It applies a file only when the current
 * bytes still match the bytes the turn ended with. Anything the person edited,
 * deleted or re-created afterwards becomes a conflict, not an overwrite. That is
 * the difference between undo and a second, silent write.
 *
 * External MCP operations are not handled here and are never claimed to be:
 * a server-side write has no generic inverse.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxStore } from './store.ts';
import type { Workspace } from './types.ts';
import type { WorkspaceManager } from './workspace-manager.ts';
import type { WorkspaceChangeRecorder } from './workspace-changes.ts';
import type {
  ChangesetFileRecord,
  ChangesetStatus,
  WorkspaceChangesetRecord,
  WorkspaceChangesetSummary,
  WorkspaceUndoResult,
  ChangesetStore,
} from '../session/changeset.ts';
import type { WorkspaceManifestEntry } from './workspace-files.ts';
import { log } from '../observability/logging.ts';
import { acquireWorkspaceWriteLocks, withWorkspaceWriteLocks } from './write-lock.ts';

/** One file can keep its before text up to this size; larger files need a checkpoint. */
const MAX_JOURNAL_BYTES = 512 * 1024;
/** A turn that touches more files than this is reported as too large to undo. */
const MAX_MANIFEST_FILES = 5_000;

interface JournalEntry {
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface ActiveTurn {
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly workspace: Workspace;
  /** Captured lazily before the first mutation; null means the turn never wrote. */
  baseline: readonly WorkspaceManifestEntry[] | null;
  readonly journal: Map<string, JournalEntry>;
  checkpointId: string | null;
  readonly startedAt: string;
}

export interface WorkspaceChangeServiceDeps {
  readonly store: SandboxStore;
  readonly workspaces: WorkspaceManager;
  readonly changesets: ChangesetStore;
  readonly now?: () => Date;
  /**
   * Directory for the cross-file change journal. Absent keeps the journal in
   * memory (tests); a deployment passes a private data directory so a crash
   * leaves `prepared`/`needs_reconciliation` evidence on disk.
   */
  readonly journalRoot?: string | null;
}

export class WorkspaceChangeService implements WorkspaceChangeRecorder {
  readonly #store: SandboxStore;
  readonly #workspaces: WorkspaceManager;
  readonly #changesets: ChangesetStore;
  readonly #now: () => Date;
  readonly #journalRoot: string | null;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #batches = new Map<string, ChangeBatchRecord>();

  constructor(deps: WorkspaceChangeServiceDeps) {
    this.#store = deps.store;
    this.#workspaces = deps.workspaces;
    this.#changesets = deps.changesets;
    this.#now = deps.now ?? (() => new Date());
    this.#journalRoot = deps.journalRoot ?? null;
  }

  /**
   * The tool-facing port for one task.
   *
   * Every write/edit/patch in that task goes through one lock and one version
   * check. The port is what `ToolContext.changes` carries, so a tool cannot
   * bypass it by calling the workspace port directly.
   */
  port(taskId: string): import('../tools/types.ts').ToolChangeJournal {
    return {
      beforeWrite: (path) => this.beforeWrite({ taskId, path }),
      writeText: (input) => this.writeText({ taskId, ...input }),
      editText: (input) => this.editText({ taskId, ...input }),
      lockPaths: (paths, run) => this.#withLock(taskId, paths, run),
      beginBatch: (input) => this.beginBatch({ taskId, ...input }),
      markBatchApplied: (batchId, path, afterSha) =>
        this.markBatchApplied({ batchId, path, afterSha }),
      completeBatch: (batchId) => this.completeBatch(batchId),
      markBatchReconciliation: (batchId, reasons) =>
        this.markBatchReconciliation(batchId, reasons),
    };
  }

  /**
   * Version-checked overwrite/create.
   *
   * `expectedSha` is the digest of the complete file the model read. A
   * mismatch means somebody changed the file after that read; writing anyway
   * would be exactly the lost update R03 exists to prevent.
   */
  async writeText(input: {
    readonly taskId: string;
    readonly path: string;
    readonly content: string;
    readonly expectedSha: string | null;
  }): Promise<{ readonly path: string; readonly bytes: number; readonly lines: number; readonly created: boolean }> {
    return this.#withLock(input.taskId, [input.path], async () => {
      const active = this.#requireActive(input.taskId);
      const files = this.#workspaces.files(active.workspace.storageLocation);
      const current = await readCurrentText(files, input.path);
      if (input.expectedSha === null) {
        if (current.exists) {
          throw new WorkspaceChangeConflict(
            `${input.path} 在执行期间被创建；请重新读取后再写，不能用空版本覆盖它。`,
          );
        }
      } else if (!current.exists || current.sha256 !== input.expectedSha) {
        throw new WorkspaceChangeConflict(
          `${input.path} 在读取之后发生了变化；请重新读取当前内容再写，不能用旧版本覆盖。`,
        );
      }
      await this.beforeWrite({ taskId: input.taskId, path: input.path });
      const result = await files.writeText(input.path, input.content);
      return {
        path: result.path,
        bytes: result.bytes,
        lines: result.lines,
        created: result.created,
      };
    });
  }

  async editText(input: {
    readonly taskId: string;
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll: boolean;
    readonly expectedSha: string | null;
  }): Promise<{ readonly path: string; readonly replacements: number; readonly bytes: number }> {
    return this.#withLock(input.taskId, [input.path], async () => {
      const active = this.#requireActive(input.taskId);
      const files = this.#workspaces.files(active.workspace.storageLocation);
      const current = await readCurrentText(files, input.path);
      if (!current.exists) throw new WorkspaceChangeConflict(`${input.path} 不存在，不能编辑。`);
      if (input.expectedSha !== null && current.sha256 !== input.expectedSha) {
        throw new WorkspaceChangeConflict(
          `${input.path} 在读取之后发生了变化；请重新读取后再编辑，不能覆盖别人的修改。`,
        );
      }
      await this.beforeWrite({ taskId: input.taskId, path: input.path });
      const result = await files.editText({
        path: input.path,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      });
      return {
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
      };
    });
  }

  async beginBatch(input: {
    readonly taskId: string;
    readonly batchId: string;
    readonly paths: readonly string[];
    readonly before: Readonly<Record<string, string | null>>;
    readonly after: Readonly<Record<string, string | null>>;
  }): Promise<void> {
    const record: ChangeBatchRecord = {
      batchId: input.batchId,
      taskId: input.taskId,
      state: 'prepared',
      before: input.before,
      after: input.after,
      applied: {},
      reasons: [],
      createdAt: this.#now().toISOString(),
      updatedAt: this.#now().toISOString(),
    };
    this.#batches.set(input.batchId, record);
    await this.#persistBatch(record);
  }

  async markBatchApplied(input: {
    readonly batchId: string;
    readonly path: string;
    readonly afterSha: string | null;
  }): Promise<void> {
    const record = this.#batches.get(input.batchId);
    if (!record) return;
    record.applied[input.path] = input.afterSha;
    record.updatedAt = this.#now().toISOString();
    await this.#persistBatch(record);
  }

  async completeBatch(batchId: string): Promise<void> {
    const record = this.#batches.get(batchId);
    if (!record) return;
    record.state = 'completed';
    record.updatedAt = this.#now().toISOString();
    await this.#persistBatch(record);
  }

  async markBatchReconciliation(batchId: string, reasons: readonly string[]): Promise<void> {
    const record = this.#batches.get(batchId);
    if (!record) return;
    record.state = 'needs_reconciliation';
    record.reasons = [...reasons];
    record.updatedAt = this.#now().toISOString();
    await this.#persistBatch(record);
  }

  /** Incomplete batches, for a restart report or an API; never auto-replayed. */
  async listIncompleteBatches(): Promise<readonly ChangeBatchRecord[]> {
    const records = [...this.#batches.values()].filter((record) => record.state !== 'completed');
    if (this.#journalRoot) {
      try {
        const files = await readdir(this.#journalRoot);
        for (const file of files.filter((entry) => entry.endsWith('.json'))) {
          try {
            const parsed = JSON.parse(
              await readFile(join(this.#journalRoot, file), 'utf8'),
            ) as ChangeBatchRecord;
            if (parsed.state !== 'completed' && !records.some((r) => r.batchId === parsed.batchId)) {
              records.push(parsed);
            }
          } catch {
            // A malformed journal is not silently green: list it as unknown.
            records.push({
              batchId: file.replace(/\.json$/, ''),
              taskId: '',
              state: 'needs_reconciliation',
              before: {},
              after: {},
              applied: {},
              reasons: ['journal file is malformed'],
              createdAt: '',
              updatedAt: '',
            });
          }
        }
      } catch {
        // No journal directory yet.
      }
    }
    return records;
  }

  /**
   * Arm undo for one turn.
   *
   * Cheap by design: the baseline manifest is captured lazily, on the first
   * write or command. A read-only or conversational turn therefore pays nothing,
   * and the baseline still predates every mutation it describes.
   */
  async arm(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly taskId: string;
  }): Promise<boolean> {
    if (this.#active.has(input.taskId)) {
      // Admission should make this impossible; if it happens, keep the older
      // turn's context rather than losing the action it belongs to.
      log.warn('workspace_changes.already_active', {
        task_id: input.taskId,
        turn_id: input.turnId,
      });
      return false;
    }
    const workspace = await this.#store.getWorkspaceForTask(input.taskId).catch(() => null);
    if (!workspace) return false;
    this.#active.set(input.taskId, {
      userId: input.userId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      taskId: input.taskId,
      workspace,
      baseline: null,
      journal: new Map(),
      checkpointId: null,
      startedAt: this.#now().toISOString(),
    });
    return true;
  }

  /**
   * Capture the baseline once, before the first mutation.
   *
   * Returns false when the manifest is too large or unreadable; the turn is then
   * made non-undoable rather than half-described.
   */
  async #ensureBaseline(active: ActiveTurn): Promise<boolean> {
    if (active.baseline !== null) return true;
    try {
      const manifest = await this.#workspaces.manifest(active.workspace);
      if (manifest.truncated) {
        log.warn('workspace_changes.manifest_truncated', { task_id: active.taskId });
        this.#active.delete(active.taskId);
        return false;
      }
      active.baseline = manifest.entries;
      return true;
    } catch (error) {
      log.warn('workspace_changes.baseline_failed', {
        task_id: active.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#active.delete(active.taskId);
      return false;
    }
  }

  /** Record a file's prior bytes before the agent overwrites it. */
  async beforeWrite(input: { readonly taskId: string; readonly path: string }): Promise<void> {
    const active = this.#active.get(input.taskId);
    if (!active || active.journal.has(input.path)) return;
    if (!(await this.#ensureBaseline(active))) return;
    const files = this.#workspaces.files(active.workspace.storageLocation);
    try {
      const resolved = files.resolve(input.path);
      const info = await files.stat(input.path);
      if (!info || info.size > MAX_JOURNAL_BYTES) return;
      const before = await readFile(resolved.host);
      const text = before.toString('utf8');
      // A non-text file cannot be restored from a string; the checkpoint path is
      // the only honest option for it.
      if (text.includes('\u0000')) return;
      active.journal.set(input.path, {
        content: text,
        sha256: sha256(before),
        bytes: before.length,
      });
    } catch {
      // A file that cannot be read now is not restorable from a journal; the
      // manifest and checkpoint still describe it.
    }
  }

  /** Take the one checkpoint a command-needing turn requires. */
  async beforeCommand(input: { readonly taskId: string }): Promise<void> {
    const active = this.#active.get(input.taskId);
    if (!active || active.checkpointId !== null) return;
    if (!(await this.#ensureBaseline(active))) return;
    try {
      const checkpoint = await this.#workspaces.createCheckpoint(active.workspace, null);
      active.checkpointId = checkpoint.checkpointId;
    } catch (error) {
      log.warn('workspace_changes.checkpoint_failed', {
        task_id: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Finish the turn, diff the workspace and persist the change set.
   *
   * Called on success, failure and cancellation; a failed turn may still have
   * written files. Returns null when nothing changed (no button to offer).
   */
  async finish(input: {
    readonly userId: string;
    readonly turnId: string;
  }): Promise<WorkspaceChangesetSummary | null> {
    const active = [...this.#active.values()].find(
      (entry) => entry.userId === input.userId && entry.turnId === input.turnId,
    );
    if (!active) return null;
    this.#active.delete(active.taskId);
    // No baseline means no mutation was ever reported; there is nothing to undo.
    if (active.baseline === null) return null;
    try {
      const after = await this.#workspaces.manifest(active.workspace);
      if (after.truncated) {
        log.warn('workspace_changes.finish_truncated', { task_id: active.taskId });
        return null;
      }
      const beforeByPath = new Map(active.baseline.map((entry) => [entry.path, entry]));
      const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
      const files: ChangesetFileRecord[] = [];

      for (const [path, entry] of afterByPath) {
        const previous = beforeByPath.get(path);
        if (!previous) {
          if (entry.sha256 === null) continue;
          files.push(record('added', path, null, entry, active));
          continue;
        }
        if (previous.sha256 === entry.sha256) continue;
        if (entry.sha256 === null) continue;
        files.push(record('modified', path, previous, entry, active));
      }
      for (const [path, entry] of beforeByPath) {
        if (afterByPath.has(path)) continue;
        if (entry.sha256 === null) continue;
        files.push(record('deleted', path, entry, null, active));
      }

      if (files.length === 0) return null;
      if (files.length > MAX_MANIFEST_FILES) {
        log.warn('workspace_changes.too_many_files', {
          task_id: active.taskId,
          files: files.length,
        });
        return null;
      }

      const summary: WorkspaceChangesetSummary = {
        id: `wcs_${randomUUID()}`,
        userId: active.userId,
        conversationId: active.conversationId,
        turnId: active.turnId,
        workspaceId: active.workspace.workspaceId,
        checkpointId: active.checkpointId,
        beforeDigest: digestOf(active.baseline),
        afterDigest: digestOf(after.entries),
        fileCount: files.length,
        added: files.filter((file) => file.kind === 'added').length,
        modified: files.filter((file) => file.kind === 'modified').length,
        deleted: files.filter((file) => file.kind === 'deleted').length,
        status: 'available',
        createdAt: this.#now().toISOString(),
        undoneAt: null,
      };
      await this.#changesets.createWorkspaceChangeset({ summary, files });
      return summary;
    } catch (error) {
      log.warn('workspace_changes.finish_failed', {
        task_id: active.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Undo a change set.
   *
   * Per file: restore only when the current digest still equals the turn's
   * after-digest. A mismatch becomes a conflict; `force` is the explicit
   * override, and even then the reason is reported.
   */
  /**
   * Read-only undo preflight (R11): what would restore, what would conflict and
   * which paths are blocked by a later changeset. It never writes.
   */
  async planUndo(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly changesetId: string;
    readonly paths?: readonly string[];
  }): Promise<{
    changesetId: string;
    turnId: string;
    files: Array<{
      path: string;
      kind: ChangesetFileRecord['kind'];
      currentSha: string | null;
      afterSha: string | null;
      matches: boolean;
      restorable: boolean;
      reason: string | null;
    }>;
    blocked: Array<{ path: string; reason: string }>;
  }> {
    const changeset = await this.#changesets.getWorkspaceChangeset(
      input.userId,
      input.changesetId,
    );
    if (!changeset || changeset.conversationId !== input.conversationId) {
      throw new WorkspaceUndoError('NO_CHANGESET', '这一轮没有可撤销的文件改动。', 404);
    }
    const workspace = await this.#store.getWorkspace(changeset.workspaceId);
    if (!workspace) {
      throw new WorkspaceUndoError('NO_WORKSPACE', '工作区已经不存在，无法撤销。', 409);
    }
    const files = this.#workspaces.files(workspace.storageLocation);
    const selected = selectFiles(changeset, input.paths);
    const blocked = await this.#laterDependencies(changeset, selected);
    const results = [] as Array<{
      path: string;
      kind: ChangesetFileRecord['kind'];
      currentSha: string | null;
      afterSha: string | null;
      matches: boolean;
      restorable: boolean;
      reason: string | null;
    }>;
    for (const file of selected) {
      const current = await currentDigest(files, file.path).catch(() => undefined);
      const matches = current !== undefined && current.sha256 === file.afterSha;
      const blocker = blocked.find((entry) => entry.path === file.path);
      results.push({
        path: file.path,
        kind: file.kind,
        currentSha: current?.sha256 ?? null,
        afterSha: file.afterSha,
        matches,
        restorable: !file.restored && matches && !blocker,
        reason: file.restored
          ? '已经撤销过'
          : blocker
            ? blocker.reason
            : matches
              ? null
              : '文件在本轮之后被修改或重建',
      });
    }
    return {
      changesetId: changeset.id,
      turnId: changeset.turnId,
      files: results,
      blocked,
    };
  }

  async undo(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly changesetId: string;
    readonly force?: boolean;
    /** A strict subset. Absent means every file in the changeset. */
    readonly paths?: readonly string[];
  }): Promise<WorkspaceUndoResult> {
    const changeset = await this.#changesets.getWorkspaceChangeset(
      input.userId,
      input.changesetId,
    );
    if (!changeset || changeset.conversationId !== input.conversationId) {
      throw new WorkspaceUndoError('NO_CHANGESET', '这一轮没有可撤销的文件改动。', 404);
    }
    if (changeset.status === 'undone') {
      return emptyResult(changeset, true);
    }
    const workspace = await this.#store.getWorkspace(changeset.workspaceId);
    if (!workspace) {
      throw new WorkspaceUndoError('NO_WORKSPACE', '工作区已经不存在，无法撤销。', 409);
    }
    const files = this.#workspaces.files(workspace.storageLocation);
    const restored: string[] = [];
    const deleted: string[] = [];
    const conflicts: { path: string; reason: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const selected = selectFiles(changeset, input.paths);
    if (input.paths && input.paths.length > 0) {
      // A partial undo must not break a later change that depends on this one.
      const blocked = await this.#laterDependencies(changeset, selected);
      if (blocked.length > 0 && input.force !== true) {
        throw new WorkspaceUndoError(
          'UNDO_SCOPE_BLOCKED',
          `这些文件在后续修改中仍被使用，不能单独撤销：${blocked.map((entry) => entry.path).join('、')}。请先撤销后续修改，或选择完整范围。`,
          409,
        );
      }
    }

    const releaseUndo = await acquireWorkspaceWriteLocks(
      selected.map((file) => join(workspace.storageLocation, file.path)),
    );
    try {
    for (const file of selected) {
      if (file.restored) continue;
      const current = await currentDigest(files, file.path).catch(() => undefined);
      const matches = current !== undefined && current.sha256 === file.afterSha;
      if (!matches && input.force !== true) {
        conflicts.push({
          path: file.path,
          reason:
            current === undefined
              ? '文件无法读取，不能确认它是否仍是本轮结束时的内容。'
              : file.afterSha === null
                ? '文件在本轮之后被重新创建；撤销不会覆盖你后来的文件。'
                : '文件在本轮之后被修改过；撤销不会覆盖你后来的修改。',
        });
        continue;
      }
      try {
        if (file.kind === 'added') {
          if (current !== undefined) {
            await files.deleteFile(file.path);
            deleted.push(file.path);
          }
          restored.push(file.path);
          continue;
        }
        const content = await this.#beforeContent(changeset, file);
        if (content === null) {
          skipped.push({
            path: file.path,
            reason:
              file.restoreSource === 'none'
                ? '没有可用的修改前内容（可能是命令修改且未建立快照）。'
                : '快照已经被清理，无法恢复修改前内容。',
          });
          continue;
        }
        if (sha256(Buffer.from(content, 'utf8')) !== file.beforeSha) {
          skipped.push({ path: file.path, reason: '保存的修改前内容与摘要不一致，已拒绝恢复。' });
          continue;
        }
        await files.writeText(file.path, content);
        restored.push(file.path);
      } catch (error) {
        conflicts.push({
          path: file.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    } finally {
      await releaseUndo();
    }
    const applied = new Set(restored);
    const remaining = changeset.files.some(
      (file) => !file.restored && !applied.has(file.path),
    );
    const status: ChangesetStatus = remaining ? 'partial' : 'undone';
    await this.#changesets.finishWorkspaceUndo({
      userId: input.userId,
      changesetId: changeset.id,
      restoredPaths: restored,
      status,
      undoneAt: this.#now().toISOString(),
    });
    return {
      changesetId: changeset.id,
      turnId: changeset.turnId,
      status,
      restored,
      deleted,
      conflicts,
      skipped,
      alreadyUndone: false,
    };
  }

  #requireActive(taskId: string): ActiveTurn {
    const active = this.#active.get(taskId);
    if (!active) {
      throw new WorkspaceChangeConflict(
        '本轮没有启用修改记录或工作区未就绪，不能执行受版本保护的写入。',
      );
    }
    return active;
  }

  async #withLock<T>(taskId: string, paths: readonly string[], run: () => Promise<T>): Promise<T> {
    // The lock identity is the canonical real workspace path, not the task id:
    // two tasks may be bound to the same source directory, and Team publish
    // writes that same source. A task-scoped Map would serialize the wrong
    // writers and let one task overwrite the other after both passed a
    // version check.
    const active = this.#requireActive(taskId);
    const absolute = paths.map((path) => join(active.workspace.storageLocation, path));
    return withWorkspaceWriteLocks(absolute, run);
  }

  async #persistBatch(record: ChangeBatchRecord): Promise<void> {
    if (!this.#journalRoot) return;
    await mkdir(this.#journalRoot, { recursive: true });
    await writeFile(
      join(this.#journalRoot, `${record.batchId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, encoding: 'utf8' },
    );
  }

  /**
   * Later turns that still have an available/partial changeset on a selected
   * path. Undoing the earlier file under them would make the later record a lie.
   */
  async #laterDependencies(
    changeset: WorkspaceChangesetRecord,
    selected: readonly ChangesetFileRecord[],
  ): Promise<Array<{ path: string; reason: string }>> {
    const all = await this.#changesets.listWorkspaceChangesets(
      changeset.userId,
      changeset.conversationId,
      1_000,
    );
    const blocked: Array<{ path: string; reason: string }> = [];
    for (const summary of all) {
      if (summary.id === changeset.id || summary.status === 'undone') continue;
      const record = await this.#changesets.getWorkspaceChangeset(changeset.userId, summary.id);
      if (!record) continue;
      for (const file of selected) {
        const currentAfter = changeset.files.find((entry) => entry.path === file.path)?.afterSha ?? null;
        const laterFile = record.files.find((entry) => entry.path === file.path);
        if (!laterFile) continue;
        // A later record that started exactly from this record's after state is
        // a dependency even when both rows share the same millisecond (common in
        // tests and fast turns). Timestamp is only a fallback for a later
        // independent edit of the same path.
        const chained = laterFile.beforeSha === currentAfter;
        if (chained || summary.createdAt > changeset.createdAt) {
          blocked.push({
            path: file.path,
            reason: `后续第 ${record.turnId.slice(0, 8)} 轮仍引用了这个文件`,
          });
          break;
        }
      }
    }
    return blocked;
  }

  async #beforeContent(
    changeset: WorkspaceChangesetRecord,
    file: ChangesetFileRecord,
  ): Promise<string | null> {
    if (file.beforeContent !== null) return file.beforeContent;
    if (!changeset.checkpointId) return null;
    const buffer = await this.#workspaces.readCheckpointFile(
      changeset.workspaceId,
      changeset.checkpointId,
      file.path,
    );
    if (!buffer) return null;
    const text = buffer.toString('utf8');
    return text.includes('\u0000') ? null : text;
  }
}

export interface ChangeBatchRecord {
  readonly batchId: string;
  readonly taskId: string;
  state: 'prepared' | 'completed' | 'needs_reconciliation';
  readonly before: Readonly<Record<string, string | null>>;
  readonly after: Readonly<Record<string, string | null>>;
  readonly applied: Record<string, string | null>;
  reasons: readonly string[];
  readonly createdAt: string;
  updatedAt: string;
}

export class WorkspaceChangeConflict extends Error {
  readonly code = 'CHANGE_CONFLICT';
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceChangeConflict';
  }
}

export class WorkspaceUndoError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'WorkspaceUndoError';
    this.code = code;
    this.status = status;
  }
}

function record(
  kind: ChangesetFileRecord['kind'],
  path: string,
  before: WorkspaceManifestEntry | null,
  after: WorkspaceManifestEntry | null,
  active: ActiveTurn,
): ChangesetFileRecord {
  const journal = active.journal.get(path) ?? null;
  const restoreSource: ChangesetFileRecord['restoreSource'] =
    kind === 'added'
      ? 'none'
      : journal
        ? 'journal'
        : active.checkpointId
          ? 'checkpoint'
          : 'none';
  return {
    path,
    kind,
    beforeSha: before?.sha256 ?? null,
    afterSha: after?.sha256 ?? null,
    beforeBytes: before?.size ?? null,
    afterBytes: after?.size ?? null,
    beforeContent: restoreSource === 'journal' ? (journal?.content ?? null) : null,
    restoreSource,
    restored: false,
  };
}

function digestOf(entries: readonly WorkspaceManifestEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path);
    hash.update('\u0000');
    hash.update(entry.sha256 ?? 'unreadable');
    hash.update('\u0000');
    hash.update(String(entry.size));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function currentDigest(
  files: ReturnType<WorkspaceManager['files']>,
  path: string,
): Promise<{ readonly sha256: string | null; readonly size: number }> {
  const resolved = files.resolve(path);
  const info = await files.stat(path);
  if (!info) return { sha256: null, size: 0 };
  const buffer = await readFile(resolved.host);
  return { sha256: sha256(buffer), size: buffer.length };
}

async function readCurrentText(
  files: ReturnType<WorkspaceManager['files']>,
  path: string,
): Promise<{ readonly exists: boolean; readonly sha256: string | null; readonly text: string | null }> {
  try {
    const info = await files.stat(path);
    if (!info) return { exists: false, sha256: null, text: null };
    const slice = await files.readLines(path, 1, 0);
    const text = slice.text
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\t/, ''))
      .join('\n');
    return { exists: true, sha256: sha256(Buffer.from(text, 'utf8')), text };
  } catch {
    return { exists: false, sha256: null, text: null };
  }
}

function selectFiles(
  changeset: WorkspaceChangesetRecord,
  paths: readonly string[] | undefined,
): readonly ChangesetFileRecord[] {
  if (!paths || paths.length === 0) return changeset.files;
  const wanted = new Set(paths.map((path) => path.replace(/^\/+/, '')));
  const selected = changeset.files.filter((file) => wanted.has(file.path));
  if (selected.length === 0) {
    throw new WorkspaceUndoError('UNDO_SCOPE_EMPTY', '选择的文件不在这轮修改集中。', 400);
  }
  return selected;
}

function emptyResult(
  changeset: WorkspaceChangesetRecord,
  alreadyUndone: boolean,
): WorkspaceUndoResult {
  return {
    changesetId: changeset.id,
    turnId: changeset.turnId,
    status: changeset.status,
    restored: [],
    deleted: [],
    conflicts: [],
    skipped: [],
    alreadyUndone,
  };
}
