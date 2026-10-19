import type { Digest, SemanticLoss } from '@openpacker/contracts';

/** How to behave when no backend can enforce the requested jail. */
export type SandboxMode = 'fail-closed' | 'degrade-warn' | 'off';

/** Preferred containment ladder entry. */
export type SandboxPrefer = 'auto' | 'mxc' | 'native';

/**
 * What kind of work is running. Determines bind profile and honesty flags.
 * - package-exec: opmx / lifecycle / ephemeral (minimal FS)
 * - host-install: apt/winget/… (limited user-capability jail)
 * - ambient: intentionally unsandboxed
 */
export type SandboxProfile = 'package-exec' | 'host-install' | 'ambient';

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
 * Defaults: enabled, fail-closed, prefer auto, project RO, minimal PATH.
 */
export interface SandboxPolicy {
  enabled?: boolean;
  mode?: SandboxMode;
  prefer?: SandboxPrefer;
  /** When true (default under fail-closed), unavailable jail is deny. */
  required?: boolean;
  /** @deprecated Host installers always refuse ambient execution. */
  allowHostUnsandboxedInstall?: boolean;
  /**
   * When true, package-exec may write the project tree (opmx). Default false.
   */
  projectWrite?: boolean;
  /**
   * When true (default), scrub PATH to /usr/bin:/bin + interpreter dir.
   */
  minimalPath?: boolean;
  /**
   * When true (default), refuse allowLifecycleScripts=true without an allowlist.
   * Enforced by opm-project lifecycle, not the sandbox package alone.
   */
  strictLifecycleAllowlist?: boolean;
  /**
   * When true, allow write grants that cover `/` or the user home.
   * Default false — dangerous grants are rejected.
   */
  allowDangerousGrants?: boolean;
  /**
   * Escape hatch: fat `--ro-bind / /` package-exec profile (insecure reads).
   * Default false.
   */
  legacyFatRoot?: boolean;
  /**
   * Package id / purl / glob → grants.
   */
  packages?: Readonly<Record<string, PackageGrants>>;
  /** Max wall-clock ms for a sandboxed process (default 600_000). 0 = none. */
  timeoutMs?: number;
  /** Raw stdout byte limit (default 1 MiB). */
  maximumStdoutBytes?: number;
  /** Raw stderr byte limit (default 1 MiB). */
  maximumStderrBytes?: number;
  /** Combined raw output byte limit (default 2 MiB). */
  maximumOutputBytes?: number;
}

export interface RunInSandboxInput {
  argv: readonly string[];
  cwd: string;
  /** Additional env merged after scrub; grants.env may inherit parent keys. */
  env?: Readonly<Record<string, string>>;
  /**
   * Bounded bytes written to the child's standard input; absent means the
   * child inherits no input (stdin is /dev/null). Callers bound the bytes
   * before handing them over — this is a transport, not a limit.
   */
  stdin?: Uint8Array;
  policy: SandboxPolicy;
  /** Optional package id for grant lookup. */
  packageId?: string;
  grants?: PackageGrants;
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  /** Allow network even without package grant (opmx flag / host install). */
  network?: boolean;
  /** Defaults to package-exec. */
  profile?: SandboxProfile;
  /**
   * Inject a backend for tests. Production callers omit this and use the
   * ladder from {@link resolveBackend}.
   */
  backend?: SandboxBackend;
  signal?: AbortSignal;
  /** Open directory handles the backend must use instead of reopening paths. */
  directoryAuthorities?: readonly { fd: number; path: string }[];
  /** Read-only standalone bytes copied into a private backend executable. */
  executableAuthority?: { fd: number; path: string };
}

export interface SandboxOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  backend: SandboxBackendId;
  profile: SandboxProfile;
  /**
   * True only for package-exec when a non-ambient backend ran.
   * Host-install and ambient never set this true for honesty.
   */
  enforced: boolean;
  /** Incomplete containment by design (host-install or ambient). */
  containmentLimited: boolean;
  policyDigest: Digest;
  losses: SemanticLoss[];
  /** True when mode was off or degrade-warn ran without a jail. */
  degraded: boolean;
  /** Set when the process tree was terminated for exceeding raw output policy. */
  outputLimitExceeded?: 'stdout' | 'stderr' | 'combined';
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
    /** Scrubbed environment for a native sandbox wrapper process. */
    hostEnv: Readonly<Record<string, string>>;
    /** Environment installed inside the jail for the target process. */
    env: Readonly<Record<string, string>>;
    readwritePaths: readonly string[];
    readonlyPaths: readonly string[];
    network: boolean;
    /** package-exec uses minimal binds; host-install uses broader. */
    profile: SandboxProfile;
    legacyFatRoot?: boolean;
    timeoutMs?: number;
    /** Bounded bytes for the child's stdin; absent means /dev/null. */
    stdin?: Uint8Array;
    maximumStdoutBytes: number;
    maximumStderrBytes: number;
    maximumOutputBytes: number;
    signal?: AbortSignal;
    directoryAuthorities?: readonly { fd: number; path: string }[];
    executableAuthority?: { fd: number; path: string };
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    outputLimitExceeded?: 'stdout' | 'stderr' | 'combined';
  }>;
}

export const DEFAULT_SANDBOX_POLICY: Readonly<
  Required<
    Pick<
      SandboxPolicy,
      | 'enabled'
      | 'mode'
      | 'prefer'
      | 'required'
      | 'allowHostUnsandboxedInstall'
      | 'projectWrite'
      | 'minimalPath'
      | 'strictLifecycleAllowlist'
      | 'allowDangerousGrants'
      | 'legacyFatRoot'
      | 'timeoutMs'
      | 'maximumStdoutBytes'
      | 'maximumStderrBytes'
      | 'maximumOutputBytes'
    >
  >
> = {
  enabled: true,
  mode: 'fail-closed',
  prefer: 'auto',
  required: true,
  allowHostUnsandboxedInstall: false,
  projectWrite: false,
  minimalPath: true,
  strictLifecycleAllowlist: true,
  allowDangerousGrants: false,
  legacyFatRoot: false,
  timeoutMs: 600_000,
  maximumStdoutBytes: 1024 * 1024,
  maximumStderrBytes: 1024 * 1024,
  maximumOutputBytes: 2 * 1024 * 1024,
};

/** Semantic loss codes from ADR 0036 / hardening contracts. */
export const SANDBOX_LOSS = {
  ENFORCED: 'SANDBOX_ENFORCED',
  BACKEND_MXC: 'SANDBOX_BACKEND_MXC',
  BACKEND_NATIVE: 'SANDBOX_BACKEND_NATIVE',
  UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  DEGRADED: 'SANDBOX_DEGRADED',
  /** Limited user-capability containment for host installers — not a full jail. */
  SYSTEM_LIMITED: 'SYSTEM_INSTALL_CONTAINMENT_LIMITED',
  SYSTEM_NOT_SANDBOXED: 'SYSTEM_INSTALL_NOT_SANDBOXED',
  /** @deprecated Prefer SYSTEM_LIMITED — kept for older readers. */
  SYSTEM_SANDBOXED: 'SYSTEM_INSTALL_SANDBOXED',
} as const;
