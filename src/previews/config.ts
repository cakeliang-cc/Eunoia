/**
 * Deployment switches for preview ingress.
 *
 * Preview is an explicit capability, not an automatic consequence of enabling a
 * sandbox. Its gateway binds loopback only; a remote deployment must terminate
 * authenticated ingress in front of it.
 */

export interface PreviewSettings {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly baseDomain: string;
  readonly leaseFile: string | null;
  readonly ttlMs: number;
  readonly maxPerConversation: number;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export function previewSettings(
  env: NodeJS.ProcessEnv = process.env,
  defaultLeaseFile: string | null = null,
): PreviewSettings {
  const port = Number.parseInt(env.SANDBOX_PREVIEW_PORT ?? '8790', 10);
  return {
    enabled: flag(env.SANDBOX_PREVIEW_ENABLED, true),
    host: env.SANDBOX_PREVIEW_HOST?.trim() || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 && port <= 65_535 ? port : 8790,
    baseDomain: env.SANDBOX_PREVIEW_BASE_DOMAIN?.trim() || 'preview.localhost',
    leaseFile: env.SANDBOX_PREVIEW_LEASE_FILE?.trim() || defaultLeaseFile,
    ttlMs: Number.parseInt(env.SANDBOX_PREVIEW_TTL_MS ?? String(30 * 60_000), 10) || 30 * 60_000,
    maxPerConversation: Math.max(
      1,
      Number.parseInt(env.SANDBOX_PREVIEW_MAX_PER_CONVERSATION ?? '2', 10) || 2,
    ),
  };
}
