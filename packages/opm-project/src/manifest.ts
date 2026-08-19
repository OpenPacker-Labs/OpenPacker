/**
 * Build a PREX package manifest for this project.
 *
 * One document naming a package and every ecosystem it ships to — the problem
 * the MCP registry's `server.json` solves for MCP servers, generalised. The
 * per-ecosystem knowledge comes from the same `ProjectFormat` plugins that
 * write native manifests, so adding an ecosystem to opm adds it here too;
 * nothing in this file knows what npm or NuGet are.
 *
 * The manifest is an artifact, not a report: it is canonicalised and digested
 * the same way every other PREX document is, so it can be published, pinned,
 * and later verified to be the same document.
 */

import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
} from '@openpacker/canonical';
import type {
  Digest,
  Distribution,
  JsonValue,
  PackageManifest,
  RegistryRef,
  SemanticLoss,
} from '@openpacker/contracts';
import { hasResource } from '@openpacker/adapter-host';
import { requireAdapterRegistry } from './adapters.js';
import { nativeName } from './native.js';
import {
  registryDefinitionFor,
  registryOptionsForEcosystem,
} from './registry.js';
import { stripPurlVersion } from './spec.js';
import { OpmError } from './types.js';
import type { LockPackage, OpmLockfile, OpmManifest } from './types.js';

/** How a distribution is ordinarily run without installing it. */
const RUNTIME_HINT: Readonly<Record<string, string>> = {
  npm: 'npx',
  pypi: 'uvx',
  nuget: 'dnx',
  oci: 'docker',
};

export interface BuiltPackageManifest {
  manifest: PackageManifest;
  /** Canonical JCS bytes — what gets published and what the digest covers. */
  bytes: Uint8Array;
  digest: Digest;
}

/**
 * Assemble the manifest from the project, its lock, and the adapter registry.
 *
 * Every version here came out of a resolve that is already recorded in the
 * lock, so this states what was decided rather than deciding anything.
 */
export async function buildPackageManifest(input: {
  root: string;
  manifest: OpmManifest;
  lock: OpmLockfile;
  /** Overrides the name taken from the project. */
  name?: string;
  version?: string;
  description?: string;
  producedAt: string;
  producer: { id: string; version: string };
}): Promise<BuiltPackageManifest> {
  const registry = requireAdapterRegistry();
  const ecosystems = [
    ...new Set(Object.values(input.lock.packages).map((pkg) => pkg.ecosystem)),
  ].sort();

  const distributions: Distribution[] = [];
  const registries: RegistryRef[] = [];
  const semanticLoss: SemanticLoss[] = [];

  for (const ecosystem of ecosystems) {
    const definition = await registryDefinitionFor(
      ecosystem,
      registryOptionsForEcosystem(ecosystem, input.manifest),
    ).catch(() => undefined);
    if (definition) {
      const ref: RegistryRef = {
        registryId: definition.registryId,
        ...(definition.displayName === undefined
          ? {}
          : { displayName: definition.displayName }),
        purlTypes: [...definition.purlTypes],
        ...(serviceIndexOf(definition) === undefined
          ? {}
          : { serviceIndex: serviceIndexOf(definition)! }),
        definitionDigest: await canonicalDigest(
          definition as unknown as JsonValue,
        ),
      };
      registries.push(ref);
    }

    // Direct requirements only: a manifest says what this package needs, and
    // the closure that satisfied it belongs in the receipt the provenance
    // points at.
    const direct = Object.values(input.lock.packages).filter(
      (pkg) => pkg.ecosystem === ecosystem && pkg.reason === 'direct',
    );
    const requirements = direct.map((pkg) => ({
      identifier: nativeName(stripPurlVersion(pkg.purl)),
      purl: stripPurlVersion(pkg.purl),
      ...(rangeOf(input.manifest, pkg) === undefined
        ? {}
        : { range: rangeOf(input.manifest, pkg)! }),
      scope: input.manifest.packages[pkg.alias]?.scope ?? ('runtime' as const),
    }));

    const format = await registry
      .projectFormatFor(ecosystem)
      .catch(() => undefined);
    const detected = await format?.detect(input.root);
    if (!detected) {
      // No project of this kind here, so there is nothing this project ships
      // to that ecosystem — the dependencies are still described above.
      semanticLoss.push(noProjectLoss(ecosystem));
      continue;
    }

    const identifier = input.name ?? projectName(input.manifest);
    const version = input.version ?? '0.0.0';
    distributions.push({
      purlType: ecosystem,
      identifier,
      version,
      exactPurl: `pkg:${ecosystem}/${encodeIdentifier(identifier)}@${version}`,
      ...(definition === undefined
        ? {}
        : { registryId: definition.registryId }),
      ...(RUNTIME_HINT[ecosystem] === undefined
        ? {}
        : { runtimeHint: RUNTIME_HINT[ecosystem]! }),
      ...(definition !== undefined &&
      hasResource(definition, 'prex.registry.package-build/1')
        ? {}
        : { extensions: { 'dev.openpacker.buildable': false } }),
      requirements,
    });
  }

  if (distributions.length === 0)
    throw new OpmError(
      'NOT_FOUND',
      `No project in ${input.root} ships to an ecosystem with a project format, ` +
        'so there is nothing to describe. Add a package.json, .csproj or similar first.',
    );

  const manifest: PackageManifest = {
    packageManifestVersion: '1',
    name: input.name ?? projectName(input.manifest),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    version: input.version ?? '0.0.0',
    registries: registries.sort((left, right) =>
      left.registryId < right.registryId ? -1 : 1,
    ),
    distributions: distributions.sort((left, right) =>
      left.purlType < right.purlType ? -1 : 1,
    ),
    provenance: {
      producedBy: input.producer,
      producedAt: input.producedAt,
      // Nothing was verified in the act of writing this document. Claiming
      // otherwise is the failure mode a provenance block exists to prevent.
      verified: [],
    },
    ...(semanticLoss.length > 0 ? { semanticLoss } : {}),
  };

  const bytes = canonicalBytes(manifest as unknown as JsonValue);
  return {
    manifest,
    bytes,
    digest: await canonicalDigest(manifest as unknown as JsonValue),
  };
}

