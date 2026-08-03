# Ecosystem codec authoring

An `EcosystemCodec` is pure ecosystem semantics. It performs no HTTP,
filesystem, credential, clock, or process operation. The interface is exported
by `@openpacker/adapter-core`; npm, Cargo, and NuGet are the executable
references.

## Required behavior

| Member                  | Obligation                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `purlType`              | Stable supported PURL type                                                                                          |
| `parseNativeCoordinate` | Preserve original coordinate and split ecosystem/name/namespace/version without ambiguity                           |
| `canonicalizePurl`      | Apply the PURL specification plus ecosystem case and encoding rules; remain idempotent                              |
| `parseNativeVersion`    | Return original/normalized form and deterministic ordering data                                                     |
| `compareNativeVersions` | Implement native ordering as a comparator; do not delegate blindly to lexical or generic SemVer                     |
| `parseNativeRange`      | Return native AST, normalized text, optional exact VERS, reversibility, and semantic loss                           |
| `toVers`                | Emit VERS only when membership is preserved                                                                         |
| `satisfies`             | Evaluate membership through the same native comparator/range AST                                                    |
| `translateMetadata`     | Produce a complete `PackageInstance`, provenance, raw metadata reference/digest, native semantics, and loss records |
| `translateLockResult`   | Preserve tool/format version, exact selections, dependencies, locations/digests, raw native data, and semantic loss |

Use shared `parsePurl`/`formatPurl` and canonical/digest functions. A codec must
not duplicate them or fetch metadata. Unsupported native relations remain
versioned under `nativeSemantics`; the codec records what was not represented
and which resolution profile it blocks.

## Minimal acceptance evidence

Add deterministic fixtures and one codec test covering coordinate and PURL round
trip, normalization idempotence, version comparator properties, native range
membership, exact/non-exact VERS translation, metadata provenance, and lock
capture. Then wrap the codec in the `OpenPackerExtension` descriptor and run
`checkEcosystemCodec` from `@openpacker/testkit`.

Provider transport is a separate `CatalogProvider`; follow the Janus-owned
[provider guide](provider-authoring.md). This separation makes the same codec
usable with live HTTP, captured fixtures, and offline snapshots.

## Ecosystem sources

Codec behavior is checked against the native authorities, not inferred from a
generic SemVer library:

- npm:
  [registry package metadata](https://github.com/npm/registry/blob/master/docs/responses/package-metadata.md)
  and
  [package-lock format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json);
- Cargo:
  [registry index format](https://doc.rust-lang.org/cargo/reference/registry-index.html),
  [dependency requirements](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html),
  and
  [lockfile format](https://doc.rust-lang.org/cargo/reference/lockfile-format.html);
- NuGet:
  [V3 API overview](https://learn.microsoft.com/en-us/nuget/api/overview),
  [service index](https://learn.microsoft.com/en-us/nuget/api/service-index),
  and
  [registration metadata](https://learn.microsoft.com/en-us/nuget/api/registration-base-url-resource).

These documents define source behavior. PREX still preserves the original native
range and metadata whenever an exact VERS translation is impossible.
