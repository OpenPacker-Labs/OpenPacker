import {
  collectStream,
  verifyBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import {
  canonicalDigest,
  compareCanonicalStrings,
  formatDigest,
} from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Capabilities,
  CatalogImportRequest,
  CatalogImportResponse,
  CatalogSnapshotRequest,
  CatalogSnapshotResponse,
  EnumerateRequest,
  EnumerateResponse,
  EvidenceResult,
  ExplainRequest,
  ExplainResponse,
  ExplanationGraph,
  IdentifyRequest,
  IdentifyResponse,
  InspectRequest,
  InspectResponse,
  JsonValue,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LockImportRequest,
  LockImportResponse,
  MaterializeRequest,
  MaterializeResponse,
  NormalizeRequest,
  NormalizeResponse,
  PackageIdentity,
  PackageInstance,
  PackRequest,
  PackResponse,
  ProtocolMeta,
  PublishRequest,
  PublishResponse,
  ResolutionReceipt,
  ResolutionUniverse,
  SignedReceipt,
  SolveRequest,
  SolveResponse,
  SourceSnapshot,
  VerifyRequest,
  VerifyResponse,
  Warning,
} from '@openpacker/contracts';
import {
  formatPurl,
  parsePurl,
  parseVers,
  type Ecosystem,
  type EcosystemCodec,
} from '@openpacker/adapter-core';
import { NpmCodec } from '@openpacker/adapter-npm';
import { CargoCodec } from '@openpacker/adapter-cargo';
import { NugetCodec } from '@openpacker/adapter-nuget';
import { PypiCodec } from '@openpacker/adapter-pypi';
import { GolangCodec } from '@openpacker/adapter-golang';
import { MavenCodec } from '@openpacker/adapter-maven';
import type { EmbeddedResolver } from '@openpacker/embedded';
import {
  completeLockImport,
  planNativeLockImport,
  type LockFormat,
} from '@openpacker/lock-import';
import { signReceipt, verifySignedReceipt } from '@openpacker/receipts';
import type { Signer, Verifier } from '@openpacker/trust';
import type { OpenPackerStateStore } from './store.js';

export interface OperationContext {
  signal: AbortSignal;
  correlationId: string;
  traceparent?: string;
  tracestate?: string;
  idempotencyKey?: string;
  offline: boolean;
  store: OpenPackerStateStore;
}

export interface PrexOperations {
  capabilities?(meta: ProtocolMeta): Capabilities;
  normalize(
    input: NormalizeRequest,
    context: OperationContext,
  ): Promise<NormalizeResponse>;
  identify(
    input: IdentifyRequest,
    context: OperationContext,
  ): Promise<IdentifyResponse>;
  enumerate(
    input: EnumerateRequest,
    context: OperationContext,
  ): Promise<EnumerateResponse>;
  inspect(
    input: InspectRequest,
    context: OperationContext,
  ): Promise<InspectResponse>;
  solve(input: SolveRequest, context: OperationContext): Promise<SolveResponse>;
  materialize(
    input: MaterializeRequest,
    context: OperationContext,
  ): Promise<MaterializeResponse>;
  verify(
    input: VerifyRequest,
    context: OperationContext,
  ): Promise<VerifyResponse>;
  explain(
    input: ExplainRequest,
    context: OperationContext,
  ): Promise<ExplainResponse>;
  catalogImport(
    input: CatalogImportRequest,
    context: OperationContext,
  ): Promise<CatalogImportResponse>;
  catalogSnapshot(
    input: CatalogSnapshotRequest,
    context: OperationContext,
  ): Promise<CatalogSnapshotResponse>;
  lockImport(
    input: LockImportRequest,
    context: OperationContext,
  ): Promise<LockImportResponse>;
  lifecycleApply(
    input: LifecycleApplyRequest,
    context: OperationContext,
  ): Promise<LifecycleApplyResponse>;
  pack(input: PackRequest, context: OperationContext): Promise<PackResponse>;
  publish(
    input: PublishRequest,
    context: OperationContext,
  ): Promise<PublishResponse>;
}

