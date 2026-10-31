# ADR 0060: `opm ci` runs the install scripts a project approved

- Status: Accepted
- Date: 2026-10-31
- Amends [ADR 0046](0046-a-lockfile-is-installed-not-re-resolved.md) §9 and
  [ADR 0055](0055-opm-ci-installs-a-pnpm-lock.md) §21 (no install script is run)
- Amended 2026-10-31: the scripts run in dependency order (§7), and opm's `npm`,
  `pnpm` and `yarn` lead their PATH
  ([ADR 0061](0061-npm-run-inside-opm-run-runs-opm-run.md) §10)
- Relates:
  [0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (no
  symlink in `node_modules` but a member's), the package-exec jail of
  `@openpacker/sandbox`

## Context

`opm ci` ran no install script. On the projects it now installs that was enough
for every proof but one. ceremony's PostgreSQL tests (74 of them, in its
`npm test` and its CI's `npm run verify`) need `@embedded-postgres/linux-x64`'s
`postinstall`. That `hydrate-symlinks.js` makes 14 versioned `.so` names, which
an npm archive cannot carry. Running every script, as npm does, is what ADR 0046
§9 refused, and still refuses.

npm (10.9.4 here) has no way to approve one package's scripts: only
`ignore-scripts` for all of them. The package managers that run none by default
read an allowlist that projects already write:

- pnpm: `onlyBuiltDependencies` (in `package.json`'s `pnpm` field or in
  `pnpm-workspace.yaml`) and `allowBuilds` (`pnpm-workspace.yaml`, a name to
  `true`). HoBo approves four packages this way.
- Bun: `trustedDependencies` in `package.json`.

## Decision

1. **The lock says what the project approved.** The npm format reads those
   declarations into `FrozenLock.approvedBuilds`: package names, or
   `name@version`, and where each list was found. Nothing else approves a
   script, and a project that declares none gets what it got before.
2. **An approved package's `preinstall`, `install` and `postinstall` run where
   npm runs them,** in the package's own directory under `node_modules`, once
   the layout is written, so a script finds its dependencies. That is each place
   the package has (HoBo's esbuild 0.25.12 is in four member trees).
3. **Inside the package-exec jail.** The directory is writable, the project is
   read-only, there is no network, and `PATH` is opm's `npm`, `pnpm` and `yarn`
   shims (ADR 0061 §10), then that package's and the project's `.bin`, then the
   Node that runs opm. The shims and the `opm run` they start are mounted
   read-only: a script that calls `npm run build` runs its own `build` through
   `opm run` in the same jail, and `npm install` is refused. The sandbox now
   mounts a parent before the paths inside it, so the writable directory stays
   writable inside the read-only project. A script that fails fails the install.
4. **On the package's own files.** They are hard links into the shared store
   until then. Each is replaced by a copy first, so nothing a script writes
   reaches the store or another project.
5. **No symlink is left.** A link the script made inside its directory, to a
   file of its own, becomes a hard link to that file.
   `libpq.so.5 -> libpq.so.5.18` is the same file to the dynamic loader. Any
   other link fails the install: `node_modules` holds no symlink but a member's
   (ADR 0048).
6. **Reported.** Each approved script that ran is listed, in the order it ran.
   Every other package that declares one is still listed as not run.
7. **In dependency order** (amended 2026-10-31). A package's scripts run after
   those of every approved package it depends on: the names in its installed
   `package.json`'s `dependencies`, `optionalDependencies` and
   `peerDependencies`, each resolved to the place in the lock Node loads it from
   (the nearest `node_modules` at or above the package that the lock fills, a
   workspace link to its member, and nothing past a copy its parent's archive
   bundles), directly or through packages and members that run nothing. Where
   nothing orders two packages the lock's order does, so the order is the same
   on every machine. Packages that depend on each other in a cycle run in the
   lock's order, and a cycle in which more than one runs a script is reported
   (`install scripts in a dependency cycle, run in the lock's order: …`). The
   scripts run one at a time, each package's `preinstall`, `install` and
   `postinstall` together. The jail of §3 to §5 is the same for each.

   This is pnpm's rule, not npm's. npm 10.9.4 (`@npmcli/arborist` `rebuild.js`)
   runs each event over every package, sorted by depth and then path, up to one
   fewer than the processors at a time, and orders nothing by dependency: a
   `postinstall` that needs another package's built output works there only when
   the sort or the scheduler happens to put that one first. pnpm 10.28.0
   (`buildSequence`, `graph-sequencer`) builds in chunks, a package after its
   dependencies. The names come from the installed manifest rather than the
   lock, so a pnpm lock and an npm lock are ordered by one rule, and a patched
   manifest (ADR 0057) by what is installed.

## Consequences

- HoBo's whole-workspace `opm ci` now runs the scripts of `@ast-grep/cli`,
  `@bufbuild/buf`, esbuild (in each of its places) and protobufjs. All of them
  pass in the jail with no network.
- ceremony approves nothing, so `opm ci` still runs none of its scripts. Its
  PostgreSQL tests pass under `opm ci` once it approves
  `@embedded-postgres/<platform>` in one of these declarations. That is a change
  to ceremony, not to opm.
- A package's built files are copies, not links: the disk cost is that package's
  size, for approved packages only.
- A script that needs another approved package built first works, wherever the
  lock lists the two (§7). Scripts are not run in parallel; an install with many
  approved packages takes the sum of their times.
- Tests: `frozen-install.approved-builds.test.ts` (Bun's and pnpm's
  declarations, a link the script makes, no network, no other script, the store
  untouched), the sandbox's "keeps a writable path writable inside a read-only
  one", `frozen-install.build-order.test.ts` (an approved `a` whose
  `postinstall` reads approved `b`'s built file, `b` hoisted or nested in `a`
  and listed after it; a diamond; a dependency through a package that runs
  nothing; a cycle; Bun's and pnpm's declarations, and a `pnpm-lock.yaml` with
  `onlyBuiltDependencies` and `allowBuilds`), `frozen-build-order.test.ts` (the
  order itself: Node's nearest `node_modules`, workspace links, bundled copies,
  the lock's order for ties) and apps/opm `ci-build-order.test.ts` (what
  `opm ci` prints).
