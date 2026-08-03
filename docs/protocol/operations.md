# PREX operations

The OpenAPI 3.1 document at
[`spec/prex/v1/openapi.yaml`](../../spec/prex/v1/openapi.yaml) is the HTTP
authority. Equivalent SDK and embedded calls preserve the same normalized
objects. Every PREX response carries `meta.protocolVersion` and provider
identity. Computational requests accept bounded context for correlation, trace
context, timeout, provider selection, semantics profile, idempotency, and
evaluation time; transport-only values do not enter canonical digests.

## Discovery and status

| Method and path         | Result                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| `GET /.well-known/prex` | Full `Capabilities` document used before negotiation                         |
| `GET /v1/capabilities`  | Same capability document at the versioned service surface                    |
| `GET /v1/health`        | Process liveness plus protocol/provider identity                             |
| `GET /v1/ready`         | Readiness of the configured state store; failure is RFC 9457 Problem Details |

Discovery is side-effect free. Clients reject unsupported protocol major
versions and must not infer an operation from the presence of a route: the
advertised `operations` and conformance levels are authoritative.

## Normative PREX operations

| Level  | Method and path                          | Request                                                                                      | Successful result and invariant                                                                                                                                     |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PREX-N | `POST /v1/normalize`                     | Bounded batch of PURL, VERS, native coordinate/version/range, digest, or target items        | Original and canonical forms, parsed form, reversibility, warnings, and semantic loss; one bad item fails the request                                               |
| PREX-I | `POST /v1/identify`                      | PURL, ecosystem/native coordinate, alias, source ref, or external ref                        | `identified`, `ambiguous`, or `not-found` plus all candidates, confidence, provenance, and warnings; ambiguity is never silently selected                           |
| PREX-E | `POST /v1/enumerate`                     | Base PURL, optional VERS, target, lifecycle visibility, and stable page                      | Exact versions in codec-native ascending order, lifecycle, artifacts, source snapshot, metadata digest, and next cursor                                             |
| PREX-D | `POST /v1/inspect`                       | Exact PURL or exact ecosystem coordinate                                                     | Loss-aware `PackageInstance`, including native semantics, requirements, capabilities, conflicts, cardinality, artifacts, lifecycle, provenance, and metadata digest |
| PREX-S | `POST /v1/solve`                         | Complete normalized request; the configured resolver receives an immutable universe snapshot | Selected instances, solution, independent proof, explanation graph, and unsigned or signed receipt; a failed proof is `INTERNAL_ERROR`                              |
| PREX-M | `POST /v1/materialize`                   | Exact PURL, solution node, artifact descriptor, or digest; optional forensic flag            | Immutable descriptor and restrictions. Resolution and local extraction are separate actions                                                                         |
| PREX-V | `POST /v1/verify`                        | Signed receipt, artifact descriptor, or external reference; named checks and evaluation time | Per-evidence six-state facts and a separate `allow`, `deny`, or `indeterminate` decision                                                                            |
| PREX-X | `POST /v1/explain`                       | Solution digest and `graph`, `text`, or `both`                                               | Normative explanation graph and optional derived prose                                                                                                              |
| PREX-R | `GET /v1/receipts/{algorithm}/{digest}`  | Canonical digest path                                                                        | Exact stored canonical receipt envelope bytes                                                                                                                       |
| PREX-R | `GET /v1/snapshots/{algorithm}/{digest}` | Canonical digest path                                                                        | Exact stored canonical snapshot bytes                                                                                                                               |
| PREX-C | `GET /v1/events?cursor=N&limit=M`        | Exclusive checkpoint and bounded page size                                                   | NDJSON CloudEvents and `x-openpacker-next-cursor`; see [Events](events.md)                                                                                          |

`VerifyResponse.evidence[].status` is one of `valid`, `invalid`, `not-provided`,
`unknown`, `not-applicable`, or `policy-denied`. Absence and policy denial are
not signature or digest failure.

## OpenPacker implementation operations

These routes are not PREX conformance operations and stay outside the normative
namespace.

| Method and path                        | Reference behavior                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /v1/openpacker/catalog/import`   | Validates/imports a snapshot-shaped canonical object and stores it by digest      |
| `POST /v1/openpacker/catalog/snapshot` | Captures configured universe snapshots, optionally filtered by provider ID        |
| `POST /v1/openpacker/lifecycle/apply`  | Applies the configured lifecycle extension operation                              |
| `POST /v1/openpacker/pack`             | Packs through the configured artifact extension operation                         |
| `POST /v1/openpacker/publish`          | Publishes through the configured extension; rejected while the request is offline |

Extension request schemas are provider capabilities, not implied PREX fields.
Callers must consult `extensionSchemaRefs` and preserve declared namespaced
extensions only.

## HTTP behavior

JSON bodies are parsed with duplicate-member rejection before canonicalization.
The daemon bounds request bodies and timeout, propagates cancellation, returns
`x-correlation-id`, and sets `X-Content-Type-Options: nosniff`. The SDK retries
only GET requests or requests carrying an idempotency key, and only for network
failure or HTTP 429/502/503/504. Authentication callbacks receive a fresh header
set per request; persisted protocol objects contain secret references, never
credentials.
