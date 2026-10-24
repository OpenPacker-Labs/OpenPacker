# Peer worlds

Small valid placement inputs (instances, their edges with the peer flag
`placeInputOf` sets from `peerDependencies`, and importers) that the planner in
`src/pnpm-install/place*.ts` must lay out (ADR 0055 §9). `cycle-split` and the
two triangles are the reviewer's reductions of random worlds from the round-6
review of #179 (a cycle of peers across two members), where the planner of the
round before refused the lock: `cycle-split` as "a defect in the planner" and
the triangles as "more than 50,000 package directories". The planners before it
laid each of them out in six places.

`host-plugin` is a world of the same review's cycle family that the planner
could not lay out at all while every importer shared (packages that peer one
another, wanted at different versions by five members): packages that need each
other at different versions, shadowed for ever below the project. Each member's
closure holds one instance of each name, so the members that reach the cycle
keep it in their own `node_modules`.

`place.cycles.test.ts` reads them.

The six worlds below belong to the round-7 review of #179, which changed the
planner one line at a time and found lines no test noticed. Each is small enough
to read, and `place.attempts.test.ts` asserts what it shows.

- `beside-edge`, `isolation-preferred`: the review's reductions of random
  worlds. In the first, the planner has to look at an edge whose dependency is
  written beside its dependent to see a split; in the second, sharing leaves a
  split that isolating the importer cures.
- `pin-accumulation`, `pin-chain`: reductions made the same way, of worlds in
  which a pin kept from one layout to the next (four layouts, where forgetting
  it takes nine), and the rule that a pin never writes a package inside its own
  copy (four layouts, where placing every pinned edge beside its dependent takes
  three), change how many layouts the same five places take.

The six worlds below belong to the round-8 decision on #179: a split the planner
can avoid is not kept and merely reported. Each is the reduction (edges and
instances deleted while the failure stayed) of a random lock from the review's
generators, on which the planner of the round before kept a split or fell back
to a layout without peers although a search over every layout
(`place-exhaustive.ts`, which uses nothing of the planner) finds one with none.
`place.refine.test.ts` asserts what each shows and repeats the search.

- `pin-cascade`: three splits in the first layout, two in the importers' own
  edges and one in the package those edges lead to; pinning all three at once
  leaves a split that pinning the outer two alone does not.
- `election`: the review's world of a package that depends on an older version
  of itself and hosts a plugin that peers it. An edge that is pinned beside its
  dependent still splits, because the dependent shadows a peer the dependency
  needs; the dependency is given the project's slot and written above.
- `lift`: the same, where the project's slot is taken by an instance the
  dependency is not (the project's own edge), so the dependency is written as
  high as its peers allow, below the project.
- `too-deep`: a package that needs, below itself, a copy of itself that the
  package between them shadows; the layout would sit more than 32 directories
  deep, so the package between is given the project's slot.
- `too-large`: the same shape, where the layout reaches its size bound before it
  is deep enough to be refused.
- `loop-lift`: the same, where the project's own edge takes the slot, so the
  packages between are written as high as their peers allow, in the importer
  that keeps its packages to itself.

`kept-split` is the one world here that no layout avoids, and the planner keeps
its one split: three instances of `p2` compete for the name (the project's own,
the member's direct one, and the one the host `p1@3` needs, which peers `p1@3`
and the plugin `p4`), and `p1@3` holds an older `p1` under its own name, so a
copy of that `p2` beside `p1@3` finds the older `p1`, and one above finds the
member's `p2`. The search over every layout of at most 20 places finds 94,505
that resolve every edge, and every one has a split (the test repeats it to 16
places: 2,969 layouts).
