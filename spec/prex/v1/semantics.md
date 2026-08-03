# PREX formal semantics

## Profiles

`native-capture-v1` records a native resolver result and its inputs. It does not
claim independent solving. `native-validated-v1` additionally checks every
faithfully represented hard relation and reports every unvalidated native
semantic. `prex-calculus-subset-v1` directly solves the bounded PREX IR: package
and capability requirements, conjunction, alternatives, negation/conflict,
optional requirements, target conditions, replacements, and
cardinality/coexistence.

`derivation-capture-v1` is a **capture profile**, carried on
`BuildRecipe.captureProfile` rather than on `SemanticsInput`. It does not select
a solver; the three solve profiles above are unchanged, and a fully captured
realisation graph remains solvable under `prex-calculus-subset-v1` because its
selections are exact. The profile claims exactly this: the recipe faithfully
represents a native build plan as it existed at capture time, its declared
digests are internally consistent, and every `producedBy` and
`expectedTreeDigest` claim is mechanically checkable against realised bytes. It
does not claim that the build is reproducible, that PREX executed anything, or
that an ecosystem expression language was evaluated. `derivation-verified-v1` is
reserved for a future profile in which an external builder attests a rebuild.

## Realisation facts

A `BuildRecipe` records inputs, outputs, platforms, and provenance for one build
plan. `recipeDigest` is its `build-recipe-v1` projection digest;
`recipeOutputId` is the `recipe-output-v1` projection digest over
`{outputName, recipeDigest}` and identifies an output before any bytes exist.
Sibling outputs of one plan share a `recipeDigest` and differ only by output
name. Input roles (`source`, `build`, `host`, `target`, `recipe`) record which
platform an input was consumed for; a capture that had to guess MUST record
`PLATFORM_ATTRIBUTION_ASSUMED`.

`treeDigest` is the `tree-manifest-v1` projection digest of a `TreeManifest` and
identifies extracted content. Entry paths are relative and forward-slash
separated, and MUST contain no empty, `.`, or `..` segment and no backslash.
Executability is carried by entry `kind`, never by a mode integer, so identical
trees digest identically across platforms. Tree identity is deliberately not
byte-compatible with any native tree-serialization hash; a native value MAY be
carried alongside in `externalRefs` or `extensions`.

The **reference closure** of a set of artifacts is the least fixpoint under
`ArtifactDescriptor.runtimeReferences`. Closure computation is a
materialization-side check and never a solver obligation. References discovered
by reading artifact bytes are permitted; see invariant 9 in
[normative.md](normative.md).

A `SubstituteDescriptor` advertises prebuilt content. It locates bytes and
declares references; it MUST NOT establish identity. A consumer MUST verify the
subject artifact digest or the tree digest before trusting substituted bytes,
and MUST record `SUBSTITUTE_UNVERIFIED` when a substituter signature was not
verified. Because the `substitute-v1` projection excludes `/locations`, the same
content offered by different mirrors has one substitute digest.

### Semantic-loss codes for realisation capture

| Code                           | Severity | Meaning                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------ |
| `RECIPE_OPAQUE`                | info     | A build plan existed but its internals were not captured           |
| `TREE_ENTRY_UNSUPPORTED`       | warning  | A tree entry kind is representable but not materializable here     |
| `SUBSTITUTE_UNVERIFIED`        | warning  | Substituted bytes arrived without a verified substituter signature |
| `CONTENT_ADDRESS_UNSUPPORTED`  | error    | A native content address uses an algorithm PREX cannot represent   |
| `PLATFORM_ATTRIBUTION_ASSUMED` | warning  | An input's build/host/target role was inferred, not captured       |

## Platforms and requirement kinds

`SolveRequest.target` is the **host** platform: where selected packages run.
`SolveRequest.platforms` optionally supplies `build`, `host`, and `target`
contexts; when present, `platforms.host` MUST equal `target`, and absent members
resolve to the host. A request without `platforms` therefore behaves exactly as
a single-platform request, because all three platforms are the same context.

`TargetPredicate.path` accepts an optional `build.`, `host.`, or `target.`
prefix. An unprefixed path resolves against the platform its enclosing
requirement is consumed on: requirements whose `kind` is `build` or `tool`
resolve against the build platform, and every other kind resolves against the
host. `requirementKindPolicy.buildPlatformKinds` replaces that set, and
`requirementKindPolicy.inactiveKinds` marks kinds that do not participate in the
solve at all. Conflicts, cardinality selectors, and capability target predicates
are host-platform facts.

Implementations MUST resolve predicates through one platform view shared by
search, proof construction, and the independent checker. A capture that inferred
rather than observed an input's platform role MUST record
`PLATFORM_ATTRIBUTION_ASSUMED`; staging distinctions finer than one
build/host/target split remain in `nativeSemantics` with
`CROSS_STAGE_APPROXIMATED`.

## Package outputs

`PackageInstance.outputs` declares the separately installable parts of one
package. An absent `outputs` array means a single implicit default output
covering every artifact. `RequirementExpression.package.outputs` selects the
parts a requirement needs, `DependencyEdge.toOutputs` records which parts an
edge required, and `MaterializeRequest.outputs` restricts extraction.

Outputs refine materialization and closure membership; they are **not** solve
variables. The node remains the atomic unit of selection, so proof and witness
semantics are unchanged. An ecosystem whose native semantics genuinely resolve
per output either mints one instance per output — distinguished by the reserved
`output` qualifier, which the existing exact qualifier match already selects —
or records `OUTPUT_GRANULARITY_COLLAPSED`.

## Environments and generations

An `EnvironmentManifest` declares what an environment should contain. An
`EnvironmentGeneration` records one realised state of it and is immutable:
generations are append-only and hash-linked through `parentGenerationDigest`, so
altering any earlier record invalidates the link its children assert.
`generationDigest` is the `environment-generation-v1` projection digest and
excludes itself, so it MUST be recomputable from the record alone.

`EnvironmentState` is the only mutable part. Switching generations MUST replace
that record atomically, and rolling back MUST re-point it at a retained
ancestor; neither operation may rewrite or delete a generation record. Every
user-visible view of an environment — executable shims, environment variables,
search paths — MUST be derivable purely from the current generation plus store
content and MUST be regenerable idempotently, so an interrupted switch is
observed as either the previous state or the new one, never a blend.

A stored artifact is **collectible** exactly when it lies outside the reference
closure of every retained generation's artifact set. Retained generations are
therefore the reachability roots; this specification defines the relation and
does not mandate a collection schedule.

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
