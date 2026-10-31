# Releasing

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

## Version bump

```sh
node scripts/sync-workspace-version.mjs 0.0.1-alpha.1
```

The script sets `version` on packages named `@openpacker/*` or `openpacker`, and
sets internal `@openpacker/*` dependency pins to that version. It does not
change `private` or `publishConfig`.
