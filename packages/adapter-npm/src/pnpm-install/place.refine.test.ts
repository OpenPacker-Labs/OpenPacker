/**
 * The splits the planner cures by trying again, and the one it keeps (ADR 0055
 * §9, round 8). Each world is the reduction of a random lock from the review's
 * generators, made by deleting edges and instances while the planner of the
 * round before kept a split or could not write a layout with peers in view
 * (`test/fixtures/peer-worlds/README.md`). A search over every layout of the
 * world, which uses nothing of the planner, says whether a layout without a
 * split exists: for the first group it does, and the planner must find one; for
 * the last it does not, and the planner keeps one split in the layout it has.
 */

import { describe, expect, it } from 'vitest';
import { MAXIMUM_PLANNED_LAYOUTS, planPlacement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import { searchSplitFree } from './place-exhaustive.js';
import { peerWorld, soundPlan } from './place-peer-worlds.js';

describe('a split the planner cures by trying again', () => {
  // `layouts` is what the plan takes; a plan that is cured by one more step
  // takes more layouts than one that was cured by the step before it.
  const cases = [
    {
      world: 'pin-cascade.json',
      step: 'pins only the outermost splits',
      placed: 6,
      layouts: 6,
      isolated: [],
    },
    {
      world: 'election.json',
      step: 'gives the dependency of a split that stays pinned the slot in the project',
      placed: 5,
      layouts: 10,
      isolated: [],
    },
    {
      world: 'lift.json',
      step: 'writes the dependency of a split that stays as high as its peers allow',
      placed: 5,
      layouts: 14,
      isolated: ['packages/m0'],
    },
    {
      world: 'too-deep.json',
      step: 'gives the packages between a copy and its own copy the slots in the project',
      placed: 7,
      layouts: 3,
      isolated: [],
    },
    {
      world: 'too-large.json',
      step: 'does the same where the layout outgrew its bound before it was deep enough to refuse',
      placed: 7,
      layouts: 3,
      isolated: [],
    },
    {
      world: 'loop-lift.json',
      step: 'writes the packages between a copy and its own copy as high as their peers allow, where the project cannot give a slot',
      placed: 6,
      layouts: 8,
      isolated: ['packages/m5'],
    },
  ] as const;

  it.each(cases)('is cured when the planner $step ($world)', (spec) => {
    const input = peerWorld(spec.world);
    const placement = soundPlan(input);
    expect(placement.placed).toHaveLength(spec.placed);
    expect(placement.layouts).toBe(spec.layouts);
    expect(placement.isolated).toEqual(spec.isolated);
  });

  it.each(cases)(
    'is one a search over every layout avoids too: a layout of at most 12 places has no split ($world)',
    (spec) => {
      const search = searchSplitFree(peerWorld(spec.world), 12);
      expect(search.found).toBeDefined();
      const input = peerWorld(spec.world);
      expect(resolutionProblems(input, search.found!)).toEqual([]);
      expect(peerSplitProblems(input, search.found!)).toEqual([]);
    },
  );
});

describe('a split no layout avoids', () => {
  // Three instances of `p2` compete for one name: the project's own, the one
  // the member needs directly, and the one `p1@3` needs, whose peers are
  // `p1@3` and the plugin `p4`. `p1@3` also holds an older `p1` under its own
  // name, so beside `p1@3` that instance of `p2` finds the older `p1`, and
  // anywhere above it finds the member's `p2`.
  const input = peerWorld('kept-split.json');

  it('is kept in the layout with the fewest, still resolves every edge, and is counted', () => {
    const placement = planPlacement(input);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(input, placement)).toEqual([]);
    expect(placement.fallback).toBe(false);
    expect(placement.splits).toBe(1);
    expect(placement.firstSplit).toEqual({
      importer: '',
      dependent: 'p1@3.0.0',
      dependency: 'p2@1.0.0#2',
    });
    expect(placement.placed).toHaveLength(9);
    // The independent check finds the same second copy.
    expect(peerSplitProblems(input, placement)).toHaveLength(1);
  });

  it('is kept in the layout with fewer places when the two ways of pinning leave as many', () => {
    // The same world beside a host and its plugins that peer one another,
    // wanted by a member at another version than the project's. Pinning every
    // split at once and pinning the outermost first each keep the one split
    // no layout avoids; the first also writes the plugin's package a second
    // time in the member, which the second does not.
    const tie = peerWorld('tie-break.json');
    const placement = planPlacement(tie);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(tie, placement)).toEqual([]);
    expect(placement.splits).toBe(1);
    expect(placement.placed).toHaveLength(13);
    expect(
      placement.placed.filter((place) => place.key === 'p1@1.0.0'),
    ).toHaveLength(1);
  });

  it('takes the layouts the bound allows, no more', () => {
    const placement = planPlacement(input);
    expect(placement.layouts).toBe(22);
    expect(placement.layouts).toBeLessThanOrEqual(MAXIMUM_PLANNED_LAYOUTS);
  });

  it('is one no layout of at most 16 places avoids: every one of the 2,969 that resolves every edge has a split', () => {
    const search = searchSplitFree(input, 16);
    expect(search.found).toBeUndefined();
    expect(search.complete).toBe(2969);
  });
});
