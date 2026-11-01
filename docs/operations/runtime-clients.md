# Daemon, SDK, embedded API, and CLI

## Reference daemon

`openpackerd` is a Fastify HTTP binding over a supplied `PrexOperations`
implementation. It exposes discovery, all PREX routes, OpenPacker extension
routes, a SQLite receipt/snapshot index and event outbox, request limits,
correlation/trace propagation, cancellation, health/readiness, and graceful
close. Core resolution remains available without the daemon.

The shipped reference operation set advertises `native-capture-v1`,
`native-validated-v1`, and `prex-calculus-subset-v1`. Native profiles consume
the exact node IDs or exact PURLs supplied in `environment.locked`; capture mode
preserves that result without claiming validation, while validated mode checks
the representable PREX constraints. Verification checks are selected by
`VerifyRequest.checks`; receipt and artifact checks are built in, while TUF,
Sigstore, SLSA, CycloneDX, lifecycle, policy, OCI, and OCM checks require their
configured verifier. Missing evidence remains `not-provided`. The
`GET /v1/capabilities` response derives `evidenceTypes` from the verifiers,
receipt keys, and artifact source actually configured — an unconfigured
standalone daemon advertises an empty evidence list and `none` authentication,
because it performs no request authentication.

The CLI `serve` command requires an operations module exporting `operations` or
a default `PrexOperations`. Supported runtime options are `--operations-module`,
`--database`, `--host`, and `--port`. The defaults are
`.openpacker/openpackerd.sqlite`, `127.0.0.1`, and `7337`. Bind beyond loopback
only behind transport authentication, TLS termination, and an explicit network
policy.

## TypeScript SDK

`@openpacker/sdk` uses caller/runtime standard `fetch`. `OpenPackerClient`
accepts base URL, fetch implementation, static headers, an authentication
callback, retries, timeout, and user agent. Per-call options add abort signal,
headers, timeout, correlation ID, W3C `traceparent`/`tracestate`, and
idempotency key.

Methods cover discovery, capabilities, health, readiness, normalize, identify,
enumerate, inspect, solve, materialize, verify, explain, receipt/snapshot
retrieval, events, catalog import/snapshot, **lock import**, lifecycle, pack,
and publish. Each successful call returns parsed `data`, exact `rawBytes`, and
the original `Response`. `PrexClientError` preserves status, parsed RFC 9457
problem when available, raw bytes, and response. The package publishes
ESM/CommonJS and a browser-safe entry; the executable SDK usage is
[`packages/sdk/test/sdk.test.ts`](../../packages/sdk/test/sdk.test.ts) and
[`examples/basic-client`](../../examples/basic-client).

```ts
import { readFile } from 'node:fs/promises';
import { OpenPackerClient } from '@openpacker/sdk';

const client = new OpenPackerClient({ baseUrl: 'http://127.0.0.1:7337' });
const { data, rawBytes } = await client.normalize({
  items: [{ type: 'purl', value: 'pkg:npm/%40openpacker/demo-tool@1.0.0' }],
});
if (data.results[0]?.canonical !== 'pkg:npm/%40openpacker/demo-tool@1.0.0')
  throw new Error('unexpected normalized identity');
console.log(rawBytes.byteLength);

// Extension: native lock capture (not a PREX core level)
const cargoLockText = await readFile('fixtures/locks/cargo/Cargo.lock', 'utf8');
const imported = await client.lockImport({
  lockfile: cargoLockText,
  format: 'cargo-lock',
});
console.log(imported.data.solveResponse.normalizedRequest.semantics.profile);
```

Use `rawBytes` when persisting receipts or other canonical response bodies.
Re-serializing `data` is unnecessary and can discard the transport evidence the
consumer intended to retain.

## Embedded native and WASM

`@openpacker/embedded` wraps the engine-neutral native/WASM binding. It exposes
PURL normalization, VERS parsing and membership, universe validation, solve,
independent proof check, brute-force oracle, canonicalization/digesting,
artifact SHA-256 verification, and receipt-digest verification. Inputs are
serialized snapshots; embedded code does no registry access.

`createEmbeddedResolver` wraps already-loaded native or WASM exports.
`loadEmbeddedResolver` asynchronously imports and initializes the wasm-bindgen
module for Node or modern browsers. Service and embedded modes share PREX
contracts; changing modes does not change canonical request, universe, solution,
or unsigned-receipt semantics.

