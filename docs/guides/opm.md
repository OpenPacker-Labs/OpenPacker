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
artifacts or explicit native-tool delegation. `opm publish` / `opm yank` send
those packed native bytes to a PREX registry (`POST /v1/openpacker/publish` and
lifecycle apply), never to npmjs, PyPI, or crates.io. The reference daemon's
publish extension stays unavailable unless `OPENPACKER_PUBLISH_STORE` is an
absolute directory. Default registry URL is `OPM_PREX_REGISTRY` or `--registry`.
`--offline` is refused.

OpenPacker v1 loads WIT-shaped TypeScript adapters and sandboxed native plugins;
it does not load Wasm components.

## Configure an ecosystem before using it

`opm` does not infer or silently enable registry adapters. A project must list
an ecosystem in `project.ecosystems` before `add`, `install`, `sync`, `search`,
or resolution can use it. This is the project-level extension configuration; if
the ecosystem is absent, the operation fails closed.

For npm, configure the adapter explicitly:

```toml
[project]
name = "my-app"
ecosystems = ["npm"]
```

Third-party ecosystems are separate delegated plugins. Install one explicitly
with `opm plugin add <name>`, then bind its digest in `opm.toml` under
`[plugins.<id>]`; plugins are never installed or discovered automatically.

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
about 0.4s. Project-state mutation uses the same no-follow, handle-relative open
on every platform: Linux maps an open directory through `/proc/self/fd`, macOS
calls libc `openat` and its siblings through koffi (`/dev/fd/N/child` does not
resolve there), and Windows opens children with `NtCreateFile` relative to the
parent OS handle (`RootDirectory`, reparse points refused) — openat semantics,
never a lexical pathname fallback. Path escapes, symlink swaps, and linked
metadata still fail closed with `UNSAFE_PATH`.

---

## 60-second project workflow

```sh
mkdir my-app && cd my-app
opm init --name my-app
# or: opm import --native   # from package.json / Cargo.toml / …

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
                     # (optional OPM_STORE_HOME hardlink/copy source)
    bin/             # shims for executables
    links/           # alias → store metadata
    project.json     # installed set
```

When `OPM_STORE_HOME` is set to an absolute path, verified package trees are
also kept there as `sha256-<hex>/` entries. Projects hardlink (or copy on
`EXDEV`) into `.opm/store`; the project store path stays project-local and
project GC never deletes the shared root. Unset leaves today's project-only
store. Relative values fail closed (`UNSAFE_PATH`). Env-only; there is no toml
`shared_store` key.

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

After `npm` is listed in `project.ecosystems`, `opm add pkg:npm/lodash@4.17.21`
resolves against the real registry and verifies the download before anything
reaches the store. A project without that adapter configuration fails closed.

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

Naming the registry is what authorizes it. An override (or a
`[registries.<id>].url` in `opm.toml`) allowlists **that origin only** and pins
it so a private or split-horizon address is reachable. Hardcoded public artifact
hosts — for example PyPI's `files.pythonhosted.org` — are **not** kept. If the
mirror still publishes locations on a public CDN, name it explicitly:

```sh
OPM_REGISTRY_PYPI=https://pypi.internal.example
OPM_REGISTRY_PYPI_ORIGINS=https://files.pythonhosted.org
```

`OPM_REGISTRY_<ECOSYSTEM>_ORIGINS` is an extra **allowlist**, not a pin:
duplicates fail closed, entries must be HTTPS origin-form, and a hostname that
rebinds to RFC1918 is refused unless that origin was the override itself.

Split-horizon of a public default hostname (`registry.npmjs.org` → `10.x`) fails
closed. Point `OPM_REGISTRY_*` at the **internal name**; that origin is the pin.
First-party production traffic uses classify-and-pin on the same `fetch`.
`RegistryClient` loopback HTTP fixtures stay origin-allowlist.

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
   is refused, not followed. Default public CDNs are allowlisted, not pinned:
   rebinding them to a private address fails closed. An `OPM_REGISTRY_*`
   override drops those CDNs (see above).

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

