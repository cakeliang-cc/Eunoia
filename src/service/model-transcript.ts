/**
 * Durable model replay for one conversation (ADR 032).
 *
 * This is the service-layer join between the session transcript, the structured
 * background projection, the model loop and the persistence port. It owns the
 * decisions the loop must not know: which epoch is active, whether a change
 * needs a boundary, which background blocks the window already contains, and
 * what a request attempt looked like.
 *
 * Two invariants shape the implementation:
 *
 *   1. **The transcript is not a chat log.** Items store what the model saw and
 *      produced, including tool results at the size the model received. The UI
 *      message rows remain a separate, summarised record.
 *   2. **Replay never executes anything.** Tool results are replayed as data.
 *      Unknown outcomes stay unknown; an unpaired call is replaced by an
 *      interruption note in a new epoch rather than being silently re-run.
 */

import { randomUUID } from 'node:crypto';
import type { UserContentV1 } from '../agent/content.ts';
import { messageContent } from '../agent/content.ts';
import type {
  LoopInputItem,
  LoopOutputItem,
} from '../agent/model-port.ts';
import type {
  LoopTranscript,
  LoopTranscriptCompletion,
  LoopTranscriptPreparation,
  LoopTranscriptStepRequest,
} from '../agent/loop.ts';
import {
  blockHash,
  planContext,
  projectRuntimeBlocks,
  renderBlock,
  type ContextBlockInput,
  type PlannedBlock,
} from '../agent/context-projection.ts';
import type {
  ModelTranscriptStore,
} from '../session/model-transcript-store.ts';
import type {
  EpochReason,
  ModelContextState,
  ModelEpoch,
  ModelItem,
  ModelStepRecord,
  NewModelContextState,
  NewModelItem,
  StepUsage,
  TranscriptPayload,
  TurnUsageSummary,
} from '../session/model-transcript.ts';
import {
  canonicalJson,
  itemContentHash,
  itemToLoopInput,
  payloadForOutput,
  sha256,
  stepUsageOf,
  summarizeTurnUsage,
  toolsDigest,
  TRANSCRIPT_RENDER_VERSION,
} from '../session/model-transcript.ts';
import type { SessionReplay, Message } from '../session/types.ts';
import { renderArchivedSummary } from '../session/summary.ts';
import type { ModelProfile } from '../models/types.ts';
import type { ToolSchema } from '../tools/types.ts';
import { describePolicy } from '../tools/policy.ts';
import type { ToolPolicy } from '../tools/types.ts';
import { log } from '../observability/logging.ts';

const CONTENT_VERSION = 'model-transcript-v1';
const DEFAULT_PROTOCOL_REVISION = 'responses-api@1';

export interface BeginTranscriptInput {
  readonly store: ModelTranscriptStore;
  readonly userId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly instructions: string;
  readonly promptVersion: string;
  readonly tools: readonly ToolSchema[];
  readonly profile: ModelProfile;
  /** The session window as it will be replayed if durable mode is off. */
  readonly replay: SessionReplay;
  /** The current user message, or null on regenerate (it is already in replay). */
  readonly user: { readonly content: UserContentV1; readonly messageId: string | null; readonly seq: number } | null;
  readonly regenerate?: boolean;
  readonly context: ContextBlockInput;
  readonly policy: ToolPolicy;
  readonly protocolRevision?: string;
  readonly encoderRevision?: string;
  readonly now?: Date;
}

export interface BegunTranscript {
  readonly transcript: DurableTranscript;
  /** The actual loop input, already including the current user and updates. */
  readonly input: readonly LoopInputItem[];
  readonly epoch: ModelEpoch;
  /** True when this turn created the epoch (new conversation, seed, boundary). */
  readonly seeded: boolean;
  readonly epochReason: EpochReason | null;
}

interface PendingItem {
  readonly newItem: NewModelItem;
  readonly loopItem: LoopInputItem;
}

/**
 * A transcript bound to one turn.
 *
 * Construct it with `beginTranscript`; the constructor is private because an
 * instance that skipped epoch selection would append into the wrong window.
 */
export class DurableTranscript implements LoopTranscript {
  readonly #store: ModelTranscriptStore;
  readonly #userId: string;
  readonly #conversationId: string;
  readonly #requestId: string;
  readonly #turnId: string;
  readonly #instructions: string;
  readonly #promptVersion: string;
  readonly #tools: readonly ToolSchema[];
  readonly #profile: ModelProfile;
  readonly #policy: ToolPolicy;
  readonly #protocolRevision: string;
  readonly #encoderRevision: string;
  readonly #now: () => Date;

  #epoch: ModelEpoch;
  #windowIds: string[];
  #injectCounter = 0;
  #windowRevision: number;
  #states: Map<string, ModelContextState>;
  #inputItems: LoopInputItem[];
  #inputIds: string[];
  #pending: PendingItem[] = [];
  #pendingStates: NewModelContextState[] = [];
  #attempts = new Map<number, string>();
  #lastContextTokens: number | null = null;
  #stepUsage = new Map<number, StepUsage | null>();
  #requestCount = 0;

  constructor(options: {
    store: ModelTranscriptStore;
    userId: string;
    conversationId: string;
    requestId: string;
    turnId: string;
    instructions: string;
    promptVersion: string;
    tools: readonly ToolSchema[];
    profile: ModelProfile;
    policy: ToolPolicy;
    protocolRevision: string;
    encoderRevision: string;
    now: () => Date;
    epoch: ModelEpoch;
    windowIds: string[];
    states: Map<string, ModelContextState>;
    inputItems: LoopInputItem[];
    inputIds: string[];
  }) {
    this.#store = options.store;
    this.#userId = options.userId;
    this.#conversationId = options.conversationId;
    this.#requestId = options.requestId;
    this.#turnId = options.turnId;
    this.#instructions = options.instructions;
    this.#promptVersion = options.promptVersion;
    this.#tools = options.tools;
    this.#profile = options.profile;
    this.#policy = options.policy;
    this.#protocolRevision = options.protocolRevision;
    this.#encoderRevision = options.encoderRevision;
    this.#now = options.now;
    this.#epoch = options.epoch;
    this.#windowIds = options.windowIds;
    this.#windowRevision = options.epoch.windowRevision;
    this.#states = options.states;
    this.#inputItems = options.inputItems;
    this.#inputIds = options.inputIds;
  }

