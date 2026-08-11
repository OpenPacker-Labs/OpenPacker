import type { SemanticLoss } from '@openpacker/contracts';
import { runInSandbox } from './run.js';
import { SANDBOX_LOSS, type SandboxPolicy } from './types.js';
import { loss } from './policy.js';

/** InstallOptions.sandbox shape from adapter-core (kept structural). */
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
  };
}

export function notSandboxedLoss(ecosystem: string): SemanticLoss {
  return loss(
    SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED,
    'warning',
    'the install ran with ambient host privileges',
    'OpenPacker did not enforce a jail; allowHostUnsandboxedInstall was set',
    ['native-validated-v1'],
  );
}

export function sandboxedSystemLoss(ecosystem: string): SemanticLoss {
  return loss(
    SANDBOX_LOSS.SYSTEM_SANDBOXED,
    'info',
    'the install process ran inside a containment backend',
    `argv was launched via runInSandbox for ${ecosystem}`,
    [],
  );
}

export interface HostInstallerRunInput {
  argv: readonly string[];
  cwd?: string;
  sandbox?: HostInstallerSandboxOptions;
  offline?: boolean;
  signal?: AbortSignal;
  ecosystem: string;
  /**
   * Ambient execute path used when unsandboxed is allowed (also the unit-test
   * injection point for adapters).
   */
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
  extraLosses: SemanticLoss[];
  /** Plan-time sandbox summary. */
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

/**
 * Run a host installer argv under the sandbox funnel, or ambient when
 * explicitly allowed.
 */
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
      extraLosses: [],
      willEnforce: true,
    };
  }

  const outcome = await runInSandbox({
    argv: [file, ...args],
    cwd: input.cwd ?? process.cwd(),
    policy,
    readwritePaths: ['/'],
    readonlyPaths: [],
    network: !input.offline,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (!outcome.enforced && outcome.backend === 'none') {
    throw new HostInstallerSandboxError(
      `Install requires a sandbox jail and none is available. ` +
        `Set sandbox.allowHostUnsandboxedInstall to run ambient ` +
        `(records ${SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED}).`,
    );
  }

  return {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    sandboxEnforced: outcome.enforced,
    sandboxBackend: outcome.backend,
    extraLosses: [
      ...(outcome.enforced ? [sandboxedSystemLoss(input.ecosystem)] : []),
      ...outcome.losses,
    ],
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
