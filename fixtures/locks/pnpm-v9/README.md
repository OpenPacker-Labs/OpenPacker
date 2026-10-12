# pnpm lockfileVersion '9.0' fixtures

Lockfiles for the reader in `packages/adapter-npm/src/pnpm-lock/` (ADR 0052).
Three are real files written by pnpm 9 or 10, kept as pnpm wrote them (so
`.prettierignore` leaves them alone); one is written by hand for the source
forms no real lock here contains; one is the output of the YAML writer pnpm is
built on, for the one YAML form no real lock here contains.

| File                            | Importers | Packages | Snapshots | Importer links | Aliases |
| ------------------------------- | --------: | -------: | --------: | -------------: | ------: |
| `ai-bdd.pnpm-lock.yaml`         |         9 |      393 |       393 |             17 |       0 |
| `hobo.cut.pnpm-lock.yaml`       |         9 |      432 |       436 |              2 |       6 |
| `opensesame.cut.pnpm-lock.yaml` |         7 |      348 |       348 |              4 |       3 |
| `exotic.pnpm-lock.yaml`         |         3 |       22 |        22 |              1 |       1 |
| `long-key.pnpm-lock.yaml`       |         1 |       46 |        46 |              0 |       0 |

## Where each came from

- `ai-bdd.pnpm-lock.yaml` is the complete `pnpm-lock.yaml` of the ai-bdd
  repository, byte for byte (sha256
  `82f5cb6c6e7711856a203cf1e94a1bad007f2f19ec761591530de461ea9875fd`).
- `hobo.cut.pnpm-lock.yaml` is HoBo's `pnpm-lock.yaml` (sha256
  `258f955338ea327631f54446b1b3c18d0035a5849fcd32695024e5b639074f85`, 792
  importers, 2,160 packages, 2,193 snapshots) cut to the importers
  `external/ts-autocode/packages/{grounding,rewrite,harness,training}`,
  `packages/agent-skills`, `packages/yard-world` (and the importer it links to),
  and
  `src/draft/technical-proofs/{cqrs-command-aggregate-contract,s0-04-protobuf-cue-codegen}`.
- `opensesame.cut.pnpm-lock.yaml` is OpenSesame's `pnpm-lock.yaml` (sha256
  `e4b76b9b140f40ad333141d5de371f6c3951517559534a01be9c45504a7b5d3a`, 70
  importers, 1,930 packages, 1,951 snapshots) cut to
  `packages/{env-spec-bridge,guide-runtime,auth-upstream}`, `apps/android` (an
  importer with no dependencies) and the importers they link to. Its
  `patchedDependencies` are left out because the packages they patch are not in
  the cut; `exotic.pnpm-lock.yaml` carries the patch forms.

A cut keeps the original text of every block it keeps: `settings` and
`overrides` whole, the chosen importers, and each `packages` and `snapshots`
entry the importers reach through `dependencies` and `optionalDependencies` (an
alias value `name@version` is followed to the package it names). Nothing is
reflowed, so the flow mappings, quoting and blank lines are pnpm's. The
importers were chosen greedily so that every field and key shape of a full lock
is present in its cut, with three exceptions that cost 300 to 550 more snapshots
each: an importer's `optionalDependencies` and a package's `bundledDependencies`
(HoBo), and the `patch_hash` forms (OpenSesame). `exotic.pnpm-lock.yaml` carries
those three. What the cuts do keep: nested peer suffixes three deep, alias
dependencies, `link:` importer dependencies with `workspace:` specifiers, `os`,
`cpu`, `libc`, `deprecated`, `hasBin`, peer dependencies with
`peerDependenciesMeta`, `transitivePeerDependencies`, optional snapshots, empty
snapshots (`{}`) and an importer that is `{}`.

`exotic.pnpm-lock.yaml` is written by hand, in pnpm's style, from the code of
pnpm 10.28.0 that builds these ids and resolutions (`createGitHostedPkgId`, the
git, tarball and local resolvers, the runtime resolver). It has the forms no
real lock here contains: a tarball (a git host's archive and a `file:` archive),
a git repository (with and without `&path:`), a directory, an injected workspace
package, a runtime with a variant per platform, a catalog, a patch (the real
`braces`, `fill-range`, `node-forge` entries and hashes from OpenSesame), a peer
suffix replaced by a hash, an `npm:` alias, `bundledDependencies`, a
`deprecated` message with quotes in it, all four `settings`, `time`, the two
checksums, `ignoredOptionalDependencies`, `dependenciesMeta` and
`publishDirectory`. Each integrity in it is either copied from a real lock (the
packages that have one there) or the SHA-512 of a dummy string (those that do
not, and the react and scheduler entries, which are not meant to be the real
packages' digests). It cannot show that pnpm writes these forms; it shows that
this reader reads them.

`long-key.pnpm-lock.yaml` is the verbatim output of js-yaml 4.3.0 (sha256
`7c0907d01ee2749ffa155e3b4e9415f755835dbbb29606f54463349c3a0ad5f4`), dumping a
small lock object with the options pnpm 10.28 passes (`lineWidth: -1`,
`noCompatMode`, `noRefs`, `sortKeys: false`; `blankLines` belongs to the fork
pnpm bundles and 4.3.0 lacks, so there are no blank lines between entries and
`resolution` is a block mapping, not `{integrity: ...}`). The object is one
importer and a package with 45 peer dependencies, so its snapshot key is 1,358
characters. js-yaml writes a mapping key of more than 1,024 characters in the
explicit form (`? key`, then `: value`), and pnpm's bundled dumper has the same
rule (`state.dump.length > 1024`, in the 10.28 bundle); YAML allows an implicit
key only up to 1,024. Every integrity in it is the SHA-512 of a dummy string. No
real lock here has a key that long (HoBo's longest is 905 characters), so this
is the only evidence for the form, and it is a writer's output, not a lock pnpm
wrote.

## expected.json

The numbers the tests compare with (importers, packages, snapshots, edges, link
and alias edges, exotic sources, names in several versions, platform
restrictions, orphans, patched and peer-suffixed snapshots, the deepest
parenthesis nesting) were counted with a short Python script over the same file
with PyYAML and none of the TypeScript reader's logic, so the reader is checked
against a second reading and not against itself. `sha256` is the hash of the
fixture the counts were taken from; a test fails if the file changes without the
counts.
