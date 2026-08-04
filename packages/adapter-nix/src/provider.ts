import { execFile } from 'node:child_process';
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
import { NixCodec } from './index.js';

/**
 * Nix, driven through the real `nix` CLI.
 *
 * Nix does not have versions the way a registry does. A package is an
 * attribute in a flake, and what pins it is the flake reference — so there is
 * no version list to enumerate, and pretending otherwise would invent an
 * ordering Nix does not have. `enumerate` therefore refuses rather than
 * guessing, and identity comes from the store path hash, which already names
 * exact bytes.
 *
 * Dependencies come from the store closure Nix computes itself
 * (`--recursive`), not from a solve. Nix has already done the resolution; the
 * useful thing PREX adds is one identity scheme and an honest record, not a
 * second opinion about what depends on what.
 */

const run = promisify(execFile);

const NIX_LOSS: readonly SemanticLoss[] = [
  {
    code: 'NIX_RESOLUTION_DELEGATED',
    severity: 'info',
    sourceEcosystem: 'nix',
    sourcePath: '/',
    originalMeaning:
      'Nix evaluated the flake and computed the closure with its own resolver',
    representedMeaning:
      'OpenPacker records what Nix decided; it did not solve the graph itself',
    blocksProfile: [],
  },
  {
    code: 'NIX_EXPRESSION_NOT_EVALUATED',
    severity: 'warning',
    sourceEcosystem: 'nix',
    sourcePath: '/',
    originalMeaning:
      'the derivation is produced by evaluating a Nix expression',
    representedMeaning:
      'OpenPacker did not evaluate the expression; it read the result Nix produced',
    blocksProfile: ['native-validated-v1'],
  },
];

/** A flake installable, checked before it reaches an argument vector. */
function assertInstallable(value: string): string {
  // Deliberately narrow: flake refs and attribute paths, nothing that could be
  // read as an option or reach a shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/#:+-]*$/u.test(value) || value.includes('..'))
    throw new ProviderError(
      'INVALID_PURL',
      `Not a usable Nix installable: ${value}`,
    );
  return value;
}

/**
 * Resolve a PURL or raw flake installable into a Nix installable string.
 *
 * - `nixpkgs#hello` passes through
 * - `pkg:nix/hello` becomes `nixpkgs#hello` (default flake)
 * - `pkg:nix/hello?flake=nixpkgs/nixos-24.05` becomes `nixpkgs/nixos-24.05#hello`
 * - `pkg:nix/x?installable=github:NixOS/nixpkgs#hello` uses that installable
 */
export function installableFromPurl(value: string): string {
  if (!value.startsWith('pkg:')) return assertInstallable(value);
  let parsed: ReturnType<typeof parsePurl>;
  try {
    parsed = parsePurl(value);
  } catch {
    throw new ProviderError('INVALID_PURL', `Not a usable Nix PURL: ${value}`);
  }
  if (parsed.type !== 'nix')
    throw new ProviderError(
      'INVALID_PURL',
      `Not a nix PURL: ${value} (expected pkg:nix/...)`,
    );
  const installable = parsed.qualifiers.installable;
  if (installable !== undefined && installable !== '')
    return assertInstallable(installable);
  const attribute = parsed.name;
  if (!attribute)
    throw new ProviderError(
      'INVALID_PURL',
      `nix PURL needs a package name: ${value}`,
    );
  const flake = parsed.qualifiers.flake || 'nixpkgs';
  return assertInstallable(`${flake}#${attribute}`);
}

