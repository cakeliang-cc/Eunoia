/**
 * What a model can do, independent of how it is reached.
 *
 * A provider owns the connection (base URL, key, protocol). A model profile owns
 * the capability numbers that shape a request: context window, output reserve,
 * safety buffer, the product's default conversation budget, and — since media
 * input — a three-valued statement about each modality.
 *
 * Three values, not two. "Unknown" is a real answer: a model whose endpoint has
 * never been checked for image input is not a text model, and silently treating
 * it as one is how a request becomes a model that claims to have seen an image it
 * never received. Unknown is rejected for a new image request, while an explicit
 * `unsupported` is a permanent product fact that can be shown as such.
 *
 * The capability object also names the image-token policy and its revision. The
 * token count is not part of the transport and not part of the generic planner:
 * it belongs to the route, and a profile that cannot name one cannot accept an
 * image.
 */

export type ModalitySupport = 'supported' | 'unsupported' | 'unknown';

export interface RouteImageLimits {
  /** Media types this route accepts. A subset of the product list. */
  readonly mediaTypes: readonly string[];
  /** Images in one request (whole replay window, not one message). */
  readonly maxCount: number;
  readonly maxBytesPerImage: number;
  /** The provider's own pixel ceiling, when it is known. */
  readonly maxPixels?: number;
  /**
   * The detail setting the route fixes for phase one.
   *
   * Not exposed as a client enum: a product that let a browser choose a
   * provider-specific detail value would have made the provider part of the UI.
   */
  readonly detail: 'auto' | 'low' | 'high';
}

export interface RouteCapabilities {
  readonly input: {
    readonly text: ModalitySupport;
    readonly image: ModalitySupport;
  };
  readonly output: {
    readonly text: ModalitySupport;
  };
  readonly tools: ModalitySupport;
  /** The image-token calculator this route uses, if it accepts images. */
  readonly imagePolicyId?: string;
  /** Version of the media policy encoded by this route. */
  readonly policyRevision: string;
  readonly image?: RouteImageLimits;
}

export interface ModelProfile {
  readonly id: string;
  readonly providerId: string;
  /** Human-facing name; the client must not infer capability from it. */
  readonly displayName: string;
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
  readonly capabilities: RouteCapabilities;
}
