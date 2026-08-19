# Codex Security remediation SDLC state

## Status

- Phase: implementing; layers 01 and 02 independently approved
- Current layer: `03-filesystem-resources` implemented and awaiting independent
  review
- Branch chain: `sdlc/codex-security-01-canonical-policy` →
  `sdlc/codex-security-02-registry-network` →
  `sdlc/codex-security-03-filesystem-resources` →
  `sdlc/codex-security-04-lock-composition` →
  `sdlc/codex-security-05-scan-closeout`
- External issues: not created; the local Codex Security report is the one-shot
  finding authority and contains sensitive operational detail.
- Dispatch: coordinator-only implementation because delegation permission was
  not separately granted; independent reviewer remains mandatory.

## Problem

Codex Security scan `36149a58` reported 24 high-confidence findings: 7 high, 16
medium, and 1 low. Coverage was partial. Its globally installed dependency graph
also contains `GHSA-jmr9-qjv8-65gv` through `extract-zip@2.0.1`, for which the
upstream Codex Security release currently has no patched version.

## Decisions

- Treat every finding and advisory as blocking. A finding may close only with a
  regression and a scanner recheck, or with concrete evidence that the reported
  path is unreachable.
- Fix shared trust boundaries, not individual call sites. Inputs derived from
  identities, authorities, paths, digests, registries, and package bytes are
  recomputed or validated where they first become trusted.
- Preserve offline and fail-closed behavior. Do not execute native package
  managers, package lifecycle scripts, mutable images, or GitHub Actions.
- Bound every untrusted collection or byte stream before allocation. Preserve
  native semantics or reject the import explicitly.
- Keep Codex Security outside the workspace dependency graph. Its external
  installation must have a clean audit before final scanning.

## Acceptance

- All 24 findings have focused positive, negative, and adversarial regression
  coverage at their responsible boundary.
- Workspace and external scanner dependency audits report zero advisories.
- `npm run agent:check`, focused package gates, and the full offline
  `npm run verify` pass.
- A fresh complete Codex Security scan reports zero findings and can evaluate
  the configured high-severity gate successfully.
- Every stack layer receives independent review and is squash-merged bottom-up;
  durable state and the dispatch log record the final evidence.

## Hardening record

- Adversarial: duplicate identities, forged authority labels, credential
  redirection, DNS/redirect rebinding, symlink swaps, cache substitution,
  infinite pagination, archive bombs, output floods, and semantic collapse are
  explicit test cases.
- YAGNI: reuse canonical projections, policy validation, sandbox execution,
  bounded collectors, and existing adapters. No parallel security framework or
  generic plugin system is introduced.
- Rubber duck: untrusted package data enters one boundary, is validated against
  operator policy and canonical bytes, and only then reaches resolution,
  storage, network, filesystem, or execution sinks.

## Verification

- 2026-08-18 baseline: scan `36149a58` completed against `4407b85` with 24
  high-confidence findings and partial coverage; the severity gate refused to
  pass.
- 2026-08-18: `@openai/codex-security@0.1.14` is the latest registry release and
  still depends on `extract-zip@2.0.1`; no upstream patched release exists.
- 2026-08-18 layer 01: resolver 31/31, policy 18/18, OPM project 139/139,
  adapter-nix 32 passed with 3 live skips, contracts validated 14 schemas and
  189 references, staged `agent:check` passed 10/10, and `git diff --check` was
  clean.
- 2026-08-18 layer 01 independent review: approved at `99a0f73`; canonical
  version projections, deny-all empty signer allowlists, deprecation defaults,
  authority-plus-digest amendments, and exact source-snapshot pins were all
  rechecked with no remaining findings.
- 2026-08-18 layer 02: authenticated namespace/status mutations, bounded and
  verified federation, operator-bound OCI origins and credentials, verified
  bounded referrers/tags/token flows, and authenticated revocation metadata.
  Registry 92/92, OCI 43/43, registry client 28/28, adapters-default 50 passed
  with 11 native skips, and the exact `253834c..fb3d9a0` layer aggregate passed
  all 15 impact-selected gates.
- 2026-08-18 layer 02 independent review: approved at `fb3d9a0` after revoked
  rotation, status rollback/collision, anonymous token egress, tag exhaustion,
  revocation authenticity, signer-role separation, redirects, and token body
  bounds were adversarially rechecked with no remaining finding.
- 2026-08-19 layer 03 implementation: sandbox helpers are fixed to trusted
  system paths and all execution funnels enforce hard output budgets; TAR and
  OCI materialization enforce count and aggregate limits before allocation or
  blob fetch; OPM artifact reads are bounded, abortable, regular-file-only and
  no-follow; canonical artifact bytes are digest-verified before every store
  reconstruction; project state paths are derived and realpath-confined; and
  native layouts traverse stable no-follow directory handles. Sandbox 32/32,
  materializer 17/17, OCI 45/45, project I/O 20/20, npm adapter 16/16, and OPM
  project 144/144 passed. All three incremental staged gates and the exact
  `970e2a8..4c0d0bf` 12-gate impact aggregate were green; diff checks were
  clean.
- 2026-08-19 layer 03 review remediation: the first independent review found
  remaining project metadata/link ancestor races, staged-layout publication and
  source-copy races, incomplete process-tree termination, an undocumented
  Windows layout limitation, and vacuous TAR count coverage. Shared stable
  file/directory operations now cover project state, generations, shims, links,
  store publication and collection; layout publication and copy inputs are
  identity-checked before and after use; timeout, abort and output limits
  terminate and await descendant trees (including MXC jobs); Windows layout
  projection fails closed and is documented; and adversarial race/early-limit
  regressions close each oracle. Materializer 18/18, project I/O 24/24, OPM
  project 149/149, sandbox 36/36, and the amended exact 12-gate layer aggregate
  passed with process authority; diff checks were clean.
- 2026-08-19 layer 03 second review remediation: the amended review found
  Windows project-state capability overclaim, a growing-file allocation gap,
  store/generation authority handoffs, validation-wide absent-state handling,
  incomplete directory/staging snapshots, and best-effort descendant killing.
  Windows project mutation is now explicitly withdrawn while read-only and
  packing remain; metadata reads allocate only the snapshotted bounded size;
  store and generation transactions retain one fd-relative authority through
  completion; only the state-file open maps ENOENT to absence; layout compares
  complete source and staged tree snapshots; and production execution requires
  Bubblewrap PID-namespace or MXC job ownership (the mock process group is
  test-only). OPM project 153/153, project I/O 26/26, sandbox 35/35, and the
  exact amended 12-gate layer aggregate passed with process authority.
