# Codex Security remediation SDLC state

## Status

- Phase: planned and implementing
- Current layer: `01-canonical-policy`
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
