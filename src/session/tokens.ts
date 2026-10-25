/**
 * A deliberately conservative token estimator.
 *
 * The provider is the only exact counter, and we do not have a stable usage
 * number at the point where the decision has to be made. `chars / 4` — the old
 * message estimate — is an English rule of thumb that undercounts Chinese by a
 * large factor: one Chinese character is usually one token, not a quarter of
 * one. Undercounting makes compaction run too late, which is the failure mode
 * we are trying to remove.
 *
 * `mixed` counts CJK characters as one token each and everything else at four
 * characters per token. It is intentionally pessimistic; a false early
 * compaction costs a summary call, a false late one costs a rejected request.
 */

export type TokenEstimatorMode = 'mixed' | 'chars4';

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

export function estimateTokens(text: string, mode: TokenEstimatorMode = 'mixed'): number {
  if (text.length === 0) return 0;
  if (mode === 'chars4') return Math.ceil(text.length / 4);

  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** A message carries a small role/turn overhead on top of its text. */
export function estimateMessageTokens(
  message: { readonly content: string },
  mode: TokenEstimatorMode = 'mixed',
): number {
  return estimateTokens(message.content, mode) + 4;
}

export function estimateMessagesTokens(
  messages: readonly { readonly content: string }[],
  mode: TokenEstimatorMode = 'mixed',
): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message, mode);
  return total;
}

/**
 * Cut text to a token budget.
 *
 * Used for the summary itself, not for model history. It is approximate on
 * purpose: the summary model's `max_tokens` is the hard bound, and this only
 * keeps the stored checkpoint from growing without limit.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  mode: TokenEstimatorMode = 'mixed',
): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text, mode) <= maxTokens) return text;

  let used = 0;
  let end = 0;
  for (const char of text) {
    const cost = mode === 'chars4' ? 0.25 : CJK.test(char) ? 1 : 0.25;
    if (used + cost > maxTokens) break;
    used += cost;
    end += char.length;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}
