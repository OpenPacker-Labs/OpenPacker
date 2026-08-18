import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import {
  ProviderError,
  type DetectedProject,
  type Ecosystem,
  type PackArtifact,
  type PackAvailability,
  type PackInput,
  type PackOptions,
  type PackOutcome,
  type PackPlan,
  type PackagePacker,
} from '@openpacker/adapter-core';
import {
  runInSandbox,
  type RunInSandboxInput,
  type SandboxOutcome,
} from '@openpacker/sandbox';

const run = promisify(execFile);

type Execute = (
  file: string,
  args: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

type SandboxRun = (input: RunInSandboxInput) => Promise<SandboxOutcome>;

export interface DelegatedToolPlan {
  commands: readonly [readonly string[], ...(readonly string[])[]];
  cleanupCommands?: readonly (readonly string[])[];
  requiresBuild: boolean;
  requiresNetwork: boolean;
  expectedRoles: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export interface DelegatedTool {
  executable: string;
  plan(input: {
    project: DetectedProject;
    outputDirectory: string;
    options: PackOptions;
  }): DelegatedToolPlan;
}

export interface DelegatedArtifactType {
  extension?: string;
  basename?: string;
  mediaType: string;
  nativeRole: string;
}

export interface DelegatedCommandPackerOptions {
  providerId: string;
  purlType: Ecosystem;
  detect(root: string): Promise<DetectedProject | undefined>;
  defaultTool: string;
  tools: Readonly<Record<string, DelegatedTool>>;
  artifacts: readonly DelegatedArtifactType[];
  /** Native manifest bundles (for example WinGet) are validated, then copied. */
  copyProjectArtifacts?: boolean;
}

/** Shared execution mechanics; each adapter still owns its native command. */
export class DelegatedCommandPacker implements PackagePacker {
  readonly providerId: string;
  readonly purlType: Ecosystem;

  constructor(
    private readonly config: DelegatedCommandPackerOptions,
    private readonly execute: Execute = (file, args, options) =>
      run(file, [...args], {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxBuffer: 8 * 1024 * 1024,
      }),
    private readonly sandboxRun: SandboxRun = runInSandbox,
  ) {
    this.providerId = config.providerId;
    this.purlType = config.purlType;
  }

  async available(options: PackOptions = {}): Promise<PackAvailability> {
    const selected = this.selectedTool(options);
    const executable = selected.mise ? 'mise' : selected.tool.executable;
    try {
      const { stdout } = await this.execute(
        executable,
        ['--version'],
        options.signal ? { signal: options.signal } : {},
      );
      const version = stdout.trim().split(/\s+/u).at(-1);
      return {
        available: true,
        tool: {
          name: selected.mise ? 'mise' : selected.name,
          ...(version ? { version } : {}),
        },
      };
    } catch {
      return { available: false, reason: `${executable} is not on PATH` };
    }
  }

  detect(root: string): Promise<DetectedProject | undefined> {
    return this.config.detect(root);
  }

  async plan(input: PackInput, options: PackOptions = {}): Promise<PackPlan> {
    if (options.strategy === 'standard')
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `${this.purlType} delegated packing does not implement standard packing`,
      );
    const selected = this.selectedTool(options);
    const outputDirectory = packOutputDirectory(input, options);
    const native = selected.tool.plan({
      project: input.project,
      outputDirectory,
      options,
    });
    const commands = native.commands.map((command) =>
      selected.mise ? ['mise', 'exec', '--', ...command] : command,
    );
    const cleanupCommands = native.cleanupCommands?.map((command) =>
      selected.mise ? ['mise', 'exec', '--', ...command] : command,
    );
    return {
      strategy: 'delegate',
      purlType: this.purlType,
      command: commands[0]!,
      commands,
      ...(cleanupCommands === undefined ? {} : { cleanupCommands }),
      requiresBuild: native.requiresBuild,
      requiresNetwork: native.requiresNetwork,
      expectedRoles: native.expectedRoles,
      semanticLoss: [],
    };
  }

  async pack(
    input: PackInput,
    options: PackOptions = {},
  ): Promise<PackOutcome> {
    const selected = this.selectedTool(options);
    const native = selected.tool.plan({
      project: input.project,
      outputDirectory: packOutputDirectory(input, options),
      options,
    });
    const plan = await this.plan(input, options);
    const availability = await this.available(options);
    if (!availability.available)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `${this.purlType} cannot pack here: ${availability.reason}`,
      );
    const withTool = {
      ...plan,
      ...(availability.tool === undefined ? {} : { tool: availability.tool }),
    };
    if (options.dryRun) return emptyOutcome(withTool);
    if (plan.requiresBuild && options.allowBuild !== true)
      throw new ProviderError(
        'BUILD_CONSENT_REQUIRED',
        `${this.purlType} packing executes a build; pass --allow-build`,
      );

    const outputDirectory = packOutputDirectory(input, options);
    await mkdir(outputDirectory, { recursive: true });
    const outcomes: SandboxOutcome[] = [];
    try {
      for (const command of plan.commands ?? [plan.command!]) {
        const outcome = await this.runCommand(
          command,
          input,
          options,
          native,
          outputDirectory,
        );
        outcomes.push(outcome);
        if (outcome.exitCode !== 0) break;
      }
    } finally {
      for (const command of plan.cleanupCommands ?? [])
        outcomes.push(
          await this.runCommand(
            command,
            input,
            options,
            native,
            outputDirectory,
          ),
        );
    }
    const outcome =
      outcomes.find((item) => item.exitCode !== 0) ?? outcomes.at(-1)!;
    if (outcome.exitCode === 0 && this.config.copyProjectArtifacts)
      await copyProjectArtifacts(
        input.project.root,
        outputDirectory,
        this.config.artifacts,
      );
    const artifacts =
      outcome.exitCode === 0
        ? await collectArtifacts(outputDirectory, this.config.artifacts)
        : [];
    if (outcome.exitCode === 0 && artifacts.length === 0)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `${selected.name} succeeded without producing a recognized ${this.purlType} artifact`,
      );
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
  }

  private runCommand(
    command: readonly string[],
    input: PackInput,
    options: PackOptions,
    native: DelegatedToolPlan,
    outputDirectory: string,
  ): Promise<SandboxOutcome> {
    return this.sandboxRun({
      argv: command,
      cwd: input.project.root,
      env: native.env ?? {},
      policy: {
        enabled: true,
        required: true,
        mode: options.sandbox?.mode ?? 'fail-closed',
        prefer: options.sandbox?.prefer ?? 'auto',
      },
      readwritePaths: [outputDirectory],
      readonlyPaths: [input.project.root],
      network: native.requiresNetwork,
      profile: 'package-exec',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private selectedTool(options: PackOptions): {
    name: string;
    tool: DelegatedTool;
    mise: boolean;
  } {
    const requested = options.tool ?? this.config.defaultTool;
    const mise = requested === 'mise';
    const name = mise ? this.config.defaultTool : requested;
    const tool = this.config.tools[name];
    if (tool === undefined)
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `${this.purlType} pack supports ${[
          ...Object.keys(this.config.tools),
          'mise',
        ].join(', ')}, not ${requested}`,
      );
    return { name, tool, mise };
  }
}

export function markerDetector(
  purlType: Ecosystem,
  candidates: readonly string[],
): (root: string) => Promise<DetectedProject | undefined> {
  return async (root) => {
    for (const candidate of candidates) {
      const manifestPath = join(root, candidate);
      try {
        await access(manifestPath);
        return { root, manifestPath, metadata: { purlType } };
      } catch {
        // Try the next native marker.
      }
    }
    return undefined;
  };
}

export function extensionDetector(
  purlType: Ecosystem,
  extensions: readonly string[],
): (root: string) => Promise<DetectedProject | undefined> {
  return async (root) => {
    const match = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .find((name) => extensions.includes(extname(name).toLowerCase()));
    return match === undefined
      ? undefined
      : {
          root,
          manifestPath: join(root, match),
          metadata: { purlType },
        };
  };
}

function packOutputDirectory(input: PackInput, options: PackOptions): string {
  return resolve(
    options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
  );
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
  root: string,
  types: readonly DelegatedArtifactType[],
): Promise<readonly PackArtifact[]> {
  const paths = await files(root);
  const artifacts: PackArtifact[] = [];
  for (const path of paths) {
    const type = types.find(
      (candidate) =>
        (candidate.basename !== undefined &&
          basename(path) === candidate.basename) ||
        (candidate.extension !== undefined &&
          extname(path).toLowerCase() === candidate.extension),
    );
    if (type === undefined) continue;
    const bytes = await readFile(path);
    artifacts.push({
      path,
      mediaType: type.mediaType,
      size: bytes.byteLength,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      nativeRole: type.nativeRole,
      outputName: basename(path),
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyProjectArtifacts(
  root: string,
  outputDirectory: string,
  types: readonly DelegatedArtifactType[],
): Promise<void> {
  const outputRoot = resolve(outputDirectory);
  for (const path of await files(root)) {
    const absolute = resolve(path);
    if (absolute === outputRoot || absolute.startsWith(`${outputRoot}${sep}`))
      continue;
    if (
      !types.some(
        (type) =>
          type.basename === basename(path) ||
          type.extension === extname(path).toLowerCase(),
      )
    )
      continue;
    const destination = join(outputDirectory, relative(root, path));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
  }
}

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
