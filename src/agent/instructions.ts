/**
 * The companion's system prompt — loaded, not written here (spec §11).
 *
 * The prompt is a document: `prompts/companion.md`. This module reads it, strips
 * the editor's note at the top, and composes it with the per-turn parts. The
 * prose used to live here as template literals, which put the thing most likely
 * to be edited (the companion's voice) inside the thing least likely to be edited
 * casually (code that hashes, caches and versions it). Anyone tuning how the
 * companion talks had to edit TypeScript to do it, and every such edit risked
 * breaking a file that also does arithmetic.
 *
 * Why a runtime read rather than an inlined string:
 *
 * - **There is no build step in development.** Node strips types and runs the
 *   sources directly, so the file on disk is what the model gets. An inlining
 *   step would mean the prompt in the repository is not the prompt in use.
 * - **`PROMPT_VERSION` hashes what was actually sent.** Reading the file at
 *   startup means the version is derived from the same bytes the model reads,
 *   rather than from a copy of them that might be stale.
 *
 * What survives here is the composition: this file decides *what goes around* the
 * prompt (retrieved memory, a safety directive) and in which order. Order is not
 * cosmetic — the stable prefix is what prompt caching keys on, and a safety
 * directive has to come after the rules it overrides to read as an override.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Where the prompt document lives, next to this module. */
export const PROMPT_FILE = new URL('./prompts/companion.md', import.meta.url);

/**
 * Remove HTML comments.
 *
 * The document opens with a note to whoever edits it — what the file is, what
 * not to rename, and that a change here implies an evaluation run. That note is
 * for a person; the model should not be paying for it on every turn, and a
 * comment addressed to the maintainer read by the model is a small, permanent
 * confusion.
 */
export function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/** Read the prompt document and reduce it to exactly what the model is sent. */
function loadPrompt(): string {
  const raw = readFileSync(PROMPT_FILE, 'utf8');
  const body = stripComments(raw).trim();
  if (body.length === 0) {
    throw new Error(`${PROMPT_FILE.pathname} is empty; the companion would have no instructions`);
  }
  return body;
}

/**
 * The stable prompt — everything that does not change between turns.
 *
 * Read once per process, and the same string every time: `buildInstructions()`
 * is called per turn, and a prompt rebuilt per turn is both wasted work and a
 * cache miss (spec §14).
 */
export const STABLE_INSTRUCTIONS = loadPrompt();

export interface InstructionOptions {
  /**
   * The retrieved-memory block for this turn, or an empty string.
   *
   * Placed after everything stable and before the safety directive, because it
   * is the only per-turn content that is *background* rather than an
   * instruction. Prompt caching still applies: the cache key is the prefix, and
   * appending after it does not disturb it (spec §14).
   */
  readonly memoryBlock?: string | null;
  /**
   * Appended last, after everything else. A safety directive overrides the
   * behavioural policy by design (spec §10), and a rule that overrides earlier
   * rules has to come after them to read as an override.
   */
  readonly safetyDirective?: string | null;
}

/** Compose the full system prompt for a turn. */
export function buildInstructions(options: InstructionOptions = {}): string {
  const sections = [STABLE_INSTRUCTIONS];

  const memoryBlock = options.memoryBlock?.trim();
  if (memoryBlock) sections.push(memoryBlock);

  const directive = options.safetyDirective?.trim();
  if (directive) sections.push(directive);

  return sections.join('\n\n');
}

/**
 * A short content hash of the stable prompt.
 *
 * Recorded on every `agent_runs` row and every evaluation result. Without it,
 * "did the results change because the prompt changed or because the model
 * drifted?" is unanswerable after the fact. The rule that a prompt change needs
 * an evaluation run is only enforceable if the prompt has an identity that can be
 * compared — which is also why this hashes the loaded document rather than a
 * constant maintained by hand.
 */
export const PROMPT_VERSION: string = createHash('sha256')
  .update(STABLE_INSTRUCTIONS)
  .digest('hex')
  .slice(0, 12);
