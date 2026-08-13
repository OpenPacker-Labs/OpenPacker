import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import {
  ProviderError,
  formatPurl,
  parsePurl,
  type InstallOptions,
  type InstallOutcome,
  type InstallPlan,
  type InstallerAvailability,
  type InstallerProvider,
  type ProviderCapabilities,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import {
  HostInstallerSandboxError,
  planSandboxSummary,
  runHostInstaller,
} from '@openpacker/sandbox';

/**
 * Debian and Ubuntu system packages, through the real `apt-get` and `dpkg`.
 *
 * This is a system package manager plugging into PREX rather than being
 * reimplemented by it. `apt` owns dependency resolution, maintainer scripts,
 * triggers, alternatives and the dpkg database; none of that is worth
 * reproducing, and a reimplementation would be wrong in ways that only show up
 * on someone's machine.
 *
 * What PREX contributes is the part apt does not do: one identity scheme
 * across ecosystems, an explicit statement of what the install can and cannot
 * promise, and a receipt of what was actually run.
 */

const run = promisify(execFile);

const APT_LOSS: readonly SemanticLoss[] = [
  {
    code: 'SYSTEM_INSTALL_NOT_BYTE_VERIFIED',
    severity: 'warning',
    sourceEcosystem: 'deb',
    sourcePath: '/',
    originalMeaning:
      'apt verifies packages against the archive signing keys configured on this host and runs maintainer scripts as root',
    representedMeaning:
      'OpenPacker did not hash the installed bytes and cannot attest to what the maintainer scripts did',
    blocksProfile: ['native-validated-v1'],
  },
  {
    code: 'SYSTEM_INSTALL_NOT_REVERSIBLE',
    severity: 'warning',
    sourceEcosystem: 'deb',
    sourcePath: '/',
    originalMeaning:
      'the change is recorded in the dpkg database and is undone with apt-get remove',
    representedMeaning:
      'the generation ledger does not cover it; opm rollback will not undo a system install',
    blocksProfile: [],
  },
];

/** `pkg:deb/debian/curl@7.88.1` → the name apt knows. */
function aptName(exactPurl: string): { name: string; version?: string } {
  const parsed = parsePurl(exactPurl);
  if (parsed.type !== 'deb')
    throw new ProviderError(
      'INVALID_PURL',
      `Not a Debian PURL: ${exactPurl} (expected pkg:deb/...)`,
    );
  // Debian binary package names are tightly constrained; anything else is not
  // a package name and must not reach a shell argument list.
  if (!/^[a-z0-9][a-z0-9+.-]+$/u.test(parsed.name))
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid Debian package name: ${parsed.name}`,
    );
  // Debian policy requires a version to begin with a digit (after an optional
  // numeric epoch). Anchoring on that is what keeps a version from ever
  // looking like an option, however it is later concatenated.
  if (
    parsed.version !== undefined &&
    !/^(?:[0-9]+:)?[0-9][A-Za-z0-9+.~:-]*$/u.test(parsed.version)
  )
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid Debian version: ${parsed.version}`,
    );
  return {
    name: parsed.name,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
  };
}

