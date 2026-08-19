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

Projects bind providers without embedding credentials:

```toml
[pack.providers.dev-example-acme]
manifest = ".opm/providers/acme.json"
executable = "/opt/acme/bin/acme-pack"
default_for = ["acme"]
allow_environment = ["ACME_TOKEN"]
```

The section key MUST equal the manifest `id`. Manifest paths are relative to the
project root and may span several segments (`.opm/providers/acme.json`), but
MUST stay contained beneath it: hosts MUST reject absolute paths and `.`/`..`
escapes, and MUST open the manifest with no-follow semantics so a symlinked or
swapped path component fails closed. `executable` MUST be an operator-approved
absolute path and hosts MUST NOT resolve it through `PATH`. `default_for` MUST
be a subset of the manifest's `purlTypes`, and `allow_environment` MUST be a
subset of its declared environment authority.

The approved executable MUST be standalone. Before execution, the host copies
bounded bytes from the no-follow approved file into an unnamed immutable
snapshot and hashes that snapshot. The sandbox copies the snapshot bytes from an
inherited read-only descriptor into a private mode-`0500` executable and
executes only that private path. The configured absolute path remains the
selection and receipt source path; the receipt digest identifies the exact
snapshot bytes that ran. The configured path is not the process `argv[0]` and
its parent directory is not made visible merely because it contains the approved
file.

Consequently, sibling modules and resources, relative loader paths, and runtime
layouts such as nvm installations are unsupported at this boundary. Operators
MUST approve a self-contained executable, bundle, or standalone wrapper instead.
This private-path rule supersedes any earlier expectation that delegated
providers execute with their configured path as `argv[0]`. A host MUST fail
closed rather than reopen that path or widen the jail to satisfy sibling lookup.
It MUST also fail closed when structurally unnamed snapshot storage is
unavailable; creating a named writable temporary executable is not a fallback.

## Templates

Templates are argv or environment values, never shell text. Hosts replace:

- `{projectRoot}`
- `{manifestPath}`
- `{outputDirectory}`
- `{packageName}`
- `{packageVersion}`

Any other brace expression makes the provider invalid. Conditional arguments
cover `allow-build`, `deny-build`, `allow-network` and `offline`; they do not
change the authority declared by the provider.

Manifest commands and cleanup commands carry argument lists only. The compiled
`DelegatedPackHostPlan` preserves that shape; the host prepends the separately
validated top-level executable name for planning and receipts. At execution the
host substitutes the private immutable snapshot path. A provider cannot check
one binary and then ask the host to execute another.

WIT planners receive a canonical `DelegatedPackPlanInput` document from this
schema. Version 1 contains the detected project root and manifest path, explicit
target identity, output directory, and build/network/offline booleans. It never
contains environment values, sandbox controls, or ambient host state.

## Authority

`authority` is a request, not a grant. `build: true` requires build consent.
`network: consent` requires network consent and is still denied in offline mode.
Environment entries name variables the provider can use, but the project must
allowlist each name before OPM forwards its current value. Secret values never
belong in either provider JSON or `opm.toml`.
