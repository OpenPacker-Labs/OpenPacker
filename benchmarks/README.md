# OpenPacker bounded benchmarks

`npm run benchmark` measures fixed, reviewable inputs after a documented
warm-up. The committed thresholds in `baseline.json` are broad CI regression
limits, not performance claims. Results record the Node version, platform,
fixture sizes, node counts, and dependency-edge counts in
`.demo-output/benchmark-report.json`.

The suite gates canonical JSON, npm PURL normalization and range membership,
100-record catalog snapshot construction, cold and warm native and WASM solving
(including proof/explanation production), independent proof checks,
exhaustive-oracle overhead, OCI-style artifact streaming memory, content-defined
chunking, and binding load overhead. Medium and large solver fixtures are
dependency chains with 99 and 999 active edges; unrelated padding is not counted
as solver work. The 1,000-node case uses one measured warm solve because the
complete proof/explanation output is intentionally retained. Missing native/WASM
bindings fail the command; no metric is conditionally skipped.
