# Trunk-based release pipeline

`@openpacker/cli` is the only package published to npm. The manual alpha
commands stay in the repository root [RELEASING.md](../RELEASING.md). Tagged
GitHub prereleases are dispatched with
[release-cli.yml](../.github/workflows/release-cli.yml). This document is the
trunk and promotion pipeline: merge queue on `main`, a scheduled nightly, then
fast-forward promotion to `integration` and `prod`.

The legacy [cd.yml](../.github/workflows/cd.yml) workflow is deprecated. Do not
add triggers to it. New releases use the `promote-*.yml` workflows below.

## Flow

```mermaid
flowchart LR
  dev[Pull request]
  queue[Merge queue]
  main[main]
  sched[Nightly schedule 06:00 UTC]
  nightlyBr[nightly branch]
  integration[integration branch]
  prod[prod branch]
  tagNightly["dist-tag nightly"]
  tagNext["dist-tag next"]
  tagAlpha["dist-tag alpha"]
  tagLatest["dist-tag latest"]

  dev --> queue --> main
  main --> sched --> nightlyBr
  nightlyBr --> tagNightly
  nightlyBr --> integration
  integration --> tagNext
  integration --> tagAlpha
  integration --> prod
  prod --> tagLatest
```

| Stage       | Git ref       | Workflow                                                                | npm dist-tag                           |
| ----------- | ------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| Merge       | `main`        | [trunk-gate.yml](../.github/workflows/trunk-gate.yml)                   | none                                   |
| Nightly     | `nightly`     | [promote-nightly.yml](../.github/workflows/promote-nightly.yml)         | `nightly`                              |
| Integration | `integration` | [promote-integration.yml](../.github/workflows/promote-integration.yml) | `next` and `alpha` on the same version |
| Production  | `prod`        | [promote-prod.yml](../.github/workflows/promote-prod.yml)               | `latest`                               |

`main` moves only through the merge queue. `nightly`, `integration`, and `prod`
move by fast-forward to a commit that is already on the previous stage.
Promotion workflows do not force-push.
[release-cli.yml](../.github/workflows/release-cli.yml) publishes from `main`
and pushes a tag only. It does not fast-forward those branches.

## Merge queue

Pull requests targeting `main` run
[ci-advisory.yml](../.github/workflows/ci-advisory.yml). That job is fast
(format and anti-slop lint on Ubuntu with Node 22) and is not a required check.
Its job summary says the merge queue runs Trunk gate.

The only required status check is:

```text
Trunk gate / Required merge queue gate
```

That string is the workflow name, a slash, and the job name from
[trunk-gate.yml](../.github/workflows/trunk-gate.yml). The same job runs on
`merge_group` and on `pull_request` targeting `main`, with
`OPENPACKER_OFFLINE=1` and `SOURCE_DATE_EPOCH=1785628800`, in this order:

1. `npm run format:check`
2. `npm run lint:anti-slop`
3. `npm run typecheck`
4. `npm run build`
5. `npm test` (root unit gate)
6. `npm test --workspace @openpacker/cli -- test/release-bundle.test.ts`

Node is 22.19.0, Rust is 1.88.0 with the `wasm32-unknown-unknown` target, and
`wasm-bindgen-cli` 0.2.126 is cached the same way as
[ci-build.yml](../.github/workflows/ci-build.yml). The composite
[openpacker-build](../.github/actions/openpacker-build/action.yml) action
performs that setup for other jobs. Its `node-version` input defaults to
`22.19.0`.

After the squash merge lands on `main`,
[ci-build.yml](../.github/workflows/ci-build.yml) builds the OS and Node matrix
and uploads pack artifacts. It does not run on pull requests.

## Nightly

[promote-nightly.yml](../.github/workflows/promote-nightly.yml) runs at 06:00
UTC (`0 6 * * *`) and on `workflow_dispatch`. The job uses the GitHub
Environment `nightly`.