  get epoch(): ModelEpoch {
    return this.#epoch;
  }

  get input(): readonly LoopInputItem[] {
    return this.#inputItems;
  }

  // ------------------------------------------------------------------ begin ---

  static async begin(input: BeginTranscriptInput): Promise<BegunTranscript> {
    const now = input.now ?? new Date();
    const toolsHash = toolsDigest(input.tools);
    const encoder = input.encoderRevision ?? 'sdk-responses@1';
    const protocol = input.protocolRevision ?? DEFAULT_PROTOCOL_REVISION;
    const active = await input.store.activeEpoch(input.conversationId);

    // A crashed tool call takes precedence over every other boundary reason: a
    // prompt or model change must not make an unobserved side effect disappear.
    if (active) {
      const unpaired = await findUnpairedCall(input.store, active);
      if (unpaired) {
        return beginWithRecoveryBoundary(input, active, unpaired, toolsHash, encoder, protocol, now);
      }
    }

    const priorMessages = input.replay.messages.filter(
      (message) => message.id !== input.user?.messageId,
    );
    let reason: EpochReason | null = null;
    if (!active) {
      reason = priorMessages.length > 0 || input.replay.summary ? 'legacy-seed' : 'new-conversation';
    } else if (active.instructions !== input.instructions) {
      reason = 'prompt-change';
    } else if (active.toolsHash !== toolsHash) {
      reason = 'tools-change';
    } else if (
      active.modelId !== input.profile.id ||
      active.providerId !== input.profile.providerId ||
      active.encoderRevision !== encoder
    ) {
      reason = 'model-switch';
    } else if (await summaryChanged(input.store, active, input.replay)) {
      reason = 'compaction';
    } else if (await hasUnseededMessages(input.store, active, priorMessages)) {
      // The process may have run in legacy mode for a while, or a previous
      // durable write may have failed after the UI message was stored. A seed
      // epoch covers those messages exactly once; the old epoch stays auditable.
      reason = 'legacy-seed';
    }

    let epoch: ModelEpoch;
    let windowIds: string[];
    let states = new Map<string, ModelContextState>();
    let seeded = false;

    if (!reason && active) {
      epoch = active;
      windowIds = [...active.windowItemIds];
      for (const state of await input.store.contextState(input.conversationId, active.id)) {
        states.set(state.key, state);
      }
    } else {
      const created = await createSeedEpoch(
        input,
        reason ?? 'legacy-seed',
        active,
        toolsHash,
        protocol,
        encoder,
        now,
      );
      epoch = created.epoch;
      windowIds = created.windowIds;
      seeded = true;
      // A new epoch rebuilds authoritative state from the current blocks rather
      // than copying stale comparisons. `states` stays empty on purpose.
    }

    const windowItems = await loadItems(input.store, input.conversationId, windowIds);
    const knownMessageIds = new Set(
      windowItems.map((item) => item.messageId).filter((id): id is string => Boolean(id)),
    );

    const transcript = new DurableTranscript({
      store: input.store,
      userId: input.userId,
      conversationId: input.conversationId,
      requestId: input.requestId,
      turnId: input.turnId,
      instructions: input.instructions,
      promptVersion: input.promptVersion,
      tools: input.tools,
      profile: input.profile,
      policy: input.policy,
      protocolRevision: protocol,
      encoderRevision: encoder,
      now: () => now,
      epoch,
      windowIds,
      states,
      inputItems: [],
      inputIds: [],
    });

    // Regeneration rewinds the *active view*, not the immutable history. The
    // old reply and its tool items stay auditable in the previous epoch.
    if (input.regenerate && input.user?.messageId) {
      await transcript.#rewindForRegenerate(input.user.messageId, input.user.seq, {
        toolsHash,
        protocol,
        encoder,
        now,
      });
      // The rewind created a new epoch. Every later append in this turn must use
      // that epoch's id, or its idempotency keys collide with the old turn's
      // blocks and the returned item ids no longer match the new window.
      epoch = transcript.#epoch;
      states = new Map();
      windowIds = [...transcript.#windowIds];
    }

    const pending: PendingItem[] = [];
    if (input.user && !knownMessageIds.has(input.user.messageId ?? '')) {
      const item = userItem(input, input.user, epoch.id);
      pending.push({ newItem: item, loopItem: loopInputForNewItem(item) });
      windowIds = [...windowIds, item.id as string];
    }

