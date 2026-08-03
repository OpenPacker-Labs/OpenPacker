import {
  ProviderError,
  formatPurl,
  parsePurl,
  type Ecosystem,
  type EcosystemCodec,
  type LockCapture,
  type TranslationProvenance,
} from '@openpacker/adapter-core';
import { CargoCodec } from '@openpacker/adapter-cargo';
import { GolangCodec } from '@openpacker/adapter-golang';
import { MavenCodec } from '@openpacker/adapter-maven';
import { NpmCodec } from '@openpacker/adapter-npm';
import { NugetCodec } from '@openpacker/adapter-nuget';
import { PypiCodec } from '@openpacker/adapter-pypi';
import {
  canonicalDigest,
  compareCanonicalStrings,
  formatDigest,
  sha256,
} from '@openpacker/canonical';
import type {
  Digest,
  JsonValue,
  OpenPackerLockfile,
  PackageInstance,
  ResolutionReceipt,
  ResolutionUniverse,
  SemanticLoss,
  SolveRequest,
  SolveResponse,
  TargetContext,
} from '@openpacker/contracts';

export type LockFormat =
  | 'package-lock'
  | 'cargo-lock'
  | 'nuget-assets'
  | 'nuget-packages-lock'
  | 'uv-lock'
  | 'go-sum'
  | 'gradle-lockfile'
  | 'auto';

export interface LockImportOptions {
  format?: LockFormat;
  ecosystem?: Ecosystem;
  evaluationTime?: string;
  target?: TargetContext;
  policy?: SolveRequest['policy'];
  objectives?: SolveRequest['objectives'];
  universe?: ResolutionUniverse;
  providerId?: string;
  endpoint?: string;
  /** Optional codec registry for ecosystems beyond the built-in three. */
  codecs?: ReadonlyMap<Ecosystem, EcosystemCodec>;
  /** Optional format handlers keyed by LockFormat. */
  formatHandlers?: ReadonlyMap<Exclude<LockFormat, 'auto'>, LockFormatHandler>;
}

export interface LockFormatHandler {
  ecosystem: Ecosystem;
  parse(raw: string | Uint8Array): unknown;
  codec: EcosystemCodec;
}

export interface CapturePlan {
  format: Exclude<LockFormat, 'auto'>;
  ecosystem: Ecosystem;
  lockCapture: LockCapture;
  lockedExactPurls: string[];
  packages: PackageInstance[];
  semanticLoss: SemanticLoss[];
  sourceDigest: Digest;
}

export interface LockImportSolveInput {
  request: SolveRequest;
  universe: ResolutionUniverse;
  lockCapture: LockCapture;
  semanticLoss: SemanticLoss[];
}

export interface LockImportResult {
  lockCapture: LockCapture;
  solveResponse: SolveResponse;
  lockfile: OpenPackerLockfile;
  semanticLoss: SemanticLoss[];
}

const DEFAULT_EVALUATION_TIME = '2026-08-02T00:00:00Z';
const ZERO_DIGEST: Digest = {
  algorithm: 'sha256',
  value: '0'.repeat(64),
};

const defaultCodecs = (): Map<Ecosystem, EcosystemCodec> =>
  new Map<Ecosystem, EcosystemCodec>([
    ['npm', new NpmCodec()],
    ['cargo', new CargoCodec()],
    ['nuget', new NugetCodec()],
    ['pypi', new PypiCodec()],
    ['golang', new GolangCodec()],
    ['maven', new MavenCodec()],
  ]);

