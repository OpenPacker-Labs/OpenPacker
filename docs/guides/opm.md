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

Package publishers can use [`opm pack`](opm-pack.md) for deterministic native
artifacts or explicit native-tool delegation.

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

## Working on OpenPacker itself

When you are developing OpenPacker, `npm link` is the wrong tool: it pins a
global name to whatever was last built, so a stale binary looks exactly like a
fresh one. `tools/dev-bin` holds launchers that rebuild before running, and a
shell hook puts them on PATH only while the shell is inside this repository.

```sh
npm run dev:shell     # prints the one line to add to ~/.bashrc or ~/.zshrc
```

That line is:

```sh
source /path/to/openpacker/tools/shell/openpacker-env.sh
```

With it in place, `opm` and `opmx` resolve to this checkout inside the
repository and are gone again outside it — so they never shadow a real install
elsewhere on the machine.

If you prefer **direnv**, create your own `.envrc` and allow it:

```sh
echo 'PATH_add tools/dev-bin' > .envrc
direnv allow
```

That file is gitignored and is deliberately not shipped: `.envrc` is a common
place to keep secrets, and `npm run agent:check` refuses to stage anything
matching `.env*`. Keeping it local means the guard stays strict for everyone.

Every run compares workspace sources against the built CLI and rebuilds when
they are newer:

| Situation                    | Cost  | Behaviour                             |
| ---------------------------- | ----- | ------------------------------------- |
| Nothing changed              | ~50ms | Runs the built CLI                    |
| A source file changed        | ~1.5s | Rebuilds, then runs the new CLI       |
| A source file does not build | —     | **Refuses to run** and exits non-zero |

The last row is deliberate. Silently running the previous build after a failed
compile is how you end up debugging code that is not the code you are running.

```sh
OPENPACKER_DEV_NO_BUILD=1 opm ...   # skip the check, run whatever is built
tools/dev-bin/opm --help            # one-off, no PATH setup at all
```

On Windows, `opm.cmd` and `opmx.cmd` do the same thing, except that they ask
turbo every time rather than checking file times first — a warm cache hit is
about 0.4s. Project-state mutation (`init`, `add`, `install`, `update`,
`remove`, generation switching and garbage collection) currently refuses with
`UNSAFE_PATH`: Node does not expose the no-follow, handle-relative Windows
filesystem primitive required to keep `.opm` metadata and shims race-safe.
Packing also refuses on Windows because artifact and receipt publication uses
the same no-follow atomic writer. Help and version remain available; `opm list`
does not. This is an explicit capability withdrawal, not a fallback to pathname
checks.

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

Resolution order is explicit `--source`, then a catalog entry, then the
ecosystem's registry. A project that has pinned where a package comes from never
starts reaching the network because a registry publishes the same name.

---

## Registries

`opm add pkg:npm/lodash@4.17.21` resolves against the real registry and verifies
the download before anything reaches the store.

| Ecosystem | Default registry                      |
| --------- | ------------------------------------- |
| `npm`     | `https://registry.npmjs.org`          |
| `cargo`   | `https://index.crates.io`             |
| `pypi`    | `https://pypi.org/pypi`               |
| `nuget`   | `https://api.nuget.org/v3/index.json` |
| `maven`   | `https://repo1.maven.org/maven2`      |
| `golang`  | `https://proxy.golang.org`            |

Point any of them at a private mirror with `OPM_REGISTRY_<ECOSYSTEM>`:

```sh
OPM_REGISTRY_NPM=https://npm.internal.example opm add pkg:npm/internal-tool@1.0.0
```

### Browsing

These need no project — looking up what a registry has is useful before you have
decided to depend on it.

```sh
opm search lodash --ecosystem npm     # candidate identities
opm versions pkg:cargo/serde          # every published version, oldest first
opm info pkg:npm/lodash@4.17.21       # digest, size, media type, download URL
```

A bare name is fail-closed the same way `opm add` is: `opm versions lodash`
errors rather than guessing npm because it is popular.

### What is checked

An install from a registry is verified three times over, and none of the checks
trust the next layer:

1. The provider checks the bytes against the registry's **own** integrity claim
   — npm's SRI, NuGet's package hash — before anything downstream sees them.
2. `opm` re-derives the sha256 from those same bytes and compares, so nothing
   enters the store on a provider's say-so.
3. The download location must be on an **allowlisted origin** for that
   ecosystem. Registries legitimately serve metadata and artifacts from
   different hosts, so those hosts are listed rather than taken from the
   metadata response — a registry that starts handing back a new download host
   is refused, not followed.

The artifact is fetched **once**: the bytes travel with the descriptor. Fetching
again to re-check would cost a second transfer and compare the new bytes against
a digest taken from the old ones, which is a weaker statement rather than a
stronger one.

`--offline` refuses every registry read outright, so an offline build cannot
quietly start depending on a registry being reachable.

`opm install --offline` replays an existing manifest-bound lock from the
canonical `.artifact` cache without re-resolving the package. The cached bytes
are re-hashed against the lock digest before extraction. Source classification
is available only when the exact immutable package projection is bound to an
explicit source in the current manifest; a source written only in the lock has
no authority. Hand-authored evidence, signer, issuer, lifecycle, registry, or
source-snapshot claims in a lock are likewise not policy authority. Registry
locks therefore fail closed offline under the default lifecycle policy unless
their verifier evidence can be independently replayed.

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
| `opm search <query>`      | Candidate packages in a registry                    |
| `opm versions <purl>`     | Every published version, oldest first               |
| `opm info <exact-purl>`   | Digest, size, media type, download URL              |
| `opmx <bin\|pkg> [args…]` | Run an installed executable                         |
| `opm generations`         | List the environment history; `*` marks current     |
| `opm rollback [--to N]`   | Return to the previous generation, or a named one   |
| `opm gc [--keep N]`       | Remove store paths no retained generation needs     |
| `opm shell [--json]`      | Print the environment for this generation           |

