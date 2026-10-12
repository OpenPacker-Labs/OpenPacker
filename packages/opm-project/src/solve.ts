import type { PackageInstance, PolicyInput } from '@openpacker/contracts';
import { OpmError } from './types.js';
import { stripPurlVersion } from './spec.js';
import {
  assignEdges,
  describeUnmet,
  duplicatedNames,
  explainUnsatisfiable,
  reachableSelection,
  unifyDuplicates,
  viableCandidates,
  type ClosureEdge,
} from './closure-edges.js';
import { narrowUnmetEdges } from './closure-tighten.js';
import { loadResolver } from './resolver-load.js';
import { defaultHostEnvironment, type ResolvedGraph } from './resolve.js';
import { universeFrom } from './universe.js';

/**
 * What a closure solve asks of the engine: satisfy every requirement, and skip
 * what lifecycle policy excludes.
 *
 * Not the optimizing ladder (`minimize-package-count`, `prefer-stable`,
 * `prefer-highest-native-version`, …). The engine can only prove an
 * optimization objective by exhaustive search, so it refuses one past a
 * handful of nodes — "objective optimality cannot be independently proven
 * above 22 nodes", and in practice `RESOURCE_LIMIT` well before that — and a
 * real closure is hundreds of nodes. Asking for optimization there is not a
 * stricter request, it is a refused one, and so nothing could ever have been
 * locked. The same request for every size also means a lock does not change
 * character when one more package pushes the universe over an invisible line.
 *
 * What the lock gets instead is honest about its strength: every hard
 * requirement is satisfied and the checker re-validates exactly that, and the
 * engine makes no claim that the set is the smallest or the newest possible.
 * The choice among candidates is steered by their order, newest first
 * (`sort_candidates` in the Resolvo engine, over the adapter's
 * `versionSortKey`), which is the same greedy rule the native resolvers use.
 */