export class AptSystemProvider implements InstallerProvider {
  readonly providerId = 'apt-system';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'install'],
    purlTypes: ['deb'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/system-installer': 'apt-get' },
  };

  constructor(
    private readonly execute: (
      file: string,
      args: readonly string[],
      options?: { signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string }> = (file, args, options) =>
      run(file, [...args], {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxBuffer: 8 * 1024 * 1024,
      }),
    private readonly currentPlatform: () => string = platform,
    private readonly isRoot: () => boolean = () => process.getuid?.() === 0,
  ) {}

  async available(signal?: AbortSignal): Promise<InstallerAvailability> {
    if (this.currentPlatform() !== 'linux')
      return {
        available: false,
        reason: `apt is Linux-only; this host is ${this.currentPlatform()}`,
      };
    try {
      const { stdout } = await this.execute(
        'apt-get',
        ['--version'],
        signal ? { signal } : {},
      );
      const version = /apt\s+(\S+)/u.exec(stdout)?.[1];
      return {
        available: true,
        tool: { name: 'apt-get', ...(version ? { version } : {}) },
      };
    } catch {
      return { available: false, reason: 'apt-get is not on PATH' };
    }
  }

  /** Candidate and installed versions, as apt reports them. */
  async versions(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ candidate?: string; installed?: string }> {
    const { stdout } = await this.execute(
      'apt-cache',
      ['policy', aptName(`pkg:deb/${name}`).name],
      signal ? { signal } : {},
    );
    const candidate = /Candidate:\s*(\S+)/u.exec(stdout)?.[1];
    const installed = /Installed:\s*(\S+)/u.exec(stdout)?.[1];
    return {
      ...(candidate && candidate !== '(none)' ? { candidate } : {}),
      ...(installed && installed !== '(none)' ? { installed } : {}),
    };
  }

  async plan(
    exactPurl: string,
    options: InstallOptions = {},
  ): Promise<InstallPlan> {
    const { name, version } = aptName(exactPurl);
    // A pinned version is passed as apt's own name=version form rather than
    // interpolated anywhere a shell could see it; execFile takes an argv.
    const target = version === undefined ? name : `${name}=${version}`;
    const command = [
      ...(this.isRoot() ? [] : ['sudo']),
      'apt-get',
      'install',
      '--yes',
      ...(options.offline ? ['--no-download'] : []),
      target,
    ];
    const summary = planSandboxSummary(options.sandbox);
    return {
      exactPurl,
      command,
      requiresElevation: !this.isRoot(),
      irreversible: true,
      semanticLoss: APT_LOSS,
      sandbox: {
        mode: summary.mode,
        prefer: summary.prefer,
        willEnforce: summary.willEnforce,
      },
    };
  }

  async install(
    exactPurl: string,
    options: InstallOptions = {},
  ): Promise<InstallOutcome> {
    const plan = await this.plan(exactPurl, options);
    const availability = await this.available(options.signal);
    if (!availability.available)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `apt cannot run here: ${availability.reason}`,
      );
    if (options.dryRun)
      return { ...plan, performed: false, exitCode: 0, stdout: '', stderr: '' };
    // Elevation is consented to, never assumed. A PURL naming a system package
    // is not authorization to change the machine.
    if (plan.requiresElevation && !options.allowElevation)
      throw new ProviderError(
        'POLICY_DENIED',
        `Installing ${exactPurl} needs root. Re-run with elevation allowed; ` +
          `the command would be: ${plan.command.join(' ')}`,
      );

    try {
      const result = await runHostInstaller({
        argv: plan.command,
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.offline === undefined ? { offline: options.offline } : {}),
        ecosystem: 'deb',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ambientExecute: async () => {
          const [file, ...args] = plan.command;
          return this.execute(
            file!,
            args,
            options.signal ? { signal: options.signal } : {},
          );
        },
      });
      const { installed } = await this.versions(
        aptName(exactPurl).name,
        options.signal,
      ).catch(() => ({ installed: undefined }));
      return {
        ...plan,
        performed: true,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        sandboxEnforced: result.sandboxEnforced,
        sandboxBackend: result.sandboxBackend,
        semanticLoss: [...plan.semanticLoss, ...result.extraLosses],
        ...(installed ? { installedVersion: installed } : {}),
      };
    } catch (error) {
      if (error instanceof HostInstallerSandboxError)
        throw new ProviderError('POLICY_DENIED', error.message);
      if (error instanceof ProviderError) throw error;
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        ...plan,
        performed: true,
        exitCode: failure.code ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String(error),
      };
    }
  }

  /** The canonical PURL for a Debian package name. */
  canonicalPurl(name: string, version?: string): string {
    return formatPurl({
      type: 'deb',
      name: aptName(`pkg:deb/${name}`).name,
      qualifiers: {},
      ...(version === undefined ? {} : { version }),
    });
  }
}
