import { createHash } from 'node:crypto';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ProviderError,
  formatPurl,
  type DetectedProject,
  type PackAvailability,
  type PackInput,
  type PackOptions,
  type PackOutcome,
  type PackPlan,
  type PackagePacker,
} from '@openpacker/adapter-core';
import { canonicalBytes } from '@openpacker/canonical';
import type {
  DelegatedPackArtifactIdentity,
  DelegatedPackProviderManifest,
  JsonValue,
  PackProviderArgument,
} from '@openpacker/contracts';
import { validateContract } from '@openpacker/conformance';
import {
  assertNamedDirectory,
  openStableDirectory,
} from '@openpacker/project-io';
import {
  runInSandbox,
  type RunInSandboxInput,
  type SandboxOutcome,
} from '@openpacker/sandbox';

import {
  collectArtifacts,
  handleRelativeReads,
  type CollectionReads,
} from './collect.js';
import {
  assertExecutableIdentity,
  inspectDelegatedExecutable,
  openDelegatedExecutable,
  UNSUPPORTED_PLATFORM,
  type DelegatedExecutableAuthority,
  type DelegatedExecutableIdentity,
} from './executable.js';

type SandboxRun = (input: RunInSandboxInput) => Promise<SandboxOutcome>;

type InspectExecutable = (path: string) => Promise<DelegatedExecutableIdentity>;
type OpenExecutableAuthority = (
  path: string,
) => Promise<DelegatedExecutableAuthority>;

const DEFAULT_LIMITS: ManifestPackagePackerLimits = {
  outputEntries: 4_096,
  artifacts: 256,
  artifactBytes: 1_073_741_824n,
  totalArtifactBytes: 2_147_483_648n,
  readChunkBytes: 64 * 1_024,
};

export interface ManifestPackagePackerLimits {
  outputEntries: number;
  artifacts: number;
  artifactBytes: bigint;
  totalArtifactBytes: bigint;
  readChunkBytes: number;
}

export interface ManifestPackagePackerDependencies {
  /**
   * Absolute standalone executable explicitly approved by the host operator.
   * The configured source path is recorded in receipts, while its digest is
   * computed from and execution uses one unnamed immutable private snapshot.
   * Sibling modules/resources are not exposed; approve a standalone wrapper or
   * bundle. Unavailable unnamed storage fails closed without a named fallback.
   */
  executablePath: string;
  inspectExecutable?: InspectExecutable;
  openExecutableAuthority?: OpenExecutableAuthority;
  sandboxRun?: SandboxRun;
  limits?: Partial<ManifestPackagePackerLimits>;
  /** Opens the approved executable for its snapshot. */
  openFile?: typeof open;
  /**
   * The reads made of the output directory, each against its retained handle.
   * Defaults to project-io's handle-relative operations; tests land a swap
   * between two of them.
   */
  collectionReads?: Partial<CollectionReads>;
}

export class ManifestPackagePacker implements PackagePacker {
  readonly providerId: string;
  readonly providerManifestDigest: string;
  readonly purlType: string;
  readonly #executablePath: string;
  readonly #inspectExecutable: InspectExecutable;
  readonly #openExecutableAuthority: OpenExecutableAuthority;
  readonly #sandboxRun: SandboxRun;
  readonly #limits: ManifestPackagePackerLimits;
  readonly #openFile: typeof open;
  readonly #reads: CollectionReads;

