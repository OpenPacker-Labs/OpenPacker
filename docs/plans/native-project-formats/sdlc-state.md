# sdlc-state: native-project-formats

- **Initiative:** Make `opm` maintain the project files each ecosystem's own
  tooling reads, and describe a package across all of them in one document
- **Phase:** done
- **Trunk:** main
- **PR:** #41 → squash-merged `2db0c5a` (seven commits, planned as six layers)
- **Plan:** approved in-session; recorded here since no plan file was kept

## Goal

`opm` decided from `opm.toml` and wrote `opm.lock.json` and `.opm/store`, none
of which anything else reads. An IDE, a CI job, `dotnet build` and `node` all
read `package.json` or the `.csproj`, so a project managed with opm looked to
every other tool like a project with no dependencies.

Mid-initiative the user extended the goal: the manifests should be **artifacts
produced through a pluggable abstraction**, and opm needs a registry/manifest
format supporting external registry providers and provenance, the way the MCP
registry's `servers.json` supports different package managers — as the base for
an OpenPacker registry spec.

## Scoping decisions (from the user)

| Question        | Chosen                                                               |
| --------------- | -------------------------------------------------------------------- |
| Which files     | Manifest **and** native lockfile **and** native install layout       |
| Source of truth | `opm.toml` stays authoritative; native files are projected from it   |
| Building        | In scope — `opm pack` emits real vendor archives                     |
| Ecosystems      | Every one with a manifest: npm, NuGet, PyPI, Cargo, Go, Maven/Gradle |

## Layers as delivered

0. **Forward-compat fix.** The unknown-reserved-type check merged in #37 threw
   on any unrecognised `prex.*` type, contradicting `registry-resource-types.md`
   ("Unknown types MUST be ignored by v1 clients") and making every new
   vocabulary entry — including the four this initiative adds — a breaking
   change for hosts that predate it. Prerequisite, and a genuine defect in
   shipped code.
1. **`ProjectFormat` contract + npm and NuGet manifests.** New optional
   `AdapterModule` export, four resource types, a WIT `project` interface,
   agreement checks, `projectNativeFormats`, `opm.toml` `scope` and
   `native_projection`. ADR 0034.
2. **PyPI, Cargo, Go, Maven/Gradle manifests.**
3. **Native integrity capture + native lockfiles.**
4. **Native install layouts** (`node_modules/`, `obj/project.assets.json`).
5. **`opm pack`** — real `.tgz` and `.nupkg`.
6. **Package manifest schema** — the format the user asked for, plus
   `opm manifest`.

## Decisions

1. **Vendor formats live in adapters.** Core never learns what a `.csproj` is,
   exactly as it never learns what an apt package is (ADR 0031, 0032).
2. **Projection is one-way.** `readRequirements` exists for a later
   `opm import --native`, not to change what was resolved.
3. **Only what opm wrote is ever removed.** `.opm/native.json` records the
   managed names per ecosystem. Treating `opm.toml` as an allowlist over a file
   opm does not own would delete a hand-added dependency. Previously-managed
   ecosystems are still visited after their last package goes — which is exactly
   when the entry needs taking out.
4. **Edits are surgical.** Hand-maintained, comment-bearing, version-controlled
   files: preserve indentation, line endings and everything untouched; write
   temp-then-rename; refuse a file carrying merge conflict markers.
5. **A projection that cannot be faithful records loss.** A Gradle build script
   is a program, not a dependency list — `NATIVE_MANIFEST_NOT_WRITABLE`, and the
   writable surface is the version catalog. `go.mod` has one require list, so a
   development dependency would be indistinguishable from a shipped one.
6. **All-or-nothing native lockfiles.** No native lockfile pins with what PREX
   pins with, and `materialize` extracts the archive and discards it, so
   integrity is captured at resolve time onto `LockPackage`. Any package missing
   its value refuses the whole file.
7. **Layouts never symlink.** Hardlink where the filesystem allows, copy where
   it does not: a symlinked layout needs developer mode or elevation on Windows
   and breaks realpath-resolving tools, so the same lockfile would install
   differently depending on where it ran.

## Package manifest: what changed from `server.json`

The MCP registry's `server.json` solved the same problem for MCP servers, so
`spec/prex/v1/schemas/package-manifest.schema.json` borrows the structure
(`packages[]` → `distributions[]`, with `identifier`, `version`,
`registryBaseUrl`, `runtimeHint`) and changes three things:

| `server.json`                      | PREX                                | Why                                                   |
| ---------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| `fileSha256`, bare hex             | `Digest` with `algorithm` + `value` | Algorithm stated; a mismatched pair is a schema error |
| `registryType`, private vocabulary | `purlType`                          | PREX already uses PURL types as ecosystem identity    |
| `_meta` publisher blob             | `provenance` + `verified[]`         | The difference between a claim and a verification     |

`registries[]` names external providers by `registryId` and pins the Registry
Definition digest each was built against, so a registry that later advertises
different capabilities is visible rather than silent. That is the seam a
registry spec builds on.

## Build vs buy (ADR 0030)

Bought: `fast-xml-parser` (XML), `smol-toml` (TOML), `fflate` (gzip + zip),
`minimatch` (already, for TUF). Written: tar _framing_ — a fixed 512-byte record
with a checksum, where `tar-stream` would add four transitive packages to a
project that had just tightened its own supply-chain policy, and the
materializer already owns a tar reader the tests round-trip these bytes through.

## Not verified

`dotnet`, `go` and `gradle` are not installed in this environment, so the
cross-tool checks that would actually prove this —
`dotnet restore --locked-mode`, `go mod tidy` — have **not** been run. npm-side
behaviour is verified against real fixtures, and the tar output is round-tripped
through the materializer's own reader, including the ustar prefix path a naive
writer truncates into a different file.

## Follow-ons

- Cross-tool verification on a host with the .NET and Go toolchains.
- `opm import --native`, using the `readRequirements` this shipped.
- Bidirectional drift detection between `opm.toml` and native manifests.
- A registry service serving package manifests, on the schema this establishes.