/**
 * Record a packed artifact against its distribution.
 *
 * Kept separate from assembly because a digest is a fact about bytes that
 * exist; a manifest built before packing should not carry one.
 */
export function withPackedArtifact(
  manifest: PackageManifest,
  purlType: string,
  artifact: {
    digest: string;
    size: number;
    mediaType: string;
    nativeIntegrity?: { algorithm: string; value: string; encoding: string };
    locations?: readonly string[];
  },
): PackageManifest {
  return {
    ...manifest,
    distributions: manifest.distributions.map((distribution) =>
      distribution.purlType === purlType
        ? {
            ...distribution,
            digest: parseDigestString(artifact.digest),
            size: artifact.size,
            mediaType: artifact.mediaType,
            ...(artifact.nativeIntegrity === undefined
              ? {}
              : {
                  nativeIntegrity: artifact.nativeIntegrity as {
                    algorithm: string;
                    value: string;
                    encoding: 'hex' | 'base64' | 'sri';
                  },
                }),
            ...(artifact.locations === undefined
              ? {}
              : { locations: [...artifact.locations] }),
          }
        : distribution,
    ),
    provenance: {
      ...manifest.provenance,
      // The bytes were hashed to produce this, so that much is checked.
      verified: [
        ...new Set([
          ...(manifest.provenance?.verified ?? []),
          'artifact-digest' as const,
        ]),
      ],
    },
  };
}

function parseDigestString(value: string): Digest {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match)
    throw new OpmError(
      'INVALID_DIGEST',
      `Expected a sha256 digest, got "${value}"`,
    );
  const digest: Digest = { algorithm: 'sha256', value: match[1]! };
  // Round-trips through the canonical formatter so an invalid pair cannot be
  // written into a published document.
  formatDigest(digest);
  return digest;
}

function projectName(manifest: OpmManifest): string {
  return manifest.project.name;
}

function rangeOf(manifest: OpmManifest, pkg: LockPackage): string | undefined {
  return manifest.packages[pkg.alias]?.version ?? pkg.version;
}

/** npm scopes are percent-encoded in a PURL; other types are not special. */
function encodeIdentifier(identifier: string): string {
  return identifier
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function serviceIndexOf(definition: {
  resources: readonly { '@id': string; '@type': unknown }[];
}): string | undefined {
  for (const resource of definition.resources) {
    const types = Array.isArray(resource['@type'])
      ? resource['@type']
      : [resource['@type']];
    if (types.includes('prex.registry.service-index/1')) return resource['@id'];
  }
  return undefined;
}

function noProjectLoss(ecosystem: string): SemanticLoss {
  return {
    code: 'NATIVE_DISTRIBUTION_ABSENT',
    severity: 'info',
    sourceEcosystem: ecosystem,
    sourcePath: `/distributions/${ecosystem}`,
    originalMeaning: `The project depends on ${ecosystem} packages`,
    representedMeaning:
      'The dependency is recorded but no distribution is listed',
    omittedMeaning: `This project has no ${ecosystem} project file, so it does not itself ship to ${ecosystem}`,
    mitigation: `Add an ${ecosystem} project file if this package should be published there.`,
    blocksProfile: [],
  };
}
