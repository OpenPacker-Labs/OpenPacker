# sdlc state — sandboxed installs

- Initiative: Aube-style jails + MXC-first sandboxed installs/execution
- Phase: **dispatch** — contracts frozen; parallel work packages WP-A…WP-I
- Trunk at start: `fb23980`
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

| WP  | Title                        | Branch (planned)                       | Issue | Status |
| --- | ---------------------------- | -------------------------------------- | ----- | ------ |
| A   | Spec, ADR, docs (contracts)  | `sdlc/sandbox-01-contracts`            | #50   | active |
| B   | `@openpacker/sandbox` core   | `sdlc/sandbox-01-contracts` (combined) | #51   | active |
| C   | Policy + contracts plumbing  | `sdlc/sandbox-01-contracts` (combined) | #52   | active |
| D   | Materialize + lifecycle jail | `sdlc/sandbox-04-lifecycle`            | #53   | queued |
| E   | opmx + ephemeral sandbox     | `sdlc/sandbox-05-opmx`                 | #54   | queued |
| F   | Host installers              | `sdlc/sandbox-06-installers`           | #55   | queued |
| G   | Receipts / generations       | `sdlc/sandbox-07-receipts`             | #56   | queued |
| H   | Security tests + gates       | `sdlc/sandbox-08-security`             | #57   | queued |
| I   | Wiring + example project     | `sdlc/sandbox-09-wiring`               | #58   | queued |

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