    // Background blocks: compare against this epoch's baseline and append only
    // what changed (or all of them on a fresh epoch).
    const blocks = projectRuntimeBlocks(input.context);
    const plan = planContext(blocks, transcript.#states, input.requestId);
    for (const block of [...plan.appends, ...plan.cleared]) {
      const built = backgroundItem(input, epoch.id, block, now);
      pending.push(built);
      windowIds = [...windowIds, built.newItem.id as string];
      transcript.#pendingStates.push({
        conversationId: input.conversationId,
        epochId: epoch.id,
        key: block.key,
        scope: block.scope,
        contentHash: block.hash,
        renderVersion: TRANSCRIPT_RENDER_VERSION,
        revision: block.revision,
        latestItemId: built.newItem.id as string,
        cleared: block.cleared,
      });
    }

    transcript.#pending = pending;
    transcript.#windowIds = windowIds;
    transcript.#inputIds = windowIds;
    transcript.#inputItems = await loopItemsFor(
      input.store,
      input.conversationId,
      windowIds,
      transcript.#pending,
    );

    return {
      transcript,
      input: transcript.#inputItems,
      epoch,
      seeded,
      epochReason: reason,
    };
  }

  // --------------------------------------------------------------- loop hooks ---

  async prepareStep(request: LoopTranscriptStepRequest): Promise<LoopTranscriptPreparation> {
    this.#lastContextTokens = request.estimatedTokens;
    this.#requestCount = Math.max(this.#requestCount, request.step);
    if (request.input.length !== this.#inputIds.length) {
      throw new Error(
        `transcript input drifted: loop has ${request.input.length} items, transcript has ${this.#inputIds.length}`,
      );
    }
    // The loop owns the canonical item objects. Re-sync to them rather than
    // comparing references: `completeStep`/`recordToolResult` receive outputs
    // and rebuild equivalent objects, which are only positionally identical.
    this.#inputItems = [...request.input];

    const mapped = mappingFor(request.requestInput, this.#inputItems, this.#inputIds);
    const pending: PendingItem[] = [...this.#pending];
    const viewIds: string[] = [];
    for (const entry of mapped) {
      if (entry.id) {
        viewIds.push(entry.id);
        continue;
      }
      const created = compressedItem(
        this.#conversationId,
        this.#epoch.id,
        this.#requestId,
        this.#turnId,
        request.step,
        entry,
      );
      pending.push({ newItem: created, loopItem: entry.item });
      viewIds.push(created.id as string);
    }

    const needsWindow =
      pending.length > 0 ||
      viewIds.length !== this.#windowIds.length ||
      viewIds.some((id, index) => id !== this.#windowIds[index]);
    // `viewIds` is the actual request view: it already includes pending items
    // from `begin` and any compressed replacement created above. Nothing that
    // was trimmed out may sneak back into the persisted window.
    const dedupedWindow = needsWindow ? [...viewIds] : this.#windowIds;

    const attemptId = randomUUID();
    const configDigest = this.#configDigest(request);
    const prepared = await this.#store.prepareStep({
      items: pending.map((entry) => entry.newItem),
      step: {
        attemptId,
        requestId: this.#requestId,
        turnId: this.#turnId,
        conversationId: this.#conversationId,
        step: request.step,
        attemptNo: 1,
        epochId: this.#epoch.id,
        epochRevision: this.#windowRevision,
        inputItemIds: viewIds,
        requestConfigDigest: configDigest,
        projection: null,
        status: 'prepared',
        createdAt: this.#now(),
      },
      ...(needsWindow
        ? {
            window: {
              epochId: this.#epoch.id,
              expectedRevision: this.#windowRevision,
              itemIds: dedupedWindow,
            },
          }
        : {}),
      ...(this.#pendingStates.length > 0 ? { state: this.#pendingStates } : {}),
    });

    this.#attempts.set(request.step, attemptId);
    this.#pending = [];
    this.#pendingStates = [];
    if (prepared.epoch) {
      this.#epoch = prepared.epoch;
      this.#windowRevision = prepared.epoch.windowRevision;
    }
    this.#windowIds = dedupedWindow;
    this.#inputIds = viewIds;
    this.#inputItems = [...request.requestInput];

    return {
      attemptId,
      inputItemIds: viewIds,
      ...(needsWindow ? { replacementInput: request.requestInput } : {}),
    };
  }

  /**
   * Persist items injected between steps (a mailbox delivery).
   *
   * They are appended as staged user items and become part of the next request
   * view. The idempotency key uses the turn, a per-turn counter and the content
   * hash, so a retried append cannot duplicate a message.
   */
  async appendInput(items: readonly LoopInputItem[]): Promise<void> {
    if (items.length === 0) return;
    this.#injectCounter += items.length;
    const created: NewModelItem[] = items.map((item, index) => {
      if (item.type !== 'message') {
        throw new Error('only a message can be injected between steps');
      }
      const payload: TranscriptPayload = {
        type: 'message',
        role: item.role,
        content: item.content,
      };
      return {
        id: randomUUID(),
        conversationId: this.#conversationId,
        epochId: this.#epoch.id,
        idempotencyKey: `inject:${this.#turnId}:${this.#injectCounter - items.length + index}:${itemContentHash(payload)}`,
        requestId: this.#requestId,
        turnId: this.#turnId,
        step: null,
        kind: item.role === 'assistant' ? 'assistant' : 'user',
        source: 'system',
        scope: 'conversation',
        contentVersion: CONTENT_VERSION,
        payload,
        contentHash: itemContentHash(payload),
        messageId: null,
        callId: null,
        status: 'complete',
      };
    });
    const inserted = await this.#store.appendItems(created);
    for (const item of inserted) {
      this.#inputIds.push(item.id);
    }
    this.#inputItems = [...this.#inputItems, ...items];
  }

  async completeStep(completion: LoopTranscriptCompletion): Promise<void> {
    const outputItems: NewModelItem[] = completion.output.map((item, index) => {
      const mapped = payloadForOutput(item);
      const payload = mapped.payload;
      return {
        id: randomUUID(),
        conversationId: this.#conversationId,
        epochId: this.#epoch.id,
        idempotencyKey: `out:${this.#turnId}:${completion.step}:${completion.attemptNo}:${index}`,
        requestId: this.#requestId,
        turnId: this.#turnId,
        step: completion.step,
        kind: mapped.kind,
        source: mapped.source,
        scope: 'turn',
        contentVersion: CONTENT_VERSION,
        payload,
        contentHash: itemContentHash(payload),
        callId: payload.type === 'function_call' ? payload.callId : null,
        status: completion.status === 'incomplete' ? 'incomplete' : 'complete',
      };
    });

    await this.#store.appendItems(outputItems);
    const outputIds = outputItems.map((item) => item.id as string);
    const nextWindow = [...this.#windowIds, ...outputIds];
    const epoch = await this.#store.updateWindow(
      this.#epoch.id,
      this.#windowRevision,
      nextWindow,
    );
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
    this.#windowIds = nextWindow;

    const usage = stepUsageOf(completion.usage);
    this.#stepUsage.set(completion.step, usage);
    await this.#store.updateStep(completion.attemptId, {
      status: completion.status,
      usage,
      outputItemIds: outputIds,
      responseId: completion.responseId ?? null,
      error: completion.error ?? null,
      finishReason: completion.finishReason ?? null,
      projection: completion.projection
        ? {
            ...completion.projection,
            modelId: this.#profile.id,
            providerId: this.#profile.providerId,
            encoderRevision: this.#encoderRevision,
          }
        : null,
      completedAt: this.#now(),
    });

    // The loop appends these to its own input immediately after this returns.
    this.#inputIds = [...this.#inputIds, ...outputIds];
    this.#inputItems = [
      ...this.#inputItems,
      ...completion.output.map(outputToLoopInput),
    ];
  }

  async recordToolResult(result: {
    readonly step: number;
    readonly item: Extract<LoopInputItem, { type: 'function_call_result' }>;
    readonly meta?: Record<string, unknown>;
    readonly ok: boolean;
  }): Promise<void> {
    const payload: TranscriptPayload = {
      type: 'function_call_result',
      callId: result.item.callId,
      name: result.item.name,
      output: result.item.output,
    };
    const created: NewModelItem = {
      id: randomUUID(),
      conversationId: this.#conversationId,
      epochId: this.#epoch.id,
      idempotencyKey: `tool:${this.#turnId}:${result.step}:${result.item.callId}`,
      requestId: this.#requestId,
      turnId: this.#turnId,
      step: result.step,
      kind: 'tool_result',
      source: 'tool',
      scope: 'turn',
      contentVersion: CONTENT_VERSION,
      payload,
      contentHash: itemContentHash(payload),
      callId: result.item.callId,
      status: 'complete',
    };
    await this.#store.appendItems([created]);
    const nextWindow = [...this.#windowIds, created.id as string];
    const epoch = await this.#store.updateWindow(
      this.#epoch.id,
      this.#windowRevision,
      nextWindow,
    );
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
    this.#windowIds = nextWindow;
    this.#inputIds = [...this.#inputIds, created.id as string];
    this.#inputItems = [...this.#inputItems, result.item];

    // A successful change_directory is authoritative state, not just a tool
    // message. Appending it through the same state channel means the next step
    // and the next turn cannot keep claiming the old directory.
    const cwd = result.meta?.cwd;
    if (result.ok && typeof cwd === 'string' && cwd.length > 0) {
      await this.#appendWorkspaceState(cwd);
    }
  }

  async failStep(result: {
    readonly step: number;
    readonly attemptId: string;
    readonly status: 'incomplete' | 'failed' | 'unknown';
    readonly error: string;
  }): Promise<void> {
    await this.#store.updateStep(result.attemptId, {
      status: result.status,
      error: result.error,
      finishReason: result.status === 'failed' ? 'failed' : result.status,
      completedAt: this.#now(),
    });
  }

  // -------------------------------------------------------------- turn end ---

  /**
   * Save the text a person actually saw when they pressed stop.
   *
   * It is marked incomplete. No reasoning signature, no fabricated tool call and
   * no `completed` status is produced for a half-streamed answer.
   */
  async recordInterrupted(text: string): Promise<void> {
    if (text.trim().length === 0) return;
    const payload: TranscriptPayload = { type: 'message', role: 'assistant', content: text };
    const item: NewModelItem = {
      id: randomUUID(),
      conversationId: this.#conversationId,
      epochId: this.#epoch.id,
      idempotencyKey: `interrupt:${this.#turnId}`,
      requestId: this.#requestId,
      turnId: this.#turnId,
      step: null,
      kind: 'assistant',
      source: 'assistant',
      scope: 'turn',
      contentVersion: CONTENT_VERSION,
      payload,
      contentHash: itemContentHash(payload),
      status: 'incomplete',
    };
    await this.#store.appendItems([item]);
    this.#windowIds = [...this.#windowIds, item.id as string];
    const epoch = await this.#store.updateWindow(
      this.#epoch.id,
      this.#windowRevision,
      this.#windowIds,
    );
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
  }

  /**
   * A replaced safety answer establishes a new epoch.
   *
   * The discarded internal answer must not be replayed as assistant history. The
   * actual safety reply becomes the only assistant text for the turn; user and
   * observed tool facts stay, because they happened.
   */
  async recordSafetyBoundary(text: string, options: { toolsHash: string; now: Date }): Promise<void> {
    const items = await loadItems(this.#store, this.#conversationId, this.#windowIds);
    const discarded = new Set(
      items
        .filter(
          (item) =>
            item.requestId === this.#requestId &&
            (item.kind === 'assistant' || item.kind === 'reasoning' || item.kind === 'interrupt'),
        )
        .map((item) => item.id),
    );
    const kept = this.#windowIds.filter((id) => !discarded.has(id));

    const payload: TranscriptPayload = { type: 'message', role: 'assistant', content: text };
    const safety: NewModelItem = {
      id: randomUUID(),
      conversationId: this.#conversationId,
      epochId: this.#epoch.id,
      idempotencyKey: `safety:${this.#turnId}`,
      requestId: this.#requestId,
      turnId: this.#turnId,
      step: null,
      kind: 'assistant',
      source: 'assistant',
      scope: 'conversation',
      contentVersion: CONTENT_VERSION,
      payload,
      contentHash: itemContentHash(payload),
      status: 'complete',
    };
    await this.#store.appendItems([safety]);
    const nextWindow = [...kept, safety.id as string];

    const epoch = await this.#store.createEpoch({
      id: randomUUID(),
      userId: this.#userId,
      conversationId: this.#conversationId,
      parentEpochId: this.#epoch.id,
      reason: 'safety-replaced',
      instructions: this.#instructions,
      promptVersion: this.#promptVersion,
      tools: this.#tools,
      toolsHash: options.toolsHash,
      providerId: this.#profile.providerId,
      modelId: this.#profile.id,
      protocolRevision: this.#protocolRevision,
      encoderRevision: this.#encoderRevision,
      windowItemIds: nextWindow,
      windowRevision: 0,
      seededThroughSeq: this.#epoch.seededThroughSeq,
      createdAt: options.now,
    });
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
    this.#windowIds = nextWindow;
    this.#states.clear();
    this.#inputIds = nextWindow;
    this.#inputItems = [];
  }

  /** Bind the persisted UI message to the item that produced it. */
  async linkAssistantMessage(messageId: string): Promise<void> {
    await this.#store.linkAssistantMessage(this.#conversationId, this.#requestId, messageId);
  }

  async usage(): Promise<TurnUsageSummary> {
    const steps = await this.#store.listSteps(this.#requestId);
    return summarizeTurnUsage(steps, this.#lastContextTokens);
  }

  async steps(): Promise<readonly ModelStepRecord[]> {
    return this.#store.listSteps(this.#requestId);
  }


  /**
   * Build a transcript on an epoch that a recovery boundary just created.
   *
   * It is a static method because it must be able to set private state: an
   * outside factory would need the fields to be public just to finish an
   * initialisation.
   */
  static async hydrate(
    input: BeginTranscriptInput,
    epoch: ModelEpoch,
    seededWindowIds: string[],
    protocol: string,
    encoder: string,
    now: Date,
  ): Promise<BegunTranscript> {
    const windowIds = [...seededWindowIds];
    const transcript = new DurableTranscript({
      store: input.store,
      userId: input.userId,
      conversationId: input.conversationId,
      requestId: input.requestId,
      turnId: input.turnId,
      instructions: input.instructions,
      promptVersion: input.promptVersion,
      tools: input.tools,
      profile: input.profile,
      policy: input.policy,
      protocolRevision: protocol,
      encoderRevision: encoder,
      now: () => now,
      epoch,
      windowIds,
      states: new Map(),
      inputItems: [],
      inputIds: [],
    });

    const pending: PendingItem[] = [];
    if (input.user) {
      const exists = (await loadItems(input.store, input.conversationId, windowIds)).some(
        (item) => item.messageId === input.user?.messageId,
      );
      if (!exists) {
        const item = userItem(input, input.user, epoch.id);
        pending.push({ newItem: item, loopItem: loopInputForNewItem(item) });
        windowIds.push(item.id as string);
      }
    }

    const blocks = projectRuntimeBlocks(input.context);
    const plan = planContext(blocks, new Map(), input.requestId);
    for (const block of [...plan.appends, ...plan.cleared]) {
      const built = backgroundItem(input, epoch.id, block, now);
      pending.push(built);
      windowIds.push(built.newItem.id as string);
      transcript.#pendingStates.push({
        conversationId: input.conversationId,
        epochId: epoch.id,
        key: block.key,
        scope: block.scope,
        contentHash: block.hash,
        renderVersion: TRANSCRIPT_RENDER_VERSION,
        revision: block.revision,
        latestItemId: built.newItem.id as string,
        cleared: block.cleared,
      });
    }

    transcript.#pending = pending;
    transcript.#windowIds = windowIds;
    transcript.#windowRevision = epoch.windowRevision;
    transcript.#inputIds = windowIds;
    transcript.#inputItems = await loopItemsFor(
      input.store,
      input.conversationId,
      windowIds,
      pending,
    );
    return {
      transcript,
      input: transcript.#inputItems,
      epoch,
      seeded: true,
      epochReason: 'recovery-boundary',
    };
  }

  // ------------------------------------------------------------- internals ---

  async #rewindForRegenerate(
    userMessageId: string,
    userSeq: number,
    options: {
      toolsHash: string;
      protocol: string;
      encoder: string;
      now: Date;
    },
  ): Promise<void> {
    const items = await loadItems(this.#store, this.#conversationId, this.#windowIds);
    const index = items.findIndex((item) => item.messageId === userMessageId);
    if (index < 0) return;
    const nextWindow = items.slice(0, index + 1).map((item) => item.id);

    const epoch = await this.#store.createEpoch({
      id: randomUUID(),
      userId: this.#userId,
      conversationId: this.#conversationId,
      parentEpochId: this.#epoch.id,
      reason: 'regenerate',
      instructions: this.#instructions,
      promptVersion: this.#promptVersion,
      tools: this.#tools,
      toolsHash: options.toolsHash,
      providerId: this.#profile.providerId,
      modelId: this.#profile.id,
      protocolRevision: options.protocol,
      encoderRevision: options.encoder,
      windowItemIds: nextWindow,
      windowRevision: 0,
      seededThroughSeq: userSeq,
      createdAt: options.now,
    });
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
    this.#windowIds = nextWindow;
    this.#states.clear();
  }

  async #appendWorkspaceState(cwd: string): Promise<void> {
    const previous = this.#states.get('workspace');
    const content = [
      '# 工作目录',
      `你现在可以在一个隔离沙箱里工作：${cwd}`,
      `当前权限：${describePolicy(this.#policy)}。`,
      '后续命令都从上面这个目录开始；需要移动时继续使用 change_directory。',
    ].join('\n');
    const revision = (previous?.revision ?? 0) + 1;
    const planned: PlannedBlock = {
      key: 'workspace',
      scope: 'persistent',
      content,
      hash: blockHash('workspace', 'persistent', content),
      revision,
      cleared: false,
      requestId: this.#requestId,
    };
    const built = backgroundItem(
      {
        conversationId: this.#conversationId,
        requestId: this.#requestId,
        turnId: this.#turnId,
      },
      this.#epoch.id,
      planned,
      this.#now(),
    );
    await this.#store.appendItems([built.newItem]);
    const nextWindow = [...this.#windowIds, built.newItem.id as string];
    const epoch = await this.#store.updateWindow(
      this.#epoch.id,
      this.#windowRevision,
      nextWindow,
    );
    this.#epoch = epoch;
    this.#windowRevision = epoch.windowRevision;
    this.#windowIds = nextWindow;
    this.#states.set('workspace', {
      conversationId: this.#conversationId,
      epochId: epoch.id,
      key: 'workspace',
      scope: 'persistent',
      contentHash: planned.hash,
      renderVersion: TRANSCRIPT_RENDER_VERSION,
      revision,
      latestItemId: built.newItem.id as string,
      cleared: false,
      updatedAt: this.#now(),
    });
    await this.#store.saveContextState([
      {
        conversationId: this.#conversationId,
        epochId: epoch.id,
        key: 'workspace',
        scope: 'persistent',
        contentHash: planned.hash,
        renderVersion: TRANSCRIPT_RENDER_VERSION,
        revision,
        latestItemId: built.newItem.id as string,
        cleared: false,
      },
    ]);
  }

  #configDigest(request: {
    readonly instructions: string;
    readonly tools: readonly ToolSchema[];
    readonly estimatedTokens?: number | null;
  }): string {
    return sha256(
      canonicalJson({
        instructions: sha256(request.instructions),
        tools: toolsDigest(request.tools),
        modelId: this.#profile.id,
        providerId: this.#profile.providerId,
        protocol: this.#protocolRevision,
        encoder: this.#encoderRevision,
      }),
    );
  }
}

