# Integration guides

| Guide                                                             | Contract                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Ecosystem codec authoring](ecosystem-codec-authoring.md)         | Pure native coordinate, version, range, metadata, and lock translation               |
| [Provider and extension authoring](provider-authoring.md)         | Janus-owned generic provider, signer, policy, event, clock, and credential contracts |
| [Artifact source/sink authoring](artifact-extension-authoring.md) | Streaming immutable artifact ports and conformance checks                            |
| [OCI, ORAS, and OCM](oci-oras-ocm.md)                             | Unchanged native bytes, OCI referrers, registry transfer, and component mapping      |
| [OpenPacker overlays](overlays.md)                                | Provenance-bound cross-ecosystem facts                                               |
| [mise backend](mise.md)                                           | PREX enumeration and verified isolated tool installation                             |
| [Epoch consumption](epoch.md)                                     | Janus-owned downstream boundary and canonical-byte preservation                      |

An extension advertises its ID/version, supported PREX versions, capabilities,
configuration schema, determinism guarantees, security boundary, and
diagnostics. It must not add undeclared top-level PREX fields.
