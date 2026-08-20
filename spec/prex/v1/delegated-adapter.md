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
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
artifact_origin_extra_header_names = ["X-JFrog-Art-Api"]
artifact_origin_extra_header_envs = ["JFROG_API_KEY"]
```

The section key MUST equal the manifest `id`. `store_digest` pins the exact
content-addressed store entry; a host MUST refuse a plugin whose materialized
bytes digest differently. A project binding MAY list `artifact_origins`, an
array of HTTPS origin-form pins (no userinfo, path, query, or hash). Those
origins union with `OPM_HOST_FETCH_ORIGINS` for this plugin's host-fetch
allowlist. Duplicate origins in one list MUST fail closed. A binding MAY list
`artifact_origin_token_envs`, a parallel array of env-var names or empty strings
for those origins; present length MUST equal `artifact_origins`. A binding MAY
list `artifact_origin_extra_header_names` and
`artifact_origin_extra_header_envs`, parallel arrays of one extra header name
(RFC 7230 token or empty) and its env-var name per origin; if either array is
present both MUST be present and length MUST equal `artifact_origins`. Empty
header name `""` means no extra header for that origin. Forbidden header names
include `authorization`, `cookie`, `cookie2`, `proxy-authorization`, `host`, and
hop-by-hop headers; invalid names MUST fail closed at parse. The binding MAY
name origins, env-var names, and extra header names; it MUST NOT carry secret
values and MUST NOT acquire. User-level pins live outside the project so
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
byte `size`, and at least one `locations[].uri`. Location URIs MUST be HTTPS
with no userinfo, query, or hash. The host MUST fetch the bytes itself over
HTTPS, from an origin it allowlists — `{ origin of record.endpoint } ∪ pins`,
where `pins` is `OPM_HOST_FETCH_ORIGINS` union this plugin's `artifact_origins`
— MUST resolve the location and refuse private, loopback, link-local, NAT64, or
IPv4-mapped answers unless that origin is in `pins` (`record.endpoint` is not a
pin), MUST bound the download by the published `size`, and MUST verify the
sha256 digest before any use. The plugin MUST NOT add origins via
`record.endpoint`, extra `locations[]`, or extra body fields. Extra
`locations[]` are not walked. A missing digest, a digest mismatch, an over-size
body, a location outside the allowlisted origin, a location URI with query or
hash, or an unpinned private address fails closed. The host MUST NOT attach
credentials because the plugin asked. The host MAY attach
`Authorization: Bearer` only when the hop origin is in `pins` **and** a
per-origin env-var name is configured (`artifact_origin_token_envs` or
`OPM_HOST_FETCH_TOKEN_ENVS`) **and** that env is set, RFC 6750 token68, with no
leading `Bearer ` prefix. `OPM_HOST_FETCH_BEARER` is not a process-wide grant
unless that name is listed. The host MAY also attach one extra operator-named
header when the hop origin is in `pins` **and** a per-origin extra-header name
and env-var name are configured (`artifact_origin_extra_header_names` /
`artifact_origin_extra_header_envs` or `OPM_HOST_FETCH_HEADER_NAMES` /
`OPM_HOST_FETCH_HEADER_ENVS`) **and** that env is set, printable ASCII with no
CR, LF, or NUL, at most 4096 bytes. Extra header is independent of Bearer: an
origin MAY have Bearer, extra header, both, or neither. The plugin MUST NOT name
headers. The plugin never proxies artifact bytes; `rawBody` remains the
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
