# ADR 0022: Dual surface — `opm` package manager + PREX control plane

- Status: Accepted
- Date: 2026-08-03

## Context

ADR 0020 established that OpenPacker is a **package control plane** for PREX:
normalize identity, solve or capture graphs, prove digests, and materialize
immutable bytes — without claiming full command compatibility with npm, pip, or
Cargo.

Users still need a **project package manager UX**: named binaries (`opm` /
`opmx`), local manifests, add/remove/sync, and install/uninstall into a project
store. Shipping only `openpacker normalize|solve|materialize` left that product
surface missing.

## Decision

OpenPacker exposes **two complementary CLI surfaces**:

1. **`opm` / `opmx` (Open Package Manager)** — project package management:
   - Manifest: `opm.toml`
   - Lock: `opm.lock.json`
   - Install root: project-local `.opm/`
   - Commands: `init`, `add`, `remove`, `install`, `uninstall`, `sync`,
     `update`, `list`, `why`
   - Execute: `opmx` runs installed package binaries
   - Optional aliases: `opkg`, `opkgm` → `opm`

2. **`openpacker` (PREX control plane)** — protocol operations and advanced
   workflows: `normalize`, `identify`, `enumerate`, `inspect`, `solve`,
   `import-lock`, `materialize`, `verify`, receipts, catalog, lifecycle.

`opm` **reuses** PREX-grade resolve/pin/materialize machinery (digests,
materializer, adapters, offline catalogs). It does **not** replace native
ecosystem install layouts by default (no silent `node_modules` rewrite; no
lifecycle script execution by default).

ADR 0020 remains valid for the control-plane role. This ADR **adds** an explicit
package-manager façade; it does not claim full npm/Cargo/pip supersession.

## Consequences

- README and user guides lead with `opm` / `opmx` for day-to-day use.
- Protocol docs and `openpacker` remain for integrators and advanced ops.
- Project model lives in `@openpacker/opm-project`; CLI bins in
  `@openpacker/opm`.
- v1 ecosystems prioritize npm/cargo/pypi install paths with fail-closed offline
  catalogs; other ecosystems follow the same lock/store model.
