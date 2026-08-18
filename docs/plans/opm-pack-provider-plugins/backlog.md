# OPM delegated pack provider plugins backlog

This repository has no configured Linear connection, so these one-shot contracts
are staged locally and map one-to-one to the requested PR stack.

## Layer 02 — contracts and WIT

Why: third-party delegated packers need a portable, versioned contract before
any host implementation can trust them.

Scope: `spec/wit/prex-adapter.wit`, `spec/prex/v1`, `packages/contracts`,
conformance vectors, ADR/docs. No runtime loading or OPM configuration.

Acceptance:

- `npm run check:contracts` validates positive and negative provider vectors.
- generated TypeScript exposes the provider document and delegated host-plan
  types.
- WIT exports a package-build planner whose result is host-executed, not
  guest-executed.
- malformed authority, templates, paths and artifact declarations fail schema
  checks.

## Layer 03 — manifest provider host

Why: schema-valid documents must map to the existing `PackagePacker` behavior
without importing provider JavaScript or giving guests ambient process
authority.

Scope: new `packages/pack-provider`, `packages/adapter-host`
registration/routing, package-scoped unit and security tests. No `opm.toml`
changes and no default-table removal.

Acceptance:

- a synthetic manifest detects, plans and produces typed artifacts through an
  injected sandbox executor;
- availability resolves PATH without executing the binary;
- build/network/environment authority, template vocabulary, output containment,
  cleanup and artifact bounds fail closed;
- `npm run test --workspace @openpacker/pack-provider` and adapter-host gates
  pass.

## Layer 04 — OPM configuration and extraction

Why: users need project configuration to select any local provider, and the
distribution must stop hard-coding native package managers.

Scope: `packages/opm-project` TOML/types/discovery, `apps/opm`,
`packages/adapters-default`, guide/examples and integration tests.

Acceptance:

- `[pack.providers.<id>]` config loads an explicit local manifest, selects it by
  PURL type or `--provider`, and allowlists named environment variables without
  storing their values;
- a synthetic unknown ecosystem delegates successfully in an offline test;
- standard emitters still pass independently with no configured provider;
- `adapters-default` contains no native delegated command or tool-name table;
- full offline `npm run verify` and independent review pass.
