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
metadata still fail closed with `UNSAFE_PATH`. The one symlink opm makes, a
workspace member's link in `node_modules`, goes through the same handles
([below](#workspace-member-links)).

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
  node_modules/      # only with native_projection = "layout" (see below)
  .opm/
    catalog.json     # optional local package catalog
    store/           # content-addressed packages: hard links into the shared store
    bin/             # shims for executables
    links/           # alias → store metadata
    project.json     # installed set
```

### Where packages live on disk

A package's files exist **once per machine**, in the shared package store.
`.opm/store` and `node_modules` are trees of hard links to them, so a second
project, or a second worktree of the same repository, costs directories and
links, not another copy.

| Setting                    | Effect                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| _(nothing set)_            | `opm` and `opmx` use `$XDG_CACHE_HOME/openpacker/store`, else `~/.cache/openpacker/store`    |
| `OPM_STORE_HOME=/abs/path` | Use that directory instead. A relative path fails closed (`UNSAFE_PATH`)                     |
| `OPM_STORE_HOME=off`       | No shared store: the project keeps its own copy (and a tarball beside it for offline repair) |

There is no `opm.toml` key for this on purpose: a committed project file must
not decide where a machine keeps its packages.

The default store is used only where it saves disk and is safe. It must be on
the same filesystem as the project (across devices every link would become a
copy); it is created `0700`, owned by you and never group- or world-writable (a
store that fails that check is skipped for the default, and an error for an
explicit `OPM_STORE_HOME`); entry files are read-only; and each adoption
re-hashes the entry and the project's linked tree, so a file edited in place
through any link is found before it is trusted. Editing a file under
`node_modules` in place therefore fails: replace the file (write a new one and
rename it) instead. On Windows files are copied and the default store is off.

Measured on 50 packages (79 MB unpacked): the first project costs 84 MiB and a
second adds 2.6 MiB; with `OPM_STORE_HOME=off` each costs 134 MiB
([ADR 0048](../adr/0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md)).

Free what no project uses any more with `opm gc --shared` (see
[Collecting unused store paths](#collecting-unused-store-paths)).

### `node_modules` (`native_projection`)

opm keeps its own layout (`.opm/`) and does not touch `node_modules` unless
asked. `[options] native_projection` says how far opm goes into the ecosystem's
own files ([ADR 0034](../adr/0034-opm-projects-into-native-project-formats.md)):

| Level      | npm                                                                                     |
| ---------- | --------------------------------------------------------------------------------------- |
| `off`      | Nothing                                                                                 |
| `manifest` | _(default)_ Keep `package.json` dependencies in step with `opm.toml`                    |
| `lock`     | Also write `package-lock.json` (needs the registry's integrity value for every package) |
| `layout`   | Also write `node_modules/`                                                              |

```toml
[options]
native_projection = "layout"
```

The layout does not need a `package.json`: a plain opm project gets a
`node_modules` too, and opm creates no `package.json` or `package-lock.json` you
did not ask for. `manifest` and `lock` still require the file to exist.

What `layout` writes:

- **Node resolves it.** Packages are placed from the dependency edges the lock
  recorded. A direct requirement, and the version most packages want, sits in
  `node_modules/<name>`; a package that needs a different version of the same
  name gets it in its own `node_modules` (`a → c@1` and `b → c@2` becomes
  `node_modules/c` = 2, `node_modules/a/node_modules/c` = 1). No symlinks,
  except a workspace member's link ([below](#workspace-member-links)). A lock
  with no recorded edges (an offline lock holds only the direct set) is laid out
  flat by name, newest first, and the version left out is reported.
- **Hard links, not copies.** Each file is a link to the store's, verified to be
  the same inode. If the filesystem cannot link, opm copies and says so.
- **Executables** are small shell scripts in `node_modules/.bin` (plus `.cmd` on
  Windows) that run the package's `bin` script with the interpreter its first
  line asks for. They are not symlinks, and a bin whose name or target is not
  safe is reported and skipped.
- **No lifecycle scripts run.** The result is equivalent to what npm lays out,
  not produced by npm, and the projection says so.
- `node_modules/.opm-layout.json` records what opm wrote. The next layout
  removes only that; a package you installed some other way is left alone.

#### Workspace member links

A workspace's members are the one thing in `node_modules` that is a symlink (a
junction on Windows). A link from a member's name to the member's own directory
lets `packages/b` resolve `packages/a`'s live source with no install: an edit to
`a` is seen at once. Nothing else is a symlink, and the rules are code, not
convention ([ADR 0050](../adr/0050-workspace-member-links.md), decided
2026-10-12):

- The link lives in a `node_modules` (or a scope directory in one), is named
  after one package, and points by a relative path at a place **inside the
  project** that is not under `node_modules` or `.opm`. An absolute target, a
  `..` that leaves the project, an empty or NUL-containing text, a link in
  `.bin` and a link where a package is installed are all refused before anything
  is written. So is a target that goes through a directory which is itself a
  symlink (a committed `packages -> ../outside`): the part of the target that
  exists is walked without following anything, at every layout write. A target
  that does not exist yet is allowed. The check is of the moment it runs; a
  directory swapped for a link after it is found at the next write.
- It is made through the same no-follow, handle-relative calls as every other
  write. A name that already holds something else (a file, a directory, a link
  to another place) is an error that names it and is not replaced; the same link
  again changes nothing.
- `node_modules/.opm-layout.json` lists each link (`links`: path and text). The
  next layout removes a link only while it is exactly the one that was written,
  so a link you made by hand, or repointed, is left and reported. (On Linux and
  macOS a file put at that exact name in the instant between the check and the
  removal is removed with it; a directory never is. ADR 0050 has the table.)
- A tool that reads `node_modules` treats a listed link as a leaf: it reads the
  link and not what it points at, so a member's source is never hashed or
  counted as part of `node_modules`. A symlink that is not listed is refused as
  it always was.
- On Windows a link is a directory junction, which needs no privilege. It holds
  an absolute path, so a project moved on disk needs its layout written again,
  and a member must be a directory.

The layout writer and its plan carry these links today. Reading members out of a
lock and installing a workspace (`opm ci` still refuses a lock that has
`link: true` entries) is not part of this.

### Installing exactly a lock (`opm ci`)

`opm ci` installs a committed `package-lock.json` (lockfileVersion 2 or 3, no
workspaces) the way `npm ci` does, without npm and without an `opm.toml`.
`opm install --frozen` is the same command. It reads `package.json` and the
lock, resolves nothing, and replaces `node_modules` with the tree the lock
describes ([ADR 0046](../adr/0046-a-lockfile-is-installed-not-re-resolved.md)).

```sh
opm ci                       # the project in the current directory
opm ci --path ./app          # another directory
opm ci --production          # leave out dev dependencies (--omit dev)
opm ci --omit optional       # also: peer
opm ci --offline             # the shared store only; names what is missing
```

```text
Installed 894 packages into /app/node_modules (845 from the store, 0 fetched, 0.0 MB) in 55.0 s; 10 declare install scripts, which opm does not run
  left out: 145 optional, for another platform
  install script not run: esbuild@0.28.2
  ...
```

What it does, in order:

1. **Reads the lock, refuses what it cannot install.** Links, workspace members
   (and the packages inside them), a git or path source, an entry with no
   `resolved` or no `integrity`, and a `package.json` that no longer matches the
   lock are each named, and nothing is installed. Exit code 3.
2. **Applies the project's policy to the lock's facts.** `opm.toml`'s `[policy]`
   when there is one, the default otherwise. Every package is judged before any
   is fetched, and one error lists those refused (exit 6). The minimum release
   age does not apply to a version the lock already pinned; a source kind the
   policy blocks does.
3. **Takes each archive from the store or from the lock's URL**, and checks it
   against the lock's `integrity` before using it. A mismatch exits 7 and leaves
   the previous `node_modules` as it was. The only hosts contacted are those of
   the lock's `resolved` URLs.
4. **Writes the lock's layout.** Each package is at the path its key names,
   hard-linked from the store, with `.bin` shims; no symlinks (a lock's
   workspace links are refused for now, see
   [Workspace member links](#workspace-member-links)).

Which entries a machine installs follows npm: `dev`, `optional` and `peer`
entries are dropped by `--omit`; an optional package for another `os`, `cpu` or
`libc` is not installed, nor is anything only it needs; a package that is not
optional and does not run here is an error. The packages that declare an install
script are counted and listed, and none is run.

Measured on a lock of 1,039 entries (894 installed here), against npm's own
reader of the same lock: no difference in which package is installed at which
path. Cold, with an empty store, it takes about two minutes; with the store
populated, about one; a second project adds 1.6% of the first
([measurements](../adr/0046-a-lockfile-is-installed-not-re-resolved.md#consequences)).

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
| `packslip:jdx/hk@2.5.0`      | A vendor's signed release ([packslip])  |
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

### Signed vendor releases (packslip)

A tool that publishes a [packslip](../integrations/packslip.md) beside its
release installs without a registry: the signer is verified, and **remembered**
in the lock so a changed signer stops the next resolve until a person approves
exactly that change.

```sh
# list "packslip" in project.ecosystems first (see above), then:
opm add packslip:jdx/hk                 # GitHub project: forge-proven signer, no config
opm packslip verify packslip:jdx/hk     # who signed it; installs nothing
opm packslip pin packslip:jdx/hk --write
```

Trust is configured in the committed manifest —
`[adapters.packslip.trust."<project>"]` — never in the lock, which anyone with
write access can edit. See the [packslip guide](../integrations/packslip.md) and
[ADR 0043](../adr/0043-packslip-signed-vendor-releases.md).

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

### The dependency closure

`opm add` locks the closure, not the request: every package an install would put
in `node_modules`, each with the digest of the bytes that were read. For
`pkg:npm/vitest@4.1.9` that is 44 packages, the same set and versions npm's own
resolver produces, in about 15 seconds from cold. What is followed:

- runtime dependencies, and peers that are not marked optional;
- npm's `optionalDependencies` **where they run**. Native packages ship as one
  optional dependency per platform (`@rolldown/binding-linux-x64-gnu`, `-musl`,
  `darwin-arm64`, …); `os`, `cpu` and `libc` are checked against what Node
  reports, the one that runs here is locked, and the rest are never downloaded.
  A hard dependency that does not run here is refused;
- never development dependencies, optional peers, or a specifier that is not a
  registry version range (`github:…`, a URL, `npm:` alias, a dist-tag). Those
  are not looked up as the registry's package of that name. In a `dependencies`
  entry they fail the resolve and name the package.

The set is chosen newest-first and every requirement is checked twice, once by
the solver and once by the ecosystem's own range rules, so a lock never pairs a
package with a version it does not accept. The engine's checker re-validates
that every requirement is satisfied; it does not claim the set is optimal.

A failure to compute the closure is an error that says why. It does not fall
back to the direct requirement.

**Limits.** A lock holds one version of a package, so a closure that needs two
(npm and pnpm nest them) fails and names who requires what, for example
`opm add tinybench` next to `vitest@4.1.9`. The locked platform packages are the
ones for the machine that resolved. See
[ADR 44](../adr/0044-a-closure-is-what-the-host-installs.md).

**Release age.** With `minimum_release_age_minutes` set, a version published
inside the window is passed over for the previous release that satisfies the
same range, for a dependency as for a direct requirement. The publish time comes
from the cheapest registry evidence that settles it: the packument's `time` when
it has one, otherwise the document's `modified` stamp when that predates the
window (no version can be newer than the last change to the document, so nothing
more is fetched), otherwise the full packument, only for a package changed
inside the window. A time the registry will not give is _not provided_, which
the default policy does not wave through.

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
| `opm ci` / `opm install --frozen`        | Install exactly what a committed `package-lock.json` says into `node_modules`: no resolving, no scripts ([below](#installing-exactly-a-lock-opm-ci))              |
| `opm uninstall [alias]`                  | Remove install (manifest/lock kept unless `remove`)                                                                                                               |
| `opm sync`                               | Resolve manifest → lock → install (idempotent)                                                                                                                    |
| `opm update [alias...] [--latest]`       | Bump selected ranged directs to the newest in-range version and re-solve their closure; exact pins unchanged unless `--latest` rewrites the manifest. Not `sync`. |
| `opm list`                               | Show aliases, PURLs, digests, install status                                                                                                                      |
| `opm why <alias>`                        | Why a package is present                                                                                                                                          |
| `opm run [script] [-- args]`             | Run a `package.json` script (pre/post hooks, exit code passed through). Not sandboxed.                                                                            |
| `opm exec <bin> [-- args]`               | Run an executable from `node_modules/.bin`. Never fetches, never searches PATH. Not sandboxed.                                                                    |
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

This never touches the shared package store. That one is the user's, not a
project's:

```sh
opm gc --shared --dry-run   # report without removing; needs no project
opm gc --shared
```

A project's store entry and its `node_modules` are hard links to an entry's
files, so an entry in which every file has a link count of one is linked by no
project and is removed. Entries younger than ten minutes are left alone (an
install may be about to link them), as are entries any project still uses.

### Shell environment

`opm shell` prints the environment derived from the current generation, which
composes with a shell rather than replacing one:

```sh
eval "$(opm shell)"
opm shell --json   # for tooling
```

### Running scripts and executables (`opm run`, `opm exec`)

With `native_projection = "layout"` (above) `node_modules/.bin` holds the
executables of the packages you added, and these two commands start them. They
exist so that a repository's `vitest run`, `tsc -b` and `vite build` can be
written in terms of `opm`
([ADR 0047](../adr/0047-opm-run-and-exec-run-the-users-own-scripts.md)).

```sh
opm run                       # list the scripts of package.json
opm run test                  # pretest, test, posttest, in that order
opm run test -- --watch       # arguments after -- are appended to `test` only
opm run lint --if-present     # succeed quietly when there is no `lint`
opm run build --path ./site   # the package.json in ./site, exactly
opm exec vitest --version     # node_modules/.bin/vitest, never a download
opm exec tsc -- -b            # a lone -- right after the bin is dropped
```

`run` reads the `package.json` at the opm project root (the nearest directory at
or above where you are that holds an `opm.toml`; where you are when there is
none) and starts each script with that directory as its working directory.
`exec` looks for the bin in `node_modules/.bin` of that root and of each parent
directory, nearest first, and runs it where you are. It does not search `PATH`
and takes a name, never a path. Everything after the bin name goes to the bin,
so `opm exec vitest --help` is vitest's help.

What they set up for the child:

- `PATH` starts with those `.bin` directories, then your own `PATH`.
- Your environment is inherited. Four names are set and nothing else:
  `npm_lifecycle_event` (`pretest` while the hook runs, `exec` for `exec`),
  `npm_package_name`, `npm_package_version` and `INIT_CWD` (where `opm` was
  started; an outer value is kept).
- Stdin, stdout and stderr are yours. No banner is printed.
- The exit status is the child's, exactly: a script that exits 7 makes `opm`
  exit 7, and a child ended by a signal gives 128 plus its number. A failing
  step also prints one line starting `opm:` to stderr that names it, and a
  failing `pretest` stops `test`.
- `SIGINT`, `SIGTERM` and `SIGHUP` sent to `opm` are forwarded to the child;
  with no terminal attached, to the child's whole process group.

If the bin is missing, `opm exec` says so and says which locked package would
provide it, then what to change:

```text
$ opm exec vitest
opm: "vitest" is not in node_modules/.bin of /work/app or any parent directory; exec never fetches or searches PATH
The lock would provide it through:
  vitest (pkg:npm/vitest@4.1.9), a direct requirement, declares it
Set native_projection = "layout" under [options] in opm.toml, then run: opm sync
Or run it inside the sandbox with: opmx vitest
```

Exit codes: a missing script, bin or `package.json` is 4; a flag `opm` does not
know, or a path where a bin name belongs, is 2; a `package.json` that does not
parse is 3. These share the numeric space with whatever a script exits with, so
read the `opm:` line when it matters. A flag `opm` does not know is an error:
put arguments for the script after `--`.

**These run your code with your authority and are not sandboxed.** The scripts
are in your own `package.json` and the bins are what your scripts already call,
exactly as with `npm run`. They do not go through the jail that `opmx`, installs
and lifecycle scripts use, and `opm --help` says so. They never run a
dependency's lifecycle scripts, never fetch or install anything, and never print
the environment. `opm run` is for your repository's commands; use `opmx` for a
tool you have not reviewed.

Not here yet: workspaces (`--filter`, `--workspace`, per-member `node_modules`;
the model they will be built on is described under
[Workspaces](#workspaces-the-model) below), and the `npm_config_*` and
`npm_execpath` variables.

On Windows a script, and a bin that is a `.cmd` shim, are started through
`cmd.exe /d /s /c` with every argument quoted and escaped for it; a real `.exe`
is started directly. The quoting is covered by tests that run on every platform,
and has not been run on Windows.

### Workspaces (the model)

`opm` can read an npm or pnpm workspace repository: which directories are
members, which member depends on which, in what order they build, and which
members a `--filter` selects
([ADR 0049](../adr/0049-workspaces-are-a-model-before-they-are-an-install.md)).
No command uses this yet; `opm ci` still refuses a workspace lock, and `opm run`
has no `--filter`. It is a library that the commands will be built on, in
`@openpacker/opm-project` (reading the directory) and `@openpacker/adapter-core`
(the pure model).

```ts
import { discoverWorkspace, graphOfWorkspace } from '@openpacker/opm-project';
import {
  parseFilter,
  selectMembers,
  topologicalOrder,
  DEFAULT_WORKSPACE_LIMITS,
} from '@openpacker/adapter-core';

const found = await discoverWorkspace('/work/repo'); // undefined: not a workspace
const graph = graphOfWorkspace(found!); // each tool's own link policy; pass one to override
const order = topologicalOrder(graph, { cycles: 'tolerate' });
const limits = DEFAULT_WORKSPACE_LIMITS;
const picked = selectMembers(graph, [
  parseFilter('@acme/app...', { cwd: '', limits }), // the package and what it depends on
]).selected;
```

What it reads: `pnpm-workspace.yaml` `packages:` (with `!` exclusions) when the
root has one, otherwise `package.json` `workspaces`. The globs are `*`, `?`,
`**` and `{a,b}`, read as the two tools read them; anything else (a character
class, a backslash, a `..`) is refused by name. Everything is bounded (members,
entries read, depth, file sizes), a name that is not a package name or that two
members share is refused, and **a symbolic link is never followed**: one a
pattern names is an error, one met while a `**` searches is passed over and
listed.

Two settings are yours to state, not the model's to guess. `linkPolicy` says
whether a plain `^1.0.0` reaches a member that satisfies it (npm: always; pnpm
since v9: only with `link-workspace-packages`); `cycles` says whether a cycle
among members is an error or is tolerated and reported (pnpm warns). A
`workspace:` specifier that names nothing, or that the model does not support,
is an error that names the specifier and the member, and `publishedDependencies`
gives the `^1.2.3` that `workspace:^` becomes when a package is packed. Filters
are `pnpm --filter`'s: a name, `@scope/*`, `./dir`, `{dir/**}`, `name...`,
`...name`, `^` and `!`; `[since]` is refused until `opm` can ask git. A
directory is a pattern, as in pnpm 10: `./packages/a` is the member in that
directory and nothing inside it, `./packages` is no member at all, and
`./packages/*` or `{packages/**}` are the ones to write for several.
`legacyDirFiltering: true` gives pnpm's `legacy-dir-filtering` instead (a
directory and everything under it); `.npmrc` is not read, so you say which.

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
- Default layout is **`.opm/`**, not a silent rewrite of `node_modules`;
  `native_projection = "layout"` is the opt-in that writes it.
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

## Troubleshooting

### `npm run build` warns that it skipped the wasm bindings

```text
warning: @openpacker/embedded: skipped the wasm bindings, the wasm32-unknown-unknown target and wasm-bindgen are missing; …
```

Expected on a machine that only needs `opm`, `opmx` or `openpacker`: the
bindings are the browser and Node wasm builds of the resolver, the CLIs never
load them, and the build exits 0 with every CLI usable. Packages that import the
bindings' types (`openpackerd`, two examples) compile against declaration-only
stubs; importing `@openpacker/embedded/wasm-node` at run time fails until the
bindings are built. To build them, install what the warning names:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
npm run build:wasm -w @openpacker/embedded
```

The same condition is an error when `CI` is set (other than `0` or `false`) or
`OPENPACKER_REQUIRE_WASM=1`, so release and CI builds cannot ship without the
bindings. A toolchain that is present but fails, such as a `wasm-bindgen`
version that does not match `Cargo.lock`, is an error in both modes.

### `opm: internal error: fetch failed`

An error opm did not expect, with no code of its own, is printed with its
`cause` chain: up to three links, one line each, indented one level deeper per
link. Node's `fetch` reports every network fault as `fetch failed` and keeps the
reason on the cause:

```text
opm: internal error: fetch failed
opm:   caused by: Error: connect ECONNREFUSED 127.0.0.1:34855
opm: hint: HTTPS_PROXY is set, but Node's built-in fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1 (Node 22.21+); retry with NODE_USE_ENV_PROXY=1
```

`opmx` prints the same lines without `internal error`. The exit code is
unchanged (`9`). Everything printed is redacted: a URL keeps its origin and path
and loses userinfo, query and fragment, and the value after a credential name
(`token`, `authorization`, `password`, `api-key`, a bearer) is withheld. A
failure opm named, such as `POLICY_DENIED` or `OFFLINE`, keeps its single line.

The `hint:` line appears only when a cause is a connection fault
(`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, an
unreachable host or network, a refused proxy tunnel, a connect timeout), one of
`HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` or `http_proxy` is set, and
`NODE_USE_ENV_PROXY` is not. Node's built-in `fetch`, which opm uses, ignores
those variables unless `NODE_USE_ENV_PROXY=1` is set (Node 22.21 or later), so a
proxied network fails here although `curl` and `npm` work. The hint names the
variable and never prints its value, which can carry credentials.

```sh
NODE_USE_ENV_PROXY=1 opm add pkg:npm/is-odd
```

---

## Related

- PREX / advanced CLI: [cli.md](cli.md) (`openpacker`)
- Dual-surface decision: [ADR 0022](../adr/0022-opm-package-manager-surface.md)
- Offline fixture packages: [`fixtures/opm/`](../../fixtures/opm/)
- Example project: [`examples/opm-project/`](../../examples/opm-project/)

[packslip]: ../integrations/packslip.md