// ------------------------------------------------------------------ factory ---

async function createSeedEpoch(
  input: BeginTranscriptInput,
  reason: EpochReason,
  previous: ModelEpoch | null,
  toolsHash: string,
  protocol: string,
  encoder: string,
  now: Date,
): Promise<{ epoch: ModelEpoch; windowIds: string[] }> {
  const epochId = randomUUID();
  const carry =
    previous !== null &&
    reason !== 'compaction' &&
    reason !== 'legacy-seed' &&
    reason !== 'new-conversation'
      ? (await loadItems(input.store, input.conversationId, previous.windowItemIds)).filter(
          (item) =>
            item.kind !== 'background' &&
            // A cross-provider/model boundary must not replay a private
            // reasoning signature. Tool calls/results are portable facts.
            !(reason === 'model-switch' && item.kind === 'reasoning'),
        )
      : [];

  const carriedIds = carry.map((item) => item.id);
  const knownMessages = new Set(
    carry.map((item) => item.messageId).filter((id): id is string => Boolean(id)),
  );
  const seed = await buildSeedItems(input, epochId, reason, now, knownMessages);
  const items = [...seed.items];

  // The epoch is created before its lexical items because items carry the
  // foreign key. If the process dies between the two writes the window is empty
  // and the next turn rebuilds it from the session window, which is safe.
  const epoch = await input.store.createEpoch({
    id: epochId,
    userId: input.userId,
    conversationId: input.conversationId,
    parentEpochId: previous?.id ?? null,
    reason,
    instructions: input.instructions,
    promptVersion: input.promptVersion,
    tools: input.tools,
    toolsHash,
    providerId: input.profile.providerId,
    modelId: input.profile.id,
    protocolRevision: protocol,
    encoderRevision: encoder,
    windowItemIds: carriedIds,
    windowRevision: 0,
    seededThroughSeq: seed.throughSeq,
    createdAt: now,
  });
  // Idempotency can return an item that already existed under the same key, so
  // the window must use the ids the store actually kept, not the preallocated
  // ids the seed happened to propose.
  const stored = items.length > 0 ? await input.store.appendItems(items) : [];
  const windowIds = [...carriedIds, ...stored.map((item) => item.id)];
  const updated =
    windowIds.length > 0
      ? await input.store.updateWindow(epoch.id, epoch.windowRevision, windowIds)
      : epoch;
  return { epoch: updated, windowIds };
}

