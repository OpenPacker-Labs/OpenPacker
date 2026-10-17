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
- The spawner refuses more than 16 inherited handles
  (`packages/sandbox/src/backends/mock.ts`). The bound is the spawner's own:
  bwrap has no such limit, and MXC takes no handles at all.
- `opmx` passed every package of a tool's closure as a path of its own. cowsay's
  closure is 33 packages, so it needed 33 handles for the store alone. Any tool
  with more than about a dozen packages was refused, and so was `opmx <bin>` in
  a project with as many.

Past that, an npm tool that requires a dependency failed with "Cannot find
module 'yargs'". The tool cache holds each package as its own store tree, and
nothing put them where Node looks.

Decision:

1. **Past eight store entries, those a run needs from one store are bound
   through one view** (`store-view.ts`).
   - The view is a directory of hard links to exactly those entries, made inside
     the store as `.view-<host>-<pid>-<uuid>`. It is opened once with a
     no-follow handle and bound read-only at the store's own path.
   - The links are made by the layout's own tree copy (`materialiseTree`, ADR
     0048): each file linked is the inode opened through no-follow handles, and
     an entry or a name in it that is a symbolic link, or that was swapped
     meanwhile, is refused, as a bind of the entry on its own refuses it.
   - Inside the sandbox the store holds the same entries at the same paths as
     when each was bound alone, and nothing else: no other package of the store,
     and not the view itself.
   - A run that needs eight entries or fewer binds each as before, and so does a
     store with only one entry the run needs. Eight leaves room in the 16 for
     the project, the working directory, the jail's home and policy grants.
   - The limit of 16 handles is unchanged.
2. **An npm tool run by `opmx` runs from a `node_modules` of its closure**
   (`ephemeral-layout.ts`).
   - The layout is written by the same writer as a project's (ADR 0048), with
     hard links to the store's files, under
     `<tool cache>/.opm/runs/run-<host>-<pid>-<uuid>`.
   - The layout is told which package each one requires, as the solve chose (ADR
     0054), so two versions of one name stay apart. cowsay's closure holds four
     names twice; told nothing, the layout kept one of each, and cowsay got
     `string-width` 4 where it asked for 2.
   - That one tree is what the sandbox binds.
   - A layout is never reused between runs, which would make it one more thing a
     run trusts without checking it again.
   - Python, .NET and native tools run as before; past eight packages their
     closure is bound through a view.
3. **A run removes both when it ends** (`run-scratch.ts`).
   - A run stopped by a signal, Ctrl-C included, cannot. The next run that makes
     a view in the same store, or a layout in the same cache, removes those
     whose process on this host has ended.
   - One whose process may still be running is never touched.
   - `opm gc` does not count a view as a store path (`isStoreView`).
   - While a view exists, each entry it shows has files with a second name, so
     the shared store's `opm gc` counts that entry as in use.

Consequences:

- Confinement is unchanged: read-only binds, the same paths, and only the
  closure visible. No store file's bytes are copied, unless the file system
  refuses a hard link, where the file is copied.
- A run past eight entries pays a link per file of what it binds: the closure
  for a tool, every package of the project for `opmx <bin>` in a project. An npm
  tool pays it once, for its layout. Before this, such a run was refused.
- `opmx pkg:npm/cowsay hi` runs against registry.npmjs.org (with the release-age
  capture of #182). Its layout of 33 packages, 419 files, took 0.2 to 1.0 s, and
  a view of the same entries 0.4 to 3.1 s, on a 4-core machine at a load average
  of 23 to 38. Most of the 23 to 29 s a run took was resolving the closure from
  the registry.

Limits:

- A view or layout left by a killed run stays until the next run in the same
  place. One left on another host is never removed from this one.
- A pid reused by a live process keeps a leftover until that process ends too.
- Measured and exercised on Linux, where bwrap is the backend.
  `tool-many-deps.test.ts` runs a 21-package tool, binds a symbolic link among
  its entries, kills a run with SIGKILL in the middle, and runs again;
  `tool-layout-versions.test.ts` lays out two versions of one name.
  `store-view-gc.test.ts` runs `opm gc` while a view is in use.
