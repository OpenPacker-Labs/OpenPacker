# OpenPacker

**Reference implementation of PREX (Package Resolution Exchange)** — a
transport-neutral protocol for package identity, constraints, resolution,
proofs, receipts, and immutable artifacts across ecosystems.

OpenPacker is a **package control plane**, not a drop-in replacement for npm,
pip, Cargo, NuGet, or other native package managers. PREX normalizes and proves;
native managers remain authoritative for install, build, and runtime scripts.
OCI/ORAS move **unchanged** native bytes; OCM describes composition; tools such
as mise integrate install prefixes while PREX pins digests.

|                  |                                                                  |
| ---------------- | ---------------------------------------------------------------- |
| **Protocol**     | [`spec/prex/v1/`](spec/prex/v1/) (schemas, OpenAPI, conformance) |
| **License**      | [MIT](LICENSE)                                                   |
| **Docs map**     | [`docs/README.md`](docs/README.md)                               |
| **Quality gate** | `npm run verify` (offline, fail-closed)                          |

## Why this exists

Package ecosystems already solve hard problems (install layouts, build graphs,
language-specific ranges). What they do not share is a **neutral control plane**
for:

- stable identity (PURL) and constraints (VERS) with honest loss reporting;
- deterministic solving with **independent proof checking**;
- content-addressed receipts and portable lockfiles;
- cross-ecosystem composition without rewriting native archives.

OpenPacker implements that plane and ships the suites that keep it honest.

## Use cases (short)

| ID   | Goal                                        | Start here                                                 |
| ---- | ------------------------------------------- | ---------------------------------------------------------- |
| UC-1 | Pin a native lock without re-solving        | `npm run demo:lock-import`                                 |
| UC-2 | Cross-ecosystem deterministic solve + proof | `npm run demo`                                             |
| UC-3 | Air-gapped CI gates                         | `npm run verify`                                           |
| UC-4 | Verified tool install via mise              | `docs/integrations/mise.md`                                |
| UC-5 | Downstream consumer of exact receipt bytes  | `examples/basic-client`, `examples/epoch-consumer`         |
| UC-6 | In-process / WASM solve                     | `examples/embedded-resolver`                               |
| UC-7 | Third-party PREX client/server compliance   | [`docs/product/compliance.md`](docs/product/compliance.md) |
| UC-8 | New ecosystem codec                         | `packages/adapter-pypi` (template)                         |

Full narratives: **[`docs/product/use-cases.md`](docs/product/use-cases.md)**.

## Quick start

### Prerequisites

Node `^22.13.0 || >=24`, npm 11, stable Rust. For the full demo also
wasm-bindgen-cli `0.2.126`, Playwright Chromium, and mise `2026.7.13`.

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
# optional for full demo / browser:
npm exec playwright install chromium
```

### Offline demos (no public registries)

```sh
# Cross-ecosystem solve, OCI pack, trust, materialize, mise
npm run demo

# Six native freeze formats → openpacker.lock.json under native-capture-v1
npm run demo:lock-import
```

### Full reference gate

```sh
npm run verify
```

### First CLI calls

```sh
npm run build

# Normalize identity
printf '%s\n' '{"items":[{"type":"purl","value":"pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0"}]}' \
  > /tmp/normalize.json
npx openpacker normalize --input /tmp/normalize.json --json

# Offline lock import library path (no daemon)
node scripts/demo-lock-import.mjs
```

### First SDK call

```ts
import { OpenPackerClient } from '@openpacker/sdk';

