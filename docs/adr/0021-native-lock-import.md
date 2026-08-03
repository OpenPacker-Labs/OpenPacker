# ADR 0021: Offline-first native lock import

- Status: Accepted
- Date: 2026-08-03

## Context

Operators already hold native lockfiles that encode exact selections. Importing
those selections into PREX must preserve offline workflows and must never claim
that OpenPacker independently solved the graph.

## Decision

Native lock import is an OpenPacker extension operation (`import-lock`), not a
normative PREX solve profile. Import uses semantics profile `native-capture-v1`,
records structured `SemanticLoss` with code `NATIVE_RESULT_CAPTURE_ONLY`, and
produces locked exact PURLs plus a capture plan that may feed a capture-mode
solve or lock/receipt export. Capture never claims independent solving or
native-validated checking.

Each ecosystem has one primary freeze format for import; secondary formats are
optional handlers and must not dilute the primary mapping:

| Ecosystem | Primary freeze format                           |
| --------- | ----------------------------------------------- |
| npm       | `package-lock.json` (lockfileVersion 3)         |
| Cargo     | `Cargo.lock`                                    |
| NuGet     | `packages.lock.json` (assets JSON optional)     |
| Python    | `uv.lock` when a codec/handler is registered    |
| Go        | `go.sum` when a codec/handler is registered     |
| Gradle    | `*.lockfile` when a codec/handler is registered |

Import is offline-first: bytes come from local input; network catalog fetch is
out of band and never required for capture planning.

## Consequences

Imported locks carry explicit loss that blocks `prex-calculus-subset-v1` and
`native-validated-v1` until the graph is re-solved or validated under those
profiles. Consumers can pin and audit native selections without overstating
proof strength. Extension format handlers reuse
`EcosystemCodec.translateLockResult` rather than inventing parallel parsers
outside the codec seam.
