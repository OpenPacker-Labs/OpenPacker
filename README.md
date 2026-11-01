# OpenPacker

[![Build](https://github.com/OpenPacker-Labs/OpenPacker/actions/workflows/ci-build.yml/badge.svg)](https://github.com/OpenPacker-Labs/OpenPacker/actions/workflows/ci-build.yml)
[![Pages](https://github.com/OpenPacker-Labs/OpenPacker/actions/workflows/pages.yml/badge.svg)](https://github.com/OpenPacker-Labs/OpenPacker/actions/workflows/pages.yml)

**Open Package Manager (`opm` / `opmx`)** plus a **PREX control plane** for
multi-ecosystem package identity, locks, proofs, and digests.

**Status:** Private reference implementation of the PREX draft. This is not a
production package registry.

**AI usage:** Maintainers and contributors may use AI coding tools under human
review. See
[CONTRIBUTING.md](https://github.com/OpenPacker-Labs/.github/blob/main/CONTRIBUTING.md#ai-assisted-contributions).

|                                  |                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project site / releases**      | [OpenPacker Pages](https://openpacker-labs.github.io/OpenPacker/)                                                                                                                                       |
| **Package manager (start here)** | **[docs/guides/opm.md](docs/guides/opm.md)**                                                                                                                                                            |
| **Example project**              | [examples/opm-project/](examples/opm-project/)                                                                                                                                                          |
| **PREX control plane (`opm …`)** | [docs/guides/opm.md#prex-control-plane](docs/guides/opm.md#prex-control-plane)                                                                                                                          |
| **Protocol**                     | [spec/prex/v1/](spec/prex/v1/)                                                                                                                                                                          |
| **License**                      | [MIT](LICENSE)                                                                                                                                                                                          |
| **Community**                    | [Code of Conduct](https://github.com/OpenPacker-Labs/.github/blob/main/CODE_OF_CONDUCT.md) · [Governance](GOVERNANCE.md) · [Security](https://github.com/OpenPacker-Labs/.github/blob/main/SECURITY.md) |

---

## Package manager: `opm` and `opmx`

This is the product surface for **add / remove / sync / install / uninstall**
and **running** installed package binaries.

> **Scope:** after the project explicitly enables the npm adapter in `opm.toml`
> (`project.ecosystems = ["npm"]`), `opm add pkg:npm/lodash@4.17.21` resolves
> against the real registry, verifies the bytes, and locks the proof-checked
> closure. `--offline` refuses the network. Explicit `source =` / catalog
> entries win when present. See
> [docs/guides/opm.md](docs/guides/opm.md#resolution-sources) for the full
> order.

```sh
npm ci
npm run build
npm link -w @openpacker/cli   # puts opm, opmx, opkg, opkgm on PATH

mkdir my-app && cd my-app
opm init
opm add pkg:npm/@openpacker/demo-tool@1.1.0 \
  --source /path/to/demo-tool-1.1.0.tgz \
  --offline
opm list
opmx demo-tool --version
```

### Offline demo in this repo

```sh
npm ci && npm run build
cd examples/opm-project
node ../../apps/openpacker-cli/dist/opm.js sync --offline
node ../../apps/openpacker-cli/dist/opm.js list
node ../../apps/openpacker-cli/dist/opmx.js demo-tool --version
# → 1.1.0
```

| Command                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `opm init`              | Create `opm.toml` + `.opm/`                |
| `opm import --native`   | Ingest native manifests into `opm.toml`    |
| `opm add <spec>`        | Add package to manifest, lock, and install |
| `opm remove <alias>`    | Remove from manifest, lock, and install    |
| `opm install`           | Materialize everything in `opm.lock.json`  |
| `opm ci`                | Install exactly `package-lock.json`        |
| `opm uninstall [alias]` | Remove install links/bins                  |
| `opm sync`              | Resolve manifest → lock → install          |
| `opm list` / `opm why`  | Inspect the project graph                  |
| `opm run [script]`      | Run a `package.json` script (unsandboxed)  |
| `opm exec <bin>`        | Run a `node_modules/.bin` executable       |
| `opm -r run <script>`   | Run it in workspace members (`--filter`)   |
| `opmx <bin\|pkg>`       | Execute an installed binary                |

Project layout:

```text
opm.toml          # requirements
opm.lock.json     # exact pins + digests
.opm/store/       # content-addressed packages
.opm/bin/         # executable shims
```

Full manual: **[docs/guides/opm.md](docs/guides/opm.md)** · ADR:
[0022](docs/adr/0022-opm-package-manager-surface.md)

Aliases: **`opkg`**, **`opkgm`** → `opm`.

---

## Advanced: PREX control plane

For protocol operations (normalize, solve, import-lock, prove digests) use the
same **`opm`** binary with PREX verbs — not the project-manager commands above.

```sh
npx opm serve \
  --universe fixtures/epoch/universe.json \
  --host 127.0.0.1 --port 7337

export OPENPACKER_URL=http://127.0.0.1:7337
npx opm normalize 'pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0' --json
npx opm import-lock --input fixtures/locks/cargo/Cargo.lock \
  --format cargo-lock --json --output cargo.openpacker.json
```

Recipes:
**[docs/guides/opm.md#prex-control-plane](docs/guides/opm.md#prex-control-plane)**
· samples: [examples/cli/](examples/cli/)

```sh
npm run demo:lock-import   # offline native lock import
npm run demo               # offline demo of the production path, fixtures only
```

---

## What to use when

| You need                                              | Use                                                    |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Manage packages in a project (add/install/run)        | **`opm` / `opmx`**                                     |
| Capture `package-lock.json` / `Cargo.lock` selections | `opm import-lock`                                      |
| Canonical package URLs across ecosystems              | `opm normalize`                                        |
| Deterministic cross-ecosystem solve + proof           | `opm solve` / `npm run demo`                           |
| Tool binary install via mise                          | [docs/integrations/mise.md](docs/integrations/mise.md) |
| Install a vendor's tool from its signed release       | [packslip guide](docs/integrations/packslip.md)        |

---

## Development

Install the alpha CLI with `npm i -g @openpacker/cli@alpha`. Publishing steps
are in [RELEASING.md](RELEASING.md).

```sh
npm ci
npm run build
npm test --workspace @openpacker/opm-project
npm test --workspace @openpacker/cli
npm run agent:check   # local hooks / gates (see org CONTRIBUTING)
```

Architecture and ADRs: [docs/](docs/) · Contributing:
[CONTRIBUTING.md](https://github.com/OpenPacker-Labs/.github/blob/main/CONTRIBUTING.md)
