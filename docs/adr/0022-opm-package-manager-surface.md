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
  `@openpacker/cli`.
- v1 ecosystems prioritize npm/cargo/pypi install paths with fail-closed offline
  catalogs; other ecosystems follow the same lock/store model.

## Amendment 2026-10-11: unexpected failures show their cause

An error with no string `code` is one opm did not expect and name. `opm` and
`opmx` print it with its `cause` chain (three links at most, one redacted line
each) instead of the bare message, because Node's `fetch` reports every network
fault as `fetch failed` and keeps the reason on `cause`. When a cause is a
connection fault, a proxy variable is set and `NODE_USE_ENV_PROXY` is not, one
`hint:` line says that Node's built-in `fetch` ignores proxy variables unless
`NODE_USE_ENV_PROXY=1`. Exit codes, and the one-line output of every failure
that carries a code, are unchanged. The redaction is `redactUrl` from
`@openpacker/adapter-core` plus a withholding rule for credential-shaped values;
the hint names a variable and never prints its value.
