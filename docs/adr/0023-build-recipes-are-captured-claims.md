# ADR 0023: Build recipes are captured claims, not executed derivations

- Status: Accepted
- Date: 2026-08-03

## Context

Ecosystems built around derivations — Nix, Guix, and to a lesser degree source
distributions, container image builds, and cross toolchains — carry identity
that a registry `name@version` cannot express. Their central idea is that a
package's identity derives from the hash of everything that went into it: the
build plan, the inputs, and the platform. PREX had no object for this. It
modeled fetched artifacts and their metadata, so a rebuild with different
dependencies was indistinguishable from the original.

[ADR 0020](0020-control-plane-not-supersession.md) and the product non-goals
forbid OpenPacker from executing builds, and materialization is deliberately
extract-only. Adding a builder would replace the ecosystems PREX coordinates.

## Decision

PREX models a build plan as a **`BuildRecipe`**: a normalized, captured claim
about how bytes came to be. It is never executed, never evaluated, and never a
substitute for the native tool.

- `recipeDigest` is the `build-recipe-v1` projection digest of the recipe.
- `recipeOutputId` is the `recipe-output-v1` projection digest over
  `{outputName, recipeDigest}` — output identity that exists before any bytes
  do. This is the store-path analog.
- `ArtifactDescriptor.producedBy` binds realised bytes to
  `{recipeDigest, outputName}`. Verifying that claim is an evidence fact, never
  identity.
- `provenance` records how the recipe was obtained (`captured`, `attested`,
  `declared`). There is no `executed` value, because PREX never executes.
- `hashMode` distinguishes `input-addressed`, `content-addressed`, and
  `fixed-output` outputs. A `fixed-output` recipe MUST pin an expected digest;
  otherwise it pins nothing.
- Recipes travel in `ResolutionUniverse.recipes` and carry the capture profile
  `derivation-capture-v1`.

Node identity is unchanged. `package-node-v1` still hashes the exact PURL,
qualifiers, and native semantics version, so every existing `nodeId` keeps its
value. Ecosystems that need input-addressed node identity surface the input
address as reserved qualifiers, which already flow into that projection.

## Consequences

PREX can normalize, pin, transport, and audit derivation-shaped ecosystems
without acquiring a build system. A captured recipe supports questions the
protocol previously could not answer — which inputs produced this artifact,
which outputs share a plan, whether two rebuilds differ — while the honest limit
stays explicit: PREX verifies claims about builds, it does not reproduce them.
`derivation-verified-v1` is reserved for a future profile in which an external
builder attests a rebuild; it is deliberately not claimed today.
