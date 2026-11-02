# CI optimization (OpenPacker)

This repository uses GitHub’s native merge queue on `main`. The authoritative
merge gate is **Trunk gate / Required merge queue gate**
(`.github/workflows/trunk-gate.yml`).

## Workflow triggers and concurrency

| Workflow               | Triggers                                                            | Concurrency / role                                                          |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `trunk-gate.yml`       | `pull_request`, `merge_group`, `workflow_dispatch`                  | Cancels superseded PR runs; never cancels `merge_group` or `push` to `main` |
| `ci-advisory.yml`      | `pull_request`, `workflow_dispatch`                                 | Same cancel rules (advisory only)                                           |
| `ci-build.yml`         | `push` to `main`, `workflow_dispatch`                               | Does not cancel in-progress runs on `main`                                  |
| `codeql.yml`           | `pull_request`, `merge_group`, weekly schedule, `workflow_dispatch` | Advisory CodeQL (uploads SARIF)                                             |
| `security.yml`         | `pull_request`, `merge_group`, weekly schedule, `workflow_dispatch` | npm/cargo audit + offline security gates                                    |
| `ci.yml`               | `workflow_dispatch` only                                            | Full offline gauntlet (manual); not on every PR                             |
| `cd.yml`               | `workflow_dispatch`, `v*` tags (legacy)                             | Deprecated; use `promote-*.yml`                                             |
| `live-compat.yml`      | `workflow_dispatch` only                                            | Opt-in live registry compatibility                                          |
| `release-evidence.yml` | `workflow_dispatch` only                                            | SBOM/provenance evidence (manual)                                           |

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

Node 22.22.2, Rust 1.88.0, `wasm-bindgen-cli` 0.2.126, and GitHub Actions use
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

## Testcontainers (integration services)

Integration tests that need an OCI distribution registry use
[Testcontainers](https://node.testcontainers.org/) with digest-pinned images
(`tests/support/pinned-container-images.mjs`). Tests skip when Docker is
unavailable so offline `npm run verify` still passes on hosts without Docker.
Manual live-compat (`live-compat.yml`) starts Zot through
`scripts/live-compat/run-with-zot.mjs` instead of ad-hoc `docker run`.

## SHA-pinned GitHub Actions

Third-party `uses:` references resolve to full commit SHAs recorded in
`.github/action-pins.json`. Regenerate workflow pins after bumping an action
tag:

```sh
node scripts/ci/apply-action-pins.mjs
node scripts/ci/apply-action-pins.mjs --check
```

Release-cli and promotion workflows share the same pin catalog as trunk CI.
