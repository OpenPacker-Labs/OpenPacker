# 46. A lockfile is installed, not re-resolved

Date: 2026-10-11

## Status

Accepted.

Relates to: [0033](0033-native-supply-chain-capture-and-mitigation.md),
[0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md),
[0044](0044-a-closure-is-what-the-host-installs.md).

Amended by [0051](0051-opm-ci-installs-workspace-locks.md) (2026-10-12): the
refusal of workspace members and links in §8 is replaced; a workspace lock is
installed.

## Context

A repository with a committed `package-lock.json` and no workspaces could not be
installed by `opm`. Taking that apart found three separate reasons.

1. `opm` only knew how to resolve. `opm add` solves a closure from the registry
   and writes its own lock; nothing read a `package-lock.json` someone else
   wrote, and a lock holds one version per package name, where npm's holds
   several, each at the path that makes Node resolve it.
2. `lock-import` refused every real npm lock, for three reasons that were its
   own. The project's own entry (key `""`) was imported as if the lock had
   selected it. A package placed at several paths (`name@version` under
   `node_modules/a/node_modules/c` and `node_modules/b/node_modules/c`) became
   "duplicate or missing exact PURLs", although that is how npm writes a
   lockfile whenever two dependents share a version. And `lockfileVersion: 2`,
   which npm 7 and 8 write, was not recognised. A lock of 1,039 entries, 101
   names in more than one version, 49 repeated placements, was refused whole.
3. Nothing could say which entries a machine installs. The lock lists every
   optional platform package (167 of the 1,039) and every dev dependency (899),
   and npm leaves out what does not apply by rules that live in how it reads
   `dev`, `optional` and `os`/`cpu`/`libc` together with the dependency graph.

Installing it for real then found two more, each only visible against real
packages: a package published with the same file under two spellings of one path
(`package/./dist/index.js` beside `package/dist/index.js`), which the
materializer refused as traversal and then as a duplicate; and archives larger
than the materializer's defaults (64 MiB expanded, 10,000 files) suit a small
tool but not a dependency tree, where a native build alone is 287 MB unpacked.

## Decision

1. **`opm ci` installs a lock and resolves nothing.**
   `opm ci [--path <dir>] [--production] [--omit <dev|optional|peer>] [--offline|--online]`,
   and `opm install --frozen` as the same command, read `package.json` and
   `package-lock.json` (lockfileVersion 2 or 3) and produce a `node_modules` in
   which every path in the lock holds exactly that package at that version.
   Nothing the lock does not name is installed, and `node_modules` is replaced
   whole, as `npm ci` does, so the result is the lock and not the lock plus what
   was there.

2. **The ecosystem's adapter reads its own lock.**
   `ProjectFormat.readFrozenLock` answers what a host installs, what it leaves
   out and why, and what the lock holds that cannot be installed. The host
   (`opm-project`) does what is generic: policy, fetching, proof, the store, the
   write. Core never names npm. One reader of `package-lock.json`
   (`lock-tree.ts`) serves both this and `lock-import`, so the root entry, a
   package at several paths, a link and a workspace member are classified once.

3. **The rules for "does this machine install it" are npm's, and are shared.**
   - `--omit` drops an entry reachable only through the omitted kind of edge:
     `dev`, `optional`, `peer`; `devOptional` only when both of those are.
   - An `optional` entry whose `os`, `cpu` or `libc` does not match is left out,
     and so is whatever only it needs (arborist's `optionalSet`, computed on the
     dependency graph the lock describes, each dependency resolved from where
     its dependent lives). The same mismatch on an entry that is _not_ optional
     is an error, as npm's EBADPLATFORM.
   - An entry shipped inside its parent's archive (`inBundle`) is not fetched.
   - The `os`/`cpu`/`libc` lists become a `TargetPredicate` once
     (`npmTargetPredicate`) and are evaluated by the one evaluator the closure
     walk uses (`evaluateTargetPredicate`, now in `adapter-core`), so a package
     the walk would leave out is one a frozen install leaves out. A list that is
     exactly `["any"]` constrains nothing, as in npm; it was read as the value
     "any".

