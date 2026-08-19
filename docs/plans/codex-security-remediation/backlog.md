# Codex Security remediation backlog

## 01 — Canonical identity and policy

Status: independently approved; focused and staged gates green.

Close findings 1, 2, 4, 7, 8, and 22. Recompute package node identity at the
Rust trust boundary, reject contradictory identities, require verified amendment
authority, preserve lifecycle and semantic-loss evidence, and reject configured
policy controls that the evaluator cannot enforce.

## 02 — Registry and network authority

Status: independently approved; focused and 15-gate layer aggregate green.

Close findings 3, 5, 6, 13, 17, 21, and 24. Authenticate registry mutation, bind
namespaces and credentials to operator configuration, constrain outbound origins
and redirects, bound pagination, and validate federated and OCI evidence before
use.

## 03 — Filesystem and resource containment

Status: independently approved; focused, staged, and exact aggregate gates
green.

Close findings 9, 10, 14, 15, 18, 19, 20, and 23. Pin sandbox helpers, validate
persisted paths, verify cached content, reject link-ancestor escapes, and
enforce streaming count, byte, output, and time limits.

## 04 — Lock and composition fidelity

Status: independently approved; focused, staged, and exact aggregate gates
green.

Close findings 11, 12, and 16. Preserve or fail closed on native hash, variant,
marker, source, and transitive composition semantics.

## 05 — Advisory and scan closeout

Status: reviewed, repaired, and squash-merged (#99, `4f0e2ef`); the fresh
complete Codex Security rescan remains scheduled for the account-limit reset
(2026-08-20 14:18 local).

Replace or remove the vulnerable `extract-zip` implementation in the external
Codex Security installation, keep it outside the workspace graph, rerun all
focused gates and `npm run verify`, then rerun Codex Security until coverage is
complete and no reportable finding or advisory remains.