  constructor(
    private readonly manifest: DelegatedPackProviderManifest,
    purlType: string,
    dependencies: ManifestPackagePackerDependencies,
  ) {
    if (!manifest.purlTypes.includes(purlType))
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `Provider ${manifest.id} does not declare purl type ${purlType}`,
      );
    this.providerId = manifest.id;
    this.providerManifestDigest = `sha256:${createHash('sha256')
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      .update(canonicalBytes(JSON.parse(JSON.stringify(manifest)) as JsonValue))
      .digest('hex')}`;
    this.purlType = purlType;
    if (!isAbsolute(dependencies.executablePath))
      throw new ProviderError(
        'AUTHORITY_NOT_DECLARED',
        'Delegated provider executable approval must be an absolute path',
      );
    this.#executablePath = dependencies.executablePath;
    this.#openFile = dependencies.openFile ?? open;
    this.#inspectExecutable =
      dependencies.inspectExecutable ??
      ((path) => inspectDelegatedExecutable(path, this.#openFile));
    this.#openExecutableAuthority =
      dependencies.openExecutableAuthority ??
      (dependencies.inspectExecutable === undefined
        ? (path) => openDelegatedExecutable(path, this.#openFile)
        : async (path) => ({
            identity: await dependencies.inspectExecutable!(path),
            fd: -1,
            close: async () => undefined,
          }));
    this.#sandboxRun = dependencies.sandboxRun ?? runInSandbox;
    this.#limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
    this.#reads = { ...handleRelativeReads, ...dependencies.collectionReads };
  }

  async available(): Promise<PackAvailability> {
    let platformRefusal: string | undefined;
    const identity = await this.#inspectExecutable(this.#executablePath).catch(
      (error: unknown) => {
        if (isUnsupportedPlatform(error))
          platformRefusal = this.#withAlternative(error.message);
        return undefined;
      },
    );
    return identity === undefined
      ? {
          available: false,
          reason:
            platformRefusal ??
            `${this.#executablePath} is not a stable executable`,
        }
      : {
          available: true,
          tool: {
            name: this.manifest.executable,
            path: identity.path,
            digest: identity.digest,
          },
        };
  }

  /** The platform refusal, and the standard emitter that does run here. */
  #withAlternative(refusal: string): string {
    return (
      `${refusal} Where ${this.purlType} has a standard emitter, ` +
      `\`opm pack ${this.purlType} --package-version <version>\` (without --provider or --delegate) runs on this platform.`
    );
  }

  async detect(root: string): Promise<DetectedProject | undefined> {
    for (const name of this.manifest.detection.manifestNames) {
      const manifestPath = join(root, name);
      try {
        const info = await lstat(manifestPath);
        if (info.isFile() && !info.isSymbolicLink())
          return {
            root,
            manifestPath,
            metadata: { purlType: this.purlType, providerId: this.providerId },
          };
      } catch {
        // Try the next declared marker.
      }
    }
    return undefined;
  }

