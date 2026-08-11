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
about 0.4s.

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
- Package execution (approved lifecycle scripts, `opmx`, host installers) goes
  through `@openpacker/sandbox` — MXC preferred, native jail fallback,
  **fail-closed** when a jail cannot be enforced
  ([ADR 0036](../adr/0036-sandboxed-installs-and-execution.md)).

### Sandbox configuration

Defaults when `[sandbox]` is omitted: enabled, `fail-closed`, prefer `auto` (MXC
then native).

```toml
[sandbox]
enabled = true
mode = "fail-closed"   # fail-closed | degrade-warn | off
prefer = "auto"        # auto | mxc | native

# Narrow grants for a reviewed package that may build inside the jail:
# [sandbox.packages."pkg:npm/sharp"]
# network = true
# write = ["~/.cache/sharp"]
# env = ["SHARP_DIST_BASE_URL"]
```

`allow_lifecycle_scripts = true` (or an allowlist) still only means scripts may
run **inside** the jail — not that they inherit tokens, home, or unrestricted
network. Host installers that cannot be jailed are refused unless the project
explicitly allows unsandboxed host install (and then emit
`SYSTEM_INSTALL_NOT_SANDBOXED`).

MXC is early preview; receipts record which backend enforced the profile rather
than claiming a finished OS security product.

---

## Related

- PREX / advanced CLI: [cli.md](cli.md) (`openpacker`)
- Dual-surface decision: [ADR 0022](../adr/0022-opm-package-manager-surface.md)
- Offline fixture packages: [`fixtures/opm/`](../../fixtures/opm/)
- Example project: [`examples/opm-project/`](../../examples/opm-project/)
