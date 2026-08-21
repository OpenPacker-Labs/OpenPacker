# One-shot swarm instruction: rescoped UPM v1 gaps (OpenPacker)

This file is a **self-contained instruction prompt** for a parent LLM coding
agent and a set of parallel implementer/reviewer subagents. It does not depend
on any prior chat. Do not ask the user to restate decisions that are frozen
here. Do not invent a timeline, a phase ladder, a slice plan, or a “later
stack.” Launch the swarms named below, give each the **entire** relevant swarm
contract plus the global sections, and finish the work.

Repository: OpenPacker, the PREX reference implementation. Trunk: `main`.
Workspace layout, gates, and protocol rules are as they exist in this checkout.

---

## 0. How the parent uses this document

You are the **parent/coordinator**. You own the user conversation, git stack
topology, shared coordinator files, PR submit/sync, independent review dispatch,
and squash-merge. You do **not** implement feature code in the shared checkout
while implementers are running.

1. Read this whole document once. Treat §2 (critique) as binding product law,
   not color commentary.
2. Create durable state at `docs/plans/upm-v1-gaps/sdlc-state.md`
   (coordinator-only) and append dispatch rows to `docs/plans/dispatch-log.md`.
3. Spawn **every implementer swarm in §6 in one dispatch wave**, each in an
   isolated git worktree, each on its own stack-layer branch, each with
   **exclusive file ownership** from §5. Do not serialize swarms behind each
   other. File ownership is the parallelization mechanism.
4. Spawn **one reviewer subagent per implementer** as soon as that implementer’s
   `.sdlc/report.json` exists. Reviewers are read-only. They do not wait for
   other swarms.
5. Integrate with `gh stack` (non-interactive). Squash-merge bottom-up only
   after each layer’s independent review passes. GitHub Actions runner minutes
   are forbidden; merge on local `npm run verify` plus reviewer pass.
   Billing-red CI does not block merge; document it on the PR and in
   `sdlc-state.md`.
6. After all implementer PRs are squash-merged, run **one** coordinator-owned
   docs/state PR for honesty lines that implementers reported as `cascadeDeltas`
   (you are the only writer of the shared doc files listed in §5). Then run
   `npm run verify` on trunk.

Do not open Linear unless it is already configured. GitHub issues with the
one-shot contract body below are acceptable. Implementers never claim issues and
never touch Linear.

---

## 1. Product identity (frozen — do not relitigate)

OpenPacker is **two surfaces**, not a replacement for npm/pip/Cargo/Maven/Go:

| Surface                 | Binary / package                                       | Role                                                             |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| Project package manager | `opm` / `opmx` (`apps/opm`, `@openpacker/opm-project`) | Manifest `opm.toml`, lock `opm.lock.json`, project store `.opm/` |
| PREX control plane      | `openpacker` / `openpackerd`                           | Normalize, solve, inspect, pack, publish, lifecycle, receipts    |

Binding ADRs (read before editing the matching area):

- **ADR 0020** (`docs/adr/0020-control-plane-not-supersession.md`): control
  plane, **not** command-compatible supersession of native managers.
- **ADR 0022** (`docs/adr/0022-opm-package-manager-surface.md`): `opm` is a
  façade over PREX-grade pin/materialize. Commands today: `init`, `add`,
  `remove`, `install`, `uninstall`, `sync`, `update`, `list`, `why`. `update` is
  documented as a first-class verb; the CLI currently aliases it to `sync`.
- **ADR 0031 / 0032**: adapters plug in; core does not hard-code ecosystems. WIT
  world `openpacker:prex-adapter@0.1.0` lives at `spec/wit/prex-adapter.wit`.
  Production guests today are TypeScript `AdapterModule` objects and **sandboxed
  native executables** (`packages/plugin-host`, `packages/sandbox`), not
  wasmtime-loaded components. `packages/adapter-host/src/bridge.ts` is explicit:
  TS is the production bridge “until WASM components load.”
- **ADR 0034**: `opm.toml` is authoritative; native project files are a one-way
  **projection**. Workspace semantics of npm/Cargo belong in those native files
  via projection, not as a second dependency graph inside opm.
- **ADR 0036**: project-local content-addressed `.opm/store` plus sandboxed
  install/exec.
- **ADR 0039–0041**: delegated plugins are metadata authorities. Host-fetch is
  HTTPS, classify-and-pin, operator pins (`OPM_HOST_FETCH_ORIGINS` ∪
  `[plugins.<id>].artifact_origins`), Bearer + one extra header only for a **pin
  plus named env**. No cookies, userinfo, netrc, IMDS, device-flow, or
  plugin-named credentials. Secrets never land in toml/lock/PURLs.
- **ADR 0028**: later ADRs supersede earlier interpretation. If you need a new
  decision, add a new ADR; do not silently contradict 0020/0032/0041.

Protocol: schema-first. Changes to `spec/prex/v1` must repair generated
consumers (`packages/contracts`) in the **same** change. Native package bytes
stay canonical; no rewrite archives for transport. No production Epoch/ATProto
dependency. Capture ≠ independent solve (`native-capture-v1` honesty).

### What already works (do not rebuild)

- Registry `opm add` for npm, Cargo, PyPI, NuGet, Maven, Go against
  `OPM_REGISTRY_*` or defaults; proof-checked closure; project store; `opmx`.
- **PyPI `inspect`** already uses Warehouse JSON
  (`PypiRepositoryProvider.inspect` in `packages/adapter-pypi/src/index.ts`).
  Yanked files/releases already map to lifecycle `yanked`. This is **not**
  sidecar-based.
- **Go `inspect`** already uses `proxy.golang.org`-style `@v/<ver>.info` +
  `@v/<ver>.mod` (`GolangProxyProvider.versionRecord` in
  `packages/adapter-golang/src/index.ts`). Missing `.mod` (404/410) is
  `GOLANG_MOD_NOT_AVAILABLE` (dependencies unknown, not empty). Retracted →
  lifecycle yanked.
- **Maven `enumerate`** already parses `maven-metadata.xml`. **Maven `inspect`
  still requires** an OpenPacker `*.catalog.json` sidecar beside the artifact
  (`catalogEntryUrl` in `packages/adapter-maven/src/index.ts` ≈ L1320). That is
  the real inspect-without-sidecar gap. POM projection for **project files**
  already exists in `packages/adapter-maven/src/project.ts` and is a different
  code path.
- `opm pack` writes native artifacts + `opm-pack-receipt.json`
  (`packages/opm-project/src/pack.ts`, `docs/guides/opm-pack.md`). Windows
  packing is refused (`UNSAFE_PATH`).
- PREX `POST /v1/publish` and lifecycle apply exist in spec + CLI + SDK. The
  reference daemon’s `publish` extension defaults to **`unavailable`**
  (`apps/openpackerd/src/reference.ts`). There is no `opm publish` / `opm yank`.
- `syncProject` (`packages/opm-project/src/project.ts`) **re-resolves the whole
  manifest and rewrites the lock**. `installProject` online **verifies** the
  lock matches a fresh resolve; offline installs the lock. CLI `update` is
  `case 'sync': case 'update':` with comment `update = sync for v1`.
- Control-plane CAS: `packages/artifact-store` (`FilesystemArtifactStore`,
  `blobs/sha256/<digest>`). Plugin CAS: user-level `packages/plugin-store`.
  Project packages: `.opm/store/` only (`packages/opm-project/src/paths.ts`,
  `install.ts`, `generations.ts`). No shared package blob CAS across projects.
- No `opm login`. Tokens for host-fetch are named env vars on pinned origins.
  `--allow-env` of `OPM_HOST_FETCH_*` or token/extra-header env names is
  refused. Sandbox `DENY_PREFIXES` includes `OPM_HOST_FETCH_`.
- Host-fetch-deferred (classify-and-pin, project pins, Bearer, extra header) is
  **shipped and merged**. Do not reopen it. Leftover host-fetch designed-v1
  items (`OPM_HOST_FETCH_REQUIRE_PIN`, path allowlists,
  `rejectUnauthorized: false`, CLI pin UX) are **out of this initiative**.

