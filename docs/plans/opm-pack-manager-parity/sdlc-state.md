# OPM pack manager parity SDLC state

## Status

- Phase: delivery complete
- Current layer: complete
- Branches: deleted after squash merge
- External issues: not created. PR #85 (`01-isolation`) squash-merged as
  `6540797`; PR #86 (`02-manager-cases`) squash-merged as `2e2fcd1`. Stack #87
  is complete.

## Problem

Standard pack emitters have deterministic archive tests, but those tests do not
prove that each supported package-manager family accepts the result. Running
host Nix, APT, WinGet, Chocolatey, Docker, or Podman from the test suite can
mutate stores, databases, profiles, daemons, or the runner itself.

## Decisions

- Normal verification remains offline and process-free: every standard target
  has a format-specific artifact oracle and every supported manager maps to one.
- Native-manager parity is explicit opt-in and runs only through Docker or
  Podman with preloaded digest-pinned images, no network, bounded resources,
  read-only artifact mounts, and deterministic timeout cleanup. Linux also uses
  a read-only root, dropped capabilities, no privilege escalation, a non-root
  user, and bounded tmpfs; Windows uses Hyper-V isolation and a bounded writable
  layer.
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

- 2026-08-18: focused pack parity, adapters-default type/tests, staged gates,
  docs, and escalated security gate passed.
- 2026-08-18: full offline `npm run verify` passed after the final code change.
- 2026-08-18: independent review approved the code and isolation boundary after
  Go proxy naming, Cargo/APT acceptance, alias coverage, storage bounds, and
  forced cleanup were repaired.
- Native Linux and Windows recipes remain intentionally unexecuted here because
  no digest-pinned images/container runtime were supplied. Default verification
  proved the complete matrix and that the lane stays dormant without opt-in.

## Implemented

- `6540797`: squash-merged locked-down container plan and explicit host-Nix
  opt-in from PR #85.
- `2e2fcd1`: squash-merged offline manager oracles, native recipes, fail-closed
  manifest requirements, and review fixes for Go/Cargo/APT parity, Windows
  storage bounds, unique container names, and forced timeout cleanup from PR
  #86.
