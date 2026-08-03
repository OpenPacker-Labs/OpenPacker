# OpenPacker documentation map

OpenPacker is the **reference implementation** of **PREX** (Package Resolution
Exchange). Start here when you need a path through the docs rather than a single
API detail.

## Start here

| Document                                                        | Audience                              | Purpose                                  |
| --------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| **[opm package manager](guides/opm.md)**                        | **Anyone managing project packages**  | **`opm` / `opmx` add/install/sync/exec** |
| [Example opm project](../examples/opm-project/)                 | Shell users                           | Offline `opm sync` + `opmx` demo         |
| [PREX control-plane CLI](guides/cli.md)                         | Advanced / protocol users             | `openpacker` normalize/solve/import-lock |
| [CLI sample inputs](../examples/cli/)                           | Shell users                           | Ready JSON for normalize / identify / …  |
| [Getting started](guides/getting-started.md)                    | New operators                         | Install + demos                          |
| [Use cases](product/use-cases.md)                               | Product / architecture                | Workflows UC-1…UC-8                      |
| [User surface](product/user-surface.md)                         | API integrators                       | Command/HTTP catalogue                   |
| [Compliance (API/CLI)](product/compliance.md)                   | Implementers of other clients/servers | PREX compliance checklist                |
| [Reference implementation](product/reference-implementation.md) | Repo engineers                        | Layout + demo matrix                     |
| [Leverage guide](product/leverage-guide.md)                     | Platform owners                       | Reuse vs build                           |
| [Architecture](architecture.md)                                 | System designers                      | Layers, determinism, trust               |

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

| Document                                         | Subject                                    |
| ------------------------------------------------ | ------------------------------------------ |
| **[opm package manager](guides/opm.md)**         | **`opm` / `opmx` project package manager** |
| [PREX control-plane CLI](guides/cli.md)          | `openpacker` protocol recipes              |
| [Runtime clients](operations/runtime-clients.md) | Daemon, SDK, embedded API details          |
| [Examples](../examples/README.md)                | CLI inputs + library samples               |
| [mise integration](integrations/mise.md)         | Tool install via PREX materialize          |
| [Epoch consumption](integrations/epoch.md)       | Downstream consumer boundary               |
| [OCI / ORAS / OCM](integrations/oci-oras-ocm.md) | Artifact transport and composition         |

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

## Agent SDLC

| Path                                                  | Role                                 |
| ----------------------------------------------------- | ------------------------------------ |
| [AGENTS.md](../AGENTS.md)                             | Skill install map + OpenPacker gates |
| `.agents/skills/sdlc` / `.claude/skills/sdlc`         | Full-loop coordinator skill          |
| `.agents/skills/gh-stack` / `.claude/skills/gh-stack` | Stacked PR CLI skill                 |
| [docs/plans/](plans/README.md)                        | Durable sdlc state + dispatch log    |

Invoke with `/sdlc` or `/sdlc --finish`. Mirrors must stay identical:
`npm run skills:mirror-check`.

## Documentation quality gate

`npm run test:docs` runs
[`docs/operations/documentation-smoke.mjs`](operations/documentation-smoke.mjs).
It requires the inventory above, checks local links, forbids unfinished-work
markers, and exercises a few documented commands against fixtures.
