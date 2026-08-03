# Benchmark methodology and baseline

`npm run benchmark` executes [`benchmarks/run.mjs`](../../benchmarks/run.mjs)
with fixed reviewable inputs after a warm-up and writes runtime/platform results
to `.demo-output/benchmark-report.json`. It measures canonical JSON, npm PURL
and range membership, a 100-record catalog snapshot, cold and warm WASM solve,
proof/explanation, proof checks, bounded exhaustive oracle, 8 MiB OCI-style
streaming and chunking, and WASM load.

The committed [`baseline.json`](../../benchmarks/baseline.json) contains broad
maximum wall-time and heap-growth regression thresholds. They are CI safety
limits, not latency/throughput promises and not comparisons with native package
managers. Report Node version, platform, fixture size, iteration count, warm-up,
and whether a metric includes loading, canonicalization, proof, or I/O whenever
publishing a result.

The current Node `>=20.20.0`, 10,000-iteration threshold set is:

| Metric                                 | Maximum milliseconds |
| -------------------------------------- | -------------------: |
| Canonical JSON                         |                2,500 |
| npm PURL                               |                3,000 |
| npm VERS membership                    |                5,000 |
| Catalog snapshot, 100 records          |                5,000 |
| Cold WASM solve                        |                5,000 |
| Warm proof/explanation, 200 operations |               10,000 |
| Proof check, 1,000 operations          |               10,000 |
| Exhaustive oracle, 100 operations      |               10,000 |
| OCI-style stream, 8 MiB                |                5,000 |
| Chunking, 8 MiB                        |               10,000 |
| WASM load                              |                5,000 |

The OCI stream heap-growth ceiling is 134,217,728 bytes. The generated report
contains the observed values; this table records only the committed gates.

Compare like with like:

- cold load versus warm repeated solve;
- search versus independent proof check and explanation;
- bounded oracle versus production search;
- bytes streamed versus native archive extraction; and
- process heap growth versus total operating-system memory.

Change a threshold only with the raw before/after reports, stable fixture and
machine/runtime details, an explained implementation change, and confirmation
that correctness gates still pass. Missing WASM bindings or metrics fail the
benchmark rather than silently skipping them.
