import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import {
  ProviderError,
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
  findHostExecutable,
  planSandboxSummary,
  runHostInstaller,
} from '@openpacker/sandbox';

/**
 * Chocolatey packages through the real `choco` CLI.
 *
 * Peer of winget/apt: host mutation via a native tool, not a reimplementation.
 * Identity is the Chocolatey package id; elevation is consented, never assumed.
 */

const run = promisify(execFile);

const CHOCO_LOSS: readonly SemanticLoss[] = [
  {
    code: 'SYSTEM_INSTALL_NOT_BYTE_VERIFIED',
    severity: 'warning',
    sourceEcosystem: 'chocolatey',
    sourcePath: '/',
    originalMeaning:
      'Chocolatey installs vendor packages and may run install scripts',
    representedMeaning:
      'OpenPacker records the choco command; it does not establish PREX byte identity',
    blocksProfile: ['native-validated-v1'],
  },
  {
    code: 'SYSTEM_INSTALL_NOT_REVERSIBLE',
    severity: 'warning',
    sourceEcosystem: 'chocolatey',
    sourcePath: '/',
    originalMeaning: 'choco uninstall is not a full host snapshot restore',
    representedMeaning:
      'Project generation rollback does not undo a Chocolatey install',
    blocksProfile: [],
  },
];

function chocolateyId(exactPurl: string) {
  const parsed = parsePurl(exactPurl);
  if (parsed.type !== 'chocolatey')
    throw new ProviderError(
      'INVALID_PURL',
      `Not a chocolatey PURL: ${exactPurl}`,
    );
  const id = [parsed.namespace, parsed.name].filter(Boolean).join('.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    throw new ProviderError(
      'INVALID_PURL',
      `Not a valid Chocolatey package id: ${id}`,
    );
  return {
    id,
    ...(!(parsed.version === undefined) && { version: parsed.version }),
  };
}

export class ChocolateyProvider implements InstallerProvider {
  readonly providerId = 'chocolatey-system';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'install'],
    purlTypes: ['chocolatey'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/system-installer': 'chocolatey' },
  };

  constructor(
    private readonly execute: (
      file: string,
      args: readonly string[],
      options?: { signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string }> = (file, args, options) =>
      run(file, [...args], {
        ...(options?.signal && { signal: options.signal }),
        maxBuffer: 8 * 1024 * 1024,
      }),
    private readonly currentPlatform: () => string = platform,
    private readonly findExecutable: (
      name: string,
    ) => Promise<string | undefined> = findHostExecutable,
  ) {}

  async available(_signal?: AbortSignal): Promise<InstallerAvailability> {
    if (this.currentPlatform() !== 'win32')
      return {
        available: false,
        reason: `chocolatey is Windows-oriented; this host is ${this.currentPlatform()}`,
      };
    const path = await this.findExecutable('choco');
    return path
      ? { available: true, tool: { name: 'choco', path } }
      : { available: false, reason: 'choco is not on PATH' };
  }

  async plan(
    exactPurl: string,
    options: InstallOptions = {},
  ): Promise<InstallPlan> {
    const { id, version } = chocolateyId(exactPurl);
    const summary = planSandboxSummary(options.sandbox);
    const command = [
      'choco',
      'install',
      id,
      '-y',
      ...(version === undefined ? [] : ['--version', version]),
      ...(options.offline ? ['--offline'] : []),
    ];
    return {
      exactPurl,
      command,
      requiresElevation: true,
      irreversible: true,
      semanticLoss: CHOCO_LOSS,
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
    if (options.dryRun)
      return { ...plan, performed: false, exitCode: 0, stdout: '', stderr: '' };
    if (plan.requiresElevation && !options.allowElevation)
      throw new ProviderError(
        'POLICY_DENIED',
        `Installing ${exactPurl} needs elevation. Re-run with elevation allowed; ` +
          `the command would be: ${plan.command.join(' ')}`,
      );
    const availability = await this.available(options.signal);
    if (!availability.available)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `chocolatey cannot run here: ${availability.reason}`,
      );
    const executable = availability.tool?.path;
    if (!executable)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        'choco did not resolve to an executable path',
      );
    const executionPlan: InstallPlan = {
      ...plan,
      command: [executable, ...plan.command.slice(1)],
    };
    try {
      const result = await runHostInstaller({
        argv: executionPlan.command,
        ...(!(options.sandbox === undefined) && { sandbox: options.sandbox }),
        ...(!(options.offline === undefined) && { offline: options.offline }),
        ecosystem: 'chocolatey',
        ...(!(options.signal === undefined) && { signal: options.signal }),
      });
      return {
        ...executionPlan,
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
}
