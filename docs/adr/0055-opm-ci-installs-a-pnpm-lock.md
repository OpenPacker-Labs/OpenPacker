# ADR 0055: `opm ci` installs a pnpm lock

- Status: Accepted
- Date: 2026-10-12; amended 2026-10-17 after the independent review of #179 (§1,
  §7, §11, §15, §18, §19, §20, §23 and Costs)
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
   builds and gives it to the same layout check and writer.** `readFrozenLock`
   of the npm format chooses the lock (§22) and, for a pnpm lock, returns the
   `FrozenLock` the npm path returns: packages, each with a place (the key an
   npm lock would give it), the member links, the members to shim, what is left
   out and why, what is refused. The host (`opm-project`) is unchanged in how it
   judges policy, takes archives from the store or the lock's origin, proves the
   integrity and writes: `planLayoutFromPaths` checks the places, and
   `writeNodeModules` writes them. There is no second writer. **There is a
   second placement planner:** an npm lock's places were chosen by arborist, a
   pnpm lock's are chosen here (`pnpm-install/place.ts`), which re-implements
   `layout-plan.ts`'s nesting rules for several tops (§10). Two planners that
   must agree on Node's lookup are a maintenance cost; §12's proof and the
   oracle are what keep them honest.
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
   the only origins contacted are the ones the packages being installed have
   (the version's `+build` metadata is dropped from the file name, as pnpm's own
   `@pnpm/tarball-url` drops it); a `tarball` resolution is a `tarball` source
   and the default policy refuses it for a transitive dependency. A package
   without a sha512, sha384 or sha256 integrity is refused by name (a sha1 only
   is refused too: it does not pin the bytes). `deprecated` becomes a lifecycle
   fact. The integrity proves the bytes and not what they hold, so after
   extraction the host reads each archive's own `package.json` and refuses one
   whose name or version (a leading `v` or `=` and build metadata aside) is not
   the lock's (`DIGEST_MISMATCH`, before `node_modules` is touched). The version
   is the one the lock records for the archive: a registry package's, or a
   tarball entry's own `version` (its key holds the URL), and a tarball entry
   with none has its name compared alone; a `name` the entry writes beside its
   key must match as well. A name is compared without regard to case, as pnpm
   compares one: pnpm makes the same check when it reads a package back from its
   store (`ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE`, on by default through
   `strict-store-pkg-content-check`); npm does not make it. Every value the
   archive gives is quoted and escaped as the lock's values are.

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
11. **A member link** is a link at `node_modules/<name>` in the project, where
    the name is the one the importer gives the dependency: the member's own
    name, or an alias (`"e": "workspace:b@*"` is a link at `node_modules/e`), as
    pnpm links it. It is a name no other package is allowed to take there, so a
    registry package of the same name wanted by something hoisted is nested
    beside its dependent, and two importers linking different members under one
    name is refused by name. Every link stays in the project's `node_modules`: a
    link inside a member's `node_modules` is outside ADR 0050's rule, and this
    does not extend it.
12. **The plan proves itself.** Before it is returned, every edge of every
    placed instance and every importer is resolved on the planned tree by the
    algorithm of point 8, and any edge that does not find its target is a bug in
    the planner, not a reason to install: the install is refused with the edge
    named. The tests use the same function. The acceptance runs check a plan a
    second time with a walk that shares none of its structure (the real ancestor
    directories of the planned tree, and, on a tree on disk, Node's own
    `require.resolve.paths`), against the lock read by PyYAML:
    `packages/adapter-npm/test/pnpm-install-oracle`.

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

15. **The importers are the project's members.** pnpm holds the projects on disk
    to the lock, not the lock's list to the disk, and so does this. An importer
    whose member the project no longer has (`pnpm-workspace.yaml`, the discovery
    of ADR 0049, never following a link) is left out: not installed, its
    directory neither cleared nor filled; a member that still links it is
    refused as opm's own rule. A member the lock does not list is installed as
    pnpm installs it when it has no dependencies (pnpm's
    `allProjectsAreUpToDate` asks no more of one), and refused, as opm's own
    rule, when it has some. A project with no `pnpm-workspace.yaml` is its root
    importer, `.`.