  async hostPlan(input: PackInput, options: PackOptions = {}) {
    if (options.strategy === 'standard')
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `${this.providerId} is a delegated provider, not a standard emitter`,
      );
    if (input.target === undefined)
      throw new ProviderError(
        'INVALID_REQUEST',
        'Delegated provider planning requires an explicit target distribution',
      );
    const outputDirectory = resolve(
      options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
    );
    const values: Readonly<Record<string, string>> = {
      projectRoot: input.project.root,
      manifestPath: input.project.manifestPath,
      outputDirectory,
      packageName: input.target.identifier,
      packageVersion: input.target.version,
    };
    return {
      providerId: this.providerId,
      purlType: this.purlType,
      executable: this.manifest.executable,
      commandArguments: this.manifest.commands.map((command) =>
        expandArguments(command.arguments, values, options),
      ),
      cleanupArguments: (this.manifest.cleanupCommands ?? []).map((command) =>
        expandArguments(command.arguments, values, options),
      ),
      identityArgumentTemplates: [...this.manifest.identityCommand.arguments],
      environment: Object.fromEntries(
        Object.entries(this.manifest.environment ?? {}).map(([name, value]) => [
          name,
          expand(value, values),
        ]),
      ),
      authority: this.manifest.authority,
      artifacts: this.manifest.artifacts,
    };
  }

  async plan(input: PackInput, options: PackOptions = {}): Promise<PackPlan> {
    const plan = await this.hostPlan(input, options);
    const requiresNetwork =
      plan.authority.network === 'consent' &&
      options.allowNetwork === true &&
      options.offline !== true;
    const commands = plan.commandArguments.map((arguments_) => [
      plan.executable,
      ...arguments_,
    ]);
    const cleanupCommands = plan.cleanupArguments.map((arguments_) => [
      plan.executable,
      ...arguments_,
    ]);
    return {
      strategy: 'delegate',
      purlType: this.purlType,
      command: commands[0]!,
      commands,
      ...(!(cleanupCommands.length === 0) && { cleanupCommands }),
      // A project-selected executable is code execution even if its manifest
      // claims the native tool does not compile project sources.
      requiresBuild: true,
      requiresNetwork,
      expectedRoles: [
        ...new Set(plan.artifacts.map((item) => item.nativeRole)),
      ],
      semanticLoss: [],
    };
  }

  async pack(
    input: PackInput,
    options: PackOptions = {},
  ): Promise<PackOutcome> {
    const hostPlan = await this.hostPlan(input, options);
    const plan = await this.plan(input, options);
    if (!options.dryRun && options.allowBuild !== true)
      throw new ProviderError(
        'BUILD_CONSENT_REQUIRED',
        `${this.providerId} requests build authority; pass --allow-build`,
      );
    const authorizedEnvironment = options.authorizedEnvironment ?? {};
    for (const name of Object.keys(authorizedEnvironment))
      if (!hostPlan.authority.environment.includes(name))
        throw new ProviderError(
          'AUTHORITY_NOT_DECLARED',
          `${this.providerId} does not declare environment variable ${name}`,
        );
    const executableAuthority = await this.#openExecutableAuthority(
      this.#executablePath,
    ).catch((error: unknown) => {
      // A host that cannot hold the snapshot at all is said so, with where to
      // run it, not reported as a problem with the file.
      if (isUnsupportedPlatform(error))
        throw new ProviderError(
          UNSUPPORTED_PLATFORM,
          `${this.providerId} cannot pack here: ${this.#withAlternative(error.message)}`,
        );
      return undefined;
    });
    if (executableAuthority === undefined)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `${this.providerId} cannot pack here: ${this.#executablePath} is not a stable executable`,
      );
    const executableIdentity = executableAuthority.identity;
    try {
      const executablePath = executableIdentity.path;
      const tool = {
        name: this.manifest.executable,
        // Receipt path identifies the operator-approved source; the digest is
        // of the exact immutable snapshot supplied to the sandbox.
        path: executablePath,
        digest: executableIdentity.digest,
      };
      const withTool: PackPlan = {
        ...plan,
        ...(!(plan.command === undefined) && {
          command: plan.command.map((value, index) =>
            index === 0 ? executablePath : value,
          ),
        }),
        ...(!(plan.commands === undefined) && {
          commands: plan.commands.map((command) =>
            command.map((value, index) =>
              index === 0 ? executablePath : value,
            ),
          ),
        }),
        ...(!(plan.cleanupCommands === undefined) && {
          cleanupCommands: plan.cleanupCommands.map((command) =>
            command.map((value, index) =>
              index === 0 ? executablePath : value,
            ),
          ),
        }),
        tool,
      };
      if (options.dryRun) return emptyOutcome(withTool);

      const outputDirectory = resolve(
        options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
      );
      const outputAuthority = await openStableDirectory(outputDirectory);
      const outputIdentity = await directoryIdentity(
        outputAuthority,
        outputDirectory,
      );
      await assertNamedDirectory(outputDirectory, outputAuthority);
      try {
        const existingArtifacts = await checkedProviderOutput(async () => {
          const artifacts = await collectArtifacts(
            outputAuthority,
            outputDirectory,
            hostPlan,
            this.#limits,
            this.#reads,
          );
          await assertDirectoryIdentity(
            outputAuthority,
            outputDirectory,
            outputIdentity,
          );
          return artifacts;
        });
        if (existingArtifacts.length > 0)
          throw new ProviderError(
            'OUTPUT_NOT_EMPTY',
            `${this.providerId} requires an output directory without matching artifacts`,
          );

        const outcomes: SandboxOutcome[] = [];
        const environment = {
          ...hostPlan.environment,
          ...authorizedEnvironment,
        };
        try {
          for (const arguments_ of hostPlan.commandArguments) {
            const outcome = await this.runCommand(
              [executablePath, ...arguments_],
              input,
              options,
              withTool,
              executableAuthority,
              environment,
              Object.keys(authorizedEnvironment),
              outputDirectory,
              outputAuthority.fd,
            );
            outcomes.push(outcome);
            if (outcome.exitCode !== 0) break;
          }
        } finally {
          for (const arguments_ of hostPlan.cleanupArguments)
            outcomes.push(
              await this.runCommand(
                [executablePath, ...arguments_],
                input,
                options,
                withTool,
                executableAuthority,
                environment,
                Object.keys(authorizedEnvironment),
                outputDirectory,
                outputAuthority.fd,
              ),
            );
        }
        const outcome =
          outcomes.find((item) => item.exitCode !== 0) ?? outcomes.at(-1)!;
        let artifacts = await checkedProviderOutput(async () => {
          await assertNamedDirectory(outputDirectory, outputAuthority);
          const currentIdentity = await directoryIdentity(
            outputAuthority,
            outputDirectory,
          );
          if (
            currentIdentity.dev !== outputIdentity.dev ||
            currentIdentity.ino !== outputIdentity.ino
          )
            throw new ProviderError(
              'INVALID_RESPONSE',
              'Delegated provider replaced its output directory',
            );
          const collected =
            outcome.exitCode === 0
              ? await collectArtifacts(
                  outputAuthority,
                  outputDirectory,
                  hostPlan,
                  this.#limits,
                  this.#reads,
                )
              : [];
          await assertDirectoryIdentity(
            outputAuthority,
            outputDirectory,
            currentIdentity,
          );
          return collected;
        });
        if (outcome.exitCode === 0 && artifacts.length === 0)
          throw new ProviderError(
            'INVALID_RESPONSE',
            `${this.providerId} succeeded without a declared artifact`,
          );
        if (outcome.exitCode === 0) {
          const identities = new Map<string, DelegatedPackArtifactIdentity>();
          const identityDirectoryIdentity = await directoryIdentity(
            outputAuthority,
            outputDirectory,
          );
          for (const artifact of artifacts) {
            const identityOutcome = await this.runCommand(
              [
                executablePath,
                ...hostPlan.identityArgumentTemplates.map((argument) =>
                  expand(argument, {
                    projectRoot: input.project.root,
                    manifestPath: input.project.manifestPath,
                    outputDirectory,
                    packageName: input.target!.identifier,
                    packageVersion: input.target!.version,
                    artifactPath: artifact.path,
                  }),
                ),
              ],
              input,
              options,
              withTool,
              executableAuthority,
              environment,
              Object.keys(authorizedEnvironment),
              outputDirectory,
              outputAuthority.fd,
            );
            outcomes.push(identityOutcome);
            if (identityOutcome.exitCode !== 0)
              throw new ProviderError(
                'INVALID_RESPONSE',
                `${this.providerId} could not identify ${artifact.path}`,
              );
            identities.set(
              artifact.path,
              parseArtifactIdentity(identityOutcome.stdout),
            );
          }
          artifacts = await checkedProviderOutput(async () => {
            await assertNamedDirectory(outputDirectory, outputAuthority);
            const collected = await collectArtifacts(
              outputAuthority,
              outputDirectory,
              hostPlan,
              this.#limits,
              this.#reads,
            );
            await assertDirectoryIdentity(
              outputAuthority,
              outputDirectory,
              identityDirectoryIdentity,
            );
            return collected;
          });
          if (
            artifacts.length !== identities.size ||
            artifacts.some((artifact) => {
              const identity = identities.get(artifact.path);
              return (
                identity === undefined ||
                identity.exactPurl !== targetExactPurl(input.target!) ||
                identity.artifactDigest !== artifact.digest
              );
            })
          )
            throw new ProviderError(
              'INVALID_RESPONSE',
              `${this.providerId} artifact identity does not match the requested target and captured bytes`,
            );
          artifacts = artifacts.map((artifact) => ({
            ...artifact,
            exactPurl: identities.get(artifact.path)!.exactPurl,
          }));
        }
        return {
          ...withTool,
          performed: true,
          exitCode: outcome.exitCode,
          stdout: outcomes
            .map((item) => item.stdout)
            .filter(Boolean)
            .join('\n'),
          stderr: outcomes
            .map((item) => item.stderr)
            .filter(Boolean)
            .join('\n'),
          artifacts,
          sandboxBackend: outcome.backend,
          sandboxEnforced: outcome.enforced,
          semanticLoss: [
            ...plan.semanticLoss,
            ...outcomes.flatMap((item) => item.losses),
          ],
        };
      } finally {
        await outputAuthority.close();
      }
    } finally {
      await executableAuthority.close();
    }
  }

  private async runCommand(
    command: readonly string[],
    input: PackInput,
    options: PackOptions,
    plan: PackPlan,
    executableAuthority: DelegatedExecutableAuthority,
    environment: Readonly<Record<string, string>>,
    grantedEnvironment: readonly string[],
    outputDirectory: string,
    outputDirectoryFd: number,
  ): Promise<SandboxOutcome> {
    await assertExecutableIdentity(
      executableAuthority.identity,
      await this.#inspectExecutable(executableAuthority.identity.path),
    );
    const outcome = await this.#sandboxRun({
      argv: command,
      cwd: input.project.root,
      env: environment,
      grants: { env: grantedEnvironment },
      policy: {
        enabled: true,
        required: true,
        mode: 'fail-closed',
        prefer: options.sandbox?.prefer ?? 'auto',
      },
      readwritePaths: [outputDirectory],
      readonlyPaths: [input.project.root],
      network: plan.requiresNetwork,
      profile: 'package-exec',
      directoryAuthorities: [{ fd: outputDirectoryFd, path: outputDirectory }],
      ...(!(executableAuthority.fd < 0) && {
        executableAuthority: {
          fd: executableAuthority.fd,
          path: executableAuthority.identity.path,
        },
      }),
      ...(!(options.signal === undefined) && { signal: options.signal }),
    });
    await assertExecutableIdentity(
      executableAuthority.identity,
      await this.#inspectExecutable(executableAuthority.identity.path),
    );
    return outcome;
  }
}