async function buildSeedItems(
  input: BeginTranscriptInput,
  epochId: string,
  reason: EpochReason,
  now: Date,
  knownMessages: ReadonlySet<string> = new Set(),
): Promise<{ items: NewModelItem[]; throughSeq: number }> {
  const items: NewModelItem[] = [];
  let throughSeq = input.replay.throughSeq;

  if (input.replay.summary) {
    const text = renderArchivedSummary(input.replay.summary);
    const payload: TranscriptPayload = { type: 'summary', text };
    items.push({
      id: randomUUID(),
      conversationId: input.conversationId,
      epochId,
      idempotencyKey: `summary:${sha256(text)}`,
      requestId: input.requestId,
      turnId: input.turnId,
      step: null,
      kind: 'summary',
      source: 'application',
      scope: 'stage',
      contentVersion: CONTENT_VERSION,
      payload,
      contentHash: itemContentHash(payload),
      status: 'complete',
    });
  }

  for (const message of input.replay.messages) {
    if (knownMessages.has(message.id)) {
      throughSeq = Math.max(throughSeq, message.seq);
      continue;
    }
    const item = messageSeedItem(input, epochId, message);
    items.push(item);
    throughSeq = Math.max(throughSeq, message.seq);
  }
  void reason;
  void now;
  return { items, throughSeq };
}

