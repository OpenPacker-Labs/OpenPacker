# 42. Rescoped UPM v1 gaps

Date: 2026-08-20

## Status

Accepted. Implementation is eight exclusive-ownership swarms documented in
[`docs/plans/upm-v1-gaps/swarm-instruction.md`](../plans/upm-v1-gaps/swarm-instruction.md).

Amended by
[ADR 0043](0043-one-copy-per-machine-and-a-node_modules-node-can-resolve.md):
the shared store of decision 3 is on by default for the `opm` and `opmx` process
entries (still environment-only, no toml key; `OPM_STORE_HOME=off` opts out).

Relates to: [0020](0020-control-plane-not-supersession.md),
[0022](0022-opm-package-manager-surface.md),
[0032](0032-wit-adapters-and-registry-definition.md),
[0034](0034-opm-projects-into-native-project-formats.md),
[0036](0036-sandboxed-installs-and-execution.md),
[0041](0041-host-fetch-operator-pins-and-credentials.md).

## Context

A ranking of “universal package manager v1 gaps” bundled six unequal items: a
WIT component host, Maven/PyPI/Go inspect without sidecars, publish+yank, real
`update` plus workspaces, shared CAS, and `opm login`/OIDC. Treating them as one
product would violate ADR 0020 (supersession), ADR 0032 (TS bridge is a valid v1
host), ADR 0034 (native workspace files are projection), and ADR 0041 (tokens
are named env vars on pinned origins). It would also collide on
`apps/opm/src/opm.ts` and `packages/opm-project`.

## Decision

1. **Maven inspect** uses the stock repository POM and optional checksum
   siblings. An OpenPacker `*.catalog.json` sidecar is an overlay, not a
   requirement. Parent POMs and BOM imports are recorded as semantic loss, not
   fetched. PyPI and Go inspect already speak Warehouse JSON and the module
   proxy; their gap is offline provider e2e depth, not a new protocol.
2. **`opm update` is not `sync`.** Update bumps selected ranged directs to the
   newest eligible in-range version and re-proves that closure. Sync keeps
   today’s full re-resolve. Exact pins do not move unless `--latest` rewrites
   the manifest. **opm has no workspace graph.** Multi-package repos are
   multiple `opm.toml` projects; npm/Cargo/Go/Maven workspace files stay
   native-projection (ADR 0034).
3. **Optional shared blob CAS** is `OPM_STORE_HOME`: verified `sha256-*` trees
   that projects hardlink or copy into `.opm/store`. The project store remains
   the activation tree. No toml schema key. No NFS SQLite CAS.
4. **Publish and yank** are PREX registry operations (`POST /v1/publish`, signed
   status / lifecycle). The reference daemon stays `unavailable` unless
   `OPENPACKER_PUBLISH_STORE` is set. Publishing to npmjs, PyPI, crates.io, or
   Maven Central is out of scope (ADR 0020).
5. **`opm auth`** stores origin → env-var **names** only. Operators mint tokens
   outside opm. No device flow, cookies, netrc, IMDS, or bearer files.
6. **WIT v1 host** is WIT-**shaped** TypeScript `AdapterModule` objects plus
   sandboxed native plugins. The WIT world remains the ABI shape. A wasmtime or
   jco component loader is a separate initiative, not this one.

## Consequences

Eight implementer swarms own disjoint paths. Shared files (`opm.ts`,
`opm-project` `index.ts`) receive only named surgical hunks. Coordinator owns
guides, inventory, and this ADR. Host-fetch residuals
(`OPM_HOST_FETCH_REQUIRE_PIN`, path allowlists, `rejectUnauthorized: false`)
stay out.
