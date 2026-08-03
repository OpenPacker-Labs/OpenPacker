# Package Resolution Exchange (PREX) 1.0-draft

## Status and language

This document is the normative PREX 1.0-draft protocol specification. The key
words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** are interpreted as described by RFC 2119 and RFC 8174 when they
appear in capitals.

PREX is vendor-neutral. OpenPacker is one reference implementation. PREX objects
MUST NOT require OpenPacker deployment details, Epoch identities, registry
locations, database identifiers, or transport credentials.

## Invariants

1. A name locates a history; a digest identifies bytes. Mutable aliases, tags,
   channels, URLs, and external references MUST NOT be used as immutable
   identity.
2. Package identity is an ecosystem-qualified PURL. Constraints are VERS plus
   preserved native syntax. A translation that changes membership MUST be
   rejected or represented as semantic loss that blocks the selected profile.
3. Catalog acquisition, solving, and materialization are separate. A solve
   consumes a complete immutable `ResolutionUniverse` and MUST perform no
   network, filesystem, clock, random, credential, or process operation.
4. Native archives remain canonical bytes. OCI and OCM describe or transport
   them; neither changes their package identity.
5. Every successful formal solve MUST include a proof checked independently from
   solver search. An invalid proof is `INTERNAL_ERROR`, never partial success.
6. Canonical protocol objects MUST contain no floating-point values. Digests use
   SHA-256 and lowercase hexadecimal. Canonical bytes follow
   [canonicalization.md](canonicalization.md).
7. Unknown top-level fields MUST fail validation. Extensions are permitted only
   in declared `extensions` containers and MUST use namespaced keys.
8. Evaluation time, target, policy, lifecycle root, source snapshots, semantics
   profile, objective ordering, solution, proof, explanation, artifact set, and
   resolver build evidence MUST be bound into receipts as specified by the
   receipt schema.
9. A build recipe is a captured claim about how bytes were produced. PREX
   operations MUST NOT execute builders, lifecycle scripts, recipes, or
   ecosystem expression languages. Reading artifact bytes to discover runtime
   references is read-only analysis and is not execution. Output identity
   (`recipe-output-v1`) and byte identity (artifact and tree digests) are
   distinct and MUST NOT be conflated: a `producedBy` claim is verified as
   evidence and never establishes identity by itself.

## Versioning and negotiation

The protocol version is `1.0-draft`. Every response MUST include
`meta.protocolVersion` and provider implementation identity. Discovery at
`/.well-known/prex` and `/v1/capabilities` advertises supported versions. A
client MUST reject an unsupported major version. Additive fields are compatible
only inside schema locations that explicitly permit them. This draft claims no
IANA registration.

## Operations

The normative HTTP binding is defined by [openapi.yaml](openapi.yaml).
Equivalent bindings MUST preserve normalized request and response objects.

| Operation   | Purpose                                                                                   | Conformance |
| ----------- | ----------------------------------------------------------------------------------------- | ----------- |
| normalize   | Canonicalize PURL, VERS, native coordinates, digests, and targets in bounded batches      | PREX-N      |
| identify    | Resolve identity or return all ambiguous candidates without silent selection              | PREX-I      |
| enumerate   | List matching exact versions in ecosystem-native deterministic order                      | PREX-E      |
| inspect     | Return an exact loss-aware package instance                                               | PREX-D      |
| solve       | Solve an immutable universe and return solution, proof, explanation, and unsigned receipt | PREX-S      |
| materialize | Return immutable artifact descriptors and restrictions; no hidden solve side effect       | PREX-M      |
| verify      | Return independent evidence facts and a separate aggregate policy decision                | PREX-V      |
| explain     | Return the normative explanation graph and optional derived prose                         | PREX-X      |
| receipts    | Store/retrieve canonical signed receipt envelopes                                         | PREX-R      |
| events      | Deliver versioned CloudEvents over SSE or NDJSON                                          | PREX-C      |

Health, readiness, and capability discovery MUST be side-effect free. Request
correlation, W3C trace context, cancellation, timeout, idempotency, and
transient timing are transport concerns and MUST NOT enter canonical request or
receipt digests. HTTP bindings use the headers declared by OpenAPI; serialized
embedded requests may carry `context`, which `request-v1` explicitly excludes.

## Conformance

Conformance levels are independent. A provider MUST advertise only levels it
implements and passes. The OpenPacker reference daemon advertises all ten
levels. A conforming implementation MUST pass every positive and negative vector
for each advertised level, reject duplicate JSON object member names before
canonicalization, verify generated-contract freshness, and preserve declared
extension values round-trip.

## Limits and failures

Every collection and string is bounded by schema. Implementations MAY impose
smaller advertised limits but MUST return RFC 9457 Problem Details using the
stable codes in [errors.md](errors.md). Resource exhaustion, cancellation, and
upstream failures MUST fail closed. Secrets, credentials, internal stack traces,
and host paths MUST NOT appear in client-visible problems.

## Trust separation

OCI digests establish byte identity. OCM describes portable component
composition. TUF protects rollback-sensitive repository metadata. Sigstore binds
signatures to identities and transparency evidence. SLSA describes production.
SBOMs describe content and license evidence. Lifecycle describes current
eligibility. Policy evaluates supplied facts. PREX receipts bind a resolution.
Implementations MUST NOT collapse these roles into one boolean.

## References

Normative dependencies: JSON Schema 2020-12, RFC 8785, RFC 9457, RFC 2119/RFC
8174, Package URL, VERS, OpenAPI 3.1, CloudEvents 1.0, and AsyncAPI 3.0. Formal
correspondences and explicit limitations appear in [semantics.md](semantics.md).
