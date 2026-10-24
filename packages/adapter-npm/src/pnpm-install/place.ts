/**
 * Where each instance of a pnpm lock goes in `node_modules` (ADR 0055 §8 to
 * §11).
 *
 * An npm lock records a place for every package, because arborist chose it when
 * npm wrote the lock. A pnpm lock records only what each package needs, so the
 * places are chosen here, once, the way the closure planner chooses them
 * (`layout-plan.ts`), for several tops instead of one:
 *
 * - the project's direct dependencies live in its `node_modules`; a member's
 *   are answered as everything else is, from the member's directory, so one
 *   lock instance has one real path, and so one module, wherever no other
 *   version holds its name;
 * - every edge is answered breadth first: if Node already finds the wanted
 *   instance from where the dependent lives, nothing is written; if it finds
 *   another instance of that name, the wanted one is nested beside the
 *   dependent; if it finds nothing, the instance of that name the most
 *   packages want goes to the project's `node_modules` and any other beside its
 *   dependent;
 * - except that an instance with a peer its dependent requires too is shared,
 *   or written, only where that peer resolves to the dependent's own copy
 *   (`place-peers.ts`): as high as that holds, and no higher;
 * - a name whose slot in the project stays empty while one instance of it is
 *   written in two members' `node_modules` gives that instance the slot;
 * - a member link takes `node_modules/<member name>` in the project;
 * - a member nested inside another member's directory looks in that member's
 *   `node_modules` before the project's, as Node does.
 *
 * The answers depend on the order they are given in, so the layout is checked
 * and made again (`layOutUntilSound`): an edge whose dependency loads another
 * copy of a peer is pinned beside its dependent, and a name left without its
 * slot in the project is elected. First every such edge is pinned at once.
 * Where a split is left, the same is tried again pinning only the outermost
 * splits, and, when an edge that is pinned already still splits, giving its
 * dependency the project's slot, then writing it as high as its peers allow;
 * the same two steps answer a package that would sit inside a copy of itself
 * (past the depth or the size the layout is allowed), for the packages between
 * the two. At most `MAXIMUM_LAYOUTS` layouts are made for each way of sharing
 * under each way of pinning: first every importer shares what it can, then,
 * where that leaves a split or no layout, the importers that reach packages
 * needing each other keep all they need in their own `node_modules`. A lock
 * for which no layout with peers in view can be written within the bound is
 * laid out once more without them, as it was before the peer rule, rather than
 * refused; and a split no layout cures is kept, in the layout that has the
 * fewest, rather than refused, and counted (`splits`) so that the install can
 * say so (`FrozenLock.peers`).
 *
 * Pure. `place-check.ts` resolves every edge on the result with Node's lookup
 * and is how a plan is proved.
 */

import { compareText } from '../layout-compare.js';
import {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
} from '../layout-plan-types.js';
import {
  knownOf,
  LayoutOutgrown,
  layOut,
  pinId,
  type Known,
  type Laid,
  type Loops,
} from './place-layout.js';
import { cyclicImporters } from './place-cycles.js';
import { emptySlotChoices } from './place-order.js';
import { findSplits, moves, outermost, type PeerSplit } from './place-peers.js';
import type { PlaceInput, PlannedPlacement } from './place-types.js';

export { enclosingDirs } from './place-order.js';
export { MAXIMUM_DEPTH } from './place-layout.js';
export type {
  PlaceEdge,
  PlaceInput,
  PlaceInstance,
  PlacedInstance,
  PlacedLink,
  Placement,
  PlannedPlacement,
  PlaceTop,
} from './place-types.js';

/**
 * The most layouts made with peers in view. A layout is made, checked, and
 * made again with one more edge pinned, one more importer isolated or one more
 * name elected; the count is what bounds the work, whatever the lock holds.
 */
export const MAXIMUM_LAYOUTS = 8;

/**
 * The most layouts a plan makes: `MAXIMUM_LAYOUTS` for each of two ways of
 * sharing under each of two ways of pinning, and the layout without peers.
 */
export const MAXIMUM_PLANNED_LAYOUTS = MAXIMUM_LAYOUTS * 4 + 1;

/** A layout made with peers in view may take this many places for each instance and importer, and `PLACEMENTS_SPARE` more. */
const PLACEMENTS_PER_PACKAGE = 8;
const PLACEMENTS_SPARE = 256;

