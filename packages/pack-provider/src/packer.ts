import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  ProviderError,
  formatPurl,
  type DetectedProject,
  type PackArtifact,
  type PackAvailability,
  type PackInput,
  type PackOptions,
  type PackOutcome,
  type PackPlan,
  type PackagePacker,
} from '@openpacker/adapter-core';
import { canonicalBytes } from '@openpacker/canonical';
import type {
  DelegatedPackHostPlan,
  DelegatedPackArtifactIdentity,
  DelegatedPackProviderManifest,
  JsonValue,
  PackProviderArgument,
} from '@openpacker/contracts';
import { validateContract } from '@openpacker/conformance';
import {
  assertNamedDirectory,
  findExecutable,
  openStableDirectory,
  stableHandlePath,
} from '@openpacker/project-io';
import {
  runInSandbox,
  type RunInSandboxInput,
  type SandboxOutcome,
} from '@openpacker/sandbox';

type ResolveExecutable = (name: string) => Promise<string | undefined>;
type SandboxRun = (input: RunInSandboxInput) => Promise<SandboxOutcome>;

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
  resolveExecutable?: ResolveExecutable;
  sandboxRun?: SandboxRun;
  limits?: Partial<ManifestPackagePackerLimits>;
  openFile?: typeof open;
}

export class ManifestPackagePacker implements PackagePacker {
  readonly providerId: string;
  readonly providerManifestDigest: string;
  readonly purlType: string;
  readonly #resolveExecutable: ResolveExecutable;
  readonly #sandboxRun: SandboxRun;
  readonly #limits: ManifestPackagePackerLimits;
  readonly #openFile: typeof open;

