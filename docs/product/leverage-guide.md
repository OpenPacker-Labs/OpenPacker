# Leverage guide

OpenPacker is a **package control plane**: PREX normalizes identity,
constraints, solve, proof, receipts, and artifacts. Native package managers
remain authoritative for install, build, and runtime scripts. Prefer reuse at
published seams over reimplementing ecosystem or operator tooling.

## Reuse versus build

| Concern                                         | Prefer                                                           | Avoid building in OpenPacker                                     |
| ----------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Install, lifecycle scripts, runtime env         | Native PMs (npm, Cargo, NuGet, pip/uv, Go, Gradle)               | A second installer or script runner that shadows native managers |
| Tool version switching and shims                | mise (and similar tool managers)                                 | OpenPacker-owned global tool PATH management                     |
| Proxying, caching, or operator package surfaces | Nexus-class proxies and existing registries                      | A general-purpose registry product inside PREX                   |
| Identity, constraints, solve, proof, receipts   | PREX / OpenPacker                                                | Ad-hoc lock digests without profiles, proofs, or semantic loss   |
| Signed history, federation, community topology  | Downstream systems (for example Epoch) via public contracts only | Production dependency on Epoch, `@epoch/*`, or ATProto           |
| Byte transport and composition                  | OCI/ORAS and OCM as already integrated                           | Rewriting native archive bytes into a proprietary blob format    |
| Ecosystem coordinate, range, and lock parsing   | `EcosystemCodec` extensions                                      | One-off parsers scattered through CLI or daemon routes           |
| Catalog fetch and offline snapshots             | `CatalogProvider` extensions                                     | Solving against live network state inside the pure resolver      |

## Map to adjacent systems

| System               | Role relative to OpenPacker                                                                                                    | Boundary                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **PREX**             | Protocol and data model for normalize, identify, enumerate, inspect, solve, materialize, verify, explain, receipts, and events | Normative contracts live in `spec/prex/v1`                                                                                         |
| **OpenPacker**       | Reference control plane: service, SDK, CLI, resolver, adapters, lock import, exports, conformance                              | Implements PREX; adds OpenPacker extension ops such as catalog and import-lock                                                     |
| **Native PMs**       | Authoritative install/build/runtime and native lock production                                                                 | OpenPacker captures or solves; it does not supersede their CLIs                                                                    |
| **mise**             | Proxies tool list/install/exec env; delegates enumerate and materialize to PREX                                                | See [mise backend](../integrations/mise.md)                                                                                        |
| **Nexus-class**      | Integrates operator package proxy/cache surfaces with registries                                                               | OpenPacker consumes catalog/artifact ports; it is not a Nexus replacement                                                          |
| **Epoch**            | Optional downstream consumer of receipts, events, and artifact descriptors                                                     | No production package coupling; see [Epoch consumption](../integrations/epoch.md) and [ADR 0018](../adr/0018-no-epoch-coupling.md) |
| **OCI / ORAS / OCM** | Transport and composition of unchanged native bytes                                                                            | See [OCI, ORAS, and OCM](../integrations/oci-oras-ocm.md)                                                                          |

## Companion projects

Treat the following as companions, not forks of OpenPacker:

- **mise** (and comparable tool managers): wire list/install to PREX enumerate
  and materialize; keep scripts and PATH ownership outside PREX.
- **Native package managers**: remain the source of install semantics and the
  producers of primary freeze formats for
  [native lock import](../adr/0021-native-lock-import.md).
- **Registry and proxy products**: supply metadata and bytes through
  `CatalogProvider` and artifact source ports.
- **Epoch or other history systems**: store and reference canonical OpenPacker
  bytes without rewriting digests or identity.

## Extension seams to reuse

| Seam              | Package / guide                                                                 | Use for                                                            |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `EcosystemCodec`  | [`@openpacker/adapter-core`](../integrations/ecosystem-codec-authoring.md)      | Pure coordinate, version, range, metadata, and lock translation    |
| `CatalogProvider` | [Provider authoring](../integrations/provider-authoring.md)                     | Identify, enumerate, inspect, and immutable offline snapshots      |
| Artifact ports    | [Artifact extension authoring](../integrations/artifact-extension-authoring.md) | Streaming immutable sources and sinks                              |
| Lock import       | `@openpacker/lock-import`, [ADR 0021](../adr/0021-native-lock-import.md)        | Offline capture of native freeze formats under `native-capture-v1` |
| Overlays          | [Overlays](../integrations/overlays.md)                                         | Provenance-bound cross-ecosystem facts                             |

New ecosystems should land as codec plus optional provider and lock-format
handler, not as bespoke control-plane branches. Product surface recommendations
are listed in [User surface](user-surface.md).
