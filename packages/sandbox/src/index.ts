/**
 * @openpacker/sandbox — single funnel for package install/execution jails.
 *
 * See ADR 0036. Prefer MXC; fall back to native jails; fail closed by default.
 */

export {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_LOSS,
  type BackendProbe,
  type PackageGrants,
  type RunInSandboxInput,
  type SandboxBackend,
  type SandboxBackendId,
  type SandboxMode,
  type SandboxOutcome,
  type SandboxPolicy,
  type SandboxPrefer,
  type SandboxProfile,
} from './types.js';

export {
  assertGrantsNotDangerous,
  assertPathNotRootOrHome,
  backendLosses,
  digestSandboxPolicy,
  loss,
  matchPackageGrant,
  mergeGrants,
  resolvePolicy,
} from './policy.js';

export { packageExecRoRoots } from './backends/native.js';

export {
  containmentWithdrawnNote,
  executableAuthorityRefusal,
} from './platform.js';

export { minimalPathValue } from './env.js';

export {
  isAllowlistedEnv,
  isDeniedCredential,
  scrubEnvironment,
  defaultJailHomeRoot,
} from './env.js';

export {
  assertSafeJailPath,
  isPathInside,
  JailPathError,
  normalizeJailPaths,
  networkToolMaskFiles,
  sensitiveMaskDirectories,
  sensitiveMaskFiles,
} from './paths.js';

export {
  createMockBackend,
  SandboxBackendError,
  spawnCapture,
} from './backends/mock.js';

export {
  buildBwrapArgv,
  buildSeatbeltProfile,
  createBwrapBackend,
  createNativeBackend,
  createSeatbeltBackend,
  findTrustedSandboxHelper,
  probeNativeBackends,
  reopenExecutableAuthority,
} from './backends/native.js';

export {
  createMxcBackend,
  mxcFilesystemPaths,
  probeMxc,
  quoteCommandLine,
} from './backends/mxc.js';

export { probeBackends, resolveBackend, runInSandbox } from './run.js';

export {
  HostInstallerSandboxError,
  limitedContainmentLoss,
  notSandboxedLoss,
  planSandboxSummary,
  findHostExecutable,
  runHostInstaller,
  sandboxPolicyFromInstallOptions,
  sandboxedSystemLoss,
  type HostInstallerRunInput,
  type HostInstallerRunResult,
  type HostInstallerSandboxOptions,
} from './host-install.js';
