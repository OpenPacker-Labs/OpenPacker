# ADR 0036: Install and package execution run under a declared sandbox policy

- Status: Accepted
- Date: 2026-08-11
- Relates: [ADR 0030](0030-build-versus-buy-for-primitives.md),
  [ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md),
  [ADR 0033](0033-native-supply-chain-capture-and-mitigation.md)

## Context

OpenPacker already materializes packages into a project-local content-addressed
store and refuses dependency lifecycle scripts by default. That closes the
common “malicious postinstall on install” path only by **never running** the
code. It does not:

- give a safe path when a project must allow scripts (native addons),
- isolate `opmx` / ephemeral tool runs from the ambient host,
- contain host installers (`apt`, `winget`, `chocolatey`, `nix`) after elevation
  consent.

Aube’s model (deny scripts by default; approved builds in a narrow jail with FS
write limits, network deny, scrubbed env, and a temporary home) and Microsoft’s
MXC (cross-platform policy-driven containment with multiple backends) describe
the missing boundary. ADR 0030 says buy standard primitives unless there is a
stated reason not to; containment is a standard OS concern with a published
TypeScript SDK (`@microsoft/mxc-sdk`).

MXC is early preview. Microsoft documents that current profiles should not be
treated as a finished security boundary. OpenPacker must therefore compose
deny-by-default scripts **and** a jail, and must record which backend enforced
policy rather than claim “MXC-secure” as a product fact.

## Decision

1. **Execution that is not pure metadata runs under a declared sandbox policy.**
   The policy is project-config (`opm.toml` `[sandbox]`) and PREX `PolicyInput`
   fields, bound into receipts via `policyDigest`.
2. **Default mode is fail-closed.** If the requested jail cannot be enforced,
   refuse rather than silently unsandbox. `degrade-warn` and `off` may relax
   isolation policy, but never waive hard process-tree termination: package
   execution still refuses when no OS-owned tree is available.
3. **Backend ladder:** prefer MXC when available and able to enforce the
   profile; else Bubblewrap's PID namespace on Linux; else refuse. Seatbelt
   alone does not own a killable process tree, and Windows requires MXC's job
   containment.
4. **Single enforcement funnel** — `@openpacker/sandbox` `runInSandbox`.
   Lifecycle scripts, `opmx`/ephemeral runs, and `InstallerProvider.install` all
   go through it. No second ad-hoc spawn for package execution.
5. **Approval ≠ ambient trust.** `allowLifecycleScripts` / allowlists only mean
   scripts may run **inside** the jail (optionally with per-package grants for
   network, write paths, env). They do not inherit credentials or home by
   default.
6. **Host installers stay capability-honest (ADR 0031).** Plans expose argv and
   the sandbox profile. `degrade-warn`, `off`, and ambient system install are
   refused; a host installer must run fail-closed in an OS-owned process tree.
7. **Adopt MXC as preferred primitive (ADR 0030 outcome 1);** OpenPacker owns
   policy semantics and PREX honesty. Native backends are first-class fallbacks,
   not afterthoughts.

## Consequences

- Pure extract-only installs still never run scripts; they evaluate sandbox
  policy and record that scripts did not execute.
- Scripted installs use a quarantine tree, run scripts in the jail, then
  atomically publish into `.opm/store`.
- Offline `npm run verify` must not require MXC or Bubblewrap: unit tests use a
  mock backend; fail-closed is tested without host tools.
- Semantic loss / evidence codes for sandbox outcomes are first-class:
  `SANDBOX_ENFORCED`, `SANDBOX_BACKEND_MXC`, `SANDBOX_BACKEND_NATIVE`,
  `SANDBOX_UNAVAILABLE`, `SANDBOX_DEGRADED`,
  `SYSTEM_INSTALL_CONTAINMENT_LIMITED`, `SYSTEM_INSTALL_NOT_SANDBOXED`.
  (`SYSTEM_INSTALL_SANDBOXED` is deprecated and must not be emitted for new host
  installs.)

## Notes

