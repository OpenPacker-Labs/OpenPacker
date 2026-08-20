# 39. Third-party ecosystems arrive as delegated adapter plugins

Date: 2026-08-19

## Status

Accepted

## Context

Every ecosystem adapter ships statically linked into the reference CLI
(`configureDefaultAdapters`). Third-party ecosystems have no honest path in:
`discoverAdapterModules` refuses dynamic JS imports by design, and the WIT
component host that ADR 0032 points to does not exist in the TypeScript CLI yet.
Meanwhile ADR 0037/0038 built a proven pattern for running third-party code
safely — delegated pack providers — where the provider plans and the host
authorizes, snapshots, sandboxes, and validates.

Users need to extend opm with ecosystems we do not ship (a company-internal
manager, a niche ecosystem, an experimental one) without forking the CLI and
without weakening the trust model.

## Decision

Third-party ecosystem support is a **delegated adapter plugin**:

- A plugin is a standalone executable plus a `DelegatedAdapterManifest`
  ([spec](../../spec/prex/v1/delegated-adapter.md)). Version 1 delegates only
  the read-only registry-definition and catalog surfaces over a bounded
  canonical-JSON stdin/stdout protocol; codec, installer, project-format and
  pack capabilities are not delegatable and fail closed.
- Plugins are distributed as PREX packages under the reserved purl type
  `opm-plugin`, acquired digest-pinned and policy-gated, and materialized into a
  user-level content-addressed plugin store (`OPM_PLUGIN_HOME`, falling back to
  the XDG data directory). Nothing installs a plugin by default.
- Users run `opm plugin add|list|remove`; `opmx --plugin <name>` uses a plugin
  for an ephemeral run; projects pin installed plugins with
  `[plugins.<id>] store_digest = "sha256:…"`. Plugins never join the project
  package graph or lock — they extend opm itself, and the lock's honesty
  invariants are preserved.
- Execution reuses the ADR 0038 immutable-snapshot rule and the ADR 0036
  fail-closed sandbox unchanged. Where containment is withdrawn (macOS,
  Windows), plugin operations refuse rather than degrade.

## Consequences

- The CLI ships its first-party adapters as today; third-party ecosystems are
  never bundled. `opm install` keeps its existing meaning (materialize the
  project lock); plugin management is an explicit `opm plugin` family.
- Every plugin response is validated against the normative PREX schemas before
  use, so a malicious or buggy plugin can fail operations but cannot inject
  unvalidated metadata into resolution, locks, or receipts.
- The plugin store is user-level and content-addressed; two projects binding the
  same digest share bytes but no mutable state.
- When the WIT component host lands, the manifest's command vocabulary maps onto
  the `adapter` world operations; the UX and store do not change.
