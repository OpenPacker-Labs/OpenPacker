# Catalog fixtures

These captured, reviewable records drive mandatory offline adapter tests and the
demo catalog. Mutable fields such as npm dist-tags and provider ETags remain
metadata; exact package identity is always a canonical PURL plus immutable
digests.

No fixture lifecycle, install, build, proc-macro, or package script is executed
during normalization, enumeration, inspection, snapshotting, or lock capture.
