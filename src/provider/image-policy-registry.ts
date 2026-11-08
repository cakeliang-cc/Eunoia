/**
 * The default policy registry.
 *
 * A composition root builds this once and injects it. Keeping the construction
 * here means a test can add its own route without editing the planner, and the
 * production process cannot accidentally fall back to a DeepSeek formula for a
 * route it has never seen.
 */

import { ImagePolicyRegistry } from './image-policy.ts';
import { DEEPSEEK_FLASH_IMAGE_POLICY } from './deepseek/image-policy.ts';
import { FAKE_IMAGE_POLICY } from './fake.ts';

export function defaultImagePolicies(): ImagePolicyRegistry {
  const registry = new ImagePolicyRegistry();
  registry.register(DEEPSEEK_FLASH_IMAGE_POLICY);
  // The offline route is registered so the replaceability acceptance test can
  // select it by id; it is never listed by `/api/models`.
  registry.register(FAKE_IMAGE_POLICY);
  return registry;
}
