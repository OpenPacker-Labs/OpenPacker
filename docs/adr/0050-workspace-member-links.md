# ADR 0050: Workspace members are linked into node_modules, through the no-follow handle API and nowhere else

- Status: Accepted
- Date: 2026-10-12
- Amends
  [ADR 0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md)
  ("No symlinks"), [ADR 0045](0045-macos-child-io-uses-libc-at-calls.md) (the
  libc symbols) and [ADR 0034](0034-opm-projects-into-native-project-formats.md)
  (the Windows handle-relative creation)
- Relates: [ADR 0042](0042-upm-v1-gaps.md) (no workspace graph),
  [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) (`opm ci` refused
  the lock entries this makes room for;
  [ADR 0051](0051-opm-ci-installs-workspace-locks.md) installs them, and checks
  every `link: true` entry of a lock against the lock's own member list before
  it reaches this layer)

## Context

A workspace repository lists its own packages in the root `package.json` and
expects each to resolve the others' live source from `node_modules`: editing
`packages/a/src` is seen by `packages/b` without an install. A lock records this
as a `link: true` entry whose key is `node_modules/<member name>` and whose
`resolved` is the member's directory. ADR 0048 gave `node_modules` no symlinks,
so that a path inside it is never an alias for a path outside it, and `opm ci`
refuses such a lock for that reason (ADR 0046).

**The decision, made by the user on 2026-10-12:** symlinks (junctions on
Windows) are allowed for workspace-member links only. They are created through
the no-follow handle API and refused everywhere else. Reading and removing a
link still never follows it.

This record says what "only" means, in code, on each platform.

## Decision

### What a member link is

A link has a **directory**, a **name** and a **target**, and each has a rule
that runs before any call reaches the operating system (`link-rules.ts`,
`memberLinkProblem`):

| Part      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory | A `node_modules`, or a scope directory in one, at the project root or inside the `node_modules` of a package the layout installs. Never `.bin`, never a package's own files, never the project root.                                                                                                                                                                                                                                                                                                                                                                            |
| Name      | One package directory name (no slash, no leading dot, not `node_modules` in any case, `[A-Za-z0-9._~+-]`). A scoped package is its scope directory and its name, never a name with a slash in it.                                                                                                                                                                                                                                                                                                                                                                               |
| Target    | The link's text, relative to its directory, in normal form (so comparing two is comparing two strings), at most 1024 characters, no NUL, line break or backslash. Its text resolves strictly inside the project root, and not into `node_modules` or `.opm`, compared the way a volume would (without regard to case, and without the trailing dots, spaces and `:stream` suffixes Windows drops), on every platform; on Windows a segment that looks like an 8.3 short name is refused too, since it can name anything. What it leads to on disk is checked separately, below. |

The last rule is also why a member's own dependencies resolve: Node looks for a
package's dependencies from the link's real path, which is under the project
root, so the project's `node_modules` is on the way up. A target that left the
project, named the root, or named a registry package would make a path in
`node_modules` an alias for something this layout did not put there.

### Where a link's target leads

The target rule is a rule about text. `../packages/pkg` stays inside the project
root as a string whatever `packages` is on disk, so if `packages` is itself a
symlink (a committed `packages -> ../outside` is enough) the link would resolve
outside the project. The rule alone does not stop that, so before a link is
made, and before one that already exists is called `unchanged`, the **nearest
existing prefix of its target is walked** from the project root with the same
no-follow, one-handle-at-a-time opens the link's own directory is reached with
(`link-prefix.ts`):

- a component that is a symbolic link, or on Windows a reparse point, refuses
  the request (`UNSAFE_PATH`, naming the component). That includes the last
  component: a member that is itself a link is not a member directory;
- a target that does not exist yet stays allowed, so only what exists is judged.
  The walk stops at the first component that is missing, and at the first that
  is not a directory, since nothing deeper can be resolved through it;
- the project root is taken as `realpath` says, once, so a project reached
  through a symlinked home directory or `/var` on macOS is not refused for its
  own location.

**What this guarantees and what it does not.** It is a check at the moment of
the call, and the call is repeated at every layout write, because an identical
existing link goes through the check too. So no link opm creates or finds
unchanged has a link among the existing components of its target at that moment,
and a component swapped for a link since is found, and refused with its name, by
the next layout write. It does not close the window in between. A link is a name
the operating system resolves each time somebody uses it (Node, a bundler, an
editor); a component swapped after the check is followed by whoever resolves the
link next, and nothing done once at creation can prevent that. The actor needs
write access to the project tree, which already lets them replace a member's
source; opm itself is not affected, since it never writes through a link and
never reads through one (the walkers take a recorded link as a leaf, and removal
unlinks). It is also a check of the filesystem and not of any lock: a later step
that feeds `link: true` lock entries in must treat a lock's `resolved` as
untrusted input and not take this walk for an authorisation of it.