export interface ReferenceExtensionOperations {
  lifecycleApply(
    input: LifecycleApplyRequest,
    context: OperationContext,
  ): Promise<LifecycleApplyResponse>;
  pack(input: PackRequest, context: OperationContext): Promise<PackResponse>;
  publish(
    input: PublishRequest,
    context: OperationContext,
  ): Promise<PublishResponse>;
}

export interface ReferenceOperationsOptions {
  universe: ResolutionUniverse;
  resolver: EmbeddedResolver;
  meta: ProtocolMeta;
  resolverBuildDigest: { algorithm: 'sha256'; value: string };
  extensions: ReferenceExtensionOperations;
  artifactSource?: ArtifactSource;
  receiptSigners?: readonly Signer[];
  receiptVerifiers?: ReadonlyMap<string, Verifier>;
  verificationChecks?: ReadonlyMap<string, EvidenceCheck>;
}

export interface EvidenceCheckInput {
  request: VerifyRequest;
  check: string;
  subjectDigest: { algorithm: 'sha256'; value: string };
}

export interface EvidenceCheckResult {
  status: EvidenceResult['status'];
  diagnostics?: Warning[];
}

export type EvidenceCheck = (
  input: EvidenceCheckInput,
  context: OperationContext,
) => EvidenceCheckResult | Promise<EvidenceCheckResult>;

