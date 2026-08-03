# PREX formal semantics

## Profiles

`native-capture-v1` records a native resolver result and its inputs. It does not
claim independent solving. `native-validated-v1` additionally checks every
faithfully represented hard relation and reports every unvalidated native
semantic. `prex-calculus-subset-v1` directly solves the bounded PREX IR: package
and capability requirements, conjunction, alternatives, negation/conflict,
optional requirements, target conditions, replacements, and
cardinality/coexistence.

## Hypergraph compilation

An exact `PackageInstance` is a vertex. Each capability offer is a
provider-labelled vertex projection. A requirement expression is compiled to a
directed hyperedge from its depender to one or more alternative satisfying
vertex sets. `allOf` forms the union of required heads; `anyOf` forms
alternative heads; a conditional edge is active exactly when its bounded target
predicate evaluates true. Conflicts compile to negative clauses. Cardinality
constraints compile to lower/upper bounds over the selected selector set.
Objective terms order valid selected sets lexicographically.

For an active `conditional`, exactly one of `then` or `else` is compiled; an
absent false `else` contributes no edge. A non-optional active requirement MUST
have a witness. An optional requirement may be witnessed or recorded exactly
once as `optional-omitted`; omission never satisfies another requirement. `not`
is compiled as a negative clause over its matching set. A replacement is a
capability-like witness only when its source requirement declares `replacement`.
Cardinality counts distinct selected node IDs matching the selector after target
filtering; `minimum` MUST NOT exceed `maximum`.

Package expressions use the codec named by PURL type for VERS membership.
Capability expressions match name, attributes, target predicate, and optional
VERS. Target predicates are pure and use only the supplied `TargetContext`;
missing paths make positive comparisons false and `notEquals`/`notIn` true.
Predicate and expression nesting are limited by advertised resource limits.

This is an implemented correspondence to a HyperRes-style dependency hypergraph,
not a claim that PREX implements the complete HyperRes calculus. Package
Calculus informed names, conflicts, and parallel/coexistence representation;
PREX only claims the tested subset above. Native peer, feature unification,
framework, build, workspace, and installer semantics that do not map exactly
remain in `nativeSemantics` with `SemanticLoss` evidence.

## Deterministic search and proof

Before search, implementations MUST sort externally supplied collections, derive
stable node IDs from canonical exact identity plus relevant variants, reject
duplicate IDs with differing content, and validate all references. Search engine
IDs are private. The supported objective ordering is deterministic and ends with
canonical exact-PURL lexical order.

Canonical IDs and result digests use the named projections in
`digest-projections.json`. Solver-internal IDs, iteration order, timestamps,
transport context, and mutable artifact locations never enter those projections.

The independent checker receives only the normalized request, universe, claimed
solution, and proof. It MUST recompute node existence/digests, active
requirements, witnesses, capability providers, conflicts, target predicates,
cardinalities, optional omissions, lifecycle/policy exclusions, objective tuple,
and solution digest. It MUST NOT invoke or reuse the solver decision procedure.
Bounded conformance fixtures additionally require exhaustive optimum comparison.

## Explanations and unsatisfiability

The `ExplanationGraph` is normative; prose is derived. Each selection,
rejection, overlay/native source, predicate, lifecycle decision, policy
decision, objective comparison, semantic loss, and checker result has a stable
graph node and source edge. Unsatisfiable results use `UNSATISFIABLE`, bind
request/universe digests, and include a bounded mechanically derived core when
available. Suggested repairs MUST NOT be guessed.
