# OPM pack parity SDLC state

## Status

- Phase: complete
- Current layer: complete
- Branch: `sdlc/opm-pack-01-contracts-delegation`
- External issues: not created. PR: #79.

## Decisions

- Deliver in three dependent layers: delegated pack, normalized OCI-based model,
  standardized emitters.
- `opm pack` ultimately uses standardized emitters by default; `--delegate`
  remains explicit with no silent fallback.
- Output is target-native artifact sets plus a canonical receipt. Normalization
  is an internal development/runtime contract, not a user command.
- Equivalent tools share one format adapter. mise routes to its declared backend
  and does not become a package type.
- Cross-target emission requires an explicit PREX `Distribution`; identifiers
  and target metadata are never guessed.
- Delegated builds and network access require separate explicit grants and use
  the existing fail-closed sandbox funnel.
- Standard emitters promise deterministic semantic parity, not native-tool byte
  identity, and never execute builds or lifecycle hooks.

## Planned layers

1. `01-contracts-delegation`: versioned pack provider/result/receipt contracts,
   registry routing, delegated execution, CLI compatibility.
2. `02-normalized-model`: normalized manifest/schema, safe content capture,
   OCI/CAS representation, adapter normalization.
3. `03-standard-emitters`: deterministic target-native emitters,
   standard-by-default CLI, parity and adversarial coverage.

## Implemented

- `929fcad`: package-build/2 host contract and strict npm delegation.
- `e92baa5`: delegated command parity for native tool families and mise routing.
- `d167cb4`: normalized pack schema/model, standard emitters, canonical
  receipts, standard-by-default CLI, conformance and independent archive checks.
- `cb8b381`: adapter-owned npm publish selection, non-executing tool discovery,
  explicit target versions, dotnet build consent and WinGet validation.
- `c20cd37`: directory snapshot/revalidation for fail-closed capture races.

## Verification

- 2026-08-18: focused package suites and impact-scoped staged gates passed.
- 2026-08-18: full offline `npm run verify` passed after the final code change.
- 2026-08-18: independent reviewer approved `c20cd37` with no findings.

## Acceptance

- All current OpenPacker ecosystems have an honest pack capability result:
  implemented, routed, or explicitly unsupported.
- Missing tools, build consent, network consent, malformed outputs, and sandbox
  failures fail closed.
- Standard output is deterministic and matches the normalized delegated oracle
  semantically.
- `npm run verify` passes before delivery; independent review finds no
  actionable defect.
