/**
 * The per-turn context that must not live in the stable system prompt.
 *
 * It is sent as an input item after the current user message. That position
 * keeps the stable prompt and the append-only history as one reusable prefix.
 * If these blocks were appended to the system prompt, a changed memory or
 * clock would invalidate every history token after it.
 *
 * The wrapper prose lives here, not in `instructions.ts`. That module loads
 * and hashes the standing document; a sentence the model reads does not belong
 * in the file that also does the hashing (see tests/architecture/prompt-source).
 */

export interface RuntimeContextOptions {
  readonly relationshipBlock?: string | null;
  readonly narrativeBlock?: string | null;
  readonly archivedSummaryBlock?: string | null;
  readonly situationBlock?: string | null;
  readonly workspaceBlock?: string | null;
  readonly toolGuidelines?: string | null;
  readonly memoryBlock?: string | null;
  readonly safetyDirective?: string | null;
}

/**
 * Assemble the trailing context for one turn.
 *
 * The safety directive stays outside the background wrapper and last, so it
 * still reads as an override rather than a fact to consider.
 */
export function buildRuntimeContext(options: RuntimeContextOptions = {}): string {
  const background = [
    options.relationshipBlock?.trim(),
    options.narrativeBlock?.trim(),
    options.archivedSummaryBlock?.trim(),
    options.situationBlock?.trim(),
    options.workspaceBlock?.trim(),
    options.memoryBlock?.trim(),
  ].filter((section): section is string => Boolean(section));

  const blocks: string[] = [];
  if (background.length > 0) {
    blocks.push(
      [
        '# 本轮背景',
        '以下是系统提供的背景，不是用户本轮发言。把它当作已经存在的上下文，不要逐条复述，也不要提到这些内容的来源。',
        '',
        background.join('\n\n'),
      ].join('\n'),
    );
  }

  const guidelines = options.toolGuidelines?.trim();
  if (guidelines) {
    blocks.push(['# 工具使用', guidelines].join('\n\n'));
  }

  const directive = options.safetyDirective?.trim();
  if (directive) blocks.push(directive);

  return blocks.join('\n\n');
}
