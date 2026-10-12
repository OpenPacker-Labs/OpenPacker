# 45. macOS child I/O uses libc `*at()` calls

Date: 2026-10-11

## Status

Accepted — amends [0034](0034-opm-projects-into-native-project-formats.md).
Amended 2026-10-12 for the sandbox and `opm pack` (see the amendment below).

## Context

ADR 0034 says POSIX maps an open directory through `/proc/self/fd` or `/dev/fd`,
so that `open(join(that, child))` is fd-relative. That holds on Linux, where
`/proc/self/fd/N` is a magic link to the directory itself. It does not hold on
macOS: `/dev/fd` is a file-descriptor filesystem whose entries are the
descriptors, not links, so `/dev/fd/N/child` does not resolve. The macOS leg of
CI build showed it on both Node versions:

```text
opm: ENOENT: no such file or directory, mkdir '/dev/fd/12/Users'
```

Every child operation on darwin failed, so `opm init` never worked there.

## Decision

Each platform reaches "a child of this open directory" by the call that actually
is one, and none re-walks a path:

| Platform | Child operation                                                          |
| -------- | ------------------------------------------------------------------------ |
| Linux    | `/proc/self/fd/N/child` through the ordinary fs calls (unchanged)        |
| macOS    | libc `openat`, `mkdirat`, `renameat`, `unlinkat`, `fstatat`, `fdopendir` |
| Windows  | `NtCreateFile` with `RootDirectory` through koffi (unchanged)            |

The macOS backend (`packages/project-io/src/handle-libc.ts`) binds libSystem
with koffi, the way Windows binds ntdll, and wraps the descriptor it gets in the
same FileHandle-shaped object. It keeps every guarantee of the other two:

- names are single segments (`assertHandleSegment`), checked before any call;
- a symlink as the final component is refused by `O_NOFOLLOW` or
  `AT_SYMLINK_NOFOLLOW`; recursive removal opens each directory `O_NOFOLLOW` and
  unlinks links instead of entering them;
- failures are Node-shaped errors (`code`, `errno`, `syscall`, a message like
  `ENOENT: no such file or directory, mkdir 'x'`) with names and text from
  `util.getSystemErrorMap()` and the numbers from `os.constants.errno`;
- descriptors are opened close-on-exec (Node's `fs.constants` omits `O_CLOEXEC`,
  libuv sets it) and a listing's own descriptor is closed with its `DIR`.

The library, symbol names, the three flag values Node does not export
(`AT_SYMLINK_NOFOLLOW`, `AT_REMOVEDIR`, `O_CLOEXEC`) and the byte layout of
`struct stat` and `struct dirent` are data in `handle-libc-profile.ts`, one
table per target. The first stat and the first listing compare libc's decoding
of `/` with Node's `fstat` and `readdir` and refuse to continue, naming the
field and dumping the raw bytes, if they differ. A backend that cannot load
koffi or libSystem throws `StableHandleError`; it never falls back to a path.

The backend is selected by platform only. A test-only function can force it on
Linux against glibc; it is not exported from the package, no environment
variable reaches it, and win32 ignores it.

## Consequences

The glibc build of the same backend is the Linux oracle: the whole `project-io`
suite and ten behavior transcripts run through it and through `/proc/self/fd`
and must agree. What no Linux host can show is checked by
`handle-darwin.test.ts` on the macOS leg of CI build, and by the first-use
layout check in the shipped code: the Darwin struct layouts, the `$INODE64`
symbols on `x86_64`, the values of `AT_SYMLINK_NOFOLLOW`, `AT_REMOVEDIR` and
`O_CLOEXEC`, errno numbering, and `/dev/fd/N/child` itself.

Handles returned by the macOS and Windows backends expose `fd`, `close`, `stat`,
`sync`, `chmod`, `read`, `write` and `writeFile`, not the whole Node FileHandle,
and a test that patches `FileHandle.prototype` does not see them.

The paragraph that stood here named three places still joining children onto
`/dev/fd/N` (the sandbox's grants, the mock backend, `opm pack` output
collection) and a snapshot that needs `O_TMPFILE`. The amendment below resolves
each.

## Amendment (2026-10-12): the sandbox and `opm pack`

### What was found

Every `/proc/self/fd` or `/dev/fd` path built in TypeScript outside
`packages/project-io`, and what each needed:

| Where                                             | What it did                                                        | Decision                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `sandbox/src/paths.ts` `openStableJailPath`       | Joined each path component onto `/proc/self/fd/N` or `/dev/fd/N`   | Handle-relative through project-io's `openStablePath` (libc `openat` on macOS)      |
| `pack-provider/src/packer.ts` `collectArtifacts`  | `opendir`, `lstat`, `realpath`, `open` of `/proc/self/fd/N/<name>` | Handle-relative through project-io, in `collect.ts`                                 |
| `sandbox/src/backends/mock.ts` argv[0]            | Handed the child `/dev/fd/N` where it was not Linux                | Refused off Linux before it is reached; Linux keeps `/proc/self/fd/N`               |
| `sandbox/src/backends/native.ts` reopen           | `open('/proc/self/fd/N')` for an independent offset                | Already Linux-only; now refused off Linux with the platform named, not "invalid fd" |
| `pack-provider/src/executable.ts` snapshot        | `open(stableHandlePath(writer))` on an `O_TMPFILE` writer          | Already Linux-only by refusal; the refusal now says so before the file is opened    |
| `opm-project/src/paths.ts` wrappers, `install.ts` | Re-export of the path form; a comment                              | No join; unchanged                                                                  |

