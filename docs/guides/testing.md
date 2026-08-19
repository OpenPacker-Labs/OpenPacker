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

| Type                        | Where                                                                                | Authority                                             | Notes                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                        | `packages/*/`, `apps/*/` suites + `tests/unit/`                                      | `npm test`                                            | Atomic, per-workspace; zero discovered or all-skipped suites fail                                                                                     |
| Behavior (BDD)              | `tests/behavior/`                                                                    | `npm run test:behavior`                               | Given/When/Then user journeys over public APIs; honest refusals are behavior too                                                                      |
| Snapshot / characterization | `packages/*/test/__snapshots__/` (Vitest `toMatchFileSnapshot`) + `fixtures/golden/` | `npm test`, `npm run golden:check`                    | Framework-native file snapshots pin renderings; goldens are digest-pinned protocol artifacts regenerated only by deliberate `npm run golden:generate` |
| Contract                    | `spec/prex/v1/`, `packages/conformance/`, `pacts/`                                   | `npm run check:contracts`, `npm run test:conformance` | Schema-first; Pact consumer **and** provider verification both run                                                                                    |
| Property                    | `tests/property/` (fast-check)                                                       | `npm test`                                            | Fixed seeds, bounded runs                                                                                                                             |
| Fuzz                        | `scripts/fuzz-smoke.mjs`, `tests/rust-fuzz/`                                         | `npm run test:fuzz`, `npm run check:rust`             | ~31k deterministic cases across 13 classes + proptest; a smoke gate, not coverage-guided fuzzing                                                      |
| Mutation                    | `examples/epoch-consumer/test/pact.mutation.test.ts`, `tests/property/prex.test.mjs` | `npm run coverage`, `npm test`                        | Mutates contracts and solver proofs; every mutant must die                                                                                            |
| Chaos                       | `examples/epoch-consumer/test/pact.chaos.test.ts`                                    | `npm run coverage`                                    | Fault injection on the registry boundary: malformed bodies, outages, version skew                                                                     |
| Security                    | `tests/security/`, package escape suites                                             | `npm run test:security`                               | Adversarial oracles at trust boundaries                                                                                                               |
| Integration                 | `tests/integration/`, `integrations/`                                                | `npm run test:integration`                            | Cross-package flows                                                                                                                                   |
| End-to-end                  | `tests/e2e/`                                                                         | `npm run test:e2e`                                    | Full demo pipeline                                                                                                                                    |
| Compatibility               | `tests/compat/`                                                                      | `npm run test:compat`                                 | SDK/event compatibility                                                                                                                               |
| Browser                     | `tests/browser/`                                                                     | `npm run test:browser`                                | Playwright                                                                                                                                            |
| Pack parity                 | `packages/adapters-default/`, `integrations/mise/`                                   | `npm run test:pack-parity`                            | Native pack semantics parity; native lane is opt-in (`test:pack-parity:native`) without a preloaded runtime                                           |

`npm run verify` runs every mandatory lane. Live registry and native
package-manager lanes stay opt-in and never substitute for offline failure.

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
