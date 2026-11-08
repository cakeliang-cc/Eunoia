/**
 * Structured per-turn background, and the baseline that makes it append-only.
 *
 * The old `buildRuntimeContext()` rendered one trailing string. That is easy to
 * send and impossible to compare: a changed clock and a changed working
 * directory produce two different strings with no way to tell which part moved.
 * This module keeps the pieces named, gives each one a scope, and renders each
 * update as a self-describing block.
 *
 * The rules are taken from DSH's runtime-context projection and Codex's world
 * state baseline, applied to Eunoia's own prompt and storage:
 *
 *   - a persistent block that did not change is not appended again;
 *   - a changed persistent block is appended as a full snapshot (never a patch);
 *   - a cleared block gets an explicit tombstone, so "removed" is not "silently
 *     still true";
 *   - a turn-scoped block applies only to the request that carried it, and is
 *     appended even when the text is identical to last turn: the same note can
 *     be relevant twice, and deduplicating it would drop this turn's context;
 *   - only application-produced blocks are normalised. Assistant text, tool
 *     arguments, tool results and user content are never trimmed for a hash.
 *
 * The wrapper is part of the model-visible bytes, so it is part of the hash.
 * A renderer version change is therefore a content change, not a cosmetic one.
 */

import { canonicalJson, sha256, TRANSCRIPT_RENDER_VERSION } from '../session/model-transcript.ts';
import type { ModelContextState } from '../session/model-transcript.ts';

export type BlockScope = 'persistent' | 'turn' | 'stage';
export type ContextBlockKey =
  | 'relationship'
  | 'narrative'
  | 'permission'
  | 'workspace'
  | 'skills'
  | 'toolGuidelines'
  | 'clock'
  | 'retrievedMemory'
  | 'attachments'
  | 'continuation'
  | 'safetyDirective'
  | 'archivedSummary';

/**
 * Fixed order. Changing this order changes every request's prefix, so it is a
 * versioned decision, not a formatting preference.
 */
export const CONTEXT_BLOCK_ORDER: readonly ContextBlockKey[] = [
  'relationship',
  'narrative',
  'permission',
  'workspace',
  'skills',
  'toolGuidelines',
  'clock',
  'retrievedMemory',
  'attachments',
  'continuation',
  'safetyDirective',
  'archivedSummary',
];

const SCOPE_OF: Readonly<Record<ContextBlockKey, BlockScope>> = {
  relationship: 'persistent',
  narrative: 'persistent',
  permission: 'persistent',
  workspace: 'persistent',
  skills: 'persistent',
  toolGuidelines: 'persistent',
  clock: 'persistent',
  retrievedMemory: 'turn',
  attachments: 'turn',
  continuation: 'turn',
  safetyDirective: 'turn',
  archivedSummary: 'stage',
};

export interface ContextBlockInput {
  readonly relationshipBlock?: string | null;
  readonly narrativeBlock?: string | null;
  readonly archivedSummaryBlock?: string | null;
  readonly situationBlock?: string | null;
  readonly workspaceBlock?: string | null;
  readonly permissionBlock?: string | null;
  readonly attachmentsBlock?: string | null;
  readonly skillsBlock?: string | null;
  readonly toolGuidelines?: string | null;
  readonly memoryBlock?: string | null;
  readonly continuationBlock?: string | null;
  readonly safetyDirective?: string | null;
}

/** A projected block, before comparison with the previous baseline. */
export interface RuntimeBlock {
  readonly key: ContextBlockKey;
  readonly scope: BlockScope;
  readonly content: string;
  readonly hash: string;
}

/** One block the active window must append, with its state row. */
export interface PlannedBlock extends RuntimeBlock {
  readonly revision: number;
  readonly cleared: boolean;
  readonly requestId: string | null;
}

export interface ContextPlan {
  readonly appends: readonly PlannedBlock[];
  /** Persistent keys whose content matched, and turn keys that were absent. */
  readonly skipped: readonly ContextBlockKey[];
  /** Persistent/stage keys that were non-empty before and absent now. */
  readonly cleared: readonly PlannedBlock[];
}

/** The input fields for each key, in content order. */
function inputsFor(
  options: ContextBlockInput,
): readonly { readonly key: ContextBlockKey; readonly text: string | null }[] {
  return [
    { key: 'relationship', text: options.relationshipBlock ?? null },
    { key: 'narrative', text: options.narrativeBlock ?? null },
    { key: 'permission', text: options.permissionBlock ?? null },
    { key: 'workspace', text: options.workspaceBlock ?? null },
    { key: 'skills', text: options.skillsBlock ?? null },
    { key: 'toolGuidelines', text: options.toolGuidelines ?? null },
    { key: 'clock', text: options.situationBlock ?? null },
    { key: 'retrievedMemory', text: options.memoryBlock ?? null },
    { key: 'attachments', text: options.attachmentsBlock ?? null },
    { key: 'continuation', text: options.continuationBlock ?? null },
    { key: 'safetyDirective', text: options.safetyDirective ?? null },
    { key: 'archivedSummary', text: options.archivedSummaryBlock ?? null },
  ];
}

