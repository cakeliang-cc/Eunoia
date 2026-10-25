/**
 * What a model can do, independent of how it is reached.
 *
 * A provider owns the connection (base URL, key, protocol). A model profile owns
 * the capability numbers that shape a request: context window, output reserve,
 * safety buffer, and the product's default conversation budget.
 *
 * The session layer uses these numbers; it never imports a provider or an SDK.
 */

export interface ModelProfile {
  readonly id: string;
  readonly providerId: string;
  /** Hard model capability, not the product's chosen budget. */
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyBufferTokens: number;
  /**
   * The budget used when the person has not set an explicit override.
   *
   * For a 1M-context model this is deliberately lower than the capability: a
   * companion turn does not need the whole window, and paying for it every turn
   * would make long conversations expensive for no visible gain.
   */
  readonly defaultInputBudgetTokens: number;
  readonly tokenEstimator: 'mixed' | 'chars4';
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
}
