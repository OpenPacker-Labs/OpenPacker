# Resolution objectives, proof, and explanation

Solving consumes a complete `ResolutionUniverse`; catalog acquisition has
already ended. The resolver has no network, filesystem, clock, random,
credential, or process access. Inputs are canonically sorted and checked for
duplicate node IDs, dangling references, invalid predicates, and bounds before
search.

## Objective order

The supported deterministic lexicographic order is:

1. `satisfy-hard-constraints`
2. `preserve-locks`
3. `minimize-changes`
4. `minimize-package-count`
5. `exclude-lifecycle-denied`
6. `prefer-stable`
7. `prefer-highest-native-version`
8. `canonical-lexical-tie-break`

A request may supply another supported explicit ordering. Ecosystem codecs
provide native version comparison; canonical exact-PURL ordering is only the
final deterministic tie-break. Every preference appears in the objective tuple
and explanation graph rather than remaining a solver heuristic.

## Solution and proof

`ResolutionSolution` contains selected nodes/capability providers, satisfied
requirements, dependency edges, exclusions, objective tuple, semantic loss,
snapshot digests, and an implementation-independent solution digest.

`ResolutionProof` binds the request and universe and records selected
assignments with node digests, requirement witnesses, conflict checks,
cardinality checks, target checks, and objective evidence. The independent
checker recomputes:

- selected-node existence and digest;
- active required expressions and capability witnesses;
- conflicts, target predicates, and cardinality/coexistence;
- optional selected/omitted/inactive status;
- lifecycle and policy exclusions;
- the claimed objective tuple and canonical solution digest.

It does not reuse the search decision procedure. A failed check becomes
`INTERNAL_ERROR`. Bounded fixture universes also run exhaustive enumeration to
prove optimality rather than merely validity.

## Explanation and unsatisfiability

`ExplanationGraph` is normative; text is derived. Stable nodes represent
candidates, requirements, capabilities, conflicts, predicates, lifecycle,
policy, objectives, semantic loss, and proof. Edges express requirements,
witnesses, rejection, conflicts, conditions, preferences, provenance, and
checking.

An unsatisfiable solve returns `UNSATISFIABLE` with normalized request and
universe digests, source mappings, candidate rejection reasons, and a bounded
unsatisfiable core when derivable. Suggestions are permitted only when
mechanically derived.
