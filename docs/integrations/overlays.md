# OpenPacker overlays

Native metadata cannot express every cross-ecosystem dependency or virtual
capability. `openpacker.overlay.json` supplements it without rewriting or
mislabeling native facts. Its provisional type is
`application/vnd.openpacker.overlay.v1+json`.

An overlay contains a subject package, optional metadata digest binding,
requirements, capabilities, conflicts, cardinality constraints, artifact
annotations, sources, authority, evidence, and generic external references.
Every fact retains overlay provenance in the compiled universe and explanation
graph.

Authority is one of `publisher`, `registry`, `organization`, `user`, or
`test-fixture`. Policy explicitly accepts authorities; conflicts produce
diagnostics. An overlay must not override a native fact by precedence, claim a
mutable external reference proves authority, or apply when its
`appliesToMetadataDigest` does not match.

Canonical overlay bytes and accepted authority policy affect the universe and
receipt. The same bytes may be attached as an OCI referrer. The tested
cross-ecosystem example is
[`fixtures/protocol/overlay/cross-ecosystem.json`](../../fixtures/protocol/overlay/cross-ecosystem.json).
