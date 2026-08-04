# PREX Registry Definition

Normative description of a **capability-discoverable package source**.

A _Registry Definition_ is the portable service index for one backend: an npm
registry, a NuGet v3 feed, an OCI distribution endpoint, an apt source, a winget
REST source, a Chocolatey feed, a git remote, a nix flake or binary cache, or a
local CLI-backed catalog. Clients enable only the operations the index
advertises. An empty or absent resource type means **unsupported**, not unknown
— the same rule as control-plane
[`Capabilities`](schemas/operations.schema.json) lists.

This document is **not** a reimplementation of any native protocol. Adapters
**translate** native discovery (NuGet service index, fixed npm URL layout, OCI
`/v2/…`, apt `Release`/`Packages`, etc.) into this shape. Hosts never parse
ecosystem-specific layouts directly.

Related:

- Schema:
  [`schemas/registry-definition.schema.json`](schemas/registry-definition.schema.json)
- Resource types: [`registry-resource-types.md`](registry-resource-types.md)
- Control-plane capabilities:
  [`capabilities-errors-media.md`](../../../docs/protocol/capabilities-errors-media.md)
- Adapter ABI: [`prex-adapter.wit`](../../wit/prex-adapter.wit) (WIT world)

## Control plane vs registry

| Surface                               | Answers                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `GET /v1/capabilities` (PREX service) | What **this control plane** can do (normalize, solve, …)           |
| Registry Definition                   | What **this package source** can do (search, versions, install, …) |

Hosts merge both for negotiation. A control plane may expose install while a
given registry resource set does not (or the reverse).

## Document requirements

A document that claims `registryDefinitionVersion: "1"` MUST validate against
`RegistryDefinition` in the schema and MUST satisfy:

1. **`registryId`** is stable for the logical source (URN, HTTPS origin id, or
   `prex-registry:` identifier). Relocating a mirror MAY keep the same id when
   content authority is unchanged; changing authority MUST change the id.
2. **`purlTypes`** lists every PURL type the source may return. Clients MUST NOT
   assume types outside this list.
3. **`resources`** has at least one entry. Each entry has `@id` (locator) and
   `@type` (versioned resource type name, or array of type names for one
   locator).
4. **Feature detection** is by exact `@type` string (e.g.
   `prex.registry.enumerate-versions/1`). Clients MUST ignore unknown types.
5. **Missing type ⇒ unsupported.** Clients MUST NOT invent endpoints for
   operations the index does not advertise.
6. **`@id` schemes:**
   - `https:` / `http:` — network resources (prefer `https:`)
   - `file:` — local metadata roots
   - `exec:` — CLI tools (`exec:apt-cache`, `exec:winget`)
   - `nix+flake:`, `git+`, `oci+` — native locator schemes documented by the
     adapter
7. **Semantic honesty:** when install mutates a host or cannot be generation-
   rolled back by the project store, `features.installSideEffects` and
   `features.reversibility` MUST be set accordingly (or default to `unknown`
   only when the adapter cannot determine them — never silently as `none`).

Canonical JSON rules for digests of a Registry Definition, when pinned, follow
[`canonicalization.md`](canonicalization.md).

## NuGet-shaped discovery (template)

NuGet v3 service indexes use `version` plus `resources[]` with `@id` and
versioned `@type` strings (`RegistrationsBaseUrl/3.6.0`,
`PackageBaseAddress/3.0.0`, …). PREX adopts that **pattern**:

| NuGet idea                                  | PREX Registry Definition            |
| ------------------------------------------- | ----------------------------------- |
| Service index document                      | `RegistryDefinition`                |
| `resources[].@type`                         | `prex.registry.*/N`                 |
| `resources[].@id`                           | resource locator                    |
| Client picks highest supported type version | client feature-detects type strings |
| Absent resource                             | operation unsupported               |

### Mapping NuGet resource types → PREX types

| NuGet `@type` (prefix)  | PREX `@type`                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `RegistrationsBaseUrl`  | `prex.registry.package-metadata/1` and/or `prex.registry.enumerate-versions/1` |
| `PackageBaseAddress`    | `prex.registry.artifact/1`                                                     |
| `SearchQueryService`    | `prex.registry.search/1`                                                       |
| `PackagePublish` / push | out of scope for consumer index (optional extension)                           |
| `SymbolPackage*`        | extension / not required                                                       |

Adapters MAY retain the native NuGet type in `clientVersion` or `extensions` for
diagnostics; hosts MUST NOT require it.

## Synthetic indexes

Registries without a native service index (classic npm URL layout, many git
remotes) still expose a Registry Definition: the **adapter synthesizes** the
index from known layout rules. The host still consumes only the PREX document.

## Relationship to WIT

The adapter world export `registry.service-index` returns the canonical JSON
bytes of a `RegistryDefinition`. Catalog/install/environment WIT interfaces
implement only what the index (and component exports) advertise. Component
exports and registry resources MUST NOT disagree (e.g. exporting `install` while
omitting `prex.registry.install/1` is invalid).

## Conformance

Fixtures under `fixtures/protocol/registry-definition/` are executable evidence.
Validators MUST accept every fixture that claims version `"1"` and MUST reject
documents that omit required fields or use unknown `registryDefinitionVersion`
values without a negotiated upgrade.
