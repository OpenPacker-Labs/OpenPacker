import {
  ProviderError,
  formatPurl,
  packageNodeId,
  parsePurl,
  type Ecosystem,
  type EcosystemCodec,
  type LockCapture,
  type TranslationProvenance,
} from '@openpacker/adapter-core';
import { tryGetAdapterRegistry } from '@openpacker/adapter-host';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
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
  | 'pnpm-lock'
  | 'cargo-lock'
  | 'nuget-assets'
  | 'nuget-packages-lock'
  | 'uv-lock'
  | 'poetry-lock'
  | 'requirements-txt'
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

/**
 * Resolve codecs from options or the process adapter registry.
 *
 * Never constructs ecosystem codecs by name — that is the adapter host's job.
 */
function resolveCodecs(
  options: LockImportOptions,
): Map<Ecosystem, EcosystemCodec> {
  const codecs = new Map<Ecosystem, EcosystemCodec>();
  const registry = tryGetAdapterRegistry();
  if (registry) {
    for (const module of registry.list()) {
      if (!module.codec) continue;
      const codec = module.codec();
      for (const purlType of module.purlTypes)
        codecs.set(purlType.toLowerCase() as Ecosystem, codec);
    }
  }
  if (options.codecs) {
    for (const [ecosystem, codec] of options.codecs)
      codecs.set(ecosystem, codec);
  }
  return codecs;
}

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
      'Lock-import requires codecs for npm, cargo, nuget, pypi, golang, and maven. ' +
        'Configure the adapter registry at process entry or pass options.codecs.',
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
      'pnpm-lock',
      {
        ecosystem: 'npm',
        codec: npm,
        parse: (raw) => parsePnpmLock(asText(raw)),
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
      'poetry-lock',
      {
        ecosystem: 'pypi',
        codec: pypi,
        parse: (raw) => parsePoetryLock(asText(raw)),
      },
    ],
    [
      'requirements-txt',
      {
        ecosystem: 'pypi',
        codec: pypi,
        // Normalised into the uv.lock shape the pypi codec already reads,
        // rather than teaching that codec a second Python lock dialect. A
        // pinned requirements.txt carries strictly less than uv.lock does, and
        // the conversion is where that shows.
        parse: (raw) => parseRequirementsTxt(asText(raw)),
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

/**
 * A `poetry.lock`, as the uv.lock document the pypi codec reads.
 *
 * Poetry pins exactly like uv does — `[[package]]` entries with a name and a
 * version — so the conversion is a rename rather than a translation. What it
 * does not carry is uv's per-package artifact hashes in the same shape, and
 * that difference is where the import loses information rather than inventing
 * it.
 */
export function parsePoetryLock(text: string): {
  version: 1;
  package: { name: string; version: string }[];
} {
  const document = parseToml(text) as {
    package?: { name?: unknown; version?: unknown }[];
    metadata?: { 'lock-version'?: unknown };
  };
  if (!Array.isArray(document.package))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'poetry.lock has no [[package]] entries',
    );

  const packages: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const entry of document.package) {
    if (typeof entry?.name !== 'string' || typeof entry.version !== 'string')
      continue;
    // Normalised the way PyPI normalises, so Foo_Bar and foo-bar are one
    // distribution — the same rule requirements.txt import applies.
    const name = entry.name.toLowerCase().replace(/[-_.]+/gu, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    packages.push({ name, version: entry.version });
  }
  if (packages.length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'poetry.lock contains no importable packages',
    );
  return { version: 1, package: packages };
}

/**
 * A `pnpm-lock.yaml`, as the package-lock document the npm codec reads.
 *
 * pnpm resolves against the same registry npm does, so the packages are the
 * same packages; only the lock format differs. Converting here rather than
 * teaching the npm codec a second dialect keeps one npm translation with one
 * set of semantics.
 *
 * pnpm keys packages as `name@version`, with scoped names carrying their own
 * `@` — `@scope/pkg@1.0.0`. The split is on the last `@` for that reason.
 */
export function parsePnpmLock(text: string): {
  lockfileVersion: 3;
  packages: Record<
    string,
    { version: string; resolved?: string; integrity?: string }
  >;
} {
  const document = parseYaml(text) as {
    lockfileVersion?: unknown;
    packages?: Record<
      string,
      { resolution?: { integrity?: string; tarball?: string } }
    >;
  };
  const version = String(document.lockfileVersion ?? '');
  // v5 keyed packages as `/name/version`, a different shape entirely. Refusing
  // beats importing a v5 file as though it were v6+ and getting names wrong.
  if (!/^(?:6|7|8|9)/u.test(version))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Unsupported pnpm lockfileVersion "${version}"; 6.0 and later are supported.`,
    );
  if (!document.packages || typeof document.packages !== 'object')
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'pnpm-lock.yaml has no packages section',
    );

  const packages: Record<
    string,
    { version: string; resolved?: string; integrity?: string }
  > = {};
  for (const [key, value] of Object.entries(document.packages)) {
    // Peer-dependency suffixes like `(react@18.0.0)` describe how a package was
    // resolved, not which package it is.
    const identifier = key.split('(')[0]!;
    const at = identifier.lastIndexOf('@');
    if (at <= 0) continue;
    const name = identifier.slice(0, at);
    const packageVersion = identifier.slice(at + 1);
    if (!/^(?:@[^/]+\/)?[^/@]+$/u.test(name)) continue;
    if (!/^[0-9]/u.test(packageVersion)) continue;
    // package-lock keys packages by install path; `node_modules/<name>` is the
    // form the npm codec reads.
    packages[`node_modules/${name}`] = {
      version: packageVersion,
      ...(value?.resolution?.tarball
        ? { resolved: value.resolution.tarball }
        : {}),
      ...(value?.resolution?.integrity
        ? { integrity: value.resolution.integrity }
        : {}),
    };
  }
  if (Object.keys(packages).length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'pnpm-lock.yaml contains no importable packages',
    );
  return { lockfileVersion: 3, packages };
}

/**
 * A fully pinned `requirements.txt`, as a uv.lock-shaped document.
 *
 * Only `name==version` lines are importable. A requirements file may also
 * carry ranges, markers, editable installs, VCS URLs and `-r` includes; none
 * of those name an exact package, and importing a lock that is not actually
 * locked would produce a pinned universe from an unpinned input. Those lines
 * are refused rather than approximated — `pip freeze` output imports cleanly,
 * a hand-written requirements file with ranges does not, and the error says
 * which line is the problem.
 */
export function parseRequirementsTxt(text: string): {
  version: 1;
  package: { name: string; version: string }[];
} {
  const packages: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    lineNumber += 1;
    // Strip comments, then hash options like `--hash=sha256:...` which pin the
    // artifact but not the identity this import is about.
    const line = rawLine
      .split('#')[0]!
      .trim()
      .replace(/\s+--hash=\S+/gu, '');
    if (line === '' || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;]+)$/u.exec(line);
    if (!match) {
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `requirements.txt line ${lineNumber} is not an exact pin: "${rawLine.trim()}". ` +
          `Only "name==version" can be imported; a range or marker does not name a package.`,
      );
    }
    const name = match[1]!.toLowerCase().replace(/[-_.]+/gu, '-');
    if (seen.has(name)) continue;
    seen.add(name);
    packages.push({ name, version: match[2]! });
  }
  if (packages.length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'requirements.txt contains no exact pins to import',
    );
  return { version: 1, package: packages };
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
  if (/^lockfileVersion:\s*'?[6-9]/mu.test(text) && /^packages:/mu.test(text))
    return 'pnpm-lock';
  // Poetry writes a [metadata] lock-version alongside [[package]] tables;
  // Cargo.lock has [[package]] too, so the metadata block is what separates
  // them and it is checked before the cargo test above would match.
  if (/^\[\[package\]\]/mu.test(text) && /^lock-version\s*=/mu.test(text))
    return 'poetry-lock';
  // Last, and only when every meaningful line is an exact pin. A loose test
  // here would claim any text file is a requirements.txt, so this asks for
  // proof rather than a hint.
  {
    const lines = text
      .split(/\r?\n/u)
      .map((line) => line.split('#')[0]!.trim())
      .filter((line) => line !== '' && !line.startsWith('-'));
    if (
      lines.length > 0 &&
      lines.every((line) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*\s*==\s*[^\s;]+(\s+--hash=\S+)*$/u.test(
          line,
        ),
      )
    )
      return 'requirements-txt';
  }
  throw new ProviderError(
    'INVALID_LOCKFILE',
    'Unable to detect native lockfile format',
  );
}

export async function planLockCapture(
  raw: string | Uint8Array,
  options: LockImportOptions = {},
): Promise<CapturePlan> {
  const codecs = resolveCodecs(options);
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
  // Through the shared helper, not sha256(exactPurl): the node ID is defined
  // as the `package-node-v1` projection of the instance it labels, and this
  // instance carries both qualifiers and a native semantics version. Hashing
  // the PURL alone produced an ID that did not match its own projection for
  // every package in every imported lockfile.
  const nodeId = await packageNodeId({
    exactPurl,
    qualifiers: parsed.qualifiers,
    nativeSemanticsVersion: `${ecosystem}-lock-import-v1`,
  });
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
  const parsedDigest =
    entry.artifactDigest === undefined
      ? undefined
      : parseLooseDigest(entry.artifactDigest);
  const semanticLoss: SemanticLoss[] = [];
  if (entry.artifactDigest !== undefined && parsedDigest === undefined)
    semanticLoss.push({
      code: 'NATIVE_DIGEST_NOT_REPRESENTED',
      severity: 'warning',
      sourceEcosystem: ecosystem,
      sourcePath: '/',
      originalMeaning: `The native lock pins this artifact with a non-sha256 digest (${entry.artifactDigest.slice(0, 32)}…) that its native tool can verify`,
      representedMeaning:
        'No artifact descriptor is captured; OpenPacker holds no sha256 audit digest for this package',
      blocksProfile: [],
    });
  const artifacts =
    parsedDigest === undefined
      ? []
      : [
          {
            descriptorId: `${nodeId}:lock-archive`,
            mediaType: 'application/octet-stream',
            artifactType: 'application/vnd.openpacker.lock-import.v1',
            digest: parsedDigest,
            size: 0,
            nativeRole: 'package-archive' as const,
            extensions: {
              'org.openpacker.lock-import': {
                exactPurl,
                nativeArchive: true,
                sizeUnknown: true,
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
        qualifiers: parsed.qualifiers,
        ...(parsed.subpath === undefined ? {} : { subpath: parsed.subpath }),
      }),
      exactPurl,
      purlType: parsed.type,
      ...(parsed.namespace === undefined
        ? {}
        : { namespace: parsed.namespace }),
      name: parsed.name,
      version: parsed.version,
      qualifiers: { ...parsed.qualifiers },
      ...(parsed.subpath === undefined ? {} : { subpath: parsed.subpath }),
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
      status: 'unknown',
      eligible: true,
      warnings: [
        {
          code: 'LIFECYCLE_NOT_CAPTURED',
          message:
            'Native lockfiles carry no lifecycle status; registry lifecycle (yank, quarantine, revocation) was not consulted during import',
        },
      ],
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
    semanticLoss,
  };
}

function stripUndefined(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function parseLooseDigest(value: string): Digest | undefined {
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
  // Non-sha256 native digests (sha512, Go h1:, none) are not representable;
  // callers record a NATIVE_DIGEST_NOT_REPRESENTED loss instead of fabricating.
  return undefined;
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
    lifecycleRoot: await canonicalDigest([]),
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
