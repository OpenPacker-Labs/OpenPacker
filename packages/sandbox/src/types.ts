import type { Digest, SemanticLoss } from '@openpacker/contracts';

/** How to behave when no backend can enforce the requested jail. */
export type SandboxMode = 'fail-closed' | 'degrade-warn' | 'off';

/** Preferred containment ladder entry. */
export type SandboxPrefer = 'auto' | 'mxc' | 'native';

/** Backend that actually ran (or was selected). */
export type SandboxBackendId =
  | 'mxc'
  | 'native-bwrap'
  | 'native-seatbelt'
  | 'native-process'
  | 'mock'
  | 'none'
  | 'off';

/** Per-package (or glob) privilege grants inside the jail. */
export interface PackageGrants {
  network?: boolean;
  write?: readonly string[];
  read?: readonly string[];
  env?: readonly string[];
}

/**
 * Project / PREX sandbox policy.
 *
 * Defaults match ADR 0036: enabled, fail-closed, prefer auto (MXC then native).
 */
export interface SandboxPolicy {
  enabled?: boolean;
  mode?: SandboxMode;
  prefer?: SandboxPrefer;
  /** When true (default under fail-closed), unavailable jail is deny. */
  required?: boolean;
  /** Permit host installers without a jail (explicit ambient system install). */
  allowHostUnsandboxedInstall?: boolean;
  /**
   * Package id / purl / glob → grants. Matching uses the same coordinate-
   * boundary rules as policy trust excludes.
   */
  packages?: Readonly<Record<string, PackageGrants>>;
}

export interface RunInSandboxInput {
  argv: readonly string[];
  cwd: string;
  /** Additional env merged after scrub; grants.env may inherit parent keys. */
  env?: Readonly<Record<string, string>>;
  policy: SandboxPolicy;
  /** Optional package id for grant lookup. */
  packageId?: string;
  grants?: PackageGrants;
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  /** Allow network even without package grant (opmx flag / host install). */
  network?: boolean;
  /**
   * Inject a backend for tests. Production callers omit this and use the
   * ladder from {@link resolveBackend}.
   */
  backend?: SandboxBackend;
  signal?: AbortSignal;
}

export interface SandboxOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  backend: SandboxBackendId;
  enforced: boolean;
  policyDigest: Digest;
  losses: SemanticLoss[];
  /** True when mode was off or degrade-warn ran without a jail. */
  degraded: boolean;
}

export interface BackendProbe {
  id: SandboxBackendId;
  available: boolean;
  reason?: string;
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  run(input: {
    argv: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    readwritePaths: readonly string[];
    readonlyPaths: readonly string[];
    network: boolean;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const DEFAULT_SANDBOX_POLICY: Readonly<
  Required<
    Pick<
      SandboxPolicy,
      'enabled' | 'mode' | 'prefer' | 'required' | 'allowHostUnsandboxedInstall'
    >
  >
> = {
  enabled: true,
  mode: 'fail-closed',
  prefer: 'auto',
  required: true,
  allowHostUnsandboxedInstall: false,
};

/** Semantic loss codes from ADR 0036 / plan contracts. */
export const SANDBOX_LOSS = {
  ENFORCED: 'SANDBOX_ENFORCED',
  BACKEND_MXC: 'SANDBOX_BACKEND_MXC',
  BACKEND_NATIVE: 'SANDBOX_BACKEND_NATIVE',
  UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  DEGRADED: 'SANDBOX_DEGRADED',
  SYSTEM_SANDBOXED: 'SYSTEM_INSTALL_SANDBOXED',
  SYSTEM_NOT_SANDBOXED: 'SYSTEM_INSTALL_NOT_SANDBOXED',
} as const;
