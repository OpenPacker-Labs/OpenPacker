import type { SemanticLoss } from '@openpacker/contracts';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { runInSandbox } from './run.js';
import { SANDBOX_LOSS, type SandboxPolicy } from './types.js';
import { loss } from './policy.js';

export interface HostInstallerSandboxOptions {
  mode?: 'fail-closed' | 'degrade-warn' | 'off';
  prefer?: 'auto' | 'mxc' | 'native';
  /** @deprecated Host installers always refuse ambient execution. */
  allowHostUnsandboxedInstall?: boolean;
}

/** Resolve a host installer without executing PATH-controlled code. */
export async function findHostExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32' && extname(name) === ''
      ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const directory of trustedHostDirectories(environment)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        const [trustedDirectory, resolved] = await Promise.all([
          realpath(directory),
          realpath(candidate),
        ]);
        const inside = relative(trustedDirectory, resolved);
        if (inside.startsWith('..') || isAbsolute(inside)) continue;
        const info = await stat(resolved);
        if (!info.isFile()) continue;
        if (
          process.platform !== 'win32' &&
          (info.uid !== 0 || (info.mode & 0o022) !== 0)
        )
          continue;
        return resolved;
      } catch {
        // Continue through fixed host locations without running anything.
      }
    }
  }
  return undefined;
}

function trustedHostDirectories(environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32')
    return [
      '/usr/bin',
      '/usr/sbin',
      '/bin',
      '/sbin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/nix/var/nix/profiles/default/bin',
    ];
  return [
    environment.SystemRoot && join(environment.SystemRoot, 'System32'),
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.ProgramData &&
      join(environment.ProgramData, 'chocolatey', 'bin'),
    environment.LOCALAPPDATA &&
      join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps'),
  ].filter((value): value is string => typeof value === 'string');
}

export function sandboxPolicyFromInstallOptions(
  sandbox?: HostInstallerSandboxOptions,
): SandboxPolicy {
  if (
    sandbox?.allowHostUnsandboxedInstall === true ||
    (sandbox?.mode !== undefined && sandbox.mode !== 'fail-closed')
  )
    throw new HostInstallerSandboxError(
      'Host installers require fail-closed containment; ambient and degraded execution are disabled',
    );
  const mode = sandbox?.mode ?? 'fail-closed';
  return {
    mode,
    prefer: sandbox?.prefer ?? 'auto',
    allowHostUnsandboxedInstall: sandbox?.allowHostUnsandboxedInstall ?? false,
    required: true,
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
  return {
    mode: policy.mode ?? 'fail-closed',
    prefer: policy.prefer ?? 'auto',
    willEnforce: true,
    allowAmbient: false,
  };
}

export async function runHostInstaller(
  input: HostInstallerRunInput,
): Promise<HostInstallerRunResult> {
  const summary = planSandboxSummary(input.sandbox);
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

  // host-install never sets enforced true; backend availability is the check.
  if (outcome.backend === 'none') {
    throw new HostInstallerSandboxError(
      'Install requires an OS-owned sandbox backend and none is available',
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
