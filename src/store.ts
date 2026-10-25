/**
 * The full persistence surface, composed at the edge.
 *
 * `memory` and `session` are separate layers with separate ports. Neither imports
 * the other. This module is the one place they are joined, because the process
 * needs one wiring handle and the database happens to hold both.
 *
 * A caller that only needs memories should depend on `MemoryStore`; a caller that
 * only needs conversations should depend on `SessionStore`. `Store` is for
 * composition roots and adapters that genuinely cross the boundary.
 */

import type { SessionStore } from './session/store.ts';
import type {
  FeedbackStore,
  IdentityStore,
  MemoryStore,
  PreferenceStore,
  RunStore,
} from './memory/store.ts';

export interface Store
  extends IdentityStore,
    MemoryStore,
    SessionStore,
    RunStore,
    PreferenceStore,
    FeedbackStore {
  /** Cheap liveness probe used by `GET /health`. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
