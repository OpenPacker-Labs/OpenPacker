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
} from './types.js';

export {
  backendLosses,
  digestSandboxPolicy,
  loss,
  matchPackageGrant,
  mergeGrants,
  resolvePolicy,
} from './policy.js';

export {
  isAllowlistedEnv,
  isDeniedCredential,
  scrubEnvironment,
  defaultJailHomeRoot,
} from './env.js';

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
  probeNativeBackends,
} from './backends/native.js';

export { createMxcBackend, probeMxc } from './backends/mxc.js';

export { probeBackends, resolveBackend, runInSandbox } from './run.js';
