# Host-fetch deferred surfaces

| Field        | Value                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Author**   | OpenPacker maintainers                                                                                                                                                           |
| **Date**     | 2026-08-20                                                                                                                                                                       |
| **Status**   | Draft (rev. 4 — open questions resolved)                                                                                                                                         |
| **Amends**   | [ADR 0040](../../adr/0040-delegated-plugins-deliver-artifact-bytes-and-executables.md), [ADR 0039](../../adr/0039-third-party-ecosystems-arrive-as-delegated-adapter-plugins.md) |
| **Proposed** | ADR 0041 (new), spec `delegated-adapter.md` §Binding / §Artifact bytes                                                                                                           |
| **Code**     | `packages/opm-project/src/registry.ts`, `packages/adapter-core/src/index.ts`, `packages/opm-project/src/toml.ts`                                                                 |

## Overview

Delegated adapter plugins now install and run tools: the plugin answers metadata
over the bounded stdio protocol, and the host downloads artifact bytes itself
(ADR 0040, PRs #109–#114, SSRF repair #117, DNS residual close #119). That path
is live and is **not** redesigned here.

Six surfaces were deferred so the first stack could ship fail-closed without
inventing project config, registry auth, or a second transport:

1. Project-level `[plugins.<id>] artifact_origins` (env pin only today).
2. Operator-configured tokens for a _pinned_ origin (registry auth).
3. Tokens / netrc / ambient cookies for _plugin-named_ URLs (still forbidden).
4. HTTP (non-TLS), including loopback, on the plugin host-fetch path.
5. Letting the plugin expand the pin set (never).
6. DNS-pinning all of `BoundedFetchTransport`, including first-party
   npm/pypi/cargo/oci and `OPM_REGISTRY_*` internal hosts.

This document designs all six. The unifying rule is: **the plugin is a metadata
authority, never a network or credential authority.** Origins that may be
private, origins beyond `record.endpoint`, and any `Authorization` header are
operator grants — named in env and/or `opm.toml` as origin strings and env-var
_names_, never as secrets in lockfiles, PURLs, or `locations[].uri`.

Surface 6 ships in this stack: first-party classify-and-pin uses an **undici
`Agent` connector `lookup`** around the same `fetch` (gzip, HTTP/2, and
env-proxy of that fetch stay). `https.request` is not the first-party stack.
When `OPM_REGISTRY_*` (or a named `[registries.<id>]` endpoint) overrides the
default, hardcoded public `ARTIFACT_ORIGINS` are **not** unioned. Extra operator
headers for pinned origins are a v1 grant.

## Background & Motivation

### Current host-fetch (shipped)

`fetchDelegatedArtifactBytes` in
[`packages/opm-project/src/registry.ts`](../../../packages/opm-project/src/registry.ts)
is the single acquisition funnel for delegated providers (capability
`openpacker/artifact-bytes: "host-fetch"`). It:

- Requires `https:` with no userinfo on `locations[].uri`.
- Restricts the download to `new URL(record.endpoint).origin`.
- Bounds the body by the published `size` via `BoundedFetchTransport`.
- Verifies `sha256` before returning bytes.
- Resolves the hostname (`dns.lookup({ all: true })` or injected `lookup`),
  refuses private / loopback / link-local / NAT64 / IPv4-mapped answers unless
  the origin is in `OPM_HOST_FETCH_ORIGINS`, and in production wraps `fetch`
  with `pinnedHostFetch` → `httpsRequestPinned` so the GET and same-origin
  redirect hops use the classified address.
- Strips `Authorization`, `Cookie`, `Cookie2`, `Proxy-Authorization` from the
  host GET (`stripCredentialHeaders`).
- Treats injected `fetch` as a test seam (skip real DNS); injected `lookup`
  still classifies rebinding.

Operator pin today is **env-only**: `OPM_HOST_FETCH_ORIGINS` (comma-separated
HTTPS origins, no userinfo). Explicitly **not** pins:

- Plugin `record.endpoint` (the plugin names it).
- `[plugins.<id>] store_digest` (store pin, not an origin pin).

`PluginBinding` in
[`packages/opm-project/src/types.ts`](../../../packages/opm-project/src/types.ts)
is still one field:

```ts
export interface PluginBinding {
  storeDigest: string;
}
```

and `parseManifest` refuses unknown plugin fields
(`Unknown plugin field "endpoint"` in
`packages/opm-project/test/opm-project.test.ts`).

First-party production does **not** go through that wrapper. `opm add` / graph
resolve build `BoundedFetchTransport` in `providerForWithDiscovery`
(`packages/opm-project/src/registry.ts` ~L269) with `allowedOrigins` and default
`globalThis.fetch` (undici). `adapters-default` `transportFor` is only used when
that constructor is not supplied (`context.transport` unset). OCI never uses
either: `OciRegistryProvider` + `allowedRegistryOrigins`
(`packages/adapters-default/src/modules.ts` ~L403). `RegistryOptions.fetch` is
forwarded to `catalogFor` but is **not** passed into the L269 transport; today
it is a host-fetch seam (`hostFetchCallOptions`).

### Pain points

| Deferred surface               | Who hits it                                                                    | Today                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Project origin pin             | A committed project whose plugin artifacts live on an internal registry or CDN | Every developer/CI job must export `OPM_HOST_FETCH_ORIGINS`; the pin is not in git                          |
| Registry auth                  | Airgap / private registries that require a bearer token                        | Host-fetch is credential-free; there is no honest header attachment                                         |
| Public DNS + bearer            | An internal registry with a public hostname that still requires auth           | Same-origin public GET needs no pin, so a bearer would never attach unless the origin is _also_ pinned (D2) |
| Ambient credential inheritance | Future auth work                                                               | Node `fetch` / `https.request` do not read netrc today, but nothing _asserts_ that invariant                |
| Loopback HTTP                  | Local plugin-registry fixtures                                                 | Plugin host-fetch is HTTPS-only; first-party `BoundedFetchTransport` already allows loopback HTTP           |
| Plugin-expanded origins        | A plugin that publishes `locations[].uri` on a second host                     | Off-endpoint always `UNSAFE_PATH`; no operator-named CDN split analogous to first-party `ARTIFACT_ORIGINS`  |
| Transport-wide DNS pin         | First-party npm/pypi/cargo/oci and `OPM_REGISTRY_*` internal mirrors           | Classifier/pin lives only in the host-fetch `fetch` wrapper; first-party uses origin-string allowlisting    |

The original host-fetch review already called the project pin: _“If a corporate
private registry must stay reachable, require the operator to pin that origin
(manifest / `opm.toml`) rather than letting each `fetch-artifact-record` pick a
new one.”_ Env was the v1 stand-in so `opmx --plugin` and airgap worked without
a project.

## Goals & Non-Goals

### Goals

- Name allowed artifact origins per plugin in `opm.toml`, composing with
  `OPM_HOST_FETCH_ORIGINS`, without putting secrets in the manifest or lock.
- Attach an operator token to GETs **only** for origins the operator already
  pinned **and** for which they named a token env var; fail closed if that named
  variable is unset or empty at the hop that needs it.
- Keep plugin URLs credential-free forever: no userinfo, no query/hash secrets,
  no plugin-supplied headers, no netrc / `~/.npmrc` / IMDS / cookie-jar
  inheritance — and test that future auth cannot accidentally grow those.
- Keep plugin host-fetch **HTTPS-only**, including loopback. Do not weaken
  production. Preserve first-party loopback HTTP for `RegistryClient` /
  fixtures.
- Make “plugin cannot add origins” a protocol-honesty invariant with tests, not
  a comment.
- Grow `BoundedFetchTransport` with an **opt-in** classify-and-pin mode
  implemented as an undici `Agent` connector `lookup` around the same `fetch`,
  then enable it on first-party production constructors (L269 and
  `transportFor`) without swapping `https.request`.
- Let an operator attach a named extra header (e.g. `X-JFrog-Art-Api`) for a
  pinned origin, env-name only, plugin cannot name headers.
- When `OPM_REGISTRY_*` or a named registry endpoint overrides the default, stop
  unioning hardcoded public `ARTIFACT_ORIGINS`.

### Non-Goals

- Redesigning ADR 0040 host-side bytes, digest/size verification, or the stdio
  protocol.
- Plugin-proxied artifact bytes, or a second HTTP stack beside
  `BoundedFetchTransport`.
- Cookie-based registry auth, mTLS client certs, OAuth device flows,
  query-string tokens, or AWS/GCP/Azure instance-metadata tokens.
- Plugin-named extra headers, or an open-ended header DSL (one extra
  operator-named header per origin in v1).
- Userinfo, query, or hash in URLs as a credential channel.
- HTTP (non-TLS) on the plugin host-fetch path, even on loopback.
- Path allowlists on a pinned origin (pin + bearer is any-path consent).
- A process-wide `OPM_HOST_FETCH_BEARER` that attaches to every pin.
- A require-every-origin-pinned high-security mode (Open Question 1: **no** —
  public endpoint origin remains enough for credential-free GET).
- Changing `apps/openpacker-cli` artifact policy (it already refuses every
  private address with no pin). Sharing `isPrivateAddress` is in scope; adding
  pins to the CLI is not.

## Key Decisions

### D1 — `[plugins.<id>] artifact_origins` is the project pin; env is the process pin; union; missing pin fails closed only where a pin is required

**Decision.** A project binding may name extra HTTPS origins the host may fetch
this plugin’s artifacts from, and which may resolve to private addresses.
`OPM_HOST_FETCH_ORIGINS` remains the process-wide pin (ephemeral
`opmx --plugin`, airgap, local override). For a given host-fetch:

```
pins(pluginId)     = parse(OPM_HOST_FETCH_ORIGINS) ∪ binding(pluginId).artifactOrigins
allowlist          = { origin(record.endpoint) } ∪ pins(pluginId)
private-address OK ⇔ location.origin ∈ pins(pluginId)
```

- Public HTTPS on `record.endpoint` still needs **no** pin for an
  _unauthenticated_ GET (today’s behavior).
- **Authentication is not implied by a public endpoint.** A bearer attaches only
  if `location.origin` is in `pins` _and_ a per-origin token env name exists
  (D2). Operators with a public DNS name and a required token must still pin
  that origin (guide recipe).
- Private / loopback / link-local / NAT64 / mapped answers still need a pin that
  **equals** `location.origin`. `record.endpoint` is not a pin.
- A location whose origin is neither the endpoint nor a pin is `UNSAFE_PATH`,
  even if the address is public. That is how a project names a CDN split.
- Empty `artifact_origins` is valid: public plugins stay pin-free.
- Ephemeral runs have no binding: `pins = parse(OPM_HOST_FETCH_ORIGINS)` only.
- Union, not intersection: a committed project pin is enough for CI; env is
  enough for `opmx --plugin` without a project. Intersection would force every
  CI job to duplicate pins in env. Union still widens _fetch_ authority (R1); it
  does **not** widen _Authorization_ (D2).
- Pin entries are **origin-form HTTPS** via `normalizePinnedOrigin` (D4/D6): no
  userinfo, path `/` or empty, no query, no hash, `https:` only. Duplicate
  origins in one list are `INVALID_MANIFEST` / `INVALID_PROVIDER_ENDPOINT`, not
  collapsed (parallel token arrays cannot survive a collapse).

**Rationale.** First-party ecosystems already split metadata and bytes
(`ARTIFACT_ORIGINS` in `packages/opm-project/src/registry.ts` and
`packages/adapters-default/src/modules.ts`: e.g. PyPI metadata on `pypi.org`,
wheels on `files.pythonhosted.org`). Plugins have no hardcoded CDN list; the
project must name it. Env stays the ephemeral/airgap channel so we do not invent
a user-level policy file beside `plugins.json` (that file is a store index, not
a trust policy).

**Rejected:** making `record.endpoint` a pin (the plugin would then grant itself
private SSRF). **Rejected:** intersection of env ∩ toml (breaks ephemeral and
committed-only CI). **Rejected:** failing closed on a missing pin for public
same-origin unauthenticated GETs (would make every public plugin require
config). **Rejected:** collapsing duplicate origins (breaks parallel
`artifact_origin_token_envs`; `bin_names` / `bin_paths` already fail on length
mismatch without collapsing).

### D2 — Operator tokens attach only to already-pinned origins, from a per-origin env _name_, as `Authorization: Bearer`

**Decision.** Registry auth is an operator grant on a pin **plus** a named env
var, not a property of the plugin URL and not a process-wide bearer.

- Secrets live in the process environment. `opm.toml` and the lock may hold
  **env-var names only**, never token values.
- **Default grant** is `Authorization: Bearer <token>` from a per-origin token
  env name. **Additional grant:** one operator-named extra header per origin
  (D2-H). No `Cookie` / `Cookie2` / `Proxy-Authorization` as either grant. The
  plugin cannot name headers.
- **`OPM_HOST_FETCH_BEARER` is not a grant.** It is not read unless an operator
  explicitly lists that name in `artifact_origin_token_envs` or
  `OPM_HOST_FETCH_TOKEN_ENVS`. Env-only pins (`OPM_HOST_FETCH_ORIGINS` without a
  parallel token-env name) are credential-free even if `OPM_HOST_FETCH_BEARER`
  happens to be set in the process.
- Attachment is evaluated **per hop URL** inside the pin-mode transport, after
  credential stripping, only if `url.origin` is in `pins(pluginId)` **and**
  `tokenEnvNameFor(url.origin)` is a non-empty name.
- **Fail-closed scope is the hop, not transport construction.** A missing token
  for origin B does not block a GET to origin A. Whitespace-only values are
  treated as empty (`trim()` then empty → `UNRESOLVABLE` for that hop).
- Pinning an origin and attaching a bearer is **consent for this plugin to
  request any path on that origin**. There is no path allowlist. Guides show the
  smallest pin set (one origin) when using a bearer.

Config (project):

```toml
[plugins.dev.example.acme-adapter]
store_digest = "sha256:…"
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
```

`artifact_origin_token_envs` is optional. If present, its length MUST equal
`artifact_origins`. Each entry is `^[A-Z_][A-Z0-9_]*$` or `""` (no token for
that origin). Values are **not** interpolated at parse time.

Config (ephemeral / airgap):

```sh
export OPM_HOST_FETCH_ORIGINS=https://artifacts.internal.example
export OPM_HOST_FETCH_TOKEN_ENVS=ACME_ARTIFACTS_TOKEN
# ACME_ARTIFACTS_TOKEN is set from the secret store; do not commit the value.
```

`OPM_HOST_FETCH_TOKEN_ENVS` is a comma-separated parallel list of env-var
**names** for `OPM_HOST_FETCH_ORIGINS`. Both parsers return **ordered
`string[]`**, never a `Set` (today’s `hostFetchPinnedOrigins` is a `Set` and
would desync `envNames[j]`). Duplicate origins are rejected **before** zipping.
`OPM_HOST_FETCH_ORIGINS` splits on comma, trims each slot, and **skips** empty
slots (same as today), then fails closed on duplicates.
`OPM_HOST_FETCH_TOKEN_ENVS` unset, `""`, or whitespace-only is **absent** (every
env pin is credential-free). If present, split on comma and trim each slot
**without skipping** — an empty slot is `""`, not a hole, so `ACME_A,` against
one origin is arity 2 and `INVALID_PROVIDER_ENDPOINT`. Present arity MUST equal
the parsed ORIGINS length (toml parallel-array rule).
`https://a.example,https://b.example` + `ACME_A,` is the empty-second form
(`["ACME_A", ""]`).

**Total function `tokenEnvNameFor(origin)`:**

1. If `origin` appears in this plugin’s `artifact_origins` at index `i` and
   `artifact_origin_token_envs` is present → `names[i]` (may be `""`). Project
   name wins over env even when both pin the same origin; explicit `""`
   suppresses a token (no fallback to `OPM_HOST_FETCH_TOKEN_ENVS` or to
   `OPM_HOST_FETCH_BEARER`).
2. Else if `origin` appears in parsed `OPM_HOST_FETCH_ORIGINS` at index `j` and
   `OPM_HOST_FETCH_TOKEN_ENVS` is present → `envNames[j]` (may be `""`).
3. Else → no name (credential-free GET).

**At the hop whose `url.origin` is `origin`:**

1. `name = tokenEnvNameFor(origin)`. If missing or `""` → no `Authorization`.
2. Else read `process.env[name]`, `trim()`. Unset or empty → `UNRESOLVABLE`,
   message names the env var, never the value. Do not fetch.
3. Else validate the token (below). Invalid → same `UNRESOLVABLE`.
4. Else set `Authorization: Bearer <token>`. If the value already has a
   `Bearer ` prefix, do **not** double-prefix; reject.

**Token charset (before attachment).** After trim, the value MUST match RFC 6750
token68: one or more characters from `A-Za-z0-9-._~+/`, then **zero or more**
trailing `=`. `==` padding is valid; `=` in the middle is not. MUST NOT contain
CR, LF, NUL, SPACE, or other C0 controls. A leading `Bearer ` prefix is
rejected, not double-prefixed. A value that could inject a second header is
refused, not forwarded.

### D2-H — Optional extra operator header on a pinned origin (v1)

**Decision.** Bearer remains the default grant. An operator MAY also attach
**one extra header** per pinned origin. The plugin MUST NOT supply header names
or values.

Project:

```toml
[plugins.dev.example.acme-adapter]
store_digest = "sha256:…"
artifact_origins = ["https://artifacts.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
artifact_origin_extra_header_names = ["X-JFrog-Art-Api"]
artifact_origin_extra_header_envs = ["JFROG_API_KEY"]
```

Ephemeral:

```sh
export OPM_HOST_FETCH_ORIGINS=https://artifacts.internal.example
export OPM_HOST_FETCH_HEADER_NAMES=X-JFrog-Art-Api
export OPM_HOST_FETCH_HEADER_ENVS=JFROG_API_KEY
```

Rules:

- Extra-header arrays, if present, MUST be the same length as `artifact_origins`
  / parsed `OPM_HOST_FETCH_ORIGINS`. Empty name `""` means no extra header for
  that origin. Serialize emits the keys whenever they are present, including
  all-`""` (same presence rule as token envs).
- `tokenEnvNameFor` and `extraHeaderFor` are independent: an origin may have
  Bearer, extra header, both, or neither. Extra header is not a substitute for
  Bearer.
- Header **name** is an RFC 7230 token
  (`^[A-Za-z0-9!#$%&'*+.^_`|~-]+$`), compared case-insensitively to a denylist. Forbidden names: `authorization`, `cookie`, `cookie2`, `proxy-authorization`, `host`, `connection`, `transfer-encoding`, `content-length`, `te`, `upgrade`, `trailer`, `keep-alive`, `content-type`, `accept-encoding`. No CR, LF, NUL, colon, or whitespace in the name (`INVALID_MANIFEST`/`INVALID_PROVIDER_ENDPOINT`
  at parse, never at GET).
- Header **value** is read at the hop from the named env, trimmed. Unset or
  empty → `UNRESOLVABLE` for that hop only (same scope as Bearer). Value MUST
  NOT contain CR, LF, or NUL (header injection). Remaining printable ASCII is
  allowed — JFrog-style API keys are not token68. Max length 4096.
- Attachment is per hop, rebuilt with Bearer:
  `headers = stripSensitive(requestHeaders) ∪ bearer(origin) ∪ extraHeader(origin)`.
- Plugin `locations[].headers` / body `headers` stay ignored (D3/D5).
- `--allow-env` of extra-header env names is refused the same way as token env
  names. Prefix `OPM_HOST_FETCH_` already covers `OPM_HOST_FETCH_HEADER_*`.

**Rejected:** plugin-named headers. **Rejected:** arbitrary header maps in toml.
**Rejected:** using extra-header name `Authorization` to bypass token68.

`LockPackage.source` stores the credential-free URI. Location URIs with query or
hash fail closed as `UNSAFE_PATH` before any GET (D3/Issue 6). Tokens never
enter the lock, a PURL, or `locations[].uri`.

**Rationale.** Mixing “the plugin published an authed location” with “the
operator attached a token” stores secrets in lock `source` URIs and makes
host-fetch a credential oracle. A process-wide bearer on unioned env pins is the
same oracle: `direnv` or a compromised CI image adding `https://evil.example` to
`OPM_HOST_FETCH_ORIGINS` would send the airgap token there. Per-origin **names**
keep fetch-grant (pin) and Authorization-grant (token env name) distinct. Union
still lets env widen where the host may connect; it cannot mint `Authorization`
without a name.

**Rejected:** userinfo / query / hash as credentials. **Rejected:** reading
`~/.npmrc` / netrc. **Rejected:** plugin-supplied `locations[].headers`.
**Rejected:** attaching a token because the plugin named `record.endpoint`.
**Rejected:** `OPM_HOST_FETCH_BEARER` as a process-wide grant (confused deputy
with D1 union). **Rejected:** option (a) (global bearer legal only when the pin
set has exactly one origin) — still auto-attaches to an env-only pin.
**Rejected:** option (b) as “toml names only” — ephemeral airgap needs
`OPM_HOST_FETCH_TOKEN_ENVS`.

### D3 — Ambient credentials for plugin URLs stay forbidden; enforcement is a denylist plus tests, not an honor system

**Decision.** Still forbidden. Future auth (D2) MUST NOT grow a side channel
that inherits:

| Source                                                                      | Enforcement                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL userinfo                                                                | Already `UNSAFE_PATH`; keep                                                                                                                                                                             |
| URL query / hash                                                            | `UNSAFE_PATH` before GET; pin origin-form already forbids query/hash; every thrown message that includes an operator- or plugin-supplied URL uses `redactUrl` (origin + path only), including pin-parse |
| Plugin `locations[]` extra keys                                             | Host ignores any field other than `uri`; never copy into headers. Wire `body` is unconstrained (`"body": true`); extra keys are **not** schema-rejected. A uri-only location `$def` is a follow-up      |
| `~/.netrc`, `~/.npmrc`, `~/.git-credentials`                                | Never open these files on the host-fetch path                                                                                                                                                           |
| Node/undici cookie jar, `credentials: 'include'`                            | Pin-mode uses fetch + undici Agent lookup; never `credentials: 'include'`                                                                                                                               |
| IMDS (`169.254.169.254`, `fd00:ec2::254`, GCP `metadata.google.internal`)   | Address classifier already refuses unless pinned; even if pinned, host-fetch never _fetches_ instance-metadata tokens                                                                                   |
| `HTTP_PROXY` / `HTTPS_PROXY` userinfo                                       | Pin-mode does not parse proxy userinfo; it inherits whatever the wrapped fetch already does. Location URLs still have no userinfo                                                                       |
| AWS env (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_SECRET_ACCESS_KEY`) | Not read. An operator may still _name_ `ACME_ARTIFACTS_TOKEN` explicitly; that is a grant, not inheritance                                                                                              |

`BoundedFetchTransport` `SENSITIVE_HEADERS` becomes one shared set in **both**
modes: `{authorization, cookie, cookie2, proxy-authorization, x-api-key}`.
Pin-mode re-adds only the operator bearer after strip, and only for a hop whose
origin has a token env name.

Sandbox filesystem masks (`.netrc` / `.npmrc` in
`packages/sandbox/src/paths.ts`) stay defense-in-depth for the **plugin
process**; they are not the host-fetch control.

Plugin env is an allowlist (`plugin-host` `resolveEnvironment` does not copy
`process.env`). `isDeniedCredential` in `packages/sandbox/src/env.ts` matches
`_TOKEN` / `_SECRET` / `_AUTH` and prefix `OP_` — it does **not** match `OPM_`.
Add prefix `OPM_HOST_FETCH_` to `DENY_PREFIXES` (covers `OPM_HOST_FETCH_BEARER`,
`OPM_HOST_FETCH_TOKEN_ENVS`, `OPM_HOST_FETCH_ORIGINS`). `--allow-env` of any
`OPM_HOST_FETCH_*` name, or of a name listed in this plugin’s
`artifact_origin_token_envs` / `OPM_HOST_FETCH_TOKEN_ENVS`, is **refused**
(grant does not win). That closes `--allow-env OPM_HOST_FETCH_BEARER` forwarding
the bearer into the plugin.

**Rationale.** Node’s `fetch` does not currently send netrc, so a “we don’t do
that” comment would rot the first time someone swaps in a richer agent.
Query-string tokens (`?token=`, `?access_token=`) would otherwise land in
`LockPackage.source` (`project.ts` writes `source: artifact.uri` verbatim) and
in `UNSAFE_PATH` messages that interpolate `input.uri`.

### D4 — Plugin host-fetch remains HTTPS-only; loopback HTTP stays a first-party/dev fixture privilege

**Decision.** `fetchDelegatedArtifactBytes` keeps refusing non-`https:` and
userinfo, and additionally refuses query and hash (D3). Pin parsers use
`normalizePinnedOrigin`, which is HTTPS-only and **must not** call
`normalizeAllowedOrigin` (that helper permits credential-free loopback HTTP —
`packages/adapter-core/src/index.ts`, test “allows only credential-free loopback
HTTP provider traffic”).

There is no `OPM_HOST_FETCH_ALLOW_LOOPBACK_HTTP`. A plugin that returns
`http://127.0.0.1/…` fails closed; the operator cannot pin `http://…`.
`pinnedOrigins: ['http://127.0.0.1']` throws at transport construction.

First-party `BoundedFetchTransport` / `RegistryClient` loopback HTTP is
unchanged: it is operator-constructed `allowedOrigins`, not plugin metadata.
`OPM_REGISTRY_<ECOSYSTEM>` and `safeRegistryEndpoint` remain HTTPS-only.

**Local plugin artifact hosts need a hostname plus an internal CA**
(`NODE_EXTRA_CA_CERTS`), not an IP-literal gift. `httpsRequestPinned` does not
set `rejectUnauthorized: false` and must not. TLS to `https://127.0.0.1` fails
with stock certs unless the SAN is that literal; named hosts with an operator CA
are the supported airgap path. Current green host-fetch tests inject `fetch` and
never speak TLS — keep it that way for unit tests; do not “fix” IP-literal HTTPS
with certificate disabling.

**Rationale.** A sandboxed plugin with `network: never` that answers
`http://127.0.0.1:1/` is host-side SSRF onto whatever is bound on loopback. The
first-party loopback-HTTP exception exists because the _operator_ constructed
`RegistryClient({ baseUrl: 'http://127.0.0.1:7400' })`.

**Rejected:** `http://127.0.0.1` when pinned. **Rejected:** turning off
first-party loopback HTTP. **Rejected:** `rejectUnauthorized: false`.

### D5 — The plugin never expands the pin set

**Decision.** Never. The pin set is
`OPM_HOST_FETCH_ORIGINS ∪ binding.artifactOrigins`. Nothing a plugin returns —
`record.endpoint`, extra `locations[].uri`, extra body fields, capability
extensions — adds an origin to `pins` or to `allowlist` beyond
`{endpoint origin} ∪ pins`.

Honesty tests (must fail closed **before** any GET), owned by **PR 3** except
the auth/netrc rows which are PR 4/5:

| Plugin answer                                                                    | Operator config         | Result                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint=https://acme.example`, `location=https://evil.example/a`               | no pins                 | `UNSAFE_PATH` (off-allowlist)                                                                                                                                         |
| same, `evil.example` in `artifact_origins`                                       | project pin             | GET allowed (operator named the CDN)                                                                                                                                  |
| `endpoint=https://127.0.0.1`, matching location                                  | no pins                 | `UNSAFE_PATH` (private, unpinned)                                                                                                                                     |
| same                                                                             | pin `https://127.0.0.1` | GET allowed (TLS/SAN is the operator’s problem; unit tests inject `fetch`)                                                                                            |
| `endpoint=https://acme.example` (public), location same origin, DNS → `10.0.0.1` | no pins                 | `UNSAFE_PATH` (rebinding)                                                                                                                                             |
| extra `locations[]` entry on a second origin, first on-endpoint                  | no pins                 | first URI used if on-allowlist; off-origin extra is not consulted (`readArtifactDescriptor` takes the first `uri`). Publishing _only_ an off-origin URI fails closed. |
| body field `headers` / `pins` / `allowedOrigins`                                 | any                     | ignored by `readArtifactDescriptor`; not schema-rejected (`body: true`)                                                                                               |
| `locations[].uri` with `?token=` or `#frag`                                      | any                     | `UNSAFE_PATH`; `LockPackage.source` never written                                                                                                                     |

Keep **one URI, fail closed** — no fallback walk of extra locations.

**Rationale.** If the plugin could add origins, D1’s project pin and D2’s
token-on-pin would be bypassable.

### D6 — `BoundedFetchTransport` classify-and-pin uses an undici `Agent` lookup; first-party production enables it in this stack

**Decision.** Do not invent a second transport. Lift `isPrivateAddress`,
credential stripping, and the production-vs-injected `fetch`/`lookup` seam from
`packages/opm-project/src/registry.ts` into `@openpacker/adapter-core`. Pin-mode
is an undici `Agent` connector `lookup` on the same `fetch`, not
`httpsRequestPinned`. Add:

```ts
export type DestinationPolicy = 'origin-allowlist' | 'classify-and-pin';

export interface BoundedFetchOptions {
  allowedOrigins: readonly string[];
  /** Default: 'origin-allowlist' (today). */
  destinationPolicy?: DestinationPolicy;
  /**
   * Origins that may resolve to private/loopback/link-local/NAT64/mapped
   * addresses. Never inferred from allowedOrigins. Default: empty.
   * Each entry MUST pass normalizePinnedOrigin (HTTPS origin-form).
   */
  pinnedOrigins?: readonly string[];
  /**
   * Origin → env-var *name* (not the secret). Consulted only in
   * classify-and-pin, only when url.origin is in pinnedOrigins, and
   * resolved from process.env at this hop — not at construction.
   */
  pinnedTokenEnvNames?: ReadonlyMap<string, string>;
  /**
   * Origin → { name, envName } for the optional extra header (D2-H).
   * Resolved from process.env at this hop. Name already denylisted at parse.
   */
  pinnedExtraHeaders?: ReadonlyMap<string, { name: string; envName: string }>;
  lookup?: HostLookup;
  fetch?: typeof fetch;
  // existing fields unchanged
}
```

Default `'origin-allowlist'` is only for `RegistryClient` loopback fixtures and
for unit tests that inject `fetch`. Production plugin host-fetch and first-party
registry transports use `'classify-and-pin'`.

**HTTP stack (picked):** pin-mode is **not** `https.request`. It is the same
`this.#fetch` (undici / `globalThis.fetch`) with a per-hop `dispatcher` that is
an `undici.Agent({ connect: { lookup } })` whose `lookup` returns the
already-classified address. Import `Agent` from `node:undici` (Node `^22.13`;
add a direct `undici` dependency only if the resolver cannot see `node:undici`).

| Concern                                | Pin-mode (undici Agent lookup)                   | Silent `https.request` swap (rejected) |
| -------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| DNS                                    | classified + address pinned per hop              | same, but different HTTP stack         |
| TLS                                    | fetch defaults; SNI = original hostname          | `https.request` defaults               |
| Decompression                          | **unchanged** (undici still decompresses)        | none unless reimplemented              |
| HTTP/2                                 | **unchanged** (undici ALPN)                      | no                                     |
| `HTTP(S)_PROXY` / `NODE_USE_ENV_PROXY` | **unchanged** (whatever this fetch already does) | dropped                                |
| Cookies / `credentials`                | never                                            | never                                  |

Injected `fetch` skips the Agent and real DNS unless `lookup` is also injected
(same seam as today). Host-fetch drops `pinnedHostFetch` / `httpsRequestPinned`
in PR 1 in favor of this Agent; plugin downloads **gain** fetch gzip rather than
losing it.

**First-party enablement (this stack, PR 7).** Shared helper
`firstPartyTransport(ecosystem, options)` is the only constructor. Both
`providerForWithDiscovery` ~L269 **and** `transportFor` call it so they cannot
diverge. `options.fetch` / `options.lookup` are passed through (today L269 drops
`fetch`; that seam is added here).

```ts
// packages/opm-project/src/registry.ts — production constructor
function firstPartyTransport(
  ecosystem: string,
  options: RegistryOptions,
): BoundedFetchTransport {
  const endpoint = options.endpoint ?? registryEndpoint(ecosystem);
  const namedOrOverride =
    options.endpoint !== undefined || registryEndpointIsOverride(ecosystem);
  const extra = parseRegistryExtraOrigins(ecosystem); // OPM_REGISTRY_<ECO>_ORIGINS
  const allowed = namedOrOverride
    ? unique([new URL(endpoint).origin, ...extra])
    : unique([
        new URL(endpoint).origin,
        ...(ARTIFACT_ORIGINS[ecosystem] ?? []).map((u) => new URL(u).origin),
        ...extra,
      ]);
  const pinned = namedOrOverride ? [new URL(endpoint).origin] : [];
  return new BoundedFetchTransport({
    allowedOrigins: allowed,
    pinnedOrigins: pinned,
    destinationPolicy: 'classify-and-pin',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
}
```

| Origin source                                          | `allowedOrigins`     | `pinnedOrigins`                                                      |
| ------------------------------------------------------ | -------------------- | -------------------------------------------------------------------- |
| Default public endpoint + hardcoded `ARTIFACT_ORIGINS` | yes                  | **no** (rebinding of `files.pythonhosted.org` → `10.x` fails closed) |
| `OPM_REGISTRY_<ECO>` override                          | override origin only | **yes** (that origin)                                                |
| `[registries.<id>].url` / `options.endpoint`           | that origin only     | **yes**                                                              |
| `OPM_REGISTRY_<ECO>_ORIGINS` extras                    | yes (explicit)       | **no**                                                               |
| Hardcoded `ARTIFACT_ORIGINS` after an override         | **no** (D6-N)        | n/a                                                                  |

**Split-horizon:** `registry.npmjs.org` → `10.x` without an override is
`UNSAFE_PATH` after PR 7. Operators who need that must set
`OPM_REGISTRY_NPM=https://<internal-name>` (the internal name is the pin).
Document in the enablement PR and `docs/guides/opm.md`.

**OCI:** `OciRegistryProvider` does not use `BoundedFetchTransport`; it calls
`fetch` (`packages/oci/src/index.ts` `fetchWithDeadlines`). Same policy via a
shared `createPinnedFetch({ allowedOrigins, pinnedOrigins, fetch, lookup })`
wrapper used as `options.fetch`. Default `registry-1.docker.io` / `ghcr.io`
allowlisted-not-pinned; `OPM_REGISTRY_OCI` override origin is pinned and does
not keep the other default registry. Injected `fetch` in OCI tests stays a stub
(skips DNS).

**`PluginRegistryProvider`:** `OPM_REGISTRY_OPM_PLUGIN` is operator-named —
classify-and-pin, pin that origin, no public CDN list (already single-origin).

**`RegistryClient`:** default constructor stays `'origin-allowlist'` so
`http://127.0.0.1:7400` fixtures keep working. Production callers that already
pass a transport (plugin-store after PR 7) get pin-mode from that transport. Do
not change `RegistryClient`’s loopback HTTP exception.

Inferring pins from `allowedOrigins` remains forbidden. `apps/openpacker-cli`
still imports shared `isPrivateAddress` only.

**Rejected:** `https.request` as the first-party stack (gzip/proxy silent
break). **Rejected:** a second `PinnedFetchTransport` class. **Rejected:**
inferring pins from `allowedOrigins`.

### D6-N — Override drops hardcoded public CDNs

**Decision.** `allowedOriginsFor` today unions the endpoint with
`ARTIFACT_ORIGINS` (e.g. PyPI always allowlists `https://files.pythonhosted.org`
even when `OPM_REGISTRY_PYPI=https://pypi.internal.example`). Named sources
(`options.endpoint`) already allowlist **only** that origin. Apply the same rule
to env overrides:

- **Default** public endpoint: `allowed = {endpoint.origin} ∪ ARTIFACT_ORIGINS`.
- **`OPM_REGISTRY_<ECO>` set or `options.endpoint` set:**
  `allowed = {that origin}` only. Do **not** union `ARTIFACT_ORIGINS`.
- If the operator’s mirror still publishes locations on a public CDN, they name
  it: `OPM_REGISTRY_<ECO>_ORIGINS` (comma-separated HTTPS origin-form,
  `normalizePinnedOrigin`, duplicates fail closed). Those extras are allowlisted
  **not** pinned.

Tests (`packages/opm-project/test/registry.test.ts`):

- Default `allowedOriginsFor('pypi')` contains `https://files.pythonhosted.org`.
- With `OPM_REGISTRY_PYPI=https://pypi.internal.example`, it does **not**.
- With that override plus
  `OPM_REGISTRY_PYPI_ORIGINS=https://files.pythonhosted.org`, the CDN is
  allowlisted and a lookup to `10.0.0.1` still `UNSAFE_PATH`.
- Named `[registries.mirror] url = "https://npm.internal.example"` does not
  allowlist `https://registry.npmjs.org` (already true at L269; keep).

## Proposed Design

### Architecture

```mermaid
flowchart TB
  subgraph operator [Operator grants]
    ENV["OPM_HOST_FETCH_ORIGINS\nOPM_HOST_FETCH_TOKEN_ENVS names"]
    TOML["opm.toml [plugins.id]\nartifact_origins\nartifact_origin_token_envs"]
  end

  subgraph plugin [Plugin - metadata only]
    STDIO["bounded stdio\nfetch-artifact-record"]
    REC["record.endpoint\nlocations[].uri\ndigest + size"]
  end

  subgraph host [Host - packages/opm-project + adapter-core]
    COMPOSE["pins = env ∪ artifact_origins\nallowlist = endpoint ∪ pins"]
    CLASSIFY["classify-and-pin transport\nundici Agent lookup"]
    AUTH["Bearer and/or extra header\niff pin AND named env"]
    VERIFY["size bound + sha256"]
  end

  ENV --> COMPOSE
  TOML --> COMPOSE
  STDIO --> REC
  REC --> COMPOSE
  COMPOSE -->|"origin allowed?"| CLASSIFY
  CLASSIFY -->|"tokenEnvNameFor(origin)?"| AUTH
  AUTH --> VERIFY
  plugin -.->|"cannot add pins\ncannot attach headers"| COMPOSE
```

### Destination decision

```mermaid
flowchart TD
  URI["locations[].uri"] --> HTTPS{"https, no userinfo,\nno query, no hash?"}
  HTTPS -->|no| FAIL1["UNSAFE_PATH\nredactUrl in message"]
  HTTPS -->|yes| ORIGIN{"origin ∈ {endpoint} ∪ pins?"}
  ORIGIN -->|no| FAIL2["UNSAFE_PATH\nplugin cannot expand pins"]
  ORIGIN -->|yes| DNS["lookup all addresses"]
  DNS --> PRIV{"any private / loopback\n/ link-local / NAT64 / mapped?"}
  PRIV -->|no| GET["pinned GET"]
  PRIV -->|yes| PIN{"origin ∈ pins?"}
  PIN -->|no| FAIL3["UNSAFE_PATH\nmissing operator pin"]
  PIN -->|yes| GET
  GET --> TOK{"tokenEnvNameFor(origin)\nnon-empty?"}
  TOK -->|yes, env set, charset OK| AUTH["Authorization: Bearer"]
  TOK -->|yes, unset/empty/bad charset| FAIL4["UNRESOLVABLE this hop\nnames the env var"]
  TOK -->|no name or empty name| PLAIN["credential-free GET"]
  AUTH --> BODY["bound + sha256"]
  PLAIN --> BODY
```

### Sequence: project install vs ephemeral

```mermaid
sequenceDiagram
  participant Op as Operator
  participant CLI as opm / opmx
  participant Bind as PluginBinding
  participant Plug as Plugin stdio
  participant T as BoundedFetchTransport classify-and-pin
  participant Reg as Artifact origin

  alt project opm add
    Op->>Bind: opm.toml artifact_origins + token_env names
    CLI->>Bind: verifyPluginBindings store_digest
    CLI->>Plug: fetch-artifact-record
    Plug-->>CLI: endpoint, locations[].uri, digest, size
    CLI->>CLI: pins = env ∪ artifact_origins
    CLI->>T: request uri, allowed=endpoint∪pins, pinned=pins, token names not values
    T->>T: classify + pin address
    T->>T: rebuild headers; bearer iff tokenEnvNameFor(origin)
    T->>Reg: GET
    Reg-->>T: bytes
    T-->>CLI: bounded body
    CLI->>CLI: sha256 verify, lock.source = credential-free uri
  else ephemeral opmx --plugin
    Op->>CLI: OPM_HOST_FETCH_ORIGINS (+ optional TOKEN_ENVS names)
    CLI->>Plug: fetch-artifact-record
    Plug-->>CLI: endpoint + location
    CLI->>CLI: pins = env only
    CLI->>T: same transport; env-only pin is credential-free without TOKEN_ENVS
  end
```

### Pin composition

| Run                                         | `pluginBindings` on `RegistryOptions` | Pin set                                | Token names                                                                               |
| ------------------------------------------- | ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `opmx --plugin acme pkg:acme/tool`          | absent                                | `OPM_HOST_FETCH_ORIGINS`               | `OPM_HOST_FETCH_TOKEN_ENVS` (optional, parallel)                                          |
| `opm add` / `install` / `sync` in a project | `manifest.plugins`                    | env ∪ that plugin’s `artifact_origins` | toml names win; else env TOKEN_ENVS                                                       |
| First-party `pkg:npm/…` (after PR 7)        | n/a                                   | override / named endpoint origin only  | first-party has no host-fetch token maps; registry auth is out of band for npm/pypi today |

A plugin id is `provider.providerId` (`delegatedAdapterModule` sets this to
`manifest.id`, the same key as `[plugins.<id>]`). Bindings for _other_ plugins
do not pin origins for this fetch.

### `RegistryOptions` plumbing

Today `RegistryOptions` already carries the host-fetch DNS seam (`lookup`) and
the `fetch` test seam (`packages/opm-project/src/registry.ts`). Extend it:

```ts
export interface RegistryOptions {
  // existing: offline, sourceId, endpoint, transport, fetch, lookup, now
  /**
   * Project plugin bindings keyed by manifest id. Host-fetch looks up
   * provider.providerId. Absent on ephemeral runs.
   */
  pluginBindings?: Readonly<Record<string, PluginBinding>>;
}
```

`registryOptionsForEcosystem` copies `manifest.plugins` into `pluginBindings` so
`project.ts` (~L777, ~L1172) and `manifest.ts` (~L83) do not each re-implement
it. `fetchTool` (`ephemeral.ts`) passes nothing; env-only remains.

`fetchDelegatedArtifactBytes` becomes:

```ts
const envPins = parseHostFetchPinnedOrigins(process.env.OPM_HOST_FETCH_ORIGINS);
// ordered string[]; empty ORIGINS slots skipped; duplicates rejected
const envTokenNames = parseParallelTokenEnvNames(
  process.env.OPM_HOST_FETCH_TOKEN_ENVS,
  envPins,
);
// undefined if TOKEN_ENVS unset/blank; else string[] of length envPins.length
// (empty comma slot → "", not skipped)
const binding = input.pluginBindings?.[providerId];
const projectPins = binding?.artifactOrigins ?? [];
const pins = [...new Set([...envPins, ...projectPins])]; // unique allowlist
const allowlist = [endpointOrigin, ...pins];

const tokenEnvNames = mergeTokenEnvNames({
  envPins,
  envTokenNames, // undefined = env TOKEN_ENVS absent
  projectPins,
  projectTokenNames: binding?.artifactOriginTokenEnvs, // undefined = absent
});
// For each origin in pins, compute tokenEnvNameFor(origin) in full
// (project step 1, including "", before env step 2). Insert into the
// Map only if the result is a non-empty name. Do not overlay env names
// and then skip "". Omitting "" is safe only because the hop MUST NOT
// re-run env fallback: get(origin) undefined means no Authorization.

const transport = new BoundedFetchTransport({
  allowedOrigins: allowlist,
  pinnedOrigins: [...pins], // each already normalizePinnedOrigin
  pinnedTokenEnvNames: tokenEnvNames,
  destinationPolicy: 'classify-and-pin',
  maximumBytes: size,
  fetch: input.fetch,
  lookup: input.lookup,
});
```

Do **not** read token _values_ here. Construction succeeds even if
`ACME_B_TOKEN` is unset, as long as this fetch’s URI does not need it. The hop
reads `pinnedTokenEnvNames.get(url.origin)` and treats missing and `""`
identically (no `Authorization`); it never consults `OPM_HOST_FETCH_TOKEN_ENVS`
again.

`providerId` is already on the `CatalogProvider` the caller holds; pass it into
`fetchDelegatedArtifactBytes` from `resolveRegistryArtifact` /
`resolveRegistryArtifactDeferred`.

Location checks before `transport.request`: `https:`, no userinfo, no query, no
hash; origin ∈ allowlist. Map pin-mode
`ProviderError('INVALID_PROVIDER_ENDPOINT')` → `OpmError('UNSAFE_PATH')`
(existing tests). Keep `UPSTREAM_RESPONSE_TOO_LARGE` → `SIZE_MISMATCH`.

Error messages that mention a URL pass it through `redactUrl` = origin +
pathname (drop userinfo, search, hash). That includes pin-parse,
duplicate-origin, and arity errors — not only location GETs. If the string
cannot be parsed as a URL, omit it from the message (do not interpolate the raw
`https://user:secret@…` value).

### TOML subset

The parser is a minimal subset (`[section]`, string/bool/number/array-of-string)
in `packages/opm-project/src/toml.ts`. Parallel string arrays already exist
(`bin_names` / `bin_paths`). Add two optional keys under `[plugins.<id>]`;
unknown keys stay refused.

```toml
[plugins.dev.example.acme-adapter]
store_digest = "sha256:…"
artifact_origins = ["https://artifacts.internal.example", "https://cdn.internal.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN", ""]
```

Validation at parse time (fail closed, `INVALID_MANIFEST`):

- Each `artifact_origins` entry passes `normalizePinnedOrigin` (HTTPS
  origin-form, no userinfo/query/hash, path `/` or empty). Stored as
  `url.origin`.
- **Duplicates are `INVALID_MANIFEST`**, not collapsed.
  (`["https://a", "https://a"]` with `["TOKEN_A", "TOKEN_B"]` has no honest
  winner; the `bin_names` / `bin_paths` parser already fails on length mismatch
  without collapsing.)
- `artifact_origin_token_envs` if present: same length as `artifact_origins`;
  each `""` or `^[A-Z_][A-Z0-9_]*$`. **Absent ≠ present-and-all-empty.**
  `undefined` on the binding means the key was omitted (step 1 of
  `tokenEnvNameFor` does not fire). `[""]` is present and suppresses env
  TOKEN_ENVS for that origin.
- `artifact_origin_extra_header_names` / `_envs` if present: same length as
  `artifact_origins`; names RFC 7230 token or `""`; names denylisted at parse;
  env names `""` or `^[A-Z_][A-Z0-9_]*$`. Same presence rule.
- `store_digest` remains required. Origins remain optional.
- Serialize:
  - `artifact_origins` whenever that array is non-empty.
  - `artifact_origin_token_envs`, `artifact_origin_extra_header_names`, and
    `artifact_origin_extra_header_envs` whenever each field is **present** on
    the binding (`!== undefined`), including all-`""` arrays. Existing manifests
    without the new keys still round-trip without them.

Comment in `parseManifest` that currently says “A binding carries exactly one
fact… No endpoints, no credentials” is updated: the binding may name origins and
env-var names; it still never carries secret values and never acquires.

### `normalizePinnedOrigin` vs `normalizeAllowedOrigin`

```ts
/** HTTPS origin-form only. Used for env pins, toml artifact_origins, and
 *  BoundedFetchOptions.pinnedOrigins. MUST NOT call normalizeAllowedOrigin. */
export function normalizePinnedOrigin(value: string): string {
  let url: URL;
  try {
    url = parseProviderUrl(value);
  } catch {
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      'Pinned origin must be an HTTPS origin',
    ); // do not interpolate the raw string (may contain userinfo)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      `Pinned origin must be an HTTPS origin: ${redactUrl(url)}`,
    );
  return url.origin;
}
```

`normalizeAllowedOrigin` keeps today’s loopback HTTP exception for default mode
`allowedOrigins`. Host-fetch runs every pin through `normalizePinnedOrigin`
**before** constructing the transport, so a hostile or mistaken
`http://127.0.0.1` never becomes a `pinnedOrigins` entry.

### `BoundedFetchTransport` classify-and-pin mode

When `destinationPolicy === 'classify-and-pin'`:

1. `assertAllowedProviderUrl` as today (scheme, no userinfo, origin ∈
   `allowedOrigins`). Plugin path additionally requires `https:` / no query / no
   hash before constructing the transport.
2. Same production/inject seam as `fetchDelegatedArtifactBytes` today
   (`nativeFetch` comparison).
3. `assertPinnedDestination(url, pinnedOrigins, lookup)` — current
   `assertHostFetchDestination` + `refuseUnpinnedPrivateAddress`, moved to
   adapter-core. Throws `ProviderError('INVALID_PROVIDER_ENDPOINT')`. Host-fetch
   maps that to `OpmError('UNSAFE_PATH')`.
4. Call
   `this.#fetch(url, { …, dispatcher: new Agent({ connect: { lookup: pinnedLookup } }) })`
   where `pinnedLookup` returns the classified `{address, family}` for this hop.
   SNI stays the original hostname. Do not set `rejectUnauthorized: false`. Do
   not replace fetch with `https.request`.
5. **Every loop iteration** (initial GET, same-origin 3xx, cross-origin 3xx):
   `headers = stripSensitive(requestHeaders) ∪ bearer(url.origin) ∪ extraHeader(url.origin)`
   where maps are the already-merged `tokenEnvNameFor` / `extraHeaderFor`
   results (hop MUST NOT re-apply env TOKEN_ENVS / HEADER_ENVS). Missing or `""`
   → no that grant. Same-origin 3xx still rebuilds. HTTPS→HTTP is refused
   **before** attaching grants
   (`Provider redirect attempted an HTTPS downgrade`).
6. Redirects stay `redirect: 'manual'`. Each hop repeats 1–5 on the next URL.

Default mode does not call DNS. First-party tests that only stub `fetch` keep
passing. Default mode uses the **same** `SENSITIVE_HEADERS` set as pin-mode
(union of today’s two lists, including `cookie2` and `x-api-key`).

Shared `isPrivateAddress` (and NAT64 / IPv4-mapped helpers) move to
adapter-core. `registry.ts` and `apps/openpacker-cli/src/index.ts` import it.

### First-party enablement (this stack)

See D6 / D6-N. PR 7 switches L269 and `transportFor` to `firstPartyTransport`,
enables classify-and-pin, stops unioning `ARTIFACT_ORIGINS` on override, wraps
OCI fetch, and pins `OPM_REGISTRY_OPM_PLUGIN`. `RegistryClient` default stays
origin-allowlist.

### Spec / ADR

Schema-first applies to **wire** changes. `DelegatedAdapterRecordResult` does
not grow fields. Binding is already specified in prose
(`spec/prex/v1/delegated-adapter.md` §Binding). **Amend the spec in the same PR
as the host that makes the sentence true** (AGENTS.md). Do not land
present-tense MUST lines for `artifact_origins` while `parseManifest` still
throws `Unknown plugin field`.

| Text                                                                                         | Lands with      |
| -------------------------------------------------------------------------------------------- | --------------- |
| ADR 0041 recording D1–D6-N / D2-H                                                            | PR 2            |
| §Binding `artifact_origins`; §Artifact bytes allowlist; plugin MUST NOT add pins; query/hash | PR 3            |
| Operator bearer; 0040 credential sentence superseded                                         | PR 4            |
| Extra operator header grant                                                                  | PR 5            |
| First-party classify-and-pin + CDN narrowing                                                 | PR 7            |
| Help text                                                                                    | implementing PR |

ADR 0041 amends 0040 per ADR 0028. 0040’s “the host never attaches credentials”
is superseded to “the host never attaches credentials _because the plugin
asked_; it MAY attach an operator bearer for an origin the operator pinned
**and** named a token env for.” Bounded-protocol and fail-closed invariants
stand.

No change to `schemas/delegated-adapter.schema.json` is required. `body` stays
unconstrained (`"body": true`); extra location keys are ignored by the host, not
schema-rejected. A uri-only location `$def` with `additionalProperties: false`
is a follow-up.

## API / Interface Changes

### `PluginBinding`

```ts
export interface PluginBinding {
  storeDigest: string;
  /** HTTPS origins this plugin may fetch from in addition to record.endpoint,
   *  and which may resolve private. Never secrets. Unique; origin-form. */
  artifactOrigins?: readonly string[];
  /**
   * Env-var names parallel to artifactOrigins; "" means no token.
   * undefined = key omitted (tokenEnvNameFor step 1 does not fire).
   * Present including `[""]` must serialize so round-trip still suppresses.
   */
  artifactOriginTokenEnvs?: readonly string[];
  /** Extra header names parallel to artifactOrigins; "" means none. */
  artifactOriginExtraHeaderNames?: readonly string[];
  /** Env-var names parallel to extra header names; same presence rule. */
  artifactOriginExtraHeaderEnvs?: readonly string[];
}
```

### `BoundedFetchOptions` (adapter-core)

See D6. Default behavior with only `allowedOrigins` is byte-compatible.
`pinnedTokenEnvNames` holds names, not secrets.

### Env

| Name                          | Role                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPM_HOST_FETCH_ORIGINS`      | Process-wide pin list (existing). Origin-form via `normalizePinnedOrigin`. Duplicates fail closed.                                                                                    |
| `OPM_HOST_FETCH_TOKEN_ENVS`   | Optional parallel **names** (ordered `string[]`). Unset/`""`/whitespace ⇒ absent (env pins credential-free). If present, split+trim, do not skip empty slots, arity = ORIGINS length. |
| `OPM_HOST_FETCH_BEARER`       | **Not a grant.** Harmless if set; used only if listed as a name in TOKEN_ENVS / toml. Denied in plugin env. **Never documented with an example value.**                               |
| `OPM_HOST_FETCH_HEADER_NAMES` | Optional parallel extra-header **names** (D2-H). Same split/arity rules as TOKEN_ENVS.                                                                                                |
| `OPM_HOST_FETCH_HEADER_ENVS`  | Parallel env-var **names** for those extra headers.                                                                                                                                   |
| `OPM_REGISTRY_<ECO>`          | Existing first-party override. After PR 7: pin that origin; do not union `ARTIFACT_ORIGINS`.                                                                                          |
| `OPM_REGISTRY_<ECO>_ORIGINS`  | Optional extra **allowlist** (not pins) when a mirror still needs a named CDN.                                                                                                        |

Docs show names only:

```sh
export OPM_HOST_FETCH_ORIGINS=https://artifacts.internal.example
export OPM_HOST_FETCH_TOKEN_ENVS=ACME_ARTIFACTS_TOKEN
```

To authenticate a public endpoint, pin it anyway:

```toml
artifact_origins = ["https://registry.example"]
artifact_origin_token_envs = ["ACME_ARTIFACTS_TOKEN"]
```

### Errors

| Condition                                                                         | Code                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Off-allowlist origin, userinfo, query, hash, HTTP, private unpinned, empty lookup | `UNSAFE_PATH` (URL redacted)                     |
| Malformed / duplicate pin in env or toml; `http://` pin; TOKEN_ENVS arity         | `INVALID_PROVIDER_ENDPOINT` / `INVALID_MANIFEST` |
| Token env named but unset/empty/bad charset **at this hop**                       | `UNRESOLVABLE` (names the env var)               |
| Size / digest                                                                     | unchanged `SIZE_MISMATCH` / `DIGEST_MISMATCH`    |
| `--allow-env OPM_HOST_FETCH_*` or a host-fetch token/header env name              | fail closed at plugin register (do not forward)  |
| Extra header name denylisted / not a token                                        | `INVALID_MANIFEST` / `INVALID_PROVIDER_ENDPOINT` |

## Data Model Changes

- **`opm.toml`**: optional arrays on `[plugins.<id>]`. No migration: absent keys
  mean “no project pins,” which is today’s meaning. Old manifests parse
  unchanged.
- **`opm.lock.json`**: no new fields. `source` remains a credential-free URI (no
  userinfo, no query, no hash — those locations never fetch). A lock written
  after a tokened fetch is indistinguishable from one written after a public
  fetch except that the URI host is the pinned origin.
- **`plugins.json`**: unchanged. User-level store index is not a pin list.
- **PREX wire / receipts**: unchanged. Mutable locations already sit outside
  identity projections (`spec/prex/v1/canonicalization.md`).
- **Env**: additive (`OPM_HOST_FETCH_TOKEN_ENVS`, `OPM_HOST_FETCH_HEADER_*`,
  `OPM_REGISTRY_<ECO>_ORIGINS`).
- **Sandbox**: `DENY_PREFIXES` gains `OPM_HOST_FETCH_`.

## Alternatives Considered

### A1. Intersection of env ∩ project pins

Every fetch would need both `OPM_HOST_FETCH_ORIGINS` _and_ `artifact_origins`.
Safer against a surprising local env widening a project, but it makes committed
project pins insufficient for CI and makes `opmx --plugin` (no toml) impossible
without a second mechanism. **Rejected** for D1. Union widens fetch only;
Authorization stays name-gated (D2).

### A2. `artifact_origins` only relaxes private-address classification; allowlist stays endpoint-only

Closer to ADR 0040’s “same origin as the record endpoint.” A plugin whose bytes
live on a CDN would have to set `record.endpoint` to the CDN, lying about where
metadata “came from,” or fail. First-party already has a real CDN split.
**Rejected** as dishonest; D1 uses pins as the plugin analogue of
`ARTIFACT_ORIGINS`.

### A3. Plugin-published `locations[].headers` or userinfo, host forwards them

Would put secrets in lock `source` and let a plugin mint an `Authorization`
against any allowlisted origin. **Rejected** (D2/D3). The whole point of
host-fetch is that the plugin does not get a credentialed HTTP client.

### A4. New `PinnedFetchTransport` instead of an opt-in mode

Two redirect/retry/bound implementations. Host-fetch already _is_ a
`BoundedFetchTransport` plus a `fetch` wrapper; growing the transport removes
the wrapper. **Rejected**.

### A5. Allow pinned loopback HTTP for plugin host-fetch

Smaller airgap story (`http://127.0.0.1` without TLS). The plugin names the URL;
plaintext plus a stolen pin is host SSRF onto developer services (metadata,
docker, printers). First-party loopback HTTP already covers operator-constructed
`RegistryClient`. **Rejected** (D4).

### A6. Infer pins from `allowedOrigins` when enabling first-party classify-and-pin

One list, less config. It would pin `https://registry.npmjs.org` and
`https://files.pythonhosted.org`, so a DNS rebinding of those names to RFC1918
would be allowed — the hole classify-and-pin exists to close. **Rejected** (D6).

### A7. Per-origin env naming convention instead of parallel name lists

e.g. `OPM_HOST_FETCH_TOKEN_HTTPS_ARTIFACTS_INTERNAL_EXAMPLE`. No toml change,
but the mangling is error-prone. The repo already names env vars in toml
(`allow_environment = ["ACME_TOKEN"]`). **Rejected** as the primary mechanism;
`artifact_origin_token_envs` / `OPM_HOST_FETCH_TOKEN_ENVS` are the names.

### A8. Process-wide `OPM_HOST_FETCH_BEARER` on every pin (or only when the pin set has size 1)

Option (a) still auto-attaches the airgap token to an env-only pin of
`https://evil.example`. Option (b) without an ephemeral name list strands
`opmx --plugin`. **Rejected** in favor of (c): env-only pins are credential-free
unless a per-origin token env name exists.

### A9. Flag-flip first-party pin-mode via `https.request`

Would drop gzip, HTTP/2, and env proxy on every `opm add`. **Rejected.** This
stack enables first-party classify-and-pin with an undici `Agent` connector
`lookup` so fetch semantics stay (D6). Split-horizon of a _public default_
hostname to RFC1918 becomes `UNSAFE_PATH`; operators set `OPM_REGISTRY_*` to the
internal name.

## Security & Privacy Considerations

### Threat model updates

Extend the **Provider network** row in
[`docs/security/threat-model.md`](../../security/threat-model.md):

| Threat                                                               | Control                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin-named SSRF to private/loopback/IMDS/NAT64                     | Classify + pin; `record.endpoint` is not a pin (already #117/#119)                                                                                                                   |
| Plugin expands origins to a second host                              | Allowlist = endpoint ∪ operator pins; extra locations not walked (D5)                                                                                                                |
| Plugin URL as credential oracle (unpinned host)                      | Tokens only if pin **and** token env name; no userinfo/query/hash; no plugin headers (D2/D3)                                                                                         |
| Env pin + process-wide bearer as credential oracle                   | `OPM_HOST_FETCH_BEARER` is not a grant; env-only pins are credential-free (D2)                                                                                                       |
| Plugin requests `/admin` on a host the operator _did_ pin and authed | **In scope as the grant.** Pin + bearer is any-path consent. Guides: smallest pin set. Non-goal: path allowlists. Honesty test: path `/not-the-artifact` still sends `Authorization` |
| Redirect forwards bearer to another host                             | Manual redirects; every hop rebuilds headers from `tokenEnvNameFor(next)`                                                                                                            |
| Secret in lock / toml / PURL / error text                            | Env values only; toml holds names; locations with query/hash never fetch; `redactUrl` on GET **and** pin-parse errors; unparseable URLs omitted                                      |
| Ambient netrc / npmrc / IMDS / cookies                               | Pin-mode never opens those files or metadata services (D3)                                                                                                                           |
| `--allow-env` leaks host-fetch bearer into the plugin                | `OPM_HOST_FETCH_` denied; token-env names cannot be granted (D3)                                                                                                                     |
| Local env silently widens a project **fetch**                        | Union composition (R1); does not attach Authorization                                                                                                                                |
| Plaintext plugin download                                            | HTTPS-only host-fetch, including loopback (D4)                                                                                                                                       |
| First-party CDN rebinding                                            | Public `ARTIFACT_ORIGINS` allowlisted-not-pinned; override drops them (D6-N); extras are not pins                                                                                    |
| Extra-header name injection                                          | RFC 7230 token + denylist at parse; plugin cannot name headers (D2-H)                                                                                                                |

### AuthN/AuthZ

- Installing a plugin (`opm plugin add`) is not consent to fetch private
  addresses or to send a bearer. Those are separate pins + token env names.
- `--allow-env` / pack-provider `allow_environment` forward env **into the
  plugin process**. Host-fetch tokens are **not** forwarded into the plugin and
  cannot be granted.
- Offline mode (`--offline`, `options.offline`) continues to refuse the network
  before this path runs (`assertOnline`).

### Data handling

- Token values: in-process only, never logged, never in `OpmError.message`.
- Operator- and plugin-supplied URLs in errors always go through `redactUrl`
  (origin + path). Unparseable strings are omitted, not interpolated raw
  (pin-parse of `https://user:secret@host` must not leak the secret).
- Do not echo `OPM_HOST_FETCH_BEARER`, token env contents, or header maps.

## Observability

v1 uses existing fail-closed error codes only. This repo has no shared `debug`
helper in `packages/**/*.ts`; do not invent one here. Do not add a CloudEvent
for the GET (`org.openpacker.artifact.verified` already fires after digest
verification and is a PREX fact, not a transport detail).

Never log `headers`, bearer values, or full URLs with query/hash. If a later PR
adds a debug helper, it lands in the implementing package with that PR’s file
list — not as an unspecified facility.

Alerting is local/operator: a spike of `UNSAFE_PATH` on internal CI is a mis-pin
or a plugin publishing off-origin locations.

## Rollout Plan

Feature flags are not used in this repo; behavior is fail-closed and versioned
by stacked PRs. Default classify-and-pin **off** on `BoundedFetchTransport`
keeps first-party fixtures green.

1. **Foundations (PR 1).** Classifier + pin-mode as undici `Agent` lookup in
   adapter-core; plugin host-fetch consumes it. Map `INVALID_PROVIDER_ENDPOINT`
   → `UNSAFE_PATH`. `normalizePinnedOrigin`. Unified `SENSITIVE_HEADERS`.
   First-party constructors still origin-allowlist until PR 7.
2. **ADR 0041 (PR 2).** Decision record for D1–D6-N / D2-H.
3. **Project pins (PR 3).** `artifact_origins` + spec allowlist + query/hash.
4. **Operator bearer (PR 4).** Token env names + sandbox deny + `--allow-env`
   refusal.
5. **Extra headers (PR 5).** D2-H named extra header grant.
6. **Ambient honesty tests (PR 6).** Netrc/IMDS/cookies (deny already in PR 4).
7. **First-party classify-and-pin + CDN narrowing (PR 7).**
   `firstPartyTransport` at L269 and `transportFor`; `ARTIFACT_ORIGINS` dropped
   on override; OCI `createPinnedFetch`; plugin-store pin.

Rollback: revert the top PR. PR 3 without PR 4 is pins-only. PR 7 revert
restores first-party origin-allowlist without touching plugin host-fetch.

No GitHub Actions. Gates: `npm run agent:check:staged` per commit; package tests
per PR; `npm run verify` before merge of the stack top.

## Risks

| ID  | Severity         | Risk                                                                                   | Mitigation                                                                                                                  |
| --- | ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1  | Medium           | Union composition: a developer’s `OPM_HOST_FETCH_ORIGINS` silently widens **fetch**    | Document; errors name which pin hit; Authorization is not widened (D2)                                                      |
| R2  | Medium (reduced) | Confused-deputy bearer on env pins                                                     | Closed by D2 (c): env-only pins are credential-free without a token env name                                                |
| R3  | Medium           | Split-horizon: public default hostname → RFC1918 fails after PR 7                      | Document; set `OPM_REGISTRY_*` to the internal name (that origin is pinned)                                                 |
| R4  | Low              | Parallel token array length drift or duplicate origins                                 | Fail closed at parse; duplicates rejected not collapsed                                                                     |
| R5  | Low              | Tightening env pin parser to origin-form breaks `OPM_HOST_FETCH_ORIGINS=https://h/foo` | Mention in PR 1 notes; previous code already stored `origin` only                                                           |
| R6  | High if missed   | Token attached because plugin named the origin, not because it was pinned              | Tests: public endpoint + token env set + origin **not** in pins → no `Authorization`; private endpoint without pin → no GET |
| R7  | Medium           | Future “just read npmrc” drive-by                                                      | PR 5 tests open a temp `~/.npmrc` / `.netrc` and assert no `Authorization`                                                  |
| R8  | Low              | Operator still needs a public CDN after override                                       | Name it in `OPM_REGISTRY_<ECO>_ORIGINS` (allowlisted, not pinned)                                                           |
| R9  | Medium           | Pin + bearer is any-path consent on that origin                                        | Guides: smallest pin set; threat row; honesty test `/not-the-artifact`                                                      |
| R10 | Medium           | Header injection via CR/LF in token env                                                | Token68 / C0 reject before attachment (D2)                                                                                  |
| R11 | Low              | `https://127.0.0.1` is not a working TLS airgap                                        | Document hostname + `NODE_EXTRA_CA_CERTS`; no `rejectUnauthorized: false`                                                   |

## Open Questions

1. **Require pin for public same-origin unauthenticated GET?** **Resolved: no.**
   Public endpoint origin remains enough for a credential-free GET. Auth still
   requires a pin (D1/D2).
2. **First-party classify-and-pin HTTP stack?** **Resolved: design and support
   it now.** Pin-mode is an undici `Agent` connector `lookup` around the same
   `fetch` (D6). L269 and `transportFor` share `firstPartyTransport`. OCI uses
   `createPinnedFetch`. `RegistryClient` default stays origin-allowlist for
   loopback fixtures. Split-horizon of a public default hostname to RFC1918
   requires `OPM_REGISTRY_*` naming the internal host.
3. **Arbitrary extra headers?** **Resolved: v1 now.** One extra operator-named
   header per pinned origin (D2-H). Plugin cannot name headers. Denylist + env
   names only.
4. **Narrow `ARTIFACT_ORIGINS` on `OPM_REGISTRY_*`?** **Resolved: yes.**
   Override or named endpoint drops hardcoded public CDNs. Optional
   `OPM_REGISTRY_<ECO>_ORIGINS` is the explicit “CDN still required” allowlist,
   not a pin (D6-N).

Residual (not blocking this stack): CLI pin mechanism; path allowlists;
`OPM_HOST_FETCH_REQUIRE_PIN` profile.

## References

- [`spec/prex/v1/delegated-adapter.md`](../../../spec/prex/v1/delegated-adapter.md)
  §Binding, §Artifact bytes, §Authority
- [`docs/adr/0040-delegated-plugins-deliver-artifact-bytes-and-executables.md`](../../adr/0040-delegated-plugins-deliver-artifact-bytes-and-executables.md)
- [`docs/adr/0039-third-party-ecosystems-arrive-as-delegated-adapter-plugins.md`](../../adr/0039-third-party-ecosystems-arrive-as-delegated-adapter-plugins.md)
- [`docs/adr/0028-amendments-supersede-interpretation.md`](../../adr/0028-amendments-supersede-interpretation.md)
- [`docs/guides/opm.md`](../../guides/opm.md) plugin section
- [`docs/security/threat-model.md`](../../security/threat-model.md) Provider
  network row
- [`docs/integrations/provider-authoring.md`](../../integrations/provider-authoring.md)
  `BoundedFetchTransport` origins
- [`packages/opm-project/src/registry.ts`](../../../packages/opm-project/src/registry.ts)
  — `fetchDelegatedArtifactBytes`, `hostFetchPinnedOrigins`,
  `assertHostFetchDestination`, `pinnedHostFetch`, `httpsRequestPinned`,
  `stripCredentialHeaders`, `allowedOriginsFor`, `registryEndpoint`,
  `providerForWithDiscovery` ~L269
- [`packages/adapter-core/src/index.ts`](../../../packages/adapter-core/src/index.ts)
  — `BoundedFetchTransport`, `assertAllowedProviderUrl`,
  `normalizeAllowedOrigin`, `SENSITIVE_HEADERS`, loopback HTTP
- [`packages/opm-project/src/toml.ts`](../../../packages/opm-project/src/toml.ts)
  — `[plugins.<id>]` parse/serialize
- [`packages/opm-project/src/types.ts`](../../../packages/opm-project/src/types.ts)
  — `PluginBinding`
- [`packages/opm-project/test/host-fetch.test.ts`](../../../packages/opm-project/test/host-fetch.test.ts)
- [`packages/adapters-default/src/modules.ts`](../../../packages/adapters-default/src/modules.ts)
  — `transportFor`, `OPM_REGISTRY_*`, `ARTIFACT_ORIGINS`, `OciRegistryProvider`
- [`packages/plugin-store/src/registry.ts`](../../../packages/plugin-store/src/registry.ts)
  — `OPM_REGISTRY_OPM_PLUGIN`
- [`packages/registry-client/src/index.ts`](../../../packages/registry-client/src/index.ts)
  — loopback HTTP `RegistryClient`
- [`packages/plugin-host/src/register.ts`](../../../packages/plugin-host/src/register.ts)
  — `verifyPluginBindings`, `resolveEnvironment`
- [`packages/plugin-host/src/module.ts`](../../../packages/plugin-host/src/module.ts)
  — `openpacker/artifact-bytes: host-fetch`
- [`apps/openpacker-cli/src/index.ts`](../../../apps/openpacker-cli/src/index.ts)
  — `pinnedHttpsStream`, `isPrivateAddress`
- [`packages/sandbox/src/env.ts`](../../../packages/sandbox/src/env.ts) —
  `isDeniedCredential`, `DENY_EXACT` / `DENY_PREFIXES` (plugin process)
- [`packages/sandbox/src/paths.ts`](../../../packages/sandbox/src/paths.ts) —
  `.netrc` / `.npmrc` masks
- Pack-provider env-name pattern:
  [`spec/prex/v1/delegated-pack-provider.md`](../../../spec/prex/v1/delegated-pack-provider.md)
  `allow_environment`
- Shipped stack: PRs #109–#114, review repair #117, DNS residual #119
- [`docs/plans/plugin-execution/sdlc-state.md`](../plugin-execution/sdlc-state.md)

## PR Plan

Stacked, bottom-up, independently reviewable. Each PR is mergeable on its own
gates; later PRs depend on earlier ones. No GitHub Actions; local
`npm run agent:check` / package tests per PR; `npm run verify` before stack-top
merge.

### PR 1 — Extract classify-and-pin into `BoundedFetchTransport` (opt-in)

- **Title:** `feat(adapter-core): opt-in classify-and-pin destination policy`
- **Depends on:** none
- **Files:**
  - `packages/adapter-core/src/index.ts` (and tests
    `packages/adapter-core/src/index.test.ts`)
  - `packages/opm-project/src/registry.ts` (host-fetch consumes pin-mode; delete
    `pinnedHostFetch` / duplicate `isPrivateAddress` if fully replaced)
  - `packages/opm-project/test/host-fetch.test.ts` (behavior preserved)
  - `apps/openpacker-cli/src/index.ts` (import shared `isPrivateAddress` only)
- **Description:** Move `isPrivateAddress`, NAT64/mapped helpers, unified
  `SENSITIVE_HEADERS`, and the native-vs-injected `fetch`/`lookup` seam into
  adapter-core. Pin-mode uses `node:undici` `Agent({ connect: { lookup } })` as
  `dispatcher` on the same `fetch` — **not** `https.request`. Delete
  `pinnedHostFetch` / `httpsRequestPinned` from `registry.ts`. Add
  `destinationPolicy` (default `'origin-allowlist'`), `normalizePinnedOrigin`,
  `redactUrl`. Host-fetch uses pin-mode with env pins. Map
  `INVALID_PROVIDER_ENDPOINT` → `UNSAFE_PATH`. No tokens, no toml, no L269
  destinationPolicy change. Tests: existing host-fetch vectors; pin-mode
  rebinding; gzip still applied if the stub/fetch would (Agent path does not
  strip `content-encoding`); `http://127.0.0.1` pin throws; default mode does
  not call DNS.

### PR 2 — ADR 0041 decision record

- **Title:** `docs(adr): 0041 host-fetch operator pins and credentials`
- **Depends on:** PR 1 (classify-and-pin is a real name)
- **Files:**
  - `docs/adr/0041-host-fetch-operator-pins-and-credentials.md` (new;
    amends 0040)
  - `docs/adr/0040-*.md` status line, `docs/adr/README.md`
- **Description:** Record D1–D6-N and D2-H. Status: accepted, implementation
  stacked. **Do not** amend `delegated-adapter.md` MUST lines for
  `artifact_origins` or bearers yet (host still rejects those toml keys). **Do
  not** change `apps/openpacker-cli/src/opm.ts` help. No example secret values.

### PR 3 — `[plugins.<id>] artifact_origins` parse and pin composition

- **Title:** `feat(opm-project): project artifact_origins union env pins`
- **Depends on:** PR 1, PR 2
- **Files:**
  - `spec/prex/v1/delegated-adapter.md` §Binding + §Artifact bytes allowlist /
    no plugin pin expansion / query-hash / HTTPS-only
  - `packages/opm-project/src/types.ts` (`PluginBinding.artifactOrigins` only)
  - `packages/opm-project/src/toml.ts` parse/serialize + tests in
    `packages/opm-project/test/opm-project.test.ts`
  - `packages/opm-project/src/registry.ts` (`RegistryOptions.pluginBindings`,
    allowlist = endpoint ∪ pins, query/hash refuse, `redactUrl`)
  - `packages/opm-project/test/host-fetch.test.ts` (D5 table except auth rows)
  - `packages/plugin-host/src/register.ts` only if the binding type flows
    through `verifyPluginBindings` (digest check unchanged)
  - `apps/openpacker-cli/src/opm.ts` help for `artifact_origins` (not token envs
    yet)
  - `apps/openpacker-cli/test/opm.test.ts` project fixture with
    `artifact_origins`
  - `docs/guides/opm.md` pin composition (env ∪ toml; public same-origin still
    pin-free for unauthenticated GET)
- **Description:** Implement D1 and D5. Ephemeral = env only. Project = env ∪
  binding. Duplicate origins `INVALID_MANIFEST`. Off-origin location fails
  closed unless pinned. Private same-origin still needs a pin. Plugin extra
  locations are not walked. `locations[].uri` with query/hash is `UNSAFE_PATH`;
  lock `source` is never written for those. Missing pin does _not_ fail public
  same-origin unauthenticated GET.

### PR 4 — Operator bearer for pinned origins

- **Title:** `feat(opm-project): bearer token for pinned host-fetch origins`
- **Depends on:** PR 3
- **Files:**
  - `spec/prex/v1/delegated-adapter.md` §Artifact bytes bearer sentences; ADR
    0040 “never attaches credentials” superseded in 0041 if not already
  - `packages/adapter-core/src/index.ts` (`pinnedTokenEnvNames`; per-hop header
    rebuild)
  - `packages/adapter-core/src/index.test.ts` (A→B different tokens; A pinned →
    B unpinned allowlisted → no `Authorization`; HTTPS→HTTP refused before
    bearer; same-origin 3xx rebuilds)
  - `packages/opm-project/src/toml.ts` / `types.ts`
    (`artifact_origin_token_envs`; serialize emits the key whenever present,
    including `[""]`)
  - `packages/opm-project/src/registry.ts` (`tokenEnvNameFor`,
    `mergeTokenEnvNames` computes the full function then inserts non-empty names
    only, hop-scoped `UNRESOLVABLE`, RFC 6750 token68, ordered
    ORIGINS/TOKEN_ENVS parsers)
  - `packages/opm-project/test/host-fetch.test.ts`
  - `packages/opm-project/src/lock.ts` — no field changes; test that `source`
    has no userinfo / query / hash after an authed fetch
  - `packages/sandbox/src/env.ts` (`OPM_HOST_FETCH_` on `DENY_PREFIXES`)
  - `packages/sandbox/src/index.test.ts` / `escape.test.ts` as needed
  - `packages/plugin-host/src/register.ts` + tests: refuse `--allow-env` of
    `OPM_HOST_FETCH_*` **and** of every name in this run’s
    `artifact_origin_token_envs` **and** `OPM_HOST_FETCH_TOKEN_ENVS` (grant must
    not win)
  - `docs/guides/opm.md` (env **names** only; recipe: pin even if public to
    authenticate; smallest pin set when using a bearer)
  - `apps/openpacker-cli/src/opm.ts` help for `artifact_origin_token_envs` /
    `OPM_HOST_FETCH_TOKEN_ENVS`
- **Description:** Implement D2. Attach `Authorization: Bearer` only when
  `tokenEnvNameFor(url.origin)` is a non-empty name **and** that env is set,
  trimmed, and RFC 6750 token68 (`1*(unreserved / "+" / "/") *"="`).
  `mergeTokenEnvNames` runs `tokenEnvNameFor` in full per origin (project `""`
  before env names) and inserts only non-empty results; the hop never re-applies
  env fallback. Resolve values at the hop, not at construction. Explicit `""` →
  no `Authorization`. **Suppression test:** toml
  `artifact_origins = ["https://a.example"]` +
  `artifact_origin_token_envs = [""]` + env
  `OPM_HOST_FETCH_ORIGINS=https://a.example` +
  `OPM_HOST_FETCH_TOKEN_ENVS=ACME_TOKEN` + that env set → GET has no
  `Authorization`. **Round-trip test:** `[""]` survives serialize → parse and
  still suppresses. Env-only pin + `OPM_HOST_FETCH_BEARER` set but **not** named
  in TOKEN_ENVS → no `Authorization`. Public endpoint + token env set + origin
  not in pins → no `Authorization`. Two toml origins, second `""` → second GET
  has no `Authorization`. Unset named env for origin B does not fail a GET to
  origin A. Path `/not-the-artifact` on a pinned authed origin still sends
  `Authorization` (expected). Lock `source` stays a credential-free URI. **This
  PR is not mergeable without the sandbox deny and `--allow-env` refusal** —
  current `scrubEnvironment` copies granted keys before the denylist.

### PR 5 — Extra operator header on pinned origins

- **Title:**
  `feat(opm-project): extra host-fetch header grant for pinned origins`
- **Depends on:** PR 4
- **Files:**
  - `spec/prex/v1/delegated-adapter.md` §Artifact bytes extra-header sentence
  - `packages/opm-project/src/types.ts` / `toml.ts`
    (`artifact_origin_extra_header_names` / `_envs`)
  - `packages/adapter-core/src/index.ts` (`pinnedExtraHeaders`; hop rebuild)
  - `packages/opm-project/src/registry.ts` (`extraHeaderFor`, env
    `OPM_HOST_FETCH_HEADER_NAMES` / `_ENVS`)
  - `packages/opm-project/test/host-fetch.test.ts`
  - `packages/plugin-host/src/register.ts` — extend `--allow-env` refusal to
    extra-header env names (grant must not win)
  - `docs/guides/opm.md` (names only; example header name `X-JFrog-Art-Api`, no
    example secret values)
- **Description:** Implement D2-H. Header name RFC 7230 token + denylist at
  parse (`authorization` / `cookie` / hop-by-hop refused). Value: no CR/LF/NUL,
  hop-scoped `UNRESOLVABLE` if named env unset. Plugin cannot name headers.
  Tests: extra header only on pinned origin; name `Cookie` refused; CR in value
  refused; plugin body `headers` ignored; both Bearer and extra header on one
  origin; `""` name suppresses; serialize round-trip of all-`""`.

### PR 6 — Ambient-credential prohibition and HTTPS-only honesty tests

- **Title:**
  `test(opm-project): host-fetch never inherits netrc, npmrc, IMDS, cookies`
- **Depends on:** PR 5
- **Files:**
  - `packages/opm-project/test/host-fetch.test.ts`
  - `packages/adapter-core/src/index.test.ts`
- **Description:** Remaining D3/D4 honesty tests. Deny / `--allow-env` already
  in PR 4–5. Cases: temp `~/.netrc` / `~/.npmrc`; userinfo and `?token=`
  `UNSAFE_PATH` with `redactUrl`; extra body `headers` ignored; `http://`
  location; no cookie jar; IMDS not fetched; loopback HTTP default-mode still
  works.

### PR 7 — First-party classify-and-pin and CDN narrowing

- **Title:**
  `feat(opm-project): classify-and-pin first-party registries; drop CDNs on override`
- **Depends on:** PR 1 (Agent pin-mode), PR 6 (plugin path complete)
- **Files:**
  - `packages/opm-project/src/registry.ts` (`firstPartyTransport`,
    `allowedOriginsFor`, `OPM_REGISTRY_<ECO>_ORIGINS`, L269 passes
    `fetch`/`lookup`)
  - `packages/opm-project/test/registry.test.ts`
  - `packages/adapters-default/src/modules.ts` (`transportFor` calls the shared
    helper; OCI `createPinnedFetch`)
  - `packages/oci/src/provider.ts` / `index.ts` (wrap default fetch)
  - `packages/plugin-store/src/registry.ts` (pin `OPM_REGISTRY_OPM_PLUGIN`)
  - `docs/guides/opm.md` (split-horizon; override drops public CDNs; `_ORIGINS`
    extras)
  - `docs/integrations/provider-authoring.md`
- **Description:** Enable `'classify-and-pin'` on production first-party
  transports via undici Agent lookup (already in PR 1). Default public
  `ARTIFACT_ORIGINS` allowlisted-not-pinned. `OPM_REGISTRY_*` or named
  `options.endpoint` → allowlist that origin only, pin it, **do not** union
  hardcoded CDNs. `OPM_REGISTRY_PYPI_ORIGINS=https://files.pythonhosted.org`
  re-allowlists that CDN without pinning. Tests: default pypi includes
  pythonhosted; override does not; extra ORIGINS allowlisted; extra ORIGINS
  rebinding to `10.0.0.1` is `UNSAFE_PATH`; named toml registry does not include
  npmjs.org. OCI default registries unpinned; `OPM_REGISTRY_OCI` pins the
  override and drops `ghcr.io`. `RegistryClient` default remains
  origin-allowlist. Injected `fetch` still skips DNS.

**Out of this stack:** CLI pin mechanism, `RegistryClient` default pin-mode,
`OPM_HOST_FETCH_REQUIRE_PIN`, `rejectUnauthorized: false`, path allowlists,
process-wide bearer auto-attach, plugin-named headers.