export class NixStoreProvider implements InstallerProvider {
  readonly providerId = 'nix-store';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'inspect', 'install'],
    purlTypes: ['nix'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/system-installer': 'nix' },
  };

  constructor(
    private readonly execute: (
      file: string,
      args: readonly string[],
      options?: { signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string }> = (file, args, options) =>
      run(file, [...args], {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxBuffer: 64 * 1024 * 1024,
      }),
    private readonly codec = new NixCodec(),
  ) {}

  async available(signal?: AbortSignal): Promise<InstallerAvailability> {
    try {
      const { stdout } = await this.execute(
        'nix',
        ['--version'],
        signal ? { signal } : {},
      );
      const version = /nix.*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/u.exec(stdout)?.[1];
      return {
        available: true,
        tool: { name: 'nix', ...(version ? { version } : {}) },
      };
    } catch {
      return { available: false, reason: 'nix is not on PATH' };
    }
  }

  /** Attributes matching a query, as `nix search` reports them. */
  async search(
    query: string,
    flake = 'nixpkgs',
    signal?: AbortSignal,
  ): Promise<{ attribute: string; version?: string; description?: string }[]> {
    const { stdout } = await this.execute(
      'nix',
      [
        'search',
        assertInstallable(flake),
        assertInstallable(query),
        '--json',
        '--extra-experimental-features',
        'nix-command flakes',
      ],
      signal ? { signal } : {},
    );
    const parsed = JSON.parse(stdout) as Record<
      string,
      { version?: string; description?: string }
    >;
    return Object.entries(parsed).map(([attribute, value]) => ({
      attribute,
      ...(value.version ? { version: value.version } : {}),
      ...(value.description ? { description: value.description } : {}),
    }));
  }

  /**
   * The store paths an installable resolves to, and its runtime closure.
   *
   * Realisation runs first: `path-info` on a flake installable that is not
   * yet in the store fails with "path is not valid" on some Nix versions /
   * portable runtimes. Building with `--no-link` puts the output in the store
   * without touching a profile; path-info then records the closure Nix already
   * computed.
   */
  async closure(
    installable: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; references: string[]; narSize?: number }[]> {
    const target = installableFromPurl(installable);
    const opts = signal ? { signal } : {};
    // Realise into the store (idempotent when already present).
    await this.execute(
      'nix',
      [
        'build',
        target,
        '--no-link',
        '--extra-experimental-features',
        'nix-command flakes',
      ],
      opts,
    );
    const { stdout } = await this.execute(
      'nix',
      [
        'path-info',
        target,
        '--json',
        '--recursive',
        '--extra-experimental-features',
        'nix-command flakes',
      ],
      opts,
    );
    const parsed = JSON.parse(stdout) as
      | Record<string, { references?: string[]; narSize?: number }>
      | { path: string; references?: string[]; narSize?: number }[];
    // Nix 2.19 returns an object keyed by store path; older versions an array.
    const entries = Array.isArray(parsed)
      ? parsed.map((item) => [item.path, item] as const)
      : Object.entries(parsed);
    return entries.map(([path, value]) => ({
      path,
      references: value?.references ?? [],
      ...(value?.narSize === undefined ? {} : { narSize: value.narSize }),
    }));
  }

  /** PREX instances for an installable (or PURL) and everything it needs. */
  async resolve(
    installable: string,
    signal?: AbortSignal,
  ): Promise<{ instances: unknown[]; semanticLoss: readonly SemanticLoss[] }> {
    const paths = await this.closure(installable, signal);
    const provenance = {
      providerId: this.providerId,
      endpoint: 'nix-store:local',
      retrievedAt: new Date().toISOString(),
      evaluationTime: new Date().toISOString(),
      metadataDigest: { algorithm: 'sha256' as const, value: '0'.repeat(64) },
    };
    const instances = [];
    for (const entry of paths) {
      const { instance } = await this.codec.translateMetadata(
        {
          path: entry.path,
          references: entry.references,
          ...(entry.narSize === undefined ? {} : { narSize: entry.narSize }),
        },
        provenance,
      );
      instances.push(instance);
    }
    return { instances, semanticLoss: NIX_LOSS };
  }

  async plan(
    exactPurl: string,
    _options: InstallOptions = {},
  ): Promise<InstallPlan> {
    const target = installableFromPurl(exactPurl);
    return {
      exactPurl,
      command: [
        'nix',
        'profile',
        'install',
        target,
        '--extra-experimental-features',
        'nix-command flakes',
      ],
      // Nix installs into a per-user profile, so no elevation is needed — one
      // of the reasons it is a better citizen here than apt.
      requiresElevation: false,
      // A nix profile install is undone with `nix profile remove`, and the
      // generation ledger does not cover it either way.
      irreversible: false,
      semanticLoss: NIX_LOSS,
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
        `nix cannot run here: ${availability.reason}`,
      );
    if (options.dryRun)
      return { ...plan, performed: false, exitCode: 0, stdout: '', stderr: '' };
    const [file, ...args] = plan.command;
    try {
      const { stdout, stderr } = await this.execute(
        file!,
        args,
        options.signal ? { signal: options.signal } : {},
      );
      return { ...plan, performed: true, exitCode: 0, stdout, stderr };
    } catch (error) {
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

  /**
   * Nix has no version list to enumerate.
   *
   * What pins a Nix package is the flake reference, not a version chosen from
   * a published set. Returning something here would invent an ordering Nix
   * does not have, so this says why instead.
   */
  async enumerate(): Promise<never> {
    throw new ProviderError(
      'UNSUPPORTED_OPERATION',
      'Nix has no published version list: a package is an attribute in a flake, ' +
        'and the flake reference is what pins it. Use a flake ref such as ' +
        'nixpkgs/nixos-24.05#jq.',
    );
  }
}
