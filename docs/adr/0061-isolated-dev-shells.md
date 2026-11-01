# ADR 0061: Isolated dev shells via `opm shell --isolate`

- Status: Accepted
- Date: 2026-11-01
- Relates: [ADR 0027](0027-environment-generations.md),
  [ADR 0036](0036-sandboxed-installs-and-execution.md)

## Context

`opm shell` (ADR 0027) prints export statements for the current generation's
environment so a developer can `eval "$(opm shell)"` on the **host**. That is
correct for composability but offers no containment: host credentials, ambient
`PATH`, and writable home remain in scope.

`@openpacker/sandbox` (ADR 0036) already jails package installs, lifecycle
scripts, and `opmx` runs via MXC and native helpers. Those profiles are tuned
for short-lived package execution, not an interactive workspace.

Operators want a **first-class isolated dev shell**: same resolved tools and
generation metadata as the host shell, with the project tree available for
editing, store/generation paths mounted read-only, optional network, and a clear
fallback when no backend exists.

## Decision

1. **`opm shell --isolate[=auto|mxc|lxc]`** enters an isolated dev shell.
   - Without `--`, behavior is unchanged (print exports or `--json`).
   - With `--isolate` and no command, start an interactive login shell inside
     the container/sandbox.
   - With **`opm shell --isolate -- <cmd>…`**, run `<cmd>` non-interactively and
     exit with its status.
2. **Manifest default** under `[environment]`:
   - `shell_isolate = "off"|"auto"|"mxc"|"lxc"` — default backend preference
     when `--isolate` is passed without `=value` (default `off`: opt-in).
   - `network = true|false` — outbound network inside the isolated shell
     (default `false`).
3. **Bind plan** for every isolated shell:
   - **Read/write:** project root (working tree).
   - **Read-only:** `opm.lock.json`, `.opm/store`, `.opm/generations`,
     `.opm/environment.json`, `.opm/references.json`, `.opm/bin`, `.opm/links`.
   - **Environment:** derived from the current generation
     (`environmentVariables`), same as non-isolated `opm shell`.
4. **Backends** (packages/sandbox):
   - **LXC/Incus** (`lxc` backend id): Linux only; uses the `incus` or `lxc`
     CLI, ephemeral container, disk bind devices for the plan. Preferred in
     `auto` on Linux when available.
   - **MXC**: same SDK as package execution; used when LXC is unavailable or
     when `=mxc` is requested.
   - **No native bwrap dev shell in v1** — bwrap remains package-exec fallback
     inside ADR 0036, not an interactive shell UX.
5. **Host fallback:** If `--isolate` is requested and no backend is available,
   **fail closed** with exit code 78 and a message listing probe results. The
   host export path is **not** silently substituted (explicit
   `eval "$(opm shell)"` remains the host fallback).
6. **Capability detection:** `probeDevShellBackends()` / `probeLxc()` /
   `probeMxc()`; integration tests skip when tools are absent.

## Consequences

- CI without Incus/MXC continues to pass: unit tests mock backends; integration
  tests gate on probes.
- LXC pulls a base image on first use (`images:ubuntu/24.04`); air-gapped hosts
  need a pre-cached image or must use MXC.
- Isolated shells inherit honesty losses from ADR 0036 (`SANDBOX_BACKEND_LXC`,
  `SANDBOX_BACKEND_MXC`); they are not marketed as finished security boundaries.
- `[environment]` is an opm.toml concern; PREX `PolicyInput` is unchanged in v1.

## Notes

Future work may add profile reuse, rootless Incus setup docs, and native bwrap
interactive mode; this ADR scopes v1 to LXC/Incus + MXC behind the existing
sandbox backend interface and `dev-shell` profile for LXC.
