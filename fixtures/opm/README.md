# Offline opm fixtures

Real installable packages for `opm` / `opmx` offline tests and
`examples/opm-project`.

| File                  | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `demo-tool-1.1.0.tgz` | npm-style tarball with `bin.demo-tool`                        |
| `catalog.json`        | Catalog entries (digest + source) for resolve without network |

Regenerate the tarball if you change package contents (update digests in
`catalog.json` to match `sha256sum demo-tool-1.1.0.tgz`).