Ancestors of the project root are not part of it (the project's own location is
canonicalised once, not judged). On Windows any reparse point on the way is
refused, not only junctions and symbolic links, as it is for the link's own
directory.

`symlinkChild` also takes the place of its directory (`site`) from its caller.
It applies the rules and walks the target against that statement, but does not
prove the handle is the directory `site.directory` names: a handle names the
directory it opened even if the pathname has since been swapped, and the
`swapped` conformance scenario pins that. `placeMemberLink` builds its `site`
from its own no-follow walk, so for it the statement is true by construction; a
direct caller of `symlinkChild` vouches for it.

Nothing else in `node_modules` is a symlink: not a registry package, not a bin
(`.bin` entries stay script shims), not a nested copy. `materialiseTree` refuses
a source tree that holds one, whether or not any record names it.

### Creating one

`symlinkChild(directory, name, target, site)` in `@openpacker/project-io`, with
`readlinkChild` and `unlinkChild`, act on an open directory like every other
child operation, never on a re-walked path. `placeMemberLink` and its siblings
take a project-relative path and walk down from the real project root one
directory handle at a time with `O_NOFOLLOW`; a link or a non-directory on the
way is `UNSAFE_PATH` and nothing is made in the directory it points at.

An existing entry is replaced only if it is already a link to exactly this
target, and then nothing happens (`unchanged`). A link to another target, a file
and a directory are each a `LINK_CONFLICT` that names the path and what is
there. Two callers creating the same link both succeed; if they disagree about
the target, one is told.

| Platform | Create                                                                                                                 | Read                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Linux    | `symlink(target, /proc/self/fd/N/name)`: the directory is the magic link, the final component is created, not followed | `readlink` on the same path                                     |
| macOS    | libc `symlinkat(target, dirfd, name)` through koffi                                                                    | libc `readlinkat(dirfd, name, buf, size)`                       |
| Windows  | a directory junction: `NtCreateFile` with `RootDirectory`, `FSCTL_SET_REPARSE_POINT`, one rename                       | `FSCTL_GET_REPARSE_POINT` on a handle opened as the link itself |

The libc symbols and their first-use check are recorded in ADR 0045.

### Removing one

`unlinkChild(directory, name, expected?)` takes a link away and refuses
(`NOT_A_LINK`) anything else; given `expected` (the text the layout's record
says was written) it also refuses a link that says something else
(`LINK_CONFLICT`). `removeMemberLink` walks to the link once, and `unlinkChild`
makes the comparison where it removes, so the text is not compared in one walk
and removed in another. `removeEmptyScope` is a single `rmdir` (`rmdirChild`):
nothing is listed first.

What that guarantees depends on the platform, and it is not "cannot delete a
file or a directory" in general:

| Platform     | What decides                                                                                                                                                                                                                 | The window                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows      | The name is opened as itself with `DELETE`, its reparse data is read from that handle, and the object that handle holds is the one deleted (`NtJunctions.unlink`).                                                           | None for the name: nothing the name becomes can be deleted. A plain directory or file, and a reparse point that is not a mount point or a symbolic link, is `NOT_A_LINK`.                                                                          |
| Linux, macOS | The text is read (`readlink`, which is also the proof it is a link, and the comparison with `expected`), then `unlink` (`unlinkat` with no flags) is called. The system refuses a directory (`EISDIR`, or `EPERM` on macOS). | Between the read and the `unlink`, somebody with write access to the directory can put a regular file or a different link at the name, and it is removed. A directory in its place is refused and kept, with what is in it. Nothing can undo that. |

The actor in that window needs write access to `node_modules`, and what is lost
is something they put at that exact name an instant before; they could have
removed it themselves. `removeEmptyScope` has no window of its own for a file
arriving in the scope: `rmdir` answers `ENOTEMPTY` at the moment it acts, and
the directory and what arrived stay. (On Windows a scope that is swapped for a
file or a junction between the walk and the removal is removed as what it has
become, which is the same class of window.)

### Windows, and the window that remains

A symbolic link needs a privilege (`SeCreateSymbolicLinkPrivilege`, or Developer
Mode) that a person installing packages does not have. A junction
(`IO_REPARSE_TAG_MOUNT_POINT`) needs none, and a workspace member is a
directory, which is the one thing a junction can name. So Windows links are
junctions, and only junctions. Two consequences are accepted:

- A junction holds an **absolute** target (`\??\C:\project\packages\a`). The
  link's relative text is resolved against the project root when it is made and
  turned back into relative text when it is read, so the plan, the record and
  every test see the same string on every platform. A project moved on disk has
  to write its layout again, which a relative link on Linux or macOS does not
  need.
