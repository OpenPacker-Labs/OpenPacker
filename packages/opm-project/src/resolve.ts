import { canonicalDigest } from '@openpacker/canonical';
import type { PackageInstance } from '@openpacker/contracts';
import { OpmError } from './types.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { providerFor, type RegistryOptions } from './registry.js';
import { codecFor } from './codecs.js';

/**
 * Transitive dependency resolution.
 *
 * `opm` resolved direct requirements only: a lockfile listed what you asked
 * for and nothing it needed. This walks the graph, gathers candidate versions
 * for every package reachable from the roots, and hands the result to the
 * PREX solver — the proof-checked CDCL engine this repository is built around
 * and which nothing in `opm` called.
 *
 * Candidate discovery is bounded, and says so. A universe containing every
 * published version of every transitive dependency is neither buildable in
 * reasonable time nor necessary: the newest versions satisfying a constraint
 * are the ones a solve will pick from in practice. When the bound truncates a
 * candidate set that is recorded, because a solve over a truncated universe
 * can report unsatisfiable for a problem that is actually satisfiable, and the
 * difference matters.
 */

/** Requirement kinds that belong in an install. */
const INSTALLED_KINDS = new Set(['runtime', 'peer']);

export interface ResolutionBounds {
  /** Newest candidates kept per package. */
  candidatesPerPackage?: number;
  /** Distinct packages the walk may visit. */
  maximumPackages?: number;
}

const DEFAULT_BOUNDS: Required<ResolutionBounds> = {
  candidatesPerPackage: 6,
  maximumPackages: 256,
};

export interface ResolvedGraph {
  /** Every candidate instance discovered, ready to become a universe. */
  packages: PackageInstance[];
  /** Root requirements, as exact or ranged PURLs. */
  roots: string[];
  /** Packages whose candidate list hit the bound. */
  truncated: string[];
  /** Packages reachable but not resolvable, with the reason. */
  unresolved: { purl: string; reason: string }[];
}

/** The native range a requirement expresses, in its own ecosystem's syntax. */
function nativeRange(requirement: unknown): string | undefined {
  const value = requirement as {
    nativeSemantics?: { data?: { range?: unknown } };
    raw?: { range?: unknown };
  };
  const fromSemantics = value.nativeSemantics?.data?.range;
  if (typeof fromSemantics === 'string') return fromSemantics;
  const fromRaw = value.raw?.range;
  return typeof fromRaw === 'string' ? fromRaw : undefined;
}

/**
 * Versions of `basePurl` that satisfy `range`, newest first.
 *
 * Matching uses the ecosystem's own codec rather than a translated constraint.
 * The npm codec already records `NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE` when
 * a range has no exact VERS form, so resolving through VERS would resolve
 * through a known approximation when the exact semantics are available.
 */
async function candidatesFor(
  ecosystem: string,
  basePurl: string,
  range: string | undefined,
  options: RegistryOptions,
): Promise<string[]> {
  const provider = providerFor(ecosystem, options);
  const published = await provider.enumerate(basePurl);
  if (range === undefined || range === '' || range === '*')
    return [...published].reverse();

  const codec = codecFor(ecosystem);
  const satisfying: string[] = [];
  for (const purl of published) {
    const version = purl.slice(purl.lastIndexOf('@') + 1);
    try {
      if (codec.satisfies(decodeURIComponent(version), range))
        satisfying.push(purl);
    } catch {
      // A range this codec cannot parse is not a reason to drop a candidate
      // silently; it is kept and the solver decides.
      satisfying.push(purl);
    }
  }
  return satisfying.reverse();
}

/**
 * Walk from the root requirements to every package they need.
 *
 * Breadth-first, so the shallowest constraint on a package is seen first and
 * the bound truncates the deepest candidates rather than the most relevant
 * ones.
 */
