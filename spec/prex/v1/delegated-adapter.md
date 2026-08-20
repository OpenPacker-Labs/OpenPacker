# Delegated adapter plugin manifest

`DelegatedAdapterManifest` is the portable configuration for a third-party
ecosystem adapter that OPM executes out of process. It maps to a subset of the
`adapter` world in `openpacker:prex-adapter@0.1.0`: version 1 delegates the
registry-definition and catalog surfaces. An `inspect` result MAY declare the
executables a package provides, and artifact bytes are acquired host-side as
specified under [Artifact bytes](#artifact-bytes). Codec, installer,
project-format and pack capabilities are not delegatable in version 1; a host
MUST fail closed when an operation needs an undeclared capability.

Media type: `application/vnd.openpacker.delegated-adapter.v1+json`.

The plugin is an answerer, not an executor. For every operation the host
separately:

1. checks the executable without running it;
2. obtains explicit network and environment authority;
3. writes a bounded canonical `DelegatedAdapterRequest` to the plugin's standard
   input — never argv templates, never shell text;
4. executes the command through the fail-closed package sandbox;
5. reads a bounded canonical `DelegatedAdapterResponse` from standard output;
6. validates the result against the normative PREX schema for that operation
   before any use.

## Distribution

Delegated adapters are distributed as ordinary PREX packages under the reserved
purl type `opm-plugin`: `pkg:opm-plugin/<name>@<version>`. The package artifact
contains the manifest and the standalone executable. Hosts acquire, digest-pin
and policy-gate plugin packages exactly like any other artifact, then
materialize them into a user-level, content-addressed plugin store that no
project shares mutably. Version 1 defines no remote plugin _discovery_: a plugin
name resolves to `pkg:opm-plugin/<name>` and nothing else.

Users manage plugins explicitly; nothing installs them by default:

```console
$ opm plugin add acme
$ opm plugin list
$ opm plugin remove acme
$ opmx --plugin acme some-tool
```

The pin record names the plugin id, the exact purl it was acquired from, the
digest of the installed store entry, and the manifest path within it.

## Binding

Projects bind plugins in `opm.toml` without embedding credentials:

```toml
[plugins.dev-example-acme]
store_digest = "sha256:…"
```

The section key MUST equal the manifest `id`. `store_digest` pins the exact
content-addressed store entry; a host MUST refuse a plugin whose materialized
bytes digest differently. User-level pins live outside the project so
`opmx --plugin` works without a project; a project binding MUST reference an
already-installed store entry and never triggers acquisition by itself.

## Execution

The approved executable MUST be standalone and follows the same immutable
snapshot rule as delegated pack providers: before execution, the host copies
bounded bytes from the no-follow approved file into an unnamed immutable
snapshot and hashes that snapshot; the sandbox executes only the private
snapshot path. Sibling modules, relative loader paths, and runtime layouts such
as nvm installations are unsupported. A host MUST fail closed rather than reopen
the configured path or widen the jail, and MUST fail closed when structurally
unnamed snapshot storage is unavailable.

Commands carry literal argument lists only. The host prepends the private
snapshot path and appends the declared arguments; the request document travels
on stdin. A plugin cannot check one binary and then ask the host to execute
another, and cannot influence argv beyond its declared literal arguments.

## Operations

| Operation               | Request params              | Result schema                                                |
| ----------------------- | --------------------------- | ------------------------------------------------------------ |
| `registry-definition`   | `offline`                   | `RegistryDefinition`                                         |
| `identify`              | `query`, `offline`          | array of `PackageIdentity`                                   |
| `enumerate`             | `basePurl`, `offline`       | array of exact purl strings                                  |
| `inspect`               | `exactPurl`, `offline`      | `DelegatedAdapterInspectionResult` (may carry `executables`) |
| `fetch-artifact-record` | `exactPurl`, `offline`      | `DelegatedAdapterRecordResult`                               |
| `snapshot`              | `evaluationTime`, `offline` | `DelegatedAdapterSnapshotResult`                             |

`catalog` capability requires `identify`, `enumerate`, `inspect` and
`fetch-artifact-record`; `snapshot` is optional. The `DelegatedAdapter*` result
schemas are normative `$defs` of `schemas/delegated-adapter.schema.json`:
`DelegatedAdapterInspectionResult.package` reuses `PackageInstance` and
`DelegatedAdapterSnapshotResult` is exactly `SourceSnapshot` from
`schemas/model.schema.json`. A host MUST bound request and response bytes, MUST
reject responses that fail schema validation, and MUST treat nonzero exits,
malformed output, or budget overruns as fail-closed provider errors.

## Artifact bytes

The stdio protocol carries metadata only; artifact bytes never travel through
the plugin. A delegated provider signals host-side byte acquisition with the
provider capability extension `openpacker/artifact-bytes: "host-fetch"`. For
such a provider the `fetch-artifact-record` body MUST carry a sha256 `digest`, a
byte `size`, and at least one `locations[].uri`. The host MUST fetch the bytes
itself over HTTPS without credentials, from an origin it allowlists — the origin
of the record's `endpoint` — MUST resolve the location and refuse private,
loopback, link-local, NAT64, or IPv4-mapped answers unless that origin is
operator-pinned, MUST bound the download by the published `size`, and MUST
verify the sha256 digest before any use. A missing digest, a digest mismatch, an
over-size body, a location outside the allowlisted origin, or an unpinned
private address fails closed. The host MUST NOT attach credentials to the
download. The plugin never proxies artifact bytes; `rawBody` remains the
canonical bytes of the answered body.

## Executables

An `inspect` result MAY carry `executables`, an array of `DelegatedAdapterBin`
declaring the executables the package provides:

- `name` is a single safe path segment matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` —
  never a separator, never empty;
- `path` is a relative POSIX path with `/` separators — never absolute, never
  containing a `..` segment, never a backslash;
- `interpreter` is `node` (the default when absent), `python`, `dotnet`, or
  `native`; `native` means the host executes the verified store file directly;
- `entry` is required if and only if `interpreter` is `python`, in
  `module:callable` form.

A host MUST validate every declaration against these rules before use and MUST
fail closed on anything else.

## Authority

`authority` is a request, not a grant. `network: consent` requires network
consent and is still denied in offline mode. Environment entries name variables
the plugin can use, but the operator must allowlist each name before OPM
forwards its current value. Secret values never belong in either plugin JSON or
`opm.toml`.
