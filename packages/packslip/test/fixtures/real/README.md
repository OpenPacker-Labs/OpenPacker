# Real signed bundles

Public `packslip.sigstore.json` release bundles, downloaded unmodified:

| File                        | Source                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `hk-2.5.0.sigstore.json`    | `https://github.com/jdx/hk/releases/latest/download/packslip.sigstore.json` (v2.5.0) |
| `packslip-1.5.1.sigstore.json` | `https://packslip.dev/v1.5.1/packslip.sigstore.json`                   |

Both are keyless (Fulcio certificate, Rekor entry) and verify offline against
the embedded Sigstore public-good trusted root, because verification uses the
log's integration time rather than the wall clock. `packslip verify` 1.5.1,
the reference implementation, accepts both; the tests assert the same facts it
reports (signer, repository ID, fingerprint).
