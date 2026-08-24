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

| Intent                       | Command                                              |
| ---------------------------- | ---------------------------------------------------- |
| **Agent impact-scoped gate** | `npm run agent:check` / `npm run agent:check:staged` |
| Package unit tests           | `npm run test --workspace <pkg>`                     |
| Typecheck package            | `npm run typecheck --workspace <pkg>`                |
| Contracts / schemas          | `npm run check:contracts`                            |
| Docs                         | `npm run test:docs`                                  |
| Conformance                  | `npm run test:conformance`                           |
| Full offline aggregate       | `npm run verify`                                     |
| Skill mirror integrity       | `npm run skills:mirror-check`                        |
| Install git hooks            | `npm run hooks:install` (also `prepare`)             |

### Git hooks + agent hooks

| Hook       | Path                   | Behavior                         |
| ---------- | ---------------------- | -------------------------------- |
| pre-commit | `.githooks/pre-commit` | `agent:check --staged`           |
| pre-push   | `.githooks/pre-push`   | `agent:check --base=origin/main` |
| commit-msg | `.githooks/commit-msg` | Conventional-commit advisory     |

`core.hooksPath` → `.githooks` via `scripts/install-hooks.mjs`. Opt out:
`OPENPACKER_SKIP_HOOKS=1`.

**CI/CD is budgeted, not forbidden.** The automatic PR/push lane is
`.github/workflows/ci-build.yml` — a build matrix (3 OS × 2 Node) with smoke
tests and 7-day build artifacts, gated by concurrency cancellation and warm
caches. Scheduled/manual security lanes are isolated in `security.yml` and
`codeql.yml`. Everything heavier stays manual-dispatch: `ci.yml` (full offline
gauntlet), `live-compat.yml`, `release-evidence.yml`, and `cd.yml` (release tags
or armed dispatch; staging → production with workflow-encoded harsh gates —
arming phrase, main-ancestor + version + green-CI checks, and production on tag
push only — since the GitHub plan gates environment protection rules). Never add
automatic triggers to the heavy workflows, and never start manual workflow runs
without an explicit request. Merge gating stays local and fail-closed: the git
hooks above on every commit/push, `npm run agent:check` for impact-scoped loops,
and a green `npm run verify` plus an independent review before merge — a green
CI build lane does not substitute for that.

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

## GitHub connector and Git stack hygiene

Use the GitHub connector for GitHub API work. Do not use `gh` for
authentication, PR creation, PR inspection, reviews, checks, merging, or stack
publication when the connector is available. The local `git` client is still the
source of truth for commits, rebases, diffs, hooks, and pushing refs.

Before publishing a stack:

1. Inspect `git status`, the complete diff, and the current branch ancestry.
   Preserve unrelated user changes and stage explicit paths only.
2. Fetch the latest `origin/main`, then rebase the lowest feature branch onto
   it. Rebase each child branch onto its immediate parent, preserving one
   logical change per incremental commit.
3. Verify each branch has the intended unique commits with
   `git log <base>..<branch>` and verify the exact remote head after pushing. Do
   not infer GitHub PR existence or freshness from local remote-tracking refs;
   query the GitHub connector.
4. Create or update one draft PR per branch through the connector, specifying
   exactly one base/head pair. Inspect checks and reviews bottom-up, then
   squash-merge bottom-up only after the required local gates and independent
   review are green.

Never force-push a rebased stack unless the user explicitly authorizes that
exact operation. If a branch was rewritten and cannot be updated normally, stop
with the precise non-fast-forward blocker. Invalid CLI credentials are not
evidence that GitHub is unavailable when the connector can authenticate.