export function createReferenceOperations(
  options: ReferenceOperationsOptions,
): PrexOperations {
  const codecs = new Map<Ecosystem, EcosystemCodec>([
    ['npm', new NpmCodec()],
    ['cargo', new CargoCodec()],
    ['nuget', new NugetCodec()],
    ['pypi', new PypiCodec()],
    ['golang', new GolangCodec()],
    ['maven', new MavenCodec()],
  ]);
  const explanations = new Map<string, ExplanationGraph>();
  const instances = () => options.universe.packages;

  return {
    capabilities: (meta) =>
      defaultCapabilities(meta, capabilityFeatures(options)),

    async normalize(input) {
      return {
        meta: options.meta,
        results: input.items.map((item) => normalizeItem(item, codecs)),
      };
    },

    async identify(input) {
      const query = input.query;
      let purl: string | undefined;
      if (query.purl) purl = canonicalPurl(query.purl, codecs);
      else if (query.nativeCoordinate && query.ecosystem) {
        const codec = codecFor(query.ecosystem, codecs);
        const coordinate = codec.parseNativeCoordinate(query.nativeCoordinate);
        purl = formatPurl({
          type: coordinate.ecosystem,
          ...(coordinate.namespace === undefined
            ? {}
            : { namespace: coordinate.namespace }),
          name: coordinate.name,
          ...(coordinate.version === undefined
            ? {}
            : { version: coordinate.version }),
          qualifiers: {},
        });
        purl = codec.canonicalizePurl(purl);
      }
      const candidates = identityCandidates(instances(), purl, query.alias);
      return {
        meta: options.meta,
        status:
          candidates.length === 0
            ? 'not-found'
            : candidates.length === 1
              ? 'identified'
              : 'ambiguous',
        candidates,
      };
    },

    async enumerate(input) {
      const canonical = canonicalPurl(input.canonicalPurl, codecs);
      const parsed = parsePurl(canonical);
      if (parsed.version !== undefined)
        throw operationError('INVALID_PURL', 'Enumerate requires a base PURL');
      const codec = codecFor(parsed.type, codecs);
      const ordered = instances()
        .filter((item) => item.identity.canonicalPurl === canonical)
        .filter(
          (item) =>
            input.lifecyclePolicy.includeYanked ||
            item.lifecycle.status !== 'yanked',
        )
        .filter(
          (item) =>
            input.lifecyclePolicy.includeDelisted ||
            item.lifecycle.status !== 'delisted',
        )
        .filter(
          (item) =>
            input.vers === undefined ||
            options.resolver.versionSatisfies(
              item.normalizedVersion,
              input.vers,
            ),
        )
        .sort(
          (left, right) =>
            codec.compareNativeVersions(
              left.normalizedVersion,
              right.normalizedVersion,
            ) || compareCanonicalStrings(left.nodeId, right.nodeId),
        );
      const start =
        input.page.cursor === undefined ? 0 : parseCursor(input.page.cursor);
      const page = ordered.slice(start, start + input.page.size);
      const versions = page.map((item) => ({
        exactPurl: requiredExactPurl(item),
        originalVersion: item.nativeVersion,
        normalizedVersion: item.normalizedVersion,
        sortKey: item.versionSortKey,
        lifecycle: item.lifecycle,
        artifacts: item.artifacts,
        sourceSnapshot:
          item.sourceSnapshots[0] ??
          options.universe.sourceSnapshots[0]?.rootDigest ??
          options.universe.canonicalDigest,
        metadataDigest: item.metadataDigest,
        warnings: [] as Warning[],
      }));
      const next = start + page.length;
      return {
        meta: options.meta,
        versions,
        ...(next < ordered.length ? { nextCursor: String(next) } : {}),
      };
    },

    async inspect(input) {
      const exact = input.exact;
      const found =
        'exactPurl' in exact
          ? instances().find(
              (item) =>
                item.identity.exactPurl ===
                canonicalPurl(exact.exactPurl, codecs),
            )
          : instances().find((item) =>
              item.identity.nativeCoordinates.some(
                (native) =>
                  native.ecosystem === exact.ecosystem &&
                  `${native.coordinate}${native.version ? `@${native.version}` : ''}` ===
                    exact.coordinate,
              ),
            );
      if (!found)
        throw operationError(
          'VERSION_NOT_FOUND',
          'Exact package instance was not found',
        );
      return { meta: options.meta, package: found };
    },

    async solve(input) {
      const embeddedInput = { request: input, universe: options.universe };
      let output;
      try {
        output = options.resolver.solve(embeddedInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNSATISFIABLE:'))
          throw operationError('UNSATISFIABLE', message);
        if (message.includes('unsupported semantics profile:'))
          throw operationError('UNSUPPORTED_SEMANTICS_PROFILE', message);
        throw error;
      }
      const check = options.resolver.check(embeddedInput, output);
      if (!check.valid)
        throw operationError(
          'INTERNAL_ERROR',
          `Independent proof check failed: ${check.diagnostics.join('; ')}`,
        );
      const explanation = output.explanation as unknown as ExplanationGraph;
      const proofDigest = await canonicalDigest(
        output.proof as unknown as JsonValue,
      );
      const explanationDigest = await canonicalDigest(
        explanation as unknown as JsonValue,
      );
      const artifactSetDigest = await canonicalDigest(
        output.selected.flatMap(
          (item) => item.artifacts,
        ) as unknown as JsonValue,
      );
      const receipt: ResolutionReceipt = {
        receiptVersion: '1',
        protocolVersion: '1.0-draft',
        requestDigest: output.requestDigest,
        normalizedRequest: output.normalizedRequest,
        universeDigest: output.universeDigest,
        sourceSnapshots: options.universe.sourceSnapshots,
        targetDigest: await canonicalDigest(
          output.normalizedRequest.target as unknown as JsonValue,
        ),
        policyDigest: await canonicalDigest(
          output.normalizedRequest.policy as unknown as JsonValue,
        ),
        lifecycleRoot: options.universe.lifecycleRoot,
        semanticsProfile: output.normalizedRequest.semantics.profile,
        objectiveOrdering: output.normalizedRequest.objectives,
        solutionDigest: output.solution.solutionDigest,
        proofDigest,
        explanationDigest,
        artifactSetDigest,
        resolver: {
          providerId: options.meta.provider.id,
          implementation: 'openpacker-resolver',
          version: options.meta.provider.version,
          buildDigest: options.resolverBuildDigest,
        },
        evaluationTime: output.normalizedRequest.evaluationTime,
        evidenceRefs: [],
        externalRefs: [],
      };
      const signedReceipt = options.receiptSigners?.length
        ? await signReceipt(receipt, options.receiptSigners)
        : undefined;
      explanations.set(
        formatDigest(output.solution.solutionDigest),
        explanation,
      );
      return {
        meta: options.meta,
        normalizedRequest: output.normalizedRequest,
        requestDigest: output.requestDigest,
        universeDigest: output.universeDigest,
        selected: output.selected,
        solution: output.solution,
        proof: output.proof,
        explanation,
        unsignedReceipt: receipt,
        ...(signedReceipt === undefined ? {} : { signedReceipt }),
      };
    },

    async materialize(input) {
      const { descriptor, package: owner } = findArtifact(input, instances());
      if (owner?.lifecycle.status === 'yanked' && input.forensic !== true)
        throw operationError(
          'LIFECYCLE_DENIED',
          'Yanked artifacts require explicit forensic materialization',
        );
      return {
        meta: options.meta,
        descriptor,
        restrictions: ['digest-verification-required', 'no-lifecycle-scripts'],
      };
    },

    async verify(input, context) {
      const requested = [...new Set(input.checks)].sort();
      const verified = new Set<string>();
      let failure: unknown;
      let subjectDigest =
        'digest' in input.subject && input.subject.digest
          ? input.subject.digest
          : { algorithm: 'sha256' as const, value: '0'.repeat(64) };
      try {
        if (isSignedReceipt(input.subject)) {
          subjectDigest = input.subject.receiptDigest;
          if (!options.receiptVerifiers)
            throw operationError(
              'PROVIDER_CAPABILITY_MISSING',
              'Receipt verifiers are not configured',
            );
          await verifySignedReceipt(input.subject, options.receiptVerifiers);
          verified.add('receipt-signature');
          verified.add('receipt-bindings');
        } else if (isArtifactDescriptor(input.subject)) {
          subjectDigest = input.subject.digest;
          if (!options.artifactSource)
            throw operationError(
              'PROVIDER_CAPABILITY_MISSING',
              'Artifact source is not configured',
            );
          const stat = await options.artifactSource.stat(
            input.subject,
            context.signal,
          );
          if (
            stat.descriptor.size !== input.subject.size ||
            formatDigest(stat.descriptor.digest) !==
              formatDigest(input.subject.digest)
          )
            throw operationError(
              'DIGEST_MISMATCH',
              'Artifact stat does not match its immutable descriptor',
            );
          const bytes = await collectStream(
            await options.artifactSource.open(
              input.subject,
              undefined,
              context.signal,
            ),
            input.subject.size,
            context.signal,
          );
          await verifyBytes(input.subject, bytes);
          verified.add('artifact-digest');
          verified.add('artifact-size');
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'PROVIDER_CAPABILITY_MISSING')
          throw error;
        failure = error;
      }
      const known = new Set([
        'artifact-digest',
        'artifact-size',
        'oci-descriptors',
        'ocm-integrity',
        'receipt-signature',
        'receipt-bindings',
        'tuf-metadata',
        'sigstore-bundle',
        'slsa-subject',
        'cyclonedx-sbom',
        'lifecycle-eligibility',
        'policy',
      ]);
      const aliases: Record<string, string> = {
        'prex-receipt-signature': 'receipt-signature',
        tuf: 'tuf-metadata',
        sigstore: 'sigstore-bundle',
        slsa: 'slsa-subject',
        cyclonedx: 'cyclonedx-sbom',
        lifecycle: 'lifecycle-eligibility',
      };
      const evidence: EvidenceResult[] = [];
      for (const requestedCheck of requested) {
        const check = aliases[requestedCheck] ?? requestedCheck;
        const configured =
          options.verificationChecks?.get(check) ??
          options.verificationChecks?.get(requestedCheck);
        let configuredResult;
        let configuredFailure: unknown;
        if (failure === undefined && !verified.has(check) && configured) {
          try {
            configuredResult = await configured(
              { request: input, check, subjectDigest },
              context,
            );
          } catch (error) {
            configuredFailure = error;
          }
        }
        const verificationFailure = configuredFailure ?? failure;
        const status: EvidenceResult['status'] =
          configuredResult?.status ??
          (verificationFailure
            ? 'invalid'
            : verified.has(check)
              ? 'valid'
              : known.has(check)
                ? 'not-provided'
                : 'unknown');
        evidence.push({
          ...evidenceResult(
            requestedCheck,
            subjectDigest,
            status,
            input.evaluationTime,
          ),
          ...(configuredResult?.diagnostics
            ? { diagnostics: configuredResult.diagnostics }
            : failure === undefined && configuredFailure === undefined
              ? {}
              : {
                  diagnostics: [
                    {
                      code: 'VERIFICATION_FAILED',
                      message:
                        verificationFailure instanceof Error
                          ? verificationFailure.message
                          : 'Verification failed',
                    },
                  ],
                }),
        });
      }
      const decision: VerifyResponse['decision'] = evidence.some(
        ({ status }) => status === 'invalid' || status === 'policy-denied',
      )
        ? 'deny'
        : evidence.every(({ status }) => status === 'valid')
          ? 'allow'
          : 'indeterminate';
      return { meta: options.meta, decision, evidence };
    },

    async explain(input) {
      const graph = explanations.get(formatDigest(input.solutionDigest));
      if (!graph)
        throw operationError(
          'PACKAGE_NOT_FOUND',
          'Explanation graph was not found',
        );
      return {
        meta: options.meta,
        graph,
        ...(input.format === 'text' || input.format === 'both'
          ? { text: renderExplanation(graph) }
          : {}),
      };
    },

    async catalogImport(input, context) {
      const snapshot = snapshotFrom(input);
      const digest = await context.store.putSnapshot(input);
      return { snapshot, digest };
    },

    async catalogSnapshot(input, context) {
      const providerId =
        isObject(input) && typeof input.providerId === 'string'
          ? input.providerId
          : undefined;
      const snapshots = options.universe.sourceSnapshots.filter(
        (snapshot) =>
          providerId === undefined || snapshot.providerId === providerId,
      );
      for (const snapshot of snapshots)
        await context.store.putSnapshot(snapshot);
      return { snapshots };
    },

    async lockImport(input) {
      try {
        const solveInput = await planNativeLockImport(input.lockfile, {
          ...(input.format === undefined
            ? {}
            : { format: input.format as LockFormat }),
          ...(input.ecosystem === undefined
            ? {}
            : { ecosystem: input.ecosystem }),
          ...(input.evaluationTime === undefined
            ? {}
            : { evaluationTime: input.evaluationTime }),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.policy === undefined ? {} : { policy: input.policy }),
          ...(input.objectives === undefined
            ? {}
            : { objectives: input.objectives as SolveRequest['objectives'] }),
          codecs,
        });
        const result = await completeLockImport(solveInput, options.resolver, {
          providerId: options.meta.provider.id,
          implementation: options.meta.provider.implementation,
          version: options.meta.provider.version,
          resolverBuildDigest: options.resolverBuildDigest,
          protocolVersion: options.meta.protocolVersion,
        });
        return {
          lockCapture: {
            format: result.lockCapture.format,
            formatVersion: result.lockCapture.formatVersion,
            ...(result.lockCapture.sourceDigest === undefined
              ? {}
              : { sourceDigest: result.lockCapture.sourceDigest }),
            packages: result.lockCapture.packages.map((entry) => ({
              exactPurl: entry.exactPurl,
              nativeCoordinate: entry.nativeCoordinate,
              ...(entry.resolved === undefined
                ? {}
                : { resolved: entry.resolved }),
              ...(entry.artifactDigest === undefined
                ? {}
                : { artifactDigest: entry.artifactDigest }),
              dependencies: { ...entry.dependencies },
              native: entry.native as JsonValue,
            })),
            semanticLoss: [...result.lockCapture.semanticLoss],
          },
          solveResponse: result.solveResponse,
          lockfile: result.lockfile,
          semanticLoss: result.semanticLoss,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('INVALID_LOCKFILE') ||
          message.includes('lockfile')
        )
          throw operationError('INVALID_REQUEST', message);
        if (message.includes('unsupported semantics profile:'))
          throw operationError('UNSUPPORTED_SEMANTICS_PROFILE', message);
        if (message.includes('UNSATISFIABLE:'))
          throw operationError('UNSATISFIABLE', message);
        throw error;
      }
    },

    lifecycleApply: options.extensions.lifecycleApply,
    pack: options.extensions.pack,
    publish: options.extensions.publish,
  };
}

