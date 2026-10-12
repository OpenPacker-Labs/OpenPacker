# Integration guides

| Guide                                                             | Contract                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Ecosystem codec authoring](ecosystem-codec-authoring.md)         | Pure native coordinate, version, range, metadata, and lock translation               |
| [Provider and extension authoring](provider-authoring.md)         | Janus-owned generic provider, signer, policy, event, clock, and credential contracts |
| [Artifact source/sink authoring](artifact-extension-authoring.md) | Streaming immutable artifact ports and conformance checks                            |
| [OCI, ORAS, and OCM](oci-oras-ocm.md)                             | Unchanged native bytes, OCI referrers, registry transfer, and component mapping      |
| [OpenPacker overlays](overlays.md)                                | Provenance-bound cross-ecosystem facts                                               |
| [mise backend](mise.md)                                           | PREX enumeration and verified isolated tool installation                             |
| [packslip](packslip.md)                                           | Signed vendor releases: Sigstore-verified, signer remembered, trust in `opm.toml`    |
| [Epoch consumption](epoch.md)                                     | Janus-owned downstream boundary and canonical-byte preservation                      |

Product framing for how integrations fit the control plane:

| Guide                                                              | Subject                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Documentation map](../README.md)                                  | Index of guides, protocol, and examples                                   |
| [Getting started](../guides/getting-started.md)                    | Install, demos, first CLI/SDK calls                                       |
| [Use cases](../product/use-cases.md)                               | UC-1…UC-8 with working entry points                                       |
| [Compliance](../product/compliance.md)                             | PREX/OpenPacker API and CLI compliance checklist                          |
| [Reference implementation](../product/reference-implementation.md) | What this repo ships and how demos prove it                               |
| [Leverage guide](../product/leverage-guide.md)                     | Reuse versus build; Nexus/mise/Epoch boundaries; codec and provider seams |
| [User surface](../product/user-surface.md)                         | Recommended CLI/API including import-lock, resolve, export, and catalog   |
| [Examples](../../examples/README.md)                               | Compile-checked samples                                                   |
| [Control plane ADR](../adr/0020-control-plane-not-supersession.md) | Package control plane, not native PM supersession                         |
| [Native lock import ADR](../adr/0021-native-lock-import.md)        | Offline-first native-capture-v1 lock import                               |

An extension advertises its ID/version, supported PREX versions, capabilities,
configuration schema, determinism guarantees, security boundary, and
diagnostics. It must not add undeclared top-level PREX fields.