  constructor(
    private readonly manifest: DelegatedPackProviderManifest,
    purlType: string,
    dependencies: ManifestPackagePackerDependencies = {},
  ) {
    if (!manifest.purlTypes.includes(purlType))
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `Provider ${manifest.id} does not declare purl type ${purlType}`,
      );
    this.providerId = manifest.id;
    this.providerManifestDigest = `sha256:${createHash('sha256')
      .update(canonicalBytes(manifest as unknown as JsonValue))
      .digest('hex')}`;
    this.purlType = purlType;
    this.#resolveExecutable = dependencies.resolveExecutable ?? findExecutable;
    this.#sandboxRun = dependencies.sandboxRun ?? runInSandbox;
    this.#limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
    this.#openFile = dependencies.openFile ?? open;
  }

  async available(): Promise<PackAvailability> {
    const candidate = await this.#resolveExecutable(
      this.manifest.executable,
    ).catch(() => undefined);
    const path = candidate === undefined ? undefined : resolve(candidate);
    return path === undefined
      ? {
          available: false,
          reason: `${this.manifest.executable} is not on PATH`,
        }
      : {
          available: true,
          tool: { name: this.manifest.executable, path },
        };
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

  async hostPlan(
    input: PackInput,
    options: PackOptions = {},
  ): Promise<DelegatedPackHostPlan> {
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
      ...(cleanupCommands.length === 0 ? {} : { cleanupCommands }),
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
    const availability = await this.available();
    if (!availability.available)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `${this.providerId} cannot pack here: ${availability.reason}`,
      );
    const executablePath = availability.tool?.path;
    if (executablePath === undefined)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `${this.providerId} did not resolve an executable path`,
      );
    const withTool = {
      ...plan,
      ...(availability.tool === undefined ? {} : { tool: availability.tool }),
    };
    if (options.dryRun) return emptyOutcome(withTool);

    const outputDirectory = resolve(
      options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
    );
    const outputAuthority = await openStableDirectory(outputDirectory);
    const stableOutputDirectory = stableHandlePath(outputAuthority);
    const outputReal = await realpath(stableOutputDirectory);
    const outputIdentity = await directoryIdentity(stableOutputDirectory);
    await assertNamedDirectory(outputDirectory, outputAuthority);
    try {
      const existingArtifacts = await checkedProviderOutput(async () => {
        const artifacts = await collectArtifacts(
          stableOutputDirectory,
          outputDirectory,
          outputReal,
          hostPlan,
          this.#limits,
          this.#openFile,
        );
        await assertDirectoryIdentity(
          stableOutputDirectory,
          outputReal,
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
      const environment = { ...hostPlan.environment, ...authorizedEnvironment };
      try {
        for (const arguments_ of hostPlan.commandArguments) {
          const outcome = await this.runCommand(
            [executablePath, ...arguments_],
            input,
            options,
            plan,
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
              plan,
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
        const currentIdentity = await directoryIdentity(stableOutputDirectory);
        if (
          currentIdentity.dev !== outputIdentity.dev ||
          currentIdentity.ino !== outputIdentity.ino ||
          (await realpath(stableOutputDirectory)) !== outputReal
        )
          throw new ProviderError(
            'INVALID_RESPONSE',
            'Delegated provider replaced its output directory',
          );
        const collected =
          outcome.exitCode === 0
            ? await collectArtifacts(
                stableOutputDirectory,
                outputDirectory,
                outputReal,
                hostPlan,
                this.#limits,
                this.#openFile,
              )
            : [];
        await assertDirectoryIdentity(
          stableOutputDirectory,
          outputReal,
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
          stableOutputDirectory,
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
            plan,
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
            stableOutputDirectory,
            outputDirectory,
            outputReal,
            hostPlan,
            this.#limits,
            this.#openFile,
          );
          await assertDirectoryIdentity(
            stableOutputDirectory,
            outputReal,
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
  }

  private runCommand(
    command: readonly string[],
    input: PackInput,
    options: PackOptions,
    plan: PackPlan,
    environment: Readonly<Record<string, string>>,
    grantedEnvironment: readonly string[],
    outputDirectory: string,
    outputDirectoryFd: number,
  ): Promise<SandboxOutcome> {
    return this.#sandboxRun({
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}

export function manifestPackagePackers(
  manifest: DelegatedPackProviderManifest,
  dependencies: ManifestPackagePackerDependencies = {},
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
  return value as DelegatedPackArtifactIdentity;
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

async function collectArtifacts(
  outputDirectory: string,
  reportedDirectory: string,
  outputReal: string,
  plan: DelegatedPackHostPlan,
  limits: ManifestPackagePackerLimits,
  openFile: typeof open,
): Promise<PackArtifact[]> {
  const artifacts: PackArtifact[] = [];
  let totalBytes = 0n;
  const entries: Dirent[] = [];
  const directory = await opendir(outputDirectory);
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      if (entries.length >= limits.outputEntries)
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Delegated provider output exceeds ${limits.outputEntries} entries`,
        );
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === 'opm-pack-receipt.json')
      throw new ProviderError(
        'INVALID_RESPONSE',
        'Delegated providers may not create the host receipt',
      );
    if (!entry.isFile()) continue;
    const type = plan.artifacts.find(
      (candidate) =>
        ('basename' in candidate && candidate.basename === entry.name) ||
        ('suffix' in candidate && entry.name.endsWith(candidate.suffix)),
    );
    if (type === undefined) continue;
    if (artifacts.length >= limits.artifacts)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Delegated provider output exceeds ${limits.artifacts} artifacts`,
      );
    const path = join(outputDirectory, entry.name);
    const resolved = await realpath(path);
    const relativePath = relative(outputReal, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`))
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Artifact escapes output: ${entry.name}`,
      );
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Artifact is not a regular file: ${entry.name}`,
      );
    if (before.size > limits.artifactBytes)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `Artifact exceeds ${limits.artifactBytes} bytes: ${entry.name}`,
      );
    const handle = await openFile(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Artifact changed while opening: ${entry.name}`,
        );
      const hash = createHash('sha256');
      let bytes = 0n;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: limits.readChunkBytes,
      })) {
        bytes += BigInt(chunk.byteLength);
        if (bytes > limits.artifactBytes)
          throw new ProviderError(
            'INVALID_RESPONSE',
            `Artifact exceeds ${limits.artifactBytes} bytes while hashing: ${entry.name}`,
          );
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs ||
        bytes !== after.size ||
        after.dev !== pathAfter.dev ||
        after.ino !== pathAfter.ino ||
        (await realpath(path)) !== resolved
      )
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Artifact changed while hashing: ${entry.name}`,
        );
      totalBytes += after.size;
      if (totalBytes > limits.totalArtifactBytes)
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Delegated provider artifacts exceed ${limits.totalArtifactBytes} total bytes`,
        );
      artifacts.push({
        path: join(reportedDirectory, entry.name),
        mediaType: type.mediaType,
        size: Number(after.size),
        digest: `sha256:${hash.digest('hex')}`,
        nativeRole: type.nativeRole,
        outputName: basename(path),
      });
    } finally {
      await handle.close();
    }
  }
  return artifacts;
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

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await stat(path, { bigint: true });
  if (!info.isDirectory())
    throw new ProviderError(
      'INVALID_RESPONSE',
      `Output is not a directory: ${path}`,
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

async function assertDirectoryIdentity(
  path: string,
  expectedReal: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await directoryIdentity(path);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.ctimeNs !== expected.ctimeNs ||
    current.mtimeNs !== expected.mtimeNs ||
    (await realpath(path)) !== expectedReal
  )
    throw new ProviderError(
      'INVALID_RESPONSE',
      'Delegated provider output directory changed during artifact collection',
    );
}
