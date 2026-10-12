import { createHash } from 'node:crypto';
import {
  canonicalDigest,
  formatDigest,
  parseCanonicalJson,
  sha256,
} from '@openpacker/canonical';
import type {
  JsonValue,
  PackageIdentity,
  SourceSnapshot,
} from '@openpacker/contracts';
import {
  ProviderError,
  assertPackageIdentityMatchesRequest,
  compareCodePoints,
  type CatalogProvider,
  type Clock,
  type ProviderAttestation,
  type ProviderCapabilities,
  type ProviderExecutable,
  type ProviderInspection,
  type ProviderRecord,
  type ProviderWarning,
} from '@openpacker/adapter-core';
import {
  PackslipError,
  chooseRecommendation,
  detectHost,
  discoverReleases,
  fetchArtifact,
  githubAssetUrl,
  parseProjectInput,
  rankCandidates,
  resolveRelease,
  type DetectedHost,
  type Fetcher,
  type GithubEndpoints,
  type ResolvedRelease,
  type SignerConfig,
} from '@openpacker/packslip';
import {
  PackslipCodec,
  mediaTypeOf,
  packslipIdentity,
  type PackslipMetadata,
} from './codec.js';
import { basePurl, formatPackslipPurl, parsePackslipPurl } from './purl.js';
import { encodeRecord, type PriorAttestation } from './record.js';
import { trustKey, type PackslipSettings } from './settings.js';

/**
 * The archive formats opm's materializer can unpack, best first. A release that
 * ships only `tar.xz` or `tar.zst` has no artifact opm can install, and says so
 * rather than being fetched and failing to unpack.
 */
export const INSTALLABLE_FORMATS: readonly string[] = [
  'tar.gz',
  'tgz',
  'zip',
  'tar',
];

/** The materializer refuses a larger archive; refusing early names the cause. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const RESOLUTION_TTL_MS = 5 * 60 * 1000;

/**
 * A resolution holds the signed bundle and, once fetched, the archive (up to
 * `MAX_ARCHIVE_BYTES`). A long-lived host would otherwise keep every release it
 * ever resolved, so what has expired is dropped and only the newest few kept.
 */
const RESOLUTION_CACHE_ENTRIES = 8;

/** One verified resolution, shared by the calls opm makes about the same release. */
interface Resolution {
  readonly resolved: ResolvedRelease;
  readonly artifactUrl: string;
  bytes?: Promise<Uint8Array> | undefined;
}

/**
 * opm asks the same questions of a provider several times while it resolves one
 * package — to find the artifact, to capture policy facts, to fetch the bytes.
 * Verification is the expensive part, so it is done once per release and shared;
 * a failure is never remembered, so a retry asks again.
 */
export class ResolutionCache {
  readonly #entries = new Map<
    string,
    { at: number; value: Promise<Resolution> }
  >();