export function manifestPackagePackers(
  manifest: DelegatedPackProviderManifest,
  dependencies: ManifestPackagePackerDependencies,
): ManifestPackagePacker[] {
  return manifest.purlTypes.map(
    (purlType) => new ManifestPackagePacker(manifest, purlType, dependencies),
  );
}

function expandArguments(
  arguments_: readonly PackProviderArgument[],
  values: Readonly<Record<string, string>>,
  options: PackOptions,
): string[] {
  return arguments_
    .filter((argument) =>
      typeof argument === 'string' ? true : condition(argument.when, options),
    )
    .map((argument) =>
      expand(typeof argument === 'string' ? argument : argument.value, values),
    );
}

function condition(
  when: Exclude<PackProviderArgument, string>['when'],
  options: PackOptions,
): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'allow-build':
      return options.allowBuild === true;
    case 'deny-build':
      return options.allowBuild !== true;
    case 'allow-network':
      return options.allowNetwork === true && options.offline !== true;
    case 'offline':
      return options.allowNetwork !== true || options.offline === true;
  }
}

function expand(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([A-Za-z]+)\}/gu, (_, name: string) => {
    const value = values[name];
    if (value === undefined)
      throw new ProviderError(
        'INVALID_PROVIDER_MANIFEST',
        `Unknown provider template token {${name}}`,
      );
    return value;
  });
}

