# opm plugins SDLC state

## Status

- Phase: closed — all four layers reviewed, repaired, and squash-merged
  bottom-up (#103 `b5d0497`, #104 `bca9ef6`, #105 `f4a1000`, #106 `8d329bd`);
  merged `main` tree is byte-identical to the verified stack head.
- Branch chain: `sdlc/opm-plugins-01-contracts` → `sdlc/opm-plugins-02-store` →
  `sdlc/opm-plugins-03-host` → `sdlc/opm-plugins-04-opmx-docs`.

## Problem

Third-party package managers had no honest path into opm: adapters shipped
statically linked, and dynamic code loading is refused by design
(`ADAPTER_LOAD_DISABLED`). Users needed ecosystem extensions installable
explicitly as plugins, never by default.

## Decisions (ADR 0039)

- Plugins are delegated adapter manifests + standalone executables, distributed
  as `pkg:opm-plugin/*` packages, acquired digest-pinned and policy-gated into a
  user-level content-addressed store; nothing installs them by default.
- UX: `opm plugin add|list|remove <name>`,
  `opmx --plugin <name> [--allow-env N]`, and project pins
  `[plugins.<id>] store_digest` (bindings never acquire).
- Execution reuses the ADR 0038 immutable-snapshot + ADR 0036 fail-closed
  sandbox; every plugin response is schema-validated against normative PREX
  $defs before use; undeclared capabilities fail closed.
- v1 delegates read-only registry-definition and catalog surfaces only. The
  stdio protocol stays metadata-only; artifact bytes are fetched host-side and
  sha256-verified (ADR 0040, plugin-execution #109–#114). That stack closed the
  earlier “resolve then refuse at digest verification” gap.

## Verification

- Full offline `npm run verify` green at the repaired stack head: 50 workspaces,
  1090/1104 runnable tests, 18 enforced test types, 100% file instrumentation,
  82.96% function coverage, 31,497 fuzz cases.
- Independent review of all four PRs: first pass rejected #103/#104/#105
  (missing result schemas, invalid example id, lexicographic version selection,
  CLI error mapping, purl-type/exactPurl validation gaps,
  registration→invocation TOCTOU); all repaired and approved on re-review,
  including re-review nits (multiple-latest refusal test, snapshot-close error
  taxonomy, remove/uninstall binding coverage).

## Follow-ups

- ~~Spec v2 for plugin-served artifact execution (byte-carrying operation or
  host-side download from record locations).~~ Closed by plugin-execution
  (#109–#114, ADR 0040): host-side download from record locations; plugin stays
  metadata authority.
- WIT component substrate per ADR 0032 when a TS component host exists.
