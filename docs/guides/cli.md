# `openpacker` CLI — PREX control plane recipes

> **Day-to-day package management** (`opm add` / `opm install` / `opmx`) lives
> in **[opm.md](opm.md)**. This page is the **advanced PREX / control-plane**
> CLI.

This guide covers **`openpacker`**: pin locks, look up packages, resolve graphs,
and export digests from the shell.

OpenPacker is a **package control plane** plus an **`opm` project manager**. The
control plane normalizes identity, resolves or captures dependency selections,
proves them, and writes portable digests. It does not claim full command
compatibility with `npm install` / `cargo build` / `pip install`.

---

## Install the CLI

From a built checkout of this repo:

```sh
npm ci
npm run build
# either:
npx openpacker --help
# or put apps/openpacker-cli on PATH via your preferred packaging step
```

Most commands talk to a local daemon (`openpackerd` via `openpacker serve`).

---

## 60-second start

```sh
# Terminal 1 — start the local service (fixture universe, no public registry)
npx openpacker serve \
  --universe fixtures/epoch/universe.json \
  --host 127.0.0.1 \
  --port 7337 \
  --database .openpacker/demo.sqlite

# Terminal 2 — point the CLI at it
export OPENPACKER_URL=http://127.0.0.1:7337
```

Sanity check:

```sh
npx openpacker normalize 'pkg:npm/%40openpacker/demo-tool@1.0.0' --json
```

You should see a JSON result with
`"canonical":"pkg:npm/%40openpacker/demo-tool@1.0.0"`.

---

## Recipe index

