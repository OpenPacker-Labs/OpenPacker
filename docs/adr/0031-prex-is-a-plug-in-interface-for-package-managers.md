# ADR 0031: PREX is a plug-in interface for package managers, and execution is a declared capability

- Status: Accepted
- Date: 2026-08-04
- Supersedes the execution prohibition in
  [ADR 0023](0023-build-recipes-are-captured-claims.md) and normative invariant
  10

## Context

ADR 0023 and invariant 10 stated that PREX operations MUST NOT execute builders,
lifecycle scripts, recipes, or expression languages. That was written while
modelling Nix, where the distinction between _capturing_ a derivation and
_evaluating_ one is real and worth defending.

Generalised into a protocol-wide prohibition, it was wrong for what PREX is for.
PREX is meant to be the interface **other package managers plug into** — one
identity scheme, one verification story, one receipt format, across every
ecosystem. Several of the package managers that most need that cannot be
modelled as pure metadata:

- `apt` and `winget` install onto the host and run maintainer scripts. There is
  no read-only version of "install curl".
- `npx`, `pipx`, `uvx` and `dnx` exist precisely to fetch and run something.
- Nix realisation builds or substitutes; capture alone never produces bytes.

A prohibition does not make those safe. It makes them **out of scope**, which
leaves users with the native tool and no common identity, no common receipt, and
no honest statement of what was verified — the exact gap PREX exists to close.

## Decision

Execution is a **declared capability**, not a prohibition.

1. `ProviderCapabilities.operations` gains `install` and `run`. A provider that
   lists them is stating that it changes the host; one that omits them is
   stating that it does not. The capability document is the contract.
2. `InstallerProvider` is the plug-in point for package managers that act:
   `available()` reports whether the native tool can run here, `plan()` returns
   the exact argv without doing anything, and `install()` performs it and
   returns an outcome.
3. Implementations are **expected to shell out to the native tool**. apt owns
   Debian dependency resolution, maintainer scripts, triggers and the dpkg
   database; reimplementing that would be wrong in ways that only appear on
   someone else's machine. PREX supplies identity, consent and the receipt.

What does not change, because it is what makes any of this trustworthy:

- **Execution never establishes identity.** `recipe-output-v1` and byte identity
  stay distinct; a `producedBy` claim is evidence, never identity.
- **`normalize` and `solve` stay side-effect free**, so a solution remains
  reproducible. Side effects live in the `install` and `run` classes, which say
  so in their capabilities.
- **An implementation must not claim what it did not check.** A system install
  is not byte-verified and is not covered by the generation ledger, so the apt
  provider emits `SYSTEM_INSTALL_NOT_BYTE_VERIFIED` (blocking
  `native-validated-v1`) and `SYSTEM_INSTALL_NOT_REVERSIBLE` on every plan.
- **Elevation is consented to, never assumed.** A PURL naming a system package
  is not authorization to change the machine; `allowElevation` is opt-in and
  `plan()` shows the argv first.

## Consequences

- The honesty machinery does more work than before, not less. Where the old
  answer was "we do not do that", the new answer is "we did that, here is the
  command, and here is what it does not prove."
- `native-capture-v1` and `native-validated-v1` are unaffected for pure metadata
  paths. System installs are blocked from `native-validated-v1` by their own
  declared loss.
- Arguments to a native tool are built as argv and validated against the
  ecosystem's own name grammar. A package name is never interpolated into a
  shell string.
- Providers that cannot run on a host report it rather than throwing, so a
  caller can choose another one — `winget` on Linux is a fact, not an error.

## Notes

The first implementation is `@openpacker/adapter-apt`, driving real `apt-get`
and `apt-cache`. It was verified against apt 2.8.3 on Ubuntu: real candidate and
installed versions, correct argv, elevation refused without consent, and
injection attempts rejected as invalid Debian package names.
