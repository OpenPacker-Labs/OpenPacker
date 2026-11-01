# CLI examples

Ready-made inputs for the OpenPacker package CLI. Full recipes:
**[docs/guides/opm.md](../../docs/guides/opm.md#prex-control-plane)**.

## Prerequisites

```sh
npm ci && npm run build
npx opm serve --universe fixtures/epoch/universe.json --port 7337 &
export OPENPACKER_URL=http://127.0.0.1:7337
```

## Commands

```sh
# Canonicalize
npx opm normalize --input examples/cli/normalize.json --json

# Find package
npx opm identify 'pkg:npm/%40openpacker/demo-tool' --json

# List versions
npx opm enumerate 'pkg:npm/%40openpacker/demo-tool' --json

# Inspect
npx opm inspect 'pkg:npm/%40openpacker/demo-tool@1.1.0' --json

# Import native locks (fixtures in-repo)
npx opm import-lock --input fixtures/locks/cargo/Cargo.lock --json \
  --output /tmp/cargo-import.json
npx opm import-lock --input fixtures/locks/npm/package-lock.json --json \
  --output /tmp/npm-import.json

# Pull selected pins from import output
jq '.lockfile.selectedExactPurls' /tmp/cargo-import.json
```

## Files

| File             | Used by                          |
| ---------------- | -------------------------------- |
| `normalize.json` | `openpacker normalize --input …` |
| `identify.json`  | `openpacker identify --input …`  |
| `enumerate.json` | `openpacker enumerate --input …` |
| `inspect.json`   | `openpacker inspect --input …`   |
