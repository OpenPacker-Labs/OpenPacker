# SDLC state — plugin-execution

Initiative: make delegated adapter plugins actually install and run the tools
they serve. Closes the v1 "metadata-only" gap: today a plugin-served purl
resolves, then fails closed at digest verification because the bounded stdio
protocol carries no artifact bytes, and no host path knows a plugin package's
executables.

Requested by user (2026-08-20): "that isn't a spec v2 decision or future design
— that's right now. Fix it."

## Phase

closed (2026-08-20) — all six layers reviewed (rubber-duck + adversarial +
independent review), nits repaired mid-stack, squash-merged bottom-up, and
`npm run verify` green on merged `main` (`ce8a3d2`).

## Gap analysis (verified in code)

- `resolveRegistryArtifact` (packages/opm-project/src/registry.ts:422) takes
  `record.rawBody` as artifact bytes. For a delegated plugin, `rawBody` is the
  canonical bytes of the JSON descriptor body
  (packages/plugin-host/src/protocol.ts `wireRecordToRecord`), so
  `bindVerifiedArtifactBytes` fails closed at digest verification. Fixture
  documentation of the gap: apps/opm/test/plugin-fixture.ts
  (`ACME_ARTIFACT_BODY` comment).
- `discoverBins` (packages/opm-project/src/bins.ts:256) returns `[]` for plugin
  purl types; a materialized plugin tool then cannot run.
- `resolveRegistryArtifact` is the single acquisition funnel
  (packages/opm-project/src/project.ts:826, :1195;
  packages/opm-project/src/ephemeral.ts:166) — fixing it fixes both
  `opmx --plugin` ephemeral runs and project `opm add`/`opm install`.

## Decisions

- **D1 — bytes travel host-side, never plugin-side.** The plugin's existing
  `fetch-artifact-record` answer already carries `digest` / `size` / `mediaType`
  / `locations`. The host detects a delegated provider via the capability
  extension `openpacker/artifact-bytes: "host-fetch"`, downloads from a
  `locations[].uri` itself (bounded transport, HTTPS + no credentials, origin
  allowlist = origin of the record's `endpoint`, published `size` required as
  the bound), and sha256-verifies against the published digest. The plugin stays
  metadata authority — the same trust position a first-party registry holds; it
  never proxies bytes, so the stdio protocol stays bounded and metadata-only.
- **D2 — executables are provider metadata.** New `DelegatedAdapterBin` $def and
  optional `executables` on `DelegatedAdapterInspectionResult`; adapter-core
  `ProviderInspection` gains optional `executables`; the resolve path surfaces
  them as `BinDeclaration`s and pins them into the lock package
  (`materializeLockPackage` already prefers `pkg.bins` over disk discovery).
  Host-side validation: single-segment safe name, relative POSIX path without
  `..`, interpreter ∈ `node|python|dotnet|native`, `entry` required iff
  `python`.
- **D3 — `native` interpreter end to end.** Third-party package managers are
  usually native binaries; `BinDeclaration.interpreter`, `opmx` spawn, and bin
  shims gain a `native` branch that executes the verified store file directly
  through the existing sandbox funnel. If the package-exec sandbox profile
  denies exec from store paths, that is a genuine gap to fix in the sandbox
  layer (behavior test decides).
- **D4 — spec-first, per repo protocol boundary.** Amend
  `spec/prex/v1/delegated-adapter.md` + schema, mirror to
  `packages/contracts/schemas`, regenerate contracts, new ADR 0040 (amends 0039
  per ADR 0028). `rawBody` stays the canonical bytes of the answered body —
  honesty invariant unchanged.
- **D5 — first-party paths unchanged.** No marker → today's `rawBody` behavior.
  No UX changes to `opm plugin add|list|remove`, bindings, or the store.

## Stack layers (one issue each, bottom-up)

