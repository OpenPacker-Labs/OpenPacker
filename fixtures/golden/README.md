# Golden protocol corpus

These 19 digest-pinned artifacts are generated from the authoritative end-to-end
demo outputs. They cover normalization, identity, enumeration, catalog and
resolver state, receipts and lifecycle, OCI/OCM interop, and trust evidence.

Run `npm run demo` followed by `npm run golden:generate` only when intentionally
reviewing a protocol-output change. `npm run check:generated` verifies the
committed bytes against `manifest.json` without rewriting them.
