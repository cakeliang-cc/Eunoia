/**
 * Runtime provider selection.
 *
 * The composition root chooses exactly one provider. There is no fallback chain:
 * a deployment configured for gVisor that cannot get gVisor fails, rather than
 * silently running on a weaker runtime (ADR §19, §21).
 */

import type { SandboxRuntime } from '../types.ts';
import { createOciRuntime } from './oci-runtime.ts';

export interface RuntimeSelectionOptions {
  readonly auditEgress?: import('./oci-runtime.ts').OciRuntimeOptions['auditEgress'];
  readonly kind: 'docker' | 'nerdctl';
  readonly binary?: string;
  readonly globalArgs?: readonly string[];
  readonly seccompProfile?: string | null;
  readonly apparmorProfile?: string | null;
  readonly egressNetwork?: string | null;
}

export function createRuntime(options: RuntimeSelectionOptions): SandboxRuntime {
  return createOciRuntime({
    kind: options.kind,
    ...(options.auditEgress ? { auditEgress: options.auditEgress } : {}),
    binary: options.binary ?? options.kind,
    globalArgs: options.globalArgs ?? [],
    seccompProfile: options.seccompProfile ?? null,
    apparmorProfile: options.apparmorProfile ?? null,
    egressNetwork: options.egressNetwork ?? null,
  });
}

export { FakeRuntime } from './fake.ts';
export { OciRuntime, createOciRuntime } from './oci-runtime.ts';
export { ContainerCli } from './container-cli.ts';
export {
  assertBaseline,
  buildCreateArgs,
  buildExecArgs,
  buildReadMarkerArgs,
  runtimeNameFor,
  sandboxContainerName,
  type ContainerCliOptions,
} from './oci-args.ts';
