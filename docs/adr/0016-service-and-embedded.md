# ADR 0016: Support service and embedded/WASM modes

- Status: Accepted
- Date: 2026-08-02

## Context

Some consumers need managed catalog access and persistence; others require
offline, browser, or in-process verification without a hosted dependency.

## Decision

OpenPacker exposes PREX through `openpackerd` and the TypeScript SDK, and
exposes pure normalization, solve, proof, receipt, and digest operations through
native and WASM bindings over serialized snapshots. All modes share contracts
and canonical vectors.

## Consequences

Deployment topology does not change PREX semantics. Cross-mode digest equality
is an acceptance requirement.

## Amendment 2026-10-11: the WASM bindings are optional locally and required in CI

The WASM bindings need the `wasm32-unknown-unknown` target and `wasm-bindgen`,
which a machine that only wants the CLIs does not have, and the CLIs never load
them. A missing toolchain therefore no longer fails `npm run build`: the
`@openpacker/embedded` WASM step prints one warning, writes declaration-only
stubs so packages that import the bindings' types still compile, and exits 0.
Importing the module at run time still fails, because no code is faked.

`CI` (other than `0` or `false`) and `OPENPACKER_REQUIRE_WASM=1` make the same
condition an error, with no variable that switches it back off, so a pipeline
cannot ship without the bindings. A toolchain that is present but fails is an
error in both modes. This changes who must install the toolchain, not what the
bindings are: cross-mode digest equality remains an acceptance requirement and
is still checked wherever the bindings are built.
