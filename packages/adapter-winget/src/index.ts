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
 * Windows applications, through the real `winget` CLI.
 *
 * winget owns installer execution, elevation prompts, the Windows Installer
 * database and per-user versus machine scope; none of that is worth
 * reimplementing. What PREX adds is one identity scheme across ecosystems and
 * an honest account of what an install can and cannot promise.
 *
 * Package identity is the winget package identifier — `Microsoft.PowerShell`,
 * `Git.Git` — which is stable and already the thing users name.
 */

const run = promisify(execFile);

const WINGET_LOSS: readonly SemanticLoss[] = [
  {
    code: 'SYSTEM_INSTALL_NOT_BYTE_VERIFIED',
    severity: 'warning',
    sourceEcosystem: 'winget',
    sourcePath: '/',
    originalMeaning:
      'winget verifies the installer hash recorded in its manifest and runs the vendor installer',
    representedMeaning:
      'OpenPacker did not hash the installed bytes and cannot attest to what the vendor installer did',
    blocksProfile: ['native-validated-v1'],
  },
  {
    code: 'SYSTEM_INSTALL_NOT_REVERSIBLE',
    severity: 'warning',
    sourceEcosystem: 'winget',
    sourcePath: '/',
    originalMeaning:
      'the change is recorded by Windows and is undone with winget uninstall',
    representedMeaning:
      'the generation ledger does not cover it; opm rollback will not undo a winget install',
    blocksProfile: [],
  },
];

/**
 * A winget package identifier, validated before reaching an argument vector.
 *
 * winget identifiers are dotted publisher/package pairs. Anchoring on that
 * grammar is what keeps an identifier from ever resembling an option.
 */
function wingetId(exactPurl: string): { id: string; version?: string } {
  const parsed = parsePurl(exactPurl);
  if (parsed.type !== 'winget')
    throw new ProviderError(
      'INVALID_PURL',
      `Not a winget PURL: ${exactPurl} (expected pkg:winget/...)`,
    );
  const id = [parsed.namespace, parsed.name]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(id) || id.includes('..'))
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid winget package identifier: ${id}`,
    );
  if (
    parsed.version !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(parsed.version)
  )
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid winget version: ${parsed.version}`,
    );
  return {
    id,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
  };
}

export class WingetSystemProvider implements InstallerProvider {
  readonly providerId = 'winget-system';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'install'],
    purlTypes: ['winget'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/system-installer': 'winget' },
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
  ) {}

  async available(signal?: AbortSignal): Promise<InstallerAvailability> {
    if (this.currentPlatform() !== 'win32')
      return {
        available: false,
        reason: `winget is Windows-only; this host is ${this.currentPlatform()}`,
      };
    try {
      const { stdout } = await this.execute(
        'winget',
        ['--version'],
        signal ? { signal } : {},
      );
      const version = /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/u.exec(stdout)?.[1];
      return {
        available: true,
        tool: { name: 'winget', ...(version ? { version } : {}) },
      };
    } catch {
      return { available: false, reason: 'winget is not on PATH' };
    }
  }

  /** Published versions, newest last, as `winget show --versions` reports. */
  async versions(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const { id } = wingetId(exactPurl);
    const { stdout } = await this.execute(
      'winget',
      ['show', '--id', id, '--exact', '--versions', '--disable-interactivity'],
      signal ? { signal } : {},
    );
    // winget prints a table; version rows are the lines that look like one.
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^[0-9][A-Za-z0-9._+-]*$/u.test(line))
      .reverse();
  }

  async plan(
    exactPurl: string,
    options: InstallOptions = {},
  ): Promise<InstallPlan> {
    const { id, version } = wingetId(exactPurl);
    const summary = planSandboxSummary(options.sandbox);
    return {
      exactPurl,
      command: [
        'winget',
        'install',
        '--id',
        id,
        '--exact',
        ...(version === undefined ? [] : ['--version', version]),
        // Consent to the vendor's licence terms is required for a
        // non-interactive install and is the user's to give, so it is stated
        // in the command they are shown rather than hidden in a flag list.
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
        // Per-user scope when the package supports it, so an install does not
        // demand administrator rights it does not need.
        '--scope',
        options.allowElevation === true ? 'machine' : 'user',
      ],
      // A machine-scope install needs administrator rights; a user-scope one
      // usually does not, and claiming otherwise would ask for elevation that
      // is not required.
      requiresElevation: options.allowElevation === true,
      irreversible: true,
      semanticLoss: WINGET_LOSS,
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
        `winget cannot run here: ${availability.reason}`,
      );
    if (options.dryRun)
      return { ...plan, performed: false, exitCode: 0, stdout: '', stderr: '' };

    try {
      const result = await runHostInstaller({
        argv: plan.command,
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.offline === undefined ? {} : { offline: options.offline }),
        ecosystem: 'winget',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return {
        ...plan,
        performed: true,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        sandboxEnforced: result.sandboxEnforced,
        sandboxBackend: result.sandboxBackend,
        semanticLoss: [...plan.semanticLoss, ...result.extraLosses],
      };
    } catch (error) {
      if (error instanceof HostInstallerSandboxError)
        throw new ProviderError('POLICY_DENIED', error.message);
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

  /** The canonical PURL for a winget identifier. */
  canonicalPurl(id: string, version?: string): string {
    const [publisher, ...rest] = id.split('.');
    if (!publisher || rest.length === 0)
      throw new ProviderError(
        'INVALID_PURL',
        `A winget identifier is Publisher.Package: ${id}`,
      );
    return formatPurl({
      type: 'winget',
      namespace: publisher,
      name: rest.join('.'),
      qualifiers: {},
      ...(version === undefined ? {} : { version }),
    });
  }
}