Coverage honesty today (`docs/product/reference-implementation.md`): automated
gates exercise npm, Cargo, and NuGet providers end-to-end; PyPI, Go, and Maven
are covered by codec/lock-parser tests more than provider e2e. Maven inspect
still documents the sidecar requirement.

---

## 2. Adversarial critique of the prior six-gap ranking

A previous ranking listed six “v1 universal package manager” gaps:

1. Real WIT component host
2. Maven/PyPI/Go inspect without sidecars
3. Publish + yank
4. Real `update` + workspaces
5. Shared CAS
6. `opm login` / OIDC

That list is useful as a **map of missing product verbs**. It is a bad
implementation contract. Implementing it literally as six equal features in one
wave would violate ADRs, collide on the same files, and ship theater.

### 2.1 The ranking treats six different sizes of work as one “v1”

WIT component loading is a **runtime**. Maven POM inspect is a **parser +
fixture**. `opm login` as OIDC device flow is a **credential product** that ADR
0041 already rejected as a host-fetch mechanism. Bundling them invites a swarm
to “do WIT” by adding a wasmtime dependency and a stub world, while Maven
inspect — the only inspect gap that is actually a functional lie — gets a
sidecar still required “for now.”

**Rule:** a v1 gap is a user-visible fail-closed capability that can be proven
offline against fixtures in this repo. A research runtime is not a v1 gap.

### 2.2 “Maven/PyPI/Go inspect without sidecars” is factually wrong as a bundle

| Ecosystem | Inspect authority today                  | Sidecar? | Actual gap                                                                    |
| --------- | ---------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Maven     | `*.jar.catalog.json` OpenPacker document | **Yes**  | Stock Maven Central layout: POM + checksums + `maven-metadata.xml`            |
| PyPI      | Warehouse JSON `releases` / `info`       | No       | Provider **e2e fixtures** (honesty of test depth), not a new inspect protocol |
| Go        | `.info` + `.mod` from the module proxy   | No       | Provider **e2e fixtures**; keep the 404 `.mod` warning honest                 |

Shipping a “three-ecosystem inspect rewrite” would churn working PyPI/Go code
and still miss Maven parent/BOM loss.

### 2.3 WIT host collides with a working security boundary

`DelegatedPluginExecutor` already runs guests in `@openpacker/sandbox` with
deny-by-default network, env prefix denylists, byte/time ceilings, and
digest-pinned executables. A wasmtime/jco host is a **second** sandbox, a
**new** native dependency, WASI capability mapping, streaming artifact ABI, and
a migration of every plugin. ADR 0032 **permits** the TypeScript in-process
bridge as the architectural boundary until component loading lands.

A one-shot WIT host will be either: (a) a toy that does not load production
plugins, advertised as a host — capability dishonesty of the kind
`docs/plans/capability-honesty/` already had to remediate; or (b) a
multi-package rewrite of `plugin-host`, `sandbox`, `adapter-host`, and
pack-provider identity, colliding with every other swarm.

**Decision:** do **not** implement a wasmtime/jco/component-model host in this
initiative. Implement **honesty + WIT-shaped contract fixtures** only (Swarm W).

### 2.4 Workspaces collide with update, CAS, native projection, and ADR 0020

There is **zero** `workspace` concept in `packages/opm-project` (`types.ts` /
`toml.ts` / `project.ts`). Adding `[workspace] members` implies: nested
manifests, a root lock spanning members, shared or per-member stores,
`opm add -w`, generation/GC across members, and native projection into npm
workspaces / Cargo workspace / Maven reactor / Go modules. Those native
workspace languages are **not isomorphic**. ADR 0034 already says: project
native files via adapters; do not teach core what a `.csproj` is.

A “minimal members list” that shares one lock is still a lock-format and
install-graph change in the same files `update` and CAS must edit (`toml.ts`,
`types.ts`, `lock.ts`, `project.ts`, `install.ts`, `apps/opm/src/opm.ts`).
Parallel swarms cannot one-shot that.

**Decision:** do **not** add opm workspaces. Document that multi-package repos
are multiple `opm.toml` projects (optionally sharing `OPM_STORE_HOME`) and that
npm/Cargo/Go/Maven workspace files are native-projection concerns. If a future
initiative wants opm workspaces, it is its own sdlc, not this wave.

### 2.5 Publish+yank is two different products

- Publishing to **npmjs / PyPI / crates.io / Maven Central** is native-manager
  supersession (ADR 0020). Out.
- Publishing a **PREX package manifest + bytes** to a PREX registry
  (`POST /v1/publish`) and yanking via signed status/lifecycle
  (`PATCH /v1/packages/.../status` / lifecycle apply) is in-protocol and mostly
  unwired on the reference daemon and missing from `opm`.

Yank as “delete bytes from `.opm/store`” is already `opm remove` / uninstall /
gc. Yank as **registry lifecycle** is the missing verb.

### 2.6 Shared CAS vs project store

Nix-style global store + GC is an ecosystem. The honest v1 is the plugin-store
pattern applied to **package blobs**: optional user-level `OPM_STORE_HOME`
holding verified `sha256-*` trees; projects **hardlink/reflink** into
`.opm/store`; project generations and GC still project-local; no mutable
sharing; digest mismatch fail-closed. Do not replace `.opm/store` as the
activation tree. Do not NFS a SQLite CAS
(`docs/operations/storage-deployment.md` already forbids that as
undocumented-safe).

### 2.7 Login/OIDC was already decided, then asked again

Device flow, cookies, mTLS-as-transport, IMDS, netrc, and ambient cookie jars
are rejected as **mechanisms that attach credentials because a URL appeared**.
Operators mint tokens **outside** opm (cloud CLI, `gh`, vault, human paste) and
attach them by **naming an env var on a pinned origin**. An `opm login` that
stores refresh tokens duplicates that poorly and fights `--allow-env` / sandbox
denylists.

**Decision:** implement `opm auth` as **origin → env-var name** user config (no
secret values). No OIDC, no device code, no token file with bearer material.

### 2.8 Package exclusivity vs six features

`apps/opm/src/opm.ts` is a single switch.
`packages/opm-project/src/{project,toml,types,install,registry,index}.ts` are
the crossroads. A “six swarm” plan that lets every swarm edit those files is not
parallel; it is a merge lottery. This document assigns **file-level exclusive
ownership**. New behavior goes in **new files** wherever possible. Shared files
are listed once.

---

## 3. Rescoped work this wave actually implements

Implement these capabilities, nothing else:

| ID  | Capability                | User-visible result                                                                                                                                                                                 |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M   | Maven stock-repo inspect  | `inspect` of `pkg:maven/group/artifact@version` against a fixture of real Maven layout (POM + checksums + metadata) **without** `*.catalog.json`. Sidecar remains an optional overlay when present. |
| P   | PyPI provider e2e oracles | Offline `FixtureHttpTransport` inspect/enumerate/artifact/yanked tests at npm-provider depth. No protocol change unless a test proves a real bug.                                                   |
| G   | Go provider e2e oracles   | Same for module proxy `.info`/`.mod`/`.zip`/list, including missing-`.mod` and retracted.                                                                                                           |
| U   | Real `opm update`         | Distinct from `sync`. Range-aware, selectable aliases, lock rewrite of those aliases + their transitive closure; other lock pins preserved when still valid.                                        |
| C   | Optional shared blob CAS  | `OPM_STORE_HOME` (same default-root pattern as `OPM_PLUGIN_HOME`). Hardlink/reflink into project store. Env-only; no toml schema change.                                                            |
| R   | PREX publish + yank       | Daemon can host a filesystem-backed publish/yank when explicitly configured. `opm publish` / `opm yank` talk to a PREX registry, not to npmjs.                                                      |
| A   | `opm auth`                | User-level origin→token-env-name map. `set` / `list` / `unset`. Secrets never written.                                                                                                              |
| W   | WIT honesty               | Docs + contract fixtures that the current TS/sandbox host is the v1 WIT-shaped runtime. **No wasmtime.**                                                                                            |