function messageSeedItem(
  input: BeginTranscriptInput,
  epochId: string,
  message: Message,
): NewModelItem {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const payload: TranscriptPayload = {
    type: 'message',
    role,
    content: role === 'user' ? messageContent(message).parts : message.content,
  };
  return {
    id: randomUUID(),
    conversationId: input.conversationId,
    epochId,
    idempotencyKey: `seed:${message.id}`,
    requestId: null,
    turnId: null,
    step: null,
    kind: role === 'user' ? 'user' : 'assistant',
    source: role === 'user' ? 'user' : 'assistant',
    scope: 'conversation',
    contentVersion: CONTENT_VERSION,
    payload,
    contentHash: itemContentHash(payload),
    messageId: message.id,
    callId: null,
    status: message.interrupted ? 'incomplete' : 'complete',
  };
}

function userItem(
  input: BeginTranscriptInput,
  user: NonNullable<BeginTranscriptInput['user']>,
  epochId: string,
): NewModelItem {
  const payload: TranscriptPayload = {
    type: 'message',
    role: 'user',
    content: user.content.parts,
  };
  return {
    id: randomUUID(),
    conversationId: input.conversationId,
    epochId,
    idempotencyKey: user.messageId ? `user:${user.messageId}` : `user:${input.requestId}:${input.turnId}`,
    requestId: input.requestId,
    turnId: input.turnId,
    step: 1,
    kind: 'user',
    source: 'user',
    scope: 'conversation',
    contentVersion: CONTENT_VERSION,
    payload,
    contentHash: itemContentHash(payload),
    messageId: user.messageId,
    callId: null,
    status: 'complete',
  };
}

