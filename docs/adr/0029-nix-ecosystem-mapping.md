# ADR 0029: Nix ecosystem mapping

- Status: Accepted
- Date: 2026-08-03

## Context

Nix is the most demanding ecosystem PREX has tried to normalize: identity comes
from the hash of a build plan rather than a registry version, one derivation
produces several separately installable outputs, dependencies are a closure of
store paths rather than a manifest graph, and binary caches serve prebuilt
outputs. Deciding how Nix maps onto PREX forces every earlier decision in this
series to be concrete rather than theoretical.

## Decision

A Nix **output path** is a `PackageInstance`. A Nix **derivation** is a
`BuildRecipe` referenced by its outputs, never an identity.

`/nix/store/<hash>-libgreet-1.0` with output `out` becomes:

```
pkg:nix/libgreet@1.0?outhash=<hash>&output=out&plan=<drv-hash>
```

- `purlType` is `nix`; `namespace` is absent, because the store is flat. Flake
  origin is provenance and lives in `identity.sourceRefs`.
- `outhash` carries this output's store-path hash and `plan` ties sibling
  outputs to one derivation. Both are exact-PURL qualifiers, so they already
  flow into `package-node-v1` — **two rebuilds with different inputs get
  different node identities using the existing projection**, with no change to
  how node identity is computed.
- `output` is the reserved cross-ecosystem output selector, so a requirement can
  ask for `dev` rather than `out` through the qualifier match the solver already
  performs.
- A name with no parseable version uses the store hash as its exact version and
  records `NIX_UNVERSIONED_NAME`, rather than inventing `0.0.0`.

Store-path hashes are truncated base32 and are **not** SHA-256 hex, so they stay
opaque qualifier strings with `NIX_STORE_PATH_HASH_OPAQUE`. They are never
presented as a PREX `Digest`. NAR bytes, by contrast, are an ordinary artifact:
`nativeRole: nix-output-nar`, verified on materialize exactly like any archive.
The `.drv` travels the same way with `nativeRole: nix-plan`.

Propagated outputs need no new machinery: `dev` depending on `out` is an
ordinary runtime requirement on its sibling. Closures use `runtimeReferences`;
narinfo becomes a `SubstituteDescriptor` plus digest-bound referrer evidence.

What PREX will not do: evaluate Nix expressions, run builders, or implement
overlay-style overrides. A capture that lost expression-level meaning records
`NIX_EXPRESSION_NOT_EVALUATED`.

## Consequences

The mapping validates the design: multi-output derivations, input-addressed
identity, closures, and cache substitution all land on constructs added for
every ecosystem, not on Nix-specific escapes. The worked example under
`fixtures/protocol/nix/` is executable evidence — its digests are recomputed by
tests, so a change to any projection surfaces there.

The honest limits are that a captured Nix graph is a snapshot of a realised
store, not a reproducible evaluation, and that PREX tree digests cannot be
compared with `nix hash path` output. Implementing an `adapter-nix` codec that
captures from `nix path-info --json`, `nix derivation show`, and narinfo is
follow-on work; this ADR fixes the target shape it must produce.
