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

| Target     | Standard output                | Delegate tools         |
| ---------- | ------------------------------ | ---------------------- |
| npm        | `.tgz`                         | npm, mise              |
| Cargo      | `.crate`                       | cargo, mise            |
| PyPI       | source `.tar.gz`               | uv, Python build, mise |
| NuGet      | `.nupkg`                       | dotnet, NuGet, mise    |
| Maven      | `.jar`                         | Maven, mise            |
| Go         | module `.zip`, `.mod`, `.info` | none                   |
| OCI        | OCI image-layout `.tar`        | Docker, Podman, mise   |
| Nix        | `.nar`                         | Nix binary cache, mise |
| Debian/APT | `.deb`                         | dpkg-deb, mise         |
| WinGet     | validated YAML manifest set    | WinGet, mise           |
| Chocolatey | `.nupkg`                       | Chocolatey, mise       |

Use `--delegate` only when native-tool output is required:

```sh
opm pack oci --package-version 1.2.3 --delegate --tool podman --allow-build --offline
opm pack pypi --package-version 1.2.3 --delegate --tool uv --allow-build --allow-network
```

Delegation never silently replaces standard packing. Native compilation or
project-controlled lifecycle execution requires `--allow-build`; network access
independently requires `--allow-network`, and `--offline` wins when both are
present. All delegated commands run through the fail-closed package sandbox.

Internally, OpenPacker captures a bounded project tree and OCI-shaped config and
layer model. That normalized representation is not a user workflow. The receipt
records its canonical digest, the chosen target and tool, sandbox enforcement,
semantic loss, and digests over the exact native files written.
