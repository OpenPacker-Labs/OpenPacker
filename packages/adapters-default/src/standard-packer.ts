import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
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
import { writeFileAtomic } from '@openpacker/project-io';
import type { StandardEmitter } from './standard-pack.js';

export interface StandardPackagePackerOptions {
  providerId: string;
  purlType: Ecosystem;
  detect(root: string): Promise<DetectedProject | undefined>;
  capturePaths?(project: DetectedProject): Promise<readonly string[]>;
  emitter: StandardEmitter;
}

export class StandardPackagePacker implements PackagePacker {
  readonly providerId: string;
  readonly purlType: Ecosystem;
  readonly capturePaths?: (
    project: DetectedProject,
  ) => Promise<readonly string[]>;

  constructor(private readonly config: StandardPackagePackerOptions) {
    this.providerId = config.providerId;
    this.purlType = config.purlType;
    if (config.capturePaths !== undefined)
      this.capturePaths = config.capturePaths;
  }

  async available(options: PackOptions = {}): Promise<PackAvailability> {
    return options.strategy === 'delegate'
      ? {
          available: false,
          reason: 'delegated packing requires a configured provider',
        }
      : { available: true };
  }

  detect(root: string): Promise<DetectedProject | undefined> {
    return this.config.detect(root);
  }

  async plan(_input: PackInput, options: PackOptions = {}): Promise<PackPlan> {
    if (options.strategy === 'delegate')
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `${this.purlType} delegation requires a configured pack provider`,
      );
    return {
      strategy: 'standard',
      purlType: this.purlType,
      requiresBuild: false,
      requiresNetwork: false,
      expectedRoles: this.config.emitter.expectedRoles,
      semanticLoss: [],
    };
  }

  async pack(
    input: PackInput,
    options: PackOptions = {},
  ): Promise<PackOutcome> {
    const plan = await this.plan(input, options);
    if (options.dryRun)
      return {
        ...plan,
        performed: false,
        exitCode: 0,
        stdout: '',
        stderr: '',
        artifacts: [],
      };
    if (input.normalized === undefined)
      throw new ProviderError(
        'INVALID_REQUEST',
        'Standard packing requires a normalized pack input',
      );
    const outputDirectory = resolve(
      options.outputDirectory ?? join(input.project.root, '.opm', 'pack'),
    );
    const emitted = await this.config.emitter.emit(input.normalized);
    const names = new Set<string>();
    const artifacts: PackArtifact[] = [];
    for (const artifact of emitted) {
      if (
        basename(artifact.fileName) !== artifact.fileName ||
        names.has(artifact.fileName)
      )
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Standard emitter returned an unsafe or duplicate filename: ${artifact.fileName}`,
        );
      names.add(artifact.fileName);
      const path = join(outputDirectory, artifact.fileName);
      await writeFileAtomic(path, artifact.bytes);
      artifacts.push({
        path,
        ...(artifact.exactPurl === undefined
          ? {}
          : { exactPurl: artifact.exactPurl }),
        mediaType: artifact.mediaType,
        size: artifact.bytes.byteLength,
        digest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
        nativeRole: artifact.nativeRole,
        outputName: artifact.fileName,
      });
    }
    if (artifacts.length === 0)
      throw new ProviderError(
        'INVALID_RESPONSE',
        `${this.purlType} standard emitter produced no artifacts`,
      );
    return {
      ...plan,
      performed: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      artifacts,
      semanticLoss: [...input.normalized.manifest.semanticLoss],
    };
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
        const info = await lstat(manifestPath);
        if (info.isFile() && !info.isSymbolicLink())
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
