# ADR 0034: opm maintains the ecosystem's own project files

- Status: Accepted
- Date: 2026-08-10
- Amends [ADR 0022](0022-opm-package-manager-surface.md) (“does not replace
  native ecosystem install layouts by default”)
- Amended by
  [ADR 0043](0043-one-copy-per-machine-and-a-node_modules-node-can-resolve.md):
  the `layout` level needs no native manifest, plans nested versions from the
  lock's edges, and links files from the store
- Amended by [ADR 0050](0050-workspace-member-links.md): the handle-relative
  create gains workspace-member links, on Windows as a junction made relative to
  the parent handle (and the one window that leaves)

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
