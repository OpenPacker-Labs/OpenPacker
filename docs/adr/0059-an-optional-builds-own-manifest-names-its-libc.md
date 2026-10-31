# ADR 0059: An optional build's own manifest names its C library

- Status: Accepted
- Date: 2026-10-31
- Amends [ADR 0055](0055-opm-ci-installs-a-pnpm-lock.md) §19 and the platform
  rule of [ADR 0051](0051-opm-ci-installs-workspace-locks.md) (which optional
  package a frozen install leaves out)
- Relates: [0046](0046-a-lockfile-is-installed-not-re-resolved.md) §9 (nothing
  an archive declares is executed; reading its manifest executes nothing)

## Context

`opm ci` installs what a lock says and leaves out an optional package whose
`os`, `cpu` or `libc` the lock records and the machine does not match. npm and
pnpm write those lists from the registry's metadata, and that metadata long
lacked `libc`. So a lock lists a musl build such as
`@anthropic-ai/claude-agent-sdk-linux-x64-musl` with `os: [linux]` and
`cpu: [x64]` and nothing more. Its own `package.json` says `libc: [musl]`.

On a glibc machine `opm ci` therefore extracted every musl build into the store
and linked it into `node_modules`, where it cannot run. Measured on the projects
it now installs (registry `unpackedSize`, linux/x64, glibc 2.39):

| Project                | musl builds that say so, taken | Unpacked |
| ---------------------- | ------------------------------ | -------- |
| OpenSesame (pnpm lock) | 6                              | 312 MiB  |
| ts-autocode (npm lock) | 3                              | 307 MiB  |
| gitlang (npm lock)     | 3                              | 263 MiB  |
| ceremony (npm lock)    | 5                              | 54 MiB   |

A build whose own `package.json` says nothing of its C library stays: neither
the lock nor the archive says it is for musl. `@libsql/linux-x64-musl`
(OpenSesame) and `@rivetkit/engine-cli-linux-x64-musl` (HoBo, 85 MiB) are such
builds; only their names say musl, and a name is not a declaration.

pnpm reads the platform from the lock alone and installs them too; npm reads the
lock's lists as well. Neither runs them: they are optional, and the binding that
loads one checks the C library first.

## Decision

1. **The format marks what the lock leaves unsaid.** An optional package whose
   lock entry restricts `os` or `cpu` and names no `libc` carries
   `platformFromArchive`. The lock it came from carries
   `archiveRuns(pkg, declared)`: whether that package runs on the machines the
   lock was read for, given what its archive declares. Both are in `FrozenLock`
   (`@openpacker/adapter-core`), so a format other than npm's can use them in
   its own vocabulary.
2. **The host reads those archives first, and extracts none that does not run
   here.** Before anything else is fetched, `opm ci` takes each marked package:
   the store's copy when the store has it, read without writing; otherwise the
   fetched bytes, proved against the lock's integrity, and read under the limits
   their extraction would have. What `archiveRuns` refuses is never extracted,
   so it takes no room in the store.
3. **The lock is then read again with what the archives declared**
   (`archivePlatforms`, keyed by the lock's integrity value). A list the lock
   has wins; only a list it lacks is taken from the archive. The package is then
   left out the way one whose lock entry names the platform is, with whatever
   only it needs, and the reason says which list came from its `package.json`:
   `optional, and for os "linux" cpu "x64" libc "musl" (libc "musl" from its package.json; the lock does not say), not "linux/x64/glibc"`.
4. **Only an optional package.** One the lock needs outright is installed as the
   lock says, whatever its archive declares. Leaving out what the lock marks
   optional is what §19 already does; this decides it with the package's own
   words where the lock has none.

## Consequences

- On these projects the musl builds above are neither in the store nor in
  `node_modules` after `opm ci` (tests: `frozen-install.targets.test.ts`,
  `frozen-install.pnpm.options.test.ts`, which also show that the store has no
  entry for the musl build).
- An install reads each marked archive twice (once for its manifest, once to
  extract it) when it is not yet in the store. The marked set is the native
  builds without `libc`: 19 packages in OpenSesame's lock, 15 in HoBo's.
- `opm ci --plan` reads no archive, so it still counts the musl builds among the
  packages it would install; the install reports them as left out.
- A machine for which the lock names `--libc musl` gets the musl build and
  leaves out the glibc one, by the same rule.
- _Amended 2026-10-31._ A build left out is never stored, so the next install
  fetched it again to read its lists, and `opm ci --offline` could never decide
  it: offline it was "not in the local store". Now, whenever an install reads a
  marked archive's lists, it records them against the integrity:
  `by-integrity/<key>.platform`, the declared `os`, `cpu` and `libc` as JSON,
  written whole and atomically. A later install, online or offline, decides a
  build that is not in the store from that record and fetches nothing (a build
  the record says runs here is fetched as before). A malformed record is a miss.
  `opm gc --shared` removes a platform record once it is older than the minimum
  age (by ctime), as it removes an entry nothing links, and a malformed one at
  once; the next install then fetches that archive once more.
- Offline, a marked package (optional by that mark) that no store holds and no
  record decides is left out with a warning on stderr (`skipped` kind `offline`;
  `opm ci` prints `opm: warning: left out …`), as npm leaves out an optional
  package it cannot get. A required package missing offline is still the
  `OFFLINE` error, naming only the required ones.
- `opm ci`'s fetched count includes an archive fetched only to find it does not
  run here, so the count and the megabytes agree.
- Tests: `frozen-install.platform-record.test.ts` (one fetch across an install,
  a second install and an offline one; the counts; an offline install with no
  record; a required package offline) and `shared-store-gc.platform.test.ts`.
