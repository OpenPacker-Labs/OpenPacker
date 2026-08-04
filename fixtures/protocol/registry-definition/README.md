# Registry Definition fixtures

Executable evidence for
[`spec/prex/v1/registry-definition.md`](../../../spec/prex/v1/registry-definition.md).

| File                         | Intent                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| `full-http.json`             | HTTP registry advertising search, enumerate, metadata, artifact, deps |
| `partial-metadata-only.json` | Read-only source: no search, no install                               |
| `cli-only-nix.json`          | Non-HTTP locators (`exec:`, `nix+flake:`) for CLI-backed sources      |
| `nuget-mapped.json`          | NuGet v3 service index mapped into PREX resource types                |

All documents use `registryDefinitionVersion: "1"` and MUST validate against
`registry-definition.schema.json`.
