# PREX and OpenPacker compliance (API and CLI)

This document defines what it means for a **server**, **SDK**, or **CLI** to
comply with PREX and with OpenPacker’s reference surfaces. Normative protocol
text lives in [`spec/prex/v1/`](../../spec/prex/v1/); this page is the
implementer checklist.

## Layers of compliance

| Layer | Name                      | Required for                               |
| ----- | ------------------------- | ------------------------------------------ |
| L0    | **Wire contracts**        | Any PREX HTTP or embedded caller           |
| L1    | **Capability levels**     | Advertising `PREX-N` … `PREX-C`            |
| L2    | **Semantics profiles**    | Advertising solve profiles                 |
| L3    | **OpenPacker extensions** | Using `/v1/openpacker/*` or CLI extensions |
| L4    | **Reference parity**      | Claiming “OpenPacker-compatible” digests   |

You may implement L0–L2 without shipping OpenPacker packages. L3–L4 describe
optional OpenPacker reference behaviors.

## L0 — Wire contracts (mandatory for any PREX party)

### HTTP

1. Implement discovery: `GET /.well-known/prex` and/or `GET /v1/capabilities`
   returning a `Capabilities` document that includes `protocolVersions`,
   `operations`, `conformanceLevels`, `purlTypes`, `versSchemes`,
   `semanticsProfiles`, and `limits`.
2. Use request/response bodies that validate against
   `spec/prex/v1/schemas/*.schema.json`.
3. Reject duplicate JSON object keys before protocol handling.
4. Return RFC 9457 Problem Details for errors; prefer documented codes in
   `spec/prex/v1/errors.md`.
5. Preserve `meta.protocolVersion` and provider identity on successful
   responses.
6. Do **not** put credentials, wall-clock noise, or transport headers into
   canonical digests (see canonicalization).

Authority: [`spec/prex/v1/openapi.yaml`](../../spec/prex/v1/openapi.yaml),
[`docs/protocol/operations.md`](../protocol/operations.md).

### Canonicalization and digests

1. Canonical JSON follows PREX rules (safe integers, sorted keys, no NaN/−0, no
   sparse arrays).
2. Digests are `sha256:<64 lowercase hex>`.
3. Identical logical objects produce identical digests across languages.

Authority:
[`spec/prex/v1/canonicalization.md`](../../spec/prex/v1/canonicalization.md).

### Embedded / in-process API

If you expose solve without HTTP, accept the same `SolveRequest` +
`ResolutionUniverse` objects and emit the same solution, proof, and digest
fields as the HTTP solve path.

## L1 — Capability levels

Advertise a level **only** when all assigned positive and negative vectors pass
and the operation is actually invoked (schema-only is insufficient).

| Level  | Operation focus                                                           |
| ------ | ------------------------------------------------------------------------- |
| PREX-N | Normalize                                                                 |
| PREX-I | Identify (no silent disambiguation)                                       |
| PREX-E | Enumerate (codec order, pagination)                                       |
| PREX-D | Inspect (loss-aware instances)                                            |
| PREX-S | Solve (deterministic + independent proof + bounded oracle where required) |
| PREX-M | Materialize (immutable descriptor; no lifecycle scripts)                  |
| PREX-V | Verify (six-state evidence ≠ policy decision)                             |
| PREX-X | Explain                                                                   |
| PREX-R | Receipts (signature outside receipt digest)                               |
| PREX-C | CloudEvents feed                                                          |

Executable vectors: `fixtures/protocol/`, harness `@openpacker/conformance`,
gate `npm run test:conformance`.

Authority: [`spec/prex/v1/conformance.md`](../../spec/prex/v1/conformance.md),
[`docs/protocol/conformance.md`](../protocol/conformance.md).

## L2 — Semantics profiles

| Profile                   | Compliance obligation                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `native-capture-v1`       | Preserve `environment.locked` selections; do **not** claim independent validation or calculus solving; record capture-only loss |
| `native-validated-v1`     | Check representable edges; report opaque native semantics not checked                                                           |
| `prex-calculus-subset-v1` | Solve the documented IR subset; emit independent proof accepted by the checker                                                  |

Mislabeling a capture as a calculus solve is a compliance failure.

