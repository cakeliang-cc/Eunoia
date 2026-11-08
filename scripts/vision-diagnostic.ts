/**
 * R07 — why an image request succeeds or is refused, without guessing.
 *
 * It prints the deployment commit, the catalog routes with an image capability,
 * their policy revision, the selected provider endpoint (redacted), and the
 * exact local preflight decision for the configured companion model. It never
 * prints a key and never turns a local refusal into a claim about the vendor.
 */

import { execFileSync } from 'node:child_process';
import { DEFAULT_COMPANION_MODEL_ID, MODEL_CATALOG } from '../src/models/catalog.ts';
import { MODEL_IDS } from '../src/config.ts';
import { providerFor } from '../src/provider/index.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function commit(): string {
  if (process.env.EUNOIA_BUILD_COMMIT?.trim()) return process.env.EUNOIA_BUILD_COMMIT.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function redactEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '(unparseable)';
  }
}

const selected = arg('model') ?? process.env.COMPANION_MODEL?.trim() ?? DEFAULT_COMPANION_MODEL_ID;
const profile = MODEL_CATALOG[selected] ?? MODEL_CATALOG[DEFAULT_COMPANION_MODEL_ID];
if (!profile) throw new Error(`no model profile for ${selected}`);
const provider = providerFor(profile.providerId);
const endpoint =
  process.env.DEEPSEEK_BASE_URL?.trim() ??
  process.env.OPENAI_BASE_URL?.trim() ??
  'https://api.deepseek.com';

const report = {
  commit: commit(),
  node: process.version,
  selectedModelId: selected,
  selectedProviderId: profile.providerId,
  endpoint: redactEndpoint(endpoint),
  keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()),
  selectedCapabilities: profile.capabilities,
  imagePolicyId: profile.capabilities.imagePolicyId ?? null,
  policyRevision: profile.capabilities.policyRevision,
  catalogImageRoutes: Object.values(MODEL_CATALOG)
    .filter((entry) => entry.capabilities.input.image === 'supported')
    .map((entry) => ({
      id: entry.id,
      providerId: entry.providerId,
      policyRevision: entry.capabilities.policyRevision,
      imagePolicyId: entry.capabilities.imagePolicyId ?? null,
      maxCount: entry.capabilities.image?.maxCount ?? null,
    })),
  preflight: {
    // This is the local decision only. It says whether `request-plan.ts` would
    // allow an image request to be built; it is not the vendor's response.
    imageSupported: profile.capabilities.input.image === 'supported',
    decision:
      profile.capabilities.input.image === 'supported'
        ? 'would-send-to-provider'
        : 'blocked-before-send (MODEL_INPUT_UNSUPPORTED)',
    note:
      profile.capabilities.input.image === 'supported'
        ? 'A local allow only proves the request would be sent. Real vision is proven by tests/smoke/live-vision.test.ts.'
        : 'A local refusal is not evidence that the vendor cannot see images. Select a route whose capability is supported.',
  },
  visionSmoke:
    MODEL_IDS.fast === selected
      ? 'run: RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts'
      : `select ${MODEL_IDS.fast} (or another catalog route with image=supported) and run: RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts`,
  providerAdapter: provider.profile.id,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