/** Every dependent of a layout: each top, then each placed instance. */
function* dependentsOf(input: PlaceInput, laid: Laid, known: Known) {
  for (const top of input.tops)
    yield {
      node: laid.tops.get(top.dir)!,
      mine: new Map(top.edges.map((edge) => [edge.as, edge.to])),
      edges: top.edges,
    };
  for (const node of laid.placed)
    yield {
      node,
      mine: known.mineOf(node.key!),
      edges: input.instances.get(node.key!)!.edges,
    };
}

interface Checked {
  readonly laid: Laid;
  readonly splits: readonly PeerSplit[];
}

/** Which splits of a layout are pinned for the next: every one, or only those closest to the importers. */
type Pinning = 'all' | 'outermost';

/**
 * Layouts made with peers in view until one has no peer split, or the count
 * is spent. `best` is the layout with the fewest splits (the later of equals);
 * it is absent when no layout could be written within the bound.
 */
function layOutUntilSound(
  input: PlaceInput,
  known: Known,
  isolated: ReadonlySet<string>,
  pinning: Pinning,
): { readonly best: Checked | undefined; readonly layouts: number } {
  const limit = Math.min(
    input.maximumPlacements ?? MAXIMUM_PLACEMENTS,
    input.peerPlacements ??
      PLACEMENTS_PER_PACKAGE * (input.instances.size + input.tops.length) +
        PLACEMENTS_SPARE,
  );
  let pinned: ReadonlySet<string> = new Set();
  let lifted: ReadonlySet<string> = new Set();
  const elected = new Map<string, string>();
  let best: Checked | undefined;
  let layouts = 0;
  while (layouts < MAXIMUM_LAYOUTS) {
    layouts += 1;
    // A package that needs, below itself, a copy of itself, with something
    // between that a copy nested there would be shadowed by, makes a tree
    // that is too deep or too big. The packages between are given the
    // project's slots, when that is allowed; where that is done or does not
    // answer, each is written as high as its peers allow instead.
    let loops: Loops | undefined;
    let laid: Laid | undefined;
    try {
      laid = layOut(input, known, {
        pinned,
        elected,
        isolated,
        lifted,
        limit,
      });
      if (laid.problems.length > 0) loops = laid.loops;
    } catch (error) {
      if (!(error instanceof LayoutTooLargeError)) throw error;
      if (error instanceof LayoutOutgrown) loops = error.loops;
      laid = undefined;
    }
    if (laid === undefined || laid.problems.length > 0) {
      if (pinning !== 'outermost' || loops === undefined) break;
      const names = [...loops.names].filter(([name]) => !elected.has(name));
      const edges = [...loops.edges].filter((edge) => !lifted.has(edge));
      if (names.length === 0 && edges.length === 0) break;
      for (const [name, key] of names) elected.set(name, key);
      if (names.length === 0) lifted = new Set([...lifted, ...edges]);
      pinned = new Set();
      continue;
    }
    const splits = findSplits(
      dependentsOf(input, laid, known),
      known.peersOf,
      pinId,
    );
    if (best === undefined || splits.length <= best.splits.length)
      best = { laid, splits };
    const fresh = splits.filter(
      (split) => !pinned.has(split.id) && !lifted.has(split.id),
    );
    if (fresh.length > 0) {
      // Beside the dependent, the next time.
      const next = pinning === 'all' ? fresh : outermost(fresh);
      pinned = new Set([...pinned, ...next.map((split) => split.id)]);
    } else if (splits.length > 0) {
      // Every edge that splits a peer is pinned already, and one still does.
      // The dependency of each is given the project's slot, to be written
      // above its dependent; where that is done already, it is written as
      // high as its peers allow below whatever answers the name. The pins are
      // made again either way.
      const above =
        pinning === 'outermost'
          ? moves(splits, elected)
          : new Map<string, string>();
      const higher =
        pinning === 'outermost' && above.size === 0
          ? splits.filter((split) => !lifted.has(split.id))
          : [];
      if (above.size === 0 && higher.length === 0) break;
      for (const [name, key] of above) elected.set(name, key);
      lifted = new Set([...lifted, ...higher.map((split) => split.id)]);
      pinned = new Set();
    } else {
      const choices = [
        ...emptySlotChoices(laid, input.instances, isolated),
      ].filter(([name]) => !elected.has(name));
      if (choices.length === 0) break;
      for (const [name, key] of choices) elected.set(name, key);
    }
  }
  return { best, layouts };
}