Inspiration:
[aube jailed builds](https://aube.jdx.dev/package-manager/jailed-builds.html),
[Microsoft MXC](https://github.com/microsoft/mxc). Neither is vendored
wholesale; PREX remains the authority on identity, receipts, and what was
verified.

## Amendment (2026-08-11) — post-audit hardening

Live probes showed fat `--ro-bind / /` left the home tree readable and `opmx`
mounted the project read-write. Profiles now distinguish:

| Profile        | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `package-exec` | Minimal RO toolchain + explicit trees; project RO by default |
| `host-install` | User-capability limited containment only                     |
| `ambient`      | Intentionally unsandboxed                                    |

`enforced` is true only for successful `package-exec` jails. Host installers
emit `SYSTEM_INSTALL_CONTAINMENT_LIMITED`. Bin shims re-enter via `opmx` (or
refuse ambient without `OPENPACKER_ALLOW_AMBIENT_SHIMS=1`).

**Defense-in-depth, not a microVM or finished OS security product.**

## Amendment (2026-08-19) — macOS/Windows containment withdrawal

The backend ladder in decision 3 assumed MXC could enforce the package-exec
profile wherever Bubblewrap is absent. Once every run began synthesizing stable
directory-handle authorities for its binds (no-follow, swap-resistant
containment), that stopped being true: the MXC SDK configures containment by
path strings only and cannot consume inherited directory handles, so the MXC
backend now fails closed with `UNAVAILABLE` on every real run. Package-exec
containment on macOS and Windows is therefore **withdrawn**: `fail-closed`
policies refuse with exit 78, and `degrade-warn`/`off` refuse with
`TREE_CONTAINMENT_UNAVAILABLE` because ambient execution is not a security
boundary and is never a fallback. The withdrawal lifts when the SDK exposes
handle-relative binds; the `ambient` profile row above describes intent, not an
executable mode.

## Amendment (2026-10-17) — one handle per store, and a node_modules for a tool

`opmx pkg:npm/cowsay hi` was refused with "At most 16 valid handles may be
inherited":

- Since the amendment of 2026-08-19 every bind is an inherited no-follow
  directory handle. `runInSandbox` opens one for each read-only path, each
  writable path and the working directory, and bwrap binds it with
  `--ro-bind-fd`.
- The spawner refuses more than 16 inherited handles (`MAX_INHERITED_HANDLES`,
  `packages/sandbox/src/handles.ts`). The bound is the spawner's own: bwrap has
  no such limit, and MXC takes no handles at all.
- `opmx` passed every package of a tool's closure as a path of its own. cowsay's
  closure is 33 packages, so it needed 33 handles for the store alone. Any tool
  with more than about a dozen packages was refused, and so was `opmx <bin>` in
  a project with as many.

Past that, an npm tool that requires a dependency failed with "Cannot find
module 'yargs'". The tool cache holds each package as its own store tree, and
nothing put them where Node looks.

Decision:

1. **Store entries are bound one handle each while the run's handles allow, and
   through one view of their store past that** (`store-view.ts`).
   - `inheritedHandleCount` (`@openpacker/sandbox`) says how many handles the
     rest of a run takes: the project, the working directory, the jail's home,
     the policy's grants for the package. `runInSandbox` opens its handles from
     the same computation, so the count is the number it passes. The store
     entries get what is left of the 16.
   - While they fit, each entry is bound alone, as before views: a store the
     user cannot write to (installed by root in an image, or on a read-only file
     system) runs whatever fits. Past that, the fewest stores are bound through
     a view, the one with the most entries first. What no views make fit, and a
     view that cannot be made in its store, are refused with a message that
     names the bound.
   - A view is a directory of hard links to exactly the entries the run needs,
     made inside the store as the `tree` of `.view-<uuid>` (a run's scratch
     directory, decision 3) and bound read-only at the store's own path. It is
     opened once, before anything is linked into it, and bound from that handle;
     once its entries are linked its path must still name that directory and the
     directory must hold exactly them, or it is refused.
   - The links are made by the layout's own tree copy (`materialiseTree`, ADR
     0048): each file linked is the inode opened through no-follow handles, and
     an entry or a name in it that is a symbolic link, or that was swapped
     meanwhile, is refused, as a bind of the entry on its own refuses it.
   - Inside the sandbox the store holds the same entries at the same paths as
     when each was bound alone, and nothing else: no other package of the store,
     and not the view itself. This holds when the working directory is outside
     the store. A working directory that contains the store (the cache root, a
     project root) is bound read-only over it and shows the whole store, view
     included, as it always has.
2. **An npm tool run by `opmx` runs from a `node_modules` of its closure**
   (`ephemeral-layout.ts`).
   - The closure is solved from the release the run takes
     (`ephemeral-closure.ts`): the tool's root is held to that version in the
     walk (a range in the ecosystem's own spelling that admits it alone) and in
     the solve (`vers:<type>/<version>`). Solved from the name alone, the solver
     chose the newest release, and a pinned older tool
     (`opmx pkg:npm/cowsay@1.5.0`) got the dependency versions the newest wants.
   - The layout is written by the same writer as a project's (ADR 0048), with
     hard links to the store's files, as the `tree` of
     `<tool cache>/.opm/runs/run-<uuid>`.
   - The layout is told which package each one requires, as the solve chose (ADR
     0054), so two versions of one name stay apart. cowsay's closure holds four
     names twice; told nothing, the layout kept one of each, and cowsay got
     `string-width` 4 where it asked for 2. A peer edge is given like any other;
     a peer name the closure would need at two versions is refused by the solve.
   - The directory an npm tarball wraps its files in is dropped by one rule for
     the writer and for a bin's path into the tree (`tarballWrapper`).
   - That one tree is what the sandbox binds, and its `node_modules/.bin` is put
     first on the tool's PATH, as npx does, so a tool can run its dependencies'
     executables by name.
   - A layout is never reused between runs, which would make it one more thing a
     run trusts without checking it again.
   - Python, .NET and native tools run as before; their closure is bound through
     views when it does not fit.
3. **A run removes both when it ends** (`run-scratch.ts`).
   - `opmx` holds SIGINT, SIGTERM and SIGHUP while a tool runs: the first ends
     the sandboxed process tree, the run removes its view and its layout, and
     the same signal is raised again, so `opmx` ends by it. A second signal,
     whichever it is, while they are still being removed does not wait: it is
     raised at once and `opmx` ends by it, leaving what was not yet removed to
     the next run in the same place.
   - A run killed outright (SIGKILL, a crash, the power) leaves them. So each is
     a directory `<prefix><uuid>` that holds `.owner`, written as soon as the
     directory is made, and the `tree` the run uses, which is all a sandbox
     binds: a tool does not see who made it. `.owner` is the owner record of ADR
     0056 (`owner-file.ts`): a pid, the time it started, the host name, the PID
     namespace, and digests of the boot id and the machine id.
   - The next run that makes one in the same place, and `opm gc` for the views
     of a project's store, removes those whose owner has ended, by the one rule
     every holder opm records is judged by (`process-owner.ts`, ADR 0056): an
     owner of this machine (machine id and host name) in an earlier boot,
     whatever its pid; or of this place (host name, machine id, boot and PID
     namespace equal, a field neither side can read counting as equal), with its
     pid unused, a zombie, or used by a process that started at another time,
     another user's process included. Anything else (another host name, machine
     id, boot or PID namespace, or a field one side reads and the other cannot)
     is another host or a container sharing the store, taken to be running and
     left alone.
   - A directory with no `.owner` a minute after it was made was left by a run
     cut short between the two, and is removed; an `.owner` opm cannot read (cut
     short, a newer version, a link) is judged by nobody and left alone.
   - Whatever removes one (the sweep, `opm gc`, the run itself) removes it
     through directory handles, as store paths are removed (`removeStableTree`):
     each directory is opened without following a link and emptied through that
     descriptor, so a directory swapped for a link while it is removed is
     refused, never entered. Node's recursive `rm` looks at a directory and then
     lists it by its path, and enters a link put there in between. Under
     `sandbox.project_write = true` a run whose entries fit without a view binds
     the project's store read-write, and a tool there could plant a `.view-*`
     whose owner reads as ended and race the next sweep into removing files
     outside the sandbox. On Linux `removeStableTree` gave that same `rm` the
     path `/proc/self/fd/N/<name>`, which pins the parent and nothing below it;
     project-io's `removeChild` now walks there as the libc backend does on
     macOS (ADR 0045). `run-scratch-removal.test.ts` swaps a directory for a
     link as it is listed, during a sweep and during each removal a run makes;
     with `rm` the file behind the link was removed.
   - A Linux host with no readable machine id (`/etc/machine-id` and
     `/var/lib/dbus/machine-id` both absent: minimal container images) removes
     what a run of its own boot left once that run's pid has ended: the machine
     id is needed only to tell an earlier boot. After a reboot such a host
     cannot place the earlier boot's leftovers (the boot ids differ, and nothing
     says the machine is the same), and keeps them. Before this rule
     (`run-owner.ts`, its own) such a host removed no leftover at all; measured
     then with both files masked in a mount namespace, a leftover of a dead pid
     was removed with the machine id readable and kept with it masked.
   - macOS and Windows read no machine id, boot id, PID namespace or start time
     (`owner-system.ts` reads them from Linux files only). Unread on both sides
     they agree, so there a leftover is judged by host name and pid alone,
     whichever boot made it: it is removed once its pid is unused, an earlier
     boot's included, and kept while any process holds that pid, one that reused
     it included. Containment is withdrawn on both (amendment of 2026-08-19), so
     a view or layout exists there only until its run is refused.
   - `opm gc` does not count a view as a store path (`isStoreView`).
   - While a view exists, each entry it shows has files with a second name, so
     the shared store's `opm gc --shared` counts that entry as in use, and keeps
     it. A view left behind by a run killed outright, where it is not removed
     (above), keeps its entries in the shared store until it is removed by hand.
