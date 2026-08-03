# OCI, ORAS, and OCM mapping

OpenPacker preserves the native npm tarball, Cargo crate, or NuGet package
unchanged. Its SHA-256 and size identify those bytes. OCI transports the bytes;
OCM describes deliverable composition; PREX remains the resolution authority.

| Native archive      | Preserved blob media type              |
| ------------------- | -------------------------------------- |
| npm package tarball | `application/vnd.npm.package+gzip`     |
| Cargo crate         | `application/vnd.crates.io.crate+gzip` |
| NuGet package       | `application/vnd.nuget.package+zip`    |

## OCI image layout and registry

`OciImageLayout.packNative` stores the native archive as one layer, uses the OCI
empty JSON descriptor for config, and writes an OCI image manifest carrying the
package artifact type and exact PURL annotations. Layout blobs are verified on
read. Manifest/index descriptors use the standard media types from the
[OCI Image Specification](https://github.com/opencontainers/image-spec/blob/v1.1.0/spec.md).

Receipts, overlays, chunk indexes, SBOMs, provenance, and other evidence are
separate subject-bearing OCI 1.1 manifests. Their provisional `artifactType`
comes from the centralized PREX media registry. A chunk index is an optional
referrer; reconstruction still must equal the original OCI SHA-256 digest.

The registry client implements OCI Distribution blob checks/uploads, manifest
transfer, pagination, digest verification, referrer discovery, manual redirect
handling, and an authentication boundary. Registry locations can change without
changing artifact identity. See the
[OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md)
and
[OCI referrers API](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md#listing-referrers).

[ORAS](https://oras.land/docs/) is an interoperability client, not a core
dependency. `npm run test:live` performs the opt-in registry push/pull/referrer,
ORAS copy, and OCM validation checks. The
[`live-compat` workflow](../../.github/workflows/live-compat.yml) supplies
digest-pinned Zot, ORAS, and OCM images and exact version expectations;
mandatory offline behavior uses the image layout directly.

## OCM

OpenPacker emits OCM v2 component descriptors. Each selected exact package maps
to a stable digest-derived component name and native version. Native artifacts
become resources with SHA-256, media type, size, and local-blob access.
Representable selected dependency edges become location-independent component
references. Labels bind exact PURL and optional solution/receipt digests.
Repository contexts and access descriptors may change when mirrored; semantic
identity and signed labels do not.

Descriptors are canonicalized and validated for schema version, component and
reference identity, duplicate names, sizes, and digest consistency. PREX does
not create a competing component graph. Primary OCM documentation:
[component descriptors](https://ocm.software/docs/component-model/component-descriptors/)
and [component identity](https://ocm.software/docs/component-model/identity/).
