# PREX implementer documentation

PREX is the transport-neutral protocol and data model. OpenPacker is its
reference implementation. The normative source remains
[`spec/prex/v1`](../../spec/prex/v1/normative.md); these guides explain how the
checked-in schemas and implementations fit together.

| Guide                                                                 | Subject                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Operations](operations.md)                                           | Discovery, health, every PREX route, OpenPacker extension routes, and transport behavior |
| [Capabilities, errors, and media types](capabilities-errors-media.md) | Negotiation, conformance levels, limits, Problem Details, and provisional media types    |
| [Identity and canonicalization](identity-canonicalization.md)         | PURL, VERS, native coordinates, canonical JSON, and digests                              |
| [IR and semantics](ir-semantics.md)                                   | Requirements, capabilities, targets, semantic loss, profiles, and formal correspondence  |
| [Resolution, objectives, and proofs](resolution-proof.md)             | Deterministic solving, independent checking, explanations, and unsatisfiability          |
| [Receipts and lockfiles](receipts-lockfiles.md)                       | Audit bindings, signatures, replay protection, and portable lock state                   |
| [Conformance](conformance.md)                                         | Capability-scoped claims and executable evidence                                         |
| [Events](events.md)                                                   | CloudEvents data contracts, NDJSON replay, checkpoints, and deduplication                |

Implementer checklists that span API and CLI surfaces (including OpenPacker
extensions such as lock import) live in [Compliance](../product/compliance.md).
Runnable reference demos and samples are listed in
[Reference implementation](../product/reference-implementation.md) and
[Examples](../../examples/README.md).

Externally visible objects are defined once in the JSON Schemas under
[`spec/prex/v1/schemas`](../../spec/prex/v1/schemas). Generated TypeScript
declarations and schema copies are outputs, not alternative specifications.