## L3 — OpenPacker extension surface

These routes are **not** PREX conformance levels. Clients must not infer them
from PREX levels alone; they appear in capabilities / docs when offered.

| Extension               | HTTP                                                 | CLI                                  |
| ----------------------- | ---------------------------------------------------- | ------------------------------------ |
| Catalog import/snapshot | `POST /v1/openpacker/catalog/import`, `.../snapshot` | `catalog import`, `catalog snapshot` |
| Lock import             | `POST /v1/openpacker/lock/import`                    | `import-lock`                        |
| Lifecycle apply         | `POST /v1/openpacker/lifecycle/apply`                | `lifecycle apply`                    |
| Pack / publish          | `POST /v1/openpacker/pack`, `.../publish`            | `pack`, `publish`                    |
| Export helpers          | (local CLI transforms)                               | `export lock`, `export sbom`         |
| Resolve alias           | same as `POST /v1/solve`                             | `resolve` → `solve`                  |

### Lock import compliance rules

1. Default/only capture profile is `native-capture-v1`.
2. Response includes structured loss with `NATIVE_RESULT_CAPTURE_ONLY` (or
   equivalent documented code) that blocks stronger profiles.
3. Offline mode never contacts registries.
4. Unsupported lock versions fail closed.

Authority: [ADR 0021](../adr/0021-native-lock-import.md).

## L4 — Reference parity (“matches OpenPacker digests”)

To claim byte-identical unsigned results with this repository:

1. Use the same normalized request, universe snapshot digests, target, policy,
   lifecycle root, profile, objectives, and evaluation time.
2. Use a pure solver (no network during solve).
3. Sort canonical collections before hashing.
4. Compare against goldens under `fixtures/golden/` and `npm run golden:check`.

Service mode and embedded mode in OpenPacker must already agree; third parties
should too.

## CLI compliance profile

A PREX-oriented CLI is compliant when:

| Rule                   | OpenPacker CLI behavior                                     |
| ---------------------- | ----------------------------------------------------------- |
| Schema-shaped I/O      | `--input` JSON validates as the operation request           |
| Exact output bytes     | `--output` writes canonical or response raw bytes           |
| Machine mode           | `--json` prints non-redacted JSON for automation            |
| Offline safety         | `--offline` limits service URL to loopback; rejects publish |
| Secrets                | Tokens via `--auth-token-file`, never protocol objects      |
| Exit codes             | Stable numeric codes (0,2–9) — see runtime-clients          |
| Discover before assume | Callers should check capabilities for optional ops          |
| Alias honesty          | `resolve` is identical to `solve`                           |

Human-readable stdout may redact credential-like keys; JSON mode must remain
faithful for automation.

## SDK compliance profile

| Rule               | OpenPacker SDK                                                   |
| ------------------ | ---------------------------------------------------------------- |
| Return exact bytes | `{ data, rawBytes, response }`                                   |
| Problem Details    | `PrexClientError` retains status + problem + rawBytes            |
| Retries            | Only safe methods or idempotent keys; 429/502/503/504            |
| Auth               | Per-request header callback; no credential persistence in bodies |
| Dual module        | ESM + CJS + browser-safe entry                                   |

## What must never be claimed

- That PREX compliance implies a full native package manager
- That capture profiles independently solved dependency graphs
- That missing evidence is “valid”
- That OCI location is package identity
- That OpenPacker extension routes are required PREX levels

## How OpenPacker proves its own compliance

| Gate                     | Command                    |
| ------------------------ | -------------------------- |
| Schema + vector harness  | `npm run test:conformance` |
| Contract packages        | `npm run check:contracts`  |
| Goldens                  | `npm run golden:check`     |
| Docs inventory and links | `npm run test:docs`        |
| Full offline aggregate   | `npm run verify`           |

## Checklist for a third-party PREX server

- [ ] Capabilities advertisement matches implemented routes
- [ ] Each advertised PREX level has positive **and** negative vectors
- [ ] Solve runs independent proof check before success
- [ ] Canonical digests stable across restarts
- [ ] Errors are RFC 9457 with documented codes where applicable
- [ ] Extension routes are explicitly documented as non-PREX
- [ ] Offline test suite does not require public registries