16. **Selection.** With no option every importer is installed.
    `--filter <selector>` (pnpm's grammar, ADR 0049 §7), `-w` and `--workspaces`
    choose importers as `opm run` does (ADR 0053); the root importer is left out
    of such a selection unless `--include-workspace-root` is given;
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
       `publishDirectory`, a lock written with `ignoredOptionalDependencies`.
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
       `"packages/web": "react" is "^19.0.0" in package.json and "^18.2.0" in pnpm-lock.yaml`.
       Every value from the lock, `pnpm-workspace.yaml` or a `package.json`
       reaches a message JSON-quoted, with C1 controls, bidirectional overrides
       and zero-width characters escaped too, and cut at 200 characters. An
       importer whose `package.json` sets `publishConfig.directory` when the
       lock records no `publishDirectory` for it is stale (pnpm:
       `OUTDATED_LOCKFILE`).
    4. **`overrides`**: the lock's section must equal the project's, read as
       pnpm 10 reads it: the root `package.json`'s (`resolutions`, then
       `pnpm.overrides` winning) when it has any, **replacing**
       `pnpm-workspace.yaml`'s `overrides` whole, and the workspace file's only
       when `package.json` has none (pnpm's `getOptionsFromRootManifest` is
       spread over the config at install; real pnpm 10.28 accepts only the
       `pnpm.overrides` value when all three set one name); `$name` is the
       root's specifier for `name`. A frozen install installs what the lock says
       and applies no override to it, so for what is installed this is a
       freshness check only. **For the importers it is more:** pnpm applies a
       project's overrides to every manifest it reads before it compares
       specifiers, so an importer that asks for `ts-autocode-rewrite@0.1.0` has
       `workspace:*` in the lock when the root overrides it, and HoBo's lock has
       five such specifiers (the check of 3 was refused on all five until it
       applied the overrides first). They are applied by pnpm's own procedure
       (`createVersionsOverrider`): a `parent>name` whose parent is the importer
       (named from its `package.json`, the root's too when there is no
       workspace; its range by `satisfies`) before a plain one; `name@range`
       when the two ranges intersect (node-semver's `intersects`,
       `pnpm-install/ranges.ts`); of several that apply, the one pnpm's
       comparator sorts first, sorted the same way, so the order written decides
       as it does for pnpm; `-` drops the dependency; a `file:` or `link:`
       replacement is made relative to the importer; a peer is overridden too,
       and moves to `dependencies` when the replacement is not a peer range
       (node-semver's `validRange`, which takes `v1` and `~>1` as ranges too). A
       selector is split at the first `>` pnpm splits at. The range reader
       agrees with node-semver on ranges of whole versions without a prerelease
       written with `^`, `~`, comparators, x-ranges, hyphen ranges and `||` (0
       differences over about 45,000 random pairs against node-semver 7.8, and
       over the 37,182 of the second review's differential; `>=0.0.0` is `*`, as
       node-semver's `replaceGTE0` makes it); a range outside those forms
       (`~>1`, `v1.x`, `<*`, `<=1.2`, a prerelease bound) is not guessed:
       whether the override applies is refused as opm's own rule, naming it.
    5. **`ignoredOptionalDependencies`**: a lock written with it is refused
       (§20); a project that sets it (`package.json` first, then the workspace
       file) when the lock does not is stale, as pnpm finds it
       (`LOCKFILE_CONFIG_MISMATCH`).
    6. **`catalogs`**: each entry the lock records must equal the one
       `pnpm-workspace.yaml` (`catalog`, `catalogs`) declares.
    7. The target: a package that does not match it (§19).
    8. The places (`planLayoutFromPaths`' rules: unsafe names, a case collision,
       a parent not installed) and the plan's own proof (§12).
19. **Platform.** A package whose `os`, `cpu` or `libc` does not match the
    target is left out when its snapshot is `optional`, with whatever only it
    needs (arborist's `optionalSet`, on the model's graph), and is refused by
    name when it is not. The target is the host alone by default. `--os`,
    `--cpu` and `--libc` (repeatable; `current` is the host) replace a dimension
    as pnpm's `supportedArchitectures` does, and a package is installed when
    every dimension it restricts has a supported value that satisfies it.
    `--supported-architectures project` reads the project's own setting
    (`pnpm.supportedArchitectures` in `package.json`, which wins as it does for
    pnpm, or `supportedArchitectures` in `pnpm-workspace.yaml`) and only then:
    HoBo's adds arm64, which is 1,162 MB it does not need on the machine it is
    installed on. Every package left out is reported with its reason, and the
    machines are printed when there are several.

    **This is opm's selection rule, chosen deliberately, and not pnpm's.** It is
    the optional flag, then the closure of what needs a dropped package
    outright, then the walk from the importers, each computed in time linear in
    the lock. Under `--no-optional` it installs exactly what pnpm 10.28 installs
    (77 of 77 random locks in the review, against real headless installs).
    Otherwise it differs from pnpm in these documented ways, each found by a
    differential run against real pnpm over 680 random locks:
    1. **pnpm's order-dependent skip** (pnpm installs less): pnpm marks a shared
       optional child skipped when it first reaches it through an unsupported
       parent and does not revisit it from a supported one, even through a
       required edge (`a -> {p1 (darwin), p2 (linux)} -> c`: pnpm leaves out
       `c`, which `p2` needs). opm installs it.
    2. **pnpm's `--prod` over-install** (pnpm installs more): a dev-only package
       without the optional flag, reachable through a skipped subtree, is
       installed by pnpm and left out by opm.
    3. **Drop propagation** (pnpm installs more): opm also drops an optional
       package that needs a platform-skipped package outright (arborist's
       `optionalSet`); pnpm keeps it.
    4. **Platform negation**: with `os` targets `linux` and `win32`, pnpm skips
       a package that says `os: ['!win32']` (any supported value negated fails
       pnpm's `checkList`); opm installs it, because it runs on `linux`.
    5. **A non-optional package for another platform** is refused by opm; pnpm
       only warns, unless `engine-strict` is set.
    6. **`engines` is not read**: pnpm skips an optional package whose
       `engines.node` the running Node fails; opm installs it.

    The oracle (`model-oracle.py`) re-implements this rule in independent code;
    it is not an independent model of pnpm, so it cannot see these six.

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
      an importer, a `link:` to an importer the project no longer has (§15).
    - A lock written with `ignoredOptionalDependencies`: pnpm also takes those
      names out of the importers' `package.json`, which opm does not.
    - An override whose range opm does not read as pnpm does (§18.4).
    - A member the lock does not list that has dependencies (§15).
    - An archive whose own `package.json` is not the package the lock names
      (§7).
    - A lock written with `excludeLinksFromLockfile: true`: its links are not in
      the lock, so the lock cannot say what the importers link.
    - Anything ADR 0052 refuses (another `lockfileVersion`, a second YAML
      document from pnpm 11, an anchor), and the same of `pnpm-workspace.yaml`,
      which is read by the lock's own bounded reader (at most 1 MiB, opened
      without following a link: a link is `UNSAFE_PATH`; nesting, lexemes and
      repeated keys bounded in linear time; tags, anchors, aliases and
      directives refused). Workspace discovery, which reads the same file for
      its `packages:`, refuses nesting deeper than 64 and finds repeated keys in
      linear time too.

    Only the refusals of a stale lock (§18.3, §18.4's overrides, §18.5's
    project-side `ignoredOptionalDependencies`, §18.6, and
    `publishConfig.directory`) say that `pnpm install --frozen-lockfile` would
    refuse too: the review of #179 saw real pnpm refuse each. Every other
    refusal here, a patch the project declares among them, is opm's own rule and
    says so.

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
    `--plan` accepts fails later only on the network, the store or the disk. The
    same plan prints the same text, with no wall time in it, so two plans can be
    compared.

## Consequences

Measured on 2026-10-12, linux-x64 (glibc 2.39), Node 22.22.0, a 4-CPU VM other
work was using, against registry.npmjs.org through the sandbox proxy, with the
shared store at `OPM_STORE_HOME` (about 4.8 GB, filled by earlier installs, so
"from the store" below is a warm store). Two readings that are not this code
check it: a Python reading of each lock with PyYAML (`model-oracle.py` for the
selection, `dump-edges.py` for the edges) and Node's own lookup paths over the
tree on disk (`require.resolve.paths`, `package.json` read at the place found).

| Measured                                                       | Result                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the model, against PyYAML                                      | ai-bdd (393 instances, 749 edges), the HoBo cut (436, 801), the OpenSesame cut (348, 510), the hand-written exotic lock (22, 13): the counts and a digest of every edge agree                                                                                                      |
| the selection, against a plain walk                            | four locks, linux x64, x64 and arm64, `--omit dev`, every machine: installed, platform-skipped and orphaned counts and a digest of the installed keys agree                                                                                                                        |
| HoBo's whole lock, planned (`opm ci --plan`)                   | 792 importers, 1,851 packages in 2,564 places from 1,818 archives, 335 optional and 7 needed-only-by-those left out, 0 refusals, 1.6 s (the 792 `package.json` read and held to the lock included)                                                                                 |
| HoBo against pnpm 10.33.4 itself                               | with `--supported-architectures project` the plan is 1,880 packages in 2,603 places from 1,847 archives; pnpm's own `node_modules/.pnpm` on this machine holds 1,880 snapshot directories of 1,847 `name@version`: **0 differences** in either direction                           |
| every edge of HoBo's plan, resolved the way Node does          | 7,397 edges (each importer's, each installed package's; 648 more lead to platform packages this machine does not install), the lookup walking the real ancestor directories of the planned tree: **0 mismatches**                                                                  |
| ai-bdd, `opm ci` (pnpm 10.28 lock, 9 importers, 393 snapshots) | 362 places of 353 packages; 229 from the store, 124 fetched (41.9 MB); 22.7 s; 40 optional left out; 8 members linked. `node_modules` 253,832 KB (`du -sk`, hard links counted once); the store grew by 123,120 KB                                                                 |
| that tree, resolved by Node                                    | 780 edges over every importer and every installed package, `require.resolve.paths` and `package.json` at the place found: **0 mismatches**, 0 entries the plan does not name, 362 of 362 places hold the name and version the plan says; the same 780 on the plan alone agree      |
| ai-bdd, run through `opm run`                                  | `typecheck` (`tsc -p tsconfig.json --noEmit` over all packages and their links) passes, 26.7 s; `test:unit` 4,908 tests pass, 1 fails: Playwright's ffmpeg is not in `/opt/pw-browsers` here (the same test fails without opm)                                                     |
| a package in two places                                        | ai-bdd places 8 packages twice (9 extra places, `vitest@5.0.3`, `playwright-core@1.64.0`, `zod@4.6.5` among them): the second place of all of them adds **384 KB** to 26,804 KB (directories and link counts; a file of the first place has 4 links)                               |
| HoBo, three members (`opm ci --filter`)                        | `provider-config` and `adapter-better-auth` (two `vitest@4.1.9` with different `@types/node` peers; the second links `@hobo/core`) and `ts-autocode-grounding`: 248 packages in 261 places, 53 fetched (16.8 MB), 18.2 s; `node_modules` 191,864 KB, the store grew by 68,876 KB   |
| that tree, resolved by Node                                    | 579 edges, **0 mismatches**; the two vitest variants load the `@types/node` of their own member                                                                                                                                                                                    |
| HoBo's scripts through `opm`                                   | `typecheck` of `provider-config` and of `adapter-better-auth` (after `opm run build` of `@hobo/core`, so through the link), 95 + 3 tests with `opm exec vitest run`. The `test` script runs `pnpm exec turbo` in its `pretest`, so it needs pnpm and is not run                    |
| ts-autocode and gitlang, npm locks                             | 438 and 758 packages, the figures of ADRs 0051 and 0054; `build:grounding`, `tsc --noEmit` and 50 tests, `build:libs` and the 312 node tests pass through `opm`. (Run with the shell's `GITHUB_TOKEN` set, 7 gitlang tests fail with or without opm: they assume no ambient token) |
| OpenSesame                                                     | refused by name for its 4 `patchedDependencies` (exit 3); its `.deepsec` lock plans (287 packages, 288 places)                                                                                                                                                                     |
| a stale lock                                                   | `zod` edited in `packages/sdk/package.json`: `packages/sdk: zod is "^9.9.9" in package.json and "^4.6.5" in pnpm-lock.yaml`, exit 3, the previous `node_modules` as it was                                                                                                         |

**HoBo's `allowBuilds`**, which this install does not run (`esbuild`,
`@ast-grep/cli`, `@bufbuild/buf`, `protobufjs`): each was installed by `opm ci`
and its bin run without the script. `esbuild --version` prints 0.28.1 (its
platform package is found without the `postinstall` link), `buf --version`
1.71.0, `ast-grep --version` 0.44.0 (it adds "Enable postinstall to avoid the
per-invocation overhead." to stderr), and `protobufjs@7.6.4` parses and encodes
a message. None needs its script to work here; `@ast-grep/cli` is slower without
it.

**What running it on the real repositories found, and is fixed.** The freshness
check refused HoBo on five specifiers because it did not apply the root's
overrides to the importers (§18.4); the first generated graph with packages
needing each other at different versions exhausted an 8 GB heap in the planner
(§12); and `FrozenLockPackage` has no way to say a pnpm package declares an
install script, which the host now reads from the archive (§21).

Costs and limits, stated so nobody finds them by surprise.

- **Not pnpm's layout.** A tool that expects `node_modules/.pnpm` finds none; a
  package that reaches a dependency it does not declare may find it (hoisting)
  or not (pnpm's own isolation). Node resolves every declared edge.
- **No patches, no scripts, no `.npmrc`.** A lock that depends on a patch is
  refused; a package whose install script is needed is installed as it is and
  says so; a registry or auth in `.npmrc` is not read (`opm auth` and
  `OPM_REGISTRY_NPM` are how opm is told).
- **A link lives in the project's `node_modules`**, under the name the lock
  gives it (the member's own, or an alias). Two importers that link different
  members under one name are refused.
- **The selection is opm's, not pnpm's** (§19): six documented differences, none
  under `--no-optional`.
- **Two placement planners** (§1): `pnpm-install/place.ts` repeats
  `layout-plan.ts`'s nesting rules for several tops.
- **The nested layout has a ceiling of 50,000 places** (`MAXIMUM_PLACEMENTS`),
  kept: HoBo's whole lock needs 2,564 for 1,851 packages, but dense generated
  graphs with many versions of each name duplicate heavily; in the review's run
  3,701 instances needed 44,558 places, and 9 of 60 generated locks were refused
  at the cap, cleanly and by name.
- **`publishConfig.directory` and `ignoredOptionalDependencies`** are not
  applied: an importer that sets the first is stale unless the lock records it,
  and a lock that records it is refused; a lock written with the second is
  refused, and a project that sets it for a lock that does not is stale.
- **`pnpm-workspace.yaml` is read as strictly as the lock**: an anchor or a tag
  in it, which pnpm would read, is refused.
- **`--filter` installs a superset of pnpm's** (§16).
- **A plan can be refused for a shape only symlinks hold** (§12): packages that
  need each other at different versions. No lock here has one.
- **`packageExtensionsChecksum` and `pnpmfileChecksum`** are not recomputed: a
  hook that changed the graph when the lock was written is not checked for
  freshness, and the lock is installed as written.
- **`dependenciesMeta` in a manifest is not read**, so a manifest that adds
  `injected` since the lock was written is not seen as stale. An `overrides`
  selector or dependency whose range is outside the forms opm reads as pnpm does
  is refused rather than guessed at (§18.4).
- **The settings in the lock are the authority**, not `.npmrc`:
  `autoInstallPeers` decides whether peers are in the importers' specifier sets.
- **HoBo was planned whole and installed in part**, not installed whole (about
  2.9 GB for linux x64 here); ts-autocode and gitlang were installed whole.
- **Nothing here ran on macOS or Windows.** The case rule and the link creation
  are the platform-specific parts (ADRs 0050 and 0054).