| I want to…                                            | Command                                                |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Canonicalize a package URL                            | [`normalize`](#normalize-a-package-id)                 |
| Find which package a name means                       | [`identify`](#identify-a-package)                      |
| List versions of a package                            | [`enumerate`](#list-versions)                          |
| Show metadata for one exact version                   | [`inspect`](#inspect-one-version)                      |
| **Turn my npm/Cargo/… lockfile into OpenPacker pins** | [`import-lock`](#import-a-native-lockfile-most-common) |
| Solve a dependency request                            | [`solve` / `resolve`](#solve-a-dependency-graph)       |
| Write `openpacker.lock.json`                          | [`export lock`](#export-a-portable-lockfile)           |
| Export an SBOM from a solve                           | [`export sbom`](#export-an-sbom)                       |
| Explain a solution                                    | [`explain`](#explain-a-solution)                       |
| Check digests / signatures                            | [`verify`](#verify-a-receipt-or-artifact)              |
| Fetch artifact for install prefix                     | [`materialize`](#materialize-an-artifact)              |
| Import a catalog snapshot                             | [`catalog import`](#import-a-catalog-snapshot)         |
| Run the offline full demo                             | [`demo`](#full-offline-demo)                           |

---

## Normalize a package id

Turn messy native or mixed-case coordinates into a canonical Package URL (PURL).

```sh
# Positional (simplest)
npx openpacker normalize 'pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0' --json

# Or JSON batch
cat > /tmp/normalize.json <<'EOF'
{
  "items": [
    { "type": "purl", "value": "pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0" },
    { "type": "native-coordinate", "ecosystem": "npm", "value": "@openpacker/demo-tool@1.0.0" }
  ]
}
EOF
npx openpacker normalize --input /tmp/normalize.json --json
```

**What you get:** each item’s `canonical` PURL, ecosystem, and any semantic-loss
warnings when something could not be represented exactly.

---

## Identify a package

Resolve a name/alias/PURL to candidates (never silently picks when ambiguous).

```sh
npx openpacker identify 'pkg:npm/%40openpacker/demo-tool' --json
```

**What you get:** `status` of `identified` | `ambiguous` | `not-found`, plus
`candidates[]` with exact PURLs.

---

## List versions

```sh
npx openpacker enumerate 'pkg:npm/%40openpacker/demo-tool' --json
```

**What you get:** ordered exact versions available in the loaded catalog for
that package (subject to target/lifecycle filters if provided via JSON input).

---

## Inspect one version

```sh
npx openpacker inspect 'pkg:npm/%40openpacker/demo-tool@1.1.0' --json
```

**What you get:** a full package instance: requirements, artifacts, lifecycle,
native semantics, digests.

---

## Import a native lockfile (most common)

Turn what **npm / Cargo / NuGet / uv / Go / Gradle already locked** into an
OpenPacker solution + portable lock digest **without re-solving**.

This records profile **`native-capture-v1`**. It does **not** claim OpenPacker
independently solved the graph.

Digest honesty: only sha256-based native digests (npm integrity, Cargo.lock
checksums) become artifact descriptors. NuGet `sha512-…`, Go `h1:` hashes, and
digest-less Gradle locks are recorded as `NATIVE_DIGEST_NOT_REPRESENTED`
semantic loss — the import never fabricates a digest for them. Lifecycle status
is captured as `unknown`; a lockfile cannot tell you whether a package was later
yanked or revoked.

### Cargo.lock

```sh
npx openpacker import-lock \
  --input fixtures/locks/cargo/Cargo.lock \
  --format cargo-lock \
  --json \
  --output .demo-output/cargo-import.json
```

### npm package-lock.json (v3)

```sh
npx openpacker import-lock \
  --input fixtures/locks/npm/package-lock.json \
  --format package-lock \
  --json \
  --output .demo-output/npm-import.json
```

### NuGet project.assets.json

```sh
npx openpacker import-lock \
  --input fixtures/locks/nuget/project.assets.json \
  --format nuget-assets \
  --json \
  --output .demo-output/nuget-import.json
```

### PyPI (uv.lock JSON projection)

```sh
npx openpacker import-lock \
  --input fixtures/locks/pypi/uv.lock.json \
  --format uv-lock \
  --json \
  --output .demo-output/pypi-import.json
```

### Go (go.sum)

```sh
npx openpacker import-lock \
  --input fixtures/locks/golang/go.sum \
  --format go-sum \
  --json \
  --output .demo-output/go-import.json
```

### Maven / Gradle lockfile

```sh
npx openpacker import-lock \
  --input fixtures/locks/maven/gradle.lockfile \
  --format gradle-lockfile \
  --json \
  --output .demo-output/maven-import.json
```

### What matters in the output

```sh
# Selected packages (the pins)
jq '.lockfile.selectedExactPurls' .demo-output/cargo-import.json

# Profile claim (must be native-capture-v1 for import-lock)
jq '.lockfile.semanticsProfile' .demo-output/cargo-import.json

# Digests for CI / audit
jq '{solution: .lockfile.solutionDigest, receipt: .lockfile.receiptDigest}' \
  .demo-output/cargo-import.json
```

### Offline without the daemon

If you only need lock import and digests, the repo ships a no-server demo that
uses the same library path:

```sh
npm run demo:lock-import
# writes .demo-output/lock-import/*.openpacker.lock.json
```

---

## Solve a dependency graph

Ask OpenPacker to **independently** solve from requirements (not capture).

Use a full solve request JSON (see `fixtures/protocol/solve/request.json` for
shape). The daemon must have a catalog/universe that contains the packages.

```sh
# Example: solve using the checked-in protocol fixture shape
# (requires a universe that includes those packages — use the full demo for the
# complete offline path, or import catalogs first).

npx openpacker solve \
  --input fixtures/protocol/solve/request.json \
  --json \
  --output .demo-output/solve-response.json

# `resolve` is the same command (alias for people who say "resolve")
npx openpacker resolve --input fixtures/protocol/solve/request.json --json
```

**End-to-end offline solve that is known-good in this repo:**

```sh
npm run demo
# produces .demo-output/ with solve, receipt, openpacker.lock.json, OCI, etc.
```

---

## Export a portable lockfile

From a **solve** or **import-lock** response that already contains a complete
solution:

```sh
# If you already have a SolveResponse JSON:
npx openpacker export lock \
  --input .demo-output/solve-response.json \
  --output openpacker.lock.json \
  --json

# import-lock already embeds lockfile in its response:
jq '.lockfile' .demo-output/cargo-import.json > openpacker.lock.json
```

`openpacker.lock.json` is the portable pin file (PURLs + digests + profile).

---

## Export an SBOM

```sh
npx openpacker export sbom \
  --input .demo-output/solve-response.json \
  --json \
  --output .demo-output/solution.cdx.json
```

---

## Explain a solution

```sh
# Needs the solutionDigest from a prior solve (hex digest string)
npx openpacker explain \
  'sha256:809410392e51162f5842cbba54d10d6c71d574c3379457787e1ab9af80ba08b2' \
  --json
```

---

## Verify a receipt or artifact

```sh
npx openpacker receipt verify \
  --input .demo-output/receipt.json \
  --json

# Generic verify request (JSON): digests, signatures, evidence checks
npx openpacker verify --input /tmp/verify.json --json
```

---

## Materialize an artifact

Prepare bytes for a local prefix **after** resolution (does not run lifecycle
scripts).

```sh
npx openpacker materialize \
  'pkg:npm/%40openpacker/demo-tool@1.1.0' \
  --json

# Optional extract into a directory
npx openpacker materialize \
  'pkg:npm/%40openpacker/demo-tool@1.1.0' \
  --install-prefix /tmp/op-tool \
  --json
```

For tool install via mise (list + install hooks), see
[`docs/integrations/mise.md`](../integrations/mise.md).

---

## Import a catalog snapshot

Load an immutable package universe so solve/enumerate/inspect have data.

```sh
npx openpacker catalog import \
  --input fixtures/epoch/universe.json \
  --json
```

(`serve --universe …` loads a universe at startup for the same purpose.)

---

## Full offline demo

One command that exercises the production path with fixtures only:

```sh
npm run demo
```

Writes evidence under `.demo-output/` (receipt, lockfile, OCI layout, mise
install check, digests). Failures are non-zero.

---

## Flags you will actually use

| Flag                | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `--input <file\|->` | Request body (JSON) or lockfile path for `import-lock`                  |
| `--output <file>`   | Write exact response bytes to a file                                    |
| `--json`            | Machine-readable JSON on stdout                                         |
| `--base-url <url>`  | Daemon URL (default `http://127.0.0.1:7337` or `$OPENPACKER_URL`)       |
| `--offline`         | CLI only talks to loopback (still needs a running local daemon)         |
| `--format …`        | Lock format for `import-lock` (`auto`, `package-lock`, `cargo-lock`, …) |
| `--install-prefix`  | Directory for `materialize` extraction                                  |
| `--auth-token-file` | Bearer token from a file (never put tokens in JSON bodies)              |

### Exit codes

| Code | Meaning                   |
| ---- | ------------------------- |
| 0    | Success                   |
| 2    | Bad usage                 |
| 3    | Bad local input           |
| 4    | Not found                 |
| 5    | Unsatisfiable             |
| 6    | Policy / lifecycle denied |
| 7    | Verification failed       |
| 8    | Service unavailable       |
| 9    | Internal error            |

`verify` and `receipt verify` exit `0` only when the service decision is
`allow`. A `deny` decision exits `7` (`6` when the denial includes
`policy-denied` evidence), and `indeterminate` — evidence missing or no verifier
configured — exits `8`. Never gate a deploy on `openpacker verify && …` without
checking the exit code documentation above.

---

## Common workflows (copy whole blocks)

### A. Pin my existing Cargo.lock for CI

```sh
npx openpacker serve --universe fixtures/epoch/universe.json --port 7337 &
export OPENPACKER_URL=http://127.0.0.1:7337

npx openpacker import-lock \
  --input path/to/Cargo.lock \
  --format cargo-lock \
  --json \
  --output cargo.openpacker.json

jq -r '.lockfile.selectedExactPurls[]' cargo.openpacker.json
jq -c '{profile:.lockfile.semanticsProfile, solution:.lockfile.solutionDigest}' \
  cargo.openpacker.json
```

### B. Pin my package-lock.json

```sh
npx openpacker import-lock \
  --input package-lock.json \
  --format package-lock \
  --json \
  --output npm.openpacker.json

jq '.lockfile.selectedExactPurls' npm.openpacker.json
```

### C. Canonicalize mixed package coordinates in a script

```sh
while read -r purl; do
  npx openpacker normalize "$purl" --json \
    | jq -r '.results[0].canonical'
done <<'EOF'
pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0
pkg:cargo/demo-zstd@1.0.0
EOF
```

### D. Look up what versions we know about

```sh
npx openpacker enumerate 'pkg:npm/%40openpacker/demo-tool' --json \
  | jq -r '.versions[].exactPurl'
```

---

## What the CLI is not

| Don’t expect                                     | Use instead                                   |
| ------------------------------------------------ | --------------------------------------------- |
| `openpacker install` that mutates `node_modules` | `npm` / `pnpm` / `yarn` after you pin digests |
| `openpacker build` for Rust/Go                   | `cargo` / `go`                                |
| Silent rewrite of package archives               | OpenPacker preserves native bytes             |
| Independent solve when you only imported a lock  | Profile is `native-capture-v1` by design      |

---

## Next

| Topic                             | Doc                                                       |
| --------------------------------- | --------------------------------------------------------- |
| Why control plane vs supersession | [ADR 0020](../adr/0020-control-plane-not-supersession.md) |
| Lock import rules                 | [ADR 0021](../adr/0021-native-lock-import.md)             |
| mise tool install                 | [mise integration](../integrations/mise.md)               |
| HTTP/API shapes                   | [User surface](../product/user-surface.md)                |
| Spec / compliance                 | [Compliance](../product/compliance.md)                    |
