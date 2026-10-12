# ADR 0055: `opm ci` installs a pnpm lock

- Status: Accepted
- Date: 2026-10-12
- Amends [ADR 0052](0052-pnpm-lockfile-model.md): "Not done: the mapping" and
  the plan in §15 to §18 are built, with the changes listed under each point
  below. [ADR 0051](0051-opm-ci-installs-workspace-locks.md): "pnpm or yarn
  locks are not read by this command" is true of yarn only.
- Relates: [0046](0046-a-lockfile-is-installed-not-re-resolved.md) (the order of
  refusals, the integrity proof and the origins this keeps),
  [0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  layout: nested, no symlinks),
  [0049](0049-workspaces-are-a-model-before-they-are-an-install.md) (importers
  are members), [0050](0050-workspace-member-links.md) (the one kind of link),
  [0054](0054-aliases-and-several-versions-in-the-closure.md) (an alias is
  installed under its install name; several versions of one name)

## Context

HoBo (792 importers), OpenSesame (70) and ai-bdd (9) are pnpm workspaces, and
their lock is `pnpm-lock.yaml`. ADR 0052 made it a typed, bounded, validated
model and installed nothing. The user's standing order is that `opm` replaces
the other package managers across their projects, so this makes `opm ci` install
it.

An npm lock and a pnpm lock say different things, and the difference decides the
design:

1. **An npm lock records places; a pnpm lock records edges.** An npm key is a
   path (`node_modules/a/node_modules/b`), and `opm ci` writes the lock's tree
   (ADR 0046 §6). A pnpm `snapshots` entry is a package resolved against one set
   of peers and lists which snapshot each of its dependencies is, under what
   name. Where Node should find it is not written, because pnpm's answer is a
   virtual store and symlinks. Someone has to choose the places; for an npm lock
   that was arborist, when npm wrote the lock.
2. **One tarball is several snapshots.** 2,160 packages are 2,193 snapshots in
   HoBo, because `react-dom@18.2.0(react@18.2.0)` and
   `react-dom@18.2.0(react@18.3.0)` are different resolutions of the same bytes.
3. **A workspace is a list of importers, each with its own direct dependencies**
   and its own links to siblings (`link:../sdk`), where an npm lock lists the
   members once and hoists.
4. **The flags differ.** A snapshot has `optional` (reachable only through
   optional edges) and no `dev` flag; a package has `os`, `cpu`, `libc`.
