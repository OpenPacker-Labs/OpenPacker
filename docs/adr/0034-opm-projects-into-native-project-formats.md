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
  materializer, `opm pack` output) and `openStablePath` (the sandbox's grants)
  walked from `/` with `O_NOFOLLOW` at every component. A path whose base runs
  through a link failed with
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

A **trusted base** is a directory the operating system or the person chose. It
is resolved once and kept for the command; every component below it is opened
with `O_NOFOLLOW`, as before. Nothing below a base is ever resolved, so a link
there is refused wherever it is, not only last. `trusted-base.ts` in
`project-io` holds the rule, and every no-follow directory walk
(`openStableDirectory` in both packages, `openProjectDirectory` and
`openStablePath`) is the one walk in `stable-walk.ts`, which opens the real path
of the longest base the path begins with, checks that what it reached there is
the directory the base was resolved to, and goes on below it.

The bases are:

- **taken**, by the code that was handed the path, which names who chose it
  (`trustBase(path, chooser)`): the project root a command was given
  (`projectPaths(root)` in `opm-project`, so every entry point that names a
  project takes it); the shared store root an environment named, the opmx tool
  cache and the directory of opm's own configuration (`opm auth`), each only
  once it was made, opened and found owned by this user and writable by nobody
  else (`ensurePrivateRoot`, `openToolCache`, `openJudgedRoot`). Each of the
  three has its own chooser (`'validated private root'`, `'tool cache'`,
  `'config root'`); none of them is a project root. A root that is refused is
  never a base. No other code may take one: a function handed a path it cannot
  vouch for has no chooser to name;
- **the environment's**: `os.tmpdir()`, `os.homedir()` and the absolute values
  of `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and
  `OPM_PLUGIN_HOME`, each resolved the first time a walk starts under it and
  kept. Code that makes a directory under `TMPDIR` or a home does not have to
  take it first. `OPM_STORE_HOME` and `OPM_TOOL_CACHE` name roots that are
  judged before they are used, so they are taken then, not read as bases.

A path under no base is walked from `/` with every link refused. The taken bases
are one record per process (both module builds share it, ADR 0017); the 512 most
recently taken are kept. A command is a process for the CLI; `runOpm`, `runOpmx`
and the `openpacker` CLI's `runCli` begin every command they run with
`beginCommand(cwd)` and end it with the function it returns, whichever way the
command ends. A command begun while none is running forgets what the last one
took; one begun while another runs forgets nothing and only adds its own fences,
so two commands running at once in one process never drop each other's fences or
bases, and both sets hold for both until the last ends. A test suite forgets
between tests (`forgetBases`). Code that uses the library directly
(`@openpacker/opm-project`, `@openpacker/project-io`) calls `beginCommand` with
its working directory before anything else, and what it returns when it is done:
without it, it is fenced only by the roots it takes and by the checkouts its
bases lie in.

**How a base is resolved.** Not by `realpath(3)`, which follows every link the
kernel will and knows nothing of a project, and not name by name with `lstat`
and `readlink` on paths, which a swap between the look and the follow defeats.
`base-resolve.ts` opens each directory relative to the handle of the one before
(`/proc/self/fd/N` on Linux, `openat`, `fstatat` and `readlinkat` on macOS),
looks at a name once, relative to that handle, and follows a link only when two
rules allow it:

- **no link in a fence.** A fence is a directory's identity (its device and
  inode). A link whose directory, or any directory above it on the way, is
  fenced is that directory's and is not followed, whatever path named the fenced
  directory: a bind mount of a project, a case variant on a case-insensitive
  volume and a firmlink are the same directory, so the same fence;
- **no link in a checkout.** A directory that holds `.git` (a directory, or the
  gitfile of a worktree or a submodule), looked at relative to its own handle,
  is a checkout, and a link in it or below it is not followed, whether or not
  anything fenced it: a checkout's links are its own however the checkout is
  named or reached;
- **`fs.protected_symlinks`' own rule, whatever the system's setting.** A link
  in a sticky directory that anyone may write to (`/tmp`) is followed only when
  it belongs to the user resolving it or to that directory's owner;
- **no link another user may have made.** A link in a directory its group or
  anyone may write to, sticky or not, is followed only when it belongs to the
  user resolving it or to root. It is judged at every component of a base, the
  last one included, so the tool cache and the configuration root, which may end
  in a link, are held to it there too. (The kernel would follow the directory
  owner's link in a sticky directory; opm does not, unless that owner is root or
  the user.)

The text of a link is read relative to the same handle and used only if the name
is still the link that was judged. A link not followed ends the resolution, and
the rest of the path is kept as written for the walk to refuse. The real path is
read from the last handle, as the system names that directory
(`/proc/self/fd/N`, `fcntl(F_GETPATH)` on macOS).

**What a project holds is the project's, not the person's.** Every taken root is
fenced, and so, before any base is resolved, is everything `beginCommand` finds
a command may not resolve a base through (`fenceWorkingProject`,
`checkout-fences.ts`):

- the project it runs in: the nearest directory above the working directory's
  real path, and below the home directory, that holds `opm.toml`,
  `opm.lock.json`, `package.json` or `.git` (or the working directory itself
  when none does);
- every checkout around it: each directory from the working directory up to the
  file system's root, past the home directory, that holds `.git`, a directory or
  a gitfile. A gitfile's `gitdir:` is followed back to the repository that holds
  it, and from there to the superproject of a submodule
  (`super/.git/modules/lib`) and, by its `commondir`, to the main work tree of a
  worktree (`main/.git/worktrees/feature`), each fenced and walked the same way.
  A submodule or a worktree nested in its main work tree leaves no outer
  checkout unfenced;
- the work tree git is told of: `GIT_WORK_TREE`; with `GIT_DIR` alone,
  `core.worktree` and the working directory (git's top level then); and the
  directory that holds `GIT_DIR`;
- the tree it runs in, a checkout or not (an exported archive, a Docker
  context): the topmost directory of the working directory below the deepest of
  the home and temporary directories that holds it, else below the file system's
  root (`/workspace` for `/workspace/repo/packages/a`, `~/code` for
  `~/code/repo/packages/a`), and the temporary directory itself where it holds a
  project marker and the command runs in it;
- every checkout around each base the environment names, wherever the command
  runs: `TMPDIR`, `HOME` and its defaults (`~/.cache`, `~/.config`,
  `~/.local/share`, `~/.local/state`), the XDG directories, `OPM_PLUGIN_HOME`,
  `OPM_STORE_HOME`, `OPM_TOOL_CACHE` and `OPM_AUTH_CONFIG`, walked from where
  each is written.

So a command run in a monorepo's package (`repo/packages/a`, with a
`package.json` of its own) fences that package, the repository's root and the
tree around it, and a link committed at the root (`repo/.cache -> /outside`) is
the checkout's. The home directory, the temporary directory and a file system's
root are fenced only as a checkout (or the temporary directory as a marked
project the command runs in), so the person's own links
(`~/.cache -> /data/cache`) stay theirs; a home directory that is itself a git
checkout (a dotfiles repository), or lies in one, is fenced like any other, and
its links are not followed, as opm followed none before this amendment. A fence
lasts for the whole command and is never forgotten to make room, and a fence
added after a base was resolved through a link in it unmakes that base, which is
resolved again (and refused) when it is next used: the order in which a command
meets its project and its caches does not matter. So an environment base that
lies in a project (`XDG_CACHE_HOME=$PWD/.cache` in CI, with `.cache` a link the
checkout holds) is resolved no further than the project, the walk meets the
project's link below it and refuses it, and the store, the tool cache and the
configuration such an environment names are refused (an explicit
`OPM_STORE_HOME`) or not used (the default store), with nothing made where the
link points. `opmx pkg:…`, which takes no project, is covered by the fences of
the command it runs in. A refusal names the link and the checkout or fenced
directory that holds it, and says to name the store, the tool cache and the
configuration (`OPM_STORE_HOME`, `OPM_TOOL_CACHE`, `XDG_CACHE_HOME`,
`XDG_CONFIG_HOME`) at a path reached without it.

**A base leads to one place for the whole command.** Before a walk under a base
opens anything, the base's path must still lead to the directory it was resolved
to, and the walk must find that directory where the base's real path ends. A
base retargeted since (a `TMPDIR` link pointed elsewhere, a project root
replaced) is refused with `INPUT_CHANGED` before anything is made, and a write
checks it again before it publishes (`writeFileAtomic`, `writeStableFile`):
nothing is left in either place. Taking a base again that now resolves elsewhere
is `INPUT_CHANGED` too.

**A project root that is itself a link is accepted.** That is how `npm`, `pnpm`
and `git` behave. Started in a linked directory, each sees the real one
(`process.cwd()` and `getcwd(3)` report it); named one by path (`npm --prefix`,
`pnpm --dir`, `git -C`), each works through the link as any path does, and
`git rev-parse --show-toplevel` reports the real top level. opm does the same:
the root is a base, its last component included, so `opm init --path` with a
link to a checkout works on the checkout. A path a project's records name below
its root another way than it is opened now (installed through the link, opened
at its real path) is that path when the two roots are the same directory
(`respelled`). Everything inside the project, `.opm`, `node_modules` and any
directory an environment variable names there included, is below the base, so a
link there is refused: one a project commits (`packages -> ../outside`,
`.cache -> /elsewhere`) is never followed (ADR 0050), and neither is a root
named through a link inside the project a command runs in.

The shared store root keeps its own stricter rule: `ensurePrivateRoot`
(ADR 0048) still refuses an `OPM_STORE_HOME` that is itself a link, because its
owner and mode are what is judged and a link's own are meaningless. The way to
it is resolved as a base's is, so a store under a linked `HOME` or
`XDG_CACHE_HOME` is fine. The root is made first, as `mkdir -p` makes it (mode
0700 where missing), then opened relative to its parent's handle with
`O_NOFOLLOW`, so a link that appears there at any moment is refused; its owner
and mode are judged on that handle, and that handle, not a second resolution, is
what is taken. The tool cache and the configuration directory are judged the
same way (owned by this user, writable by nobody else), except that their last
component may be a link the way to them is allowed to hold, as `mkdir -p` always
followed one there.

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
`INIT_CWD` is the real directory too: it is `process.cwd()`), and opmx names
what it hands a tool there (`jailedPath`).

`opm pack` walks the project's real path, and compared what it found with the
excluded paths as written, so under a linked `TMPDIR` it packed its own previous
output. An excluded path inside the root (`out`, and `..dist`, a name that only
begins with two dots) is now also excluded under the root's real path.

### Writes and removals by path

Once a base is taken, code that used to fail at the walk reaches the operations
that act by path. Each that writes or removes in a project or a store now acts
through its directory's handle, the directory opened by the one walk from its
base (`stable-ops.ts`), so a component swapped for a link since an earlier step
is refused and nothing is written or removed where it points:

- the shared store: the removal of a half-linked project entry and of a
  half-made shared entry, the publishing rename, the tree linked into a project
  and the hard links broken again before a lifecycle script (`shared-store.ts`,
  `shared-store-tree.ts`), and the store root (`shared-store-root.ts`);
- the rollback copy (ADR 0056): every directory, file, link and hard link of the
  copy, the putting back of trees, files and links, the temporary names it
  sweeps and the copy's discard (`project-rollback.ts`, `rollback-restore.ts`,
  `rollback-files.ts`);
- the empty `.opm` a step lock removes, relative to the project root's handle
  (`step-lock.ts`), the owner file (`owner-file.ts`), the tool cache
  (`ephemeral.ts`, `ephemeral-layout.ts`) and the scratch directories a run is
  laid out in and its sweep (`run-scratch.ts`), and the auth configuration, read
  and written through the directory taken as the configuration root
  (`auth-config.ts`);
- the links an approved install script leaves, each made a hard link to the file
  of the package's own it leads to, followed link by link inside the package,
  linked under a private name it is proved to be, and renamed over the link
  (`frozen-builds.ts`);
- a patched entry's copy, made and published through the store root's handle,
  and the patch written back into it (`frozen-patch.ts`, and `commitPatchTree`
  in `adapter-npm`);
- `opm gc --shared` moving an entry or a record aside and putting a record back
  (`shared-store-gc.ts`).

A rename between two directories, a symbolic link and a hard link are relative
to the directories' handles too: through `/proc/self/fd/N` on Linux, `renameat`,
`symlinkat` and `linkat` on macOS (`moveChild`, `restoreLinkChild`, `linkChild`
in `project-io`), and a rename whose target names its directory by handle
(`RootDirectory`) on Windows. A hard link is made under a private temporary
name, proved to be the very file that was inspected, and only then given its
name: a source swapped for a link is linked as the link (never followed) and
refused, and nothing is left behind. The copies of a store file a project gets
and the rollback's copies are one function (`copyChild` in `stable-ops.ts`); a
copy a project may write is owner-writable (`(mode & 0o777) | 0o200`), as
before, so a lifecycle script that edits its own file can.

### What remains

- Windows has no handle-relative hard or symbolic link. A file is copied there
  instead of linked, and a symbolic link a rollback puts back and a record
  `opm gc --shared` puts back are the two things made by path. Windows has no
  sticky permission either, and its bases are resolved by path, one name at a
  time, with the same fences.
- macOS runs the same resolution through libSystem's `*at` calls and
  `F_GETPATH`. The suite runs those calls against glibc on Linux, with
  `/proc/self/fd/N` standing in for `F_GETPATH`; neither has been run on a Mac.
  Where the C library cannot be bound, every handle-relative operation is
  refused already, and a base is resolved by path.
- The store's leases (`store-lease.ts`, `store-lease-reader.ts`) are made and
  removed by name below the store root's real path as it was taken, not through
  a handle: their locks are opened by path with the platform's lock flags
  (`O_EXLOCK`, a Windows share mode) and probed again by path, which the handle
  helpers do not carry. They cannot be raced by another user: `.leases` lies in
  a store root `ensurePrivateRoot` found owned by this user and writable by
  nobody else, so only this user's processes can put a link at it or below it; a
  lease creates only new names (`O_CREAT | O_EXCL`, which refuses a link at the
  name) and removes only the names of its own and of leases it judged abandoned,
  each `<kind>.<mechanism>.<owner>.<uuid>.<lock|keys|pending>`, so a link put
  there by this user could make it remove nothing but files of those names.
- A base is judged as it is found: a link on the way to one, changed while it is
  being resolved, is the base it then leads to, within the rules above. The
  check that a base still leads where it did asks the system (`stat`), which
  follows links as it will; only the identity it answers is used.
- A checkout is found by its `.git`, and a tree a command runs in by where it
  lies. A tree with no `.git` and no marker at its root, whose root is the home
  directory itself (`HOME` at the root of an exported archive, the command run
  in one of its packages), is fenced from below the home directory only, so a
  link at that root (`$HOME/.cache`) is followed: the home directory's links are
  the person's unless it is a checkout. Code that uses the library without
  `beginCommand` is fenced by the projects it takes, when it takes them, and by
  the checkouts its bases lie in; what it wrote through another link before then
  is not undone.
- A link a person makes inside the tree a command runs in (below the topmost
  directory under the home or temporary directory, or under `/`), or inside a
  checkout, is not followed: CI that links `.cache -> /cache-volume` in its
  workspace names the volume itself in `OPM_STORE_HOME` and `OPM_TOOL_CACHE`
  (`docs/guides/opm.md`, "Where packages live on disk").

### What this guarantees

No component below a base is followed by a walk: a link there is refused with
`ENOTDIR` or `ELOOP` from the open (`UNSAFE_PATH` from the walkers that wrap
it), and nothing is made where it points. No base is resolved through a link in
a fenced directory or a checkout, however that directory is named, nor through a
link another user may have put in a directory others may write to. A component
of a base's real path swapped for a link after the base was resolved is refused
by the walk, and a base that leads somewhere else is refused with
`INPUT_CHANGED` before the walk makes anything and before a write publishes. A
root opm judges is the directory it opened, and is taken as that directory. On
Linux and macOS, every rename, link and removal opm makes in a project (`.opm`,
`node_modules`, an approved script's package) or a store (the shared store, a
project's own store, the tool cache) is relative to its directories' handles,
except the store's leases, made and removed by name for the reason above; on
Windows, the two things named above are made by path.

### Tests

Each failed before this change (on 9aeb116, or for the parts the review of
3bdddca found, on that commit, or for the parts the third review found, on
76ad596) and passes after it:

- `project-io/src/trusted-base.test.ts`: writes and walks under a `TMPDIR` that
  is a link, under `TMPDIR` laid out as on macOS (a `var` link to `private/var`
  in a temporary world), under `HOME` and `XDG_CACHE_HOME` links, in a project
  reached through a linked parent, in a project root that is a link, and a
  layout written there; the refusals of a link below a taken root, below a
  linked `TMPDIR`, swapped in after the root was taken, and on the way to a path
  under no base; an environment base inside a project that holds a link there,
  resolved after the project was taken, before it, below the link, and spelled
  through the project's real path; a root retargeted mid-command and a `TMPDIR`
  link retargeted mid-command, each refused before anything is made or written,
  and at publication; and `forgetBases`;
- `project-io/src/trusted-base.fences.test.ts`: a fence held through a bind
  mount of the project, kept past 600 other bases, and unmaking a base taken
  through its link before it came; the project a command runs in fenced before
  any base is resolved, found by its markers, with the checkout that holds it
  (its `.git` a directory or a gitfile) when the command runs in a monorepo's
  package, and never a home directory that is no checkout or a root; a link
  another user owns in a sticky directory not followed, through `/proc/self/fd`
  and through glibc's `*at` calls, the directory owner's included, and one the
  user owns followed; the glibc resolution equal to the procfs one; and moves,
  links and link restores between two open directories, through both backends,
  acting where the directories were opened, a source that is a link linked as
  itself;
- `opm-project/test/symlinked-base.test.ts`: `opm init` and `opm add` with a
  `node_modules` layout under a `TMPDIR` link, the macOS shape, a linked parent,
  a root that is a link, and a shared store under a linked `HOME` and
  `XDG_CACHE_HOME` and under a link an environment object names; a pack under a
  linked `TMPDIR` into `out` and `..dist`; a lifecycle script in the native jail
  under a linked `TMPDIR`; the refusal of a link at `.opm/store`; a default and
  an explicit store named inside a project through the link it holds (not used,
  and refused; nothing made outside); a store root that is refused, which is no
  base after; and a root retargeted mid-command (`INPUT_CHANGED` at the next
  walk and taking, nothing made at either target);
- `opm-project/test/symlinked-base.writes.test.ts`: a link swapped in where a
  half-linked store entry is removed, where a step discards its copy and where
  it puts the copy back, where an owner file is written, and where a tool cache
  and the auth config are made inside a project that holds a link there: each
  refused, and the directory it points at left as it was;
- `opm-project/test/symlinked-base.fences.test.ts`: `opm add` in a project whose
  cache is named through a bind mount of it; a store root a link appears at
  while it is made (refused, nothing in the victim's directory); a project root
  through a link another user put in a sticky directory; a store file a project
  copies, written by a non-root owner; the empty `.opm` a step made, removed
  where it was made after a directory above it was swapped; a retargeted
  `TMPDIR` refused before `writeStableFile` publishes or `ensureStableDirectory`
  makes anything; a store root taken before the project that holds its link; a
  tool cache others may write to; and a lease of a store whose root was
  retargeted;
- `project-io/src/trusted-base.checkouts.test.ts` (the third review): the
  superproject of a submodule and the main work tree of a nested worktree
  fenced, and those a gitfile leads back to when they are not ancestors; a cache
  named inside a checkout the command does not run in, with and without a
  command begun, and through the glibc `*at` calls; a home directory that is the
  checkout, lies in it, or whose `~/.cache` is the committed link, refused
  naming the checkout, and the person's links kept in one that is no checkout; a
  tree with no `.git` fenced from its topmost directory, with a nested checkout
  in it and when it is the temporary directory; `GIT_WORK_TREE` inside and
  outside, and `GIT_DIR` alone; a link nobody owns in a 0777 and a 0770
  directory refused as a base, a taken root and a judged root's last component;
  two commands running at once keeping each other's fences and bases; and a
  checkout through a bind mount of it;
- `opm/test/fenced-checkouts.test.ts`: `opmx pkg:…` and `opm add` in a
  submodule, a nested worktree and a tree with no `.git`, `opmx pkg:…` with the
  home directory the checkout or in it (the refusal naming the checkout), under
  `GIT_WORK_TREE`, and with the cache in a checkout elsewhere: nothing made
  where the link points; and a second command run while `opmx` waits on the
  registry, which drops none of its fences;
- `openpacker-cli/test/fenced-checkout.test.ts`:
  `openpacker materialize --install-prefix` below a link a project holds where
  `XDG_CACHE_HOME` points: refused, nothing extracted there;
- `opm-project/test/auth-config.read.test.ts`: the auth configuration not read
  through a checkout's link, from a directory others may write, or through a
  link in place of the file;
- `opm-project/test/symlinked-base.handles.test.ts` and
  `adapter-npm/src/pnpm-patch/tree-commit.test.ts`: a directory swapped for a
  link, or the store root retargeted, at the moment an install script's links
  are made hard links, a patched entry is published or written back,
  `opm gc --shared` moves an entry or a record aside, and a run's scratch is
  made: each acts where its directory was opened, or is refused, and the other
  tree is left as it was;
- `opm/test/fenced-project.test.ts`: `opmx pkg:…` and `opm auth set` in a
  checkout that holds a link where `XDG_CACHE_HOME` or `XDG_CONFIG_HOME` points,
  with no store or cache named elsewhere: refused, nothing made outside;
  `opmx pkg:…` and `opm add` run in a monorepo's package while the link is at
  the checkout's root (`.git` a directory, and a gitfile): refused, the default
  store not used, an explicit one through the link refused, nothing made
  outside; and two commands in one process, each taking its project where it is
  when it begins;
- `sandbox/src/trusted-base.test.ts`: a jail run in, and binding, a directory
  under a linked `TMPDIR` and under the macOS shape (with an authority opened
  through the link), and the user home known by its real path; and a grant
  through a link below the base, refused before and after;
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
linked `TMPDIR` they now name it by its real path, where the jail has it. A
rollback test that restores a project to the same place recovers in a later
command (`forgetBases`), as a recovery runs, and the step-lock test that holds a
recovery before it removes `node_modules` stops it at the look a removal through
a directory handle begins with, which is how it removes now.
