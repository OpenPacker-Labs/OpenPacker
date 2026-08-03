# Recommended user surface

OpenPacker is a package control plane. The recommended CLI and API surface
mirrors PREX operations, adds a small set of OpenPacker extension commands for
catalog and lock workflows, and keeps native install/build/runtime outside the
protocol. Normative HTTP paths remain under `/v1/*` as described in
[Operations](../protocol/operations.md). Service and embedded modes share the
same normalized objects.

## Core operations

| Surface       | Role                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalize`   | Canonicalize PURL, VERS, native coordinate/version/range, digest, or target inputs with reversibility and semantic loss                                            |
| `identify`    | Resolve ambiguous names, aliases, and external refs to candidates without silent selection                                                                         |
| `enumerate`   | List exact versions for a base package under target and lifecycle visibility                                                                                       |
| `inspect`     | Return a loss-aware `PackageInstance` for one exact package                                                                                                        |
| `solve`       | Snapshot-backed resolution under an explicit semantics profile; emits solution, independent proof, explanation, and receipt                                        |
| `resolve`     | Alias of `solve` for operators who expect package-manager vocabulary; same request/response contracts as `solve`                                                   |
| `import-lock` | OpenPacker extension: offline native lock capture under `native-capture-v1` with `NATIVE_RESULT_CAPTURE_ONLY` loss ([ADR 0021](../adr/0021-native-lock-import.md)) |
| `export lock` | Write `openpacker.lock.json` from a complete solve/capture response                                                                                                |
| `export sbom` | Emit CycloneDX-oriented SBOM evidence derived from a resolution result                                                                                             |
| `materialize` | Prepare or extract immutable artifact descriptors after resolution; never runs native lifecycle scripts                                                            |
| `verify`      | Check digests, signatures, and evidence facts; policy decides allow/deny/indeterminate separately                                                                  |
| `explain`     | Return the normative explanation graph and optional derived prose for a solution digest                                                                            |
| `receipt`     | Inspect or verify stored receipt envelopes by digest                                                                                                               |
| `catalog`     | Import or snapshot catalog universes for offline and deterministic solve                                                                                           |

Discovery (`capabilities`, health/ready) stays side-effect free and is required
before clients assume which operations a deployment advertises.

## Semantics and claims

| Profile                   | When to use                                                   | Claim strength                                                 |
| ------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `native-capture-v1`       | `import-lock` and recorded native selections                  | Captured native result only; no independent solve claim        |
| `native-validated-v1`     | Re-check representable hard relations against a captured lock | Checks represented edges; reports unvalidated native semantics |
| `prex-calculus-subset-v1` | Cross-ecosystem or shared-IR solving from requirements        | Independent solve and proof over the documented IR subset      |

`resolve` does not change profile defaults; callers set `semantics.profile`
explicitly. `import-lock` always records capture-only loss that blocks stronger
profiles until the operator re-solves or validates.

## CLI shape

Prefer stable subcommands that accept schema-shaped JSON via `--input`, emit
canonical JSON with `--json`, and write exact bytes with `--output`. Offline
clients use `--offline` against loopback services and pre-imported catalogs.

```sh
openpacker normalize --input req.json --json
openpacker identify --input identity.json --json
openpacker enumerate --input enum.json --json
openpacker inspect --input package.json --json
openpacker solve --input solve-request.json --output solve-response.json --json
openpacker resolve --input solve-request.json --json
openpacker import-lock --input package-lock.json --format package-lock --json
openpacker export lock --input solve-response.json --output openpacker.lock.json --json
openpacker export sbom --input solve-response.json --json
openpacker materialize --input materialize.json --json
openpacker verify --input verify.json --json
openpacker explain --input explain.json --json
openpacker receipt verify --input receipt.json --json
openpacker catalog import --input universe.json --json
```

Human-oriented flags such as `--target`, `--policy-file`, and
`--evaluation-time` remain transport context; they do not invent parallel
protocol objects. Exit codes and redaction follow
[Runtime and clients](../operations/runtime-clients.md).

## API shape

| Kind                       | Path / entry                                                                                                 | Notes                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| PREX                       | `POST /v1/normalize`, `/identify`, `/enumerate`, `/inspect`, `/solve`, `/materialize`, `/verify`, `/explain` | Conformance operations; see OpenAPI                                |
| Receipt and snapshot fetch | `GET /v1/receipts/{algorithm}/{digest}`, `GET /v1/snapshots/{algorithm}/{digest}`                            | Exact stored canonical bytes                                       |
| Events                     | `GET /v1/events`                                                                                             | NDJSON CloudEvents replay                                          |
| OpenPacker extension       | `POST /v1/openpacker/catalog/*`, pack/publish/lifecycle                                                      | Outside PREX conformance namespace                                 |
| Recommended extension      | `import-lock` as OpenPacker extension op (CLI and SDK)                                                       | Offline lock capture; not a substitute for `POST /v1/solve` claims |
| SDK / embedded             | `@openpacker/sdk`, `@openpacker/embedded`                                                                    | Same normalized request and universe objects as HTTP               |

`resolve` is a client alias only: it must call the same solve contracts and
digests as `solve`. Embedded callers pass immutable universes; they never expect
the pure resolver to fetch catalogs or import locks.

## Composition patterns

1. **Pin what native already solved** — `import-lock` → optional capture-mode
   solve → `export lock` / `receipt` / `verify`.
2. **Cross-ecosystem solve** — `catalog` snapshot → `normalize` requirements →
   `solve` with `prex-calculus-subset-v1` → `verify` → `materialize` selected
   artifacts; install scripts remain native or mise-owned.
3. **Tool install via mise** — mise list/install hooks call `enumerate` and
   `materialize` only; see [mise](../integrations/mise.md).

What to reuse versus build is covered in the
[leverage guide](leverage-guide.md). The control-plane framing is fixed in
[ADR 0020](../adr/0020-control-plane-not-supersession.md).
