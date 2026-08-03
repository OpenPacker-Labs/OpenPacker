# OpenPacker reference implementation

This repository **is** the PREX reference implementation: normative contracts
plus an executable stack that implements them end-to-end. Use this page as a map
of what ships and how demos prove it.

## Split of ownership

| Name                        | Owns                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **PREX**                    | Protocol version, JSON Schemas, OpenAPI/AsyncAPI, media types, errors, semantics profiles, conformance levels and vectors   |
| **OpenPacker**              | Daemon, CLI, SDK, pure resolver (Rust/WASM/native), adapters, lock import, materializer, trust tooling, test harness, demos |
| **Downstream** (e.g. Epoch) | History, identity, federation, product UX — consumes public contracts only                                                  |

## Repository layout

```text
spec/prex/v1/          Normative PREX 1.0-draft
apps/
  openpackerd/         HTTP reference service (Fastify)
  openpacker-cli/      CLI: PREX ops + extensions + serve/demo
packages/
  contracts/           Generated TS types + schema copies
  sdk/                 HTTP client (ESM/CJS/browser)
  embedded/            Native + WASM embedded API
  lock-import/         Native lock → capture solve plan
  adapter-*/           Ecosystem codecs + providers
  catalog/ receipts/ trust/ oci/ ocm/ materializer/ ...
crates/
  openpacker-resolver/ Pure deterministic solver + checker
  openpacker-wasm/     WASM/native bindings
integrations/mise/     mise backend plugin
examples/              Compile-checked usage samples
fixtures/              Offline catalogs, locks, protocol vectors, goldens
tests/                 Gates: unit, conformance, security, e2e, browser, ...
docs/                  Human documentation (this tree)
scripts/demo*.mjs      Offline demonstration workflows
```

## Runtime modes

| Mode                | Entry                                        | Network during solve?                  |
| ------------------- | -------------------------------------------- | -------------------------------------- |
| Service             | `openpackerd` / `openpacker serve`           | No (catalog acquisition is separate)   |
| Embedded native     | `@openpacker/embedded/native`                | No                                     |
| Embedded WASM       | `@openpacker/embedded` / wasm-node / browser | No                                     |
| CLI                 | `@openpacker/cli` → HTTP or local transforms | Depends on command; solve hits service |
| Library lock import | `@openpacker/lock-import`                    | No                                     |

Service and embedded modes must emit identical digests for identical inputs
([ADR 0016](../adr/0016-service-and-embedded.md)).

## Shipped ecosystems

| Ecosystem  | Codec package                | Primary lock format for import           |
| ---------- | ---------------------------- | ---------------------------------------- |
| npm        | `@openpacker/adapter-npm`    | package-lock v3                          |
| Cargo      | `@openpacker/adapter-cargo`  | Cargo.lock                               |
| NuGet      | `@openpacker/adapter-nuget`  | project.assets.json / packages.lock.json |
| PyPI       | `@openpacker/adapter-pypi`   | uv.lock (JSON projection)                |
| Go modules | `@openpacker/adapter-golang` | go.sum                                   |
| Maven      | `@openpacker/adapter-maven`  | gradle.lockfile                          |

Optional enrichment providers: deps.dev, Sonatype (not identity authorities).

## Demonstration matrix

| Demo                  | Command                                      | Proves                                                                                               |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Full offline workflow | `npm run demo`                               | Catalog import, cross-ecosystem solve, proof, OCI pack, trust, materialize, mise, multi-mode digests |
| Lock import           | `npm run demo:lock-import`                   | Six native freeze formats → capture locks under `native-capture-v1`                                  |
| Conformance           | `npm run test:conformance`                   | PREX capability vectors                                                                              |
| Goldens               | `npm run golden:check`                       | Digest-pinned protocol objects                                                                       |
| Examples              | `npm test --workspace @openpacker/example-*` | SDK, embedded, lock-import, Epoch consumer patterns                                                  |
| Aggregate             | `npm run verify`                             | Fail-closed gate for the whole reference                                                             |

## How to use the reference as a product dependency

### As an HTTP PREX server

1. Build: `npm run build`
2. Serve with a universe module or fixture:
   `npx openpacker serve --universe fixtures/epoch/universe.json`
3. Point `@openpacker/sdk` or any PREX client at the base URL
4. Prefer `--offline` clients against loopback for CI

### As a library

| Need                | Package                   |
| ------------------- | ------------------------- |
| HTTP client         | `@openpacker/sdk`         |
| In-process solve    | `@openpacker/embedded`    |
| Native lock capture | `@openpacker/lock-import` |
| Schema types        | `@openpacker/contracts`   |
| Canonical digests   | `@openpacker/canonical`   |
| Conformance harness | `@openpacker/conformance` |

Examples under [`examples/`](../../examples/README.md) are the supported “copy
this pattern” surfaces.

### As a compliance oracle

Run OpenPacker gates against the same fixtures your implementation claims.
Compare digests with `fixtures/golden/` and protocol vectors. Do not treat
OpenPacker’s private modules as protocol surface — only `spec/prex/v1` and
advertised HTTP/embedded contracts are normative.

## Operator checklist

1. Read [Getting started](../guides/getting-started.md)
2. Pick a [use case](use-cases.md)
3. Run the matching demo from the matrix above
4. Integrate via SDK/CLI using [user surface](user-surface.md)
5. If building another stack, follow [compliance](compliance.md)
6. Before shipping changes here, run `npm run verify`

## Versioning note

Protocol version advertised today: **`1.0-draft`**. Breaking contract changes
start in `spec/prex/v1` and update generated consumers in the same change
([contributing](../operations/contributing-releasing.md)).
