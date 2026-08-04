# Nix

How Nix store paths, derivations, closures, and binary caches normalize into the
PREX model. This page is the worked reference for the constructs described in
[ADR 0029](../adr/0029-nix-ecosystem-mapping.md); the executable version lives
in `fixtures/protocol/nix/`, whose digests are recomputed by
`packages/canonical` tests.

OpenPacker **captures and verifies** Nix facts. It never evaluates a Nix
expression and never runs a builder — see invariant 10 in
[`spec/prex/v1/normative.md`](../../spec/prex/v1/normative.md).

## Identity

A store path becomes an exact PURL. `/nix/store/b3f2…-libgreet-1.0`, output
`out`, built by `/nix/store/97ml…-libgreet-1.0.drv`:

```
pkg:nix/libgreet@1.0?outhash=b3f2…&output=out&plan=97ml…
```

| Nix concept       | PREX location                                      |
| ----------------- | -------------------------------------------------- |
| store-path hash   | `outhash` qualifier (opaque; not a PREX digest)    |
| output name       | `output` qualifier (reserved across ecosystems)    |
| derivation        | `plan` qualifier + a `BuildRecipe` in the universe |
| flake / source    | `identity.sourceRefs`                              |
| store path itself | `identity.nativeCoordinates[].coordinate`          |

Because qualifiers already enter the `package-node-v1` projection, two rebuilds
with different inputs get different `nodeId`s with no change to identity
computation. Store hashes are truncated base32, so they stay strings and every
instance records `NIX_STORE_PATH_HASH_OPAQUE`.

## Derivations

One `BuildRecipe` per `.drv`, with `kind: derivation` and
`provenance: captured`. Its `inputs` carry the platform role they were consumed
for (`source`, `build`, `host`, `target`), and its `outputs` carry each output's
`inputAddress` and `expectedTreeDigest`.

`recipeOutputId` — the `recipe-output-v1` digest over
`{outputName, recipeDigest}` — is the store-path analog: output identity that
exists before any bytes do. Sibling outputs share a `recipeDigest` and differ
only by name.

The `.drv` file itself travels as an ordinary artifact (`nativeRole: nix-plan`,
`application/x-nix-drv`), so its native ATerm bytes are preserved rather than
rewritten.

## Outputs and propagation

Each output is its own `PackageInstance`, selected through the `output`
qualifier. Propagation needs no special rule: `libgreet.dev` requiring
`libgreet.out` is an ordinary runtime requirement on its sibling.

```json
{
  "type": "package",
  "purl": "pkg:nix/libgreet",
  "vers": "vers:nix/1.0",
  "qualifiers": { "outhash": "b3f2…", "output": "out" },
  "outputs": ["out"]
}
```

## Closures and NARs

A NAR is an artifact: `nativeRole: nix-output-nar`, media type
`application/x-nix-nar`, with its SHA-256 verified on materialize like any
archive. Its `treeDigest` is the PREX tree identity of the extracted output.

Runtime references — what Nix discovers by scanning output bytes for embedded
store paths — land in `ArtifactDescriptor.runtimeReferences`. Scanning is
read-only byte analysis and is explicitly not build execution. The reference
closure is then the least fixpoint over those edges.

> A PREX `treeDigest` is **not** comparable to `nix hash path` output. Tree
> identity is a canonical JSON manifest of per-file digests, not NAR
> serialization ([ADR 0024](../adr/0024-canonical-tree-manifests.md)). Carry a
> native NAR hash alongside in `externalRefs` if you need to cross-check.

## Binary caches

A narinfo becomes a `SubstituteDescriptor`: subject, tree digest, size, runtime
references, deriver, and locations. Raw narinfo bytes ride along as a
digest-bound referrer on the NAR artifact.

Two rules keep substitution honest:

1. A substitute never establishes identity. Verify the artifact digest or tree
   digest before trusting fetched bytes. The `substitute-v1` projection excludes
   `/locations`, so the same content behind any number of mirrors has one
   digest.
2. Cache signatures are evidence for policy, not identity. An unverified
   signature records `SUBSTITUTE_UNVERIFIED`; OpenPacker trusts no cache
   implicitly.

## Profiles and honesty

A captured store graph carries `derivation-capture-v1` on its recipes. Because
its selections are exact, the universe is still solvable under
`prex-calculus-subset-v1`.

| Code                           | When                                                 |
| ------------------------------ | ---------------------------------------------------- |
| `NIX_STORE_PATH_HASH_OPAQUE`   | always — store hashes are not PREX digests           |
| `NIX_EXPRESSION_NOT_EVALUATED` | the expression behind a derivation was not evaluated |
| `NIX_UNVERSIONED_NAME`         | a name carried no parseable version                  |
| `SUBSTITUTE_UNVERIFIED`        | substituted bytes lacked a verified cache signature  |

## What is not supported

Nix expression evaluation, building or realising anything, overlay-style
attribute overrides (use
[amendments](../adr/0028-amendments-supersede-interpretation.md), which
supersede interpretation rather than facts), NixOS activation, and store garbage
collection.

## The codec

`@openpacker/adapter-nix` implements the mapping above and is registered in the
reference daemon, so `pkg:nix` normalize, identify, and inspect work without
extra configuration.

It consumes `nix path-info --json` entries: `path` becomes the exact PURL and
native coordinate, `deriver` becomes the `plan` qualifier, `references` become
runtime requirements on exact sibling paths (the self-reference is dropped),
`narHash` becomes the output artifact digest when it is sha256 — other
algorithms record `CONTENT_ADDRESS_UNSUPPORTED` rather than being coerced — and
`output` becomes the declared package output.

Version comparison follows Nix rather than semver: components split on `.`, `-`,
and digit/non-digit boundaries, numeric components compare numerically, and a
pre-release marker sorts before the bare release. Nix has no range syntax, so a
captured requirement is always exact; anything range-shaped records
`NIX_RANGE_NOT_REPRESENTED`.

A closure listing (`nix path-info --json --recursive`) captures as a lock
result, which is the closest Nix equivalent of a lockfile: an exact,
already-resolved set.
