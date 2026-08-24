import { canonicalDigest } from '@openpacker/canonical';
import type { Digest, SemanticLoss } from '@openpacker/contracts';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_SANDBOX_POLICY,
  type PackageGrants,
  type SandboxBackendId,
  type SandboxPolicy,
  type SandboxProfile,
  SANDBOX_LOSS,
} from './types.js';
import { JailPathError } from './paths.js';

const COORDINATE_BOUNDARY = new Set(['@', '/', '?', '#', '*']);

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

export function resolvePolicy(policy: SandboxPolicy) {
  const mode = policy.mode ?? DEFAULT_SANDBOX_POLICY.mode;
  const enabled =
    policy.enabled ?? (mode === 'off' ? false : DEFAULT_SANDBOX_POLICY.enabled);
  const required =
    policy.required ??
    (mode === 'fail-closed' ? true : DEFAULT_SANDBOX_POLICY.required);
  const byteLimit = (value: number | undefined, fallback: number) => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback)
      throw new RangeError(
        `Sandbox output limit must be between 1 and ${fallback}`,
      );
    return resolved;
  };
  return {
    enabled: mode === 'off' ? false : enabled,
    mode,
    prefer: policy.prefer ?? DEFAULT_SANDBOX_POLICY.prefer,
    required,
    allowHostUnsandboxedInstall:
      policy.allowHostUnsandboxedInstall ??
      DEFAULT_SANDBOX_POLICY.allowHostUnsandboxedInstall,
    projectWrite: policy.projectWrite ?? DEFAULT_SANDBOX_POLICY.projectWrite,
    minimalPath: policy.minimalPath ?? DEFAULT_SANDBOX_POLICY.minimalPath,
    strictLifecycleAllowlist:
      policy.strictLifecycleAllowlist ??
      DEFAULT_SANDBOX_POLICY.strictLifecycleAllowlist,
    allowDangerousGrants:
      policy.allowDangerousGrants ??
      DEFAULT_SANDBOX_POLICY.allowDangerousGrants,
    legacyFatRoot: policy.legacyFatRoot ?? DEFAULT_SANDBOX_POLICY.legacyFatRoot,
    timeoutMs: policy.timeoutMs ?? DEFAULT_SANDBOX_POLICY.timeoutMs,
    maximumStdoutBytes: byteLimit(
      policy.maximumStdoutBytes,
      DEFAULT_SANDBOX_POLICY.maximumStdoutBytes,
    ),
    maximumStderrBytes: byteLimit(
      policy.maximumStderrBytes,
      DEFAULT_SANDBOX_POLICY.maximumStderrBytes,
    ),
    maximumOutputBytes: byteLimit(
      policy.maximumOutputBytes,
      DEFAULT_SANDBOX_POLICY.maximumOutputBytes,
    ),
  };
}

export async function digestSandboxPolicy(
  policy: SandboxPolicy,
): Promise<Digest> {
  const resolved = resolvePolicy(policy);
  const packages = policy.packages
    ? Object.fromEntries(
        Object.entries(policy.packages).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      )
    : {};
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalDigest({
    sandboxPolicyVersion: 2,
    enabled: resolved.enabled,
    mode: resolved.mode,
    prefer: resolved.prefer,
    required: resolved.required,
    allowHostUnsandboxedInstall: resolved.allowHostUnsandboxedInstall,
    projectWrite: resolved.projectWrite,
    minimalPath: resolved.minimalPath,
    strictLifecycleAllowlist: resolved.strictLifecycleAllowlist,
    allowDangerousGrants: resolved.allowDangerousGrants,
    legacyFatRoot: resolved.legacyFatRoot,
    timeoutMs: resolved.timeoutMs,
    maximumStdoutBytes: resolved.maximumStdoutBytes,
    maximumStderrBytes: resolved.maximumStderrBytes,
    maximumOutputBytes: resolved.maximumOutputBytes,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

/**
 * Reject a path that *is* the filesystem root or the user home.
 * Paths *under* home (a project in ~/src) are allowed; package write
 * grants under home are still refused by {@link assertGrantsNotDangerous}.
 */
export function assertPathNotRootOrHome(
  raw: string,
  allowDangerous: boolean,
  label: string,
): void {
  if (allowDangerous) return;
  const p = resolve(raw);
  if (p === '/' || p === resolve('/')) {
    throw new JailPathError(
      label,
      `refusing ${label} at filesystem root; set sandbox.allow_dangerous_grants = true`,
    );
  }
  let home: string | undefined;
  try {
    home = resolve(homedir());
  } catch {
    home = undefined;
  }
  if (home && p === home) {
    throw new JailPathError(
      label,
      `refusing ${label} at the user home (${home}); set sandbox.allow_dangerous_grants = true`,
    );
  }
}

/** Reject write grants that cover `/` or the user home unless allowed. */
export function assertGrantsNotDangerous(
  writePaths: readonly string[],
  allowDangerous: boolean,
): void {
  if (allowDangerous) return;
  let home: string | undefined;
  try {
    home = resolve(homedir());
  } catch {
    home = undefined;
  }
  for (const raw of writePaths) {
    const p = resolve(raw);
    if (p === '/' || p === resolve('/')) {
      throw new JailPathError(
        'write grant',
        'refusing write grant for filesystem root; set sandbox.allow_dangerous_grants = true',
      );
    }
    if (home && (p === home || p.startsWith(home + '/'))) {
      throw new JailPathError(
        'write grant',
        `refusing write grant under home (${home}); set sandbox.allow_dangerous_grants = true`,
      );
    }
  }
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
  profile: SandboxProfile,
  enforced: boolean,
  degraded: boolean,
): SemanticLoss[] {
  const losses: SemanticLoss[] = [];
  if (enforced && profile === 'package-exec') {
    losses.push(
      loss(
        SANDBOX_LOSS.ENFORCED,
        'info',
        'package-exec ran inside an OS jail with a minimal bind profile',
        `backend=${backend}; defense-in-depth, not a microVM`,
      ),
    );
  }
  if (backend === 'mxc') {
    losses.push(
      loss(
        SANDBOX_LOSS.BACKEND_MXC,
        'info',
        'containment used Microsoft MXC',
        'MXC is early preview; not a finished security boundary',
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
  if (profile === 'host-install') {
    losses.push(
      loss(
        SANDBOX_LOSS.SYSTEM_LIMITED,
        'warning',
        'host installer runs with user-capability containment only',
        'not root isolation; system package managers may still mutate the host as the user',
        ['native-validated-v1'],
      ),
    );
  }
  if (degraded) {
    losses.push(
      loss(
        SANDBOX_LOSS.DEGRADED,
        'warning',
        'the process ran without full jail enforcement',
        'sandbox mode allowed degraded or ambient execution',
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
