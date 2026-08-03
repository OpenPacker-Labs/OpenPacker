# Loss-aware IR and semantics profiles

PREX normalizes only stable shared layers. Native metadata is retained in
`nativeSemantics`; any inexact translation emits a `SemanticLoss` with code,
severity, ecosystem/path, original meaning, represented or omitted meaning,
mitigation, and profiles blocked by the loss. Policy may deny a code or a
severity. Silent approximation is invalid.

## Core IR

| Object                  | Meaning                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PackageInstance`       | Deterministic exact node with identity, native version/sort key, relations, artifacts, lifecycle, snapshot and metadata digests, native semantics, and semantic loss |
| `Requirement`           | Sourced, authorized relation with kind, optionality, raw/native meaning, and a discriminated expression                                                              |
| `RequirementExpression` | Package, capability, `allOf`, `anyOf`, `not`, or target-conditional expression                                                                                       |
| `Capability`            | Versioned/attributed offer by a selected node, optionally target-gated                                                                                               |
| `Conflict`              | Negative expression scoped to solution, package, or target                                                                                                           |
| `CardinalityConstraint` | Minimum/maximum selected matches for a selector and scope; coexistence is explicit, never globally one-version-per-name                                              |
| `TargetPredicate`       | Side-effect-free bounded Boolean tree over target fields, version membership, and capabilities                                                                       |
| `ResolutionUniverse`    | Complete immutable packages, overlays, snapshots, lifecycle root, target vocabulary, and canonical digest                                                            |

Requirement kinds preserve `runtime`, `build`, `development`, `peer`,
`optional`, `feature`, `tool`, `platform`, `replacement`, `conflict`, and
`unknown-native`. They are classification, not permission to discard richer
native semantics.

## Overlays

An `OpenPackerOverlay` adds provenance-bound cross-ecosystem requirements,
capabilities, conflicts, cardinality, or artifact annotations without claiming
they came from native metadata. Authorities are `publisher`, `registry`,
`organization`, `user`, and `test-fixture`; policy decides which are accepted.
Conflicts are diagnostics, not last-writer-wins. The overlay digest and
authority policy enter the universe/receipt evidence. See
[Overlay integration](../integrations/overlays.md).

## Profiles

| Profile                   | Claim                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native-capture-v1`       | Records a native resolver result, inputs, lock state, and available native explanation; OpenPacker does not claim it solved the graph                                                |
| `native-validated-v1`     | Captures native output and independently checks every faithfully represented hard relation, reporting every native semantic not checked                                              |
| `prex-calculus-subset-v1` | Directly solves bounded package/capability requirements, conjunction, alternatives, negation/conflicts, optional edges, target conditions, replacements, and cardinality/coexistence |

The OpenPacker reference daemon advertises and executes all three profiles.
Native modes require a non-empty, uniquely resolvable `environment.locked`
selection of node IDs or exact PURLs. Capture mode marks represented witnesses
inactive and emits structured unvalidated-semantics loss; validated mode checks
represented hard relations but does not claim native-semantics validation or
objective optimization. Clients must treat capability discovery as
authoritative.

## Formal correspondence and limits

An exact package instance is a hypergraph vertex. A capability is a
provider-labelled projection. Requirements compile to hyperedges from a depender
to alternative satisfying vertex sets; conflicts become negative clauses, target
predicates control activation, cardinality supplies bounds, and objectives
lexicographically order valid selected sets.

This is an implemented correspondence to HyperRes-style dependency hypergraphs
and a tested subset informed by Package Calculus. It is not a claim of full
equivalence. Peer dependency negotiation, Cargo feature unification, NuGet
target-framework behavior, workspaces, build/link/runtime behavior, and
installer semantics remain native when they cannot be translated exactly.
Research provenance and primary sources are collected in
[Formal foundations](../research/formal-foundations.md).
