# OPM pack parity implementation backlog

External issue creation is intentionally deferred. These are the three one-shot
implementation contracts.

## 01 — Versioned delegated pack capability

Status: implemented and locally gated.

Why: OPM currently exposes single-artifact in-process npm/NuGet packers and
cannot safely drive native package toolchains.

Deliver: package-build v2 types and registry routing; exact delegated
plans/outcomes/receipts; fail-closed sandbox execution; tool-family adapters;
`opm pack --delegate`.

Accept: injected-executor tests prove exact argv, availability, dry-run,
build/network consent, cancellation, multi-output discovery, digesting, and
failure cleanup. Legacy package-build v1 remains compatible.

## 02 — Normalized pack model

Status: implemented; full verification pending.

Why: standardized packing needs a target-independent representation that can be
produced without invoking a delegate.

Deliver: schema-first normalized manifest composed from existing PREX
package/artifact/tree types; project and artifact normalization; safe content
capture; internal OCI/CAS serialization.

Accept: canonical/round-trip/maximum/negative vectors and per-ecosystem fixture
normalization produce stable tree and manifest digests with explicit semantic
loss.

## 03 — Deterministic standard emitters

Status: implemented; full verification pending.

Why: the final OPM path must produce target-native artifacts without installed
native pack tooling.

Deliver: adapter-owned emitters for truthful repo formats; standard-by-default
`opm pack`; native artifacts plus canonical receipt; mise backend routing.

Accept: repeated output is byte-stable, independently parseable, semantically
equal to normalized delegate fixtures, and fails closed on incomplete target
metadata or prebuilt content.