`linkChild` inside project-io still joins `posixChild(parent, name)` for
`link(2)`; see "Not covered" below.

### The sandbox

A directory grant is bound by the descriptor that was checked, so a swapped
ancestor cannot redirect it. Getting that descriptor is a walk from `/`, opening
each ancestor relative to the one before with `O_NOFOLLOW`. That is the call
project-io already has for "a child of this open directory" on every platform,
so `openStableJailPath` now delegates to `openStablePath`
(`project-io/src/stable-path.ts`), which creates nothing and refuses a link
anywhere in the path. Linux runs the same system calls as before. On macOS it is
`openat`, and the guarantee holds: no step re-walks a path.

An approved executable snapshot has no safe macOS implementation. It is run from
the descriptor that was hashed; Linux gives that descriptor a path the kernel
executes (`/proc/self/fd/N`), macOS does not (`/dev/fd/N` is a descriptor
filesystem, as this ADR records), Node has no `fexecve`, and the alternatives
each reopen the gap the snapshot closes: a named copy is a path the same user
can swap between the check and the run, and Seatbelt and the MXC SDK name their
grants by path. So it fails closed, and early. `runInSandbox` refuses an
`executableAuthority` off Linux with `EXECUTABLE_AUTHORITY_UNSUPPORTED` before
it resolves a backend or opens a handle, and the mock backend and
`reopenExecutableAuthority` refuse it too. The message names the platform, the
missing piece and "Run this on a Linux host". `opm pack` and plugin operations
that need a snapshot report `UNSUPPORTED_PLATFORM` from
`openDelegatedExecutable`; `opm pack` adds the standard emitter that does run on
macOS (`opm pack <ecosystem> --package-version <version>` without `--provider`
or `--delegate`). Nothing was weakened to get there: no check was relaxed, and
there is no named-file fallback.

Package-exec containment itself stays withdrawn on macOS and Windows (ADR 0036,
amendment of 2026-08-19): no backend there can consume a directory handle. What
changes is how a run ends. With a handle-relative grant walk, a macOS run
reaches the documented refusal (exit 78 under `fail-closed`,
`TREE_CONTAINMENT_UNAVAILABLE` otherwise) instead of an `ENOENT`, and the
message now says containment is withdrawn on that platform, that a Linux host
has it, and that `opm exec <bin>` runs a tool the person has reviewed and
installed with their own authority and no jail (ADR 0047). `SANDBOX_UNAVAILABLE`
from a lifecycle script or `opmx` carries the same sentence.

Found while reproducing this: the jail home was made under the lexical
`$TMPDIR`. On macOS that is under `/var`, a link to `/private/var`, and a grant
may not contain a link, so every run was refused with "path must not contain
symbolic links" before it reached a bind. `defaultJailHomeRoot` now resolves the
temp directory. `jail-home.test.ts` reproduces it on Linux with `TMPDIR` pointed
at a link, and failed before the change with that message.

### `opm pack`

`collectArtifacts` read the output directory as `/proc/self/fd/N` and `join`ed
every artifact onto it. It now takes the `FileHandle` the host already retains
and uses project-io's operations on it: `readDirChildBounded` for the listing
(which stops at the first entry past the bound, so a directory of millions of
names is not held in memory, as before), `lstatChild`, and a no-follow
`openChild` for each artifact, read with `FileHandle.read` because the libc and
NT handle wrappers do not have `createReadStream`. Messages and error codes are
unchanged. The `realpath` comparisons are gone with the path. The directory is
still checked by identity (inode, change and modify time) after each collection,
and `assertNamedDirectory` now runs there too, which notices a directory renamed
away and not put back.

Linux output is unchanged: one fixed input (five artifacts, including a 3 MiB
one and unicode names, plus a directory and a symlink that must be skipped)
gives the same canonical outcome JSON before and after, sha256
`730d6ccf1472f0c52ec877e01218da4217d388bf63748e944fecf79572a471b6`, and the same
again with every child operation routed through glibc's `*at()` calls.

### Testing

The override that forces the libc backend on Linux stays out of project-io's
package entry (a test pins that). The sandbox and pack-provider suites reach it
by the file the entry re-exports it from, which is the same module instance, and
fail if the grants and the output directory did not in fact go through it:
`sandbox.libc-at.test.ts` replays the sandbox, escape and grant suites, and
`pack-provider.libc-at.test.ts` the packer and collection suites.
`stable-read.libc-at.test.ts` does the same for the two new project-io reads.
`handle-relative.test.ts` in both packages lists the production files that may
name a descriptor path, with the reason, and fails on any other.

What only macOS shows is in `sandbox.darwin.test.ts`, `pack.darwin.test.ts` and
two cases in `handle-darwin.test.ts`, run by the macOS legs of "CI build"
(`macos-latest / Node 22.19.0` and `/ Node 24`). They check the grant walk on a
real path under `/private/var`, a run under a supplied backend, the refusals
above by name, a pack end to end, and the bounded listing's early stop. None of
them has been run: this change was written and tested on Linux.

### Not covered

- `linkChild` (project-io, `link(2)`) still joins `/dev/fd/N/<name>` on macOS.
  adapter-npm's layout write calls `materialiseTree` with `{ link: true }`; a
  link that fails with `ENOENT` or `ENOTDIR` is not in the copy fallback, so the
  `layout` level may fail on macOS instead of copying. It needs libc `linkat` in
  the backend (or those codes in the fallback). Found by reading, not by a macOS
  run.
- Package-exec containment on macOS and Windows is still withdrawn.
- `O_TMPFILE` snapshots remain Linux-only.