function backgroundItem(
  input: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly turnId: string;
  },
  epochId: string,
  block: PlannedBlock,
  now: Date,
): PendingItem {
  const text = renderBlock(block);
  const payload: TranscriptPayload = {
    type: 'background',
    key: block.key,
    scope: block.scope,
    text,
    revision: block.revision,
    cleared: block.cleared,
    ...(block.requestId ? { requestId: block.requestId } : {}),
  };
  const newItem: NewModelItem = {
    id: randomUUID(),
    conversationId: input.conversationId,
    epochId,
    idempotencyKey: `context:${epochId}:${block.key}:${block.revision}`,
    requestId: input.requestId,
    turnId: input.turnId,
    step: null,
    kind: 'background',
    source: 'application',
    scope: block.scope === 'persistent' ? 'conversation' : block.scope,
    contentVersion: CONTENT_VERSION,
    payload,
    contentHash: itemContentHash(payload),
    status: 'complete',
  };
  void now;
  return { newItem, loopItem: loopInputForNewItem(newItem) };
}

function compressedItem(
  conversationId: string,
  epochId: string,
  requestId: string,
  turnId: string,
  step: number,
  entry: { readonly item: LoopInputItem; readonly originalCallId?: string },
): NewModelItem {
  if (entry.item.type !== 'function_call_result') {
    throw new Error('only a trimmed tool result can be re-materialised as an item');
  }
  const payload: TranscriptPayload = {
    type: 'function_call_result',
    callId: entry.item.callId,
    name: entry.item.name,
    output: entry.item.output,
  };
  return {
    id: randomUUID(),
    conversationId,
    epochId,
    idempotencyKey: `trim:${turnId}:${step}:${entry.item.callId}`,
    requestId,
    turnId,
    step,
    kind: 'tool_result',
    source: 'system',
    scope: 'stage',
    contentVersion: CONTENT_VERSION,
    payload,
    contentHash: itemContentHash(payload),
    callId: entry.item.callId,
    status: 'complete',
  };
}

