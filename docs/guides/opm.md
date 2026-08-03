# `opm` / `opmx` — Open Package Manager

This is the **day-to-day package manager** for OpenPacker projects.

| Binary           | Role                                       |
| ---------------- | ------------------------------------------ |
| **`opm`**        | Project package manager (add/install/sync) |
| **`opmx`**       | Execute binaries from the project install  |
| `opkg` / `opkgm` | Aliases for `opm`                          |
| `openpacker`     | Advanced PREX control plane (separate)     |

OpenPacker still ships the PREX control plane
(`openpacker normalize|solve|import-lock|…`). That is **not** what you use to
manage a project’s packages. Use **`opm`**.

---

## Install

From a built checkout:

```sh
npm ci
npm run build

# run via workspace paths
node apps/opm/dist/opm.js --help
node apps/opm/dist/opmx.js --help

# or link bins onto PATH
npm link -w @openpacker/opm
opm --help
opmx --help
```

---

## 60-second project workflow

```sh
mkdir my-app && cd my-app
opm init --name my-app

# Add a package from a local catalog / file source (offline-friendly)
opm add pkg:npm/@openpacker/demo-tool@1.1.0 \
  --source /path/to/demo-tool-1.1.0.tgz \
  --offline

# Or sync everything declared in opm.toml
opm sync --offline

opm list
opmx demo-tool --version
opmx demo-tool hello

opm remove demo-tool
```

Repo offline demo (uses `fixtures/opm`):

```sh
cd examples/opm-project
opm sync --offline
opmx demo-tool --version
```

---

## Project files

```text
my-project/
  opm.toml           # requirements you edit (or opm add/remove)
  opm.lock.json      # exact pins (generated)
  .opm/
    catalog.json     # optional local package catalog
    store/           # content-addressed extracted packages
    bin/             # shims for executables
    links/           # alias → store metadata
    project.json     # installed set
```

### `opm.toml`

```toml
[project]
name = "my-app"
ecosystems = ["npm", "cargo", "pypi"]

[packages.demo-tool]
purl = "pkg:npm/@openpacker/demo-tool"
version = "1.1.0"
source = "file:./vendor/demo-tool.tgz"

[options]
offline = false
layout = "opm"
```

### Specs for `opm add`

| Spec                         | Notes                                   |
| ---------------------------- | --------------------------------------- |
| `pkg:npm/@scope/name@1.2.3`  | Full PURL (preferred)                   |
| `name@1.2.3 --ecosystem npm` | Bare name requires `-e` / `--ecosystem` |
| `… --source ./pkg.tgz`       | Local artifact (offline)                |
| `… --alias tool`             | Override local alias                    |

Bare names are **fail-closed**: `opm add lodash` errors unless you pass
`--ecosystem`.

A spec names the package; it does not fetch it from a public registry. Every add
resolves through a [resolution source](#resolution-sources) — an explicit
`--source` (local file or URL you supply) or a catalog entry. Without one,
`opm add` fails with `UNRESOLVABLE`.

---

## Commands

| Command                   | What it does                                        |
| ------------------------- | --------------------------------------------------- |
| `opm init`                | Create `opm.toml` + `.opm/`                         |
| `opm add <spec>`          | Add to manifest, resolve, lock, install             |
| `opm remove <alias>`      | Drop from manifest + lock + install                 |
| `opm install`             | Materialize lock into `.opm/store` + bins           |
| `opm uninstall [alias]`   | Remove install (manifest/lock kept unless `remove`) |
| `opm sync`                | Resolve manifest → lock → install (idempotent)      |
| `opm update`              | Re-resolve from manifest (v1 = sync)                |
| `opm list`                | Show aliases, PURLs, digests, install status        |
| `opm why <alias>`         | Why a package is present                            |
| `opmx <bin\|pkg> [args…]` | Run an installed executable                         |

### `opmx`

```sh
opmx demo-tool --version
opmx --package demo-tool --bin demo-tool -- --help
```

Resolution order: explicit `--bin` → package primary bin → bin name in
`.opm/bin`.

---

## Resolution sources

These are the **only** ways `opm` resolves a package — online or offline. `opm`
never contacts npm, crates.io, PyPI, NuGet, Maven, or the Go proxy;
registry-backed resolution is a control-plane (`openpacker`) concern. In order:

1. `source = "file:…"` (or an explicit `https:` URL) on the package in
   `opm.toml`
2. `.opm/catalog.json` in the project
3. `OPM_CATALOG` env path
4. Walk-up `fixtures/opm/catalog.json` (repo demos)

Locks record **direct requirements only** — `opm` performs no transitive
dependency resolution or version-range solving; a `^`/`~` range is a hint, not a
constraint the resolver satisfies.

Catalog entry shape (see `fixtures/opm/catalog.json`):

```json
{
  "schemaVersion": 1,
  "packages": {
    "pkg:npm/@openpacker/demo-tool@1.1.0": {
      "purl": "pkg:npm/@openpacker/demo-tool@1.1.0",
      "version": "1.1.0",
      "digest": "sha256:…",
      "size": 406,
      "format": "tar+gzip",
      "mediaType": "application/vnd.npm.package+gzip",
      "source": "file:demo-tool-1.1.0.tgz",
      "bins": [{ "name": "demo-tool", "path": "package/bin/demo-tool.js" }]
    }
  }
}
```

Missing artifacts fail closed with a clear error (no silent network when
`--offline`).

---

## Safety invariants

- Lifecycle scripts (`postinstall`, etc.) are **never** run by default.
- Installs are content-addressed under `.opm/store/sha256-…`.
- Digests are verified before materialize.
- Default layout is **`.opm/`**, not a silent rewrite of `node_modules`.

---

## Related

- PREX / advanced CLI: [cli.md](cli.md) (`openpacker`)
- Dual-surface decision: [ADR 0022](../adr/0022-opm-package-manager-surface.md)
- Offline fixture packages: [`fixtures/opm/`](../../fixtures/opm/)
- Example project: [`examples/opm-project/`](../../examples/opm-project/)
