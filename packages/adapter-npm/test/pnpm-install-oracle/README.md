# Checking a pnpm install against the lock, with a second reading

ADR 0055 §12: the plan for a pnpm lock proves itself, and these three files
prove it again from outside the code that made it.

```sh
python3 dump-edges.py <project>/pnpm-lock.yaml > edges.json   # PyYAML only
node plan.mjs <project> plan.json [--filter ./packages/a]...  # what opm ci would place
node verify.mjs <project> plan.json edges.json plan           # Node's lookup over the plan
opm ci --path <project> [--filter ...]                        # install
node verify.mjs <project> plan.json edges.json disk           # Node's lookup over the tree
```

`verify.mjs` resolves every dependency edge of every importer and of every
installed package, and fails on any that finds a different package than the lock
names: a different version, another peer variant (the place found must be the
plan's place for that snapshot), a link to another directory. On `disk` it also
uses `require.resolve.paths`, reads the `package.json` it finds, and lists any
entry under a `node_modules` that the plan does not name.

Measured with them: ai-bdd 780 edges and HoBo 7,397 edges, 0 mismatches (ADR
0055, Consequences). `plan.mjs` imports the packages' `dist`, so build first.