/**
 * Project non-empty blocks in their fixed order.
 *
 * Content is `trim()`ed only here, where the application authored it. The
 * rendered block keeps that text verbatim afterwards.
 */
export function projectRuntimeBlocks(options: ContextBlockInput): RuntimeBlock[] {
  const blocks: RuntimeBlock[] = [];
  for (const entry of inputsFor(options)) {
    const text = entry.text?.trim();
    if (!text) continue;
    blocks.push({
      key: entry.key,
      scope: SCOPE_OF[entry.key],
      content: text,
      hash: blockHash(entry.key, SCOPE_OF[entry.key], text),
    });
  }
  return blocks;
}

export function blockHash(key: string, scope: BlockScope, content: string): string {
  return sha256(
    canonicalJson({
      key,
      scope,
      content,
      renderVersion: TRANSCRIPT_RENDER_VERSION,
    }),
  );
}

/**
 * Compare projected blocks with the baseline of the active window.
 *
 * `states` is keyed by block key. A state is the last version this window
 * incorporated; it is not a claim that the model necessarily read it. That
 * distinction matters after a failed request: the baseline may have advanced
 * only in the same transaction as the request's items.
 */
export function planContext(
  blocks: readonly RuntimeBlock[],
  states: ReadonlyMap<string, ModelContextState>,
  requestId: string | null,
): ContextPlan {
  const present = new Map<ContextBlockKey, RuntimeBlock>();
  for (const block of blocks) present.set(block.key, block);

  const appends: PlannedBlock[] = [];
  const skipped: ContextBlockKey[] = [];
  const ordered: PlannedBlock[] = [];

  for (const key of CONTEXT_BLOCK_ORDER) {
    const scope = SCOPE_OF[key];
    const block = present.get(key);
    const previous = states.get(key);

    if (!block) {
      skipped.push(key);
      // Turn blocks expire; persistent/stage blocks need an explicit tombstone.
      if (scope !== 'turn' && previous && !previous.cleared) {
        ordered.push({
          key,
          scope,
          content: '',
          hash: blockHash(key, scope, ''),
          revision: previous.revision + 1,
          cleared: true,
          requestId,
        });
      }
      continue;
    }

    if (scope === 'turn') {
      // Always append, even for identical text: this turn's applicability is
      // itself new information.
      appends.push({
        ...block,
        revision: (previous?.revision ?? 0) + 1,
        cleared: false,
        requestId,
      });
      continue;
    }

    if (previous && !previous.cleared && previous.contentHash === block.hash) {
      skipped.push(key);
      continue;
    }

    appends.push({
      ...block,
      // Re-activating a cleared block is a new revision, not a resurrection of
      // the old one.
      revision: previous ? previous.revision + 1 : 1,
      cleared: false,
      requestId,
    });
  }

  const tombstoned = ordered;
  const all = [...appends, ...tombstoned].sort(
    (a, b) => CONTEXT_BLOCK_ORDER.indexOf(a.key) - CONTEXT_BLOCK_ORDER.indexOf(b.key),
  );
  return {
    appends: all.filter((block) => !block.cleared),
    skipped,
    cleared: tombstoned,
  };
}

/**
 * Render one block for the model.
 *
 * The header states the scope and revision. The closing sentence says what the
 * version means, because a model that only sees a newer paragraph may still
 * treat the old one as current. This prose is application-authored; it is not
 * mixed into the person's messages.
 */
export function renderBlock(block: PlannedBlock): string {
  if (block.cleared) {
    return [
      `[系统背景 key=${block.key} scope=${block.scope} revision=${block.revision} cleared=true]`,
      '这项状态已被系统清空。同一 key 的旧内容不再有效，不要继续引用它；',
      '如果当前回合需要它，以这一条之后出现的状态为准。',
    ].join('\n');
  }

  const applicability =
    block.scope === 'turn'
      ? `这条资料只适用于本回合（request=${block.requestId ?? 'unknown'}），下一回合不会自动生效。`
      : block.scope === 'stage'
        ? '这是本阶段开始时的检查点，只说明更早的历史。'
        : '这是持续状态；同一 key 的新版本会覆盖旧版本，旧版本只作为历史。';

  return [
    `[系统背景 key=${block.key} scope=${block.scope} revision=${block.revision}]`,
    '以下是系统提供的背景，不是用户发言。把它当作已经存在的上下文；不要逐条复述，也不要提到这些内容的来源。',
    applicability,
    `<${block.key}>`,
    block.content,
    `</${block.key}>`,
  ].join('\n');
}
