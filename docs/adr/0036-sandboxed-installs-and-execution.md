# ADR 0036: Install and package execution run under a declared sandbox policy

- Status: Accepted
- Date: 2026-08-11
- Relates: [ADR 0030](0030-build-versus-buy-for-primitives.md),
  [ADR 0031](0031-prex-is-a-plug-in-interface-for-package-managers.md),
  [ADR 0033](0033-native-supply-chain-capture-and-mitigation.md)

## Context

OpenPacker already materializes packages into a project-local content-addressed
store and refuses dependency lifecycle scripts by default. That closes the
common “malicious postinstall on install” path only by **never running** the
code. It does not:

- give a safe path when a project must allow scripts (native addons),
- isolate `opmx` / ephemeral tool runs from the ambient host,
- contain host installers (`apt`, `winget`, `chocolatey`, `nix`) after elevation
  consent.

Aube’s model (deny scripts by default; approved builds in a narrow jail with FS
write limits, network deny, scrubbed env, and a temporary home) and Microsoft’s
MXC (cross-platform policy-driven containment with multiple backends) describe
the missing boundary. ADR 0030 says buy standard primitives unless there is a
stated reason not to; containment is a standard OS concern with a published
TypeScript SDK (`@microsoft/mxc-sdk`).

MXC is early preview. Microsoft documents that current profiles should not be
treated as a finished security boundary. OpenPacker must therefore compose
deny-by-default scripts **and** a jail, and must record which backend enforced
policy rather than claim “MXC-secure” as a product fact.

## Decision

1. **Execution that is not pure metadata runs under a declared sandbox policy.**
   The policy is project-config (`opm.toml` `[sandbox]`) and PREX `PolicyInput`
   fields, bound into receipts via `policyDigest`.
2. **Default mode is fail-closed.** If the requested jail cannot be enforced,
   refuse rather than silently unsandbox. `degrade-warn` and `off` may relax
   isolation policy, but never waive hard process-tree termination: package
   execution still refuses when no OS-owned tree is available.
3. **Backend ladder:** prefer MXC when available and able to enforce the
   profile; else Bubblewrap's PID namespace on Linux; else refuse. Seatbelt
   alone does not own a killable process tree, and Windows requires MXC's job
   containment.
4. **Single enforcement funnel** — `@openpacker/sandbox` `runInSandbox`.
   Lifecycle scripts, `opmx`/ephemeral runs, and `InstallerProvider.install` all
   go through it. No second ad-hoc spawn for package execution.
5. **Approval ≠ ambient trust.** `allowLifecycleScripts` / allowlists only mean
   scripts may run **inside** the jail (optionally with per-package grants for
   network, write paths, env). They do not inherit credentials or home by
   default.
6. **Host installers stay capability-honest (ADR 0031).** Plans expose argv and
   the sandbox profile. `degrade-warn`, `off`, and ambient system install are
   refused; a host installer must run fail-closed in an OS-owned process tree.
7. **Adopt MXC as preferred primitive (ADR 0030 outcome 1);** OpenPacker owns
   policy semantics and PREX honesty. Native backends are first-class fallbacks,
   not afterthoughts.

## Consequences

- Pure extract-only installs still never run scripts; they evaluate sandbox
  policy and record that scripts did not execute.
- Scripted installs use a quarantine tree, run scripts in the jail, then
  atomically publish into `.opm/store`.
- Offline `npm run verify` must not require MXC or Bubblewrap: unit tests use a
  mock backend; fail-closed is tested without host tools.
- Semantic loss / evidence codes for sandbox outcomes are first-class:
  `SANDBOX_ENFORCED`, `SANDBOX_BACKEND_MXC`, `SANDBOX_BACKEND_NATIVE`,
  `SANDBOX_UNAVAILABLE`, `SANDBOX_DEGRADED`,
  `SYSTEM_INSTALL_CONTAINMENT_LIMITED`, `SYSTEM_INSTALL_NOT_SANDBOXED`.
  (`SYSTEM_INSTALL_SANDBOXED` is deprecated and must not be emitted for new host
  installs.)

## Notes

Inspiration:
[aube jailed builds](https://aube.jdx.dev/package-manager/jailed-builds.html),
[Microsoft MXC](https://github.com/microsoft/mxc). Neither is vendored
wholesale; PREX remains the authority on identity, receipts, and what was
verified.

## Amendment (2026-08-11) — post-audit hardening

Live probes showed fat `--ro-bind / /` left the home tree readable and `opmx`
mounted the project read-write. Profiles now distinguish:

| Profile        | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `package-exec` | Minimal RO toolchain + explicit trees; project RO by default |
| `host-install` | User-capability limited containment only                     |
| `ambient`      | Intentionally unsandboxed                                    |

`enforced` is true only for successful `package-exec` jails. Host installers
emit `SYSTEM_INSTALL_CONTAINMENT_LIMITED`. Bin shims re-enter via `opmx` (or
refuse ambient without `OPENPACKER_ALLOW_AMBIENT_SHIMS=1`).

**Defense-in-depth, not a microVM or finished OS security product.**
