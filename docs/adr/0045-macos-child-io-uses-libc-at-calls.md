# 45. macOS child I/O uses libc `*at()` calls

Date: 2026-10-11

## Status

Accepted — amends [0034](0034-opm-projects-into-native-project-formats.md).

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

Still Linux-shaped, outside `opm init`, `import`, `add` and `sync`:
`packages/sandbox` grants (`paths.ts`), the mock backend (`backends/mock.ts`)
and `opm pack` output collection (`pack-provider/src/packer.ts`) join children
onto `/dev/fd/N`, and `pack-provider/src/executable.ts` snapshots with
`O_TMPFILE`. None has been exercised on macOS and each wants the same treatment.
