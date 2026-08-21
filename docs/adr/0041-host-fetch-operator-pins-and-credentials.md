# 41. Host-fetch operator pins and credentials

Date: 2026-08-20

## Status

Accepted — amends
[0040](0040-delegated-plugins-deliver-artifact-bytes-and-executables.md).
Implementation is stacked (`sdlc/host-fetch-deferred-01` … `07`).

## Context

ADR 0040 shipped host-side artifact bytes
(`openpacker/artifact-bytes: "host-fetch"`) fail-closed: HTTPS, no credentials,
endpoint-origin allowlist, published-size bound, sha256 verification, and DNS
classify plus pin via `OPM_HOST_FETCH_ORIGINS`. The plugin remains a metadata
authority; the host fetches and verifies. That path is live and is not
redesigned here.

Six surfaces were deferred so that stack could ship without inventing project
config, registry auth, or a second transport:

1. Project-level `[plugins.<id>] artifact_origins` (env pin only today).
2. Operator-configured tokens for a _pinned_ origin (registry auth).
3. Tokens, netrc, or ambient cookies for _plugin-named_ URLs (still forbidden).
4. HTTP (non-TLS), including loopback, on the plugin host-fetch path.
5. Letting the plugin expand the pin set (never).
6. DNS-pinning all of `BoundedFetchTransport`, including first-party
   npm/pypi/cargo/oci and `OPM_REGISTRY_*` internal hosts.

This ADR records the decisions for those surfaces. The long form lives in
[`docs/plans/host-fetch-deferred/design.md`](../plans/host-fetch-deferred/design.md).
Per [ADR 0028](0028-amendments-supersede-interpretation.md) this amendment
supersedes ADR 0040's "the host never attaches credentials" to: the host never
attaches credentials _because the plugin asked_; it MAY attach an operator
bearer (and optionally one extra operator-named header) for an origin the
operator pinned **and** named an env var for. The bounded-protocol and
fail-closed invariants of ADR 0039 and ADR 0040 stand.

## Decision

- **D1 — Pin set is a union; `record.endpoint` is not a pin.** For a given
  host-fetch, pin set =
  `parse(OPM_HOST_FETCH_ORIGINS) ∪ binding.artifactOrigins` and allowlist =
  `{endpoint origin} ∪ pins`. Union, not intersection: a committed project pin
  is enough for CI; env is enough for ephemeral `opmx --plugin`. Public
  same-origin unauthenticated GET needs no pin. Authentication still requires a
  pin. `record.endpoint` is not a pin — the plugin naming an origin does not
  grant private-address SSRF. Pin entries are HTTPS origin-form via
  `normalizePinnedOrigin`. Duplicate origins in one list fail closed; they are
  not collapsed.
- **D2 — Bearer only on a pin plus a per-origin env-var _name_.** The host
  attaches `Authorization: Bearer` only when the hop origin is in `pins` **and**
  a per-origin env-var name is set. Secrets live in the process environment;
  `opm.toml`, the lock, and env-pin lists hold names only (for example
  `ACME_ARTIFACTS_TOKEN`). `OPM_HOST_FETCH_BEARER` is **not** a grant unless
  that name is explicitly listed in `artifact_origin_token_envs` or
  `OPM_HOST_FETCH_TOKEN_ENVS`. Env-only pins (`OPM_HOST_FETCH_ORIGINS` without a
  parallel token-env name) are credential-free even if `OPM_HOST_FETCH_BEARER`
  is set in the process. Fail-closed scope is the hop (`UNRESOLVABLE` if the
  named var is unset or empty), not transport construction. Token charset is RFC
  6750 token68; no CR, LF, or NUL. A leading `Bearer ` prefix is rejected, not
  double-prefixed. Pin plus bearer is any-path consent on that origin.
- **D2-H — One extra operator-named header per pinned origin (v1).** Independent
  of Bearer: an origin may have Bearer, the extra header, both, or neither. The
  plugin cannot name headers. The header name is an RFC 7230 token. A denylist
  includes `authorization`, `cookie`, `cookie2`, `proxy-authorization`, `host`,
  `connection`, `transfer-encoding`, `content-length`, `te`, `upgrade`,
  `trailer`, `keep-alive`, `content-type`, and `accept-encoding`. The value is
  read from a named env at the hop; no CR, LF, or NUL; max 4096.
- **D3 — Ambient credentials stay forbidden.** No userinfo, no query or hash, no
  plugin headers, no netrc / npmrc / cookie-jar / IMDS inheritance. Every
  operator- or plugin-supplied URL in errors goes through `redactUrl`.
  `--allow-env` of any `OPM_HOST_FETCH_*` name, or of a token or extra-header
  env name, is refused. Prefix `OPM_HOST_FETCH_` is added to sandbox
  `DENY_PREFIXES` (implementation is later stacked PRs; this records the
  decision).
- **D4 — Plugin host-fetch remains HTTPS-only, including loopback.** The
  operator cannot pin `http://…`. `normalizePinnedOrigin` MUST NOT call
  `normalizeAllowedOrigin` (that helper permits credential-free loopback HTTP).
  First-party `RegistryClient` loopback HTTP is unchanged. There is no
  `rejectUnauthorized: false`.
- **D5 — The plugin never expands the pin set.** Extra `locations[]` are not
  walked. An off-origin URI is `UNSAFE_PATH`. Query or hash on a location is
  `UNSAFE_PATH`.
- **D6 — Opt-in classify-and-pin on the same `fetch`.** `BoundedFetchTransport`
  gains `destinationPolicy: 'classify-and-pin'`. Production pin-mode is undici
  `Agent({ connect: { lookup } })` as dispatcher on the **same** `fetch` — not
  `https.request`. Default remains `'origin-allowlist'` (fixtures and injected
  fetch). `pinnedOrigins` are never inferred from `allowedOrigins`. First-party
  enablement is this stack (later PR) via shared `firstPartyTransport`; OCI via
  `createPinnedFetch`.
- **D6-N — Override drops hardcoded public CDNs.** When `OPM_REGISTRY_*` or a
  named `[registries.<id>]` endpoint overrides the default, do **not** union
  hardcoded public `ARTIFACT_ORIGINS`. Optional `OPM_REGISTRY_<ECO>_ORIGINS` is
  allowlisted, not pinned.
- **Rejected.** `record.endpoint` as a pin; a process-wide bearer; intersection
  of env ∩ toml; HTTP loopback for plugins; plugin-expanded origins;
  `https.request` as the first-party pin stack; inferring pins from
  `allowedOrigins`.

## Consequences

- The plugin remains metadata-only. It never proxies bytes, never names headers,
  and never grants itself a pin, a bearer, or an extra origin.
- Operator pins and per-origin env names are the only grants for private
  origins, extra origins, and credentials.
- Implementation is the remaining stacked PRs 3–7. This record does not change
  `spec/prex/v1/delegated-adapter.md`; present-tense MUST lines for
  `artifact_origins`, bearers, and extra headers wait for the PRs that make
  those sentences true. The host still rejects those toml keys until then.