| Layer | Branch                               | Scope                                                                                                                                                                           | PR   |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 01    | sdlc/plugin-execution-01-spec        | spec amendment, schema $defs, mirrors, regenerated contracts, protocol fixture, ADR 0040                                                                                        | #109 |
| 02    | sdlc/plugin-execution-02-host        | adapter-core `ProviderExecutable`/`ProviderInspection.executables`; plugin-host bin validation + capability marker; unit tests                                                  | #110 |
| 03    | sdlc/plugin-execution-03-acquire     | host-fetch acquisition in `resolveRegistryArtifact`; bins plumbing into locks; `native` interpreter through bins/shims/opmx                                                     | #111 |
| 04    | sdlc/plugin-execution-04-e2e         | fixture plugin serves real bytes + runnable tool; behavior/e2e `opmx --plugin`; guides/examples; closeout docs                                                                  | #112 |
| 05    | sdlc/plugin-execution-05-generations | generation members record declared bins; activation prefers recorded over discovery; opmx project path dispatches on the declared interpreter                                   | #113 |
| 06    | sdlc/plugin-execution-06-cache       | ephemeral tool cache hits: metadata-first resolution defers the byte download; a digest the store already holds skips it, with download fallthrough on any cache-shape surprise | #114 |

## Gates

- Per commit: `npm run agent:check:staged` (pre-commit hook, never bypassed).
- Per PR: bottom-up rubber-duck + adversarial review, then squash-merge.
- Pre-merge of stack top: full `npm run verify` green.

## Open risks

- ~~Sandbox package-exec profile vs. native exec from store paths (D3)~~ —
  resolved in layer 03: bwrap ro-binds argv[0]/dirname + declared storePaths;
  proven by an enforced-sandbox e2e.
- ~~`BoundedFetchTransport` redirects~~ — resolved in layer 03:
  `redirect: 'manual'`, origin allowlist + no-credentials re-checked per hop.

## Boyscout defects fixed along the way

- Generation activation discarded provider-declared bins (project `opmx <bin>`
  failed for plugin ecosystems) — layer 05.
- opmx project path spawned every bin through Node (latent crash for
  python/dotnet/native project bins) — layer 05.
- Ephemeral tool cache never hit; `(cached)` was unreachable — layer 06.
- Lockfile parser dropped `interpreter`/`entry` on read — layer 03.

## Verification

- Full offline `npm run verify` on merged `main` (`ce8a3d2`) exited 0: 50
  workspaces, 1135/1149 runnable tests, 18 enforced test types, 100%
  production-file instrumentation, 83.22% function coverage, 31,497 fuzz cases
  across 13 classes.
- Independent review of all six PRs; nits repaired mid-stack before squash-merge
  (schema backslash exclusion, drive-prefix refusal, `SIZE_MISMATCH` exit-code
  mapping, docs exit-code over-claim).

## Follow-ups

- WIT component substrate per ADR 0032 when a TS component host exists.
- Fresh Codex Security deep scan remains scheduled after the scanner account
  reset (2026-08-20 14:18 local); it is not a plugin-execution blocker.
- Host-fetch still allowlists by hostname origin. Literal private/loopback/
  NAT64/mapped addresses are refused (#117). DNS rebinding of a public hostname
  onto a private address is residual, the same class as any hostname allowlist.

## Post-merge review (2026-08-20)

Independent review of `16ffe4e..0a4a028` plus a full `npm run verify` (exit 0,
1135/1149 tests) found two defects, both repaired in
[#117](https://github.com/Tyler-R-Kendrick/OpenPacker/pull/117) (`527f5e6`):

1. First-party OCI ephemeral path: deferred resolution used the inspect
   _manifest_ digest as the store key while `fetchArtifactRecord` returns the
   _layout tar_. Restricted the inspect shortcut to package-archive nativeRoles.
2. Host-fetch SSRF: plugin-chosen origin strings that were loopback, link-local,
   NAT64, or IPv4-mapped literals were fetched by the host. Those addresses are
   now refused before download.

Contracts/spec review passed. First-party project install, plugin add/list/
remove, bins, generations, and the npm deferred cache path were not regressed.
