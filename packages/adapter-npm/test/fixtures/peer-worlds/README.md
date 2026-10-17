# Peer worlds

Small valid placement inputs (instances, their edges with the peer flag
`placeInputOf` sets from `peerDependencies`, and importers) that the planner in
`src/pnpm-install/place*.ts` must lay out (ADR 0055 §9). Each is the reduction
of a random world from the round-6 review of #179 (a cycle of peers across two
members), where the planner of the round before refused the lock: `cycle-split`
as "a defect in the planner" and the two triangles as "more than 50,000 package
directories". The planners before it laid each of them out in six places.

`host-plugin` is a world of the same review's cycle family that the planner
could not lay out at all while every importer shared (a host and its plugins
that peer each other, in four versions, wanted by five members): packages that
need each other at different versions, shadowed for ever below the project. Each
member's closure holds one instance of each name, so the members that reach the
cycle keep it in their own `node_modules`.

`place.cycles.test.ts` reads them.
