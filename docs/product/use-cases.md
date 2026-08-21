# OpenPacker use cases

Each use case states the **problem**, the **PREX/OpenPacker path**, the **claim
strength** of the result, and a **working entry point** in this repository.
OpenPacker is a control plane: it pins and proves package graphs; it does not
replace native installers.

## UC-1 — Pin a native lock without re-solving

**Problem.** CI already trusts `package-lock.json`, `Cargo.lock`, `uv.lock`,
`go.sum`, or `gradle.lockfile`. You need a portable, digest-addressed pin and
audit receipt without claiming OpenPacker independently solved the graph.

**Path.**

1. `import-lock` (CLI, SDK, or `@openpacker/lock-import`)
2. Profile fixed to `native-capture-v1`
3. Emit `openpacker.lock.json` + unsigned/signed receipt
4. Store digests; optional `verify` for signatures later

**Claim.** Capture only. Semantic loss includes `NATIVE_RESULT_CAPTURE_ONLY`,
which blocks advertising `prex-calculus-subset-v1` for the same result.

**Working demos.**

```sh
npm run demo:lock-import
npm run test --workspace @openpacker/example-lock-import
npx openpacker import-lock --input fixtures/locks/npm/package-lock.json --json
```

**Formats.** package-lock v3, Cargo.lock, NuGet project.assets /
packages.lock.json, uv.lock (native TOML or JSON projection), go.sum,
gradle.lockfile.

## UC-2 — Cross-ecosystem deterministic solve

**Problem.** A deliverable spans npm, Cargo, and NuGet (or other codecs) and
must produce the same solution digests on every machine from the same universe
snapshot.

**Path.**

1. Acquire/import immutable catalog snapshots (`catalog import` / providers)
2. `normalize` requirements and targets
3. `solve` with `semantics.profile = "prex-calculus-subset-v1"`
4. Independent proof check (daemon/embedded always run the checker)
5. `export lock` / `receipt` / optional `verify` / `materialize`

**Claim.** Independent solve over the documented IR subset, with structured
`SemanticLoss` for native meaning that cannot be represented.

**Working demos.**

```sh
npm run demo
# fixture solve input:
# fixtures/protocol/solve/request.json
# fixtures/epoch/universe.json
```

## UC-3 — Air-gapped / offline CI gate

**Problem.** Build agents cannot reach public registries but must still check
resolution digests and artifact integrity.

**Path.**

1. Pre-import snapshots and native archives into the CAS
2. Run daemon with `--offline` clients and loopback URL
3. Use committed fixtures under `fixtures/` for conformance
4. Fail closed on digest mismatch

**Claim.** Same as the profile used; offline never invents success for missing
evidence (`not-provided` stays distinct from `valid`).

**Working demos.**

```sh
npm run verify          # full offline aggregate
npm run test:conformance
npm run demo            # no public-registry traffic after prerequisites
```

## UC-4 — Tool install via mise

**Problem.** Operators want mise to install a verified tool binary into an
isolated prefix without running package lifecycle scripts.

**Path.**

1. mise backend lists versions via PREX `enumerate`
2. Install calls PREX `materialize` for an exact PURL
3. Backend verifies digests and declared executables only
4. Exec env exposes directories that contain those executables

**Claim.** Materialization safety + digest checks; not a full language package
install.

**Working demos.**

```sh
npm run demo            # includes isolated mise install path
# docs: docs/integrations/mise.md
# code: integrations/mise/
```

## UC-5 — Consumer SDK with exact bytes

**Problem.** A downstream system (CI, Epoch-like history store, policy service)
must persist the **exact** receipt or response bytes, not a re-serialized
approximation.

**Path.**

1. Discover `/.well-known/prex` or `/v1/capabilities`
2. Call PREX ops through `@openpacker/sdk`
3. Store `rawBytes` from each successful call
4. Verify digests offline later with embedded or service `verify`

**Claim.** Transport-neutral canonical objects; digests match when inputs match.

**Working demos.**

```sh
npm run test --workspace @openpacker/example-basic-client
npm run test --workspace @openpacker/example-epoch-consumer
# docs: docs/integrations/epoch.md
```

## UC-6 — Pure embedded resolve in process or browser

**Problem.** You already have a complete `ResolutionUniverse` snapshot and need
solve + proof without HTTP or Node-only deps.

**Path.**

1. Load native or WASM bindings via `@openpacker/embedded`
2. `validateUniverse` → `solve` → `check`
3. Optionally compare bounded fixtures with the brute-force oracle

**Claim.** Identical unsigned digests to service mode for the same inputs.

**Working demos.**

```sh
npm run test --workspace @openpacker/example-embedded-resolver
npm run test:browser    # WASM browser path
```

## UC-7 — Compliance and alternate implementations

**Problem.** A second PREX server or client must prove interoperability without
importing OpenPacker internals.

**Path.**

1. Implement against `spec/prex/v1` schemas and OpenAPI
2. Advertise only earned `PREX-*` levels
3. Run shared vectors from `fixtures/protocol` and `@openpacker/conformance`
4. Keep OpenPacker extension routes (`/v1/openpacker/*`) optional

**Claim.** Conformance is capability-scoped; schema-only is not enough.

**Working demos.**

```sh
npm run test:conformance
# docs: docs/product/compliance.md
# normative: spec/prex/v1/conformance.md
```

## UC-8 — New ecosystem adapter

**Problem.** You need PyPI/Go/Maven-like coverage for another ecosystem without
forking the solver.

**Path.**

1. Implement pure `EcosystemCodec`
2. Optional `CatalogProvider` with offline fixture replay
3. Optional lock-format handler for `import-lock`
4. Wire codec into daemon capabilities; pass `checkEcosystemCodec` probes

**Claim.** Native fidelity with honest `SemanticLoss`; no silent flattening.

**Working demos.**

```sh
npm run test --workspace @openpacker/adapter-pypi
npm run test --workspace @openpacker/adapter-golang
npm run test --workspace @openpacker/adapter-maven
# docs: docs/integrations/ecosystem-codec-authoring.md
```

## Non-goals (not OpenPacker use cases)

| Non-goal                                           | Prefer                                       |
| -------------------------------------------------- | -------------------------------------------- |
| Drop-in `npm install` / `pip install` CLI          | Native PM or a thin façade outside PREX core |
| Hosting a multi-tenant registry UI                 | Nexus/Harbor/Artifactory                     |
| Rewriting native tarballs into a universal archive | Preserve native bytes; OCI transports them   |
| Social identity, forge, or ATProto                 | Downstream systems (e.g. Epoch)              |
| Automatic lifecycle script execution               | Explicitly forbidden in materialization      |

## Choosing a path

```text
Need to pin what native already chose?     → UC-1 import-lock
Need cross-ecosystem independent solve?  → UC-2 solve + proof
Need offline CI?                         → UC-3 fixtures + verify
Need tool binary install?                → UC-4 mise
Need durable receipts for another system?→ UC-5 SDK rawBytes
Need in-process/browser solve?           → UC-6 embedded
Building another PREX client/server?     → UC-7 compliance
Adding an ecosystem?                     → UC-8 codec + provider
```
