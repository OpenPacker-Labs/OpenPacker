# Claude Code / multi-agent notes (OpenPacker)

@AGENTS.md

## Skills

Repo-local skills load from:

- `.agents/skills/` — Cursor, Codex, Grok, and agents that read that tree
- `.claude/skills/` — Claude Code mirror (**must stay byte-identical**)

Primary coordinator:

- **sdlc** — full feature loop; invoke with `/sdlc` or “run the sdlc loop”
- **sdlc --finish** — land the session (commit, rebase, PR, squash-merge)
- **gh-stack** — stacked PR CLI detail

Implementer/reviewer backends: `.claude/agents/implementer.md`,
`.claude/agents/reviewer.md`.

## OpenPacker defaults

- Prefer `npm run verify` offline before claiming Done on multi-package work.
- Use RTK (`rtk <cmd>`) when available for verbose shell output.
- Documentation map: `docs/README.md`. Compliance: `docs/product/compliance.md`.
