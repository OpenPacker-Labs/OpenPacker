# Contributing to OpenPacker

OpenPacker is the reference implementation of PREX. Keep PREX contracts
vendor-neutral, preserve native package bytes, and keep Epoch or other
downstream architecture outside production packages.

Human documentation starts at [`docs/README.md`](docs/README.md). Product
workflows live under [`docs/product/`](docs/product/); API/CLI compliance rules
are in [`docs/product/compliance.md`](docs/product/compliance.md). Runnable
samples are under [`examples/`](examples/README.md). Documentation changes must
pass `npm run test:docs`.

Agent coordination uses the repo-local **sdlc** skill (mirrored in
`.agents/skills/sdlc` and `.claude/skills/sdlc`) plus **gh-stack**. See
[`AGENTS.md`](AGENTS.md). After editing a skill tree, run
`npm run skills:mirror-check` and keep both mirrors byte-identical.

## Development

Use Node `^20.20.0 || >=22.13.0`, npm workspaces with the committed lockfile,
stable Rust 2024, and the checked-in tool configuration. Install with `npm ci`.
The mandatory checks and demo are offline after prerequisites are installed.

Public protocol changes start in `spec/prex/v1` and its JSON Schemas. Regenerate
consumers, repair OpenAPI/AsyncAPI, conformance vectors, TypeScript/Rust
bindings, examples, and docs in the same change. Do not hand-edit generated
files or add undeclared top-level extension fields.

Keep catalog acquisition outside the pure resolver, use the shared PURL/VERS and
canonicalization implementations, preserve native semantics with structured loss
evidence, and route one bug fix through the shared layer used by all callers.
New branches/parsers/security behavior include the smallest runnable regression
check.

## Validation

Run `npm run verify` before review. It includes format, contract/generated
freshness, license, TypeScript, Rust, conformance, security, integration,
compatibility, browser, fuzz, benchmark, and production-path demo gates. Live
public providers and registries are separate opt-in jobs and do not excuse an
offline failure.

Commit generated changes only with their source and freshness evidence. Solver
fixtures require independent proof and bounded oracle agreement; artifacts
require digest and safe-materialization negatives; schemas require positive,
negative, size, canonical, and round-trip vectors. Documentation changes run
`node docs/operations/documentation-smoke.mjs` and the documented Prettier
check.

The detailed contract and release checklist is
[`docs/operations/contributing-releasing.md`](docs/operations/contributing-releasing.md).