const client = new OpenPackerClient({ baseUrl: 'http://127.0.0.1:7337' });
const { data: caps } = await client.capabilities();
const { data, rawBytes } = await client.normalize({
  items: [{ type: 'purl', value: 'pkg:npm/%40openpacker/demo-tool@1.0.0' }],
});
// Prefer rawBytes when persisting protocol objects for later verification.
```

Runnable samples: **[`examples/README.md`](examples/README.md)**.

## Specification and compliance

PREX is defined under [`spec/prex/v1/`](spec/prex/v1/):

| Artifact                          | Role                                        |
| --------------------------------- | ------------------------------------------- |
| `schemas/*.schema.json`           | Normative request/response and model shapes |
| `openapi.yaml`                    | HTTP surface                                |
| `asyncapi.yaml`                   | Event contracts                             |
| `conformance.md` / `semantics.md` | Levels and profiles                         |
| `fixtures/protocol/`              | Positive/negative vectors                   |

**API/CLI compliance checklist** (wire contracts, PREX levels, profiles,
extensions, reference parity):

→ **[`docs/product/compliance.md`](docs/product/compliance.md)**

Capability levels: `PREX-N` (normalize) … `PREX-C` (events). Advertise a level
only when its vectors pass. OpenPacker extension routes under `/v1/openpacker/*`
(catalog, **lock import**, pack, publish, lifecycle) are **not** PREX levels.

| Semantics profile         | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `native-capture-v1`       | Record native selections; no independent solve claim         |
| `native-validated-v1`     | Check representable edges; report unvalidated native meaning |
| `prex-calculus-subset-v1` | Independent solve over the documented IR subset              |

## Reference implementation map

| Component                     | Location                                               |
| ----------------------------- | ------------------------------------------------------ |
| HTTP service                  | `apps/openpackerd`                                     |
| CLI                           | `apps/openpacker-cli`                                  |
| SDK                           | `packages/sdk`                                         |
| Embedded native/WASM          | `packages/embedded`, `crates/openpacker-wasm`          |
| Pure resolver + proof checker | `crates/openpacker-resolver`                           |
| Lock import                   | `packages/lock-import`                                 |
| Ecosystems                    | `packages/adapter-{npm,cargo,nuget,pypi,golang,maven}` |
| Conformance harness           | `packages/conformance`                                 |
| mise backend                  | `integrations/mise`                                    |

Details:
**[`docs/product/reference-implementation.md`](docs/product/reference-implementation.md)**.

### Supported lock import formats

| Format                                   | Ecosystem | Fixture                  |
| ---------------------------------------- | --------- | ------------------------ |
| package-lock v3                          | npm       | `fixtures/locks/npm/`    |
| Cargo.lock                               | cargo     | `fixtures/locks/cargo/`  |
| project.assets.json / packages.lock.json | nuget     | `fixtures/locks/nuget/`  |
| uv.lock (JSON projection)                | pypi      | `fixtures/locks/pypi/`   |
| go.sum                                   | golang    | `fixtures/locks/golang/` |
| gradle.lockfile                          | maven     | `fixtures/locks/maven/`  |

```sh
npx openpacker import-lock --input fixtures/locks/cargo/Cargo.lock --json
# HTTP: POST /v1/openpacker/lock/import
```

## Documentation

| Guide                                                                | Description                      |
| -------------------------------------------------------------------- | -------------------------------- |
| [Getting started](docs/guides/getting-started.md)                    | Install, demos, first commands   |
| [Use cases](docs/product/use-cases.md)                               | Full UC-1…UC-8                   |
| [User surface](docs/product/user-surface.md)                         | CLI/API catalogue                |
| [Compliance](docs/product/compliance.md)                             | Standards for API/CLI compliance |
| [Reference implementation](docs/product/reference-implementation.md) | Repo map and demo matrix         |
| [Leverage guide](docs/product/leverage-guide.md)                     | Reuse vs build; Nexus/mise/Epoch |
| [Architecture](docs/architecture.md)                                 | Layers and data flow             |
| [Protocol docs](docs/protocol/README.md)                             | Operations, IR, proofs, receipts |
| [Examples](examples/README.md)                                       | Working samples                  |
| [ADRs](docs/adr/README.md)                                           | Architecture decisions           |
| [Doc index](docs/README.md)                                          | Full map                         |

## Development

```sh
npm ci
npm run verify
```

`npm run verify` runs formatting, schema/generated freshness, licenses, lint,
typecheck, build, unit tests, coverage, conformance, security, integration, e2e,
compat, browser, Rust, both demos, benchmarks, goldens, and fuzz smoke. Live
registry tests are opt-in and never substitute for offline gates.

Contribution rules: [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/operations/contributing-releasing.md`](docs/operations/contributing-releasing.md).

## Protocol boundary

- **Names and locations** locate mutable histories; **digests** identify bytes.
- **Native archives remain canonical**; OCI transports them.
- **Resolution ≠ materialization ≠ policy**: separate operations and trust
  roles.
- **No production dependency** on Epoch, ATProto, or social/forge stacks.

Product framing ADRs:
[0020 control plane](docs/adr/0020-control-plane-not-supersession.md),
[0021 lock import](docs/adr/0021-native-lock-import.md).
