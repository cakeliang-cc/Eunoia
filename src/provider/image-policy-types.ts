/**
 * The vocabulary a token estimate reports back in.
 *
 * Kept in a tiny module so both the policy interface and its implementations can
 * name the basis without a cycle through the registry.
 */

export type ImageCostBasis =
  /** A local reproduction of the provider's own documented calculator. */
  | 'provider-calculator'
  /** A request-counting endpoint the provider actually exposes. */
  | 'provider-counter'
  /** A documented per-image bound, used as a conservative ceiling. */
  | 'documented-bound';
