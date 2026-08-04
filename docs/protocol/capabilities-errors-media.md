# Capabilities, errors, and media types

## Capability discovery

### Control plane

`Capabilities` is defined in
[`operations.schema.json`](../../spec/prex/v1/schemas/operations.schema.json). A
consumer must negotiate all fields relevant to its call:

- protocol versions, provider ID, implementation version, and optional build
  digest;
- operations and independently earned conformance levels;
- PURL types, VERS schemes, semantics profiles, and target dimensions;
- evidence types, artifact transports, content encodings, and event bindings;
- request, batch, universe, graph, artifact-metadata, page, and streaming
  limits;
- authentication scheme descriptions without credentials; and
- provider extension schema references.

An empty list means unsupported, not unknown. A provider advertises only checks
it passes; clients must not assume the OpenPacker reference daemon's full set
for another provider.

### Package sources (Registry Definition)

Per-source capability discovery uses a **Registry Definition** service index
([normative](../../spec/prex/v1/registry-definition.md),
[schema](../../spec/prex/v1/schemas/registry-definition.schema.json)). Versioned
resource `@type` values (NuGet-style) advertise search, enumerate, metadata,
artifact, install, update, uninstall, and environment. Missing type ⇒
unsupported. Adapters expose the document via the WIT `registry.service-index`
export ([prex-adapter.wit](../../spec/wit/prex-adapter.wit)).

Control-plane capabilities and Registry Definitions answer different questions;
clients merge both when negotiating a call.

## Conformance capabilities

| Level  | Capability     |
| ------ | -------------- |
| PREX-N | Normalize      |
| PREX-I | Identity       |
| PREX-E | Enumerate      |
| PREX-D | Inspect        |
| PREX-S | Solve          |
| PREX-M | Materialize    |
| PREX-V | Verify         |
| PREX-X | Explain        |
| PREX-R | Receipts       |
| PREX-C | Catalog events |

The exact obligations are in [Conformance](conformance.md).

## Problem Details

Failures use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
`application/problem+json`. Alongside `type`, `title`, `status`, and optional
`detail`/`instance`, PREX defines `code`, `retryable`, and optional
`correlationId`, `violations`, `explanationRef`, `provider`, and
`upstreamStatus`.

| Class                  | Stable codes                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input and support      | `INVALID_REQUEST`, `INVALID_PURL`, `INVALID_VERS`, `INVALID_NATIVE_COORDINATE`, `UNSUPPORTED_ECOSYSTEM`, `UNSUPPORTED_SEMANTICS_PROFILE`, `PROVIDER_CAPABILITY_MISSING` |
| Identity and catalog   | `AMBIGUOUS_IDENTITY`, `PACKAGE_NOT_FOUND`, `VERSION_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `SNAPSHOT_MISMATCH`, `STALE_METADATA`                                             |
| Resolution and policy  | `UNSATISFIABLE`, `SEMANTIC_LOSS_REJECTED`, `POLICY_DENIED`, `LIFECYCLE_DENIED`                                                                                          |
| Artifact and trust     | `ARTIFACT_NOT_FOUND`, `DIGEST_MISMATCH`, `SIZE_MISMATCH`, `INVALID_SIGNATURE`, `PROVENANCE_MISMATCH`                                                                    |
| Transient and internal | `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `CANCELLED`, `INTERNAL_ERROR`                                                                                                   |

Validation and semantic errors are non-retryable. Only an explicitly retryable
problem should be retried, and side-effecting requests also require an
idempotency key. Responses must not expose bearer tokens, credentials, stack
traces, or host paths.

## Provisional media types

These vendor types are centralized in
[`media-types.md`](../../spec/prex/v1/media-types.md) and claim no IANA
registration.

| Object            | Media type                                               |
| ----------------- | -------------------------------------------------------- |
| Package metadata  | `application/vnd.openpacker.package.metadata.v1+json`    |
| PREX receipt      | `application/vnd.openpacker.prex.receipt.v1+json`        |
| Overlay           | `application/vnd.openpacker.overlay.v1+json`             |
| Chunk index       | `application/vnd.openpacker.chunk-index.v1+json`         |
| Lifecycle event   | `application/vnd.openpacker.lifecycle.v1+json`           |
| Explanation graph | `application/vnd.openpacker.explanation.v1+json`         |
| Proof             | `application/vnd.openpacker.proof.v1+json`               |
| Lockfile          | `application/vnd.openpacker.lock.v1+json`                |
| Problem           | `application/problem+json`                               |
| Event stream      | `application/x-ndjson` or negotiated `text/event-stream` |

OCI manifests and indexes retain their standard OCI media types. A later
registered type is introduced through capability negotiation; merely changing an
envelope type must not rewrite canonical object bytes or digest bindings.
