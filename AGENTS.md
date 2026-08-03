# Agent instructions (OpenPacker)

This repository is the **PREX reference implementation** (OpenPacker). Prefer
offline, fail-closed gates. Product docs start at
[`docs/README.md`](docs/README.md).

## Installed skills

| Skill        | Path (mirrors)                                        | Use                                                                                                                          |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **sdlc**     | `.agents/skills/sdlc` ≡ `.claude/skills/sdlc`         | Full loop: brainstorm → plan → issues → subagents → stacked PRs → bottom-up review → squash-merge. `/sdlc`, `/sdlc --finish` |
| **gh-stack** | `.agents/skills/gh-stack` ≡ `.claude/skills/gh-stack` | Non-interactive `gh stack` CLI for stacked PRs                                                                               |

Keep skill mirrors byte-identical: `node scripts/check-skill-mirrors.mjs`.

Subagent definitions for the Claude Code backend:

- `.claude/agents/implementer.md` — one issue, one worktree, incremental commits
- `.claude/agents/reviewer.md` — read-only gate + acceptance re-check

## Repo-local sdlc (configured for OpenPacker)

The **sdlc** skill was pulled from HoBo (`hobo-devx`) and bound to this repo:

1. Durable state: `docs/plans/<initiative-slug>/sdlc-state.md`
2. Dispatch log: `docs/plans/dispatch-log.md`
3. Handback: `.sdlc/report.json` (worktree) or fenced `sdlc-report` on cloud PRs
4. Gates: narrow workspace checks per commit; **`npm run verify`** before
   PR/merge
5. Stacks: `gh stack` (`github/gh-stack`); bottom-up squash-merge closeout
6. Billing-only CI red does not block squash-merge (document on PR + state file)

See `.agents/skills/sdlc/SKILL.md` § **OpenPacker binding** for HoBo →
OpenPacker command mapping. Draft-proof cascade / Linear are optional here; use
ADRs + `spec/prex/v1` when draft/Linear are not in use.

## Quality gates (OpenPacker)

| Intent                 | Command                                                   |
| ---------------------- | --------------------------------------------------------- |
| Package unit tests     | `npm run test --workspace <pkg>`                          |
| Typecheck package      | `npm run typecheck --workspace <pkg>`                     |
| Contracts / schemas    | `npm run check:contracts` / build `@openpacker/contracts` |
| Docs                   | `npm run test:docs`                                       |
| Conformance            | `npm run test:conformance`                                |
| Full offline aggregate | `npm run verify`                                          |
| Skill mirror integrity | `node scripts/check-skill-mirrors.mjs`                    |

Live registry tests are opt-in and never substitute for offline failure.

## Protocol boundaries

- Schema-first for PREX: change `spec/prex/v1` and repair consumers in the same
  change.
- Native package bytes stay canonical; no rewrite archives for transport.
- No production dependency on Epoch/ATProto.
- Capture ≠ independent solve (`native-capture-v1` honesty).

## Git defaults (local)

```bash
git config --local rerere.enabled true
git config --local remote.pushDefault origin
gh extension install github/gh-stack   # if missing
```
