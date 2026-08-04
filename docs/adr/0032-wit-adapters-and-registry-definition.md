# ADR 0032: WIT adapters and capability-discoverable registry definitions

- Status: Accepted
- Date: 2026-08-04
- Relates to: [ADR 0020](0020-control-plane-not-supersession.md),
  [ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md)

## Context

PREX is intended as the **plug-in interface** for package managers: one identity
scheme, one verification story, one receipt format. Implementations had drifted
toward:

1. **Hardwired ecosystems** in the control plane (`switch` on npm/cargo/…,
   compile-time imports of apt/nix/winget into `opm-project`).
2. A **split CLI ontology** (`opm add` vs `opm system`) that treated host
   package managers as a second product rather than adapters with different
   capability vectors.
3. No **portable description of a package source** comparable to NuGet’s v3
   service index, so discovery of “what can this registry do?” stayed ad hoc per
   ecosystem.

The desired end state normalizes **library packages, system packages, install /
update / uninstall, and execution environments** against **registries**, with
**nix** and **mise** as reference models — without baking any manager into the
host.

## Decision

1. **Adapters are WIT components.** The normative guest ABI is
   [`spec/wit/prex-adapter.wit`](../../spec/wit/prex-adapter.wit)
   (`openpacker:prex-adapter@0.1.0`). The host loads components from an
   allowlisted configuration; it does not compile ecosystem packages into the
   core. A TypeScript in-process bridge MAY implement the same interface shapes
   during migration; the architectural boundary is still the WIT world.

2. **Every package source has a Registry Definition.** The document is defined
   by
   [`spec/prex/v1/registry-definition.md`](../../spec/prex/v1/registry-definition.md)
   and
   [`schemas/registry-definition.schema.json`](../../spec/prex/v1/schemas/registry-definition.schema.json).
   It is a **capability-discoverable service index** (NuGet-inspired): versioned
   resource `@type` values map to operations (search, enumerate, metadata,
   artifact, install, update, uninstall, environment). Missing type ⇒
   unsupported.

3. **Two-layer negotiation.** Component exports answer “what can this adapter
   implement?” The Registry Definition answers “what does this named source
   offer?” They MUST NOT disagree.

4. **Control plane capabilities stay separate.** `GET /v1/capabilities` remains
   the PREX **service** document. Registry Definition is per **source**. Clients
   merge both.

5. **No long-term baked-in ecosystem list in core.** Hardwired imports and
   `opm system` as a separate product ontology are transitional. User-facing
   verbs converge on one family (`add` / `install` / …) differentiated by
   discovered capabilities and semantic loss — not by special-casing apt/nix in
   the CLI grammar.

6. **Reference models:** **mise** (tool manager client over PREX materialize /
   env) and **nix** (store + registry + install + environment adapter) validate
   the resource vocabulary. apt, winget, Chocolatey, git, OCI, npm, Cargo, etc.
   are peer adapters with different resource subsets.

## Consequences

- New backends ship as adapter packages + Registry Definition production; core
  gains zero ecosystem-specific imports.
- Honesty (byte verification, elevation, reversibility) is declared on
  `features` and semantic loss, not by forbidding a unified verb.
- WASI policy gates network and process access for components that need
  `install` or HTTP.
- Existing TypeScript `CatalogProvider` / `InstallerProvider` / `EcosystemCodec`
  interfaces remain valid migration targets that implement the WIT shapes
  in-process until real component loading lands.

## Notes

Normative protocol text and schemas override this ADR on conflict. Conformance
fixtures for Registry Definition live under
`fixtures/protocol/registry-definition/`.
