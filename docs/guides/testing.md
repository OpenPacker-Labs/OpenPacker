# Testing strategy

OpenPacker's gates are offline and fail-closed. This page is the map from test
type to authority: where each kind of test lives, how it runs, and what makes it
count.

The enforcement point is
[`scripts/check-test-inventory.mjs`](../../scripts/check-test-inventory.mjs)
(`npm run check:test-inventory`): every workspace must have a runnable Vitest
suite, and every test type below must be wired to its authority command with at
least one live oracle. A type that loses its last oracle fails the gate.

## Test-type matrix

| Type                        | Where                                                                                                                                                                                                                                                     | Authority                                             | Notes                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                        | `packages/*/`, `apps/*/` suites + `tests/unit/`                                                                                                                                                                                                           | `npm test`                                            | Atomic, per-workspace; zero discovered or all-skipped suites fail                                                                                                    |
| Behavior (BDD)              | `tests/behavior/`                                                                                                                                                                                                                                         | `npm run test:behavior`                               | Given/When/Then user journeys over public APIs; honest refusals are behavior too                                                                                     |
| Snapshot / characterization | `packages/*/{src,test}/__snapshots__/` (Vitest `toMatchFileSnapshot`, awaited) + `fixtures/golden/`                                                                                                                                                       | `npm test`, `npm run golden:check`                    | Framework-native file snapshots pin renderings (Verify-style); goldens are digest-pinned protocol artifacts regenerated only by deliberate `npm run golden:generate` |
| Contract                    | `spec/prex/v1/`, `packages/conformance/`, `pacts/`                                                                                                                                                                                                        | `npm run check:contracts`, `npm run test:conformance` | Schema-first; Pact consumer **and** provider verification both run                                                                                                   |
| Property                    | `tests/property/` (fast-check)                                                                                                                                                                                                                            | `npm test`                                            | Fixed seeds, bounded runs                                                                                                                                            |
| Fuzz                        | `scripts/fuzz-smoke.mjs`, `tests/fuzz/` (auth-config, Maven POM), `tests/rust-fuzz/`                                                                                                                                                                      | `npm run test:fuzz`, `npm run check:rust`             | ~33k deterministic cases across 14 classes (including host-fetch pins) plus auth-config and Maven POM parsers + proptest; a smoke gate, not coverage-guided fuzzing  |
| Mutation                    | `examples/epoch-consumer/test/pact.mutation.test.ts`, `tests/property/prex.test.mjs`, `packages/opm-project/test/host-fetch.mutation.test.ts`, `packages/opm-project/test/update.mutation.test.ts`, `packages/adapter-maven/src/inspect.mutation.test.ts` | `npm run coverage`, `npm test`                        | Mutates contracts, solver proofs, host-fetch grants, update ranges, and Maven inspect; every mutant must die                                                         |
| Chaos                       | `examples/epoch-consumer/test/pact.chaos.test.ts`, `packages/adapter-core/src/host-fetch.chaos.test.ts`, `packages/opm-project/test/shared-store.chaos.test.ts`, `apps/openpackerd/test/publish.chaos.test.ts`                                            | `npm run coverage`                                    | Fault injection on the registry, host-fetch transport, shared CAS link, and publish-store boundaries                                                                 |
| Security                    | `tests/security/`, package escape suites                                                                                                                                                                                                                  | `npm run test:security`                               | Adversarial oracles at trust boundaries                                                                                                                              |
| Integration                 | `tests/integration/`, `integrations/`                                                                                                                                                                                                                     | `npm run test:integration`                            | Cross-package flows                                                                                                                                                  |
| End-to-end                  | `tests/e2e/`                                                                                                                                                                                                                                              | `npm run test:e2e`                                    | Full demo pipeline                                                                                                                                                   |
| Compatibility               | `tests/compat/`                                                                                                                                                                                                                                           | `npm run test:compat`                                 | SDK/event compatibility                                                                                                                                              |
| Browser                     | `tests/browser/`                                                                                                                                                                                                                                          | `npm run test:browser`                                | Playwright                                                                                                                                                           |
| Pack parity                 | `packages/adapters-default/`, `integrations/mise/`                                                                                                                                                                                                        | `npm run test:pack-parity`                            | Native pack semantics parity; native lane is opt-in (`test:pack-parity:native`) without a preloaded runtime                                                          |

