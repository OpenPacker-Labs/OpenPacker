import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import type {
  PackArtifact,
  PackOptions,
  PackOutcome,
} from '@openpacker/adapter-core';
import { canonicalBytes, parseDigest } from '@openpacker/canonical';
import type {
  Distribution,
  DistributionRequirement,
  JsonValue,
  PackageManifest,
  PackReceipt,
} from '@openpacker/contracts';
import { writeFileAtomic } from '@openpacker/project-io';
import { requireAdapterRegistry } from './adapters.js';
import { normalizeProjectPack } from './pack-normalize.js';
import { OPM_DIR } from './paths.js';
import { OpmError } from './types.js';

export const PACK_RECEIPT = 'opm-pack-receipt.json';

/** Standardize a detected project through the internal normalized model. */
export async function packStandardProject(input: {
  root: string;
  ecosystem: string;
  outputDirectory?: string;
  name: string;
  version: string;
  nativeMetadata?: Record<string, JsonValue>;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<PackOutcome> {
  return packProject({ ...input, strategy: 'standard' });
}

/** Common receipt-producing path for standard and delegated packaging. */
export async function packProject(input: {
  root: string;
  ecosystem: string;
  strategy: 'delegate' | 'standard';
  outputDirectory?: string;
  name: string;
  version: string;
  nativeMetadata?: Record<string, JsonValue>;
  provider?: string;
  authorizedEnvironment?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  allowBuild?: boolean;
  allowNetwork?: boolean;
  offline?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<PackOutcome> {
  const registry = requireAdapterRegistry();
  const packer =
    input.strategy === 'delegate'
      ? registry.delegatedPackerFor(input.ecosystem, input.provider)
      : await registry.packerFor(input.ecosystem);
  const project = await packer.detect(input.root);
  if (!project)
    throw new OpmError(
      'NOT_FOUND',
      `No ${input.ecosystem} packable project in ${input.root}.`,
    );
  const format = await registry.projectFormatFor(input.ecosystem);
  const requirements = format ? await format.readRequirements(project) : [];
  const target: Distribution = {
    purlType: packer.purlType,
    identifier: input.name,
    version: input.version,
    requirements: requirements.map(toDistributionRequirement),
  };
  const packageManifest: PackageManifest = {
    packageManifestVersion: '1',
    name: input.name,
    version: input.version,
    distributions: [target],
  };
  const outputDirectory = resolve(
    input.outputDirectory ?? join(input.root, OPM_DIR, 'pack'),
  );
  const includePaths = input.dryRun
    ? undefined
    : await packer.capturePaths?.(project);
  const normalized = input.dryRun
    ? undefined
    : await normalizeProjectPack({
        root: input.root,
        package: packageManifest,
        target,
        ...(input.nativeMetadata === undefined
          ? {}
          : { nativeMetadata: input.nativeMetadata }),
        excludePaths: [outputDirectory],
        ...(includePaths === undefined ? {} : { includePaths }),
      });
  const options: PackOptions = {
    strategy: input.strategy,
    outputDirectory,
    ...(input.authorizedEnvironment?.[packer.providerId] === undefined
      ? {}
      : {
          authorizedEnvironment: input.authorizedEnvironment[packer.providerId],
        }),
    ...(input.allowBuild === undefined ? {} : { allowBuild: input.allowBuild }),
    ...(input.allowNetwork === undefined
      ? {}
      : { allowNetwork: input.allowNetwork }),
    ...(input.offline === undefined ? {} : { offline: input.offline }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const outcome = await packer.pack(
    {
      project,
      manifest: packageManifest,
      target,
      ...(normalized === undefined ? {} : { normalized }),
    },
    options,
  );
  if (!outcome.performed || outcome.exitCode !== 0) return outcome;
  if (normalized === undefined)
    throw new OpmError(
      'INTERNAL_ERROR',
      'Performed pack has no normalized input',
    );
  if (
    input.strategy === 'delegate' &&
    packer.providerManifestDigest === undefined
  )
    throw new OpmError(
      'INVALID_RESPONSE',
      `Delegated provider ${packer.providerId} has no manifest digest`,
    );
  const receipt = receiptFor(
    outcome,
    target,
    normalized.digest,
    input.strategy === 'delegate'
      ? {
          id: packer.providerId,
          manifestDigest: parseDigest(packer.providerManifestDigest!),
          artifactIdentity: 'provider-attested',
        }
      : undefined,
  );
  const bytes = canonicalBytes(receipt as unknown as JsonValue);
  const receiptPath = join(outputDirectory, PACK_RECEIPT);
  await writeFileAtomic(receiptPath, bytes);
  const receiptArtifact: PackArtifact = {
    path: receiptPath,
    mediaType: 'application/vnd.openpacker.pack-receipt.v1+json',
    size: bytes.byteLength,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    nativeRole: 'receipt',
    outputName: PACK_RECEIPT,
  };
  return {
    ...outcome,
    artifacts: [...outcome.artifacts, receiptArtifact],
    receipt,
  };
}

function receiptFor(
  outcome: PackOutcome,
  target: Distribution,
  normalizedManifestDigest: PackReceipt['normalizedManifestDigest'],
  provider?: PackReceipt['provider'],
): PackReceipt {
  const descriptorIds = new Set<string>();
  return {
    packReceiptVersion: '1',
    strategy: outcome.strategy,
    target,
    normalizedManifestDigest,
    ...(provider === undefined ? {} : { provider }),
    ...(outcome.tool === undefined ? {} : { tool: outcome.tool }),
    commands: (
      outcome.commands ??
      (outcome.command === undefined ? [] : [outcome.command])
    ).map((command) => [...command]),
    ...(outcome.sandboxEnforced === undefined
      ? {}
      : {
          sandbox: {
            ...(outcome.sandboxBackend === undefined
              ? {}
              : { backend: outcome.sandboxBackend }),
            enforced: outcome.sandboxEnforced,
          },
        }),
    artifacts: outcome.artifacts.map((artifact) => {
      if (descriptorIds.has(artifact.digest))
        throw new OpmError(
          'INVALID_RESPONSE',
          `Pack returned duplicate artifact digest ${artifact.digest}`,
        );
      descriptorIds.add(artifact.digest);
      return {
        descriptorId: artifact.digest,
        digest: parseDigest(artifact.digest),
        size: artifact.size,
        mediaType: artifact.mediaType,
        artifactType: artifact.mediaType,
        ...(artifact.outputName === undefined
          ? {}
          : { fileName: basename(artifact.outputName) }),
        nativeRole: artifact.nativeRole,
        locations: [],
        referrers: [],
        externalRefs: [],
      };
    }),
    semanticLoss: [...outcome.semanticLoss],
  };
}

function toDistributionRequirement(input: {
  purl: string;
  name: string;
  range?: string;
  scope: DistributionRequirement['scope'];
}): DistributionRequirement {
  return {
    identifier: input.name,
    purl: input.purl,
    ...(input.range === undefined ? {} : { range: input.range }),
    scope: input.scope,
  };
}
