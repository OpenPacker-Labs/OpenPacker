# OPM pack manager parity SDLC state

## Status

- Phase: implementation
- Current layer: `01-isolation`
- Branch: `sdlc/opm-pack-manager-parity-01-isolation`
- External issues / PRs: not created.

## Problem

Standard pack emitters have deterministic archive tests, but those tests do not
prove that each supported package-manager family accepts the result. Running
host Nix, APT, WinGet, Chocolatey, Docker, or Podman from the test suite can
mutate stores, databases, profiles, daemons, or the runner itself.

## Decisions

- Normal verification remains offline and process-free: every standard target
  has a format-specific artifact oracle and every supported manager maps to one.
- Native-manager parity is explicit opt-in and runs only through Docker or
  Podman with preloaded digest-pinned images, no network, a read-only root,
  dropped capabilities, no privilege escalation, a non-root user, bounded
  resources, tmpfs scratch space, and read-only artifact mounts.
- The harness never mounts a container socket. OCI is checked with an
  unprivileged OCI archive consumer; it does not use Docker-in-Docker.
- WinGet and Chocolatey native checks require a Windows container runtime. Their
  offline artifact oracles remain mandatory on every platform.
- mise is a PREX client integration, not a pack target. Its existing contract
  test remains the parity gate for that integration.
- Live host Nix tests require explicit opt-in; tool presence alone must never
  execute Nix during ordinary tests.
- No Testcontainers dependency is added: the existing Node runtime and a small,
  audited argv builder cover the required containment without image pulls or a
  privileged sidecar.

## Layers

1. `01-isolation`: fail-closed container runner, safety regressions, host Nix
   opt-in, durable matrix.
2. `02-manager-cases`: per-target artifact oracles, native manager recipes, gate
   wiring, full verification and independent review.

## Acceptance

- The manager matrix covers npm, Cargo, pip, uv, NuGet, Maven, Go, OCI
  (Docker/Podman), Nix, APT/dpkg, WinGet, Chocolatey, and mise.
- Normal `npm run verify` cannot execute or modify a host package manager.
- The native lane refuses missing/unpinned images, unknown runtimes, ambient
  network, root/privileged execution, writable artifact mounts, or host sockets.
- Each standard emitter has a manager-mapped, format-specific offline oracle.
- Focused checks, `npm run verify`, and independent review pass before merge.

## Verification

- Pending.
