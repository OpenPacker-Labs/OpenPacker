# ADR 0019: Use one cross-runtime property and fuzz authority

- Status: Accepted
- Date: 2026-08-03

## Context

The baseline recommends Rust `proptest` and fuzz targets. OpenPacker must also
prove that TypeScript and Rust agree on PURL, VERS, canonical bytes, digests,
constraints, proofs, and receipts. Separate TypeScript and Rust generators would
duplicate the corpus while permitting their assumptions to drift.

The checked-in property suite already loads the release-mode Rust/WASM artifact
through `@openpacker/embedded/wasm-node`. `fast-check` supplies deterministic
seeds, generated values, and shrinking while each property compares the public
TypeScript result with the Rust result. The bounded fuzz smoke adds 30,601
deterministic mutation cases across protocol, parser, solver, proof, artifact,
and trust classes. Native Cargo tests consume the same canonical fixtures and
independently check the solver against the exhaustive oracle.

## Decision

Use `tests/property/prex.test.mjs` as the property generator and shrinking
authority for both TypeScript and Rust/WASM. Use `scripts/fuzz-smoke.mjs` as the
mandatory deterministic fuzz target and retain native Rust fixture, checker,
oracle, and mutation tests under `cargo test`.

This is the technology-baseline deviation: do not add a second `proptest`
generator whose cases do not cross the language boundary. A Rust change is not
property-tested unless the built WASM artifact passes the shared properties;
`npm run verify` therefore runs build, property/unit, fuzz, browser/Node WASM,
and native Rust gates together.

## Consequences

One seeded, shrinking corpus proves parity instead of two independent corpora
proving only self-consistency. Failures report the replayable seed and minimized
value, and the fuzz report records every class count. Native Rust panics,
checker mutations, oracle disagreement, formatting, clippy warnings, and unit
behavior remain direct Cargo failures. The Epoch boundary is unchanged because
the tested surface is the published embedded API and canonical PREX fixtures.
