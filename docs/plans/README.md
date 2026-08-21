# SDLC plans and durable state

Used by the repo-local **sdlc** skill (`.agents/skills/sdlc`).

## Layout

```text
docs/plans/
  README.md                 # this file
  dispatch-log.md           # append-only dispatch outcomes
  <initiative-slug>/
    sdlc-state.md           # phase, decisions, issues → branch/PR/stack layer
    …                       # optional notes, sketches, instruction prompts, links

Current active instruction: [upm-v1-gaps swarm prompt](upm-v1-gaps/swarm-instruction.md).
```

## Rules

1. Create `docs/plans/<initiative-slug>/sdlc-state.md` when starting an sdlc
   loop.
2. Update state at every phase boundary (brainstorm, plan, dispatch, closeout).
3. Append dispatch outcomes to `dispatch-log.md` (do not rewrite history).
4. Coordinator-only writes to shared state files; implementers hand back
   `.sdlc/report.json` deltas.

See `.agents/skills/sdlc/SKILL.md` and `references/dispatch.md`.