export async function resolveGraph(input: {
  roots: readonly { purl: string; range?: string }[];
  bounds?: ResolutionBounds;
  options?: RegistryOptions;
}): Promise<ResolvedGraph> {
  const bounds = { ...DEFAULT_BOUNDS, ...(input.bounds ?? {}) };
  const options = input.options ?? {};
  const packages: PackageInstance[] = [];
  const truncated: string[] = [];
  const unresolved: { purl: string; reason: string }[] = [];
  const inspected = new Set<string>();
  const queued = new Set<string>();

  const queue: { purl: string; range?: string }[] = input.roots.map((root) => ({
    purl: stripPurlVersion(root.purl),
    ...(root.range === undefined ? {} : { range: root.range }),
  }));
  for (const item of queue) queued.add(`${item.purl}|${item.range ?? ''}`);

  while (queue.length > 0) {
    if (queued.size > bounds.maximumPackages)
      throw new OpmError(
        'UNRESOLVABLE',
        `Dependency graph exceeded ${bounds.maximumPackages} packages. ` +
          `Raise the bound deliberately rather than resolving an unbounded graph.`,
      );
    const item = queue.shift()!;
    const ecosystem = ecosystemFromPurl(item.purl);

    let candidates: string[];
    try {
      candidates = await candidatesFor(
        ecosystem,
        item.purl,
        item.range,
        options,
      );
    } catch (error) {
      unresolved.push({
        purl: item.purl,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (candidates.length === 0) {
      unresolved.push({
        purl: item.purl,
        reason:
          item.range === undefined
            ? 'the registry published no versions'
            : `no published version satisfies ${item.range}`,
      });
      continue;
    }
    if (candidates.length > bounds.candidatesPerPackage) {
      truncated.push(item.purl);
      candidates = candidates.slice(0, bounds.candidatesPerPackage);
    }

    const provider = providerFor(ecosystem, options);
    for (const candidate of candidates) {
      if (inspected.has(candidate)) continue;
      inspected.add(candidate);
      let instance: PackageInstance;
      try {
        instance = (await provider.inspect(candidate)).package;
      } catch (error) {
        unresolved.push({
          purl: candidate,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      packages.push(instance);

      for (const requirement of instance.requirements ?? []) {
        const kind = (requirement as { kind?: string }).kind ?? 'runtime';
        if (!INSTALLED_KINDS.has(kind)) continue;
        if ((requirement as { optional?: boolean }).optional === true) continue;
        const expression = (requirement as { expression?: { purl?: string } })
          .expression;
        if (!expression?.purl) continue;
        const next = {
          purl: stripPurlVersion(expression.purl),
          ...(nativeRange(requirement) === undefined
            ? {}
            : { range: nativeRange(requirement)! }),
        };
        const key = `${next.purl}|${next.range ?? ''}`;
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(next);
      }
    }
  }

  return {
    packages,
    roots: input.roots.map((root) => root.purl),
    truncated: [...new Set(truncated)],
    unresolved,
  };
}

/**
 * Load the PREX solver for Node.
 *
 * Through the package's `wasm-node` entry, which wasm-bindgen builds for the
 * nodejs target and which reads the module with `readFileSync`. The generic
 * loader hands wasm-bindgen a relative URL instead and resolves it with
 * `fetch`, and Node's fetch has no `file:` scheme — so that path throws "not
 * implemented" rather than loading anything.
 */
async function loadResolver() {
  const { createEmbeddedResolver } = await import('@openpacker/embedded');
  const specifier = '@openpacker/embedded/wasm-node';
  const bindings = (await import(specifier)) as Record<string, unknown>;
  return createEmbeddedResolver(bindings as never);
}

/**
 * Solve the graph with the PREX engine and return the selected instances.
 *
 * This is the solver the repository is built around — CDCL search whose result
 * is checked by an independent proof checker — rather than a greedy
 * newest-satisfying walk. An unsatisfiable graph therefore produces an
 * explanation instead of a silently wrong tree.
 */
export async function solveGraph(input: {
  graph: ResolvedGraph;
  rootRequirements: readonly { purl: string; vers?: string }[];
  evaluationTime?: string;
}): Promise<{
  selected: PackageInstance[];
  solutionDigest: string;
  proofValid: boolean;
}> {
  const resolver = await loadResolver();
  const universe = await universeFrom(input.graph);

  const request = {
    environment: { installed: [], locked: [] },
    evaluationTime: input.evaluationTime ?? new Date().toISOString(),
    mode: 'closure',
    objectives: [
      'satisfy-hard-constraints',
      'minimize-package-count',
      'exclude-lifecycle-denied',
      'prefer-stable',
      'prefer-highest-native-version',
      'canonical-lexical-tie-break',
    ],
    policy: {
      acceptedOverlayAuthorities: ['publisher'],
      allowQuarantined: false,
      allowYanked: false,
      requiredEvidence: [],
      semanticLossMaximum: 'warning',
    },
    // `prex-calculus-subset-v1` is the profile whose solutions are formally
    // checkable, which is the point of solving here rather than walking the
    // graph greedily.
    semantics: {
      nativeCompatibility: [
        ...new Set(
          input.graph.packages.map((instance) => instance.identity.purlType),
        ),
      ],
      profile: 'prex-calculus-subset-v1',
    },
    // The host this resolution is for. Reported rather than assumed, so a
    // solution says which machine it is valid on instead of quietly being
    // wrong on another.
    target: {
      abi: {},
      architecture: process.arch === 'x64' ? 'x86_64' : process.arch,
      capabilities: [],
      libc: 'glibc',
      os: process.platform === 'win32' ? 'windows' : process.platform,
      runtimes: { node: process.versions.node.split('.')[0]! },
      variables: {},
    },
    requirements: input.rootRequirements.map((root, index) => ({
      authority: 'native',
      expression: {
        purl: stripPurlVersion(root.purl),
        type: 'package',
        ...(root.vers === undefined ? {} : { vers: root.vers }),
      },
      id: `root-${index}`,
      kind: 'runtime',
      optional: false,
      semanticLoss: [],
      source: { type: 'overlay', uri: 'opm://project' },
    })),
  };

  const solved = resolver.solve({
    request: request as never,
    universe: universe as never,
  });
  // The proof is checked rather than trusted: an unchecked proof is only a
  // claim, and invariant 5 makes an invalid one a hard failure.
  const checked = resolver.check(
    { request: request as never, universe: universe as never },
    solved,
  );
  if (!checked.valid)
    throw new OpmError(
      'UNRESOLVABLE',
      `The solver returned a solution its own proof checker rejected: ${checked.diagnostics.join('; ')}`,
    );

  const byNodeId = new Map(
    input.graph.packages.map((instance) => [instance.nodeId, instance]),
  );
  return {
    selected: solved.solution.selectedNodeIds
      .map((nodeId) => byNodeId.get(nodeId))
      .filter(
        (instance): instance is PackageInstance => instance !== undefined,
      ),
    solutionDigest: solved.solution.solutionDigest as unknown as string,
    proofValid: checked.valid,
  };
}

/** A `ResolutionUniverse` over everything the walk found. */
export async function universeFrom(
  graph: ResolvedGraph,
): Promise<Record<string, unknown>> {
  const body = {
    universeVersion: '1',
    packages: graph.packages,
    overlays: [],
    sourceSnapshots: [],
    lifecycleRoot: await canonicalDigest([]),
    targetVocabularyVersion: '1',
  };
  return { ...body, canonicalDigest: await canonicalDigest(body) };
}