type CodecMap = ReadonlyMap<Ecosystem, EcosystemCodec>;

function normalizeItem(
  item: NormalizeRequest['items'][number],
  codecs: CodecMap,
): NormalizeResponse['results'][number] {
  if (item.type === 'purl') {
    const parsed = parsePurl(item.value);
    const canonical = codecFor(parsed.type, codecs).canonicalizePurl(
      item.value,
    );
    return normalized(
      item.type,
      item.value,
      canonical,
      parsePurl(canonical) as unknown as JsonValue,
      parsed.type,
    );
  }
  if (item.type === 'vers') {
    let parsed;
    try {
      parsed = parseVers(item.value);
    } catch (error) {
      throw operationError(
        'INVALID_VERS',
        error instanceof Error ? error.message : 'Invalid VERS',
      );
    }
    return {
      ...normalized(
        item.type,
        item.value,
        parsed.vers!,
        parsed as unknown as JsonValue,
        parsed.scheme,
      ),
      scheme: parsed.scheme,
    };
  }
  if (item.type === 'digest') {
    const match = /^sha256:([0-9a-f]{64})$/u.exec(item.value);
    if (!match)
      throw operationError(
        'DIGEST_MISMATCH',
        'Only canonical sha256 digests are accepted',
      );
    return normalized(item.type, item.value, item.value, {
      algorithm: 'sha256',
      value: match[1]!,
    });
  }
  if (item.type === 'target')
    return normalized(
      item.type,
      item.value as unknown as JsonValue,
      item.value as unknown as JsonValue,
      item.value as unknown as JsonValue,
    );
  const codec = codecFor(item.ecosystem, codecs);
  if (item.type === 'native-coordinate') {
    const coordinate = codec.parseNativeCoordinate(item.value);
    const purl = codec.canonicalizePurl(
      formatPurl({
        type: coordinate.ecosystem,
        ...(coordinate.namespace === undefined
          ? {}
          : { namespace: coordinate.namespace }),
        name: coordinate.name,
        ...(coordinate.version === undefined
          ? {}
          : { version: coordinate.version }),
        qualifiers: {},
      }),
    );
    return normalized(
      item.type,
      item.value,
      purl,
      coordinate as unknown as JsonValue,
      item.ecosystem,
    );
  }
  if (item.type === 'native-version') {
    const parsed = codec.parseNativeVersion(item.value);
    return normalized(
      item.type,
      item.value,
      parsed.normalized,
      parsed as unknown as JsonValue,
      item.ecosystem,
    );
  }
  const parsed = codec.toVers(item.value);
  return normalized(
    item.type,
    item.value,
    parsed.vers ?? parsed.normalized,
    parsed as unknown as JsonValue,
    item.ecosystem,
    parsed.semanticLoss as NormalizeResponse['results'][number]['semanticLoss'],
  );
}