function targetExactPurl(target: NonNullable<PackInput['target']>): string {
  if (target.exactPurl !== undefined) return target.exactPurl;
  const separator = target.identifier.lastIndexOf('/');
  return formatPurl({
    type: target.purlType,
    qualifiers: {},
    ...(separator < 0
      ? { name: target.identifier }
      : {
          namespace: target.identifier.slice(0, separator),
          name: target.identifier.slice(separator + 1),
        }),
    version: target.version,
  });
}

function parseArtifactIdentity(stdout: string): DelegatedPackArtifactIdentity {
  let value: JsonValue;
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    value = JSON.parse(stdout) as JsonValue;
  } catch {
    throw new ProviderError(
      'INVALID_RESPONSE',
      'Delegated provider identity output is not one JSON object',
    );
  }
  const schema =
    'https://openpacker.dev/spec/prex/v1/schemas/delegated-pack-provider.schema.json#/$defs/DelegatedPackArtifactIdentity';
  if (!validateContract(schema, value).valid)
    throw new ProviderError(
      'INVALID_RESPONSE',
      'Delegated provider identity output does not match the PREX contract',
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return value as DelegatedPackArtifactIdentity;
}

function isUnsupportedPlatform(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.code === UNSUPPORTED_PLATFORM;
}

function emptyOutcome(plan: PackPlan): PackOutcome {
  return {
    ...plan,
    performed: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    artifacts: [],
  };
}

async function checkedProviderOutput<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      'INVALID_RESPONSE',
      `Delegated provider output changed during collection: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function directoryIdentity(
  directory: FileHandle,
  reported: string,
): Promise<DirectoryIdentity> {
  const info = await directory.stat({ bigint: true });
  if (!info.isDirectory())
    throw new ProviderError(
      'INVALID_RESPONSE',
      `Output is not a directory: ${reported}`,
    );
  return {
    dev: info.dev,
    ino: info.ino,
    ctimeNs: info.ctimeNs,
    mtimeNs: info.mtimeNs,
  };
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

/**
 * The retained directory is the one first opened (same inode, same change and
 * modify times), and the output path still names it. The handle is what is
 * read; the path check is what notices a directory renamed away and not put
 * back.
 */
async function assertDirectoryIdentity(
  directory: FileHandle,
  outputDirectory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await directoryIdentity(directory, outputDirectory);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.ctimeNs !== expected.ctimeNs ||
    current.mtimeNs !== expected.mtimeNs
  )
    throw new ProviderError(
      'INVALID_RESPONSE',
      'Delegated provider output directory changed during artifact collection',
    );
  await assertNamedDirectory(outputDirectory, directory);
}
