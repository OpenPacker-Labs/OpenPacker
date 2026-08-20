# 40. Delegated plugins deliver artifact bytes and executables

Date: 2026-08-20

## Status

Accepted — amends
[0039](0039-third-party-ecosystems-arrive-as-delegated-adapter-plugins.md);
amended by [0041](0041-host-fetch-operator-pins-and-credentials.md)

## Context

ADR 0039 scoped version 1 of delegated adapter plugins to read-only
registry-definition and catalog answers over a bounded canonical-JSON stdio
protocol. That left plugin-served tools uninstallable: the protocol carries no
artifact bytes, so acquisition failed closed at digest verification, and nothing
carried the package's executable declarations, so a materialized plugin tool
could not run. Per ADR 0028 this amendment supersedes that interpretation; the
bounded-protocol and fail-closed invariants of ADR 0039 stand.

## Decision

- **Artifact bytes travel host-side, never plugin-side.** A delegated provider
  signals host-side byte acquisition with the provider capability extension
  `openpacker/artifact-bytes: "host-fetch"`. Its `fetch-artifact-record` body
  carries a sha256 `digest`, a byte `size`, and at least one `locations[].uri`;
  the host fetches the bytes itself over HTTPS without credentials, from the
  allowlisted origin of the record's `endpoint`, bounded by the published size,
  and verifies the sha256 digest before any use. The host resolves the location
  and refuses private, loopback, link-local, NAT64, or IPv4-mapped answers
  unless the origin is operator-pinned (`OPM_HOST_FETCH_ORIGINS`); the plugin
  naming an origin is not a pin. The host never attaches credentials to the
  download. Absence or mismatch fails closed. `rawBody` remains the canonical
  bytes of the answered body — the honesty invariant is unchanged.
- **Executables are provider metadata.** `DelegatedAdapterInspectionResult`
  gains an optional `executables` array of `DelegatedAdapterBin`: a safe
  single-segment `name`, a relative POSIX `path` without `..`, an `interpreter`
  of `node` (default), `python`, `dotnet` or `native`, and an `entry` required
  iff the interpreter is `python`. Hosts validate every declaration before use
  and fail closed on anything else.
- **`native` is a first-class interpreter.** Third-party package managers are
  usually native binaries; `native` means the host executes the verified store
  file directly through the existing sandbox funnel.
- The spec and schema change together: `spec/prex/v1/delegated-adapter.md` and
  `schemas/delegated-adapter.schema.json` (and its generated mirrors) are
  amended in the same change.

## Consequences

- The plugin stays the metadata authority — the same trust position a
  first-party registry holds. It never proxies bytes, so the stdio protocol
  stays bounded and metadata-only.
- Codec, installer, project-format and pack capabilities remain non-delegatable
  and fail closed.
- First-party registry paths are unchanged: a provider without the `host-fetch`
  marker behaves exactly as before.
- A plugin-served tool can now resolve, install, and run end to end without
  weakening digest pinning, origin allowlisting, or sandbox containment.