4. **As root, the sandboxed process holds no capabilities** (`native.ts`). bwrap
   run by root gives the process root's capabilities unless told to drop them,
   and CAP_SYS_ADMIN remounts any read-only bind read-write. The bwrap backend
   passes `--cap-drop ALL` when its effective uid is 0; for any other user bwrap
   gives none. This predates views and held for every bind.
   - Root's other capabilities go with it, CAP_DAC_OVERRIDE and
     CAP_DAC_READ_SEARCH among them. The sandboxed process is uid 0 and no more:
     it is held to a file's mode like any user, as its owner for files uid 0
     owns and as "other" for the rest. Measured with bwrap run by root, over a
     0600 file and a 0755 directory, both owned by uid 1000: before, the file
     was read and a name made in the directory (`CapEff 000001fffeffffff`); with
     `--cap-drop ALL` both give `Permission denied` (`CapEff 0`).
   - What that means for `opmx` run as root: a project, a tool cache or a store
     that belongs to another user and whose modes refuse "other" (0600 files,
     0700 directories) is no longer readable or writable inside the sandbox, as
     it would not be for that user's neighbour. Files uid 0 owns, and files any
     user can read, are unaffected, which is every file of a root-owned cache.
     Run `opmx` as the user the files belong to, or make them readable, for the
     rest. No test of the suites reached this.