/** What one way of pinning made of a lock: its best layout, the importers it isolated, and the layouts it took. */
interface Attempt {
  readonly best: Checked | undefined;
  readonly isolated: ReadonlySet<string>;
  readonly layouts: number;
}

/**
 * First every importer shares what it can. Where that leaves a split, or no
 * layout at all, the importers that reach packages needing each other keep all
 * they need in their own `node_modules`, and the better layout is kept.
 */
function attemptWith(
  input: PlaceInput,
  known: Known,
  pinning: Pinning,
): Attempt {
  const shared = layOutUntilSound(input, known, new Set(), pinning);
  if (shared.best !== undefined && shared.best.splits.length === 0)
    return { best: shared.best, isolated: new Set(), layouts: shared.layouts };
  const keep = cyclicImporters(input);
  if (keep.size === 0)
    return { best: shared.best, isolated: new Set(), layouts: shared.layouts };
  const alone = layOutUntilSound(input, known, keep, pinning);
  const layouts = shared.layouts + alone.layouts;
  return alone.best !== undefined &&
    (shared.best === undefined ||
      alone.best.splits.length < shared.best.splits.length)
    ? { best: alone.best, isolated: keep, layouts }
    : { best: shared.best, isolated: new Set(), layouts };
}

/**
 * Whether `next` is a better layout than `kept`: there is one, and it has fewer
 * splits, or as many in fewer places. On a tie the layout kept stays.
 */
function better(next: Checked | undefined, kept: Checked | undefined): boolean {
  if (next === undefined) return false;
  if (kept === undefined) return true;
  return (
    next.splits.length < kept.splits.length ||
    (next.splits.length === kept.splits.length &&
      next.laid.placed.length < kept.laid.placed.length)
  );
}

export function planPlacement(input: PlaceInput): PlannedPlacement {
  const known = knownOf(input);
  // Every split pinned at once is the quick way, and cures nearly every lock.
  // Where a split is left, or no layout fits, the same is tried again pinning
  // the outermost splits only: a pin made for a split that an outer pin would
  // have cured can itself leave one. The second is kept only when it is better
  // (`better`), so a lock the first lays out without a split is laid out as it
  // was.
  let attempt = attemptWith(input, known, 'all');
  let layouts = attempt.layouts;
  if (attempt.best === undefined || attempt.best.splits.length > 0) {
    const again = attemptWith(input, known, 'outermost');
    layouts += again.layouts;
    if (better(again.best, attempt.best)) attempt = again;
  }
  const isolated = attempt.isolated;
  let laid = attempt.best?.laid;
  let fallback = false;
  if (laid === undefined) {
    // No layout with peers in view could be written: lay it out as the planner
    // did before there was a peer rule, which a lock that installed then still gets.
    fallback = true;
    layouts += 1;
    laid = layOut(
      input,
      { peersOf: () => [], mineOf: known.mineOf },
      {
        pinned: new Set(),
        elected: new Map(),
        isolated: new Set(),
        lifted: new Set(),
        limit: input.maximumPlacements ?? MAXIMUM_PLACEMENTS,
      },
    );
  }
  const { placed, links, problems } = laid;
  const splits = fallback
    ? findSplits(dependentsOf(input, laid, known), known.peersOf, pinId)
    : (attempt.best?.splits ?? []);
  const first = splits[0];
  return {
    placed: placed
      .map((node) => ({
        key: node.key!,
        base: node.base,
        chain: node.chain,
        direct: node.direct,
      }))
      .sort(
        (left, right) =>
          left.chain.length - right.chain.length ||
          compareText(left.base, right.base) ||
          compareText(left.chain.join('\0'), right.chain.join('\0')),
      ),
    links: [...links]
      .map(([name, memberDir]) => ({ name, memberDir }))
      .sort((left, right) => compareText(left.name, right.name)),
    problems,
    layouts,
    fallback,
    isolated: fallback ? [] : [...isolated].sort(compareText),
    splits: splits.length,
    ...(first !== undefined && {
      firstSplit: {
        importer: first.importer,
        ...(first.dependent !== undefined && { dependent: first.dependent }),
        dependency: first.dependency,
      },
    }),
  };
}
