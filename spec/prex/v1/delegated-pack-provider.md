# Delegated pack provider manifest

`DelegatedPackProviderManifest` is the portable configuration for a native
package builder that OPM delegates to. It maps to the `package-build` interface
in `openpacker:prex-adapter@0.1.0`.

Media type: `application/vnd.openpacker.delegated-pack-provider.v1+json`.

The provider is a planner, not an executor. A manifest or WIT guest returns a
`DelegatedPackHostPlan`; the OPM host separately:

1. checks the executable without running it;
2. obtains explicit build, network and environment authority;
3. expands only the schema's closed template vocabulary into argv values;
4. executes every command through the fail-closed package sandbox;
5. accepts only declared artifacts contained beneath the output directory;
6. hashes the resulting bytes and writes the canonical pack receipt.

Provider files are local, explicit project configuration. Version 1 does not
define remote discovery, installation, secret values, shell command strings or
ambient environment inheritance.

## Templates

Templates are argv or environment values, never shell text. Hosts replace:

- `{executable}`
- `{projectRoot}`
- `{manifestPath}`
- `{outputDirectory}`
- `{packageName}`
- `{packageVersion}`

Any other brace expression makes the provider invalid. Conditional arguments
cover `allow-build`, `deny-build`, `allow-network` and `offline`; they do not
change the authority declared by the provider.

## Authority

`authority` is a request, not a grant. `build: true` requires build consent.
`network: consent` requires network consent and is still denied in offline mode.
Environment entries name variables the provider can use, but the project must
allowlist each name before OPM forwards its current value. Secret values never
belong in either provider JSON or `opm.toml`.
