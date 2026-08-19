# ADR 0037: Delegated pack providers plan; the host authorizes and executes

- Status: Accepted
- Date: 2026-08-18
- Relates: [ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md),
  [ADR 0032](0032-wit-adapters-and-registry-definition.md),
  [ADR 0036](0036-sandboxed-installs-and-execution.md)

## Context

The first package-build/2 implementation proved delegation across major native
tools, but kept their command tables inside `adapters-default`. Supporting a new
package manager still meant changing and releasing OpenPacker. Loading arbitrary
TypeScript modules would remove the switch while granting untrusted code ambient
Node process authority, which violates the WIT and sandbox decisions above.

## Decision

Delegated pack providers use a versioned JSON manifest mapped to the
`package-build` WIT planner interface. Both produce the same canonical
`DelegatedPackHostPlan`.

The boundary is intentionally asymmetric:

- providers declare detection markers, argument templates, requested authority,
  environment names, artifact patterns and a sandboxed identity probe;
- the host validates, grants authority, expands templates, resolves tools,
  executes through `runInSandbox`, contains outputs, hashes bytes, and records
  each matching probe result explicitly as `provider-attested` identity;
- no provider manifest contains a command string or secret value;
- no WIT guest receives ambient process authority merely because it can plan.

Standard emitters remain host-owned. They are deterministic implementations of
the normalized interface, not delegated native tools.

## Consequences

Any local package manager can be configured without an OPM code change. Native
tool support becomes data that can be tested independently. The host has one
execution funnel and one receipt path, while a future WASM component can replace
declarative planning without changing authorization or execution semantics.

Provider manifest version 2 makes the identity probe mandatory. It prevents an
accidental target mismatch but is not independent native-format validation: the
same delegated executable produced and attested the artifact. Receipts say
`provider-attested`; only a separately trusted standard emitter or format
verifier may claim native validation.

Provider distribution, signatures, remote fetching and a marketplace remain out
of scope. A project names local provider files explicitly.
