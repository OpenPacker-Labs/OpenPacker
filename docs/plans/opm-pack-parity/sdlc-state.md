# OPM pack parity SDLC state

## Status

- Phase: implementation
- Current layer: `01-contracts-delegation`
- Branch: `sdlc/opm-pack-01-contracts-delegation`
- External issues/PRs: not created; implementation authorization did not include
  external mutations

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

## Acceptance

- All current OpenPacker ecosystems have an honest pack capability result:
  implemented, routed, or explicitly unsupported.
- Missing tools, build consent, network consent, malformed outputs, and sandbox
  failures fail closed.
- Standard output is deterministic and matches the normalized delegated oracle
  semantically.
- `npm run verify` passes before delivery; independent review finds no
  actionable defect.
