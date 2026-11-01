# Releasing

Trunk-based promotion (merge queue, nightly, integration, and production) is
documented in [docs/RELEASING.md](docs/RELEASING.md). Tagged CLI prereleases are
dispatched with
[.github/workflows/release-cli.yml](.github/workflows/release-cli.yml).

`@openpacker/cli` is the only package published to npm. Every other workspace
under `apps/`, `packages/`, and `examples/` is private. The published artifact
is the esbuild bundle in `apps/openpacker-cli/release`: workspace sources are
inlined, and the bundle's `package.json` declares the external npm dependencies.

Install the alpha:

```sh
npm i -g @openpacker/cli@alpha
```

## Publish

Sign in to npm with a passkey (trusted publishing). Never publish this
prerelease on the `latest` dist-tag.

```sh
npm ci && npm run build && npm run bundle --workspace @openpacker/cli
cd apps/openpacker-cli/release && npm publish --tag alpha --access public
```

`node scripts/npm-publish-alpha-order.mjs` prints those commands and does not
publish.

## GitHub release

Dispatch [Release CLI](.github/workflows/release-cli.yml) (`workflow_dispatch`)
to tag `main`, publish the alpha with provenance, and open a GitHub prerelease
with the npm pack tarball. The npm version stays semver without `+build`. The
short git SHA is in the release title, for example
`cli 0.0.1-alpha.1 (+abc1234)`. The workflow moves `alpha` and `next`. It does
not move `latest` and it does not fast-forward `nightly`, `integration`, or
`prod`.

`NPM_TOKEN` (an npm Automation token, or a granular token that can publish
`@openpacker/cli`) is the registry fallback until trusted publishing is
configured. When that secret is set, publish passes `--provenance`. When it is
empty, publish leaves `--provenance` at the default and npm attaches provenance
with OIDC. GitHub Packages for that release show under the repository Packages
page. Details are in
[docs/RELEASING.md](docs/RELEASING.md#github-releases-and-npm-auth).

## Version bump

```sh
node scripts/sync-workspace-version.mjs 0.0.1-alpha.1
```

The script sets `version` on packages named `@openpacker/*` or `openpacker`, and
sets internal `@openpacker/*` dependency pins to that version. It does not
change `private` or `publishConfig`.