function normalized(
  type: string,
  original: JsonValue,
  canonical: JsonValue,
  parsed: JsonValue,
  ecosystem?: string,
  semanticLoss: NormalizeResponse['results'][number]['semanticLoss'] = [],
): NormalizeResponse['results'][number] {
  return {
    type,
    original,
    canonical,
    parsed: parsed as { [key: string]: JsonValue },
    ...(ecosystem === undefined ? {} : { ecosystem }),
    reversibility: semanticLoss.length ? 'lossy' : 'exact',
    warnings: [],
    semanticLoss,
  };
}

function codecFor(ecosystem: string, codecs: CodecMap): EcosystemCodec {
  const codec = codecs.get(ecosystem as Ecosystem);
  if (!codec)
    throw operationError(
      'UNSUPPORTED_ECOSYSTEM',
      `Unsupported ecosystem: ${ecosystem}`,
    );
  return codec;
}

function canonicalPurl(value: string, codecs: CodecMap): string {
  return codecFor(parsePurl(value).type, codecs).canonicalizePurl(value);
}

function identityCandidates(
  packages: readonly PackageInstance[],
  purl?: string,
  alias?: string,
): IdentifyResponse['candidates'] {
  const exact =
    purl === undefined ? undefined : parsePurl(purl).version !== undefined;
  const byIdentity = new Map<string, PackageIdentity>();
  for (const item of packages) {
    const matches =
      purl !== undefined
        ? exact
          ? item.identity.exactPurl === purl
          : item.identity.canonicalPurl === purl
        : alias !== undefined && item.identity.aliases.includes(alias);
    if (matches)
      byIdentity.set(
        exact ? requiredExactPurl(item) : item.identity.canonicalPurl,
        item.identity,
      );
  }
  return [...byIdentity.values()]
    .sort((a, b) => compareCanonicalStrings(a.canonicalPurl, b.canonicalPurl))
    .map((identity) => ({
      identity,
      confidence: 1,
      provenance: identity.sourceRefs,
      warnings: /[^\x20-\x7e]/u.test(identity.name)
        ? [
            {
              code: 'UNICODE_CONFUSABLE_REVIEW',
              message: 'Non-ASCII package identity requires confusable review',
            },
          ]
        : [],
    }));
}

