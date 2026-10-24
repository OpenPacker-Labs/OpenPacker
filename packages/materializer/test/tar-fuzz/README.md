# tar-fuzz

A differential fuzz of the materializer's npm reader agreement (ADR 0058 section
8): `node run.mjs <opm module> <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <family>`
reads each archive a family builds with node-tar (whole and in pieces of 1,
1,460, 16,384 and 65,536 bytes), pnpm's `parseTarball` and opm, and exits 1 if
opm extracts what the readers read differently. Families, flags and what each
varies are in `families.mjs` and `run.mjs`; the readers and the hand-built cases
are in `../tar-oracle`.