Consequences:

- Confinement is unchanged: read-only binds, the same paths, and only the
  closure visible. No store file's bytes are copied, unless the file system
  refuses a hard link, where the file is copied.
- A run that does not fit pays a link per file of what it binds through a view:
  the closure for a Python, .NET or native tool, the packages of the project for
  `opmx <bin>` in a project. An npm tool pays it once, for its layout. Before
  this, such a run was refused.
- `opmx pkg:npm/cowsay hi` runs against registry.npmjs.org (with the release-age
  capture of #182). Its layout of 33 packages, 419 files, took 0.2 to 1.0 s, and
  a view of the same entries 0.4 to 3.1 s, on a 4-core machine at a load average
  of 23 to 38. Most of the 23 to 29 s a run took was resolving the closure from
  the registry.

Limits:

- Entries spread one per store over more stores than there are handles left are
  refused: more than fourteen single-entry stores beside a working directory and
  a jail home, more than thirteen beside a project too. A view of a store saves
  a handle only when it holds two or more of the run's entries. A tool's
  closure, and a project's packages, are in one store, so opm's own runs do not
  meet this.
- What a run killed outright leaves on another machine or in another PID
  namespace is never removed from here, by a run or by `opm gc`: whether its
  owner still runs cannot be told. A later run on that machine, or in that
  namespace, removes it. On a Linux host with no machine id, what an earlier
  boot left is never removed by a run.
- Off Linux the place is the host name alone: two machines with one host name
  sharing a store are taken for one, and a run on one removes what a live run on
  the other left once that pid is unused on its own side.
- Two machines with the same machine id and host name are taken for one, as
  machine-id(5) requires the id to be unique: a clone that kept its original's
  id, sharing a store with it, would have a live run's leftovers taken for an
  earlier boot's.
- Measured and exercised on Linux, where bwrap is the backend.
  `tool-many-deps.test.ts`, `store-view-budget.test.ts`,
  `store-view-confinement.test.ts`, `store-view-swap.test.ts`,
  `store-view-gc.test.ts`, `store-view-handles.test.ts`,
  `store-view-dispose.test.ts`, `run-scratch.test.ts`,
  `run-scratch-removal.test.ts`, `tool-pinned-version.test.ts`,
  `fetch-tool-closure.test.ts`, `tool-layout-versions.test.ts` and
  `tool-peer.test.ts` (opm-project), `opmx-signals.test.ts`,
  `opmx-run-signals.test.ts` and `opmx-bin-path.test.ts` (apps/opm), and
  `root-capabilities.test.ts`, `handles.test.ts` and `handles-oracle.test.ts`
  (sandbox) cover it. The sandboxed ones are skipped where bwrap is absent. The
  automatic CI lane does not run these suites; the manual one (`ci.yml`) runs
  them on GitHub's `ubuntu-latest` with no step that installs bubblewrap, and
  whether that image has it was not checked. The root-only ones (capabilities, a
  sweep in another PID namespace) are skipped for any other user.

## Amendment (2026-10-24) — an installed npm bin runs from a node_modules too

`opmx http-server -- --version`, in a project where
`opm add pkg:npm/http-server` had installed 51 packages, failed with "Cannot
find module 'chalk'". Decision 2 of the amendment of 2026-10-17 gave a
`node_modules` to a tool straight from a registry only. An installed bin ran
from its package's store tree, with every store entry of the project bound, and
nothing around it where Node looks.

Decision: an npm bin a project installed runs from a layout of its package's
closure, written by the same code as a tool's (`layOutTool`), as the `tree` of
`.opm/runs/run-<uuid>` in the project, beside its store, and removed when the
run ends, by a signal included, as decision 3 says. That tree is what the
sandbox binds besides the project, and its `node_modules/.bin` is first on PATH
(`installed-closure.ts`, `runLaidOut` in `opmx-spawn.ts`).

- The closure is the lock's: from the bin's own entry, each entry's
  `dependencies`, and its `aliases` under the name it requires them by (ADR
  0054), transitively. Each package is the active generation's store tree, which
  `activateGeneration` checked against its digest just before.
- The lock describes what is installed only when every entry of the closure
  records its edges and is installed with the lock's digest. An offline lock
  records none, and `opm rollback` activates an older generation and leaves the
  newer lock; then every npm package installed is laid out by name alone, as a
  tool whose closure could not be solved is (`ToolPackage.requires` absent). A
  lock that cannot be read gives no edges either; it does not stop the run.
- Python, .NET and native bins, and a file in `.opm/bin` no package owns, run as
  before, the project's store entries bound alone or through a view.

`opmx-installed-deps.test.ts` (apps/opm) runs an installed bin that requires
`helper@^1` in a project that also holds `helper@2.0.0` and gets version 1;
`installed-closure.test.ts` (opm-project) pins the closure and the by-name
cases; `opmx-run-signals.test.ts` stops an installed declared bin by SIGHUP and
finds its layout removed.

## Amendment (2026-10-24) — a tool's output reaches the terminal as it is written

`opmx http-server` printed nothing while it served. The backends collected a
process's output (`BoundedOutput`) and returned it in the outcome, and `opmx`
wrote the outcome's `stdout` and `stderr` once the process had ended: a server
says that it listens and then runs until it is stopped, and was seen saying it
only after.

Decision:

- `runInSandbox` takes an `output` sink (`OutputSink`: `stdout(chunk)`,
  `stderr(chunk)`), passed by `runSandboxedPackageProcess` to every backend,
  bwrap, MXC and the mock alike. Each chunk is handed to it as it is read, and
  none is kept: the outcome's `stdout` and `stderr` then hold only what the
  sandbox itself says, an output limit reached or a run stopped. A caller with
  no sink (an install's lifecycle scripts) keeps the output as before.
- The policy's byte limits are unchanged and still count every byte: what passes
  `maximumStdoutBytes`, `maximumStderrBytes` or `maximumOutputBytes` is not
  handed on, and the process tree is ended, exit 125, as when the output is
  kept.
- MXC is not run a second time after a run that has handed output on: what a
  person has been shown cannot be taken back.
- `opmx` hands a tool's output to its own stdout and stderr as text, each stream
  through its own UTF-8 decoder (`passedOn` in `opmx-spawn.ts`), so a character
  split between two chunks is written whole; the outcome held text decoded the
  same way before.

Limits: output is handed on as the sandbox reads it, so how often it arrives is
the tool's (a tool that buffers its own output when it is not writing to a
terminal still does). The policy's `timeout_ms` (ten minutes unless a project
sets it, and always for `opmx pkg:...`, which has no project) and the byte
limits above still end a tool that runs or writes past them, a server included.