function requiredExactPurl(item: PackageInstance): string {
  if (!item.identity.exactPurl)
    throw operationError(
      'INTERNAL_ERROR',
      `Package node ${item.nodeId} lacks an exact PURL`,
    );
  return item.identity.exactPurl;
}

function parseCursor(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value))
    throw operationError(
      'INVALID_NATIVE_COORDINATE',
      'Pagination cursor is invalid',
    );
  return Number(value);
}

function findArtifact(
  input: MaterializeRequest,
  packages: readonly PackageInstance[],
): { descriptor: ArtifactDescriptor; package?: PackageInstance } {
  const subject = input.subject;
  if (subject.type === 'artifact') return { descriptor: subject.descriptor };
  let owner: PackageInstance | undefined;
  let selectedDescriptor: ArtifactDescriptor | undefined;
  if (subject.type === 'purl')
    owner = packages.find(
      (item) => item.identity.exactPurl === subject.exactPurl,
    );
  else if (subject.type === 'solution-node')
    owner = packages.find((item) => item.nodeId === subject.nodeId);
  else if (subject.type === 'digest')
    owner = packages.find((item) =>
      item.artifacts.some(
        (artifact) =>
          formatDigest(artifact.digest) === formatDigest(subject.digest),
      ),
    );
  else
    for (const item of packages) {
      const artifact = item.artifacts.find((candidate) => {
        const ocm = candidate.ocm;
        if (!ocm || Array.isArray(ocm) || typeof ocm !== 'object') return false;
        return (
          ocm.component === subject.component &&
          ocm.version === subject.version &&
          (subject.resourceName === undefined ||
            ocm.resourceName === subject.resourceName) &&
          (subject.descriptorDigest === undefined ||
            ocm.descriptorDigest === formatDigest(subject.descriptorDigest))
        );
      });
      if (artifact) {
        owner = item;
        selectedDescriptor = artifact;
        break;
      }
    }
  const descriptor = selectedDescriptor ?? owner?.artifacts[0];
  if (!descriptor)
    throw operationError(
      'ARTIFACT_NOT_FOUND',
      'No immutable artifact descriptor matches the materialization subject',
    );
  return { descriptor, ...(owner === undefined ? {} : { package: owner }) };
}

