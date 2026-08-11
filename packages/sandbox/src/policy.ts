import { canonicalDigest } from '@openpacker/canonical';
import type { Digest, SemanticLoss } from '@openpacker/contracts';
import {
  DEFAULT_SANDBOX_POLICY,
  type PackageGrants,
  type SandboxBackendId,
  type SandboxMode,
  type SandboxPolicy,
  type SandboxPrefer,
  SANDBOX_LOSS,
} from './types.js';

const COORDINATE_BOUNDARY = new Set(['@', '/', '?', '#', '*']);

/**
 * Match package grants with the same boundary discipline as policy excludes:
 * prefix matches must stop on a coordinate boundary (or end with one / `*`).
 */
export function matchPackageGrant(
  packageId: string | undefined,
  packages: Readonly<Record<string, PackageGrants>> | undefined,
): PackageGrants | undefined {
  if (!packageId || !packages) return undefined;
  const keys = Object.keys(packages).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key === packageId) return packages[key];
    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      if (packageId.startsWith(prefix)) return packages[key];
      continue;
    }
    if (!packageId.startsWith(key)) continue;
    const last = key.charAt(key.length - 1);
    if (COORDINATE_BOUNDARY.has(last)) return packages[key];
    if (COORDINATE_BOUNDARY.has(packageId.charAt(key.length)))
      return packages[key];
  }
  return undefined;
}

export function resolvePolicy(policy: SandboxPolicy): {
  enabled: boolean;
  mode: SandboxMode;
  prefer: SandboxPrefer;
  required: boolean;
  allowHostUnsandboxedInstall: boolean;
} {
  const mode = policy.mode ?? DEFAULT_SANDBOX_POLICY.mode;
  const enabled =
    policy.enabled ?? (mode === 'off' ? false : DEFAULT_SANDBOX_POLICY.enabled);
  const required =
    policy.required ??
    (mode === 'fail-closed' ? true : DEFAULT_SANDBOX_POLICY.required);
  return {
    enabled: mode === 'off' ? false : enabled,
    mode,
    prefer: policy.prefer ?? DEFAULT_SANDBOX_POLICY.prefer,
    required,
    allowHostUnsandboxedInstall:
      policy.allowHostUnsandboxedInstall ??
      DEFAULT_SANDBOX_POLICY.allowHostUnsandboxedInstall,
  };
}

export async function digestSandboxPolicy(
  policy: SandboxPolicy,
): Promise<Digest> {
  // Stable projection: only fields that affect enforcement.
  const resolved = resolvePolicy(policy);
  const packages = policy.packages
    ? Object.fromEntries(
        Object.entries(policy.packages).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      )
    : {};
  return canonicalDigest({
    sandboxPolicyVersion: 1,
    enabled: resolved.enabled,
    mode: resolved.mode,
    prefer: resolved.prefer,
    required: resolved.required,
    allowHostUnsandboxedInstall: resolved.allowHostUnsandboxedInstall,
    packages: packages as Record<string, Record<string, unknown>>,
  } as import('@openpacker/contracts').JsonValue);
}

export function mergeGrants(
  ...parts: Array<PackageGrants | undefined>
): PackageGrants {
  const write: string[] = [];
  const read: string[] = [];
  const env: string[] = [];
  let network = false;
  for (const part of parts) {
    if (!part) continue;
    if (part.network) network = true;
    if (part.write) write.push(...part.write);
    if (part.read) read.push(...part.read);
    if (part.env) env.push(...part.env);
  }
  return {
    network,
    write: [...new Set(write)],
    read: [...new Set(read)],
    env: [...new Set(env)],
  };
}

export function loss(
  code: string,
  severity: SemanticLoss['severity'],
  originalMeaning: string,
  representedMeaning: string,
  blocksProfile: SemanticLoss['blocksProfile'] = [],
): SemanticLoss {
  return {
    code,
    severity,
    sourceEcosystem: 'openpacker',
    sourcePath: 'sandbox',
    originalMeaning,
    representedMeaning,
    blocksProfile,
  };
}

export function backendLosses(
  backend: SandboxBackendId,
  enforced: boolean,
  degraded: boolean,
): SemanticLoss[] {
  const losses: SemanticLoss[] = [];
  if (enforced) {
    losses.push(
      loss(
        SANDBOX_LOSS.ENFORCED,
        'info',
        'the process ran inside an OS-enforced jail',
        `OpenPacker enforced a sandbox via backend ${backend}`,
      ),
    );
  }
  if (backend === 'mxc') {
    losses.push(
      loss(
        SANDBOX_LOSS.BACKEND_MXC,
        'info',
        'containment used Microsoft MXC',
        'MXC is early preview; treat as defense-in-depth, not a finished boundary',
      ),
    );
  } else if (backend.startsWith('native-') || backend === 'mock') {
    losses.push(
      loss(
        SANDBOX_LOSS.BACKEND_NATIVE,
        'info',
        'containment used a native or test jail',
        `backend=${backend}`,
      ),
    );
  }
  if (degraded) {
    losses.push(
      loss(
        SANDBOX_LOSS.DEGRADED,
        'warning',
        'the process ran without full jail enforcement',
        'sandbox mode allowed degraded execution',
        [],
      ),
    );
  }
  if (backend === 'none') {
    losses.push(
      loss(
        SANDBOX_LOSS.UNAVAILABLE,
        'error',
        'no containment backend could enforce the requested jail',
        'fail-closed refuses ambient execution',
        ['native-validated-v1'],
      ),
    );
  }
  return losses;
}
