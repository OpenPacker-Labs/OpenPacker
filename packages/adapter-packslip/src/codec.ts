import { canonicalDigest } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  JsonValue,
  PackageIdentity,
  PackageInstance,
  SemanticLoss,
  VersionConstraint,
} from '@openpacker/contracts';
import {
  ProviderError,
  compareParsedVersions,
  evaluateSemverRange,
  formatPurl,
  packageNodeId,
  parsePurl,
  parseSemver,
  parseSemverRange,
  rangeToConstraint,
  semanticLoss,
  sourceRef,
  type EcosystemCodec,
  type LockCapture,
  type NativeCoordinate,
  type ParsedRange,
  type ParsedVersion,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';
import {
  PackslipError,
  isSemver,
  parseProject,
  type ResolvedRelease,
} from '@openpacker/packslip';
import { formatPackslipPurl, parsePackslipPurl } from './purl.js';

/** What a verified release looks like to the codec. */
export interface PackslipMetadata {
  readonly resolved: ResolvedRelease;
  /** Where the selected artifact is downloaded from. */
  readonly artifactUrl: string;
}

const SEMANTICS = 'packslip-v1';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  'tar.gz': 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  zip: 'application/zip',
};

export function mediaTypeOf(format: string): string {
  return MEDIA_TYPES[format] ?? 'application/octet-stream';
}

export function packslipIdentity(
  exactPurl: string,
  endpoint?: string,
): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'packslip',
    name: parsed.name,
    ...(parsed.namespace !== undefined && { namespace: parsed.namespace }),
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'packslip',
        coordinate: [parsed.namespace, parsed.name]
          .filter((part): part is string => part !== undefined)
          .join('/'),
        ...(parsed.version !== undefined && { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('packslip', endpoint)],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  return identity;
}

/**
 * Packslip carries no dependency graph and no native range language, so what
 * the codec offers is the version semantics the specification does fix: strict
 * semver precedence, and requests that name a prefix of the components (`20`,
 * `3.12`), which npm's partial-version ranges express exactly.
 */
export class PackslipCodec implements EcosystemCodec<PackslipMetadata, never> {
  readonly purlType = 'packslip' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    const name = at <= 0 ? trimmed : trimmed.slice(0, at);
    const version = at <= 0 ? undefined : trimmed.slice(at + 1);
    try {
      parseProject(name);
    } catch (error) {
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        error instanceof PackslipError ? error.message : String(error),
      );
    }
    if (version !== undefined && !isSemver(version))
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `"${version}" is not a semantic version`,
      );
    return {
      ecosystem: 'packslip',
      name,
      original: value,
      ...(version !== undefined && { version }),
    };
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePackslipPurl(value);
    return formatPackslipPurl(parsed.project, parsed.version, parsed.variant);
  }

  parseNativeVersion(value: string): ParsedVersion {
    // adapter-core's parser tolerates a leading v and short versions; packslip
    // signs only strict semantic versions, so anything else is not one.
    if (!isSemver(value))
      throw new ProviderError(
        'INVALID_NATIVE_VERSION',
        `Invalid version: ${value}`,
      );
    return parseSemver(value, 3);
  }

  compareNativeVersions(left: string, right: string): number {
    return compareParsedVersions(
      this.parseNativeVersion(left),
      this.parseNativeVersion(right),
    );
  }

  parseNativeRange(value: string): ParsedRange {
    return parseSemverRange(value, {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    });
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    return evaluateSemverRange(
      version,
      typeof range === 'string' ? this.parseNativeRange(range).ast : range.ast,
      (left, right) => this.compareNativeVersions(left, right),
    );
  }

  async translateMetadata(
    metadata: PackslipMetadata,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const { resolved } = metadata;
    const { statement, artifact } = resolved;
    const variant = artifact.variant;
    const exactPurl = formatPackslipPurl(
      resolved.project,
      statement.version,
      variant,
    );
    const nodeId = await packageNodeId({
      exactPurl,
      ...(variant !== undefined && { qualifiers: { variant } }),
      nativeSemanticsVersion: SEMANTICS,
    });
    const subject = statement.subjects.find(
      (entry) => entry.name === artifact.name,
    );
    const losses: SemanticLoss[] = [];
    if ((artifact.provenance?.length ?? 0) > 0)
      losses.push(
        semanticLoss(
          'packslip',
          'PACKSLIP_PROVENANCE_NOT_VERIFIED',
          '/artifact/provenance',
          'The release links build provenance for this artifact. packslip authenticates the release statement, not how the artifact was built; the provenance was not fetched or verified',
          'The release statement and artifact digest are verified',
          'info',
        ),
      );
    if (resolved.resources.length > 0)
      losses.push(
        semanticLoss(
          'packslip',
          'PACKSLIP_RESOURCES_NOT_INSTALLED',
          '/resources',
          'The release declares completions, man pages, skills or other resources. opm installs the verified archive and its executables; resources are not linked into shells or agents',
          'Resources that live inside the archive remain in the store tree',
          'info',
        ),
      );
    const artifactDescriptor: ArtifactDescriptor = {
      descriptorId: `${nodeId}:archive`,
      digest: { algorithm: 'sha256', value: subject?.sha256 ?? '' },
      size: artifact.size,
      mediaType: mediaTypeOf(artifact.format),
      artifactType: `application/vnd.openpacker.packslip.artifact.v1+${artifact.format}`,
      fileName: artifact.name,
      nativeRole: 'package-archive',
      locations: [
        {
          transport: 'https',
          uri: metadata.artifactUrl,
          priority: 0,
          rangeSupported: false,
        },
      ],
      referrers: [],
      externalRefs: [],
    };
    // SAFETY: Every value below is a string, boolean, number or array of those.
    const data = {
      project: statement.project,
      tag: resolved.candidate.tag ?? null,
      artifact: artifact.name,
      os: artifact.os ?? null,
      arch: artifact.arch ?? null,
      libc: artifact.libc ?? null,
      variant: variant ?? null,
      format: artifact.format,
      signer: resolved.verified.signer.identity,
      bundleDigest: resolved.verified.bundleDigest,
      logged: resolved.verified.logged,
      publishedAt: statement.publishedAt,
    } as JsonValue;
    const instance: PackageInstance = {
      nodeId,
      identity: packslipIdentity(exactPurl, provenance.endpoint),
      nativeVersion: statement.version,
      normalizedVersion: this.parseNativeVersion(statement.version).normalized,
      versionSortKey: this.parseNativeVersion(statement.version).normalized,
      requirements: [],
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts: [artifactDescriptor],
      lifecycle: { status: 'published', eligible: true, warnings: [] },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: { version: SEMANTICS, data },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    _lock: never,
    _provenance: TranslationProvenance,
  ): LockCapture {
    // packslip has no native lockfile to import; refusing is the honest answer.
    throw new ProviderError(
      'UNSUPPORTED_OPERATION',
      'packslip releases have no native lockfile to import',
    );
  }
}

/** A stable digest of the signed statement a release was resolved from. */
export async function metadataDigestOf(payload: JsonValue) {
  return canonicalDigest(payload);
}
