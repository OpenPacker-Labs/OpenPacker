# ADR 0062: `@openpacker/cli` ships `opm`, `opmx`, and PREX control-plane verbs

- Status: Accepted
- Date: 2026-11-01

## Context

The reference implementation had two Node CLI workspaces: `@openpacker/cli`
(`openpacker` bin, PREX control plane) and `@openpacker/opm` (`opm` / `opmx`
bins, project package manager). They shared adapters, materialization, and
release automation but duplicated packaging, CI filters, and dev shims.

Product naming treats **`opm` as the executable** users install; the npm package
remains **`@openpacker/cli`**.

## Decision

1. **One workspace:** `apps/openpacker-cli` is the sole CLI app. All former
   `apps/opm` sources, tests, and bins live there. The `@openpacker/opm`
   workspace is removed.

2. **Primary bins on `@openpacker/cli`:** `opm`, `opmx`, and optional aliases
   `opkg` / `opkgm`. The `openpacker` bin name is retired; PREX verbs are
   invoked as `opm normalize`, `opm materialize`, and so on.

3. **Routing:** The `opm` process entry (`main.js`) still fast-paths `run` /
   `exec` before loading adapters. PREX-only verbs listed in `prex-commands.ts`
   delegate to the bundled PREX client (`index.ts` / `runCli`). Verbs that
   overlap the project manager (`resolve`, `pack`, `publish`) stay on the opm
   surface when invoked as `opm …`.

4. **Library export:** Programmatic access to the project manager remains
   `@openpacker/cli/opm` (formerly `@openpacker/opm`).

5. **Integrations:** Mise and release smoke tests invoke the `opm` executable
   (default `OPENPACKER_BIN=opm`).

## Consequences

- Release tarballs from `@openpacker/cli` ship `opm` + `opmx` with workspace
  dependencies pinned in the release `package.json`; PREX client code stays
  esbuild-bundled in `dist/index.js`.
- Docs and ADRs that referenced `apps/opm` or `@openpacker/opm` point at
  `apps/openpacker-cli` and `@openpacker/cli`.
- ADR 0022’s “two CLI surfaces” is unified at packaging time; the behavioral
  split (project manager vs PREX verbs) remains in routing.