- A target that is a file cannot be linked on Windows.

A reparse point is made by sending `FSCTL_SET_REPARSE_POINT` to a handle of an
**empty directory that already exists**, so a fully atomic "create a link at
this name" does not exist. What is done instead keeps every step handle-relative
and keeps the final name from ever being a half-made link:

1. an empty directory is created under a staging name
   (`.<name>.opm-link-<uuid>`) with `NtCreateFile`, `FILE_CREATE`,
   `RootDirectory` = the parent handle;
2. the reparse data is sent through the handle that created it, so the reparse
   data lands on the directory this call created, whatever happens to names
   meanwhile;
3. the handle is closed and the directory is renamed **by its staging name** to
   the final name with `ReplaceIfExists` **off**: a taken name is `EEXIST`, and
   a name is either absent or a complete junction. If anything fails, the
   staging directory is removed.

**The window that remains** is the staging name itself. Between steps 1 and 3 an
entry named `.<name>.opm-link-<uuid>` is visible in the directory, first as an
empty directory and then as a junction. It is never the name anything resolves,
it is a dot name no layout lists, and a process that dies in the interval leaves
it behind; the next layout write does not touch it. Its content is the same
junction the final name would hold. The rename in step 3 is by name, after the
handle of step 2 is closed, so the guarantee of step 2 is about the reparse data
and not about the rename: a process of the same user that replaced the staging
name in that interval would have _its_ object published under the final name.
That is an object it made in a directory it can write to, and the first junction
made in a process is read back (below) before anything relies on it; the rename
could be made through the open handle instead, and has not been, because that
cannot be tried here. No step re-walks a path, no step follows a reparse point,
and the absolute path inside the junction is derived from the project root the
caller names, not read back from the handle (`GetFinalPathNameByHandle` stays
unused, as ADR 0034 says).

`placeMemberLink` and its siblings also refuse, by what it is, any directory
component on the way down that is a reparse point (`FSCTL_GET_REPARSE_POINT`
after each `NtCreateFile`), because Windows opens a junction as itself and not
as what it points at; they do not rely on what NT would then do inside it.

### How a name is recognised as a link

Everything that decides whether a name is a link asks one function: the member
link reader, the tree walkers, the comparison of a tree before and after it is
read, and the check of what is in the way of a new link all go through
`lstatChild`. On Linux and macOS that is `lstat` (`fstatat` with
`AT_SYMLINK_NOFOLLOW`). On Windows it cannot be the stat of the open handle:
libuv's `fstat` never reports a symbolic link, so a junction answers "directory"
and a file symlink "regular file". `lstatChild` there opens the name as itself
and asks that same handle for its reparse data (`FSCTL_GET_REPARSE_POINT`,
`handle-nt-lstat.ts`):

- a mount point (a junction) or a symbolic link is a link, and neither a
  directory nor a file;
- any other reparse tag (a OneDrive placeholder, a deduplicated file) is a thing
  this package neither makes nor follows, and is neither link, file nor
  directory, which is how a directory listing types it (`handle-nt-dir.ts`);
- no reparse data is the plain file or directory the stat said;
- a handle that cannot say fails the call, and is not taken for one that is not
  a link.

What is verified, and what is not: the reading of the reparse data is tested on
every platform against stand-ins for the handle and the bytes
(`handle-nt-lstat.test.ts`). That NTFS answers as the stand-ins do, and that a
recorded junction is walked as a leaf and removed as itself, is
`handle-windows-link.read.test.ts`, which only the Windows leg of CI can run.
Until that leg has run, nothing here is evidence about NTFS.

The first junction made in a process is read back through
`FSCTL_GET_REPARSE_POINT` and must be a mount point to the very path that was
sent; if not, it is removed and the error names the call and the raw names.

Removing a link, and a recursive removal that meets one, delete the link as the
link it is. A directory that is a reparse point is not listed on the way
(`FSCTL_GET_REPARSE_POINT`), so nothing it points at can be reached by a
removal. A volume without reparse points (FAT, exFAT) has none to refuse and is
listed as before.

### The plan, the writer and the record

`LayoutPlan` gains `links: { path, target }[]`. `path` is the project-relative
place in the lock's own spelling (`node_modules/@scope/name`); `target` is the
relative text. The planner refuses, naming every problem:

- a link in a `node_modules` the plan does not own, or outside one;
- two links at one place, and a link inside another link;
- a link at a place the plan installs a package;
- a package whose place is under a link.

`writeNodeModules` takes the links as an option, builds the plan itself (it does
not accept a plan from a caller), writes the packages, shims and stale removal,
and then the links, through `placeMemberLink` and nothing else. It then checks
that no package it placed is a symlink nobody declared.