Node applications load the maintained Node-API artifact from the explicit
subpath; browsers load the asynchronous web WASM subpath:

```ts
import { loadNativeEmbeddedResolver } from '@openpacker/embedded/native';

const resolver = await loadNativeEmbeddedResolver();
const result = resolver.solve({ request, universe });
const check = resolver.check({ request, universe }, result);
if (!check.valid) throw new Error(check.diagnostics.join('; '));
```

The equivalent WASM loaders and cross-runtime digest assertions are exercised by
[`tests/compat/native-node.test.mjs`](../../tests/compat/native-node.test.mjs)
and [`tests/compat/wasm-node.test.mjs`](../../tests/compat/wasm-node.test.mjs).

## CLI

**Cookbook with full package-management recipes:**
**[docs/guides/opm.md](../guides/opm.md#prex-control-plane)** (normalize,
identify, enumerate, import-lock, solve, export, verify, materialize). Sample
inputs: [`examples/cli/`](../../examples/cli/).

The CLI accepts JSON from `--input <file|->`, emits canonical JSON with
`--json`, writes exact output bytes with `--output`, and supports `--target`,
`--policy-file`, `--evaluation-time`, `--timeout`, `--idempotency-key`,
`--base-url`, and secret `--auth-token-file`. `--offline` permits only loopback
service URLs and rejects publish.

| Group                     | Commands                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| PREX                      | `normalize`, `identify`, `enumerate`, `inspect`, `solve`, `resolve`, `explain`, `materialize`, `verify` |
| Lock import               | `import-lock` (OpenPacker extension; `native-capture-v1`)                                               |
| Artifact                  | `pack`, `publish`                                                                                       |
| Receipt/catalog/lifecycle | `receipt inspect`, `receipt verify`, `catalog import`, `catalog snapshot`, `lifecycle apply`            |
| Export                    | `export lock`, `export sbom`                                                                            |
| Runtime                   | `serve`, `demo`                                                                                         |

| Exit | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 2    | Usage                                                                  |
| 3    | Invalid local input                                                    |
| 4    | Package/version/snapshot/artifact not found                            |
| 5    | Unsatisfiable                                                          |
| 6    | Policy, lifecycle, or semantic-loss denial                             |
| 7    | Digest, size, signature, provenance, or freshness verification failure |
| 8    | Retryable/unavailable service                                          |
| 9    | Internal/unclassified failure                                          |

`verify` maps the service decision to these codes: `allow` → `0`, `deny` → `7`
(`6` when the denial includes `policy-denied` evidence), `indeterminate` → `8`.

Human output recursively redacts keys that look like authorization, password,
secret, token, or credential data. JSON errors contain the stable exit code and
available Problem Details.

The shortest service-client example is compile-checked at
[`examples/basic-client/src/index.ts`](../../examples/basic-client/src/index.ts).
For command-line automation, pass complete schema-shaped input and consume only
JSON on stdout:

```sh
openpacker solve --input fixtures/protocol/solve/request.json --output .demo-output/solve-response.json --offline --json
openpacker receipt verify --input .demo-output/receipt.json --offline --json
openpacker export lock --input .demo-output/solve-response.json --output openpacker.lock.json --json
openpacker import-lock --input fixtures/locks/cargo/Cargo.lock --format cargo-lock --json
```

`--offline` constrains the client to a loopback service; it does not make a
remote daemon offline. The daemon itself must be configured with captured
snapshots and immutable artifact sources.

CLI/API compliance obligations for third-party tools are listed in
[Compliance](../product/compliance.md). End-to-end workflows are in
[Use cases](../product/use-cases.md) and
[Getting started](../guides/getting-started.md).

## Executable entry points

`npm run demo` builds and runs the full offline workflow, then indexes
`.demo-output`. `npm run verify` runs all mandatory non-live gates. Individual
CLI command shapes and exit behavior are exercised by
[`apps/openpacker-cli/test/cli.test.ts`](../../apps/openpacker-cli/test/cli.test.ts);
the production-path demo is exercised by
[`tests/e2e/demo.test.mjs`](../../tests/e2e/demo.test.mjs).
