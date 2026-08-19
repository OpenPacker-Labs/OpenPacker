# Test coverage completion SDLC state

## Status

- Phase: verification and review
- Current layer: bottom-up review
- Branch: `sdlc/test-coverage-02-inventory`, stacked on
  `sdlc/test-coverage-01-authority`
- External issues: not created. PR #89 is the coverage-authority base; PR #90 is
  the test-type closeout; GitHub stack #91 is open.

## Problem

The aggregate coverage threshold is global and excludes examples, so one
well-tested workspace can hide another below threshold. Specialized gates are
present, but there is no fail-closed inventory proving every workspace owns a
test suite and every advertised test type has a mandatory oracle.

## Decisions

- Reuse the dependency-free V8 coverage collector already in the repository.
- Require every production source file to be instrumented and retain the 70%
  function threshold independently per workspace; unknown functions fail closed.
- Count production `src` trees only, and include apps, examples, and packages.
- Require unit coverage for every workspace. Apply conformance, security,
  property, integration, end-to-end, compatibility, browser, fuzz, Pact, chaos,
  mutation, native-manager, and live tests only where their boundary exists; a
  meaningless test type copied into every package is not evidence.
- Native package-manager commands remain isolated and opt-in. Do not execute a
  host package manager to make a test green.

## Acceptance

- Every workspace has at least one discovered test and participates in the
  coverage run.
- Every workspace independently clears 100% source-file instrumentation and 70%
  function coverage.
- Every root test gate refuses an empty or missing oracle.
- Pact chaos and Pact mutation tests remain mandatory for the Epoch HTTP
  boundary; package-manager parity remains mandatory offline and native-only in
  an isolated opt-in container.
- Focused gates, `npm run verify`, and independent review pass before merge.

## Verification

- 2026-08-18 baseline: escalated coverage passed globally at 92.25% files and
  78.5% functions, but examples were absent and six workspaces were below the
  70% function threshold. The in-workspace run also exposed expected process
  restrictions; it is not accepted as a product failure.
- 2026-08-18: the revised gate passed 774 tests with 98.46% production-file
  instrumentation and 81.43% function coverage across 48 workspaces. Every
  workspace independently cleared the then-configured 80%/70% gate.
- 2026-08-18: the first full verify exposed an Epoch Pact server race in the
  broad `check:generated` alias. Pact-bearing Vitest aggregates now serialize
  files; the formerly failing aggregate passed three consecutive runs.
- 2026-08-18: the second full verify exposed a scheduler-dependent diagnostic in
  the growing-artifact adversarial test. File opening and mutation are now
  synchronized so the byte-limit rejection is deterministic.
- 2026-08-18: the final full offline `npm run verify` passed after both race
  fixes, including all 48 workspace suites, 14 test-type authorities, explicit
  package-manager parity, TypeScript/Rust builds, demos, benchmarks, goldens,
  browser, fuzz, Pact chaos, and Pact mutation.
- Native parity is not yet rerun: Docker and Podman are unavailable, and host
  Nix/APT execution is prohibited by the isolation requirement.
- 2026-08-18 review closeout: coverage passed 776 tests at 100% production-file
  instrumentation and 81.39% functions across all 48 workspaces. Inventory found
  776 runnable of 790 collected tests and rejects no-op, empty, skipped-only, or
  unwired gates; the focused pack-provider suite passed 15/15.
- 2026-08-18: the post-review full offline `npm run verify` passed all required
  TypeScript, Rust, contract, documentation, coverage, specialized test,
  pack-parity, demo, benchmark, golden, browser, Pact, and fuzz gates.
- 2026-08-18 second review closeout: every specialized Vitest oracle is now
  required to collect a runnable test, authority commands match exactly, and the
  root Nix live lane resolves to an explicit workspace script. Focused inventory
  and the complete offline `npm run verify` passed again without executing a
  host package manager.