`npm run verify` runs every mandatory lane. Live registry and native
package-manager lanes stay opt-in and never substitute for offline failure.

## One package's tests at a time

`npm test`, `npm run check:contracts` and `npm run check:generated` run turbo
through [`scripts/turbo-run.mjs`](../../scripts/turbo-run.mjs), one package at a
time unless `OPENPACKER_TURBO_CONCURRENCY` says otherwise. Each package's suite
is one `vitest run`, and Vitest starts a worker per CPU but one; with turbo's
default of ten tasks at once the verify alone put about 30 runnable test threads
on a 4-CPU machine. A test that takes half a second alone then took over five,
past Vitest's 5 s default, although nothing in it was wrong. One package at a
time keeps the threads within the CPUs on a dedicated 4-CPU machine, and the
tests' own timeouts stay as they are. The lanes that run one Vitest process
across many packages (`npm run coverage` and the `run-gate.mjs` gates) already
did.

A machine with CPUs to spare runs more at once by naming a number of tasks or a
share of its CPUs, as turbo's `--concurrency` takes them:

```sh
OPENPACKER_TURBO_CONCURRENCY=4 npm test
OPENPACKER_TURBO_CONCURRENCY=50% npm run check:contracts
```

Unset or empty means 1, and so does CI, which sets nothing. A value turbo would
not take is refused before turbo starts.

A one-time cost belongs outside a test's budget too: a file whose first test
would compile the PREX schemas (Ajv) compiles them while the file is collected,
and a test that times its work measures the CPU it spent, not the wall clock.

## What a test run may touch

The suites that can resolve a store (opm-project, opm, plugin-store and
plugin-host) and the root gate and coverage configs load
[`tests/support/stores.setup.ts`](../../tests/support/stores.setup.ts), which
unsets `OPM_STORE_HOME`, `OPM_TOOL_CACHE` and `OPM_PLUGIN_HOME` and points
`XDG_CACHE_HOME` and `XDG_DATA_HOME` at a fresh directory per test file, so no
test reads or writes the caller's shared store, tool cache or plugin store. A
caller that exported `OPM_STORE_HOME` used to have every install of the suite
use that store, and a test that writes into a store file (two of them check that
a tampered tree is rebuilt) wrote through a hard link into it: as root, the
entry's read-only mode does not stop that, and every later install of the
package failed with "does not match its recorded digest". The opm-project and
opm suites and the root runs also fail a test whose environment would resolve
one of those outside the temporary directory
([`tests/support/store-guard.ts`](../../tests/support/store-guard.ts)), and
`packages/opm-project/test/store-isolation.test.ts` runs both tampering tests
with `OPM_STORE_HOME` set and requires that store to stay empty. The setup
changes no test's time bound.

`HOME` and `XDG_CONFIG_HOME` are left as the caller has them, and a few reads
through them are not isolated, only read: opm-project looks for an installed
.NET under `$HOME/.dotnet/shared/Microsoft.NETCore.App` (`src/bins.ts`), the
registry auth configuration is read from `$XDG_CONFIG_HOME` or `$HOME/.config`
(`src/auth-config.ts`; a test that writes one names its own file with
`OPM_AUTH_CONFIG` or a path), and the sandbox names the home directory in its
deny rules. Their answers depend on the machine; nothing is written there.

## Coverage policy

[`scripts/coverage-policy.mjs`](../../scripts/coverage-policy.mjs) requires 100%
production-file instrumentation and at least 70% function coverage per workspace
and globally (`npm run coverage` enforces both).

## Adding a test type

1. Add the lane (script + oracle files).
2. Register an authority in `scripts/check-test-inventory.mjs` so the type can
   never silently lose its last oracle.
3. Add it to `npm run verify`.
4. Update the matrix above.