| Command                                  | What it does                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opm init`                               | Create `opm.toml` + `.opm/`                                                                                                                                       |
| `opm import --native`                    | One-shot: read native project files into `opm.toml`. Native files are not authority after import.                                                                 |
| `opm add <spec>`                         | Add to manifest, resolve, lock, install                                                                                                                           |
| `opm remove <alias>`                     | Drop from manifest + lock + install                                                                                                                               |
| `opm install`                            | Materialize lock into `.opm/store` + bins                                                                                                                         |
| `opm uninstall [alias]`                  | Remove install (manifest/lock kept unless `remove`)                                                                                                               |
| `opm sync`                               | Resolve manifest → lock → install (idempotent)                                                                                                                    |
| `opm update [alias...] [--latest]`       | Bump selected ranged directs to the newest in-range version and re-solve their closure; exact pins unchanged unless `--latest` rewrites the manifest. Not `sync`. |
| `opm list`                               | Show aliases, PURLs, digests, install status                                                                                                                      |
| `opm why <alias>`                        | Why a package is present                                                                                                                                          |
| `opm search <query>`                     | Candidate packages in a registry                                                                                                                                  |
| `opm versions <purl>`                    | Every published version, oldest first                                                                                                                             |
| `opm info <exact-purl>`                  | Digest, size, media type, download URL                                                                                                                            |
| `opmx <bin\|pkg> [args…]`                | Run an installed executable                                                                                                                                       |
| `opm generations`                        | List the environment history; `*` marks current                                                                                                                   |
| `opm rollback [--to N]`                  | Return to the previous generation, or a named one                                                                                                                 |
| `opm gc [--keep N]`                      | Remove store paths no retained generation needs                                                                                                                   |
| `opm shell [--json]`                     | Print the environment for this generation                                                                                                                         |
| `opm plugin add <name>`                  | Install a delegated adapter plugin (digest-pinned)                                                                                                                |
| `opm plugin list`                        | List installed plugins and their pins                                                                                                                             |
| `opm plugin remove <name>`               | Remove a plugin and its store entry                                                                                                                               |
| `opm publish --from <dir>\|--pack <eco>` | Publish packed native bytes to a PREX registry                                                                                                                    |
| `opm yank <exact-purl>`                  | Yank one published version via lifecycle apply                                                                                                                    |
| `opm auth set\|list\|unset`              | Origin → token-env **name** map (no secrets)                                                                                                                      |

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

`opmx pkg:<type>/<name>` runs a tool straight from a registry, without a
project. Registry metadata is re-resolved on every run — an unpinned run is a
different thing tomorrow — but artifact bytes are content-addressed: a repeat
run whose resolved digest already names a tool-cache entry skips the download
and rebuilds from the digest-verified store archive, reported as `(cached)`.

### Delegated adapter plugins

Third-party ecosystems arrive as delegated adapter plugins (ADR 0039): a
standalone executable plus a `DelegatedAdapterManifest`, distributed as a PREX
package under `pkg:opm-plugin/<name>`. Plugins extend opm itself; they never
join a project's manifest, lock, or store. Nothing installs one by default:

```sh
opm plugin add acme          # or acme@1.0.0; prints the pinned digest
opm plugin list              # installed plugins and their pins
opm plugin remove acme
```

Acquisition is digest-pinned and policy-gated exactly like a package install,
and the manifest is schema-validated at `plugin add` — a malformed or tampered
plugin never reaches the store. Plugins materialize into a user-level
content-addressed store (`OPM_PLUGIN_HOME`, else
`$XDG_DATA_HOME/openpacker/plugins`, else `~/.local/share/openpacker/plugins`),
recorded in `plugins.json` there. The plugin registry is selected with
`OPM_REGISTRY_OPM_PLUGIN`; there is no default and no plugin discovery. That
origin is operator-named, so the host pins it (classify-and-pin) rather than
treating it as a public CDN. Offline install works only from an already-pinned,
digest-verified cache entry.

Installed plugins register as adapters at `opm` startup, so the purl types they
serve work in `opm search` / `versions` / `resolve` like any other registry. End
to end:

```sh
opm plugin add acme                    # once; digest-pinned into the store
opmx --plugin acme pkg:acme/some-tool  # resolve → fetch → verify → run
opmx --plugin acme some-tool           # when the plugin serves exactly one purl type
```

`--plugin` names an already-installed plugin for that run; it never installs
one. The run is the full loop: the plugin answers `enumerate` / `inspect` /
`fetch-artifact-record` over the bounded stdio protocol — metadata only; the
host downloads the artifact itself from the record's published `locations`
(HTTPS, no userinfo, query, or hash). The allowlist is the record endpoint
origin union operator pins; pins are `OPM_HOST_FETCH_ORIGINS` union this
plugin's `[plugins.<id>] artifact_origins`. Ephemeral `opmx --plugin` has no
project binding, so pins are env only. A public HTTPS GET on the endpoint origin
still needs no pin. Private, loopback, link-local, NAT64, or IPv4-mapped answers
still need a pin that equals the location origin — `record.endpoint` is not a
pin. An off-origin location (CDN split) is `UNSAFE_PATH` unless the operator
named that origin. The plugin cannot expand the pin set. The host verifies
sha256 and size against the published values, materializes the package into the
content-addressed tool cache, and runs the executables the plugin's inspection
declared. A withheld location or an off-origin download fails closed
(`UNRESOLVABLE`/`UNSAFE_PATH`), and a size or digest mismatch fails closed as a
verification failure (exit 7) — always before anything executes.

The host never attaches credentials because the plugin asked. To authenticate a
pinned origin, name a token env var (never a secret value) in
`artifact_origin_token_envs` or `OPM_HOST_FETCH_TOKEN_ENVS`. Pin even a public
hostname if it requires a bearer — a public endpoint is not an Authorization
grant. Pin plus bearer is any-path consent on that origin, so use the smallest
pin set. `OPM_HOST_FETCH_BEARER` is not a grant unless that name is listed. An
origin may also attach one extra operator-named header (for example
`X-JFrog-Art-Api`) from `artifact_origin_extra_header_names` /
`artifact_origin_extra_header_envs` or `OPM_HOST_FETCH_HEADER_NAMES` /
`OPM_HOST_FETCH_HEADER_ENVS`. Extra header is independent of Bearer. The plugin
cannot name headers.

```sh
export OPM_HOST_FETCH_ORIGINS=https://artifacts.internal.example
export OPM_HOST_FETCH_TOKEN_ENVS=ACME_ARTIFACTS_TOKEN
export OPM_HOST_FETCH_HEADER_NAMES=X-JFrog-Art-Api
export OPM_HOST_FETCH_HEADER_ENVS=JFROG_API_KEY
# Optional: every host-fetch hop origin must be in the pin set (endpoint origin
# is not enough).
export OPM_HOST_FETCH_REQUIRE_PIN=1
```

### `opm auth` (env names only)

Private registries need tokens. ADR 0041 already specifies Bearer from a **named
env** on a **pinned origin**. `opm auth` is a user-level origin → token-env-name
map so operators do not re-export those names ad hoc.

```sh
opm auth set --origin https://registry.internal.example
opm auth set --origin https://npm.internal.example --token-env NPM_TOKEN
opm auth list
opm auth unset --origin https://npm.internal.example
```

`--origin` alone is a pin (private-address host-fetch, or
`OPM_HOST_FETCH_REQUIRE_PIN=1`). `--token-env` still records a name, never a
secret.

The file (`OPM_AUTH_CONFIG` or `$XDG_CONFIG_HOME/openpacker/auth.json`, mode
`0600` on POSIX) stores **names only**. Mint tokens outside opm (cloud CLI,
`gh`, vault, human paste) and export the named variable in the process
environment. There is no `opm login`, OIDC, device-code flow, or `--token` that
writes bearer material.

At process start, `opm` appends auth-config origins that are not already present
onto `OPM_HOST_FETCH_ORIGINS` / `OPM_HOST_FETCH_TOKEN_ENVS`. Operator-set lists
are not overridden. `process.env[tokenEnv]` is never written.

A plugin's declared environment stays unforwarded unless each name is granted
with `--allow-env NAME` (repeatable), mirroring `opm pack --allow-env`.
`--allow-env` of `OPM_HOST_FETCH_*` or of a host-fetch token or extra-header env
name is refused. `opmx --offline` refuses an ephemeral resolve outright.

A project pins the plugins it relies on in `opm.toml`, keyed by the plugin's
manifest id, against the store entry digest that `opm plugin list` prints:

```toml
[plugins.dev.example.acme-adapter]
store_digest = "sha256:…"
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
artifact_origin_extra_header_names = ["X-JFrog-Art-Api"]
artifact_origin_extra_header_envs = ["JFROG_API_KEY"]
```

A binding is a pin, never an acquisition: project commands that read or mutate
the manifest, lock, or store (`add`, `install`, `sync`, `remove`, `uninstall`,
`resolve`) verify the plugin is installed and that its store entry still digests
to the pinned value, and fail closed (`PLUGIN_NOT_INSTALLED` /
`PLUGIN_DIGEST_MISMATCH`) otherwise. Version 1 delegates the registry-definition
and catalog surfaces, so a plugin answers metadata — versions, identity,
records, executable declarations — while artifact bytes are fetched host-side
from the record's published locations and verified against the published digest
before any use (ADR 0040); a plugin that withholds or misstates them fails
closed rather than executing unverifiable bytes. Declared executables are pinned
into the lock and the generation record at install, so `opmx <bin>` runs a
plugin-served tool in the project exactly like a first-party one.

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
