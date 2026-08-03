---
type: Agent Skill Reference
title: "SDLC planning over the draft cascade"
description: "Plan-mode guidance that maps work onto the four-layer draft-proof cascade."
tags: [hobo, sdlc, planning]
timestamp: 2026-07-02T00:00:00Z
---

# Plan

Enter **plan mode** (the user approves the plan before anything mutates). Compose with the
Superpowers `writing-plans` skill where available.

## Map onto the draft cascade

Order the work as the proof layers order it:

1. **Technical proofs first** — every new atomic concept gets a technical proof (draft skill,
   `src/draft/_templates/technical/`).
2. **Experience proofs in parallel** — for each affected experience type (dx/ux/cx/ax/api), a
   proof under `src/draft/exp-proofs/<type>/` with the per-type artifacts.
3. **Epic promotion** — technical + experience proofs roll up into an epic proof with an
   EXECUTABLE feature suite (this is where ATDD acceptance lands).
4. **Project aggregation** — only when an owner/outcome/scope exists (no fake MVPs).

## Rules

- New tech, screens, features, and capabilities go **through the draft skill** — never ad-hoc
  files. Changing an existing proof follows plan → improve (review the blast radius) → ADR beside
  the changed proof; the `draft:cascade` gate enforces rollup updates mechanically.
- Plans name exact packages/paths, the gates that prove each step, and the dependency order.
- Requirements discovered mid-planning update the brainstorm record (append, never overwrite).
- **Stack layers:** when the plan has 2+ dependent steps, name ordered stack branches
  (`sdlc/<id>-NN-<slug>`) with foundations at the bottom. Multi-step delivery uses `gh stack`
  (see `stacked-prs.md`); one issue per layer when possible.

Exit: user-approved plan; state file updated (phase: planned, plan location, planned stack chain).