  get(key: string, make: () => Promise<Resolution>): Promise<Resolution> {
    const existing = this.#entries.get(key);
    if (existing !== undefined && Date.now() - existing.at < RESOLUTION_TTL_MS)
      return existing.value;
    this.#evict();
    const value = make();
    this.#entries.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }

  #evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries)
      if (now - entry.at >= RESOLUTION_TTL_MS) this.#entries.delete(key);
    // Map iteration is insertion order: the oldest go first.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < RESOLUTION_CACHE_ENTRIES) break;
      this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export interface PackslipProviderOptions {
  readonly clock: Clock;
  readonly fetcher: Fetcher;
  readonly settings: PackslipSettings;
  /** What the lock remembers, by versionless PURL. */
  readonly prior: Readonly<Record<string, PriorAttestation>>;
  readonly trustedRoot?: string;
  readonly host?: DetectedHost;
  readonly endpoints?: GithubEndpoints;
  readonly cache?: ResolutionCache;
}

/** Map a library refusal onto the provider error codes opm already knows how to report. */
export function asProviderError(error: Error): Error {
  if (!(error instanceof PackslipError)) return error;
  const codes: Record<PackslipError['code'], string> = {
    INVALID_INPUT: 'INVALID_PACKSLIP_INPUT',
    // Packslip's own codes, so a malformed signed release is not reported under
    // the shared code other registries use for a glitchy upstream response.
    INVALID_STATEMENT: 'INVALID_PACKSLIP_METADATA',
    INVALID_BUNDLE: 'INVALID_PACKSLIP_METADATA',
    VERIFICATION_FAILED: 'SIGNATURE_VERIFICATION_FAILED',
    SIGNER_MISMATCH: 'SIGNATURE_VERIFICATION_FAILED',
    PIN_MISMATCH: 'SIGNATURE_VERIFICATION_FAILED',
    UNLOGGED: 'SIGNATURE_VERIFICATION_FAILED',
    TRUST_CHANGE: 'TRUST_CHANGE_REQUIRES_APPROVAL',
    DOWNGRADE: 'TRUST_CHANGE_REQUIRES_APPROVAL',
    PROJECT_MISMATCH: 'SIGNATURE_VERIFICATION_FAILED',
    DIGEST_MISMATCH: 'DIGEST_MISMATCH',
    SIZE_MISMATCH: 'SIZE_MISMATCH',
    LIST_EXPIRED: 'SIGNATURE_VERIFICATION_FAILED',
    LIST_ROLLBACK: 'SIGNATURE_VERIFICATION_FAILED',
    LIST_MISSING: 'SIGNATURE_VERIFICATION_FAILED',
    NO_RELEASE: 'VERSION_NOT_FOUND',
    NO_ARTIFACT: 'ARTIFACT_NOT_FOUND',
    AMBIGUOUS_ARTIFACT: 'INVALID_PACKSLIP_METADATA',
    HOST_INCOMPATIBLE: 'HOST_INCOMPATIBLE',
    UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
    OFFLINE: 'OFFLINE',
  };
  return new ProviderError(codes[error.code], error.message);
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asProviderError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * A keyless identity names a workflow at a ref (`…/release.yml@refs/tags/v1`);
 * policy allow-lists want the workflow. Only a trailing `@refs/…` is a ref: an
 * email identity (`alice@example.com`) is whole, and cutting it at its `@`
 * would let an allow-list entry for `alice` match every `alice@…`.
 */
export function withoutRef(identity: string): string {
  return identity.replace(/@refs\/.*$/su, '');
}

/**
 * `trusted-publisher` is the strongest thing a packslip can show: a CI identity
 * bound to a repository, recorded in a transparency log, vouching for its own
 * release. A signer with no repository behind it (an email identity), or a
 * repackager vouching for someone else's release, is a registry-style
 * attestation however well it was logged.
 */
export function trustTierFor(facts: {
  readonly keyless: boolean;
  readonly logged: boolean;
  readonly repositoryId: string | undefined;
  readonly attestedBy: 'vendor' | 'repackager';
}): 'trusted-publisher' | 'registry-attested' {
  return facts.keyless &&
    facts.logged &&
    facts.repositoryId !== undefined &&
    facts.attestedBy === 'vendor'
    ? 'trusted-publisher'
    : 'registry-attested';
}

export class PackslipProvider implements CatalogProvider {
  readonly providerId = 'packslip-release';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['packslip'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: false,
    extensions: { 'openpacker.dev/packslip-release': 1 },
  };
  readonly #codec = new PackslipCodec();
  readonly #cache: ResolutionCache;
  readonly #seen = new Map<string, string>();

  constructor(private readonly options: PackslipProviderOptions) {
    this.#cache = options.cache ?? new ResolutionCache();
  }

  invalidate(): void {
    this.#cache.clear();
  }

  #signer(project: string): SignerConfig {
    return this.options.settings.signers[trustKey(project)] ?? {};
  }

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    return guarded(async () => {
      const text = query.trim();
      if (text.startsWith('pkg:'))
        return [packslipIdentity(this.#codec.canonicalizePurl(text))];
      // `packslip:github.com/jdx/hk@2.5.0`, `github.com/jdx/hk`, or `jdx/hk`.
      const spec = text.replace(/^packslip:/u, '');
      const at = spec.lastIndexOf('@');
      const name = at <= 0 ? spec : spec.slice(0, at);
      const version = at <= 0 ? undefined : spec.slice(at + 1);
      return [
        packslipIdentity(
          this.#codec.canonicalizePurl(
            formatPackslipPurl(parseProjectInput(name), version),
          ),
        ),
      ];
    });
  }

  async enumerate(base: string): Promise<readonly string[]> {
    return guarded(async () => {
      const { project, variant } = parsePackslipPurl(base);
      const key = basePurl(base);
      const prior = this.options.prior[key];
      const { discovery } = await discoverReleases({
        project,
        signer: this.#signer(project.name),
        fetcher: this.options.fetcher,
        now: new Date(this.options.clock.now()),
        ...(prior !== undefined && {
          memory: prior.memory,
          listMemory: prior.list,
        }),
        ...(this.options.trustedRoot !== undefined && {
          trustedRoot: this.options.trustedRoot,
        }),
        ...(this.options.endpoints !== undefined && {
          endpoints: this.options.endpoints,
        }),
      });
      const ranking = rankCandidates(
        discovery.candidates,
        { spec: 'latest', prerelease: false },
        chooseRecommendation(discovery.signedLatest, discovery.githubLatest),
      );
      // opm takes the last entry as the newest. The best release comes first in
      // the ranking — the vendor's recommendation when it is eligible, else the
      // highest version — so reversing puts it last and the rest in ascending order.
      return [...ranking.ordered]
        .reverse()
        .map((candidate) =>
          formatPackslipPurl(project, candidate.version, variant),
        );
    });
  }

  async #resolution(exactPurl: string): Promise<Resolution> {
    const parsed = parsePackslipPurl(exactPurl);
    if (parsed.version === undefined)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'inspect requires an exact packslip PURL',
      );
    const key = basePurl(exactPurl);
    const prior = this.options.prior[key];
    const signer = this.#signer(parsed.project.name);
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          exactPurl,
          signer,
          this.options.settings.approvals,
          this.options.settings.allowIncompatibleHost,
          prior?.memory ?? null,
          prior?.list ?? null,
          this.options.trustedRoot ?? null,
        ]),
      )
      .digest('hex');
    const resolution = await this.#cache.get(identity, async () => {
      const resolved = await resolveRelease({
        project: parsed.project,
        request: { spec: parsed.version ?? '', prerelease: false },
        signer,
        ...(prior !== undefined && {
          memory: prior.memory,
          listMemory: prior.list,
        }),
        approvals: this.options.settings.approvals,
        fetcher: this.options.fetcher,
        now: new Date(this.options.clock.now()),
        host: this.options.host ?? detectHost(),
        formats: INSTALLABLE_FORMATS,
        ...(parsed.variant !== undefined && { variant: parsed.variant }),
        allowIncompatibleHost: this.options.settings.allowIncompatibleHost,
        ...(this.options.trustedRoot !== undefined && {
          trustedRoot: this.options.trustedRoot,
        }),
        ...(this.options.endpoints !== undefined && {
          endpoints: this.options.endpoints,
        }),
      });
      if (resolved.statement.version !== parsed.version)
        throw new PackslipError(
          'NO_RELEASE',
          `${parsed.project.name} has no release ${parsed.version}`,
        );
      const { artifact } = resolved;
      if (artifact.size > MAX_ARCHIVE_BYTES)
        throw new ProviderError(
          'ARTIFACT_TOO_LARGE',
          `${artifact.name} is ${artifact.size} bytes; opm unpacks archives of at most ${MAX_ARCHIVE_BYTES}`,
        );
      let artifactUrl = artifact.url;
      if (artifactUrl === undefined) {
        if (
          parsed.project.forge !== 'github' ||
          resolved.candidate.tag === undefined
        )
          throw new PackslipError(
            'UNAVAILABLE',
            `${artifact.name} declares no download URL and none can be derived for ${parsed.project.name}`,
          );
        artifactUrl = githubAssetUrl(
          parsed.project,
          resolved.candidate.tag,
          artifact.name,
          this.options.endpoints,
        );
      }
      return { resolved, artifactUrl };
    });
    // Recorded here and not where the resolution is made: a second provider
    // sharing the process-wide cache never makes one, and a snapshot must not
    // depend on whether somebody else warmed it.
    this.#seen.set(exactPurl, resolution.resolved.verified.bundleDigest);
    return resolution;
  }

  async inspect(exactPurl: string): Promise<ProviderInspection> {
    return guarded(async () => {
      const canonical = this.#codec.canonicalizePurl(exactPurl);
      const { resolved, artifactUrl } = await this.#resolution(canonical);
      const retrievedAt = this.options.clock.now();
      const payload = parseCanonicalJson(resolved.verified.payload);
      const metadataDigest = await canonicalDigest(payload);
      const metadata: PackslipMetadata = { resolved, artifactUrl };
      const translated = await this.#codec.translateMetadata(metadata, {
        providerId: this.providerId,
        endpoint: resolved.candidate.bundleUrl,
        retrievedAt,
        evaluationTime: retrievedAt,
        metadataDigest,
        rawMetadataRef: {
          type: 'provider-metadata',
          locator: `urn:openpacker:packslip:${resolved.project.name}:${resolved.statement.version}`,
          digest: metadataDigest,
          mediaType: 'application/vnd.in-toto+json',
        },
      });
      assertPackageIdentityMatchesRequest(
        canonical,
        translated.instance.identity,
      );
      const { verified, statement, artifact } = resolved;
      const record: ProviderRecord = {
        key: canonical,
        endpoint: resolved.candidate.bundleUrl,
        // The fields opm's fact capture reads from a registry record: the
        // version it describes, and nothing that claims install scripts.
        body: {
          version: statement.version,
          project: statement.project,
          // The time the release is proven to have existed, which is what the
          // minimum-release-age rule measures. The statement's own
          // `published_at` is the signer's word and could be back-dated to
          // look old, so it is offered only as `statedPublishedAt`, which
          // nothing treats as a clock. With no verified time there is no
          // `publishedAt`, and policy sees a release whose age is unknown.
          ...(verified.integratedTime !== undefined && {
            publishedAt: verified.integratedTime,
          }),
          statedPublishedAt: statement.publishedAt,
          ...(resolved.candidate.tag !== undefined && {
            tag: resolved.candidate.tag,
          }),
        },
        rawBody: resolved.bundle,
        retrievedAt,
      };
      const executables: ProviderExecutable[] = (artifact.bin ?? []).map(
        (bin) => ({
          name: bin.name,
          path: bin.path,
          interpreter: 'native',
        }),
      );
      const warnings: ProviderWarning[] = [
        ...resolved.requirements.warnings.map((message) => ({
          code: 'PACKSLIP_HOST_REQUIREMENT',
          message,
        })),
        ...resolved.notes.map((message) => ({
          code: 'PACKSLIP_NOTE',
          message,
        })),
        ...(executables.length === 0
          ? [
              {
                code: 'PACKSLIP_NO_EXECUTABLES',
                message: `${artifact.name} declares no executables, so opm will install it without any command to run`,
              },
            ]
          : []),
      ];
      const keyless = verified.signer.scheme === 'sigstore-oidc';
      const attestation: ProviderAttestation = {
        kind: 'packslip',
        signerIdentity: keyless
          ? withoutRef(verified.signer.identity)
          : verified.signer.identity,
        ...(verified.signer.issuer !== undefined && {
          issuer: verified.signer.issuer,
        }),
        signedAt: verified.integratedTime ?? statement.publishedAt,
        signedAtVerified: verified.integratedTime !== undefined,
        // A repository-bound CI identity recorded in a transparency log is the
        // strongest thing a packslip can show; a key the project pinned is a
        // vendor attestation without a CI identity behind it.
        trustTier: trustTierFor({
          keyless,
          logged: verified.logged,
          repositoryId: verified.signer.repositoryId,
          attestedBy: resolved.memory.attestedBy,
        }),
        // `sigstore` means Sigstore's own PKI vouched for the signer. A key
        // the project pinned is the project's trust anchor, not Sigstore's, so
        // it must not satisfy a policy that asks for Sigstore evidence.
        evidence: [
          'packslip',
          ...(keyless ? ['sigstore'] : []),
          ...(verified.logged ? ['sigstore-transparency'] : []),
        ],
        record: encodeRecord(resolved),
        // The list's sequence rises with every release the vendor publishes,
        // so it is not part of what makes this release the same release.
        advancing: ['list'],
      };
      return {
        package: translated.instance,
        record,
        executables,
        attestation,
        warnings,
      };
    });
  }

  async fetchArtifactRecord(exactPurl: string): Promise<ProviderRecord> {
    return guarded(async () => {
      const inspection = await this.inspect(exactPurl);
      const canonical = this.#codec.canonicalizePurl(exactPurl);
      const resolution = await this.#resolution(canonical);
      const { resolved, artifactUrl } = resolution;
      resolution.bytes ??= fetchArtifact(
        this.options.fetcher,
        resolved.statement,
        resolved.artifact,
        artifactUrl,
      );
      const bytes = await resolution.bytes.catch((error: Error) => {
        resolution.bytes = undefined;
        throw error;
      });
      const descriptor = inspection.package.artifacts[0];
      if (descriptor === undefined)
        throw new ProviderError(
          'ARTIFACT_NOT_FOUND',
          `No artifact for ${canonical}`,
        );
      const digest = await sha256(bytes);
      return {
        key: canonical,
        endpoint: artifactUrl,
        body: {
          ...descriptor,
          digest,
          size: bytes.byteLength,
          mediaType: mediaTypeOf(resolved.artifact.format),
        },
        rawBody: bytes,
        retrievedAt: inspection.record.retrievedAt,
      };
    });
  }

  async snapshot(evaluationTime: string): Promise<SourceSnapshot> {
    const records = await Promise.all(
      [...this.#seen.entries()]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(async ([key, digest]) => ({ key, digest })),
    );
    // SAFETY: records is an array of {key, digest} string pairs.
    const recordsDigest = await canonicalDigest(records as JsonValue);
    const revision = formatDigest(recordsDigest);
    const retrievedAt = this.options.clock.now();
    // SAFETY: every field below is a string or an array of string pairs.
    const rootDigest = await canonicalDigest({
      providerId: this.providerId,
      providerType: 'packslip-release',
      endpointIdentity: 'packslip',
      retrievedAt,
      evaluationTime,
      revision,
      records,
    } as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'packslip-release',
      endpointIdentity: 'packslip',
      retrievedAt,
      evaluationTime,
      revision,
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }
}
