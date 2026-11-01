# CI optimization (OpenPacker)

This repository uses GitHub’s native merge queue on `main`. The authoritative
merge gate is **Trunk gate / Required merge queue gate**
(`.github/workflows/trunk-gate.yml`).

## Workflow triggers and concurrency

| Workflow          | Triggers                                           | Concurrency                                                                 |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `trunk-gate.yml`  | `pull_request`, `merge_group`, `workflow_dispatch` | Cancels superseded PR runs; never cancels `merge_group` or `push` to `main` |
| `ci-advisory.yml` | `pull_request`, `workflow_dispatch`                | Same cancel rules (advisory only)                                           |
| `ci-build.yml`    | `push` to `main`, `workflow_dispatch`              | Does not cancel in-progress runs on `main`                                  |

## Affected-only Turbo on pull requests

On `pull_request`, typecheck, build, and workspace tests run through
`scripts/ci/run-scoped-turbo.mjs` with:

```text
turbo ... --filter=...[origin/$GITHUB_BASE_REF]
```

That comparison ref is the stack parent branch for stacked PRs. Changes under
repo-wide paths (`scripts/`, `spec/prex/`, `tests/`, `.github/`, root lockfiles,
and similar) expand back to a **full** monorepo gate automatically.

The **full** gate still runs in the merge queue (`merge_group`) and on `push` to
`main` (`ci-build.yml`).

To force a full monorepo run on a PR workflow re-run, set repository variable or
job env `OPENPACKER_CI_FULL=1`.

## Turbo remote cache (optional, Vercel free tier)

When configured, CI sets `TURBO_TOKEN` and `TURBO_TEAM` for Vercel Remote Cache.
Fork pull requests use read-only remote cache. Without those secrets, CI falls
back to `actions/cache` on `.turbo/cache`.

**One-time setup (repo admin):**

1. Link the monorepo to a Vercel team (Turbo remote cache — free tier is
   sufficient for this use case).
2. Create a Turbo remote cache token for CI.
3. Add GitHub Actions secret `TURBO_TOKEN` and repository variable `TURBO_TEAM`
   (team slug).

Never print tokens in logs. Fork PRs cannot write to the remote cache.

## Local / agent signoff (non-authoritative)

Optional local attestation before push:

```sh
# https://github.com/basecamp/gh-signoff
gh extension install basecamp/gh-signoff
gh signoff
```

This does not replace CI. Trunk gate and `npm run verify` before release remain
authoritative.

## Toolchain pins

Node 22.19.0, Rust 1.88.0, `wasm-bindgen-cli` 0.2.126, and GitHub Actions use
pinned versions in workflow files. Install dependencies with `npm ci`.

## Dev container

`.devcontainer/` provides a pinned Node + Rust environment aligned with CI for
Codespaces or VS Code Dev Containers. It does not replace the merge queue gate.

## CLI runtime container

The publishable `@openpacker/cli` bundle has a multi-stage runtime image at
`apps/openpacker-cli/Dockerfile` (digest-pinned Node base, non-root `65532`
user). Build from the repository root:

```sh
docker build -f apps/openpacker-cli/Dockerfile -t openpacker-cli:local .
docker run --rm openpacker-cli:local --help
```
