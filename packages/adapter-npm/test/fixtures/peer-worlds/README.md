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
- `kept-split`: the review's world of a package that depends on an older version
  of itself and hosts a plugin that peers it. No layout gives the plugin's
  dependents one copy of the host; the planner keeps the layout with the fewest
  splits and counts them.
- `fallback`: a reduction of a random world in which no layout with peers in
  view fits, so the lock is laid out without them.
