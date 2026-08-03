# OpenPacker

**Package control plane CLI and reference service** for multi-ecosystem
resolution: pin locks, look up packages, solve graphs, prove digests.

OpenPacker is **not** `npm install`. It does not replace Cargo, pip, NuGet, or
Go. It normalizes package identity, captures or solves dependency selections,
and writes portable digests you can audit in CI.

|                               |                                              |
| ----------------------------- | -------------------------------------------- |
| **CLI cookbook (start here)** | **[docs/guides/cli.md](docs/guides/cli.md)** |
| **CLI sample inputs**         | [examples/cli/](examples/cli/)               |
| **Protocol**                  | [spec/prex/v1/](spec/prex/v1/)               |
| **License**                   | [MIT](LICENSE)                               |

---

## Using the CLI (what you actually type)

### 1. Build and start the local service

```sh
npm ci
npm run build

npx openpacker serve \
  --universe fixtures/epoch/universe.json \
  --host 127.0.0.1 \
  --port 7337
```

In another terminal:

```sh
export OPENPACKER_URL=http://127.0.0.1:7337
```

### 2. Normalize / look up packages

```sh
# Canonicalize a messy PURL
npx openpacker normalize 'pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0' --json

# Find the package for a base PURL
npx openpacker identify 'pkg:npm/%40openpacker/demo-tool' --json

# List versions in the loaded catalog
npx openpacker enumerate 'pkg:npm/%40openpacker/demo-tool' --json

# Inspect one exact version
npx openpacker inspect 'pkg:npm/%40openpacker/demo-tool@1.1.0' --json
```

### 3. Pin a native lockfile (most common workflow)

Import what npm/Cargo/NuGet/uv/Go/Gradle already locked. OpenPacker records the
selection as **`native-capture-v1`** (it does **not** pretend it re-solved the
graph).

```sh
# Cargo
npx openpacker import-lock \
  --input fixtures/locks/cargo/Cargo.lock \
  --format cargo-lock \
  --json \
  --output cargo.openpacker.json

# npm package-lock v3
npx openpacker import-lock \
  --input fixtures/locks/npm/package-lock.json \
  --format package-lock \
  --json \
  --output npm.openpacker.json

# Show the pins
jq '.lockfile.selectedExactPurls' cargo.openpacker.json
jq '.lockfile.semanticsProfile' cargo.openpacker.json   # → native-capture-v1
jq '.lockfile.solutionDigest' cargo.openpacker.json
```

Same idea for NuGet, PyPI (`uv-lock`), Go (`go-sum`), and Gradle
(`gradle-lockfile`) — full list in [docs/guides/cli.md](docs/guides/cli.md).

### 4. Offline lock import without a daemon

```sh
npm run demo:lock-import
# → .demo-output/lock-import/*.openpacker.lock.json for all six formats
```

### 5. Full offline production-path demo

```sh
npm run demo
# solve + proof + OCI + trust + materialize + mise evidence under .demo-output/
```

### 6. Copy-paste sample inputs

```sh
npx openpacker normalize --input examples/cli/normalize.json --json
npx openpacker identify --input examples/cli/identify.json --json
npx openpacker enumerate --input examples/cli/enumerate.json --json
npx openpacker inspect --input examples/cli/inspect.json --json
```

More recipes (export lock, SBOM, verify, materialize, solve, mise):  
→ **[docs/guides/cli.md](docs/guides/cli.md)**

---

## What OpenPacker is for

| You need                                                     | Use                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Pin `package-lock.json` / `Cargo.lock` / … for audit digests | `openpacker import-lock`                                              |
| Canonical package URLs across ecosystems                     | `openpacker normalize`                                                |
| Deterministic cross-ecosystem solve + proof                  | `openpacker solve` / `npm run demo`                                   |
| Tool binary install into a prefix                            | mise backend → [docs/integrations/mise.md](docs/integrations/mise.md) |
| Actually install npm/Cargo packages into a project           | **still** `npm` / `cargo` / …                                         |

---

## Prerequisites

- Node `^22.13.0 || >=24`, npm 11
- Stable Rust (resolver/WASM)
- Optional: wasm-bindgen-cli `0.2.126`, Playwright, mise `2026.7.13` for full
  demos

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
```

---

## Development gates

```sh
npm run agent:check:staged   # pre-commit (local hooks)
npm run verify               # full offline aggregate when you need it
```

Agent tooling: [AGENTS.md](AGENTS.md). Doc map:
[docs/README.md](docs/README.md).

---

## Protocol boundary (short)

PREX is the vendor-neutral protocol under `spec/prex/v1`. OpenPacker is this
reference CLI/daemon/SDK. Digests identify bytes; names do not. Native archives
are not rewritten. Capture is not an independent solve.
