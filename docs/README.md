# OpenPacker documentation map

OpenPacker is the **reference implementation** of **PREX** (Package Resolution
Exchange). Start here when you need a path through the docs rather than a single
API detail.

## Start here

| Document                                                        | Audience                                    | Purpose                                        |
| --------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| [Getting started](guides/getting-started.md)                    | New operators and integrators               | Install, demos, first CLI/SDK calls            |
| [Use cases](product/use-cases.md)                               | Product and architecture                    | Concrete workflows OpenPacker is built for     |
| [User surface](product/user-surface.md)                         | CLI/API users                               | Recommended commands and HTTP paths            |
| [Compliance (API/CLI)](product/compliance.md)                   | Implementers of alternative clients/servers | What it means to comply with PREX/OpenPacker   |
| [Reference implementation](product/reference-implementation.md) | Engineers reading this repo                 | What ships, where it lives, how demos prove it |
| [Leverage guide](product/leverage-guide.md)                     | Platform owners                             | Reuse vs build; Nexus/mise/Epoch boundaries    |
| [Architecture](architecture.md)                                 | System designers                            | Layers, determinism, trust composition         |

## Normative PREX

| Document                                                               | Authority                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`spec/prex/v1/`](../spec/prex/v1/)                                    | Normative protocol: schemas, OpenAPI, semantics, errors, media types |
| [Operations](protocol/operations.md)                                   | PREX and OpenPacker operation catalogue                              |
| [Conformance](protocol/conformance.md)                                 | Capability levels PREX-N … PREX-C                                    |
| [Identity and canonicalization](protocol/identity-canonicalization.md) | PURL/VERS and digest rules                                           |
| [IR and semantics](protocol/ir-semantics.md)                           | Profiles and loss-aware IR                                           |
| [Resolution and proof](protocol/resolution-proof.md)                   | Solver outputs and independent checking                              |
| [Receipts and lockfiles](protocol/receipts-lockfiles.md)               | Pin formats                                                          |
| [Events](protocol/events.md)                                           | CloudEvents outbox and replay                                        |

## Using the reference implementation

| Document                                         | Subject                                       |
| ------------------------------------------------ | --------------------------------------------- |
| [Runtime clients](operations/runtime-clients.md) | Daemon, SDK, embedded API, CLI                |
| [Examples](../examples/README.md)                | Compile-checked and offline-runnable examples |
| [mise integration](integrations/mise.md)         | Tool install via PREX materialize             |
| [Epoch consumption](integrations/epoch.md)       | Downstream consumer boundary                  |
| [OCI / ORAS / OCM](integrations/oci-oras-ocm.md) | Artifact transport and composition            |

## Extending OpenPacker

| Document                                                       | Subject                                |
| -------------------------------------------------------------- | -------------------------------------- |
| [Ecosystem codecs](integrations/ecosystem-codec-authoring.md)  | Pure native translation                |
| [Providers](integrations/provider-authoring.md)                | Catalog and enrichment providers       |
| [Artifact ports](integrations/artifact-extension-authoring.md) | Sources and sinks                      |
| [Overlays](integrations/overlays.md)                           | Provenance-bound cross-ecosystem facts |

## Operations and security

| Document                                                           | Subject                       |
| ------------------------------------------------------------------ | ----------------------------- |
| [Storage and deployment](operations/storage-deployment.md)         | CAS, SQLite, binding          |
| [Trust and policy](operations/trust-lifecycle-policy.md)           | Evidence vs decisions         |
| [Threat model](security/threat-model.md)                           | Security assumptions          |
| [Contributing and releasing](operations/contributing-releasing.md) | Change control and gates      |
| [ADRs](adr/README.md)                                              | Stable architecture decisions |

## Documentation quality gate

`npm run test:docs` runs
[`docs/operations/documentation-smoke.mjs`](operations/documentation-smoke.mjs).
It requires the inventory above, checks local links, forbids unfinished-work
markers, and exercises a few documented commands against fixtures.