`output-sink.test.ts` (sandbox) shows a process's first lines handed on while it
runs, by the mock backend and by bwrap, and the limits ending a tree whose
output is handed on; `opmx-stream.test.ts` (apps/opm) shows the same through
`opmx`'s spawn, and a split character written whole.

## Amendment (2026-10-24) — a tool someone runs: how long, how much, which network, what it leaves, and what stopped it

`opmx` runs a tool a person started, as `npx` does: a server, a watcher, a REPL.
Since the amendment above its output reaches the terminal as it is written, and
two limits made for what runs unattended still ended it:

- The policy's `timeout_ms`, ten minutes unless the project set one, and always
  ten minutes for `opmx pkg:...`, which has no project. MXC set ten minutes of
  its own when it was given none.
- The byte limits, 1 MiB a stream and 2 MiB in all, which bound the output the
  sandbox keeps in memory. Handed on as it is written, the output is not kept,
  and a server was ended by its own log.

Decision:

1. **A tool `opmx` runs has no wall-clock limit unless one is asked for.** The
   limit is, in this order: `opmx --timeout <ms>` for the run; else
   `[sandbox] opmx_timeout_ms` in `opm.toml`; else a `[sandbox] timeout_ms` the
   project sets, so that a project that bounds its sandboxed runs (in CI, say)
   keeps that bound for `opmx` too; else none (`opmxRunTimeout`). Only the
   default of `timeout_ms`, ten minutes, which is for what runs unattended (an
   install's lifecycle scripts), no longer applies to `opmx`. All take whole
   milliseconds, 0 for none, up to 2^31 - 1, what a timer can wait
   (`parseRunTimeout`); anything else is refused, a key by `INVALID_MANIFEST`.
   The library leaves the choice to its caller: `runSandboxedPackageProcess`
   requires the limit it applies (`timeoutMs`) and reads none from the project
   on its own. `opmx pkg:...` reads no project, so only `--timeout` applies to
   it. MXC is given no limit of its own (its SDK sets none when it is omitted);
   the sandbox's own signal carries the policy's.
2. **Output handed to a sink has no byte limit** (`BoundedOutput`): nothing of
   it is kept. Output kept in the outcome, which is what a caller with no sink
   gets (lifecycle scripts, host installers), keeps the limits, and the process
   tree is still ended past them, exit 125.

What a run is still bounded by: the person who started it (Ctrl-C, SIGTERM,
SIGHUP, as the amendment of 2026-10-17 says), and the limit they ask for.

`opmx-long-run.test.ts` (apps/opm) runs, through bwrap, an installed tool that
writes 3 MiB to stdout and 1.5 MiB to stderr, and finds all of it written and
exit 0; and a tool that never ends, ended by `opmx_timeout_ms = 500`, by
`timeout_ms = 400` where the project sets no `opmx_timeout_ms`, and by
`--timeout 400` over the project's. `opmx-timeout.test.ts` (opm-project) pins
the order, that the library applies the limit its caller gives and refuses a run
given none, and the key's round trip and refusals; `output-sink.test.ts`
(sandbox) hands 4.5 MiB to a sink through the mock backend and bwrap, and still
cuts kept output at its limit.

### Which network

`opmx http-server` printed its address, and `curl` to it got no answer. A run
without network is given bwrap's `--unshare-net`: a network namespace of its
own, with a loopback interface and nothing else. The tool reaches nothing
outside, which is the point, and nothing outside reaches it, a server included.
`opmx` could not be told to share the host's network for a run; a project could
grant it to a package (`[sandbox.packages."<purl>"] network = true`), and
neither was documented for `opmx`, nor was what happens without it.

Decision:

1. **Network is granted, never assumed, and fails closed.** A tool `opmx` runs
   has no network unless the run is granted it. `opmx --allow-network`, the
   spelling `opm pack` uses for the same grant, shares the host's network with
   that run; a project grants it to a package for every run with
   `[sandbox.packages."<purl>"] network = true`, as it does for that package's
   lifecycle scripts (decision 5). Either one leaves out `--unshare-net`, and
   the masks over network tools (`networkToolMaskFiles`) with it. Nothing else
   grants it: not a tool's own request, not the absence of a policy.
2. **A tool that listens without network is told so** (`listen-watch.ts`). While
   a run has no network, the bwrap backend reads, every 200 ms, the TCP sockets
   of the run's namespace in `/proc/<pid>/net/tcp` and `tcp6`, from the first
   process bwrap started there; only a namespace other than the caller's is
   read, so a run that shares the host's is never reported. The first port in
   the LISTEN state is handed to the caller (`onIsolatedListen`), once, and
   `opmx` writes one line to stderr: the port, that nothing outside the sandbox
   can reach it, and, if it was meant to be reached from this host, that
   `--allow-network` shares this host's network, which also gives the tool
   outbound network and the host's loopback services: the hint names the grant
   and what it costs, rather than urging it. Run by a user who is not root,
   bwrap makes the run's namespaces inside a user namespace of its own; the
   processes there still answer to that user, and `/proc/<pid>/net/tcp` of the
   first of them is readable by the process that started bwrap (measured with a
   child of uid 65534 on Linux 6.18; `/proc/<pid>/root/proc/net/tcp`, the other
   way in, is not needed). Where it cannot be read (a `/proc` mounted with
   `hidepid`, a kernel without `/proc/<pid>/task/<pid>/children`, MXC, the mock
   backend) nothing is said; `opmx --help` and the opm guide say the same in
   words.

`opmx-network.test.ts` (apps/opm) runs an installed server through bwrap: with
no grant a request to its port is refused and `opmx` says so, once, with the
port; with `--allow-network`, and with the project's grant to its package, the
request is answered and nothing is said. `listen-watch.test.ts` (sandbox) has a
process listen in a run without network and is told its port, and finds nothing
told of a process listening in the caller's own namespace;
`listen-watch.user.test.ts` does the first as uid 65534, through `runInSandbox`
and an unprivileged bwrap, where the test runs as root.

### What a run killed outright leaves

Every run gives its process a home of its own (`$HOME`, with `$TMPDIR` in it)
under `$TMPDIR/openpacker-sandbox` and removes it when the run ends, a signal
included. A run killed outright (SIGKILL, a crash, a second signal while `opmx`
removes what it made) left it there, with whatever the tool wrote, and nothing
ever removed it: seven of them were in this machine's `/tmp` from one day's test
runs.

Decision (`jail-home.ts`):

1. **A home names its owner, out of the tool's sight.** A run's directory is
   `home-<uuid>`, holding `.owner`, the record every holder opm keeps (ADR
   0056's `writeOwnerFile`, written before anything else), and `home`, the one
   thing the sandbox binds. The owner rule (`process-owner.ts`, `owner-file.ts`
   and the system reads behind them) moved from opm-project to
   `@openpacker/project-io`, which the sandbox and opm-project both build on;
   opm-project re-exports it as before, and the judgement a run's scratch made
   of its directories is the same function for both (`abandonedByOwner`).
2. **Every run first removes the homes whose owner has ended, by that rule**
   (`sweepJailHomes`): an owner of this place whose pid is gone, a zombie, or
   now another process, or one of an earlier boot of this machine. A home whose
   owner may still be running, runs on another host, machine, boot or PID
   namespace, or whose `.owner` cannot be read, is never touched.
3. **A home with no `.owner` is removed only once it has not changed for a
   week** (`UNOWNED_JAIL_HOME_MS`). An opm from before this made the home the
   run's directory itself and recorded no owner, so nothing says whether its run
   is over; a tool such a run keeps up (a server) writes there, and a week is
   longer than it is likely to go without. A run cut short between making its
   directory and writing `.owner` is judged the same way. An old opm's run that
   lasts longer than a week without writing to its home directly would lose it.
4. **A home is removed by renaming it to a tombstone first**
   (`.home-<uuid>.sweep-<uuid>`) and removing that, as the shared store
   unpublishes an entry it collects (`shared-store-gc.ts`). Of two runs that
   judge one home at once, one renames it and the other finds it gone; a run's
   own home has a live owner from before it is used, so no sweep takes it; a
   tombstone a run was killed before removing is removed by the next run. The
   jail root is listed, and its homes renamed and removed, through a handle of
   it opened without following a link (`openStablePath`, `renameChild`,
   `removeChild`), and a home's `.owner` is read without following one.

`jail-home-sweep.test.ts` (sandbox) leaves homes in a jail root and runs through
`runInSandbox`: a home whose owner is a pid that has ended is removed; one whose
owner is alive, on another host, or unreadable is kept beside it; a home with no
owner is kept while young and removed once older than the bound; a tombstone is
removed; six runs at once, beside a seventh that holds its home throughout, each
use their own home and remove the one that ended; two sweeps of the same dead
homes remove each once. Through bwrap, a run's `.owner` names this process and
the tool cannot read it.

### What stopped it

`opmx http-server` stopped by Ctrl-C said "openpacker sandbox: process aborted
or timed out". The sandbox ended the process tree on an abort of the signal it
was given, and the policy's timeout aborted the same signal, so it could not
tell the two apart, nor say which signal it was.

Decision: what ended a run is the reason of the AbortSignal that ended it
(`RunStop`, `stop.ts`). `opmx` aborts with the signal it holds
(`stoppedBySignal`, `opmx-signals.ts`), the sandbox aborts its own signal with
the timeout (`stoppedByTimeout`), and the backends (bwrap, MXC and the mock) say
which on a line of their own: `process stopped by SIGINT`,
`process timed out after 600000 ms`, or `process aborted` for any other reason.
The exit status is 124 for all three, as before; `opmx` then ends by the signal
itself, so a shell sees 130 for SIGINT.

`stop.test.ts` (sandbox) ends a run by each of the three signals, by the
timeout, and by a bare abort, through the mock backend and bwrap, and an MXC run
by a signal; `opmx-run-signals.test.ts` (apps/opm) finds the signal named when
`opmx` is sent SIGHUP, SIGINT and SIGTERM.
