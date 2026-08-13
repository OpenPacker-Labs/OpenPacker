import type { SemanticLoss } from '@openpacker/contracts';
import { runInSandbox } from './run.js';
import { SANDBOX_LOSS, type SandboxPolicy } from './types.js';
import { loss } from './policy.js';

export interface HostInstallerSandboxOptions {
  mode?: 'fail-closed' | 'degrade-warn' | 'off';
  prefer?: 'auto' | 'mxc' | 'native';
  allowHostUnsandboxedInstall?: boolean;
}

export function sandboxPolicyFromInstallOptions(
  sandbox?: HostInstallerSandboxOptions,
): SandboxPolicy {
  const mode = sandbox?.mode ?? 'fail-closed';
  return {
    mode,
    prefer: sandbox?.prefer ?? 'auto',
    allowHostUnsandboxedInstall: sandbox?.allowHostUnsandboxedInstall ?? false,
    required: mode === 'fail-closed',
    // Host installers need broader FS; never claim package-exec strength.
    minimalPath: false,
    projectWrite: true,
    legacyFatRoot: true,
  };
}

export function notSandboxedLoss(_ecosystem: string): SemanticLoss {
  return loss(
    SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED,
    'warning',
    'the install ran with ambient host privileges',
    'OpenPacker did not enforce a jail; allowHostUnsandboxedInstall was set',
    ['native-validated-v1'],
  );
}

export function limitedContainmentLoss(_ecosystem: string): SemanticLoss {
  return loss(
    SANDBOX_LOSS.SYSTEM_LIMITED,
    'warning',
    'host installer ran under a user-capability jail only',
    'not root isolation; the process can still mutate anything the user can',
    ['native-validated-v1'],
  );
}

/** @deprecated use limitedContainmentLoss */
export function sandboxedSystemLoss(ecosystem: string): SemanticLoss {
  return limitedContainmentLoss(ecosystem);
}

export interface HostInstallerRunInput {
  argv: readonly string[];
  cwd?: string;
  sandbox?: HostInstallerSandboxOptions;
  offline?: boolean;
  signal?: AbortSignal;
  ecosystem: string;
  ambientExecute: () => Promise<{
    stdout: string;
    stderr: string;
    exitCode?: number;
  }>;
}

export interface HostInstallerRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxEnforced: boolean;
  sandboxBackend: string;
  containmentLimited: boolean;
  profile: 'host-install' | 'ambient';
  extraLosses: SemanticLoss[];
  willEnforce: boolean;
}

export function planSandboxSummary(sandbox?: HostInstallerSandboxOptions): {
  mode: 'fail-closed' | 'degrade-warn' | 'off';
  prefer: 'auto' | 'mxc' | 'native';
  willEnforce: boolean;
  allowAmbient: boolean;
} {
  const policy = sandboxPolicyFromInstallOptions(sandbox);
  const allowAmbient =
    policy.allowHostUnsandboxedInstall === true || policy.mode === 'off';
  return {
    mode: policy.mode ?? 'fail-closed',
    prefer: policy.prefer ?? 'auto',
    willEnforce: !allowAmbient,
    allowAmbient,
  };
}

export async function runHostInstaller(
  input: HostInstallerRunInput,
): Promise<HostInstallerRunResult> {
  const summary = planSandboxSummary(input.sandbox);
  if (summary.allowAmbient) {
    try {
      const result = await input.ambientExecute();
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        sandboxEnforced: false,
        sandboxBackend: 'off',
        containmentLimited: true,
        profile: 'ambient',
        extraLosses: [notSandboxedLoss(input.ecosystem)],
        willEnforce: false,
      };
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message ?? String(error),
        exitCode: failure.code ?? 1,
        sandboxEnforced: false,
        sandboxBackend: 'off',
        containmentLimited: true,
        profile: 'ambient',
        extraLosses: [notSandboxedLoss(input.ecosystem)],
        willEnforce: false,
      };
    }
  }

  const policy = sandboxPolicyFromInstallOptions(input.sandbox);
  const [file, ...args] = input.argv;
  if (!file) {
    return {
      stdout: '',
      stderr: 'host installer argv is empty',
      exitCode: 1,
      sandboxEnforced: false,
      sandboxBackend: 'none',
      containmentLimited: true,
      profile: 'host-install',
      extraLosses: [],
      willEnforce: true,
    };
  }

  const outcome = await runInSandbox({
    argv: [file, ...args],
    cwd: input.cwd ?? process.cwd(),
    policy,
    profile: 'host-install',
    // Broad user-visible FS — limited containment only.
    readwritePaths: ['/'],
    readonlyPaths: [],
    network: !input.offline,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (!outcome.enforced && outcome.backend === 'none') {
    // host-install never sets enforced true; check backend for availability
  }
  if (outcome.backend === 'none') {
    throw new HostInstallerSandboxError(
      `Install requires a sandbox backend and none is available. ` +
        `Set sandbox.allowHostUnsandboxedInstall to run ambient ` +
        `(records ${SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED}).`,
    );
  }

  return {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    // Honesty: host-install is never fully "enforced" package-exec style.
    sandboxEnforced: false,
    sandboxBackend: outcome.backend,
    containmentLimited: true,
    profile: 'host-install',
    extraLosses: outcome.losses.some(
      (loss) => loss.code === SANDBOX_LOSS.SYSTEM_LIMITED,
    )
      ? [...outcome.losses]
      : [limitedContainmentLoss(input.ecosystem), ...outcome.losses],
    willEnforce: true,
  };
}

export class HostInstallerSandboxError extends Error {
  readonly code = 'POLICY_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'HostInstallerSandboxError';
  }
}
