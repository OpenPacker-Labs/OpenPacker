# mise backend integration

The hook layout and `BackendListVersions`, `BackendInstall`, and
`BackendExecEnv` contracts follow mise's
[backend plugin development reference](https://mise.jdx.dev/backend-plugin-development.html).
The implementation uses only the documented
[plugin Lua modules](https://mise.jdx.dev/plugin-lua-modules.html).

The Lua backend under [`integrations/mise`](../../integrations/mise) implements
the current mise backend hooks and pins a minimum tested mise version in
`mise.plugin.toml`. It delegates package semantics to PREX and installs only an
immutable descriptor.

## Configuration

Supply a base PURL without a version through the tool's `purl` option, use an
encoded PURL as the tool name, or set `OPENPACKER_TOOL_<ALIAS>_PURL`. Configure
the service with `service_url` or `OPENPACKER_URL`; configure the CLI with
`openpacker_bin` or `OPENPACKER_BIN`. Authentication is an
`auth_token_file`/`OPENPACKER_AUTH_TOKEN_FILE` reference, not an inline token.
Offline mode defaults to true and permits only local file artifact locations;
set the plugin option or `OPENPACKER_OFFLINE=false` for HTTPS retrieval.

## Hook behavior

| Hook                  | Behavior                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BackendListVersions` | Calls PREX enumerate with the current OS/architecture and returns the codec-ordered normalized versions expected by mise                                                    |
| `BackendInstall`      | Calls PREX materialize for an exact PURL, selects a permitted location, checks size and SHA-256, extracts into mise's prefix, and verifies every declared executable exists |
| `BackendExecEnv`      | Reads the installation manifest and exposes only directories containing declared executables on `PATH`                                                                      |

The artifact descriptor must declare portable relative executables in the
`org.openpacker.mise` extension. Absolute, parent, backslash, drive, and empty
paths are rejected. The backend never runs lifecycle scripts and records that in
`.openpacker-mise.json`; the exec hook refuses a manifest without that
invariant.

The deterministic contract harness is
[`integrations/mise/test/contract.test.mjs`](../../integrations/mise/test/contract.test.mjs).
The repository's integration gate exercises it; live mise compatibility is an
explicit pinned-tool job rather than an ambient optional success.

## Local verification

After `npm run build` and with `openpackerd` serving the fixture universe:

```sh
mise plugins link openpacker ./integrations/mise --force
mise ls-remote openpacker:demo
mise install -f openpacker:demo@1.0.0
mise exec openpacker:demo@1.0.0 -- openpacker-demo
```

Set `OPENPACKER_URL`, `OPENPACKER_BIN`, and `OPENPACKER_TOOL_DEMO_PURL` as
described above. The mandatory demo runs these commands in isolated mise
data/cache/config/state directories, checks the pinned `2026.7.13` version,
verifies `.openpacker-mise.json`, and proves no lifecycle script executed. The
lightweight contract check is:

```sh
node --test integrations/mise/test/contract.test.mjs
```
