/**
 * Image-token policies, selected by route rather than by vendor name.
 *
 * The request planner needs one thing from a route: a function that turns the
 * actual request image's dimensions into an estimate and an honest basis. It
 * must not contain `if (modelId === ...)`, a patch constant, or a 1024 cap. The
 * route's capability object names a policy id; this registry resolves it. A
 * second provider therefore substitutes a policy object, not planner code.
 *
 * The registry is built at the composition root and injected. That keeps the
 * generic planner free of provider imports and makes the "unknown policy is not
 * zero tokens" rule expressible: resolving a missing id returns null.
 */

import type { ImageCostBasis } from './image-policy-types.ts';

export type { ImageCostBasis } from './image-policy-types.ts';

export interface ImageCostEstimate {
  readonly estimatedTokens: number;
  /**
   * A conservative upper bound, only when the provider documents one.
   *
   * A heuristic safety margin is not a mathematical upper bound and must not be
   * reported as one; the basis says which it is.
   */
  readonly upperBoundTokens?: number;
  readonly basis: ImageCostBasis;
  readonly policyRevision: string;
}

export interface ImageEstimateInput {
  readonly width: number;
  readonly height: number;
  readonly detail: string;
  readonly mediaType: string;
}

export interface ImageTokenPolicy {
  readonly id: string;
  readonly revision: string;
  estimate(input: ImageEstimateInput): ImageCostEstimate;
}

export class ImagePolicyRegistry {
  readonly #policies = new Map<string, ImageTokenPolicy>();

  register(policy: ImageTokenPolicy): this {
    this.#policies.set(policy.id, policy);
    return this;
  }

  get(id: string): ImageTokenPolicy | null {
    return this.#policies.get(id) ?? null;
  }

  /**
   * Resolve the policy a route names.
   *
   * Null means "this route cannot count images", which the planner turns into
   * `MODEL_CAPABILITY_UNKNOWN`; it is never allowed to become zero tokens.
   */
  forRoute(capabilities: {
    readonly imagePolicyId?: string;
    readonly policyRevision: string;
  }): ImageTokenPolicy | null {
    if (!capabilities.imagePolicyId) return null;
    return this.get(capabilities.imagePolicyId);
  }

  ids(): string[] {
    return [...this.#policies.keys()];
  }
}