4. **The lock is the authority.** `package.json` and the lock must agree, as
   `npm ci` requires: a dependency added or dropped since the lock was written
   is named, and a changed spec that the locked version still satisfies is
   accepted. Policy facts come from the lock and from nothing fetched: its
   `resolved` URL classifies the source (an archive at the registry's
   `/<name>/-/<name>-<version>.tgz` is `registry`, any other https archive is
   `tarball`, `git+` and `file:` are named as such), the dependency graph says
   direct or transitive, `deprecated` becomes a lifecycle fact. The minimum
   release age is the one gate that does not apply to a version a person already
   pinned; a blocked source kind, a withdrawn release and everything else the
   project's policy says still deny, and one error names every package refused
   before any is fetched. `engines` and `os`/`cpu` are advice and an
   already-evaluated predicate, not losses. `package-lock.json` has no yanked or
   quarantined flag; the fact is carried (`withdrawn`) for a format that does,
   and denies unless the project allows that kind of release.

5. **Bytes are proved before they are used, and come from where the lock says.**
   Each archive is checked against the lock's integrity under Subresource
   Integrity's rule (the strongest algorithm present decides; any token of it
   may match; sha512, sha384, sha256 or sha1). A mismatch fails closed and
   leaves the previous `node_modules` alone. The shared store is found by that
   digest (`by-integrity/<algorithm>-<hex>` records the entry's sha256, only
   after verification) and the entry it names is adopted the usual way, so a
   stale index costs a download and cannot cost a wrong package. What is not in
   the store is fetched through the bounded, destination-classifying transport
   with an allowlist that is exactly the origins of the `resolved` URLs being
   installed: no environment variable adds one and a redirect elsewhere is
   refused. Only an origin the operator named (`OPM_REGISTRY_<ECOSYSTEM>`) may
   resolve to a private address.

6. **The layout is the lock's.** `planLayoutFromPaths` places each package at
   the chain its key gives; it chooses nothing and refuses what cannot be
   written as written (an unsafe name, two packages claiming one place, a
   package inside a parent that is not installed, and, since ADR 0054 §17, two
   names that differ only by case in one directory). Those rules look at the
   lock's keys alone, so they are asked when the lock is read (step 1 of the
   host's order): a lock they refuse is refused before any archive is fetched
   and before the project's `node_modules` is removed, which stays as it was.
   What can only be found while writing (a link or a file on the way, the
   filesystem refusing) is found after the old `node_modules` has been removed,
   as with `npm ci`. Executables are the `.bin` shims of ADR 0048; no symlink is
   made. A tarball's single top-level directory is stripped whatever it is
   called, as npm does, and a bare `bin` string is named by the package's own
   `name`, not by the alias it lives under.

7. **The materializer takes an ecosystem's own tolerance only when asked.** An
   archive whose paths carry a `.` segment, or that lists the same file twice
   with the same bytes and mode, is accepted when the limits say
   `acceptRedundantEntries`, which the npm adapter requests. By default both are
   still refused and the exploit corpus still rejects them; differing content at
   one path, `..` and an empty segment are refused either way. A frozen install
   also extracts under larger bounds than the defaults (1 GiB expanded, 100,000
   files, 256 MiB compressed, a compression ratio of 128) and holds the memory
   extraction needs in one shared budget, so several large archives are not
   unpacked at once.

8. **What cannot be honoured is refused, by name, whole.** An entry with no
   `resolved` or no `integrity`, a git or path source: each is listed, up to
   twenty a screen, and nothing is installed. Workspace members and links were
   on this list until [ADR 0051](0051-opm-ci-installs-workspace-locks.md), which
   installs them; what it still refuses is a link or a key that is not a
   workspace member's. A lock opm cannot install is not partly installed.

9. **Nothing is executed.** `allow_lifecycle_scripts = false` stays the default.
   The packages that declare an install script are counted in the summary line
   and listed; a package that needs its script to run (a native build with no
   prebuilt fallback) is installed as it is and says so.

