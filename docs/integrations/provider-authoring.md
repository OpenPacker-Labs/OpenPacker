# OpenPacker extension authoring

OpenPacker extensions implement transport-neutral contracts; they do not modify
PREX schemas or resolver semantics. The public interfaces live with the behavior
they extend and are re-exported by `@openpacker/testkit` for conformance checks.

| Extension                         | Contract owner               | Required behavior                                                                                                                |
| --------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CatalogProvider`                 | `@openpacker/adapter-core`   | Identify, enumerate, inspect, fetch artifact records, and produce immutable offline-replay snapshots through an ecosystem codec. |
| `EcosystemCodec`                  | `@openpacker/adapter-core`   | Pure PURL/native coordinate, version, range, VERS, metadata, and lock translation; no network access.                            |
| `ArtifactSource` / `ArtifactSink` | `@openpacker/artifact-model` | Stream immutable descriptor-addressed bytes, ranges, manifests, and referrers without rewriting content.                         |
| `ReceiptSigner`                   | `@openpacker/trust`          | Sign the supplied canonical receipt-digest message with a maintained algorithm implementation.                                   |
| `EvidenceVerifier`                | `@openpacker/testkit`        | Return typed evidence facts without collapsing invalid, absent, unknown, or denied states.                                       |
| `PolicyRule`                      | `@openpacker/testkit`        | Produce a deterministic typed result for canonical policy facts.                                                                 |
| `EventSink`                       | `@openpacker/events`         | Accept validated canonical CloudEvents and return an event ID plus replay checkpoint.                                            |
| `Clock` / `CredentialResolver`    | `@openpacker/adapter-core`   | Inject RFC 3339 evaluation time and resolve secret references without persisting secrets.                                        |

## Extension descriptor

Long-term adapters implement the WIT world
[`spec/wit/prex-adapter.wit`](../../spec/wit/prex-adapter.wit) and return a
[Registry Definition](../../spec/prex/v1/registry-definition.md) from
`registry.service-index`. TypeScript `CatalogProvider` / `InstallerProvider`
interfaces remain the in-process migration shape.

Wrap a TypeScript implementation in `OpenPackerExtension<T>` with an
`ExtensionDescriptor` containing:

- reverse-domain `id` and SemVer `version`;
- a unique non-empty capability list;
- JSON configuration schema;
- supported PREX protocol versions;
- `deterministic`, `input-deterministic`, or `nondeterministic` guarantee;
- explicit security boundaries; and
- structured startup diagnostics.

Capabilities describe observable operations, not marketing labels. Configuration
schemas reject unknown security-sensitive fields. Credential values use secret
references and never enter snapshots, receipts, logs, or diagnostics.

## Conformance

Run the descriptor check for every extension and the matching behavioral probe
from `@openpacker/testkit`. The probes cover:

- descriptor completeness and protocol compatibility;
- PURL canonicalization idempotence and version-order laws;
- deterministic offline enumeration and snapshot provider identity;
- exact artifact descriptor and byte preservation;
- signer/verifier agreement;
- typed, deterministic evidence-verifier results;
- deterministic policy results;
- RFC 3339 clocks and credential value shape; and
- CloudEvent ID, canonical-byte, and checkpoint preservation.

`assertConforms(report)` fails on any unsuccessful check. Provider packages
should add deterministic HTTP fixtures for provider-specific retries, redirects,
ETags, pagination, limits, corruption, and cancellation; the generic testkit
deliberately does not invent provider-specific metadata.

Every behavioral probe first checks the complete required method surface. A
partially shaped object therefore produces named `method:<name>` failures
instead of passing because one happy-path method happened to exist. The catalog
probe invokes identify, enumerate, inspect, artifact-record lookup, and
snapshot; artifact probes exercise referrer methods as well as byte transfer.

## Catalog provider rules

A provider uses an `EcosystemCodec`; it must not reimplement ecosystem parsing
or ordering. Capture every solve input into a stable `SourceSnapshot` with
canonical response-order sorting, record digests, root digest, provider
identity, revision or ETag, retrieval time, and evaluation time. Keep bounded
raw metadata by digest reference. Offline replay must yield the same snapshot
independent of response order.

Provider facts retain their source and authority. Translate unrepresentable
native meaning into structured `SemanticLoss`; never silently approximate.
Enrichment providers add namespaced evidence and warnings and do not change
canonical PURLs.

The optional reference enrichers follow the documented
[deps.dev v3 API](https://docs.deps.dev/api/v3/) and Sonatype's
[Component Details REST API](https://help.sonatype.com/en/component-details-rest-api.html).
Provider-specific coordinates are evidence only: Sonatype documents that some of
its
[PURL handling](https://help.sonatype.com/en/package-url-and-component-identifiers.html)
may deviate from the PURL specification, so a provider must report the mismatch
instead of rewriting canonical PREX identity.

Construct `BoundedFetchTransport` with the exact HTTP(S) origins the provider
may contact. Every initial and redirected URL must remain in that allowlist;
credentials are stripped between allowed origins. Production first-party
registry traffic uses `destinationPolicy: 'classify-and-pin'`: public default
origins are allowlisted-not-pinned, and `pinnedOrigins` are never inferred from
`allowedOrigins`. An operator-named endpoint (`OPM_REGISTRY_*` or
`[registries.<id>].url`) is pinned; extra `OPM_REGISTRY_<ECO>_ORIGINS` entries
are allowlisted only. Private or localhost origins in default `origin-allowlist`
mode are therefore available to explicit test/live configurations and
`RegistryClient` loopback fixtures, never by default.

## Artifact and event rules

Artifact implementations verify digest and size before returning success,
propagate cancellation, bound streams, and never forward credentials to a
different host. Mutable locations are retrieval hints, not content identity.

Event sinks accept `PublishedEvent`, which pairs a typed CloudEvent with its
exact canonical bytes. Delivery is at least once: consumers deduplicate by event
ID and persist checkpoints. A sink may use SQLite, files, queues, or another
transport, but PREX does not require Kafka, NATS, ATProto, or any vendor
service.

## Security review

Document trust boundaries for configuration, credentials, network destinations,
redirects, raw metadata, artifacts, clocks, and diagnostics. Fail closed on
unsupported protocol majors, malformed immutable identifiers, digest mismatch,
secret leakage risk, cancellation, and capability mismatch. An extension must
report a real error; it must not return a placeholder or fake success.
