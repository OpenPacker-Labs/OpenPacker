# ADR 0025: Runtime references and substitute descriptors

- Status: Accepted
- Date: 2026-08-03

## Context

PREX could describe which packages a solve selected, but not which realised
artifacts a realised artifact actually needs at run time. Dependency edges come
from declared metadata: they answer "what did the manifest say", not "what do
these bytes reference". Realisation ecosystems depend on the second question,
because a runtime closure is what gets copied, cached, and garbage-collected.

Separately, binary caches (Nix substituters, and the same pattern in other
systems) advertise prebuilt content: here is the output for this plan, here is
its size, here are its references, here is who built it. PREX had mirror
selection for native archives via `ArtifactLocation.priority`, but no way to
carry that advertisement — and no place to record that a cache's signature was
or was not verified.

## Decision

Runtime references are recorded on the artifact that holds them:
`ArtifactDescriptor.runtimeReferences` is a list of `ArtifactReference`
selectors (`artifactDigest`, `recipeOutputId`, or `nodeId`). The **reference
closure** of a set is the least fixpoint under those edges, defined in
`spec/prex/v1/semantics.md`. Computing it is a materialization-side concern,
never a solver obligation.

Discovering references by reading artifact bytes is permitted. Scanning is
read-only byte analysis and is explicitly not build execution — a distinction
`normative.md` now states, so that a reference scanner cannot be mistaken for a
loophole in the no-execution rule.

Prebuilt availability is a **`SubstituteDescriptor`**: subject, `treeDigest`,
size, runtime references, optional deriver, optional chunk index, and locations.
Two rules keep it honest:

1. A substitute never establishes identity. Consumers MUST verify the artifact
   digest or the tree digest before trusting fetched bytes. The `substitute-v1`
   projection excludes `/locations` for exactly this reason: the same content
   behind ten mirrors has one digest.
2. Cache signatures are evidence for policy, not identity. An unverified
   substituter signature yields `SUBSTITUTE_UNVERIFIED`; policy decides what
   that means. PREX does not implicitly trust any cache.

## Consequences

Closure-shaped operations — copy this output and everything it needs, decide
what is collectible, ask a cache whether it already has this tree — become
expressible in normalized form. Because references carry their own provenance
once assembled into a closure, a consumer can tell a declared graph from an
observed one instead of being handed a single unlabeled DAG.

The chunk index already in the protocol composes directly: a substitute may
point at one, making delta transfer available without a second mechanism. What
this ADR does not add is a fetch protocol, a cache trust store, or garbage
collection; those are implementations over the facts defined here.