Refuse (do not implement, do not leave comments that imply they are in this
wave):

- wasmtime, jco, component-model guest loading, WASI preview2 host
- OAuth device flow, cookies, mTLS as host-fetch, IMDS, netrc, npmrc inheritance
- `opm login` that stores bearer/refresh tokens
- Publish/yank to npmjs, PyPI, crates.io, Maven Central, proxy.golang.org
- `[workspace]` / members / overlays / catalog of catalogs inside `opm.toml`
- Replacing `.opm/` with a global store as the only store
- HTTP (non-TLS) host-fetch, plugin-expanded pins, `rejectUnauthorized: false`
- `OPM_HOST_FETCH_REQUIRE_PIN` and path allowlists (host-fetch residual
  initiative)
- Windows project-mutation (`UNSAFE_PATH` withdrawal stays)
- Live registry tests as a substitute for offline fixtures
- Re-enabling GitHub Actions automatic workflows

---

## 4. Global constraints every swarm inherits

Copy this section into every implementer prompt.

### 4.1 Isolation and git

- Work **only** in the assigned worktree on the assigned branch
  `sdlc/upm-v1-gaps-<NN>-<slug>`.
- One issue per swarm. Incremental conventional commits after each red→green
  unit. Never one dump commit.
- Never skip hooks (`OPENPACKER_SKIP_HOOKS` is forbidden). Never `--no-verify`.
- Never edit coordinator files: `docs/plans/upm-v1-gaps/sdlc-state.md`,
  `docs/plans/dispatch-log.md`, `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`,
  `.claude/skills/**`, `.github/workflows/**`, root `package-lock.json` unless
  the swarm is explicitly a dependency task (none of these are).
- Never restructure the stack or merge PRs.
- After changing `@openpacker/adapter-core` or `@openpacker/opm-project`
  **source**, rebuild that workspace before consumer tests (`package.json`
  exports `./dist/esm`). Stale dist is a known false-green.
- `git config --local rerere.enabled true` is already the repo default; do not
  fight it.

### 4.2 Red/green and gates

1. Write failing tests first (unit + at least one behavior or provider-oracle
   test as specified in the swarm).
2. Smallest implementation that goes green.
3. Before **every** commit: the swarm’s workspace
   `npm run test --workspace <pkg>` and `npm run typecheck --workspace <pkg>`.
   If you touch `spec/prex/v1`, also
   `npm run build --workspace @openpacker/contracts` and
   `npm run check:contracts` / `npm run test:conformance` as applicable.
4. `npm run agent:check:staged` must pass (hook). Use `npm run verify` only if
   your swarm’s contract requires it (Registry publish swarm and CLI-facing
   swarms should run it before handback if they touch apps). Prefer narrow gates
   in the inner loop.
5. Coverage: production files you add must be instrumented; repo policy is 100%
   files / ≥70% functions per workspace (`scripts/coverage-policy.mjs`). Do not
   drop a workspace below that.
6. All tests offline and fail-closed. `FixtureHttpTransport` / temp dirs /
   committed `fixtures/`. No live Maven Central / PyPI / proxy.golang.org /
   npmjs in mandatory tests.

### 4.3 Test types this initiative must add (not “have a comment about”)

Authorities are `docs/guides/testing.md` and `scripts/check-test-inventory.mjs`.
Each swarm that ships behavior adds **its own uniquely named oracle files** (no
two swarms edit the same test file). Types required across the **initiative**,
not necessarily inside every swarm:

| Type           | Where new oracles may be added                                                                                                                                          | Who                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unit           | `packages/<owned>/src/*.test.ts` or `packages/<owned>/test/*.ts`                                                                                                        | Every implementer swarm                                                                                      |
| Behavior (BDD) | `tests/behavior/upm-<id>.behavior.test.mjs` (one file per swarm that has a user verb)                                                                                   | U, R, A, M (inspect is a provider verb; still add a behavior file for Maven inspect via public provider API) |
| Snapshot       | Vitest `toMatchFileSnapshot` **awaited** (Vitest 3). Put snaps next to the test                                                                                         | M (POM→inspection shape), U (lock rewrite), optional P/G                                                     |
| Contract       | `spec/prex/v1` + `packages/contracts` + conformance vectors only if you change protocol                                                                                 | R only, and only if a schema hole blocks publish/yank                                                        |
| Mutation       | Small mutant table in `packages/opm-project/test/update.mutation.test.ts` (U) and `packages/adapter-maven/src/inspect.mutation.test.ts` (M)                             | U, M                                                                                                         |
| Chaos          | Fault injection on publish transport / CAS link failure — `packages/opm-project/test/shared-store.chaos.test.ts` (C), `apps/openpackerd/test/publish.chaos.test.ts` (R) | C, R                                                                                                         |
| Fuzz class     | Do **not** edit `scripts/fuzz-smoke.mjs`. Add `tests/fuzz/upm-<id>.mjs` if you have a parser (M: POM; A: auth config). Report inventory row as `cascadeDeltas`          | M, A                                                                                                         |
| Atomic unit    | Every new exported function has a direct test; no “covered only via CLI”                                                                                                | All                                                                                                          |

If `check-test-inventory` needs a new authority row, **do not edit the script**.
Put the exact row in `cascadeDeltas`.

### 4.4 Code style and honesty

- TypeScript ESM matching the package. No new root `.js` sources. Tests may be
  `.ts` or existing `.mjs` behavior pattern.
- `OpmError` / `ProviderError` codes stay stable; new codes are UPPER_SNAKE and
  used in tests.
- Semantic loss over pretending completeness (Maven parent/BOM/profiles; Go h1 ≠
  sha256 zip).
- No secrets in fixtures. Token tests use env stubs.
- `redactUrl` for any operator/plugin URL in errors (already in adapter-core).
- Rebuild dist; do not test against source when exports point at dist.
- Windows: do not “fix” the stable-handle withdrawal.

### 4.5 Handback (mandatory)

Write `.sdlc/report.json` at the worktree root:

```json
{
  "issue": "upm-v1-gaps-<id>",
  "branch": "sdlc/upm-v1-gaps-<NN>-<slug>",
  "gates": [
    { "name": "workspace-test", "pass": true },
    { "name": "workspace-typecheck", "pass": true }
  ],
  "cascadeDeltas": [],
  "requirementChanges": []
}
```

If you open a PR, embed the same JSON in a fenced `sdlc-report` block. Report
docs/inventory/ADR one-liners as `cascadeDeltas` with **exact replacement
text**. Do not apply them.

Final message: issue id, branch, one-paragraph summary, files touched, tests
run, anything blocked.

---

## 5. Exclusive ownership (the parallelization law)

Two swarms must never edit the same path. Git merge is not a protocol.

### 5.1 Owned paths (implementers)

