# sdlc state — sandbox security hardening

- Initiative: close audit gaps (C1/C2/H1–H4/M1–M4) as one-shot swarm
- Phase: **complete** — #73 + #74 on main
- Trunk base: `9c71d2b`
- Shipped: `e6f5504` (#73); gap-close `e3ec252` (#74)
- Issues: #63–#72 closed via #73

## Delivered

- Profiles: `package-exec` | `host-install` | `ambient`
- Minimal bwrap binds for package-exec (no fat RO `/`)
- Minimal PATH; project RO by default for opmx
- Shim re-entry via opmx / ambient hatch
- Host-install limited containment honesty
- Strict lifecycle allowlist default
- Must-pass adversarial tests
- Timeouts (default 600s)

## Gap-close after #73 (this session)

| Gap                                                                   | Fix                                               |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| Apt called `runInSandbox` as package-exec and could claim `SANDBOXED` | Apt uses `runHostInstaller` like winget/choco/nix |
| Project `[sandbox]` never reached host `opm add`                      | `hostSandboxFromPolicy` on plan/install           |
| Generation `sandbox.enforced` inferred from “scripts ran”             | Receipts store `policyDigest` + observed backends |
| MXC always RW-mounted cwd (C2 on that backend)                        | cwd is RO unless the caller granted write         |
| Closeout docs still said “implementation → ship”                      | This file                                         |

## Still true (honest product stance)

Defense-in-depth, not a microVM. Host installers remain user-capability limited.
Windows without MXC stays fail-closed. Seatbelt/MXC live probes skip when the
tools are not on the runner.

## Verification

Scoped package tests + `npm run test:security`. Full `npm run verify` before
merge.
