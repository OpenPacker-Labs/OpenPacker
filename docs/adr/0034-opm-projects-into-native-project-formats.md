# ADR 0034: opm maintains the ecosystem's own project files

- Status: Accepted
- Date: 2026-08-10
- Amends [ADR 0022](0022-opm-package-manager-surface.md) (“does not replace
  native ecosystem install layouts by default”)
- Amended by
  [ADR 0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md):
  the `layout` level needs no native manifest, plans nested versions from the
  lock's edges, and links files from the store
- Amended by [ADR 0050](0050-workspace-member-links.md): the handle-relative
  create gains workspace-member links, on Windows as a junction made relative to
  the parent handle (and the one window that leaves)
- Amended 2026-10-31: a no-follow walk takes the links on the way to a trusted
  base, and none below it
  ([Amendment](#amendment-2026-10-31-the-links-on-the-way-to-a-base))

## Context

`opm` decides from `opm.toml` and records the result in `opm.lock.json` and
`.opm/store`. Nothing else reads any of those. An IDE, a CI job, `dotnet build`
and `node` all read `package.json` or the `.csproj`, so a project managed with
`opm` looked, to every other tool, like a project with no dependencies at all.

ADR 0022 said opm “does not replace native ecosystem install layouts by
default”, which was the right instinct — a package manager that silently
rewrites `node_modules` is hard to trust — but it left opm unable to participate
in a real project.

## Decision

`opm` **projects** its decisions into the ecosystem's own project files.

1. **`opm.toml` stays authoritative.** Projection is one-way. Nothing here reads
   a native manifest to decide what to install; a later `opm import --native`
   may, and `ProjectFormat.readRequirements` exists so it can, but a projection
   never changes what opm resolved.

2. **Vendor formats live in adapters.** `ProjectFormat` is an optional
   `AdapterModule` export, discoverable through
   `prex.registry.project-manifest/1` and its siblings. Core never learns what a
   `.csproj` is, exactly as it never learns what an apt package is
   ([ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md),
   [ADR 0032](0032-wit-adapters-and-registry-definition.md)).

3. **Three levels, opted into by depth.** `manifest` writes the declaration file
   and is the default; `lock` also writes the native lockfile; `layout` also
   materialises the native install layout. `off` restores the old behaviour. A
   level an adapter does not advertise does not happen.

4. **Only what opm wrote is ever removed.** `.opm/native.json` records the names
   opm has written per ecosystem. A dependency someone added by hand is not in
   that record and is never deleted — treating `opm.toml` as an allowlist over a
   file opm does not own would destroy work.

5. **Edits are surgical.** These files are hand-maintained, comment-bearing and
   version-controlled. A projection changes the smallest span it can and
   preserves indentation, line endings and everything else byte-for-byte, so
   `opm add` produces a one-line diff. It refuses to write a file carrying merge
   conflict markers, and writes through temp-then-rename.

6. **A projection that cannot be faithful says so.** `ProjectionResult` carries
   `SemanticLoss`. A scope npm has no field for, a Gradle build script that is a
   DSL rather than a data file, a native lockfile whose integrity value was
   never captured — each records loss instead of writing something the native
   tool would not have written.

## Consequences

The ADR 0022 sentence about not replacing native layouts is amended, not
deleted: the `layout` level exists, but it is opt-in, and it states in its loss
that the result is _equivalent to_ rather than _produced by_ the native tool.
Native layout projection and `.opm` project-state mutation use the same
no-follow, handle-relative open on Linux, macOS, and Windows. Linux maps an open
directory through `/proc/self/fd`. macOS, where `/dev/fd/N/child` does not
resolve, calls libc `openat`/`mkdirat`/`renameat`/`unlinkat`/`fstatat` through
koffi ([ADR 0045](0045-macos-child-io-uses-libc-at-calls.md)). Windows opens
children with `NtCreateFile` relative to the parent OS handle (`RootDirectory`,
`OBJ_DONT_REPARSE` / `FILE_OPEN_REPARSE_POINT`) — openat semantics, never a
lexical pathname fallback or a `GetFinalPathNameByHandle` re-walk. Path escapes,
symlink swaps, and linked metadata still fail closed with `UNSAFE_PATH`. A
platform without that mapping still refuses rather than degrading to pathname
checks.

`opm` is now safe to run in an existing npm or .NET project: it adds what it
manages and leaves everything else where it was. That is the property that made
this worth doing, and the reason projection is one-way and removal is
record-scoped.

Native lockfiles pin with ecosystem-specific integrity over the archive bytes —
npm SRI, NuGet base64 sha512, Cargo sha256 hex — so `LockPackage` gained
`nativeIntegrity`, captured at resolve time where the bytes are in hand. A
format whose value was not captured does not get a lockfile rather than getting
a wrong one.

## Amendment (2026-10-31): the links on the way to a base

### What was wrong

The no-follow open above was implemented three ways, and none drew the line
where the guarantee needs it:

- `openStableDirectory` in `project-io` (every `writeFileAtomic`, the
  materializer, `opm pack` output) walked from `/` with `O_NOFOLLOW` at every
  component. A path whose base runs through a link failed with
  `ENOTDIR: not a directory, open '/proc/self/fd/N/<link>'`. On macOS every
  `$TMPDIR` is under `/var`, a link to `/private/var`, so any project, scratch
  directory or bin scan there failed; so did a project in a linked directory and
  a `HOME` or XDG directory behind a link. On Linux the same showed with
  `TMPDIR` pointed at a link: `rollback-mounts.test.ts` failed 8 of 8, the
  `project-io` suite 16 tests and the `opm-project` suite 456 of 1364.
- `openStableDirectory` in `opm-project` and `openProjectDirectory` in
  `project-io` (the layout walkers) did the opposite: before walking they ran
  `realpath` over every existing component but the last. That honoured a linked
  `$TMPDIR`, and also followed a link swapped in _inside_ the tree. With
  `<project>/.opm/store` replaced by a link, a write to
  `<project>/.opm/store/<entry>/meta.json` was made where the link pointed; only
  the last component was refused.

### Decision

A **trusted base** is a directory the operating system or the person chose. Its
own path is resolved with `realpath` once, when it is taken, and recorded; every
component below it is opened with `O_NOFOLLOW`, as before. Nothing below a base
is ever resolved, so a link there is refused wherever it is, not only last.
`trusted-base.ts` in `project-io` holds the rule, and every no-follow directory
walk (`openStableDirectory` in both packages and `openProjectDirectory`) goes
through `stableTarget`, which replaces the longest base a path begins with by
that base's real path.

The bases are:

- **taken**: `trustBase(path)` resolves and records one. `projectPaths(root)` in
  `opm-project` takes the project root, so every entry point that names a
  project takes it, and `requestedSharedStore` takes the shared store root an
  environment names, whether or not it is this process's; taking a base again
  resolves it again;
- **the environment's**, read and resolved by the walk that starts under one:
  `os.tmpdir()`, `os.homedir()` and the absolute values of `XDG_CACHE_HOME`,
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `OPM_STORE_HOME`,
  `OPM_TOOL_CACHE` and `OPM_PLUGIN_HOME`. Code that makes a directory under
  `TMPDIR` or a home does not have to take it first.

A path under no base is walked from `/` with every link refused. The record is
one per process (both module builds share it, ADR 0017) and keeps the 512 most
recently taken bases.

**A project root that is itself a link is accepted.** That is how `npm`, `pnpm`
and `git` behave. Started in a linked directory, each sees the real one
(`process.cwd()` and `getcwd(3)` report it); named one by path (`npm --prefix`,
`pnpm --dir`, `git -C`), each works through the link as any path does, and
`git rev-parse --show-toplevel` reports the real top level. opm does the same:
the root is a base, its last component included, so `opm init --path` with a
link to a checkout works on the checkout. Everything inside the project, `.opm`
and `node_modules` included, is below the base, so a link there is refused as
before. The links of a base are the person's and the system's, not the
project's: a link a project commits (`packages -> ../outside`) is below its root
and still refused (ADR 0050).

The shared store root keeps its own stricter rule: `ensurePrivateRoot`
(ADR 0048) still refuses an `OPM_STORE_HOME` that is itself a link, because its
owner and mode are what is judged and a link's own are meaningless. A store
under a linked `HOME` or `XDG_CACHE_HOME` is fine: the links are on the way to
it.

The sandbox (ADR 0036, 0045) still refuses a link in anything it binds, because
a bind helper resolves a path again when it binds. A grant, the jail's working
directory and a directory authority are now taken at the real path of their base
first (`assertSafeJailPath`, `runInSandbox`), so what is bound has no link in
it; a link below the base is refused as before. Before, every lifecycle script
under a linked `TMPDIR` was refused with "path must not contain symbolic links".
The root and home checks now compare a path, and its real path, with `HOME` as
written and as its real path: before, the real form of a linked `HOME` passed
them as somewhere else. Inside the jail a granted directory is at its real path,
and a path spelled through the link does not resolve there, so a lifecycle
script is given the real path as its working directory and `INIT_CWD` (npm's
`INIT_CWD` is the real directory too: it is `process.cwd()`). A caller that puts
another absolute path into a jailed program's arguments or environment spells it
the same way.

`opm pack` walks the project's real path, and compared what it found with the
excluded paths as written, so under a linked `TMPDIR` it packed its own previous
output. An excluded path inside the root is now also excluded under the root's
real path.

### What this guarantees

No component below a base is followed by a walk: a link there is refused with
`ENOTDIR` or `ELOOP` from the open (`UNSAFE_PATH` from the walkers that wrap
it), and nothing is made where it points. A base's own links are taken as they
were when it was taken; a walk under it opens that real path, so a link
retargeted later does not redirect the walk. `assertNamedDirectory` compares
each handle with what its path names now (a base through its link, anything else
by its own name), so such a retarget, or a component swapped since the walk, is
still reported as the directory having changed.

### Tests

Each failed before this change and passes after it:

- `project-io/src/trusted-base.test.ts`: writes and walks under a `TMPDIR` that
  is a link, under `TMPDIR` laid out as on macOS (a `var` link to `private/var`
  in a temporary world), under `HOME` and `XDG_CACHE_HOME` links, in a project
  reached through a linked parent, in a project root that is a link, and a
  layout written there; and the refusals of a link below a taken root, below a
  linked `TMPDIR`, swapped in after the root was taken, and on the way to a path
  under no base (`openProjectDirectory` followed each of these before);
- `opm-project/test/symlinked-base.test.ts`: `opm init` and `opm add` with a
  `node_modules` layout under a `TMPDIR` link, the macOS shape, a linked parent,
  a root that is a link, and a shared store under a linked `HOME` and
  `XDG_CACHE_HOME`; and the refusal of a link at `.opm/store` in a project
  reached through a link (followed before; a link at `.opm` itself was refused
  before and after);
- `opm-project/test/symlinked-base.test.ts` also packs a project twice under a
  linked `TMPDIR` and compares the tarballs (the second held the first before);
- `sandbox/src/trusted-base.test.ts`: a jail run in, and binding, a directory
  under a linked `TMPDIR` and under the macOS shape (with an authority opened
  through the link), and the user home known by its real path; and a grant
  through a link below the base, refused before and after;
- `opm-project/test/symlinked-base.test.ts` also runs a lifecycle script under a
  linked `TMPDIR` in the native jail and checks it ran, at the real path, with
  `INIT_CWD` naming it;
- `rollback-mounts.test.ts` and `lifecycle-sandbox.test.ts`, unchanged, under
  `TMPDIR` pointed at a link.

Three existing tests honoured a link with no base taken
(`materialises through a symlinked ancestor of the root`,
`operates through a symlinked ancestor of the project root`,
`detects a swap of a symlinked ancestor while a handle is held`). Each now takes
its project root first, as every opm entry point does, and checks the same
thing. Three sandbox tests
(`retains the approved directory when its pathname is swapped`,
`allows project source writes only when projectWrite is granted`,
`allows package-local writes`) named a granted directory as written; under a
linked `TMPDIR` they now name it by its real path, where the jail has it.
