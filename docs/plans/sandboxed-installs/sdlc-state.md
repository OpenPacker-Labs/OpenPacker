# sdlc state — sandboxed installs

- Initiative: Aube-style jails + MXC-first sandboxed installs/execution
- Phase: **implementation** — foundation on main (`0c70e85` / #59); follow-up
  installers + generation sandbox fields
- Trunk at start: `fb23980`
- Foundation merged: `0c70e85` (#59)
- Plan: one-shot parallel swarm (no sequential phases); merge order bottom-up
  only for git hygiene

## Decisions (frozen)

1. **MXC preferred, native fallback.** `@microsoft/mxc-sdk` when available;
   Bubblewrap / Seatbelt / Landlock+seccomp / process isolation otherwise.
2. **Fail-closed default.** Project may set `sandbox.mode` to `degrade-warn` or
   `off`. Host unsandboxed install requires explicit opt-in and emits
   `SYSTEM_INSTALL_NOT_SANDBOXED`.
3. **Full surface.** Materialize/store, lifecycle scripts (when allowed),
   `opmx`/ephemeral, and host installers (apt/winget/chocolatey/nix).
4. **Approval ≠ ambient trust.** `allowLifecycleScripts` only permits scripts
   _inside_ the jail.
5. **MXC maturity honesty.** Preview profiles are not marketed as a finished
   security boundary; receipts record the backend that ran.
6. **Single funnel.** All package execution goes through `@openpacker/sandbox`
   `runInSandbox` — no ad-hoc spawn for install/run.

## Work packages

| WP  | Title                        | Branch / tip                          | Issue | Status                 |
| --- | ---------------------------- | ------------------------------------- | ----- | ---------------------- |
| A   | Spec, ADR, docs (contracts)  | `sdlc/sandbox-01-contracts` `c54ac67` | #50   | landed on branch       |
| B   | `@openpacker/sandbox` core   | same                                  | #51   | landed on branch       |
| C   | Policy + contracts plumbing  | same                                  | #52   | landed on branch       |
| D   | Materialize + lifecycle jail | same `2275c99`                        | #53   | landed on branch       |
| E   | opmx + ephemeral sandbox     | same `2275c99`                        | #54   | landed on branch       |
| F   | Host installers              | same `2275c99`                        | #55   | **partial** — apt only |
| G   | Receipts / generations       | open                                  | #56   | open                   |
| H   | Security tests + gates       | boundary test only                    | #57   | partial                |
| I   | Wiring + example project     | open                                  | #58   | open                   |

## Merge order (stack hygiene only)

A → (B ∥ C) → (D ∥ E ∥ F ∥ G ∥ H) → I

## Backend matrix (this session)

- Parent: Grok Build (local)
- Implementers: local worktree subagents (`general-purpose` / `implementer`)
- Reviewers: read-only after handback
- Cloud coding agents: not required; local gates only (no GHA minutes)

## Dispatch permission

User approved the one-shot parallel plan and authorized coding (plan mode exit).
Offload to parallel implementers is in scope for this initiative.
