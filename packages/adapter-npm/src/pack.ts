import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ProviderError,
  type DetectedProject,
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
import { NpmProjectFormat } from './project.js';

const run = promisify(execFile);

type Execute = (
  file: string,
  args: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

type SandboxRun = (input: RunInSandboxInput) => Promise<SandboxOutcome>;

interface NpmPackRecord {
  filename: string;
  name: string;
  version: string;
}

export class NpmPackagePacker implements PackagePacker {
  readonly providerId = 'npm-pack';
  readonly purlType = 'npm';
  readonly #project = new NpmProjectFormat();

  constructor(
    private readonly execute: Execute = (file, args, options) =>
      run(file, [...args], {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxBuffer: 8 * 1024 * 1024,
      }),
    private readonly sandboxRun: SandboxRun = runInSandbox,
  ) {}

  async available(options: PackOptions = {}): Promise<PackAvailability> {
    if (options.tool !== undefined && !['npm', 'mise'].includes(options.tool))
      return {
        available: false,
        reason: `npm pack supports npm or mise, not ${options.tool}`,
      };
    const tool = options.tool ?? 'npm';
    try {
      const { stdout } = await this.execute(
        tool,
        ['--version'],
        options.signal ? { signal: options.signal } : {},
      );
      const version = stdout.trim();
      return {
        available: true,
        tool: { name: tool, ...(version ? { version } : {}) },
      };
    } catch {
      return { available: false, reason: `${tool} is not on PATH` };
    }
  }

  detect(root: string): Promise<DetectedProject | undefined> {
    return this.#project.detect(root);
  }

  async plan(input: PackInput, options: PackOptions = {}): Promise<PackPlan> {
    if (options.strategy === 'standard')
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        'The npm package-build/2 adapter does not implement standard packing yet',
      );
    const outputDirectory = packOutputDirectory(input, options);
    const nativeCommand = [
      'npm',
      'pack',
      input.project.root,
      '--json',
      '--pack-destination',
      outputDirectory,
      ...(options.allowBuild ? [] : ['--ignore-scripts']),
    ];
    const command =
      options.tool === 'mise'
        ? ['mise', 'exec', '--', ...nativeCommand]
        : nativeCommand;
    return {
      strategy: 'delegate',
      purlType: 'npm',
      command,
      commands: [command],
      requiresBuild: options.allowBuild === true,
      requiresNetwork: options.allowNetwork === true && !options.offline,
      expectedRoles: ['distribution'],
      semanticLoss: [],
    };
  }

  async pack(
    input: PackInput,
    options: PackOptions = {},
  ): Promise<PackOutcome> {
    const plan = await this.plan(input, options);
    const availability = await this.available(options);
    if (!availability.available)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `npm cannot pack here: ${availability.reason}`,
      );
    const withTool = {
      ...plan,
      ...(availability.tool === undefined ? {} : { tool: availability.tool }),
    };
    if (options.dryRun)
      return {
        ...withTool,
        performed: false,
        exitCode: 0,
        stdout: '',
        stderr: '',
        artifacts: [],
      };

    const outputDirectory = packOutputDirectory(input, options);
    await mkdir(outputDirectory, { recursive: true });
    const outcome = await this.sandboxRun({
      argv: plan.command!,
      cwd: input.project.root,
      env: { npm_config_cache: join(outputDirectory, '.npm-cache') },
      policy: {
        enabled: true,
        required: true,
        mode: options.sandbox?.mode ?? 'fail-closed',
        prefer: options.sandbox?.prefer ?? 'auto',
      },
      readwritePaths: [outputDirectory],
      readonlyPaths: [input.project.root],
      network: plan.requiresNetwork,
      profile: 'package-exec',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (outcome.exitCode !== 0)
      return {
        ...withTool,
        performed: true,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        artifacts: [],
        sandboxBackend: outcome.backend,
        sandboxEnforced: outcome.enforced,
        semanticLoss: [...plan.semanticLoss, ...outcome.losses],
      };

    const records = parseRecords(outcome.stdout);
    const artifacts = await Promise.all(
      records.map((record) => artifactFor(outputDirectory, record)),
    );
    return {
      ...withTool,
      performed: true,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      artifacts,
      sandboxBackend: outcome.backend,
      sandboxEnforced: outcome.enforced,
      semanticLoss: [...plan.semanticLoss, ...outcome.losses],
    };
  }
}

function packOutputDirectory(input: PackInput, options: PackOptions): string {
  return resolve(
    options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
  );
}

function parseRecords(stdout: string): readonly NpmPackRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new ProviderError(
      'INVALID_RESPONSE',
      `npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as NpmPackRecord).filename !== 'string' ||
        typeof (entry as NpmPackRecord).name !== 'string' ||
        typeof (entry as NpmPackRecord).version !== 'string',
    )
  )
    throw new ProviderError(
      'INVALID_RESPONSE',
      'npm pack returned no complete artifact records',
    );
  return value as NpmPackRecord[];
}

async function artifactFor(outputDirectory: string, record: NpmPackRecord) {
  if (basename(record.filename) !== record.filename)
    throw new ProviderError(
      'INVALID_RESPONSE',
      `npm pack returned an unsafe filename: ${record.filename}`,
    );
  const outputRoot = await realpath(outputDirectory);
  const path = resolve(outputDirectory, record.filename);
  const actual = await realpath(path).catch(() => undefined);
  if (actual === undefined || !inside(outputRoot, actual))
    throw new ProviderError(
      'INVALID_RESPONSE',
      `npm pack artifact is outside the output directory: ${record.filename}`,
    );
  const bytes = await readFile(actual);
  return {
    path,
    exactPurl: npmPurl(record.name, record.version),
    mediaType: 'application/gzip',
    size: bytes.byteLength,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    nativeRole: 'distribution',
  };
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !child.startsWith('/');
}

function npmPurl(name: string, version: string): string {
  if (name.startsWith('@')) {
    const [scope, packageName, ...rest] = name.slice(1).split('/');
    if (!scope || !packageName || rest.length > 0)
      throw new ProviderError('INVALID_RESPONSE', `Invalid npm name: ${name}`);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  if (!name || name.includes('/'))
    throw new ProviderError('INVALID_RESPONSE', `Invalid npm name: ${name}`);
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}