5. **The lock carries no URL for a registry package**, only an integrity.
6. **Settings that change the result live outside the lock**:
   `supportedArchitectures` (HoBo's adds arm64 and costs 1,162 MB),
   `allowBuilds`, overrides in `package.json` or `pnpm-workspace.yaml`.

## Decision

### One model, one writer

1. **A frozen install of a pnpm lock builds the same internal model the npm path
   builds and gives it to the same planner and writer.** `readFrozenLock` of the
   npm format chooses the lock (§22) and, for a pnpm lock, returns the
   `FrozenLock` the npm path returns: packages, each with a place (the key an
   npm lock would give it), the member links, the members to shim, what is left
   out and why, what is refused. The host (`opm-project`) is unchanged in how it
   judges policy, takes archives from the store or the lock's origin, proves the
   integrity and writes: `planLayoutFromPaths` checks the places, and
   `writeNodeModules` writes them. There is no second writer.
2. **The output is an npm-style nested `node_modules`, what Node resolves, and
   not pnpm's virtual store.** No symlink but a workspace member's (ADR 0050);
   `.bin` entries are shims (ADR 0048, ADR 0054).
3. **Where it lives.** `packages/adapter-npm/src/pnpm-install/`, beside the
   reader (`pnpm-lock/`). Pure up to the point it reads two files (the lock and
   the project's own `package.json`, `pnpm-workspace.yaml`), with the members
   the host discovered handed in. Nothing is fetched here.

### The mapping

4. **A snapshot is an instance.** Its identity is its key
   (`name@version(peer suffix)`); its package is the `packages` entry of
   `name@version`, which is where the integrity, the platform lists and the
   `deprecated` message are. Its edges are its `dependencies` and
   `optionalDependencies`: each is `{install name, target snapshot, optional}`.
   The install name is the dependency's key, so an `npm:` alias
   (`string-width-cjs: string-width@4.2.3`) is an edge that is installed under
   the alias and is the target's package (ADR 0054). A peer is an ordinary edge:
   pnpm has already written the resolved peers into the snapshot.
5. **An importer is a top.** Its edges are its three dependency lists. The root
   importer (`.`) is the project; every other importer is a workspace member
   (ADR 0049, ADR 0050). A `link:` edge whose target is another importer is a
   member link; a `link:` anywhere else (outside the lock's importers, or in a
   snapshot) is refused by name.
6. **A package that bundles dependencies** (`bundledDependencies`) has none of
   them in its snapshot, pnpm leaves them out, and they arrive with its archive,
   as an npm `inBundle` entry does (ADR 0046 §3). HoBo has one.
7. **Facts for policy come from the lock** (ADR 0046 §4): the integrity is the
   proof; a registry package's URL is `resolution.tarball` when present and
   otherwise `<registry>/<name>/-/<last segment>-<version>.tgz` with the
   registry the host names (`OPM_REGISTRY_NPM`, the public one by default), so
   the only origins contacted are the ones the packages being installed have; a
   `tarball` resolution is a `tarball` source and the default policy refuses it
   for a transitive dependency. A package without a sha512, sha384 or sha256
   integrity is refused by name (a sha1 only is refused too: it does not pin the
   bytes). `deprecated` becomes a lifecycle fact.

### Where each instance goes

8. **Rule.** Node finds `require('x')` from a package by looking in that
   package's own `node_modules`, then each ancestor directory's. The plan is a
   function from the model to a set of places such that, for every instance
   placed at `L` and every edge `x -> t` of that instance, the first `x` Node
   finds going up from `L` is `t`; the same for every importer and its direct
   edges, from the importer's directory. The planner (`pnpm-install/place*.ts`)
   chooses; it is the job arborist does when npm writes a lock, and it ends in
   the same `PlacedEntry` list the npm lock gives `planLayoutFromPaths`.
9. **A direct dependency of an importer lives in that importer's own
   `node_modules`**, the project's for the root importer
   (`packages/web/node_modules/vitest`). Always, even when the same instance
   would also resolve from the project's. Reasons: a member's version of a name
   cannot collide with another member's or the project's; its `.bin` shims are
   its own and take precedence on its `PATH` (ADR 0047); the rule is stated and
   checked from the lock alone. It costs a directory tree of hard links per
   placement (see Consequences), not a file.
10. **Everything else is placed as the closure planner places it**
    (`layout-plan.ts`), generalised to several tops: breadth-first from the
    direct placements; for each edge of a placed instance, look up what Node
    finds from where it lives; if that is the wanted instance, nothing is
    written; if it is another instance of the name, the wanted one is nested in
    the dependent's own `node_modules` (shadowing for that package and what is
    below it only); if nothing answers, it goes to the project's `node_modules`
    when it is the instance of that name the most packages want, and beside its
    dependent otherwise. A tie is broken by the newer version, then by key. A
    name that differs only by case from one already in the directory is nested
    instead (ADR 0054 §17 refuses what cannot be).
11. **A member link** is a link at `node_modules/<member name>` in the project,
    as ADR 0051 writes them: a name no other package is allowed to take there,
    so a registry package of the same name wanted by something hoisted is nested
    beside its dependent. A `link:` dependency whose name is not the member's
    own name (`"alias": "workspace:other@*"`) is refused by name: a link inside
    a member's `node_modules` is outside ADR 0050's rule, and this does not
    extend it.
12. **The plan proves itself.** Before it is returned, every edge of every
    placed instance and every importer is resolved on the planned tree by the
    algorithm of point 8, and any edge that does not find its target is a bug in
    the planner, not a reason to install: the install is refused with the edge
    named. The same function is exported, and is what the tests and the
    acceptance runs use to check a plan, and, on a tree on disk, what Node finds
    from every importer.

    One shape has no plan: packages that need each other at different versions
    (`a@1` needs `b@1`, which needs `a@2`, which needs `b@2`, which needs
    `a@1`), because each copy nested beside its dependent is shadowed by the one
    above it, for ever. pnpm writes that with symlinks, which this layout does
    not have. The planner stops at 32 directories deep and the install is
    refused naming the instances, where without the bound it exhausted an 8 GB
    heap on the first generated graph that had one.

### Peer-suffixed instances

13. **Each is a separate instance of one registry package.** It is placed where
    its dependents resolve their peers: because placement is by what Node finds
    from the dependent, `react-dom@18.2.0(react@18.2.0)` and
    `react-dom@18.2.0(react@18.3.0)` end up in the nearest places whose
    ancestors find the right `react` and nothing wrong.
14. **Two instances of one tarball cost one extraction.** The archive is
    fetched, proved and extracted once however many places the plan gives it
    (the store is found by the integrity, ADR 0046 §5; `storeArchives` already
    handles one archive at many paths), and the second place is a set of hard
    links. What a second place costs on disk is its directories and the link
    count of its files, not their bytes (measured in Consequences).

### Importers, members and what a filter selects

15. **The importers must be the project's members.** The lock's importer ids and
    the workspace the project's files declare (`pnpm-workspace.yaml`, the
    discovery of ADR 0049, never following a link) must be the same set of
    directories; a difference is named on both sides. A project with no
    `pnpm-workspace.yaml` has one importer, `.`.
