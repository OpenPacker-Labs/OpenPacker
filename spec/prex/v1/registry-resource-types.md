# PREX registry resource types

Versioned `@type` values for
[`RegistryDefinition.resources`](registry-definition.md). Naming follows NuGet’s
`Name/Version` pattern: major versions are incompatible.

Clients MUST treat an absent type as **unsupported**.

## Core types (v1)

| `@type`                              | PREX / WIT operation                      | Purpose                                                   |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| `prex.registry.service-index/1`      | `registry.service-index`                  | Refresh or locate the index itself                        |
| `prex.registry.search/1`             | catalog identify / search                 | Free-text or structured package search                    |
| `prex.registry.enumerate-versions/1` | `catalog.enumerate`                       | List versions for a base PURL                             |
| `prex.registry.package-metadata/1`   | `catalog.inspect`                         | Package metadata for an exact PURL                        |
| `prex.registry.package-config/1`     | package options                           | Configurable package parameters / extras / outputs        |
| `prex.registry.artifact/1`           | `catalog.fetch-artifact` / materialize    | Immutable bytes location                                  |
| `prex.registry.dependency-graph/1`   | graph edges / native deps                 | Declared dependency edges for solve or capture            |
| `prex.registry.install/1`            | `install.install`                         | Make a package present (store, profile, or system)        |
| `prex.registry.update/1`             | `install.update`                          | Move to a newer version under policy                      |
| `prex.registry.uninstall/1`          | `install.uninstall`                       | Remove a package (adapter-defined reverse)                |
| `prex.registry.environment/1`        | `environment.exec-env`                    | PATH / env vars for execution (mise, nix shell)           |
| `prex.registry.lifecycle/1`          | honesty only                              | Declares whether lifecycle scripts exist or are forbidden |
| `prex.registry.project-manifest/1`   | `project.read` / `project.write-manifest` | Read and write the ecosystem's project manifest           |
| `prex.registry.project-lock/1`       | `project.write-lock`                      | Write the ecosystem's native lockfile                     |
| `prex.registry.project-layout/1`     | `project.write-layout`                    | Materialise the ecosystem's native install layout         |
| `prex.registry.package-build/1`      | `project.pack`                            | Build a vendor artifact from a project                    |

## Ecosystem mapping (informative)

| Ecosystem         | Typical resources advertised                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| NuGet             | package-metadata, enumerate-versions, artifact, search (when SearchQueryService present)               |
| npm               | package-metadata, enumerate-versions, artifact, search                                                 |
| Cargo             | package-metadata, enumerate-versions, artifact, dependency-graph                                       |
| OCI               | enumerate-versions (tags), package-metadata (manifest), artifact (blobs)                               |
| apt               | package-metadata, dependency-graph, install, uninstall                                                 |
| winget            | search, package-metadata, install, uninstall                                                           |
| Chocolatey        | search, package-metadata, install, uninstall                                                           |
| git               | enumerate-versions (tags/refs), artifact (archive), optional install                                   |
| nix               | search, enumerate-versions (attrs), package-metadata (path-info), artifact (NAR), install, environment |
| mise (as backend) | enumerate-versions, install, environment                                                               |

## Project formats

`project-manifest/1` is the entry level: an adapter that advertises
`project-lock/1` or `project-layout/1` without it is claiming to maintain a
lockfile for a manifest it cannot write. Hosts MUST refuse that combination.

Each level is a projection of a decision PREX already made, never a new
decision. A projection that cannot be faithful — a build DSL that is not a data
file, a native lockfile whose integrity value was never captured — MUST record
`SemanticLoss` rather than write a file that differs from what the native tool
would have produced.

## Extending the vocabulary

New types MUST use `prex.registry.<name>/<major>` and be documented before hosts
depend on them. Unknown types MUST be ignored by v1 clients.

“Ignored” is literal: a host that does not recognise a reserved type MUST load
the adapter and drop the type, because refusing it would make every new
vocabulary entry a breaking change for hosts that predate it. Ignoring is also
what keeps this safe — an unrecognised type is never honoured, so an adapter
cannot acquire a capability by inventing a name.

A host MAY refuse a **malformed** reserved type. `prex.` claims this namespace,
so a member of it has to be shaped like one: lowercase `name`, a major version
of 1 or more. `prex.registry.attestation` (unversioned) and `prex.attestation/1`
(wrong namespace) are malformed; `prex.registry.attestation/1` is simply newer
than the host.