function defaultHandlers(
  codecs: ReadonlyMap<Ecosystem, EcosystemCodec>,
): Map<Exclude<LockFormat, 'auto'>, LockFormatHandler> {
  const npm = codecs.get('npm');
  const cargo = codecs.get('cargo');
  const nuget = codecs.get('nuget');
  const pypi = codecs.get('pypi');
  const golang = codecs.get('golang');
  const maven = codecs.get('maven');
  if (!npm || !cargo || !nuget || !pypi || !golang || !maven)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Default lock-import codecs for npm, cargo, nuget, pypi, golang, and maven are required',
    );
  return new Map([
    [
      'package-lock',
      {
        ecosystem: 'npm',
        codec: npm,
        parse: (raw) => JSON.parse(asText(raw)) as unknown,
      },
    ],
    [
      'cargo-lock',
      {
        ecosystem: 'cargo',
        codec: cargo,
        parse: (raw) => asText(raw),
      },
    ],
    [
      'nuget-assets',
      {
        ecosystem: 'nuget',
        codec: nuget,
        parse: (raw) => ({
          format: 'project.assets.json' as const,
          data: JSON.parse(asText(raw)) as unknown,
        }),
      },
    ],
    [
      'nuget-packages-lock',
      {
        ecosystem: 'nuget',
        codec: nuget,
        parse: (raw) => ({
          format: 'packages.lock.json' as const,
          data: JSON.parse(asText(raw)) as unknown,
        }),
      },
    ],
    [
      'uv-lock',
      {
        ecosystem: 'pypi',
        codec: pypi,
        parse: (raw) => JSON.parse(asText(raw)) as unknown,
      },
    ],
    [
      'go-sum',
      {
        ecosystem: 'golang',
        codec: golang,
        parse: (raw) => asText(raw),
      },
    ],
    [
      'gradle-lockfile',
      {
        ecosystem: 'maven',
        codec: maven,
        parse: (raw) => asText(raw),
      },
    ],
  ]);
}

function asText(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
}

function asBytes(raw: string | Uint8Array): Uint8Array {
  return typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
}

export function detectLockFormat(
  raw: string | Uint8Array,
  hint?: LockFormat,
): Exclude<LockFormat, 'auto'> {
  if (hint && hint !== 'auto') return hint;
  const text = asText(raw).trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.lockfileVersion === 3 && parsed.packages)
        return 'package-lock';
      if (parsed.version !== undefined && parsed.targets) return 'nuget-assets';
      if (
        parsed.version !== undefined &&
        parsed.dependencies &&
        !Array.isArray(parsed.package)
      )
        return 'nuget-packages-lock';
      // uv.lock JSON projection: version + package[]
      if (
        (parsed.version === 1 || parsed.version === '1') &&
        Array.isArray(parsed.package)
      )
        return 'uv-lock';
    } catch {
      // fall through
    }
  }
  if (/^version\s*=\s*\d+/m.test(text) && /\[\[package\]\]/.test(text))
    return 'cargo-lock';
  // go.sum lines: module version h1:... (ignore comments)
  if (
    text
      .split('\n')
      .some((line) => /^[\w./-]+ [vh][\w.+-]* h1:/.test(line.trim()))
  )
    return 'go-sum';
  // Gradle lockfile: group:name:version=configurations
  if (
    text
      .split('\n')
      .some((line) =>
        /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+=/.test(line.trim()),
      )
  )
    return 'gradle-lockfile';
  throw new ProviderError(
    'INVALID_LOCKFILE',
    'Unable to detect native lockfile format',
  );
}

export async function planLockCapture(
  raw: string | Uint8Array,
  options: LockImportOptions = {},
): Promise<CapturePlan> {
  const codecs = options.codecs ?? defaultCodecs();
  const handlers = new Map([
    ...defaultHandlers(codecs),
    ...(options.formatHandlers ?? []),
  ]);
  const format = detectLockFormat(raw, options.format);
  const handler = handlers.get(format);
  if (!handler)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `No lock-import handler registered for format ${format}`,
    );
  if (options.ecosystem && options.ecosystem !== handler.ecosystem)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Ecosystem ${options.ecosystem} does not match detected format ${format}`,
    );

  const sourceDigest = await sha256(asBytes(raw));
  const evaluationTime = options.evaluationTime ?? DEFAULT_EVALUATION_TIME;
  const provenance: TranslationProvenance = {
    providerId: options.providerId ?? `lock-import:${handler.ecosystem}`,
    endpoint: options.endpoint ?? `lockfile://${format}`,
    retrievedAt: evaluationTime,
    evaluationTime,
    metadataDigest: sourceDigest,
  };
  const parsed = handler.parse(raw);
  const lockCapture = handler.codec.translateLockResult(parsed, provenance);
  if (!lockCapture.packages.length)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Native lockfile produced no package selections',
    );

  const packages = await Promise.all(
    lockCapture.packages.map((entry) =>
      minimalInstanceFromLockEntry(entry, handler.ecosystem, sourceDigest),
    ),
  );
  const lockedExactPurls = [
    ...new Set(
      packages
        .map((item) => item.identity.exactPurl)
        .filter((value): value is string => value !== undefined),
    ),
  ].sort(compareCanonicalStrings);

  if (lockedExactPurls.length !== packages.length)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Native lockfile contains duplicate or missing exact PURLs',
    );

  return {
    format,
    ecosystem: handler.ecosystem,
    lockCapture: {
      ...lockCapture,
      sourceDigest: formatDigest(sourceDigest),
    },
    lockedExactPurls,
    packages,
    semanticLoss: [
      ...lockCapture.semanticLoss,
      {
        code: 'NATIVE_RESULT_CAPTURE_ONLY',
        severity: 'info',
        sourceEcosystem: handler.ecosystem,
        sourcePath: '/',
        originalMeaning:
          'Selections were imported from a native lockfile; OpenPacker did not independently solve the graph',
        representedMeaning: 'native-capture-v1 locked exact PURLs',
        blocksProfile: ['prex-calculus-subset-v1', 'native-validated-v1'],
      },
    ],
    sourceDigest,
  };
}

