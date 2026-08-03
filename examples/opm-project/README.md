# Example: `opm` project

Minimal project using the **Open Package Manager** CLI.

## Run offline

From the repo root (after `npm run build`):

```sh
cd examples/opm-project
node ../../apps/opm/dist/opm.js sync --offline
node ../../apps/opm/dist/opm.js list
node ../../apps/opm/dist/opmx.js demo-tool --version
node ../../apps/opm/dist/opmx.js demo-tool hello from opm
```

Or with linked bins:

```sh
npm link -w @openpacker/opm
cd examples/opm-project
opm sync --offline
opmx demo-tool --version
```

## Files

| File            | Role                                                         |
| --------------- | ------------------------------------------------------------ |
| `opm.toml`      | Declares `demo-tool` with a file source into `fixtures/opm/` |
| `opm.lock.json` | Written by `opm sync`                                        |
| `.opm/`         | Local store + bins (created on sync)                         |

See **[docs/guides/opm.md](../../docs/guides/opm.md)** for the full command
reference.
