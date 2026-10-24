# tar-fuzz

A differential fuzz of the materializer's npm reader agreement (ADR 0058 section
8). Each archive a family builds is read by every reader, and the run fails on
an archive the readers read differently that opm extracts, or one they read
alike that opm extracts as something else. What is compared and the classes are
in `fuzz.mjs`; the families, and what each varies, in `families.mjs` and
`families-more.mjs`.

```sh
node run.mjs <opm module> <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <family> \
  [--node-tar-7 <node-tar 7.5.22 dir>] [--seed N] [--count N] [--pacote]
```

## The readers

- **node-tar 6.2.1**, the one npm 10.9 bundles:
  `$(npm root -g)/npm/node_modules/tar` with npm 10.9.4 (the oracle and the fuzz
  refuse any other version).
- **node-tar 7.5.22**, npm 11's line:
  `node fetch-node-tar-7.mjs <new directory>` fetches it and the five packages
  it needs from the registry, checks each against a pinned sha512 and unpacks it
  with the system `tar` (no package manager); give
  `<new directory>/node_modules/tar`.
- **pnpm 10.28.0**: the `pnpm` package directory of a 10.28.0 install, for
  example `$(npm root -g)/pnpm`. Its `parseTarball` is taken from
  `dist/pnpm.cjs` by its source path (`../tar-oracle/readers.mjs`) and runs in a
  worker with a 3-second deadline, because it spins for minutes on an `x` header
  whose size runs past the data; an archive it misses the deadline on is counted
  as `inconclusive`, not as a disagreement.
- **opm**: the materializer's built entry, `dist/esm/index.js`, or a bundle of
  `src/index.ts` (`esbuild src/index.ts --bundle --platform=node --format=esm`).
- With `--pacote`, `tar.x` with pacote 19.0.1's options and filter for each
  node-tar line, to a temporary directory; a `tar.x` that throws or fails is
  `UNSAFE-TARX` when opm extracts the archive.

## Families and seeds

| Family        | Without `--seed`                                                 | With `--seed N --count C`                    |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `byte-sweep`  | every header byte but the checksum's, 15 values, 5 bases: 37,800 | C archives, base, position and byte drawn    |
| `field-bytes` | seed 1, C archives                                               | C archives                                   |
| `pax-records` | seed 1, C archives                                               | C archives                                   |
| `pax-cut`     | a character swept across six feed boundaries: 246                | C archives, cut, padding and character drawn |
| `meta-order`  | every pair and triple of 16 headers: 4,864                       | C runs of 2 to 5 headers                     |
| `zero-blocks` | zero, null and partial blocks, cut archives: 1,183               | C runs of entries and blocks                 |

On a 4-CPU VM under load, `byte-sweep` with `--pacote` and both node-tar lines
takes about ten minutes; 2,000 archives of a seeded family about one.
`src/tar-fuzz.test.ts` runs every family at 300 archives with a fixed seed in
the materializer's suite (about 20 seconds), when it finds the readers in
`OPENPACKER_NODE_TAR_6_DIR`, `OPENPACKER_PNPM_DIR` and
`OPENPACKER_NODE_TAR_7_DIR` or installed beside the running node, and says it
skipped otherwise. A run with no failure shows that its families found none, not
that there is none.
