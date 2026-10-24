# mutants

Mutation runs for ADR 0058 (the gzip padding and the npm reader agreement).
`mutants.jsonl` holds 129 mutants, one a line: 88 written while the rules were
fixed (`W`, `N`, `T`, `I`, `A`, `P`, `X`, `C`, `Y`, `Z`, `TX`, `BOM`, `OC`,
`PX`, `QD`, `ZN`), the sixth review's 16 (`M1` to `M15`, `M11b`) and 25 for the
rules added after it (`R19`, `R20`, `O1`, `E1`, `N1`, `D1`). Each replaces one
piece of source, which must occur exactly once, and runs a package's suite or
the test files it names.

```sh
node run.mjs all            # or a list of ids: node run.mjs R19a,R19b
node run.mjs all --dry      # only check that every `find` still matches once
```

`run.mjs` edits the checkout it is in and writes each file back from what it
read; run it on a clean tree and check `git status` after. The 2026-10-24 run
(Node 22.22.0, with `OPENPACKER_PNPM_DIR=/nonexistent`, so the fuzz test in the
suite was skipped) is in `results.tsv`: 122 killed and 7 not. `R19b`, `M14` and
`PX3` did not die in that run and were killed by tests added for them (an oracle
case of a mode field that is a NUL, six zeros and a last digit; `tarNumber`
refusing an 8 or a 9; a three-byte character whose first byte is at body offset
510, its later bytes 0x80, which the guard from offset 511 sees only as 0x80).
`PX3` was equivalent while the guard looked at the whole body, and stopped being
so when it began at offset 511.

## The seven that are not killed

Each is equivalent: no archive makes opm decide differently with it, for the
reason given.

| Mutant | Change                                                          | Why it changes no decision                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T14`  | node-tar's checksum text is not trimmed                         | `parseInt` skips the same white space `trim()` removes, so the number read is the same                                                                                                                                                          |
| `BOM3` | the checksum field's decoder strips a byte order mark           | the checksum text is trimmed after decoding, and `trim()` removes U+FEFF too                                                                                                                                                                    |
| `OC3`  | the node-tar half of the size and mode comparison is dropped    | `tarNumber` accepts only octal digits once cut at the first NUL and trimmed, and node-tar's `decSmallNumber` reads the same text as the same number; the sixth review checked 5,954,010 accepted fields of 30 M random ones: 0 differ           |
| `OC7`  | pnpm's checksum is read over 12 bytes instead of 8              | `verifyTarChecksum` and node-tar's 12-byte reading are checked first; of 60 M random 12-byte windows, 773,132 held a sum a header can have that both accept, and pnpm read none of them differently over 8 and over 12 bytes (the sixth review) |
| `PX2`  | a pax body of exactly 512 bytes falls under the long-body guard | a body is whole records and ends in a newline, so in a 512-byte body offset 511 is the newline and the guard (from offset 511) finds no byte past 0x7f                                                                                          |
| `M1`   | the text rule looks from the byte after the first NUL           | the slice from the NUL starts with the NUL itself, which is zero, so both slices hold a non-zero byte or neither does                                                                                                                           |
| `M15`  | node-tar's octal reader does not cut at a NUL                   | it is used only in the comparison of `OC3`, which cannot fire on its own                                                                                                                                                                        |