The links go in two halves with the record between them: the recorded links that
are no longer wanted are removed, the record is written with the links the
layout wants, and only then are those made. So a link that was made is a link
that was recorded, whichever later link is refused (a name that holds a
directory) or whenever the process stops, and the next layout removes it. A
recorded link that was never made is nothing to remove (`absent`), or, if the
name now holds something else, is left and listed under `skipped`.

`node_modules/.opm-layout.json` gains `links: { path, target }[]`, omitted when
there are none, so a layout without links is recorded byte for byte as before.
`layoutVersion` stays 1: an older opm reads the record without the field and
leaves a link it did not know it wrote. What the record lists is all opm
removes:

- a link no longer wanted, or wanted with another target, is removed only while
  it is exactly the link the record says was written, as "Removing one" above
  states it; a link someone repointed, or replaced by a file or a directory, is
  left and listed under `skipped`;
- a name that held a package opm wrote may become a link, and a link may become
  a package, in which case the package replaces it without following it;
- an entry of a hand-edited record that is not a valid member link is ignored,
  never turned into a path;
- a re-run with identical links changes nothing at the top level of
  `node_modules` (same inode). A link inside a package's own `node_modules` is
  written again with the package, because the package directory is.

`opm ci` removes the whole `node_modules` before writing, which unlinks every
link and follows none.

### The reading side

A walker of a tree that refuses every link must be able to read a `node_modules`
that holds member links. `collectTree` and `collectTreeFromHandle` take the
record's links (`memberLinks`): a link the record names, at that path, with that
very text, is a **leaf**. It is read with `lstat` and `readlink`, its path and
text are returned, and the directory it points at is never opened, listed,
hashed or counted against a read limit. The snapshot taken after the walk
compares the link again, and a link swapped or repointed while the tree was
walked is `UNSAFE_PATH`. Any other link, and a recorded path whose link now says
something else, is refused exactly as it was before this decision.
`collectFiles`, `collectFilesFromHandle` and `materialiseTree` still refuse
every link.

Nothing else in the repository walks a project's `node_modules`: `opm gc` and
`opm gc --shared` read store entries (a symlink in one is refused, ADR 0048),
and `pack` leaves `node_modules` out. That was checked by searching every
non-test source file under `packages` and `apps` for `node_modules`; the one
place that removes the whole directory is `opm ci`'s `removeTree`.

## Consequences

- A member's source is the one `node_modules` serves, so an edit is seen with no
  install. Hard links to the store are unchanged for everything else.
- The exception is as small as the code can make it: three parts with a rule
  each, one creating module, one writing module, one record field. A change that
  makes any rule wider changes `link-rules.ts` and its tests, which pin each
  refusal.
- macOS and Windows run the same link suites as Linux (`handle-link*.test.ts`,
  including the prefix and removal files, and `member-link*.test.ts`, with the
  conformance scenarios `links`, `linkRefusals` and `linkRaces` on macOS), plus
  a file for what only libSystem (`handle-darwin.test.ts`) or NTFS
  (`handle-windows-link.test.ts` and `handle-windows-link.read.test.ts`, which
  asserts how a junction is recognised, removed and walked, with the call and
  the raw value in every failure message) can show. **Neither has run on those
  systems at the time of writing**: the Linux legs run the same code through
  `/proc/self/fd` and through libc bound to glibc, and the Windows control flow
  runs against in-memory stand-ins for the NT calls and for an open handle
  (`handle-nt-link.test.ts`, `handle-nt-lstat.test.ts`,
  `handle-nt-dir.test.ts`). The `ci-build.yml` macOS and Windows legs are the
  first evidence, and until they have run, every statement above about NTFS or
  libSystem is a statement about the code, not about the system.
- When this was written `opm ci` still refused a lock with `link: true` entries:
  this record covers creating, recording, reading and removing the links, and
  the layout plan and writer that carry them. Reading members out of a lock and
  installing a workspace is [ADR 0051](0051-opm-ci-installs-workspace-locks.md).
- Sharing a project directory with Windows tools that cannot read junctions
  (older archivers) can copy the target's contents or fail; that is the
  platform's, and the link is still a junction.

## Amendment (2026-10-31): a member's own links

For a pnpm lock, a member's `link:` dependencies are also linked in the member's
own `node_modules` (`packages/web/node_modules/lib -> ../../lib`), where pnpm
puts them; code relies on the path (HoBo's `packages/runtime` imports
`../node_modules/@hobo/wit/src/generated/…`). They are links to members, as
before, so there is still one copy of each member. The link grammar
(`project-io` `linkDirectoryProblem`) accepts plain directory names (no dot, no
`node_modules`) before the first `node_modules`; nothing else changes. The
project's own links stay, and are the ones `opm ci` counts as linked at the
project.