| Swarm               | Exclusive paths (create or edit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M Maven inspect** | `packages/adapter-maven/src/index.ts` (inspect + helpers only; do not rewrite codec/lock/project), `packages/adapter-maven/src/index.test.ts`, `packages/adapter-maven/src/inspect.mutation.test.ts` (new), `packages/adapter-maven/src/__snapshots__/**` (new), `fixtures/catalogs/maven/**` (add POM/checksum fixtures; do not delete existing catalog sidecars), `tests/behavior/upm-maven-inspect.behavior.test.mjs` (new), `tests/fuzz/upm-maven-pom.mjs` (new)                                                                                                                                                                |
| **P PyPI oracles**  | `packages/adapter-pypi/src/index.test.ts`, `packages/adapter-pypi/src/provider.e2e.test.ts` (new), `fixtures/catalogs/pypi/**` (add only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **G Go oracles**    | `packages/adapter-golang/src/index.test.ts`, `packages/adapter-golang/src/provider.e2e.test.ts` (new), `fixtures/catalogs/golang/**` (add only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **U Update**        | `packages/opm-project/src/update.ts` (**new**), `packages/opm-project/test/update.test.ts` (**new**), `packages/opm-project/test/update.mutation.test.ts` (**new**), `packages/opm-project/test/__snapshots__/update-*` (new), `tests/behavior/upm-update.behavior.test.mjs` (new), **plus the three surgical shared hunks in §5.2**                                                                                                                                                                                                                                                                                                |
| **C Shared CAS**    | `packages/opm-project/src/shared-store.ts` (**new**), `packages/opm-project/test/shared-store.test.ts` (**new**), `packages/opm-project/test/shared-store.chaos.test.ts` (**new**), `packages/opm-project/src/install.ts`, `packages/opm-project/src/paths.ts` (additive, see contract), **plus index export hunk in §5.2**                                                                                                                                                                                                                                                                                                         |
| **R Publish/yank**  | `packages/opm-project/src/publish-client.ts` (**new**), `packages/opm-project/test/publish-client.test.ts` (**new**), `apps/openpackerd/src/publish-store.ts` (**new**), `apps/openpackerd/src/index.ts` and `apps/openpackerd/src/reference.ts` (wiring only, see contract), `apps/openpackerd/test/publish-store.test.ts` (**new**), `apps/openpackerd/test/publish.chaos.test.ts` (**new**), `apps/opm/src/commands/publish.ts` (**new**), `apps/opm/src/commands/yank.ts` (**new**), `apps/opm/test/publish-yank.test.ts` (**new**), `tests/behavior/upm-publish-yank.behavior.test.mjs` (new), **plus surgical hunks in §5.2** |
| **A Auth**          | `packages/opm-project/src/auth-config.ts` (**new**), `packages/opm-project/test/auth-config.test.ts` (**new**), `apps/opm/src/commands/auth.ts` (**new**), `apps/opm/test/auth.test.ts` (**new**), `tests/behavior/upm-auth.behavior.test.mjs` (new), `tests/fuzz/upm-auth-config.mjs` (new), **plus surgical hunks in §5.2**                                                                                                                                                                                                                                                                                                       |
| **W WIT honesty**   | `packages/adapter-host/src/bridge.ts` (comments/tests only if needed), `packages/adapter-host/src/wit-contract.test.ts` (**new**), `spec/wit/README.md`, `fixtures/protocol/wit-adapter/**` (new fixtures that `assertWitShapedModule` already accepts), **no production loader**                                                                                                                                                                                                                                                                                                                                                   |

### 5.2 Surgical shared hunks (textually disjoint)

Only the named swarm may apply the named hunk. Insert at the **anchor** given.
Do not reformat surrounding code.

**`packages/opm-project/src/index.ts`**

- **U:** In the existing `export { ... } from './project.js'` block (currently
  includes `syncProject`), add `updateProject,` after `syncProject,`.
- **C:** Immediately **after** the `generations.js` export block, add a new
  block:

```ts
export {
  sharedStoreRoot,
  materializeThroughSharedStore,
} from './shared-store.js';
```

- **R:** Immediately after C’s block (or after generations if C is not yet
  merged; parent resolves order on stack), add:

```ts
export {
  publishPackedArtifact,
  yankRegistryVersion,
} from './publish-client.js';
```

- **A:** Immediately after R’s block:

```ts
export {
  defaultAuthConfigPath,
  readAuthConfig,
  upsertAuthOrigin,
  removeAuthOrigin,
  tokenEnvNameForOrigin,
} from './auth-config.js';
```

Parent stacks C→U is unnecessary; these hunks do not overlap if each swarm only
adds its own block/name.

**`apps/opm/src/opm.ts`**

- **U only:** Replace the existing `case 'sync': case 'update':` so that `sync`
  stays as today and `update` calls `updateProject` (imported from
  `@openpacker/opm-project`). Change the user-facing stdout so update does not
  print “Synced”. Update the `help()` line for `opm update` to document
  `[alias...]` and `--latest` as specified in Swarm U. Do not add new command
  names.
- **R only:** Add `'publish'` and `'yank'` to `COMMANDS`. Add `case 'publish'`
  and `case 'yank'` that dynamic-import `./commands/publish.js` and
  `./commands/yank.js`. Place the cases immediately **before** `case 'list':`.
  Add help lines after the pack section.
- **A only:** Add `'auth'` to `COMMANDS`. Add `case 'auth'` that dynamic-imports
  `./commands/auth.js`. Place it immediately **after** the `plugin` cases. Add
  help lines under a new “Auth (env names only)” section.

**`apps/openpackerd/src/index.ts` / `reference.ts` (R only)**

- Wire an optional filesystem publish extension constructed from
  `publish-store.ts` when a CLI/env opt-in is present
  (`OPENPACKER_PUBLISH_STORE`). Default remains `unavailable`. Do not change
  other operations.

**`packages/opm-project/src/install.ts` and `paths.ts` (C only)**

- Additive: `installFromLock` / blob materialize may call
  `materializeThroughSharedStore` when `OPM_STORE_HOME` is set. Do not change
  function names or the lock schema. `paths.ts` may add a helper for the env
  root; do not change `projectPaths()` shape except optional unused fields are
  forbidden — keep project paths project-local.

**Forbidden to all implementers**

- `docs/guides/opm.md`, `docs/product/reference-implementation.md`,
  `docs/adr/**` (except W may edit `spec/wit/README.md` only), `docs/plans/**`,
  `scripts/check-test-inventory.mjs`, `scripts/fuzz-smoke.mjs`,
  `packages/opm-project/src/toml.ts`, `packages/opm-project/src/types.ts`,
  `packages/opm-project/src/project.ts` (U must **not** edit `project.ts`;
  `update.ts` imports `resolveManifestToLock` / `installFromLock` / lock helpers
  from existing modules — if a helper is not exported, export it from
  `project.ts` **only by adding to the existing export list of a function that
  already exists**, or duplicate the small helper in `update.ts`. Prefer
  importing `resolveManifestToLock` which is already exported from `index.ts`.)
- Wait: `resolveManifestToLock` is exported. U should **not** call it for the
  whole manifest blindly (that is sync). U implements its own selection. It may
  import `codecFor`, `providerFor`, lock writers, `installFromLock`,
  `projectNativeFormats` — `projectNativeFormats` is not currently exported. **U
  may import from `./native.js` inside the same package.** It must not edit
  `native.ts`.
- `packages/adapter-core/**` — out of this wave (host-fetch shipped).
- `packages/plugin-host/**`, `packages/sandbox/**` — out (WIT host refused).

### 5.3 Coordinator-only paths

Parent writes after implementer handbacks (or in a docs PR, still parent):

- `docs/plans/upm-v1-gaps/sdlc-state.md`, `docs/plans/dispatch-log.md`
- `docs/guides/opm.md` (update vs sync, auth, publish/yank, `OPM_STORE_HOME`,
  WIT honesty one-liner)
- `docs/product/reference-implementation.md` (Maven inspect no longer
  sidecar-required; PyPI/Go e2e oracles exist)
- `docs/adr/0042-upm-v1-gaps.md` (new, from §7)
- `scripts/check-test-inventory.mjs` rows from `cascadeDeltas`
- `docs/guides/testing.md` matrix oracles if new types/files must be listed

---

## 6. Swarm contracts (atomic, parallel, one-shot)

Each subsection is the **full issue body** to paste into the implementer.
Include §1, §3, §4, §5 plus the swarm’s subsection. Subagents must not defer to
“the conversation” or to another swarm for missing semantics: if a dependency is
an import of a **new** symbol from another swarm, code against the **frozen
signatures in this document**. If that symbol is not on `main` yet, the swarm
that **owns** it implements it; the other swarm must not stub it. CLI hunks that
`dynamic-import('./commands/….js')` fail until those command files exist — that
is why **R and A own their command files on the same branch as their library
code**, and **U edits the existing update case** to call `updateProject` which U
also owns. Parent should put R’s `apps/opm/src/opm.ts` hunk and U’s hunk on
**different line ranges** as specified so `gh stack` can still merge; if a
textual conflict appears, parent rebases — implementers do not.

Suggested branch names (parent creates before spawn):

- `sdlc/upm-v1-gaps-01-maven-inspect`
- `sdlc/upm-v1-gaps-02-pypi-oracles`
- `sdlc/upm-v1-gaps-03-golang-oracles`
- `sdlc/upm-v1-gaps-04-update`
- `sdlc/upm-v1-gaps-05-shared-cas`
- `sdlc/upm-v1-gaps-06-publish-yank`
- `sdlc/upm-v1-gaps-07-auth`
- `sdlc/upm-v1-gaps-08-wit-honesty`

Stack them as **siblings on `main` where ownership is disjoint** (M, P, G, W, C,
U, R, A are all disjoint if they obey §5). Prefer **independent PRs from
`main`**, not a tall stack, because there is no functional dependency. If
`gh stack` requires a chain, order: W (docs-adjacent fixtures) / M / P / G / C /
U / A / R — still merge in any order if GitHub PRs are unstacked. Do not invent
a “foundations PR.”

---

### Swarm M — Maven stock-repository inspect

**Problem.** `MavenRepositoryProvider.inspect` fetches
`${packaging}.catalog.json` via `catalogEntryUrl`. A stock Maven repo (Central,
Nexus proxy of Central, `file:` fixture of that layout) has
`maven-metadata.xml`, `${artifact}-${version}.pom`, the artifact, and
`.sha1`/`.md5`/`.sha256` siblings — not OpenPacker JSON.
`docs/product/reference-implementation.md` already admits this. Enumerate
already speaks `maven-metadata.xml`. Codec `translateMetadata` already consumes
`MavenCatalogEntry` (GAV, deps, `openpackerSha256`, size, packageUrl).

**Implement**

1. Change `inspect` so the **primary** metadata source is the version POM at the
   standard repository path (`…/group/artifact/version/artifact-version.pom`).
   Parse `groupId`, `artifactId`, `version`, `packaging`/`classifier` from POM
   (classifier stays a PURL qualifier; default packaging `jar`). Map
   `<dependencies>` to `MavenDependency` (existing type). Feed that object into
   **existing** `codec.translateMetadata` so inspect output stays
   `ProviderInspection`.
2. Artifact location: repository URL + standard path for packaging (jar/war/…).
   Size/digest: read sibling `${filename}.sha256` (hex) if present; else `.sha1`
   with semantic loss `MAVEN_SHA1_NOT_SHA256` and **do not** invent sha256; else
   no expected digest (download path must still hash bytes later; inspect must
   not fabricate `sha256:000…0`).
3. If `*.catalog.json` **is** present, it is an overlay: identity must match GAV
   or `INVALID_PROVIDER_METADATA`; it may supply `openpackerSha256` /
   `packageSize` / `packageUrl`. Inspect must succeed when the sidecar is
   **absent**.
4. **Do not** recursively fetch parent POMs or imported BOMs. If the POM has
   `<parent>` or `scope=import` BOM, emit structured `SemanticLoss`
   (`MAVEN_PARENT_NOT_INLINED`, `MAVEN_BOM_NOT_INLINED`) and return **only**
   dependencies written in this POM. Unresolved properties (`${foo}` left in
   groupId/artifactId/version) → fail closed `INVALID_PROVIDER_METADATA` or
   loss + skip that dep; do not emit a PURL with a literal `${project.version}`
   as a version. Prefer fail closed on the **root GAV** if the POM’s GAV cannot
   be resolved without parent (common: child omits version). If
   group/artifact/version cannot be completed from this POM file alone,
   `VERSION_NOT_FOUND` / `INVALID_PROVIDER_METADATA` — never guess.
5. Profiles: ignore profile-only deps; loss `MAVEN_PROFILES_NATIVE_ONLY`.
   Optional deps: keep but mark optional in native semantics as today if the
   codec already does.
6. SNAPSHOT versions: fail closed (`VERSION_NOT_FOUND` or `UNRESOLVABLE`) unless
   the fixture also has `maven-metadata.xml` for that snapshot and you already
   have enumerate support — do not add a unique snapshot resolver in this swarm
   if enumerate does not. Prefer refusing SNAPSHOT inspect with a clear code.
7. Keep `FixtureHttpTransport` as the only network. Add committed fixtures under
   `fixtures/catalogs/maven/`:
   - existing `maven-metadata-org.example-demo-tool.xml` may be reused
   - a **real-shaped** POM with two compile deps, one test dep, one optional,
     one exclusion
   - a POM with `<parent>` (to prove loss, not resolution)
   - `demo-tool-1.0.0.jar.sha256` and the jar bytes (small)
   - **no** `catalog.json` in the success-path fixture
   - a second fixture **with** sidecar overlay proving sha256 overlay still
     works
8. Tests (red first):
   - inspect without sidecar returns identity, requirements from POM, artifact
     URI, sha256 from sibling
   - missing POM → `VERSION_NOT_FOUND` / `UPSTREAM_UNAVAILABLE` as appropriate;
     **fetch of catalog.json must not be required**
   - sidecar mismatch GAV → `INVALID_PROVIDER_METADATA`
   - parent POM → loss present, no extra HTTP to parent coordinates
   - `${property}` in a dependency version that is not in this POM’s
     `<properties>` → that dep is not silently turned into `*`
   - mutation: drop sha256 sibling; corrupt POM identity; swap groupId
   - snapshot of canonical inspection JSON (await `toMatchFileSnapshot`)
   - behavior test: Given a Maven layout fixture, When inspect exact PURL, Then
     package identity matches GAV and catalog.json was not requested (assert
     transport URL list)
9. Do **not** change `MavenProjectFormat` (`project.ts`) except if you extract a
   shared POM parser into e.g. `packages/adapter-maven/src/pom.ts` **new file
   you also own**. Reuse beats duplication: if `project.ts` parser is not usable
   for repository POMs, add `pom.ts` and leave `project.ts` alone (do not
   refactor project projection in this swarm).

**Acceptance**

- `npm run test --workspace @openpacker/adapter-maven` and typecheck pass.
- A test proves inspect against a layout **without** any `catalog.json` URL
  succeeding.
- Existing sidecar tests still pass (overlay or legacy path).
- `cascadeDeltas` for `docs/product/reference-implementation.md`: delete/replace
  the sentence that inspect “reads OpenPacker-authored `*.catalog.json` sidecars
  — it does not parse POMs” with text that inspect parses the version POM and
  optional checksum siblings; sidecar optional.

**Stop.** Do not add a Maven resolver, do not fetch Central, do not implement
Gradle module metadata.

---

### Swarm P — PyPI provider e2e oracles

**Problem.** Inspect is already Warehouse JSON. The honesty gap is **test
depth**: reference-implementation says PyPI is codec/lock-parser only versus
npm/Cargo/NuGet provider e2e.

**Implement**

1. Add `packages/adapter-pypi/src/provider.e2e.test.ts` using
   `FixtureHttpTransport` the way `packages/adapter-npm/src/index.test.ts` does.
   Cover:
   - `enumerate` versions from the project document
   - `inspect` exact PURL: identity, requirements from `requires_dist`, artifact
     URL, sha256 from `digests.sha256`
   - yanked release → lifecycle yanked, ineligible
   - yanked **file** on an otherwise live version: do not pick the yanked wheel
     if a non-yanked artifact exists; if all files yanked, version is yanked
   - `requires_python` preserved as native semantics / loss, not dropped
   - missing version → `VERSION_NOT_FOUND`
   - artifact fetch hashes bytes and matches
2. Reuse or extend `fixtures/catalogs/pypi/**`. Do not hit pypi.org.
3. If you find a real inspect bug (e.g. yanked file selected, PEP 503 name
   mismatch), **fix it** in `packages/adapter-pypi/src/index.ts` — this swarm
   owns that package’s src **only if a test in this swarm requires the fix**. Do
   not drive-by refactor translateMetadata.
4. Do not add Simple API HTML scraping unless inspect cannot obtain artifacts
   from JSON (it can).

**Acceptance**

- Workspace test + typecheck green.
- `cascadeDeltas` for reference-implementation.md: PyPI provider
  inspect/artifact is exercised offline at provider-e2e depth (keep the uv.lock
  JSON-projection caveat; that is lock-import, not inspect).

**Stop.** No uv.lock TOML parser (separate honesty item, not this wave). No
twine publish.

---

### Swarm G — Go module proxy e2e oracles

**Problem.** Same honesty gap as PyPI. Inspect already uses `.info` + `.mod`.
Need npm-grade provider tests including the fail-closed `.mod` 404 path and
retracted lifecycle.

**Implement**

1. Add `packages/adapter-golang/src/provider.e2e.test.ts` with
   `FixtureHttpTransport` mapping:
   - `/<module>/@v/list`
   - `/<module>/@v/v1.0.0.info`
   - `/<module>/@v/v1.0.0.mod`
   - `/<module>/@v/v1.0.0.zip`
2. Assertions:
   - enumerate matches list
   - inspect requirements come from `.mod` require (not an empty list when
     `.mod` exists)
   - 404 `.mod` → inspect succeeds with `warnings` containing
     `GOLANG_MOD_NOT_AVAILABLE` and **no** fabricated requires
   - non-404 `.mod` error → `UPSTREAM_UNAVAILABLE`
   - retracted in metadata → lifecycle yanked (use the same field the codec
     already uses)
   - artifact zip sha256 of fixture bytes
   - `encodeGoModulePath` used for uppercase module paths
3. Existing `fixtures/catalogs/golang/**` already has list/info/mod/zip — reuse.
   Add a 404-mod fixture and a retracted fixture as needed.
4. Fix production code only if a new test proves a bug (this swarm may edit
   `packages/adapter-golang/src/index.ts` then).

**Acceptance**

- Workspace test + typecheck green.
- `cascadeDeltas`: Go provider inspect/artifact e2e offline; keep h1-vs-sha256
  loss honesty.

**Stop.** No `GOPROXY=off` VCS fetch. No `go.mod` replace/exclude graph beyond
what inspect already represents.

---

### Swarm U — Range-aware `opm update` (not sync)

**Problem.** CLI `update` is `sync`. `syncProject` re-resolves **every** direct
requirement from the manifest and rewrites the whole lock, then installs. That
is closer to `npm install` than `npm update`. Users need:

- `opm sync` — keep current behavior (re-resolve all directs from manifest
  constraints, rewrite lock, install). Do **not** change `syncProject`.
- `opm update` — bump **selected** packages to the newest version that still
  satisfies the **manifest range**, re-solve **their** transitive closure, leave
  other lock pins in place when they still satisfy the new graph; fail closed if
  the solver cannot.

**Frozen API** (`packages/opm-project/src/update.ts`):

```ts
export async function updateProject(input: {
  root: string;
  aliases?: readonly string[]; // empty/undefined = all direct packages with a range (not an exact pin)
  latest?: boolean; // if true, also rewrite manifest version to the selected exact version (breaking bump); default false
  offline?: boolean;
  catalogPaths?: readonly string[];
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[]; // aliases whose locked exact PURL changed
}>;
```

**Semantics**

1. Read manifest + lock. If no lock, `update` is identical in effect to `sync`
   (must still go through this function so CLI can print “Updated”).
2. **Exact pins are not updated** unless `latest: true` (then the manifest
   version/range is rewritten to the newest enumerated version and the lock
   follows). An exact pin is: purl contains `@version` **or** `version` matches
   `^[A-Za-z0-9][A-Za-z0-9._+-]*$` (same test as `assertLockMatchesManifest`).
   Ranges (`^1.2`, `>=1,<2`, PyPI specifiers, Cargo reqs) are updateable.
3. Default alias set: all **direct** manifest packages that are not exact pins.
   If `aliases` is provided, every name must be a direct alias or
   `OpmError('NOT_FOUND')`. Updating an exact pin without `--latest` →
   `OpmError('UNRESOLVABLE', '… exact pin; pass --latest to change the manifest')`.
4. For each selected alias: enumerate registry/catalog versions (reuse
   `listRegistryVersions` / catalog), filter by codec `parseNativeRange` +
   `evaluateRange` / existing codec compare, **exclude yanked/ineligible**
   lifecycle when inspect/metadata is available; if enumerate has no lifecycle,
   do not invent yanked. Pick newest by codec `compareNativeVersions`.
5. Rebuild lock: start from **existing lock**, replace selected directs’ exact
   PURLs/versions/digests via the same resolution path `addPackage` /
   `resolveRequirement` uses (do not fork a third resolver). Re-run transitive
   solve for the new direct set (`resolveGraph` / `solveGraph` as
   `resolveManifestToLock` does). **Drop lock entries that are no longer in the
   closure. Keep lock entries that remain reachable even if not selected.** Do
   not keep a stale transitive that the new solve did not prove.
6. Offline: cannot enumerate registries. Offline update of registry-sourced
   packages fails `UNRESOLVABLE` / `UNAVAILABLE` unless catalogPaths provide
   versions. File-sourced packages are not “updated” (no-op, not in `updated`).
7. After lock write: same uninstall-stale + `installFromLock` +
   `projectNativeFormats` as sync. Do not duplicate those functions; import
   them. If `installFromLock` is not exported, import from `./install.js` inside
   the package.
8. Proof: online update must still be a checked solve, not “newest of each dep
   independently,” for the **new** graph. Same posture as
   `resolveManifestToLock` (offline stays direct-only).
9. CLI (`opm.ts` hunk only):
   `opm update [alias...] [--latest] [--offline|--online]`. Print
   `Updated N package(s): a, b` or `Already up to date`. Never print `Synced`.
10. Tests:
    - two directs `^1.0.0`; lock at 1.0.0; catalog/registry fixture has 1.0.0
      and 1.2.0 → update rewrites lock to 1.2.0; unselected exact other package
      stays
    - exact pin unchanged without `--latest`
    - `--latest` on exact pin rewrites manifest version **and** lock
    - yanked newest skipped
    - unknown alias → NOT_FOUND
    - mutation: range `^1` must not accept `2.0.0`; deleting lock mid-update
      fail-closed
    - snapshot of lock JSON after update (await)
    - behavior: Given manifest range and older lock, When `updateProject`, Then
      lock exact version is the newest in-range fixture version
11. Must not edit `syncProject`. A test in `update.test.ts` may import
    `syncProject` to prove the two functions differ on a fixture where sync
    would also bump everything — that is fine.

**Acceptance**

- Workspace `@openpacker/opm-project` test+typecheck green including new files.
- `apps/opm` typecheck: U’s `opm.ts` hunk imports `updateProject` which U also
  adds to `index.ts`. Run `npm run test --workspace @openpacker/opm` if you
  touch `opm.ts` — add a focused test **only if you can do it without editing
  `apps/opm/test/opm.test.ts` in a colliding way**. Prefer asserting via
  `update.test.ts` at the library. If you must edit `apps/opm/test/opm.test.ts`,
  add a **new** `apps/opm/test/update.test.ts` instead (you own that new file;
  add it to the exclusive table — parent: treat `apps/opm/test/update.test.ts`
  as U-owned).

**Stop.** No workspaces. No `opm outdated` UI beyond `updated` list. No
interactive prompts.

---

### Swarm C — Shared package blob CAS (`OPM_STORE_HOME`)

**Problem.** Each project copies verified blobs into `.opm/store/sha256-<hex>/`.
Plugin store already has a user-level CAS. Package installs should optionally
hardlink (or copy if cross-device) from a shared verified blob store so two
projects with the same digest do not double-materialize.

**Frozen API** (`packages/opm-project/src/shared-store.ts`):

```ts
export function sharedStoreRoot(env?: NodeJS.ProcessEnv): string | undefined;
export async function materializeThroughSharedStore(input: {
  digest: string; // sha256:hex
  projectStorePath: string; // destination directory currently used as storePathForDigest
  bytes: Uint8Array | (() => Promise<Uint8Array>);
  format: ArchiveFormat;
  env?: NodeJS.ProcessEnv;
}): Promise<{ path: string; shared: boolean }>;
```

**Semantics**

1. `sharedStoreRoot`: if `OPM_STORE_HOME` set, that absolute path (must be
   absolute; relative → `OpmError('UNSAFE_PATH')`). Else `undefined` (feature
   off; today’s project-only store).
2. Layout: `<OPM_STORE_HOME>/sha256-<hex>/` materialized tree, same as project
   store entries. Index optional; digest directory is the source of truth.
   `plugins.json`-style index is **not** required.
3. On install, when env is set: if shared entry exists, verify
   `stableStoreTreeDigest` (already in generations/paths) matches claimed
   digest; then `link` (hardlink files) or `fs.copyFile` fallback into the
   **project** store path. Never point `projectPaths().store` at the shared
   root. Project GC must not `rm` the shared root.
4. If shared entry missing: materialize **first** into shared (same
   `materialize` + inspectArchive limits as install), then link into project.
   Atomic: temp dir + rename. Failed materialize must not leave a digest dir
   that later inspect would trust.
5. Cross-device `EXDEV`: copy instead of hardlink; still digest-verify. Reflink
   (`FICLONE`) is optional optimization, not required.
6. Two projects, same digest, same filesystem: second install does not re-fetch
   bytes if shared has them (test with a counting fetch stub).
7. Digest mismatch in shared → refuse (`VERIFICATION_FAILED` / existing
   integrity error), do not silently replace unless the incomplete marker is
   present. Prefer fail closed over self-heal unless you can prove the dir is a
   leftover tmp.
8. `install.ts`: hook only the path that writes a new store tree from verified
   bytes. Do not change lock schema. Do not share **shims** or `.opm/bin`.
9. Chaos tests: kill after shared write before project link; ensure retry
   succeeds; chmod/read-only shared → fail closed; symlink in shared as store
   entry → refuse (no-follow, same as project store).
10. Tests use temp dirs; never write the developer’s real `OPM_STORE_HOME`.

**Acceptance**

- opm-project tests cover off/on, EXDEV copy path (injectable link fn), digest
  mismatch, GC of project does not delete shared (simulate `collectGarbage` if
  you can call it without editing `generations.ts`; if you cannot, test
  `materializeThroughSharedStore` isolation only and document GC interaction in
  `cascadeDeltas` as a residual).
- **Prefer not editing `generations.ts`.** If GC would delete shared paths
  because they were recorded as store paths, you must **not** record shared
  paths as project store members. Project store still has its own
  copy/hardlinked tree; GC already collects project store paths. This is the
  design that avoids the generations collision.

**Stop.** No daemon CAS merge. No content-addressed nix `/nix/store` names. No
sqlite. No toml `shared_store` key.

---

### Swarm R — PREX publish + yank (not native registries)

**Problem.** `opm pack` produces native bytes. PREX publish is specified
(`spec/prex/v1/registry-api.md` `POST /v1/publish`, status PATCH). SDK already
has `publish`. Daemon `extensions.publish` is `unavailable`. Operators cannot
round-trip pack → PREX registry → yank in this repo without custom extensions.

**Implement**

1. **Filesystem publish store** (`apps/openpackerd/src/publish-store.ts`): given
   a directory, implement `publish(PublishRequest)` and a yank/status update
   that:
   - validates `RegistryPublishRequest` via existing contracts
   - re-derives manifest digest (never trust caller digest)
   - stores canonical bytes + artifact blobs in that directory using
     `@openpacker/artifact-store` `FilesystemArtifactStore` where possible
   - rejects digest-changing re-publish of `(name, version)`
   - yank: signed status update **or**, if signatures are too heavy for v1
     fixtures, operator-configured **offline test key** from a fixture **and** a
     documented `registry-configured` namespace proof only (ADR-honest). Prefer
     reusing `packages/lifecycle` reduction for yanked. Do not invent a parallel
     lifecycle algebra.
   - default daemon still `unavailable` unless `OPENPACKER_PUBLISH_STORE` points
     at a directory (or CLI flag if one already exists for extensions; do not
     add a flag if env is enough). Bind address policy already in daemon: do not
     weaken “explicit opt-in so OPENPACKER_HOST cannot accidentally publish.”
2. **opm-project client** (`publish-client.ts`):
   - `publishPackedArtifact`: reads pack output + receipt, builds
     `PublishRequest` using existing contract types, POST via `@openpacker/sdk`
     `PrexClient` to `OPM_PREX_REGISTRY` (new env) or `--registry` passed in.
     Fail closed if offline.
   - `yankRegistryVersion`: PATCH/lifecycle apply as specified; require exact
     name+version; no wildcards.
3. **CLI command files** (owned by R):
   - `opm publish --from <dir>|--pack <ecosystem> --package-version <v> --registry <url>`
   - If `--pack` is given, call existing `packProject` then publish. Do not
     reimplement pack.
   - `opm yank <exact-purl> --registry <url> --reason <text>`
   - Refuse `--offline`. Refuse publishing to `registry.npmjs.org` / `pypi.org`
     / `crates.io` by origin denylist (fail `UNSAFE_PATH` / usage error). PREX
     registries only (OpenAPI base that serves `/v1/publish`).
4. Tests:
   - daemon: publish then fetch blob by digest from the store dir; duplicate
     identical bytes idempotent; different bytes same version rejected; yank
     makes subsequent resolution ineligible in the publish-store’s metadata
   - chaos: kill mid-put; no half-published version
   - client: offline refused; npmjs origin refused
   - behavior: pack fixture → publish to loopback daemon with publish-store →
     yank → inspect/status yanked
5. Schema: **only if** `PublishRequest` cannot express packed native bytes.
   Prefer existing fields. If you must amend `spec/prex/v1`, do schema +
   `packages/contracts` generate + conformance vectors **in this swarm** (you
   then own those spec files for the amendment only — parent: if R needs spec,
   it is the **only** swarm allowed to touch `spec/prex/v1/schemas` related to
   publish). Do not change delegated-adapter or host-fetch specs.

**Acceptance**

- Default `openpackerd` without `OPENPACKER_PUBLISH_STORE` still returns
  unavailable for publish.
- With env set, offline tests round-trip.
- `cascadeDeltas` for `docs/guides/opm.md` publish/yank section and
  `docs/guides/cli.md` only if needed.

**Stop.** No `npm publish`. No OIDC to GitHub Packages. No namespace DNS-TXT
implementation beyond `registry-configured` fixtures.

---

### Swarm A — `opm auth` (env names, no secrets)

**Problem.** Private registries need tokens. ADR 0041 already specifies Bearer
from a **named env** on a **pinned origin**. There is no user-level place to
remember “this origin uses `NPM_TOKEN`,” so operators re-export ad hoc. People
then ask for device flow.

**Frozen types** (`auth-config.ts`):

```ts
export interface AuthConfig {
  version: 1;
  origins: Record<string, { tokenEnv: string }>; // keys: HTTPS origin-form, no userinfo, via normalizePinnedOrigin from adapter-core
}
```

**Semantics**

1. Default path: `$XDG_CONFIG_HOME/openpacker/auth.json` or
   `~/.config/openpacker/auth.json` (override `OPM_AUTH_CONFIG`). Create with
   mode `0600` on POSIX. File contains **names only**. If a value looks like a
   token (length, `ghp_`, `eyJ`, `Bearer `), refuse to write (`UNSAFE_PATH`).
2. `upsertAuthOrigin({ origin, tokenEnv })`: origin through
   `normalizePinnedOrigin` (HTTPS, no userinfo). `tokenEnv` `[A-Z_][A-Z0-9_]*`.
   Duplicate origin replaces tokenEnv.
3. `removeAuthOrigin`, `readAuthConfig` (missing file → empty),
   `tokenEnvNameForOrigin`.
4. CLI:
   - `opm auth set --origin https://npm.internal.example --token-env NPM_TOKEN`
   - `opm auth list` prints origin and env **name**
   - `opm auth unset --origin …`
   - `opm auth set --origin … --token …` **must not exist**.
5. Integration: `apps/opm/src/commands/auth.ts` is the CLI. For **use** of the
   mapping: when `runOpm` constructs registry/host-fetch options, if you can
   pass token env names **without editing `registry.ts`** (e.g. CLI sets
   `process.env` is forbidden), prefer: command module exports
   `applyAuthConfigToEnvNames()` that returns lists the CLI already has a place
   to pass. **If there is no hook**, A may add a **new function**
   `registryOptionsWithAuthConfig` in `auth-config.ts` that **calls** existing
   `registryOptionsForEcosystem` and appends token env names — without modifying
   `registry.ts`. Host-fetch already reads `OPM_HOST_FETCH_TOKEN_ENVS` as a
   parallel list; `apply` may **return** extra names for the CLI to put into
   that list **for the process of this command only** via an options object, not
   by mutating `process.env`.
6. Look at `apps/opm/src/opm.ts` for where registry options are built. A is
   **not** allowed to edit `opm.ts` except the `case 'auth'` hunk in §5.2.
   Therefore: `commands/auth.ts` handles `auth` subcommands. For add/sync to
   honor the map, **U/R must not be required**. Add `applyAuthConfigToEnvNames`
   and call it from `commands/auth.ts` is not enough for `opm add`. **Allowed
   exception:** A may create `apps/opm/src/auth-hook.ts` and the parent will, in
   the coordinator docs PR, **not** be the one to wire it — A’s `case 'auth'`
   hunk is insufficient for add. **Wire `applyAuthConfigToEnvNames` inside
   `commands/auth.ts` plus export it. Additionally A may edit
   `apps/opm/src/opmx.ts` only if needed — avoid.**  
   **Practical wire that stays exclusive:** implement `readAuthConfig` + a
   function `hostFetchTokenEnvNamesFromAuth(): string[]` that serializes as
   `origin1,env1,origin2,env2` matching `OPM_HOST_FETCH_TOKEN_ENVS` /
   `OPM_HOST_FETCH_ORIGINS` parallel-list format **documented in ADR 0041**.
   Document in `cascadeDeltas` that the CLI dispatcher should call this when
   building host-fetch names. **Parent coordinator must apply a tiny wire in
   `opm.ts` after merge if dynamic-import of `./commands/auth.js` cannot run on
   every command.** Specify: A’s `case 'auth'` hunk **also** inserts at the
   **start** of `runOpm` (after adapters are configured) these exact lines,
   which A owns as part of its hunk:

```ts
const { applyAuthConfigForProcess } = await import('./commands/auth.js');
await applyAuthConfigForProcess();
```

`applyAuthConfigForProcess` must **not** copy secrets into toml. It may set
`OPM_HOST_FETCH_ORIGINS` / `OPM_HOST_FETCH_TOKEN_ENVS` **only by appending
origins already in the auth config that are not already present**, and only env
**names**. It must not override operator-set env that already lists those
origins. It must never `process.env[tokenEnv] = secret`.

7. Tests: round-trip file; refuse HTTP origin; refuse writing secret-shaped
   tokenEnv values if the user passed a value in the JSON somehow; fuzz parser
   on truncated JSON; behavior list/set/unset; 0600 if
   `process.platform !== 'win32'`.

**Acceptance**

- No test writes a bearer token to disk.
- `cascadeDeltas` for opm.md: auth is origin→env name; mint tokens outside opm;
  OIDC/device flow out of scope.

**Stop.** No `opm login`, no device code, no keychain binary, no mTLS files.

---

### Swarm W — WIT honesty (no host runtime)

**Problem.** ADR 0032 says adapters are WIT components. Production is TS
`AdapterModule` + sandboxed executables. Advertising a “WIT host” without
wasmtime is the capability-honesty bug.

**Implement**

1. `spec/wit/README.md`: state clearly that OpenPacker v1 **loads**
   WIT-**shaped** TypeScript modules and delegated native plugins; it does
   **not** load WebAssembly components. The WIT file remains the normative ABI
   **shape**. A wasmtime host is a future initiative.
2. Add `packages/adapter-host/src/wit-contract.test.ts` that:
   - calls existing `assertWitShapedModule` on a minimal fake module (already
     the pattern in adapter-host tests — extend, don’t duplicate poorly)
   - loads `fixtures/protocol/wit-adapter/` JSON service-index documents and
     proves `parseServiceIndex` round-trip
   - proves advertising `prex.registry.search/1` without `catalog` still throws
     `INVALID_ADAPTER` (honesty already in bridge.ts — pin it)
3. Do not add wasmtime, `@bytecodealliance/*`, `jco`, or a `crates/` wasm
   component.
4. Optional: a **comment** on `packages/adapter-host/src/bridge.ts` file header
   is enough; do not rewrite the bridge.

**Acceptance**

- adapter-host tests green.
- `cascadeDeltas` for ADR 0032 “Notes” or a new ADR 0042 sentence: v1 host is
  WIT-shaped TS + sandbox, not component loading.

**Stop.** Any code that `dlopen`s wasm.

---

## 7. Coordinator ADR 0042 (parent writes, after or in parallel as docs)

Parent authors `docs/adr/0042-upm-v1-gaps.md` (Accepted) capturing:

- Maven inspect uses stock POM+checksums; sidecar optional overlay
- PyPI/Go inspect were never sidecar-based; e2e oracles close the honesty gap
- `opm update` ≠ `sync`; no opm workspaces; native workspaces via ADR 0034
- `OPM_STORE_HOME` optional blob CAS; project `.opm/store` remains activation
- PREX publish/yank only; daemon opt-in store
- `opm auth` names env vars; no OIDC/device flow
- WIT host remains TS+sandbox; wasmtime out of v1

Do not wait for implementers to draft this; the decisions are in §2–§3.
Implementers must not write ADRs.

---

## 8. Reviewer subagents

For each implementer worktree/PR, spawn `reviewer` with:

- Exclusive path list from §5
- The swarm’s acceptance bullets
- Order: scope leak (edited forbidden files?) → tests that would fail without
  the change → gates re-run → semantic-loss honesty → secrets on disk → live
  network in tests → ADR 0020/0032/0041 violations (supersession, wasm host,
  credential theater)

Verdict `pass|fail` as in `.claude/agents/reviewer.md`. Parent does not trust
implementer self-report.

---

## 9. Done

The initiative is done when:

1. All eight implementer PRs are squash-merged (or independent PRs merged) with
   reviewer pass.
2. Coordinator docs/ADR/inventory PR merged.
3. `npm run verify` green on `main` locally.
4. `docs/plans/upm-v1-gaps/sdlc-state.md` records residuals **only** if they
   match §3 Refuse (not as “implement WIT host next in this file as if it were
   forgotten”).

If a swarm cannot finish without breaking exclusive ownership, it stops and
reports `requirementChanges` — it does **not** edit a sibling’s files.

---

## 10. Implementer prompt prefix (paste above each swarm contract)

```
You are an OpenPacker implementer subagent. Isolated worktree, one swarm, exclusive
paths only. Red tests first. Incremental conventional commits. Never skip hooks.
Never touch coordinator files, skills, workflows, or another swarm’s paths.
Rebuild workspace dist after source changes before consumer tests.
Offline fail-closed fixtures only. Schema-first if you touch spec/prex/v1.
Hand back .sdlc/report.json. Read AGENTS.md in the repo. Native bytes canonical.
No Epoch/ATProto. Capture ≠ solve. ADR 0020/0022/0032/0034/0041 bind you.
```

Then paste §4, the swarm’s exclusive paths, and the swarm subsection.