16. **Selection.** With no option every importer is installed.
    `--filter <selector>` (pnpm's grammar, ADR 0049 §7), `-w` and `--workspaces`
    choose importers as `opm run` does (ADR 0053); the root importer is
    installed only when it is selected or `--include-workspace-root` is given;
    `--workspaces=false` installs the root importer only and no link. What is
    installed is the selected importers, the members they link, those members'
    dependencies, and everything reachable from them through `dependencies` and
    `optionalDependencies`. This is `npm ci -w` (ADR 0051 §9) and is a superset
    of `pnpm install --filter x` without `...`, which does not install what a
    linked member needs; a script in the selected member that imports the linked
    member's code needs it, so it is installed.
17. **`--omit dev` (`--production`) leaves out the importers'
    `devDependencies`** and what only they reach; `--omit optional` the
    `optionalDependencies` and what only they reach. `--omit peer` is refused: a
    pnpm lock writes resolved peers as ordinary dependencies, so there is
    nothing to omit by. Each package's `scope` for policy is `optional` when the
    snapshot is, `development` when only an importer's `devDependencies` reach
    it, and `runtime` otherwise.

### Freshness: the lock must say what the project says

18. **Checked in this order, before any fetch and before `node_modules` is
    touched** (ADR 0046 §6: what looks only at the lock comes first, then what
    needs the project's files, then what needs the target, then the places):
    1. The lock itself: refusals of the reader (ADR 0052), a source this does
       not install (§20), `patchedDependencies` (§20), an
       `excludeLinksFromLockfile` lock, an importer with `dependenciesMeta` or
       `publishDirectory`.
    2. The importers against the members on disk (§15).
    3. **Each importer's specifiers against its `package.json`**, as
       `pnpm install --frozen-lockfile` does (`satisfiesPackageManifest`): the
       lock's three lists together are the manifest's `devDependencies`,
       `dependencies` and `optionalDependencies` merged with the later list
       winning, plus, when the lock's `autoInstallPeers` is on, the
       `peerDependencies` the others do not name; every name and specifier
       equal; and each name in the list pnpm puts it in (a name in
       `optionalDependencies` there, in `dependencies` before
       `devDependencies`). A difference names the importer, the dependency, the
       specifier in `package.json` and the one in the lock:
       `packages/web: react is "^19.0.0" in package.json and "^18.2.0" in pnpm-lock.yaml`.
       A link's name must be the member's own name (§11).
    4. **`overrides`**: the lock's section must equal the project's
       (`pnpm.overrides` in the root `package.json`, then `overrides` in
       `pnpm-workspace.yaml`, which wins). A frozen install installs what the
       lock says and applies no override, so this is a freshness check only.
    5. **`catalogs`**: each entry the lock records must equal the one
       `pnpm-workspace.yaml` (`catalog`, `catalogs`) declares.
    6. The target: a package that does not match it (§19).
    7. The places (`planLayoutFromPaths`' rules: unsafe names, a case collision,
       a parent not installed) and the plan's own proof (§12).
19. **Platform.** A package whose `os`, `cpu` or `libc` does not match the
    target is left out when its snapshot is `optional`, with whatever only it
    needs (arborist's `optionalSet`, on the model's graph), and is refused by
    name when it is not. The target is the host alone by default. `--os`,
    `--cpu` and `--libc` (repeatable; `current` is the host) replace a dimension
    as pnpm's `supportedArchitectures` does, and a package is installed when
    every dimension it restricts has a supported value that satisfies it.
    `--supported-architectures project` reads the project's own setting
    (`pnpm.supportedArchitectures` in `package.json`, or
    `supportedArchitectures` in `pnpm-workspace.yaml`) and only then: HoBo's
    adds arm64, which is 1,162 MB it does not need on the machine it is
    installed on. Every package left out is reported with its reason.

### What is refused

20. By name, whole, with nothing installed or removed:
    - `patchedDependencies`: `opm` does not apply patches. This is a stated
      boundary of the install, not of the model. HoBo and ai-bdd have none;
      OpenSesame has four.
    - A package from a git repository, a directory, a `file:` archive or a
      runtime; and an `http(s)` tarball without an integrity. A tarball with one
      is installed from its URL, as a `tarball` source.
    - A package with no integrity, or only a sha1.
    - An injected workspace package (`dependenciesMeta.injected`), a
      `publishDirectory`, a `link:` in a snapshot or to a directory that is not
      an importer, a `link:` that is not named for its member.
    - A lock written with `excludeLinksFromLockfile: true`: its links are not in
      the lock, so the lock cannot say what the importers link.
    - Anything ADR 0052 refuses (another `lockfileVersion`, a second YAML
      document from pnpm 11, an anchor).
21. **Lifecycle scripts are not run** (ADR 0046 §9, unchanged; this slice adds
    no script execution). An npm lock says which packages declare an install
    script (`hasInstallScript`); a pnpm lock does not (`requiresBuild` is kept
    in `node_modules/.modules.yaml`, not in the lock). So for a pnpm lock the
    host reads each archive it has extracted and lists, as the npm path does,
    the packages whose `package.json` has a `preinstall`, `install` or
    `postinstall` script, or that ship a `binding.gyp` and no `install` script.
    `allowBuilds` and `onlyBuiltDependencies` are not consulted: they say which
    scripts pnpm would be allowed to run, and none is. Consequences says, for
    the four packages HoBo's `allowBuilds` names, whether each works without its
    script.

### Which lock

22. **`opm ci` takes the lock the project has.** One of `pnpm-lock.yaml` and
    `package-lock.json`: that one. Both: the root `package.json`'s
    `packageManager` decides (`pnpm@…` is `pnpm-lock.yaml`, `npm@…` is
    `package-lock.json`); with that field absent or naming another manager, the
    install is refused naming both files and asking for one to be removed. A
    project that has both and nothing to choose between them has been installed
    by two tools that disagree, and guessing is how the wrong one gets
    installed. `yarn.lock` is not read.

### Seeing the plan

23. **`opm ci --plan`** reads, checks and plans, and does nothing else: no
    fetch, no write, no removal. It prints what the install would do: instances,
    places, members, links, what is left out by reason, what is refused. It is
    the whole of the install up to the first byte fetched, so a lock that
    `--plan` accepts fails later only on the network, the store or the disk.

## Consequences

To be measured against the three repositories and recorded below, with the
oracle (an independent reading of each lock in Python, and Node's own lookup
paths over the tree on disk): see the acceptance section once written.

Costs and limits, stated so nobody finds them by surprise.

- **Not pnpm's layout.** A tool that expects `node_modules/.pnpm` finds none; a
  package that reaches a dependency it does not declare may find it (hoisting)
  or not (pnpm's own isolation). Node resolves every declared edge.
- **No patches, no scripts, no `.npmrc`.** A lock that depends on a patch is
  refused; a package whose install script is needed is installed as it is and
  says so; a registry or auth in `.npmrc` is not read (`opm auth` and
  `OPM_REGISTRY_NPM` are how opm is told).
- **A link is named for its member and lives in the project's `node_modules`.**
  A sibling the lock links under another name is refused.
- **`--filter` installs a superset of pnpm's** (§16).
- **`packageExtensionsChecksum` and `pnpmfileChecksum`** are not recomputed: a
  hook that changed the graph when the lock was written is not checked for
  freshness, and the lock is installed as written.
- **`dependenciesMeta` in a manifest is not read**, so a manifest that adds
  `injected` since the lock was written is not seen as stale.
- **The settings in the lock are the authority**, not `.npmrc`:
  `autoInstallPeers` decides whether peers are in the importers' specifier sets.
- **Nothing here ran on macOS or Windows.**
