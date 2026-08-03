# ADR 0026: Package outputs and build/host/target platforms

- Status: Accepted
- Date: 2026-08-03

## Context

Two gaps blocked PREX from describing packages that are not language-registry
artifacts.

First, a package was one indivisible thing. Ecosystems routinely split one build
into separately installable parts — headers, shared libraries, documentation,
debug symbols — and consumers want the parts they need, not all of them. PREX
could hold many artifacts per package, but they were files of one package
distinguished by target predicate, not parts a dependency could ask for.

Second, `SolveRequest` carried exactly one `TargetContext`. Cross compilation
needs three: the platform doing the building, the platform the result runs on,
and the platform the result itself emits code for. `Requirement.kind` already
recorded `build` and `tool`, but nothing read it, so a compiler needed at build
time was indistinguishable from a library needed at run time.

## Decision

**Outputs refine materialization; the node stays the unit of selection.**
`PackageInstance.outputs` names the parts a package exposes,
`RequirementExpression.package.outputs` asks for specific ones,
`DependencyEdge.toOutputs` records which were needed, and
`MaterializeRequest.outputs` restricts what gets extracted. Absent means one
implicit default output, so every existing document keeps its meaning. Outputs
deliberately do not become SAT variables: that would change proof and witness
semantics for a benefit ecosystems can already get by minting per-output
instances distinguished by the reserved `output` qualifier, which the solver
already matches exactly.

**Platforms are explicit and requirement kinds decide which one applies.**
`SolveRequest.platforms` supplies `build`, `host`, and `target` contexts. The
existing `target` field is normatively the host, and `platforms.host` must equal
it. Absent members fall back to the host, so a request without `platforms`
behaves exactly as before — every platform is the same context.

`TargetPredicate.path` accepts optional `build.`, `host.`, and `target.`
prefixes. An unprefixed path resolves against the platform its requirement is
consumed on: `build` and `tool` requirements resolve against the build platform,
everything else against the host. `requirementKindPolicy` overrides that mapping
and can mark kinds inactive for a solve.

Because a single-platform solve makes all three contexts identical, kind
attribution is always applied and is simply unobservable without `platforms` —
one rule rather than a conditional one.

## Consequences

A cross-compilation request is expressible without inventing a second solve
mode, and the same node may appear once per platform because
`CardinalityConstraint` already legalizes coexistence. The resolver, the
independent checker, and the resolvo compilation path all resolve predicates
through the same platform view, so none of them can silently disagree about
which platform a predicate meant — a disagreement the bounded oracle would
otherwise surface as an invalid proof.

The honest limits: PREX models one build/host/target split, not the full staging
graph of ecosystems that distinguish further (`depsBuildBuild` and relatives).
Those stay in `nativeSemantics` with `CROSS_STAGE_APPROXIMATED`. Per-output
solving remains out of the calculus subset, recorded as
`OUTPUT_GRANULARITY_COLLAPSED` when an ecosystem's native semantics needed it.
