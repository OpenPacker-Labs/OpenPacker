# ADR 0030: Build versus buy for standard primitives

- Status: Accepted
- Date: 2026-08-04

## Context

OpenPacker reached twenty-nine ADRs with six third-party runtime dependencies —
`ajv`, `fastify`, `resolvo`, `serde`, `sha2`, `thiserror` — and no ADR
explaining why. That posture was never decided; it accumulated. Meanwhile the
repository carried its own implementations of RFC 8785 canonical JSON (twice,
once per language), PURL parsing, multi-pattern substring search, POSIX shell
quoting and nixbase32.

Several defects landed in exactly those reimplementations:

- A shell-quoting routine that left `$` and backticks live, so a project
  directory name reached `eval`.
- A hand-written Rabin-Karp scanner whose safety needed a deliberately
  constructed hash collision to demonstrate.
- An ordered-set sort by UTF-8 bytes where the specification says UTF-16 code
  units — the classic JCS pitfall, in the one language that does not get the
  answer for free.
- A nixbase32 alphabet missing a character, which decoded roughly a fifth of
  real hashes to the _wrong_ digest and rejected the rest.

None of these is a hard problem. All of them are somebody else's solved problem,
and the cost of solving them again was paid in defects rather than in dependency
review.

The opposing pressure is real and specific to this project: OpenPacker is a
package manager with a supply-chain story. Every dependency is one this project
would have to vouch for, and a dependency whose behavior shifts in a later
release can silently move digests that are supposed to be stable forever.

## Decision

Standard primitives are taken from a library unless there is a stated reason not
to. A primitive is "standard" when it implements a published specification or a
textbook algorithm and the repository is not the authority on it.

Three outcomes are allowed, and which one applies must be recorded where the
decision lives:

1. **Adopt as the implementation.** The default. Used for `shell-quote` and
   `ahocorasick`.

2. **Adopt as a test oracle, keep the implementation.** Correct when the
   repository's contract is deliberately _narrower_ than the specification, or
   when the primitive's output is bound into a permanent digest and a future
   release changing it would be a silent identity break. The library then pins
   conformance continuously without owning the bytes. Used for `serde_jcs` (PREX
   canonical JSON is a restriction of JCS — safe integers only) and
   `packageurl-js` (this parser refuses duplicate qualifiers, empty path
   segments, empty qualifier names and unbounded length, all of which the
   reference accepts; and `exactPurl` feeds every node ID).

3. **Keep the implementation, with an independent oracle in the tests.** Only
   when no suitable library exists. Used for nixbase32, which has no npm
   package; its vectors come from an independent reimplementation of Nix's
   `printHash32` anchored on `sha256("")`.

What is _not_ a standard primitive, and stays in this repository: the PREX
protocol itself — digest projections, semantics profiles, loss codes, the
resolution calculus — and any data model. Reference-closure garbage collection
is the worked example: the traversal is a textbook visited-set walk and was
never the problem; the bugs were in where edges were stored and what keyed them,
which no library decides.

## Consequences

- New dependencies are still reviewed for licence, maintenance and provenance.
  `npm run check:licenses` remains the gate; nothing copyleft enters.
- Choosing outcome 2 or 3 requires writing down why, next to the code.
- Cross-check tests against a reference implementation are load-bearing, not
  decoration: the Rust-versus-JS canonical JSON divergence was invisible
  precisely because two hand-written implementations of one specification had
  nothing comparing them.
- Replacing a primitive must leave the golden digests unchanged, or the change
  is an identity break and needs its own decision.

## Notes

Adopting `ahocorasick` also made the scan faster, not slower: 107ms against
171ms for the hand-written Rabin-Karp at 1000 candidates over 8MB, and 8161ms
before either. "Hand-rolled is faster" was not true here even before counting
the defects.
