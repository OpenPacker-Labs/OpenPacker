# Test coverage completion backlog

## 01 — Per-workspace coverage authority

Status: complete, independently approved, and squash-merged in PR #89.

Make the existing V8 coverage gate include every app, example, and package,
measure only production source, and fail when any workspace falls below the
repository thresholds. Add the smallest regressions needed to close every
reported gap.

## 02 — Test-type closeout

Status: complete, independently approved, and squash-merged in PR #90.

Prove every workspace has an executable unit suite and that every specialized
repository gate has a mandatory, non-empty oracle. Run focused checks, the full
offline aggregate, and independent review; record any native lane that cannot
run without an isolated runtime as external evidence rather than claiming it.