function evidenceResult(
  type: string,
  subjectDigest: { algorithm: 'sha256'; value: string },
  status: EvidenceResult['status'],
  evaluationTime: string,
): EvidenceResult {
  return {
    type,
    subjectDigest,
    status,
    verifier: { implementation: 'openpackerd', version: '0.1.0' },
    evaluationTime,
    policyRelevant: true,
    diagnostics: [],
  };
}

function isSignedReceipt(
  value: VerifyRequest['subject'],
): value is SignedReceipt {
  return (
    isObject(value) &&
    'receipt' in value &&
    'receiptDigest' in value &&
    'signatures' in value
  );
}
function isArtifactDescriptor(
  value: VerifyRequest['subject'],
): value is ArtifactDescriptor {
  return (
    isObject(value) &&
    'descriptorId' in value &&
    'digest' in value &&
    'size' in value
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotFrom(value: CatalogImportRequest): SourceSnapshot {
  return value;
}

function renderExplanation(graph: ExplanationGraph): string {
  return graph.nodes.map((node) => `${node.id}: ${node.label}`).join('\n');
}

export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

function operationError(
  code: string,
  message: string,
  status?: number,
): OperationError {
  return new OperationError(code, message, status);
}

export interface CapabilityFeatures {
  receiptVerification?: boolean;
  artifactVerification?: boolean;
  configuredChecks?: Iterable<string>;
}

const EVIDENCE_TYPE_BY_CHECK: Record<string, string> = {
  'tuf-metadata': 'tuf',
  'sigstore-bundle': 'sigstore',
  'slsa-subject': 'slsa',
  'cyclonedx-sbom': 'cyclonedx',
  'lifecycle-eligibility': 'lifecycle',
  'receipt-bindings': 'receipt-signature',
  'artifact-size': 'artifact-digest',
};

export function capabilityFeatures(
  options: ReferenceOperationsOptions,
): CapabilityFeatures {
  return {
    receiptVerification: (options.receiptVerifiers?.size ?? 0) > 0,
    artifactVerification: options.artifactSource !== undefined,
    configuredChecks: [...(options.verificationChecks?.keys() ?? [])],
  };
}

export function defaultCapabilities(
  meta: ProtocolMeta,
  features: CapabilityFeatures = {},
): Capabilities {
  const evidenceTypes = new Set<string>();
  if (features.receiptVerification) evidenceTypes.add('receipt-signature');
  if (features.artifactVerification) evidenceTypes.add('artifact-digest');
  for (const check of features.configuredChecks ?? [])
    evidenceTypes.add(EVIDENCE_TYPE_BY_CHECK[check] ?? check);
  return {
    meta,
    protocolVersions: ['1.0-draft'],
    operations: [
      'normalize',
      'identify',
      'enumerate',
      'inspect',
      'solve',
      'materialize',
      'verify',
      'explain',
      'receipt.get',
      'snapshot.get',
      'events.get',
    ],
    conformanceLevels: [
      'PREX-N',
      'PREX-I',
      'PREX-E',
      'PREX-D',
      'PREX-S',
      'PREX-M',
      'PREX-V',
      'PREX-X',
      'PREX-R',
      'PREX-C',
    ],
    purlTypes: ['npm', 'cargo', 'nuget', 'pypi', 'golang', 'maven'],
    versSchemes: ['npm', 'cargo', 'nuget', 'pypi', 'golang', 'maven'],
    semanticsProfiles: [
      'native-capture-v1',
      'native-validated-v1',
      'prex-calculus-subset-v1',
    ],
    targetDimensions: [
      'os',
      'architecture',
      'libc',
      'kernel',
      'runtimes',
      'abi',
      'capabilities',
      'variables',
    ],
    evidenceTypes: [...evidenceTypes].sort(),
    artifactTransports: ['file', 'cas', 'oci', 'https'],
    contentEncodings: ['identity'],
    eventBindings: ['ndjson'],
    limits: {
      requestBytes: 1_048_576,
      batchItems: 1_000,
      universeNodes: 100_000,
      graphNodes: 1_000_000,
      artifactMetadataBytes: 4_194_304,
    },
    pagination: { supported: true, maximumPageSize: 1_000 },
    streaming: { supported: true, bindings: ['ndjson'] },
    authenticationSchemes: [
      {
        type: 'none',
        description: 'The reference daemon performs no request authentication',
      },
    ],
    extensionSchemaRefs: [],
  };
}