## Consequences

Measured on 2026-10-11, linux-x64 (glibc), Node 22.22.0, a 4-CPU VM that other
work was using at the same time (load average 4 to 7), against
registry.npmjs.org through the sandbox's proxy, with an application's lock of
1,039 entries.

| Measured                                 | Result                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the lock                                 | 1,039 entries: 899 `dev`, 174 `optional`, 167 with `os` or `cpu`, 18 with an install script                                                                            |
| `opm ci`                                 | 894 packages installed, 145 optional packages for other platforms left out                                                                                             |
| against npm's reader of the same lock    | 0 differences in (path, name, version) in either direction. The oracle is `@npmcli/arborist` `loadVirtual` (npm 10.9.4) with its own `checkPlatform` and `optionalSet` |
| `--production`                           | 117 packages (899 omitted by `--omit`, 23 for other platforms); 0 differences against the same oracle                                                                  |
| integrity                                | 845 distinct archives, all verified; changing one character of one digest exits 7 and changes nothing                                                                  |
| the installed tree runs                  | `tsc`, `vitest`, the platform `esbuild` binary, `@swc/core`, `sharp` and `onnxruntime-node` load or run                                                                |
| two small tool locks (2 and 29 packages) | 0 differences against the oracle; `esbuild`, `workerd` and `miniflare` run                                                                                             |
| a workspace lock (4 members)             | exit 3, 8 entries named (4 links, 4 members), nothing written (as measured then; ADR 0051 installs it)                                                                 |
| cold: empty store, 354 MB fetched        | 113.5 s: 90.9 s fetching and extracting, 22.3 s writing the layout                                                                                                     |
| warm: store populated, a new project     | 55.0 s: 18.9 s adopting the 845 entries, 35.6 s writing the layout                                                                                                     |
| a second project from the same lock      | adds 21,376 KB to 1,337,948 KB (1.60%): its 5,164 directories and nothing else (`du` over all paths in one invocation)                                                 |

The unit and integration tests need no network: a stand-in registry serves
archives built in the tests.

Costs and limits, stated so nobody finds them by surprise.

- **It is not fast.** A warm install of 894 packages takes about a minute on
  this machine, most of it in handle-relative I/O: every file is opened, listed
  and stat-ed several times by the verification ADR 0048 asks for (adoption
  re-hashes the entry; the layout checks the source and staged trees against a
  snapshot three times). This is CPU in the kernel (sys time is half of it) and
  a loaded machine makes it worse. One cheap change is in this slice (a snapshot
  looks at a file with one `lstat`, not an open, a stat and a close: the layout
  step went from 38 s to 29 s). Fewer verification passes, or synchronous I/O
  under the same handle checks, is the next step and is not taken here.
- **Git and path dependencies are refused.** (Workspaces and their links are
  installed as of [ADR 0051](0051-opm-ci-installs-workspace-locks.md).) pnpm
  locks are not read. `opm.lock.json` installs (`opm install`) are unchanged and
  still evaluate policy on the facts the older lock persists.
- **Hard links, not copies.** Editing a file under `node_modules` in place fails
  (ADR 0048). With `OPM_STORE_HOME=off`, or a store on another device, archives
  are extracted beside `node_modules`, linked in, and the extraction removed, so
  the files stay editable and there is still one copy.
- **`libc` on a host with no libc to report is satisfied**, as the closure walk
  already treats it. npm refuses a package that declares `libc` and no `os` on
  such a host. In the four locks measured every entry that declares `libc` also
  declares `os: ["linux"]`, so nothing is installed differently.
- **A hard dependency that does not run here is refused even if `--omit` would
  drop it.** npm checks every non-optional entry before it omits any, and fails;
  this checks only what it will install, and installs.
- **Archive bounds are fixed.** An archive that would expand past 1 GiB or hold
  more than 100,000 files is refused, naming the package.
- **Authenticated registries are not configured here.** A registry that needs a
  token is reached only if `opm auth` already names one for its origin.
