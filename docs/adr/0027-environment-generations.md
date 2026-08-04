# ADR 0027: Environment generations are an append-only ledger

- Status: Accepted
- Date: 2026-08-03

## Context

PREX could describe one resolved set of packages. It could not describe an
_environment over time_: what is installed right now, what was installed before,
and how to get back there. `openpacker.lock.json` pins a solve, and
`SolveRequest.environment` carried two arrays of opaque strings, but nothing
recorded that a particular pinned set became current at a particular moment, or
what preceded it.

That gap blocks the operations people actually want from an environment: switch
to a new set atomically, roll back when it breaks, and know which stored content
is still needed. Rollback in particular cannot be built on a mutable current
state, because the previous state has already been overwritten by the time you
want it back.

The reference implementation also has a constraint that rules out the usual
answer: it deliberately avoids symlinks, because they do not behave uniformly
across the platforms it supports, and its materializer refuses symlink archive
entries outright. So "repoint a symlink" is unavailable as the switch primitive.

## Decision

An environment is three objects in a new `environment.schema.json`.

**`EnvironmentManifest`** is the declarative input: name, requirements, target,
optional platforms, optional policy. It says what an environment should contain,
not what it currently does.

**`EnvironmentGeneration`** is an immutable record of one realised state:
sequence number, creation time, the manifest it came from, the lockfile,
solution and receipt digests behind it, and the artifact set it installed. Each
generation carries `parentGenerationDigest`, making the history a hash-linked
chain: editing any earlier generation breaks the link its children assert.
`generationDigest` is the `environment-generation-v1` projection digest, which
excludes the field itself, so it is always recomputable from the record.

**`EnvironmentState`** is the single mutable pointer: which generation is
current, and which are retained.

Switching writes a new state record atomically — write a temporary file, then
rename. Rolling back writes a state record pointing at an ancestor. Neither
rewrites or deletes a generation. Every user-visible view of an environment
(executable shims, environment variables, search paths) MUST be derivable purely
from the current generation plus store content, and MUST be regenerable
idempotently, so a crash during a switch leaves either the old state or the new
one and never a blend. The correctness anchor is the record; views are cache.

Retained generations are the reachability roots: stored content is collectible
exactly when it is outside the reference closure of every retained generation's
artifact set. This ADR defines that relation; it does not implement collection.

## Consequences

Rollback becomes a property of the data model rather than a feature bolted onto
an installer, and it works without symlinks, so it behaves the same everywhere.
Because generations bind the lockfile, solution, and receipt digests that
produced them, "what changed between these two environments, and what proof do I
have for each" is answerable from the ledger alone.

The costs are explicit. Retaining generations retains content, so an environment
that is never pruned grows — bounded by policy, once collection exists. And a
generation records what was installed, not a guarantee that it can be
reinstalled: that still depends on the artifacts and substitutes being
reachable.