export async function buildCaptureSolveInput(
  plan: CapturePlan,
  options: LockImportOptions = {},
): Promise<LockImportSolveInput> {
  const evaluationTime = options.evaluationTime ?? DEFAULT_EVALUATION_TIME;
  const universe =
    options.universe === undefined
      ? await buildMinimalUniverse(
          plan.packages,
          evaluationTime,
          plan.sourceDigest,
        )
      : mergePackagesIntoUniverse(options.universe, plan.packages);

  const request: SolveRequest = {
    requirements: [],
    target: options.target ?? {},
    environment: {
      installed: [],
      locked: plan.lockedExactPurls,
    },
    policy: options.policy ?? {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: [],
      acceptedOverlayAuthorities: [],
    },
    semantics: {
      profile: 'native-capture-v1',
      nativeCompatibility: [plan.ecosystem],
    },
    objectives: options.objectives ?? [
      'minimize-package-count',
      'prefer-highest-native-version',
      'canonical-lexical-tie-break',
    ],
    mode: 'closure',
    evaluationTime,
  };

  return {
    request,
    universe,
    lockCapture: plan.lockCapture,
    semanticLoss: plan.semanticLoss,
  };
}

export async function planNativeLockImport(
  raw: string | Uint8Array,
  options: LockImportOptions = {},
): Promise<LockImportSolveInput> {
  const plan = await planLockCapture(raw, options);
  return buildCaptureSolveInput(plan, options);
}

export interface EmbeddedSolveLike {
  solve(input: { request: SolveRequest; universe: ResolutionUniverse }): {
    normalizedRequest: SolveRequest;
    requestDigest: Digest;
    universeDigest: Digest;
    selected: PackageInstance[];
    solution: SolveResponse['solution'];
    proof: SolveResponse['proof'];
    explanation: unknown;
  };
  check(
    input: { request: SolveRequest; universe: ResolutionUniverse },
    output: unknown,
  ): { valid: boolean; diagnostics: string[] };
}

