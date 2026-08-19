# Codex Security remediation SDLC state

## Status

- Phase: all five layers reviewed, repaired, and squash-merged bottom-up
  (#95–#99); a fresh complete Codex Security deep scan remains blocked on the
  external account usage limit (reset 2026-08-20 14:18 local; rescan scheduled)
- Current layer: `05-scan-closeout` (merged)
- Branch chain: `sdlc/codex-security-01-canonical-policy` →
  `sdlc/codex-security-02-registry-network` →
  `sdlc/codex-security-03-filesystem-resources` →
  `sdlc/codex-security-04-lock-composition` →
  `sdlc/codex-security-05-scan-closeout`
- External issues: not created; the local Codex Security report is the one-shot
  finding authority and contains sensitive operational detail.
- Dispatch: coordinator plus explicitly authorized security-boundary
  implementers; independent reviewer remains mandatory.

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
  Windows project mutation is now explicitly withdrawn while packing remains;
  metadata reads allocate only the snapshotted bounded size; store and
  generation transactions retain one fd-relative authority through completion;
  only the state-file open maps ENOENT to absence; layout compares complete
  source and staged tree snapshots; and production execution requires Bubblewrap
  PID-namespace or MXC job ownership (the mock process group is test-only). OPM
  project 153/153, project I/O 26/26, sandbox 35/35, and the exact amended
  12-gate layer aggregate passed with process authority.
- 2026-08-19 layer 03 third review remediation: lifecycle execution now passes
  an inherited stable directory handle to Bubblewrap and binds it with
  `--bind-fd`; staged layouts revalidate complete source and destination trees
  after old-destination removal and again after publication; host installers
  reject the legacy ambient option before execution and all four providers now
  route installs only through OS-owned containment; and Windows documentation no
  longer claims `opm list` support. Directory-handle accessibility after exec
  has a real child-process oracle. The final review edge makes containment
  required for host installers and rejects `degrade-warn` and `off` during
  planning, before availability probes or backend selection, so missing
  containment is policy denial rather than a claimed attempted install; public
  types mark the removed ambient option deprecated and refused. Sandbox 36/36,
  OPM project 154/154, project I/O 27/27, apt 14/14, WinGet 11/11, Chocolatey
  3/3, and Nix 32 passed with 3 opt-in live skips. Contract validation, package
  typechecks, and the exact layer impact aggregate passed with process
  authority; diff checks were clean.
- 2026-08-19 layer 03 independent review: approved at `d584ebd` after stable
  lifecycle handle transfer, complete publication snapshots, mandatory
  process-tree ownership, provider pre-probe policy denial, and the narrowed
  Windows capability contract were rechecked with no remaining finding.
- 2026-08-19 layer 04 implementation: requirements artifact hashes and
  directives, Poetry marker/source/hash contexts at any nesting depth, malformed
  mixed entries, pnpm v9 package and snapshot peer contexts, and multiple native
  selections now fail closed instead of collapsing into a weaker capture; pnpm
  support is honestly limited to v9. OCM component-reference digests include
  completed transitive references, require a one-to-one selected package graph,
  and use one-pass adjacency with iterative dependency-first completion; missing
  endpoints and cycles fail explicitly. A 5,000-node chain guards the resource
  boundary. Lock import 24/24, OCM 5/5, both package typechecks, all staged
  gates, and the exact layer six-gate impact aggregate passed; diff checks were
  clean.
- 2026-08-19 layer 04 independent review: approved at `88457fe` after native
  variant, marker, hash, snapshot, endpoint, cycle, and deep-chain cases were
  independently rechecked with no remaining finding.
- 2026-08-19 layer 05 pre-review aggregate: exact committed head `9a99b94`
  passed `npm run verify` across 48 workspaces, including 959 unit tests with 14
  opt-in skips, 43 security files with 567 tests and 3 opt-in skips, Pact
  baseline/mutation/chaos, 31,497 fuzz cases, 19 golden files, 6 lock imports,
  isolated package-manager parity, Rust, conformance, integration, E2E,
  compatibility, browser, demos, and benchmarks.
- 2026-08-19 layer 05 review remediation: delegated executables are capped,
  copied from a no-follow source into unnamed `O_TMPFILE` storage, hashed,
  executed from a private standalone snapshot through Bubblewrap
  `--ro-bind-data`, and reopened with an independent read offset for every pack,
  cleanup, and identity command. Unsupported backends and runtime sibling
  dependencies fail closed. Offline installation now replays only a
  manifest-matching lock from digest-verified cached bytes; exact explicit
  manifest sources bind immutable lock projections, while unverified registry,
  lifecycle, evidence, signer, issuer, trust, and snapshot claims remain
  indeterminate. Public package, policy, bytes, closure, and scalar inputs are
  owned or frozen before asynchronous use.
- 2026-08-19 layer 05 focused evidence: pack-provider 29/29; sandbox authority
  12 passed with 7 native-only skips; OPM project 187/189 with only the two
  managed-seccomp `/bin/sh` EPERM cases unavailable; all three package
  typechecks; 14 schemas and 189 API references; documentation smoke across 122
  files; generated mirrors and `git diff --check` clean. Independent review
  approved the exact working tree with no remaining code, security, contract, or
  documentation finding and separately proved the composed O_TMPFILE to
  Bubblewrap handoff.
- 2026-08-19 closeout blocker: the approval service refused native/full gate,
  commit-hook, push, and fresh Codex Security network authority after the
  account usage limit was reached (reset reported as 2026-08-20 14:18 local).
  The interrupted/cancelled deep runs produced no authoritative final report.
- 2026-08-19 delivery: layer 05 committed incrementally (5 commits, staged gates
  green); the stack was submitted as PRs #95–#99 and independently re-reviewed.
  Fresh review found and repaired real defects before merge: spec/implementation
  drift on amendment digest gating (layer 01), symlinked project-root ancestors
  failing closed on macOS temp dirs (layer 03), silently discarded poetry
  `python-versions`/`optional` context (layer 04), nested provider-manifest
  paths contradicting the spec, unreachable MXC containment on macOS, a weakened
  scanner approval policy, and NAT64/IPv4 SSRF guard gaps (layer 05). Full
  offline `npm run verify` passed at the repaired stack head `9e25e43` (48
  workspaces, 998/1012 runnable tests, 100% file instrumentation, 83.16%
  functions, 31,497 fuzz cases, cargo green), and the merged `main` tree is
  byte-identical to that verified head. Squash-merged bottom-up: #95 `fabe617`,
  #96 `a8d3a6b`, #97 `33cc342`, #98 `10c5298`, #99 `4f0e2ef`. CodeRabbit review
  comments on the PRs were quota-limit notices only (no actionable content).
  Known transient: mid-stack heads do not pass `npm run demo` alone because
  canonical fixture identity repairs landed in layer 05; the stack composes
  green and was merged back-to-back.
- 2026-08-19 residual: a fresh complete Codex Security deep scan could not run —
  the account usage limit still refuses
  (`You've hit your usage limit … try again at Aug 20th, 2026 2:18 PM`; scan
  exit 2 after preflight). Rescan is scheduled for 2026-08-20 14:25 local. The
  zero-finding acceptance criterion is NOT yet evidenced and must not be claimed
  until that report exists.
