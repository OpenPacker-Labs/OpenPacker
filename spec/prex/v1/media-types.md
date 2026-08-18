# Provisional media types

These vendor media types are provisional and claim no IANA registration.
Producers MUST include their version and consumers MUST use capability discovery
before selecting them.

| Constant         | Media type                                            |
| ---------------- | ----------------------------------------------------- |
| package metadata | `application/vnd.openpacker.package.metadata.v1+json` |
| PREX receipt     | `application/vnd.openpacker.prex.receipt.v1+json`     |
| overlay          | `application/vnd.openpacker.overlay.v1+json`          |
| chunk index      | `application/vnd.openpacker.chunk-index.v1+json`      |
| lifecycle event  | `application/vnd.openpacker.lifecycle.v1+json`        |
| explanation      | `application/vnd.openpacker.explanation.v1+json`      |
| proof            | `application/vnd.openpacker.proof.v1+json`            |
| lockfile         | `application/vnd.openpacker.lock.v1+json`             |
| normalized pack  | `application/vnd.openpacker.normalized-pack.v1+json`  |
| pack receipt     | `application/vnd.openpacker.pack-receipt.v1+json`     |
| tree manifest    | `application/vnd.openpacker.tree-manifest.v1+json`    |
| build recipe     | `application/vnd.openpacker.build-recipe.v1+json`     |
| substitute       | `application/vnd.openpacker.substitute.v1+json`       |
| problem          | `application/problem+json`                            |
| event stream     | `application/x-ndjson` or `text/event-stream`         |

OCI manifests retain standard OCI media types and use `artifactType`, `subject`,
annotations, and referrers. A future registered media type is a negotiated
additive migration: providers advertise both values during transition; canonical
object bytes and digest relationships do not change merely because the envelope
media type changes.
