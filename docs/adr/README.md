# Architecture decision records

Accepted decisions:

1. [Operation separation](0001-separate-protocol-operations.md)
2. [Identity and mutable locations](0002-identity-not-location.md)
3. [Native bytes and OCI transport](0003-native-bytes-oci-transport.md)
4. [PREX resolution and OCM composition](0004-prex-resolution-ocm-composition.md)
5. [Catalog acquisition and pure resolution](0005-snapshot-before-solving.md)
6. [Three semantics profiles](0006-resolution-semantics-profiles.md)
7. [Loss-aware requirement IR](0007-loss-aware-ir.md)
8. [Provenance-bound overlays](0008-provenance-bound-overlays.md)
9. [Resolvo as an internal engine](0009-resolvo-internal-engine.md)
10. [Independent solve proofs](0010-independent-proof-checking.md)
11. [Receipt binding](0011-receipt-binding.md)
12. [Solution and receipt digests](0012-solution-vs-receipt-digest.md)
13. [Separate trust layers](0013-separate-trust-layers.md)
14. [CloudEvents transport neutrality](0014-cloudevents.md)
15. [Optional chunk-index referrers](0015-chunk-index-referrers.md)
16. [Service and embedded modes](0016-service-and-embedded.md)
17. [Dual Node module compatibility](0017-dual-module-node-compatibility.md)
18. [No Epoch or ATProto production dependency](0018-no-epoch-coupling.md)
19. [Cross-runtime property and fuzz authority](0019-cross-runtime-property-fuzzing.md)

ADRs document stable boundaries. Normative protocol behavior remains in
`spec/prex/v1`; an ADR cannot override a schema or conformance vector.
