# Getting started with OpenPacker

**Day-to-day package CLI recipes:** **[cli.md](cli.md)** (start there if you
want commands, not setup theory).

This page is install + first run. All mandatory steps are **offline** after
one-time toolchain install.

## What you get

- **PREX** — vendor-neutral package resolution protocol (`spec/prex/v1`)
- **OpenPacker** — reference daemon, CLI, SDK, pure resolver (native + WASM),
  ecosystem adapters, lock import, demos, and conformance suite

OpenPacker is a **package control plane**. It normalizes identity, solves or
captures graphs, proves results, and pins digests. It does **not** replace npm,
pip, Cargo, or NuGet install semantics. See
[ADR 0020](../adr/0020-control-plane-not-supersession.md).

## Prerequisites

| Tool                | Notes                                                  |
| ------------------- | ------------------------------------------------------ |
| Node.js             | `^22.19.0 \|\| >=24` (demos target Node 24)            |
| npm                 | 11.x with the committed lockfile (`npm ci`)            |
| Rust                | Stable toolchain (2024 edition workspace)              |
| wasm-bindgen-cli    | Pinned `0.2.126`; WASM bindings only (see below)       |
| mise                | `2026.7.13` only for the full `npm run demo` mise path |
| Playwright Chromium | Only for browser gates and full demo                   |

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
# Optional for full demo / browser tests:
npm exec playwright install chromium
```

The wasm target and `wasm-bindgen-cli` build only the WASM bindings
(`@openpacker/embedded/wasm-node` and `/wasm-web`). The CLIs do not load them,
so on a machine without them `npm run build` skips that one step with a warning
and still builds everything else; dependents compile against declaration-only
stubs. `CI` and `OPENPACKER_REQUIRE_WASM=1` turn the same condition into an
error, so a pipeline cannot ship without the bindings. See
[Troubleshooting](opm.md#troubleshooting).

## Fastest offline proofs

### 1. Full reference demo

Builds packages, starts the local service path, solves a cross-ecosystem fixture
graph, packs OCI, verifies trust, materializes a tool, and writes
`.demo-output/`.

```sh
npm run demo
```

### 2. Native lock import demo

Imports six native freeze formats under `native-capture-v1` with no registry
network and no daemon:

```sh
npm run demo:lock-import
# → .demo-output/lock-import/*.openpacker.lock.json
# → .demo-output/lock-import/summary.json
```

### 3. Fail-closed aggregate

```sh
npm run verify
```

Includes format, contracts, TypeScript, Rust, conformance, security,
integration, e2e, browser, fuzz, benchmarks, and both demos.

## Run the reference service

```sh
# After npm run build
npx openpacker serve --host 127.0.0.1 --port 7337
# or with a committed universe fixture:
npx openpacker serve --universe fixtures/epoch/universe.json --port 7337
```

Discovery:

```sh
curl -sS http://127.0.0.1:7337/.well-known/prex | head
curl -sS http://127.0.0.1:7337/v1/capabilities | head
curl -sS http://127.0.0.1:7337/v1/health
```

## CLI recipes (working against fixtures)

Commands accept schema-shaped JSON via `--input`, emit pretty JSON by default,
canonical JSON with `--json`, and exact bytes with `--output`.

### Normalize a PURL

```sh
printf '%s\n' '{
  "items": [
    { "type": "purl", "value": "pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0" }
  ]
}' > /tmp/normalize.json

npx openpacker normalize --input /tmp/normalize.json --json
```

### Import a native lockfile (daemon required)

```sh
npx openpacker serve --port 7337 &
# wait for ready, then:
npx openpacker import-lock \
  --input fixtures/locks/cargo/Cargo.lock \
  --format cargo-lock \
  --base-url http://127.0.0.1:7337 \
  --json \
  --output .demo-output/cargo-import.json
```

The response always uses `semantics.profile = "native-capture-v1"` and includes
`NATIVE_RESULT_CAPTURE_ONLY` semantic loss. It does **not** claim an independent
cross-ecosystem solve.

### Offline lock import without HTTP

Use the library path (same code as `npm run demo:lock-import`):

```sh
node scripts/demo-lock-import.mjs
```

Or the compile-checked example package:

```sh
npm run test --workspace @openpacker/example-lock-import
```

## SDK recipe

```ts
import { OpenPackerClient } from '@openpacker/sdk';

const client = new OpenPackerClient({ baseUrl: 'http://127.0.0.1:7337' });

const { data: capabilities } = await client.capabilities();
if (!capabilities.protocolVersions.includes('1.0-draft'))
  throw new Error('unsupported PREX version');

const { data, rawBytes } = await client.normalize({
  items: [{ type: 'purl', value: 'pkg:npm/%40openpacker/demo-tool@1.0.0' }],
});

// Persist rawBytes when you need the exact transport payload.
console.log(data.results[0]?.canonical, rawBytes.byteLength);
```

See [`examples/basic-client`](../../examples/basic-client) for a tested
discover-then-call pattern.

## Embedded resolver recipe

For pure offline solve + independent proof (no network, no daemon):

```ts
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import type { EmbeddedSolveInput } from '@openpacker/embedded';

const resolver = createEmbeddedResolver(bindings);
const input = /* { request, universe } from fixtures */ as EmbeddedSolveInput;
resolver.validateUniverse(input.universe);
const output = resolver.solve(input);
const check = resolver.check(input, output);
if (!check.valid) throw new Error(check.diagnostics.join('; '));
```

See [`examples/embedded-resolver`](../../examples/embedded-resolver) and
[`tests/fixtures/bounded-solve.json`](../../tests/fixtures/bounded-solve.json).

## Next reading

| Goal                                  | Document                                                           |
| ------------------------------------- | ------------------------------------------------------------------ |
| Which workflow fits my team           | [Use cases](../product/use-cases.md)                               |
| Command and HTTP catalogue            | [User surface](../product/user-surface.md)                         |
| Comply as a third-party client/server | [Compliance](../product/compliance.md)                             |
| Map the monorepo                      | [Reference implementation](../product/reference-implementation.md) |
| Normative contracts                   | [`spec/prex/v1/`](../../spec/prex/v1/)                             |
| All runnable samples                  | [Examples](../../examples/README.md)                               |