export async function completeLockImport(
  solveInput: LockImportSolveInput,
  resolver: EmbeddedSolveLike,
  meta: {
    providerId: string;
    implementation?: string;
    version: string;
    resolverBuildDigest: Digest;
    protocolVersion?: string;
  },
): Promise<LockImportResult> {
  const embeddedInput = {
    request: solveInput.request,
    universe: solveInput.universe,
  };
  const output = resolver.solve(embeddedInput);
  const check = resolver.check(embeddedInput, output);
  if (!check.valid)
    throw new ProviderError(
      'INTERNAL_ERROR',
      `Independent proof check failed: ${check.diagnostics.join('; ')}`,
    );

  const explanation = output.explanation as SolveResponse['explanation'];
  const proofDigest = await canonicalDigest(
    output.proof as unknown as JsonValue,
  );
  const explanationDigest = await canonicalDigest(
    explanation as unknown as JsonValue,
  );
  const artifactSetDigest = await canonicalDigest(
    output.selected.flatMap((item) => item.artifacts) as unknown as JsonValue,
  );
  const protocolVersion =
    meta.protocolVersion === '1.0-draft' || meta.protocolVersion === undefined
      ? ('1.0-draft' as const)
      : ('1.0-draft' as const);
  const unsignedReceipt: ResolutionReceipt = {
    receiptVersion: '1',
    protocolVersion,
    requestDigest: output.requestDigest,
    normalizedRequest: output.normalizedRequest,
    universeDigest: output.universeDigest,
    sourceSnapshots: solveInput.universe.sourceSnapshots,
    targetDigest: await canonicalDigest(
      output.normalizedRequest.target as unknown as JsonValue,
    ),
    policyDigest: await canonicalDigest(
      output.normalizedRequest.policy as unknown as JsonValue,
    ),
    lifecycleRoot: solveInput.universe.lifecycleRoot,
    semanticsProfile: output.normalizedRequest.semantics.profile,
    objectiveOrdering: output.normalizedRequest.objectives,
    solutionDigest: output.solution.solutionDigest,
    proofDigest,
    explanationDigest,
    artifactSetDigest,
    resolver: {
      providerId: meta.providerId,
      implementation: meta.implementation ?? 'openpacker-resolver',
      version: meta.version,
      buildDigest: meta.resolverBuildDigest,
    },
    evaluationTime: output.normalizedRequest.evaluationTime,
    evidenceRefs: [],
    externalRefs: [],
  };

  const solveResponse: SolveResponse = {
    meta: {
      protocolVersion,
      provider: {
        id: meta.providerId,
        implementation: meta.implementation ?? 'openpacker-lock-import',
        version: meta.version,
      },
    },
    normalizedRequest: output.normalizedRequest,
    requestDigest: output.requestDigest,
    universeDigest: output.universeDigest,
    selected: output.selected,
    solution: output.solution,
    proof: output.proof,
    explanation,
    unsignedReceipt,
  };

  const lockfile = await buildLockfileFromSolve(solveResponse);
  return {
    lockCapture: solveInput.lockCapture,
    solveResponse,
    lockfile,
    semanticLoss: solveInput.semanticLoss,
  };
}

export async function buildLockfileFromSolve(
  solve: SolveResponse,
): Promise<OpenPackerLockfile> {
  const receiptDigest = await canonicalDigest(
    solve.unsignedReceipt as unknown as JsonValue,
  );
  const artifacts = solve.selected.flatMap((item) => item.artifacts);
  return {
    schemaVersion: '1',
    protocolVersion: '1.0-draft',
    rootRequirements: solve.normalizedRequest.requirements,
    target: solve.normalizedRequest.target,
    semanticsProfile: solve.normalizedRequest.semantics.profile,
    objectiveOrdering: solve.normalizedRequest.objectives,
    selectedExactPurls: solve.selected
      .map((item) => item.identity.exactPurl)
      .filter((value): value is string => value !== undefined)
      .sort(compareCanonicalStrings),
    dependencyEdges: solve.solution.dependencyEdges,
    artifactDescriptors: artifacts,
    ocmReferences: artifacts.flatMap((artifact) =>
      artifact.externalRefs.filter((reference) =>
        reference.type.startsWith('ocm'),
      ),
    ),
    sourceSnapshotDigests: solve.solution.sourceSnapshotDigests,
    lifecycleRoot: solve.unsignedReceipt.lifecycleRoot,
    policyDigest: solve.unsignedReceipt.policyDigest,
    solutionDigest: solve.solution.solutionDigest,
    receiptDigest,
    externalRefs: [],
  };
}

