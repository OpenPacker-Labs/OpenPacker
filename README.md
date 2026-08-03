# OpenPacker

OpenPacker is the reference implementation of **PREX (Package Resolution
Exchange)**, a transport-neutral protocol for normalizing package ecosystems
beyond OCI. PREX standardizes package identity, constraints, resolution, proofs,
receipts, and immutable artifact descriptions without pretending that all
package managers share installation or build semantics.

OpenPacker is not a replacement for npm, Cargo, NuGet, OCI, or native package
managers. It preserves native package bytes and ecosystem-specific metadata;
OCI/ORAS transport those bytes, OCM describes deliverable composition, and PREX
describes resolution. OpenPacker is independent of Epoch. Epoch can consume its
SDK, events, receipts, and artifact descriptors through public contracts, but no
production OpenPacker package depends on Epoch or ATProto.

## Five-minute offline demo

Prerequisites: Node.js 24, npm 11, stable Rust, and mise 2026.7.13. Install the
pinned WASM binding tool and Playwright browser once; after these prerequisites
the demo uses committed fixtures and makes no public-registry requests.

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
npm exec playwright install chromium
npm run demo
```

The demo starts the local reference service, imports the npm/Cargo/NuGet fixture
catalogs, solves and independently checks a cross-ecosystem graph, packs
unchanged native archives into an OCI image layout, verifies trust evidence,
materializes the fixture tool, exercises service/native/WASM modes, and writes
indexed evidence to `.demo-output/`. Any digest or verification mismatch fails
the command.

## Development

```sh
npm ci
npm run verify
```

`npm run verify` is the fail-closed aggregate for formatting, schemas, generated
files, TypeScript, Rust, conformance, security, integration, compatibility,
browser, and end-to-end checks. Live provider and registry tests are opt-in and
are never substituted for the mandatory offline checks.

Useful entry points:

- [`spec/prex/v1/`](spec/prex/v1/) — normative PREX 1.0-draft contracts.
- [`docs/architecture.md`](docs/architecture.md) — system boundaries and data
  flow.
- [`docs/adr/`](docs/adr/) — architecture decisions.
- [`apps/openpackerd/`](apps/openpackerd/) — HTTP reference service.
- [`apps/openpacker-cli/`](apps/openpacker-cli/) — command-line client.
- [`packages/sdk/`](packages/sdk/) — ESM/CommonJS/browser-safe client.
- [`packages/embedded/`](packages/embedded/) — native and WASM embedded API.
- [`crates/openpacker-resolver/`](crates/openpacker-resolver/) — pure resolver
  and proof checker.

## Protocol boundary

PREX owns versioned contracts, canonicalization, semantic profiles, proofs, and
receipt schemas. OpenPacker owns the reference daemon, SDK, CLI, resolver,
adapters, artifact tooling, conformance suite, and test harness. Downstream
systems own their histories, identities, federation, and delivery topology.
Mutable names and locations locate content; cryptographic digests identify it.

The project is licensed under the [MIT License](LICENSE).
