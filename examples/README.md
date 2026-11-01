# OpenPacker examples

**Package manager (start here):**  
**[docs/guides/opm.md](../docs/guides/opm.md)** ·
**[opm-project/](opm-project/)**

**PREX control-plane CLI:**  
**[docs/guides/opm.md](../docs/guides/opm.md#prex-control-plane)** ·
**[cli/](cli/)** sample inputs

Library packages below are compile-checked and tested offline.

## Catalogue

| Package                                 | Path                                       | Demonstrates                                                                                     | Run                                                              |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| _(opm project)_                         | [`opm-project/`](opm-project/)             | `opm sync` / `opmx` offline package manager demo                                                 | see `opm-project/README.md`                                      |
| _(CLI inputs)_                          | [`cli/`](cli/)                             | Copy-paste `openpacker` commands + JSON                                                          | see `cli/README.md`                                              |
| `@openpacker/example-basic-client`      | [`basic-client/`](basic-client/)           | SDK discover → normalize; keep `rawBytes`                                                        | `npm run test --workspace @openpacker/example-basic-client`      |
| `@openpacker/example-embedded-resolver` | [`embedded-resolver/`](embedded-resolver/) | Pure in-process solve, independent proof check, bounded oracle                                   | `npm run test --workspace @openpacker/example-embedded-resolver` |
| `@openpacker/example-lock-import`       | [`lock-import/`](lock-import/)             | Offline native lock → `native-capture-v1` solve plan + lockfile digests                          | `npm run test --workspace @openpacker/example-lock-import`       |
| `@openpacker/example-epoch-consumer`    | [`epoch-consumer/`](epoch-consumer/)       | Downstream consumer boundary: receipts, events, pacts; no Epoch production dep inside OpenPacker | `npm run test --workspace @openpacker/example-epoch-consumer`    |

## Mapping to use cases

| Use case                                                                                             | Example                                                          |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [UC-1 pin native lock](../docs/product/use-cases.md#uc-1--pin-a-native-lock-without-re-solving)      | `lock-import`                                                    |
| [UC-2 cross-ecosystem solve](../docs/product/use-cases.md#uc-2--cross-ecosystem-deterministic-solve) | Full `npm run demo` (repo root); fixtures in `fixtures/protocol` |
| [UC-5 SDK exact bytes](../docs/product/use-cases.md#uc-5--consumer-sdk-with-exact-bytes)             | `basic-client`, `epoch-consumer`                                 |
| [UC-6 embedded](../docs/product/use-cases.md#uc-6--pure-embedded-resolve-in-process-or-browser)      | `embedded-resolver`                                              |

## Minimal copy-paste patterns

### HTTP client

```ts
import { OpenPackerClient } from '@openpacker/sdk';

const client = new OpenPackerClient({ baseUrl: 'http://127.0.0.1:7337' });
const caps = await client.capabilities();
// always inspect caps.data.operations before optional routes
const { data, rawBytes } = await client.normalize({
  items: [{ type: 'purl', value: 'pkg:npm/%40openpacker/demo-tool@1.0.0' }],
});
```

Full tested flow: [`basic-client/src/index.ts`](basic-client/src/index.ts).

### Offline lock import (no daemon)

```ts
import { readFile } from 'node:fs/promises';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import {
  completeLockImport,
  planNativeLockImport,
} from '@openpacker/lock-import';
import { canonicalDigest } from '@openpacker/canonical';

const raw = await readFile('fixtures/locks/cargo/Cargo.lock', 'utf8');
const plan = await planNativeLockImport(raw);
const resolver = createEmbeddedResolver(bindings);
const result = await completeLockImport(plan, resolver, {
  providerId: 'org.example.demo',
  version: '0.1.0',
  resolverBuildDigest: await canonicalDigest({ implementation: 'demo' }),
});
// result.lockfile.selectedExactPurls, result.solveResponse.solution.solutionDigest
```

Full tested flow: [`lock-import/src/index.ts`](lock-import/src/index.ts).

### Embedded solve

See [`embedded-resolver/src/index.ts`](embedded-resolver/src/index.ts) and the
bounded fixture at
[`tests/fixtures/bounded-solve.json`](../tests/fixtures/bounded-solve.json).

## CLI counterparts

Examples above are library-first. Equivalent CLI commands are documented in
[Getting started](../docs/guides/getting-started.md) and
[User surface](../docs/product/user-surface.md):

```sh
npx opm normalize --input req.json --json
npx opm import-lock --input fixtures/locks/npm/package-lock.json --json
npx opm solve --input fixtures/protocol/solve/request.json --json
```

Root demos:

```sh
npm run demo
npm run demo:lock-import
```

## Rules for new examples

1. Stay offline in mandatory tests (inject `fetch` or use fixtures).
2. Depend only on public workspace packages, not private app internals.
3. Export a small function that tests call — do not require a manual server for
   unit tests.
4. Document the example in this README and link it from
   [use cases](../docs/product/use-cases.md) when it illustrates a workflow.
