# Upstream packslip conformance vectors

These six JSON files are copied unmodified from
[`tests/conformance`](https://github.com/jdx/packslip/tree/main/tests/conformance)
in `jdx/packslip` (MIT licensed, © the packslip authors). They are the
specification's executable examples: an implementation that disagrees with a
vector disagrees with the specification.

`test/conformance.test.ts` runs every case against `@openpacker/packslip`.
Refresh them by re-copying the upstream files; do not hand-edit them. Locally
added cases belong in the other test files so the upstream set stays diffable.

| File                      | Rule                                           |
| ------------------------- | ---------------------------------------------- |
| `artifact-selection.json` | Selecting an artifact                          |
| `resource-selection.json` | Resources                                      |
| `tag-versions.json`       | Tags                                           |
| `statement-validity.json` | The release statement                          |
| `forge-identity.json`     | Repository identity and renames                |
| `signer-fingerprint.json` | Signer fingerprints                            |