It checks out `main` with full history and skips when `HEAD` has no commits
after the newest tag matching `cli-v*-nightly.*`. Otherwise it runs
`npm run build` before `npm run verify` and `npm run test:integration`, then
publishes. Promotion workflows run `npm run build` before `npm run verify`
because verify begins with `check:contracts`.

The npm version is planned by
`node scripts/release/plan-cli-release.mjs --mode nightly`. The workflow passes
`--sha` as the 7-character checkout SHA and `RELEASE_STAMP` as UTC `YYYYMMDD`.
The stable triplet is the `apps/openpacker-cli/package.json` version with the
prerelease removed. `0.0.1-alpha.1` on 2026-10-31 becomes
`0.0.1-nightly.20261031`. The bundle reads that string from
`OPENPACKER_RELEASE_VERSION`. The npm version has no `+build` metadata.

Publish uses
[publish-openpacker-cli](../.github/actions/publish-openpacker-cli/action.yml)
from `apps/openpacker-cli/release`. The action installs npm 11.21.1 because Node
22.19.0's bundled npm cannot move dist-tags with OIDC.

When `NPM_TOKEN` is set, that token is `NODE_AUTH_TOKEN` for the publish command
only:

```sh
npm publish --provenance --access public --tag nightly
```

An empty `NPM_TOKEN` writes an `.npmrc` with no `_authToken` line, leaves
`NODE_AUTH_TOKEN` unset, and publishes without `--provenance`. npm then attaches
provenance through OIDC trusted publishing, which runs while provenance is still
the default. Before `npm dist-tag add`, the workflow runs the same action with
`publish: false`. That step installs npm 11.21.1 and exports
`NPM_CONFIG_USERCONFIG` through `GITHUB_ENV`. The dist-tag step uses that
userconfig and does not rewrite it.

