# ADR 0002: PURL and VERS do not encode mutable locations

- Status: Accepted
- Date: 2026-08-02

## Context

Registry URLs, mirrors, aliases, tags, and channels change independently of a
package's ecosystem-qualified identity or version constraint.

## Decision

PREX uses PURL for package identity and VERS plus native preserved syntax for
constraints. Mutable retrieval locations are ordered hints on artifact
descriptors and are excluded from content identity unless a receipt explicitly
snapshots them.

## Consequences

Mirroring does not rename packages or change semantic digests. Reproducibility
comes from exact PURLs, snapshot digests, and artifact digests rather than a URL
that may later serve different bytes.
