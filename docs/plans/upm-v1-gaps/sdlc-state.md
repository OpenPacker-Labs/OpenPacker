# sdlc-state: upm-v1-gaps

- **Initiative:** Rescoped UPM v1 gaps (Maven stock inspect, provider e2e
  oracles, real `opm update`, optional shared blob CAS, PREX publish/yank,
  `opm auth` env names, WIT honesty)
- **Phase:** dispatch
- **Trunk:** main
- **Instruction:** [`swarm-instruction.md`](swarm-instruction.md)
  (self-contained one-shot swarm prompt; no phases)
- **Decisions:** [ADR 0042](../../adr/0042-upm-v1-gaps.md). Binding critique in
  the instruction §2. Refuse wasmtime WIT host, opm workspaces, native-registry
  publish, OIDC/device-flow login, host-fetch residual pins.

## Dispatch (one wave, exclusive ownership)

| Swarm           | Branch                               | Status                       |
| --------------- | ------------------------------------ | ---------------------------- |
| M Maven inspect | `sdlc/upm-v1-gaps-01-maven-inspect`  | spawning                     |
| P PyPI oracles  | `sdlc/upm-v1-gaps-02-pypi-oracles`   | squash-merged #138 `2e8e6b7` |
| G Go oracles    | `sdlc/upm-v1-gaps-03-golang-oracles` | squash-merged #139 `cf29543` |
| U Update        | `sdlc/upm-v1-gaps-04-update`         | spawning                     |
| C Shared CAS    | `sdlc/upm-v1-gaps-05-shared-cas`     | spawning                     |
| R Publish/yank  | `sdlc/upm-v1-gaps-06-publish-yank`   | spawning                     |
| A Auth          | `sdlc/upm-v1-gaps-07-auth`           | spawning                     |
| W WIT honesty   | `sdlc/upm-v1-gaps-08-wit-honesty`    | squash-merged #137 `2dd2c93` |

Independent PRs from `main` (ownership is disjoint). Reviewer per implementer on
handback. Merge on local `npm run verify` + reviewer pass; GHA never runs.

## Residuals (explicitly out of this initiative)

WIT wasmtime host; `[workspace]` in `opm.toml`; `opm login` / OIDC;
npmjs/PyPI/crates publish; `OPM_HOST_FETCH_REQUIRE_PIN` / path allowlists /
`rejectUnauthorized: false`.
