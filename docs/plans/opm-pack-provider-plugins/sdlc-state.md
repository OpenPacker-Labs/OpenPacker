# OPM delegated pack provider plugins SDLC state

## Status

- Phase: independent review
- Current layer: `04-opm-config`
- Parent stack branch: `sdlc/opm-pack-01-contracts-delegation`
- Stack chain:
  1. `sdlc/opm-pack-01-contracts-delegation`
  2. `sdlc/opm-pack-plugins-02-contracts`
  3. `sdlc/opm-pack-plugins-03-host`
  4. `sdlc/opm-pack-plugins-04-opm-config`
- Dispatch backend: parent sequential. The user authorized stacked delivery but
  did not authorize implementation offload; independent review remains required.
- PRs: [#79](https://github.com/Tyler-R-Kendrick/OpenPacker/pull/79),
  [#80](https://github.com/Tyler-R-Kendrick/OpenPacker/pull/80),
  [#81](https://github.com/Tyler-R-Kendrick/OpenPacker/pull/81), and
  [#82](https://github.com/Tyler-R-Kendrick/OpenPacker/pull/82) are open as a
  stack. PRs #79 and #80 are independently approved; PR #81 review fixes have
  passed focused gates and await re-review.

## Problem and success criteria

OPM currently keeps delegated pack command plans in `adapters-default`. Adding a
package manager therefore requires changing the OpenPacker distribution. Replace
that closed list with a versioned provider manifest mapped onto the PREX adapter
WIT boundary. A user must be able to configure an unrecognized PURL type and
native command without changing OPM source, while OPM retains all process,
sandbox, consent, output-containment and receipt authority.

Success is executable when:

- a schema-valid provider manifest for a synthetic package manager loads from
  `opm.toml`, detects a project, plans and delegates through the host sandbox;
- malformed manifests, unknown templates, missing consent, unsafe environment
  requests, escaping artifacts and unavailable executables fail closed;
- the default adapter distribution contains no npm/cargo/uv/dotnet/docker/nix/
  winget/etc delegated command table;
- standard packing stays deterministic and independent of delegated providers;
- contracts, provider runtime and OPM configuration each have package-scoped
  tests and stacked PRs; full offline `npm run verify` and independent review
  pass.

## Brainstorm and hardening

### Approaches considered

1. Keep TypeScript `PackagePacker` imports and document a convention. Rejected:
   arbitrary imported JavaScript receives ambient process authority and is not a
   portable WIT/manifest boundary.
2. External JSON-RPC helper processes. Rejected: this adds another
   daemon/process protocol and moves command authority outside the existing
   fail-closed sandbox.
3. Declarative JSON provider manifests compiled to the same pure package-build
   WIT plan shape, with the host alone executing commands. Selected: it is
   small, portable, testable without native tools and admits future WASM
   components without changing host authorization.

### Adversarial survival

- Provider documents never contain secret values and cannot request ambient
  environment. They may name environment variables; project configuration must
  explicitly allow each name before the host forwards its current value.
- Templates expand only as complete argv/env values from a closed vocabulary.
  There is no shell interpolation or command string.
- Provider authority is declarative. Build and network remain separate explicit
  grants; project input is read-only and output is the sole write path.
- Artifact discovery remains bounded and contained beneath the output directory.
- Plugins plan; the OPM host executes. Neither JSON manifests nor future WIT
  guests receive ambient process authority.

### YAGNI and rubber-duck

- No plugin marketplace, installer, remote manifest fetch, signatures or hot
  reload in this initiative. Providers are local, explicit, schema-versioned
  files.
- No generic workflow language. A provider declares detection markers, argument
  templates, conditional argument lists, environment names and artifact
  patterns.
- Standard emitters are not moved behind plugins: the requested openness
  concerns delegated native tools, while standardized pack remains OPM-owned.

## Planned layers

1. `02-contracts`: delegated-provider JSON schema, positive/negative vectors,
   generated types, package-build WIT plan interface, ADR and specification
   docs.
2. `03-host`: independent `@openpacker/pack-provider` workspace package that
   parses manifests, compiles plans, resolves executables without running them,
   executes only through the sandbox, and registers providers separately from
   standard ecosystem adapters.
3. `04-opm-config`: `opm.toml` provider discovery/authority configuration, CLI
   provider selection, synthetic end-to-end proof, and removal of hard-coded
   delegated command tables from `adapters-default`.

## Acceptance

- Narrow package gates pass per incremental commit.
- `npm run agent:check:staged` passes before each commit.
- `npm run verify` passes on every submitted stack layer's final composition.
- Each PR receives bottom-up rubber-duck, adversarial and independent review;
  all threads are resolved before squash merge.

## Implementation log

- Durable plan and one-shot layer contracts committed on the contracts branch.
- Delegated-provider schema, WIT planner, conformance vectors, generated types,
  normative guide and ADR 0037 committed on the contracts branch.
- Full `npm run verify` passed on the composed stack on 2026-08-18. PR #80's
  executable binding, dedicated WIT world, versioned planner input and broader
  negative vectors passed independent re-review.
- Added the independently tested manifest loader and sandboxed host package; all
  seven package tests and the staged gate passed on 2026-08-18.
- Added collision-safe delegated-provider routing independent from ecosystem
  adapter registration; all 20 adapter-host tests passed.
- PR #81's first independent review found executable-path rebinding,
  sandbox-wrapper environment, fail-closed mode, artifact race/bounds and parser
  parity defects. The shared host fixes and 39 sandbox/provider tests pass; full
  aggregate verification and re-review are pending.
- Deleted 1,686 lines of built-in native delegation and retained standard
  emitters behind a process-free packer.
- Added strict `[pack.providers.<id>]` TOML configuration, local provider
  loading, declared environment binding, synthetic end-to-end packing and
  `--provider` selection.
