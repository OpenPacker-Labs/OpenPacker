# ADR 0006: Keep native capture, validation, and PREX solving distinct

- Status: Accepted
- Date: 2026-08-02

## Context

Native resolvers preserve ecosystem behavior that a shared model may not
represent, while cross-ecosystem requirements require a common solver.

## Decision

PREX defines `native-capture-v1`, `native-validated-v1`, and
`prex-calculus-subset-v1`. Capture records a native result without claiming an
independent solve; validation checks representable semantics and reports loss;
the subset profile solves the documented shared IR directly.

## Consequences

Claims match actual proof strength. Users choose fidelity or cross-ecosystem
solving explicitly rather than receiving silent approximation.
