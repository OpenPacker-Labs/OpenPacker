# ADR 0003: Preserve native bytes; use OCI and ORAS for transport

- Status: Accepted
- Date: 2026-08-02

## Context

Repacking npm tarballs, crates, or NuGet packages would create new artifacts
that no longer match upstream signatures, hashes, or native tooling.

## Decision

OpenPacker stores the exact native archive as an OCI blob. OCI 1.1 manifests,
annotations, subjects, and referrers describe and transport it; ORAS is an
interoperability workflow, not core execution logic.

## Consequences

Upstream bytes and digests remain authoritative. Metadata, receipts, overlays,
SBOMs, and provenance can evolve as referrers without mutating the package.
