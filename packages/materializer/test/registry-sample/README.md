# registry-sample

Real npm archives for ADR 0058 section 8: `manifest.txt` lists the 3,387
archives (name@version, how they were drawn in its header), and `run.mjs`
fetches each one into memory and reads it with one or more builds of the
materializer, in npm mode and under the general rule:

```sh
NODE_USE_ENV_PROXY=1 node run.mjs head=../../dist/esm/index.js before=<another build>
```

It prints how many archives each build extracts, its refusals by code, every
archive a build decides differently from the first one named, and every
`TAR_AMBIGUOUS_*` refusal of the first in npm mode. Nothing is written to disk;
a version the registry no longer serves is counted as gone. A run reads about
3,400 archives and takes some minutes.
