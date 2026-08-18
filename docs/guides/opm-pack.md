# Packing with `opm`

`opm pack` writes target-native package files and `opm-pack-receipt.json`.
Standardized packing is the default and does not need the target package manager
installed:

```sh
opm pack npm --package-version 1.2.3
opm pack cargo --package-version 1.2.3 --output ./dist
opm pack oci --package-version 1.2.3 --os linux --arch amd64
```

The target distribution is explicit: the positional ecosystem selects the
format, the project name supplies its native identifier unless `--name` is
given, and `--package-version` supplies its version. OCI additionally requires
an OS and architecture; OpenPacker does not guess a platform.

| Target     | Standard output                |
| ---------- | ------------------------------ |
| npm        | `.tgz`                         |
| Cargo      | `.crate`                       |
| PyPI       | source `.tar.gz`               |
| NuGet      | `.nupkg`                       |
| Maven      | `.jar`                         |
| Go         | module `.zip`, `.mod`, `.info` |
| OCI        | OCI image-layout `.tar`        |
| Nix        | `.nar`                         |
| Debian/APT | `.deb`                         |
| WinGet     | validated YAML manifest set    |
| Chocolatey | `.nupkg`                       |

Native delegation is provider-driven; OPM contains no package-manager command
table. Add a local
[provider manifest](../../spec/prex/v1/delegated-pack-provider.md) and select it
from `opm.toml`:

```toml
[pack.providers.dev-example-acme]
manifest = ".opm/providers/acme.json"
default_for = ["acme"]
allow_environment = ["ACME_TOKEN"]
```

The key must equal the provider manifest's `id`. `default_for` is optional; use
`--provider` when several providers support one PURL type:

```sh
opm pack acme --package-version 1.2.3 --provider dev-example-acme --allow-build --offline
```

Provider manifests map to the standard `package-build` WIT plan interface; the
host retains execution authority. Native compilation or project-controlled
lifecycle execution requires `--allow-build`; network access independently
requires `--allow-network`, and `--offline` wins when both are present. Only
environment names declared by the provider and allowlisted in `opm.toml` are
forwarded. All commands run through the fail-closed package sandbox.

Internally, OpenPacker captures a bounded project tree and OCI-shaped config and
layer model. That normalized representation is not a user workflow. The receipt
records its canonical digest, the chosen target and tool, sandbox enforcement,
semantic loss, and digests over the exact native files written.

## Pack parity tests

`npm run test:pack-parity` runs the mandatory offline format oracles for npm,
Cargo, pip/uv, NuGet, Maven, Go, OCI/Docker/Podman, Nix, APT/dpkg, WinGet,
Chocolatey, and the mise integration contract. It never invokes a host package
manager.

Native acceptance is an explicit platform lane:

```sh
OPENPACKER_NATIVE_PACK_PARITY=linux npm run test:pack-parity:native
OPENPACKER_NATIVE_PACK_PARITY=windows npm run test:pack-parity:native
```

Set `OPENPACKER_PARITY_RUNTIME` to `docker` or `podman` (Docker is the default),
and provide digest-pinned, already-loaded images through
`OPENPACKER_PARITY_<NPM|CARGO|PIP|UV|NUGET|MAVEN|GO|OCI|NIX|APT>_IMAGE` on Linux
or `OPENPACKER_PARITY_<WINGET|CHOCOLATEY>_IMAGE` on Windows. The harness refuses
mutable tags and image pulls. Linux containers have no network, capabilities,
privilege escalation, writable root, or host socket; Windows uses Docker Hyper-V
isolation with a storage-capped writable layer. Artifacts are mounted read-only,
scratch space is bounded, and timed-out containers are forcibly removed by name.