The workflow packs the tarball, publishes, points the `nightly` dist-tag at that
version, creates the git tag from the plan (`cli-v${VERSION}`), pushes that tag,
fast-forwards `nightly` with `git push origin SHA:refs/heads/nightly`, and opens
a GitHub prerelease with `gh release create --target` set to that commit. It
then mirrors the same directory to GitHub Packages. The release title records
the short SHA as `(+SHORT_SHA)`. See
[GitHub Releases and npm auth](#github-releases-and-npm-auth).

Leave the `nightly` environment without required reviewers so the schedule can
finish. Restrict deployment branches to `main` if you set a branch policy. The
schedule runs the workflow on `main`.

## Integration

[promote-integration.yml](../.github/workflows/promote-integration.yml) accepts
`workflow_dispatch` input `nightly_sha` and also listens for a successful
`workflow_run` of Promote nightly. The run is skipped when that SHA is already
the `integration` tip.

`nightly_sha` must be an ancestor of the `nightly` tip. The workflow then runs:

- a matrix of `ubuntu-latest`, `windows-latest`, and `macos-latest` against Node
  `22.19.0` and `24`: `npm ci`, `npm run build`, `npm run test:integration`,
  `npm run test:e2e`, and `npm run test:conformance`
- an Ubuntu supply-chain job: `npm run check:licenses`,
  `npm run security:codex:dry-run` when the reviewed `codex-security` CLI is
  installed, otherwise the in-repo equivalent (`npm run security:codex:test` and
  `npm run test:security`), gitleaks, and `npm audit --audit-level=high` on the
  release bundle's external dependencies

The publish job uses the GitHub Environment `integration`. It bundles the same
nightly version and does not run `npm publish`. Nightly already published that
version. The job calls
[publish-openpacker-cli](../.github/actions/publish-openpacker-cli/action.yml)
with `publish: false` so the runner has npm 11.21.1 and an OIDC-safe npmjs
userconfig, requires the version to exist on the registry, then runs:

```sh
npm dist-tag add @openpacker/cli@${VERSION} next
npm dist-tag add @openpacker/cli@${VERSION} alpha
```

If the version is missing, the job fails and asks for the nightly publish first.
`next` and `alpha` point at the nightly version that just passed the matrix. The
job then fast-forwards `integration` to `nightly_sha` and refuses a
non-fast-forward. It does not publish to GitHub Packages.

## Production

[promote-prod.yml](../.github/workflows/promote-prod.yml) runs only on
`workflow_dispatch` with a required `integration_sha`. It has no `push` trigger.
The GitHub Environment `production` must require Tyler as a reviewer. GitHub
stores that reviewer on the environment; the workflow file cannot name the
person.

`integration_sha` must be the current tip of `integration`, and `prod` must be
an ancestor of that commit when `prod` already exists. The promotion job then
runs, in order:

1. `npm run verify`
2. [changelog-entry-check.mjs](../scripts/release/changelog-entry-check.mjs)
3. [semver-gate.mjs](../scripts/release/semver-gate.mjs) `--prod`
4. [npm-pack-gate.mjs](../scripts/release/npm-pack-gate.mjs)
5. `npm sbom --sbom-format cyclonedx`
6. `npm audit --audit-level=high` on the workspace and on the release bundle
7. `semver-gate.mjs --no-prerelease-deps` on
   `apps/openpacker-cli/release/package.json`
8. `actions/attest-build-provenance` on the release tarball
9. fast-forward `prod` to `integration_sha`
10. `npm publish --provenance --access public --tag latest`

`--prod` rejects a prerelease. The version published to `latest` is the version
committed in `apps/openpacker-cli/package.json`, not the nightly override. Bump
that field to a stable semver (for example `0.1.0`), add a matching changelog
heading, merge it through the queue, promote that commit through nightly and
integration, and only then dispatch production.

A production environment deployment-branch rule must allow `main`. Dispatch runs
the workflow file from `main`. Limiting the environment to the `prod` branch
blocks the job.

## Release scripts

| Script                                                                    | Behavior                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [changelog-entry-check.mjs](../scripts/release/changelog-entry-check.mjs) | Fails when `CHANGELOG.md` has no `##` heading for the current CLI version                        |
| [semver-gate.mjs](../scripts/release/semver-gate.mjs)                     | Validates semver. `--prod` rejects a prerelease. `--no-prerelease-deps` reads a release manifest |
| [npm-pack-gate.mjs](../scripts/release/npm-pack-gate.mjs)                 | Bundles, packs, and requires `files` to be `["dist"]` with no `@openpacker` dependencies         |
| [plan-cli-release.mjs](../scripts/release/plan-cli-release.mjs)           | Plans the npm version, git tag, and GitHub Release title. The npm version has no `+build`        |
| [apply-trunk-ruleset.mjs](../scripts/github/apply-trunk-ruleset.mjs)      | Creates or updates the repository rulesets below                                                 |

```sh
npm run ruleset:apply
```

`apps/openpacker-cli/scripts/bundle-release.mjs` writes
`process.env.OPENPACKER_RELEASE_VERSION` into `release/package.json` when that
variable is set. Otherwise it uses the CLI package version.

## Rulesets

`npm run ruleset:apply` calls the GitHub API as the current `gh` user. A 403
means the token is missing Administration permission. The script prints the
token setup steps. Create a fine-grained token for `OpenPacker-Labs/OpenPacker`
with Administration read/write and Metadata read, then run `gh auth login` and
`npm run ruleset:apply`.

| Ruleset             | Branch        | Effect                                                                                                     |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `trunk-main`        | `main`        | Squash merge queue, no force push, no deletion. Required check `Trunk gate / Required merge queue gate`    |
| `trunk-integration` | `integration` | Updates, deletions, and force pushes require a repository admin bypass. Pull requests from `main` included |
| `trunk-prod`        | `prod`        | Same admin-only update rule as `integration`                                                               |

The admin bypass uses repository role id `5` (`RepositoryRole`). Writers cannot
push or merge into `integration` or `prod`. Promotion workflows fast-forward
those branches with a dedicated GitHub App token (see **Release GitHub App**
below), not with the default `GITHUB_TOKEN`.

When you run `npm run ruleset:apply`, set `OPENPACKER_RELEASE_APP_ID` to that
App’s numeric id so `trunk-integration` and `trunk-prod` include the App as an
`Integration` bypass actor. Do not add the built-in GitHub Actions integration
(`actor_id` `15368`); GitHub refused that bypass on this repository.

Merge queue settings on `main`: squash, `ALLGREEN`, status-check timeout 60
minutes, build concurrency 5. Pull requests use squash as the only merge method.
Admins are not bypass actors on `main`, so the queue and Trunk gate apply to
them too.

## GitHub environments

Create these environments on
`https://github.com/OpenPacker-Labs/OpenPacker/settings/environments`. Names are
case-sensitive and must match the workflow `environment:` keys.

| Environment   | Required reviewers                          | Deployment branches                                         |
| ------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `nightly`     | none, so the 06:00 UTC schedule can publish | `main`, or all branches                                     |
| `integration` | optional                                    | `main`, because dispatch and `workflow_run` use `main`      |
| `production`  | Tyler                                       | `main`, because `workflow_dispatch` runs the file on `main` |

`production` is shared with the deprecated `cd.yml` production job. A required
reviewer there also gates that legacy tag path.

## Release GitHub App (one-time, Tyler)

GitHub refused the built-in GitHub Actions ruleset bypass (`Integration`
`actor_id` `15368`) on `integration` and `prod`. Only repository admins could
push those branches until a dedicated App bypasses the rulesets.

1. **Create a GitHub App** (OpenPacker-Labs organization → Settings → Developer
   settings → GitHub Apps → New GitHub App). Suggested name:
   `OpenPacker Release`. Set **Repository permissions → Contents** to **Read and
   write**. Webhooks are not required for promotion.
2. Note the **App ID** on the app’s About page. Generate and download a
   **private key** (`.pem`).
3. **Install the app** on `OpenPacker-Labs/OpenPacker` only (Install App →
   OpenPacker-Labs → Only select repositories → OpenPacker).
4. Add repository **Actions secrets** on
   `https://github.com/OpenPacker-Labs/OpenPacker/settings/secrets/actions`:
   - `OPENPACKER_RELEASE_APP_ID` — the App ID (digits only)
   - `OPENPACKER_RELEASE_APP_KEY` — the full private key PEM (including
     `BEGIN`/`END` lines)
5. Re-apply rulesets so the App is a bypass actor on `integration` and `prod`:

   ```sh
   export OPENPACKER_RELEASE_APP_ID=<app-id>
   npm run ruleset:apply
   ```

[promote-integration.yml](../.github/workflows/promote-integration.yml) and
[promote-prod.yml](../.github/workflows/promote-prod.yml) call
`actions/create-github-app-token` with those secrets immediately before the
fast-forward `git push`.

## GitHub Releases and npm auth

npm versions from these workflows are semver without `+build`. npm strips build
metadata, so `0.0.1-alpha.1+abc1234` would be stored as `0.0.1-alpha.1`. The
short git SHA (7 hex characters) is build metadata in the GitHub Release title
and notes: `cli 0.0.1-alpha.1 (+abc1234)`.
`node scripts/release/plan-cli-release.mjs` prints `version`, `tag`,
`release_title`, `short_sha`, `npm_dist_tag`, and `also_github_packages`.

### Release CLI

[release-cli.yml](../.github/workflows/release-cli.yml) is `workflow_dispatch`
only. The input `skip_verify` defaults to false. The job uses the `integration`
environment, checks out `main`, and does not fast-forward `nightly`,
`integration`, or `prod`.

It plans an alpha release from `apps/openpacker-cli/package.json` (the version
must be a prerelease), runs `npm run build` before `npm run verify` unless
`skip_verify` is true, bundles with `OPENPACKER_RELEASE_VERSION`, packs the
tarball, and publishes on the `alpha` dist-tag. Promotion workflows run
`npm run build` before `npm run verify` because verify begins with
`check:contracts`. Release and promotion jobs set `TURBO_CONCURRENCY=1` (same as
[trunk-gate.yml](../.github/workflows/trunk-gate.yml)) so long `@openpacker/opm`
contract tests are not starved while turbo runs the rest of the monorepo.
`apps/opm/vitest.config.ts` runs opm contract files serially for the same
reason. `npm run coverage` uses a single vitest worker so V8 precise-coverage
snapshots merge deterministically before the 100% per-workspace file gate. A
non-empty `NPM_TOKEN` passes `--provenance`. An empty token leaves provenance at
the default so OIDC can attach it. It then points `alpha` and `next` at that
version. It does not set `latest`. It creates the git tag from the plan
(`cli-v${version}`), pushes that tag, and opens a GitHub prerelease with
`gh release create --target` set to the planned commit. The title comes from the
plan. The pack tarball is attached. If the release already exists, the tarball
is uploaded with `--clobber`. It then mirrors the same directory to GitHub
Packages. If the version is already on a registry, publish is skipped and that
step still succeeds.

### NPM_TOKEN (one-time, Tyler)

OIDC trusted publishing is the path when the `NPM_TOKEN` repository secret is
absent. Until the trusted publishers below exist, create that secret:

1. On npm, as a publisher of `@openpacker/cli`, create either an **Automation**
   token or a **granular** access token that can publish `@openpacker/cli`.
2. Add it at
   `https://github.com/OpenPacker-Labs/OpenPacker/settings/secrets/actions` as
   `NPM_TOKEN`.
3. [publish-openpacker-cli](../.github/actions/publish-openpacker-cli/action.yml)
   writes `NPM_CONFIG_USERCONFIG` under `RUNNER_TEMP`. A non-empty token stores
   the placeholder `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`. The
   publish step exports `NODE_AUTH_TOKEN` for that command only and runs
   `npm publish --provenance`. The token is never printed and is never written
   to `GITHUB_ENV`.
4. An empty token stores only `registry=https://registry.npmjs.org/`, unsets
   `NODE_AUTH_TOKEN`, and publishes without `--provenance` so OIDC can attach
   provenance. These jobs do not pass `registry-url` to `actions/setup-node`.
   That input writes an `_authToken` line and exports a placeholder
   `NODE_AUTH_TOKEN`, and npm then skips the OIDC exchange. Each
   `npm dist-tag add` step is preceded by another call to the action with
   `publish: false`, which rewrites `NPM_CONFIG_USERCONFIG` for that command.
   The dist-tag step sets `NODE_AUTH_TOKEN` from `NPM_TOKEN` for that step only,
   so a non-empty token fills the placeholder and an empty token leaves OIDC in
   charge.

`release-cli` and nightly pass `secrets.NPM_TOKEN` into that action and publish.
Integration passes the same secret only so `npm dist-tag add` can authenticate.
Production does not read `NPM_TOKEN`. Jobs that publish or move dist-tags set
`id-token: write`. The action installs npm 11.21.1 so dist-tag commands can use
OIDC (npm 11.21.0 or newer).

### Trusted publishing later

When a trusted publisher exists for each workflow in the tables below, delete
the `NPM_TOKEN` secret. An empty secret keeps the OIDC path. Allow direct
`npm publish` on `release-cli`, nightly, and production. Allow dist-tag changes
on `release-cli`, nightly, and integration. npm documents dist-tag OIDC from npm
11.21.0. Add `release-cli.yml` with environment `integration` alongside the
promotion workflows.

### GitHub Packages

`release-cli` and nightly promotion mirror the same release directory to GitHub
Packages (`https://npm.pkg.github.com`) with `GITHUB_TOKEN` after the git tag
and GitHub Release exist. Those jobs set `packages: write`. The package is
listed on the repository **Packages** page. A package linked by the `repository`
field inherits that repository's access; adjust visibility on the package page
if the first publish is private. The manifest name stays `@openpacker/cli`.
GitHub expects the npm scope to match the repository owner (`@openpacker-labs`).
The workflow still publishes this manifest to that registry. A version already
on a registry is skipped. Integration promotion does not publish to GitHub
Packages.

### Dist-tags

| Dist-tag  | Who moves it                                                                                                  | Left unchanged by             |
| --------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `alpha`   | `release-cli` (the package prerelease) and `promote-integration` (the nightly version that passed the matrix) | production                    |
| `next`    | same publishers as `alpha`                                                                                    | production                    |
| `nightly` | `promote-nightly`                                                                                             | `release-cli` and integration |
| `latest`  | `promote-prod` only                                                                                           | every prerelease workflow     |

`release-cli` publishes the package prerelease and moves `alpha` and `next`.
Integration moves `alpha` and `next` onto the nightly version and does not
publish. The last successful dist-tag update wins. Neither workflow sets
`latest`.

## npm trusted publishing

Add one trusted publisher per workflow on
`https://www.npmjs.com/package/@openpacker/cli/access` under **Trusted
Publisher**. Choose **GitHub Actions**. Enter only the workflow filename, not
`.github/workflows/`. npm does not check the values when you save them. This is
the long-term auth path. Until it is saved, the `NPM_TOKEN` fallback in
[GitHub Releases and npm auth](#github-releases-and-npm-auth) publishes
`release-cli` and nightly, and authenticates integration dist-tag moves. Do not
put `NPM_TOKEN` in the production workflow. `release-cli`, nightly, and
integration configure the npmjs registry in
[publish-openpacker-cli](../.github/actions/publish-openpacker-cli/action.yml)
and do not pass `registry-url` to `actions/setup-node`. Production still calls
`actions/setup-node` with `registry-url: https://registry.npmjs.org` and passes
`--provenance` on `npm publish`. Each of these jobs has `id-token: write`.

Provenance stays on public repositories. This repository is
`OpenPacker-Labs/OpenPacker`.

Allow **direct `npm publish`** on `release-cli`, nightly, and production. npm
stage publish is not used. `release-cli`, nightly, and integration run
`npm dist-tag add`, so those publishers must be allowed to manage dist-tags.

### release-cli.yml

| Field                | Value             |
| -------------------- | ----------------- |
| Organization or user | `OpenPacker-Labs` |
| Repository           | `OpenPacker`      |
| Workflow filename    | `release-cli.yml` |
| Environment name     | `integration`     |

### promote-nightly.yml

| Field                | Value                 |
| -------------------- | --------------------- |
| Organization or user | `OpenPacker-Labs`     |
| Repository           | `OpenPacker`          |
| Workflow filename    | `promote-nightly.yml` |
| Environment name     | `nightly`             |

### promote-integration.yml

| Field                | Value                     |
| -------------------- | ------------------------- |
| Organization or user | `OpenPacker-Labs`         |
| Repository           | `OpenPacker`              |
| Workflow filename    | `promote-integration.yml` |
| Environment name     | `integration`             |

### promote-prod.yml

| Field                | Value              |
| -------------------- | ------------------ |
| Organization or user | `OpenPacker-Labs`  |
| Repository           | `OpenPacker`       |
| Workflow filename    | `promote-prod.yml` |
| Environment name     | `production`       |

Publish from `apps/openpacker-cli/release` after
`npm run bundle --workspace @openpacker/cli`. The release manifest lists
external npm dependencies only. Workspace packages are inlined into `dist`.
