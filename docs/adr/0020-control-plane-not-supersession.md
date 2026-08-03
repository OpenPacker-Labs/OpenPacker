# ADR 0020: OpenPacker is a package control plane, not a supersession

- Status: Accepted
- Date: 2026-08-03

## Context

Package ecosystems already own install, build, and runtime scripts. Operators
need a shared plane for identity, constraints, resolution evidence, and pinned
artifacts without replacing npm, pip, Cargo, or other native managers, and
without pretending that a single CLI can reimplement their full behavior.

Tooling such as Nexus and mise can proxy or integrate package and tool
workflows. PREX must stay the normalization, proof, and pin layer rather than a
command-compatible supersession of those tools or of native package managers.

## Decision

OpenPacker is a **package control plane** for PREX. It normalizes identity and
constraints, acquires immutable catalog snapshots, solves or captures graphs,
emits independent proofs and receipts, and describes immutable artifacts. Native
package managers remain authoritative for install, build, and runtime script
execution. Nexus- and mise-class tools proxy or integrate; PREX normalizes,
proves, and pins. There is no production coupling to Epoch or ATProto.

## Consequences

Clients compose OpenPacker with native managers instead of migrating off them.
Proof strength tracks the chosen semantics profile. Integrations stay thin
adapters over PREX operations, and OpenPacker does not claim command
compatibility with npm, pip, Cargo, or similar CLIs.