async function minimalInstanceFromLockEntry(
  entry: LockCapture['packages'][number],
  ecosystem: Ecosystem,
  sourceDigest: Digest,
): Promise<PackageInstance> {
  const exactPurl = entry.exactPurl;
  const parsed = parsePurl(exactPurl);
  if (!parsed.version)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Locked package is missing an exact version: ${exactPurl}`,
    );
  const nodeId = formatDigest(
    await sha256(new TextEncoder().encode(exactPurl)),
  );
  const metadataDigest = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        exactPurl,
        native: entry.native,
        resolved: entry.resolved,
        artifactDigest: entry.artifactDigest,
      }),
    ),
  );
  const artifacts =
    entry.artifactDigest === undefined
      ? []
      : [
          {
            descriptorId: `${nodeId}:lock-archive`,
            mediaType: 'application/octet-stream',
            artifactType: 'application/vnd.openpacker.lock-import.v1',
            digest: parseLooseDigest(entry.artifactDigest),
            size: 0,
            nativeRole: 'package-archive' as const,
            extensions: {
              'org.openpacker.lock-import': {
                exactPurl,
                nativeArchive: true,
              },
            },
            locations:
              entry.resolved === undefined
                ? []
                : [
                    {
                      transport: 'https' as const,
                      uri: entry.resolved,
                      priority: 0,
                      rangeSupported: false,
                    },
                  ],
            referrers: [],
            externalRefs: [],
          },
        ];

  return {
    nodeId,
    identity: {
      canonicalPurl: formatPurl({
        type: parsed.type,
        ...(parsed.namespace === undefined
          ? {}
          : { namespace: parsed.namespace }),
        name: parsed.name,
        qualifiers: {},
      }),
      exactPurl,
      purlType: parsed.type,
      ...(parsed.namespace === undefined
        ? {}
        : { namespace: parsed.namespace }),
      name: parsed.name,
      qualifiers: { ...parsed.qualifiers },
      nativeCoordinates: [
        {
          ecosystem,
          coordinate: entry.nativeCoordinate,
          version: parsed.version,
        },
      ],
      aliases: [],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
    },
    nativeVersion: parsed.version,
    normalizedVersion: parsed.version,
    versionSortKey: parsed.version,
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts,
    lifecycle: {
      status: 'published',
      eligible: true,
      warnings: [],
    },
    sourceSnapshots: [sourceDigest],
    metadataDigest,
    nativeSemantics: {
      version: `${ecosystem}-lock-import-v1`,
      data: stripUndefined({
        nativeCoordinate: entry.nativeCoordinate,
        dependencies: entry.dependencies,
        native: entry.native,
      }) as JsonValue,
    },
    semanticLoss: [],
  };
}

function stripUndefined(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function parseLooseDigest(value: string): Digest {
  if (value.startsWith('sha256:')) {
    const hex = value.slice('sha256:'.length).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) return { algorithm: 'sha256', value: hex };
  }
  if (value.startsWith('sha256-')) {
    // npm integrity is base64-encoded SHA-256; decode when well-formed.
    try {
      const binary = atob(value.slice('sha256-'.length));
      let hex = '';
      for (let index = 0; index < binary.length; index += 1) {
        hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
      }
      if (/^[0-9a-f]{64}$/.test(hex))
        return { algorithm: 'sha256', value: hex };
    } catch {
      // fall through
    }
  }
  // Fallback: placeholder digest. Lock-import artifacts are capture hints only.
  return {
    algorithm: 'sha256',
    value: '0'.repeat(64),
  };
}

async function buildMinimalUniverse(
  packages: PackageInstance[],
  evaluationTime: string,
  sourceDigest: Digest,
): Promise<ResolutionUniverse> {
  const sorted = [...packages].sort((left, right) =>
    compareCanonicalStrings(left.nodeId, right.nodeId),
  );
  const recordsDigest = await canonicalDigest(
    sorted.map((item) => item.metadataDigest) as unknown as JsonValue,
  );
  const snapshot = {
    snapshotId: formatDigest(sourceDigest),
    providerId: 'org.openpacker.lock-import',
    providerType: 'native-lock',
    endpointIdentity: 'lockfile',
    retrievedAt: evaluationTime,
    evaluationTime,
    rootDigest: sourceDigest,
    recordsDigest,
    evidenceRefs: [],
  };
  const body: Omit<ResolutionUniverse, 'canonicalDigest'> = {
    universeVersion: '1',
    packages: sorted,
    overlays: [],
    sourceSnapshots: [snapshot],
    lifecycleRoot: ZERO_DIGEST,
    targetVocabularyVersion: '1',
  };
  return {
    ...body,
    canonicalDigest: await canonicalDigest(body as unknown as JsonValue),
  };
}

function mergePackagesIntoUniverse(
  universe: ResolutionUniverse,
  packages: PackageInstance[],
): ResolutionUniverse {
  const byExact = new Map(
    universe.packages
      .filter((item) => item.identity.exactPurl)
      .map((item) => [item.identity.exactPurl!, item]),
  );
  for (const item of packages) {
    const exact = item.identity.exactPurl;
    if (!exact)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        'Package instance is missing exactPurl',
      );
    if (!byExact.has(exact)) byExact.set(exact, item);
  }
  return {
    ...universe,
    packages: [...byExact.values()].sort((left, right) =>
      compareCanonicalStrings(left.nodeId, right.nodeId),
    ),
  };
}