export const CLOSURE_OBJECTIVES = [
  'satisfy-hard-constraints',
  'exclude-lifecycle-denied',
] as const;

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
  policy?: Pick<
    PolicyInput,
    | 'allowYanked'
    | 'allowQuarantined'
    | 'requiredEvidence'
    | 'semanticLossMaximum'
    | 'acceptedOverlayAuthorities'
  >;
}): Promise<{
  selected: PackageInstance[];
  dependencyEdges: ClosureEdge[];
  solutionDigest: string;
  proofValid: boolean;
}> {
  const resolver = await loadResolver();

  const request = {
    environment: { installed: [], locked: [] },
    evaluationTime: input.evaluationTime ?? new Date().toISOString(),
    mode: 'closure',
    objectives: [...CLOSURE_OBJECTIVES],
    policy: input.policy ?? {
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
      // What this host reports, and nothing on a host that has no libc to
      // report, instead of a "glibc" that was true only on glibc linux.
      ...(!(defaultHostEnvironment().nativeTarget.libc === undefined) && {
        libc: defaultHostEnvironment().nativeTarget.libc,
      }),
      os: process.platform === 'win32' ? 'windows' : process.platform,
      runtimes: {
        node: process.versions.node.split('.')[0]!,
        python: defaultHostEnvironment().pythonVersion.split('.')[0]!,
      },
      variables: {},
    },
    requirements: input.rootRequirements.map((root, index) => ({
      authority: 'native',
      expression: {
        purl: stripPurlVersion(root.purl),
        type: 'package',
        ...(!(root.vers === undefined) && { vers: root.vers }),
      },
      id: `root-${index}`,
      kind: 'runtime',
      optional: false,
      semanticLoss: [],
      source: { type: 'overlay', uri: 'opm://project' },
    })),
  };

  // The engine lets a package coexist at several versions, so a selection can
  // hold two when two dependents want different ones. Each edge is then pointed
  // at the newest selected version its range accepts, and what no edge reaches
  // is dropped. A name that every dependent can take one release of is made one
  // (the lock is smaller and the tree flatter, and a closure that locked before
  // locks the same); a name no single release suits stays at the versions it
  // needs, unless a required peer dependency points at it (ADR 0054).
  const isRoot = (instance: PackageInstance): boolean =>
    input.rootRequirements.some(
      (root) =>
        stripPurlVersion(root.purl) === instance.identity.canonicalPurl &&
        (root.vers === undefined ||
          resolver.versionSatisfies(instance.nativeVersion, root.vers)),
    );
  const viable = viableCandidates(input.graph.packages);
  let packages = viable.kept;
  const kept = new Set<string>();
  const narrowed = new Set<string>();
  for (let round = 0; ; round += 1) {
    const universe = await universeFrom({ ...input.graph, packages });
    let solved: ReturnType<typeof resolver.solve>;
    try {
      solved = resolver.solve({
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        request: request as never,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        universe: universe as never,
      });
    } catch (error) {
      // The engine's refusal is a JSON document naming the project's own
      // requirement ids; what a person needs is which edge nothing satisfies.
      if (
        !/^UNSATISFIABLE\b/u.test(error instanceof Error ? error.message : '')
      )
        throw error;
      const causes = explainUnsatisfiable({
        dropped: viable.dropped,
        kept: viable.kept,
        rootRequirements: input.rootRequirements,
        resolver,
      });
      throw new OpmError(
        'UNRESOLVABLE',
        causes.length === 0
          ? 'no selection of releases satisfies every requirement together'
          : `no selection of releases satisfies every requirement: ${causes.slice(0, 5).join('; ')}${causes.length > 5 ? `; and ${causes.length - 5} more` : ''}`,
        { cause: error },
      );
    }
    // The proof is checked rather than trusted: an unchecked proof is only a
    // claim, and invariant 5 makes an invalid one a hard failure.
    const checked = resolver.check(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      { request: request as never, universe: universe as never },
      solved,
    );
    if (!checked.valid)
      throw new OpmError(
        'UNRESOLVABLE',
        `The solver returned a solution its own proof checker rejected: ${checked.diagnostics.join('; ')}`,
      );

    const byNodeId = new Map(
      packages.map((instance) => [instance.nodeId, instance]),
    );
    const chosen = solved.solution.selectedNodeIds
      .map((nodeId) => byNodeId.get(nodeId))
      .filter(
        (instance): instance is PackageInstance => instance !== undefined,
      );
    for (const instance of chosen)
      if (instance.identity.exactPurl === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          'Selected package lacks an exact PURL',
        );
    const assigned = assignEdges(chosen);
    if (assigned.unmet.length > 0) {
      // The solver reads a range as a comparison, which admits a prerelease
      // the ecosystem's rule leaves out. Narrow those edges to the releases
      // it accepts and solve again, before calling the closure unsatisfiable.
      const narrowing =
        round >= MAXIMUM_SOLVE_ROUNDS
          ? undefined
          : narrowUnmetEdges({ packages, unmet: assigned.unmet, narrowed });
      if (narrowing === undefined || !narrowing.changed)
        throw new OpmError(
          'UNRESOLVABLE',
          `The closure the solver selected leaves a requirement unmet: ${describeUnmet(assigned.unmet, chosen)}`,
        );
      packages = narrowing.packages;
      continue;
    }
    const selected = reachableSelection({
      selected: chosen,
      edges: assigned.edges,
      isRoot,
    });
    const reached = new Set(selected.map((instance) => instance.nodeId));
    const edges = assigned.edges.filter((edge) => reached.has(edge.fromNodeId));
    const duplicated = duplicatedNames(selected);
    const unifiable = [...duplicated.keys()].filter((base) => !kept.has(base));
    const unified =
      unifiable.length === 0
        ? undefined
        : unifyDuplicates({
            packages,
            edges,
            duplicated,
            rootRequirements: input.rootRequirements,
            resolver,
            kept,
          });
    if (unified === undefined || !unified.changed)
      return {
        selected,
        dependencyEdges: edges.map(
          ({ fromNodeId, toNodeId, installName, requirementId }) => ({
            fromNodeId,
            toNodeId,
            installName,
            requirementId,
          }),
        ),
        solutionDigest: solved.solution.solutionDigest.value,
        // An invalid proof never gets this far: the check above throws on it.
        proofValid: true,
      };
    if (round >= MAXIMUM_SOLVE_ROUNDS)
      throw new OpmError(
        'UNRESOLVABLE',
        `The closure still holds several versions of ${[...duplicated.keys()].join(', ')} after ${MAXIMUM_SOLVE_ROUNDS} rounds of narrowing and unifying`,
      );
    packages = unified.packages;
  }
}

/** Enough for a closure of ordinary shape; a loop here is a bug, not a graph. */
const MAXIMUM_SOLVE_ROUNDS = 32;