function loopInputForNewItem(item: NewModelItem): LoopInputItem {
  const payload = item.payload;
  switch (payload.type) {
    case 'message':
      return {
        type: 'message',
        role: payload.role,
        content: payload.content,
        source: item.source === 'user' ? 'conversation' : item.source === 'assistant' ? 'conversation' : 'summary',
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
    case 'background':
      return {
        type: 'message',
        role: 'user',
        content: payload.text,
        source: 'background',
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
    case 'summary':
      return { type: 'message', role: 'system', content: payload.text, source: 'summary' };
    case 'function_call':
      return {
        type: 'function_call',
        callId: payload.callId,
        name: payload.name,
        arguments: payload.arguments,
      };
    case 'function_call_result':
      return {
        type: 'function_call_result',
        callId: payload.callId,
        name: payload.name,
        output: payload.output,
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        text: payload.text,
        ...(payload.id ? { id: payload.id } : {}),
        ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
      };
    case 'interrupt':
      return { type: 'message', role: 'system', content: payload.text, source: 'summary' };
  }
}

function outputToLoopInput(item: LoopOutputItem): LoopInputItem {
  switch (item.type) {
    case 'message':
      return { type: 'message', role: 'assistant', content: item.content, source: 'conversation' };
    case 'function_call':
      return {
        type: 'function_call',
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        text: item.text,
        ...(item.id ? { id: item.id } : {}),
        ...(item.raw !== undefined ? { raw: item.raw } : {}),
      };
  }
}

interface MappedItem {
  readonly item: LoopInputItem;
  readonly id: string | null;
  readonly originalCallId?: string;
}

function itemKey(item: LoopInputItem): string {
  switch (item.type) {
    case 'message':
      return `message:${item.role}:${JSON.stringify(item.content)}`;
    case 'function_call':
      return `call:${item.callId}`;
    case 'function_call_result':
      return `result:${item.callId}`;
    case 'reasoning':
      return `reasoning:${item.id ?? ''}:${item.text}`;
  }
}

function mappingFor(
  requestInput: readonly LoopInputItem[],
  fullInput: readonly LoopInputItem[],
  ids: readonly string[],
): MappedItem[] {
  return requestInput.map((item) => {
    let index = fullInput.indexOf(item);
    if (index < 0 && item.type !== 'function_call_result') {
      const key = itemKey(item);
      index = fullInput.findIndex((candidate) => itemKey(candidate) === key);
    }
    if (index >= 0) return { item, id: ids[index] ?? null };
    if (item.type === 'function_call_result') {
      const original = fullInput.findIndex(
        (candidate) =>
          candidate.type === 'function_call_result' && candidate.callId === item.callId,
      );
      if (original >= 0) {
        return { item, id: null, originalCallId: item.callId };
      }
    }
    return { item, id: null };
  });
}

async function loadItems(
  store: ModelTranscriptStore,
  conversationId: string,
  ids: readonly string[],
): Promise<ModelItem[]> {
  if (ids.length === 0) return [];
  const items = await store.listItems(conversationId, ids);
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids
    .map((id) => byId.get(id))
    .filter((item): item is ModelItem => item !== undefined);
}

async function loopItemsFor(
  store: ModelTranscriptStore,
  conversationId: string,
  ids: readonly string[],
  pending: readonly PendingItem[],
): Promise<LoopInputItem[]> {
  const pendingById = new Map(pending.map((entry) => [entry.newItem.id, entry.loopItem]));
  const items = await loadItems(store, conversationId, ids);
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.map((id) => {
    const ready = pendingById.get(id);
    if (ready) return ready;
    const item = byId.get(id);
    const input = item ? itemToLoopInput(item) : null;
    if (!input) throw new Error(`model item ${id} cannot be replayed`);
    return input;
  });
}

async function hasUnseededMessages(
  store: ModelTranscriptStore,
  epoch: ModelEpoch,
  messages: readonly Message[],
): Promise<boolean> {
  if (messages.length === 0) return false;
  const known = await store.knownMessageIds(epoch.conversationId);
  return messages.some((message) => !known.has(message.id));
}

async function summaryChanged(
  store: ModelTranscriptStore,
  epoch: ModelEpoch,
  replay: SessionReplay,
): Promise<boolean> {
  const items = await loadItems(store, epoch.conversationId, epoch.windowItemIds);
  const summaryItem = items.find((item) => item.kind === 'summary');
  if (!replay.summary) return summaryItem !== undefined;
  if (!summaryItem || summaryItem.payload.type !== 'summary') return true;
  return summaryItem.payload.text !== renderArchivedSummary(replay.summary);
}

interface UnpairedCall {
  readonly callId: string;
  readonly name: string;
  readonly callItemId: string;
}

async function findUnpairedCall(
  store: ModelTranscriptStore,
  epoch: ModelEpoch,
): Promise<UnpairedCall | null> {
  const items = await loadItems(store, epoch.conversationId, epoch.windowItemIds);
  const results = new Set(
    items
      .filter((item) => item.kind === 'tool_result')
      .map((item) => item.callId),
  );
  for (const item of items) {
    if (item.kind !== 'tool_call' || !item.callId) continue;
    if (!results.has(item.callId)) {
      const payload = item.payload;
      return {
        callId: item.callId,
        name: payload.type === 'function_call' ? payload.name : 'unknown',
        callItemId: item.id,
      };
    }
  }
  return null;
}

async function beginWithRecoveryBoundary(
  input: BeginTranscriptInput,
  active: ModelEpoch,
  unpaired: UnpairedCall,
  toolsHash: string,
  encoder: string,
  protocol: string,
  now: Date,
): Promise<BegunTranscript> {
  const filtered = active.windowItemIds.filter((id) => id !== unpaired.callItemId);
  // Items must exist before the new epoch can reference them; the note is
  // appended into the *old* epoch and then carried into the new window, which is
  // legal because window entries are item ids, not per-epoch copies.
  const notePayload: TranscriptPayload = {
    type: 'interrupt',
    reason: 'unpaired-tool',
    callId: unpaired.callId,
    text: [
      `[工具调用中断：${unpaired.name} call=${unpaired.callId}]`,
      '这次调用的结果从未被观察到。系统没有自动重跑它，也没有把它当作成功或失败；',
      '如果需要它的结果，由人决定是否重新执行。这里只保留调用事实。',
    ].join('\n'),
  };
  const note: NewModelItem = {
    id: randomUUID(),
    conversationId: input.conversationId,
    epochId: active.id,
    idempotencyKey: `recovery:${unpaired.callId}`,
    requestId: input.requestId,
    turnId: input.turnId,
    step: null,
    kind: 'interrupt',
    source: 'system',
    scope: 'conversation',
    contentVersion: CONTENT_VERSION,
    payload: notePayload,
    contentHash: itemContentHash(notePayload),
    callId: unpaired.callId,
    status: 'unknown',
  };
  await input.store.appendItems([note]);
  const nextWindow = [...filtered, note.id as string];
  const epoch = await input.store.createEpoch({
    id: randomUUID(),
    userId: input.userId,
    conversationId: input.conversationId,
    parentEpochId: active.id,
    reason: 'recovery-boundary',
    instructions: input.instructions,
    promptVersion: input.promptVersion,
    tools: input.tools,
    toolsHash,
    providerId: input.profile.providerId,
    modelId: input.profile.id,
    protocolRevision: protocol,
    encoderRevision: encoder,
    windowItemIds: nextWindow,
    windowRevision: 0,
    seededThroughSeq: active.seededThroughSeq,
    createdAt: now,
  });
  log.warn('model_transcript.recovery_boundary', {
    conversation_id: input.conversationId,
    call_id: unpaired.callId,
    tool: unpaired.name,
  });
  return DurableTranscript.hydrate(input, epoch, nextWindow, protocol, encoder, now);
}

// --------------------------------------------------------------- diagnostics ---

export interface TranscriptDiagnostics {
  readonly epochs: readonly ModelEpoch[];
  readonly items: number;
  readonly steps: readonly ModelStepRecord[];
  readonly usage: TurnUsageSummary | null;
}

/**
 * Read-only summary for a CLI or a report. It deliberately does not dump item
 * bodies: ids, counts, hashes and usage are enough to explain a request sequence
 * without copying private text into a log or a terminal.
 */
export async function transcriptDiagnostics(
  store: ModelTranscriptStore,
  conversationId: string,
  requestId?: string,
): Promise<TranscriptDiagnostics> {
  const epochs = await store.listEpochs(conversationId);
  const active = await store.activeEpoch(conversationId);
  const items = active ? await store.listEpochItems(active.id) : [];
  const steps = requestId
    ? await store.listSteps(requestId)
    : active
      ? await store.listRecentSteps(conversationId, 50)
      : [];
  return {
    epochs,
    items: items.length,
    steps,
    usage: requestId ? summarizeTurnUsage(steps, null) : null,
  };
}

/** A stable note used when a turn has no text to continue from. */
export function interruptedReplayNote(): string {
  return [
    '[上一条回复在生成途中停止]',
    '上一条回复没有完整结束。这里保留的是当时实际显示的内容；不要把它当作完整回答，',
    '也不要凭空补全没有出现的工具调用或推理。',
  ].join('\n');
}