### Generations and rollback

Every install and removal appends an immutable generation recording what was
installed. Generations are hash-linked, so editing one breaks the link its child
asserts, and the only mutable state is a pointer naming the current generation —
replaced atomically, so an interrupted switch is observed as the old state or
the new one and never a blend.

```sh
opm generations          # * 2  2026-08-03T…  3 package(s)
opm rollback             # back one generation
opm rollback --to 1      # back to a specific one
```

Rolling back re-points the pointer and rebuilds the derived view — bin shims,
link records, project state — from the generation's own record plus store
content. It never rewrites a generation, so a rollback is itself reversible, and
it does not depend on the current manifest or lock still describing what that
generation contained.

No symlinks are involved, so this behaves identically on every platform.

### Collecting unused store paths

A store path is collectible exactly when no retained generation needs it.

```sh
opm gc --dry-run   # report without removing
opm gc --keep 3    # retain the three newest generations
```

The current generation is always retained; `--keep` bounds history so an
environment that is never pruned does not grow forever. Dropping a generation
also drops its record, so what is retained and what is reachable stay
consistent.

### Shell environment

`opm shell` prints the environment derived from the current generation, which
composes with a shell rather than replacing one:

```sh
eval "$(opm shell)"
opm shell --json   # for tooling
```

### `opmx`

```sh
opmx demo-tool --version
opmx --package demo-tool --bin demo-tool -- --help
```

Resolution order: explicit `--bin` → package primary bin → bin name in
`.opm/bin`.

---

## Resolution sources

`opm add` / `opm resolve` pick a source in this order. The first hit wins.

1. `source = "file:…"` (or an explicit `https:` URL) on the package in
   `opm.toml`
2. `.opm/catalog.json` in the project
3. `OPM_CATALOG` env path
4. A named `[registries.<id>]` in `opm.toml`
5. The default registry for that PURL type (`registry.npmjs.org`,
   `index.crates.io`, `pypi.org`, …) — see [Registries](#registries)

`--offline` refuses every network step. A miss after the local sources is a hard
error, not a silent empty lock.

Explicit non-`file:` sources carry no registry lifecycle evidence, and opm no
longer assumes one: an `https:` tarball, a git URL, or an online catalog
`resolvedSource` fails closed with `POLICY_INDETERMINATE`. Only `file:` sources
and registry-resolved packages — whose lifecycle comes from the registry
inspection — install as direct dependencies. This is an explicit capability
withdrawal, not a fallback to assuming eligibility.

Locks record the **proof-checked closure**, not just the direct requirement. A
range is solved; it is not stored as a hint.

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
- Package execution (approved lifecycle scripts, `opmx`, host installers) goes
  through `@openpacker/sandbox` — native Bubblewrap jail on Linux,
  **fail-closed** when a jail cannot be enforced
  ([ADR 0036](../adr/0036-sandboxed-installs-and-execution.md)).

### Sandbox configuration

Defaults when `[sandbox]` is omitted: enabled, `fail-closed`, prefer `auto`
(native jail when present, else MXC), **project write off**, **minimal PATH**.

```toml
[sandbox]
enabled = true
mode = "fail-closed"   # fail-closed | degrade-warn | off
prefer = "auto"        # auto | mxc | native
project_write = false  # opmx cannot rewrite project source unless true
minimal_path = true

# Prefer allowlists (strict mode rejects allow_lifecycle_scripts alone):
# [policy]
# allowed_lifecycle_script_packages = ["pkg:npm/esbuild"]
```

`degrade-warn` and `off` do not waive hard process-tree ceilings, and they do
not fall back to ambient execution: every mode refuses with
`TREE_CONTAINMENT_UNAVAILABLE` unless a backend owns the process tree. That
currently means Bubblewrap with a PID namespace on Linux. Package-execution
containment on macOS and Windows is **withdrawn**: the MXC SDK configures
containment by path strings and cannot consume the stable directory-handle
authorities every run requires, so runs there fail closed (exit 78 under
`fail-closed`, `TREE_CONTAINMENT_UNAVAILABLE` otherwise) instead of degrading
toward ambient execution. This is an explicit capability withdrawal, like the
Windows metadata refusal above, not a silent downgrade.

**Run tools with `opmx`.** Shims re-enter via `opmx`; ambient direct spawn needs
`OPENPACKER_ALLOW_AMBIENT_SHIMS=1` (insecure).

Lifecycle scripts are deny-by-default; an allowlist entry is required under
strict mode. Host installers only get **limited user-capability** containment.

This is **defense-in-depth**, not a microVM.

---

## Related

- PREX / advanced CLI: [cli.md](cli.md) (`openpacker`)
- Dual-surface decision: [ADR 0022](../adr/0022-opm-package-manager-surface.md)
- Offline fixture packages: [`fixtures/opm/`](../../fixtures/opm/)
- Example project: [`examples/opm-project/`](../../examples/opm-project/)
