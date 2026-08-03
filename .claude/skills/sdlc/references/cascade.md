---
type: Agent Skill Reference
title: "SDLC requirement cascade"
description: "How inner/outer-loop discoveries ripple through plans, proofs, ADRs, and Linear - mechanically, single-writer."
tags: [hobo, sdlc, cascade]
timestamp: 2026-07-02T00:00:00Z
---

# Requirement cascade

Inner/outer loop cycles WILL surface requirement changes. They ripple; nothing is edited silently.

## Upward (implementation → plan/Linear)

Implementers record discoveries in `.sdlc/report.json` `requirementChanges` — they never edit
plans, Linear, or shared registers themselves. The coordinator, single-writer, then:

1. Updates the plan doc and `sdlc-state.md` (append decisions; never rewrite history).
2. Updates affected Linear issues — acceptance-criteria changes are APPENDED with a dated note
   (an issue whose contract changed after dispatch goes back through review).
3. Records scope-level changes in the long-running register (GAPS.md pattern) or an ADR when a
   design decision moved.

## Downward (design/proof change → dependents)

Proof changes follow the draft skill: plan the change → improve-review the blast radius → ADR
beside the changed proof → update every referencing rollup. `pnpm run draft:cascade` is the
mechanical backstop — a changed technical/exp proof fails the gate until referencing epics/projects
move in the same diff (waiver = proof.json + ADR).

## Shared-file strategy (conflict-free by construction)

Traceability rows for proofs derive from `proof.json` manifests; ledgers/registries/registers are
coordinator-applied from reported deltas. If two dispatched issues both need the same shared
mutation, the coordinator serializes them — implementers never race on shared files because they
never touch them.
