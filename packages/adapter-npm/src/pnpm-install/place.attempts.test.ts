/**
 * What the planner's layouts and attempts do, held by worlds small enough to
 * read (ADR 0055 §9). The review of #179, round 7, changed one line of the
 * planner at a time (a mutant); these are the cases that fail when each of
 * these lines is changed, and each world is the review's reduction of a random
 * one, or a reduction made the same way, in the `peer-worlds` fixtures.
 */

import { describe, expect, it } from 'vitest';
import { planPlacement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import { peerWorld, soundPlan } from './place-peer-worlds.js';

describe('an edge whose dependency sits beside its dependent', () => {
  it('is checked for a split like every other, and isolating the importer cures it', () => {
    // A dependency written directly beside its dependent can hold a copy of a
    // peer the dependent requires too, so the planner looks at that edge as
    // well. Without it the shared layout is reported as having no split while
    // the independent check finds one, and the plan keeps it.
    const placement = soundPlan(peerWorld('beside-edge.json'));
    expect(placement.isolated).toEqual(['packages/m0']);
    expect(placement.layouts).toBe(3);
  });
});

describe('an importer that keeps its packages to itself', () => {
  it('is preferred when sharing leaves a split that isolating cures', () => {
    const placement = soundPlan(peerWorld('isolation-preferred.json'));
    expect(placement.isolated).toEqual(['packages/m1']);
    expect(placement.layouts).toBe(3);
  });
});

describe('pins', () => {
  it('found in one layout are kept in the next', () => {
    // Four layouts, the last without a split. A pin forgotten between layouts
    // lets the planner go on to its bound: nine layouts for this world.
    const placement = soundPlan(peerWorld('pin-accumulation.json'));
    expect(placement.layouts).toBe(4);
    expect(placement.isolated).toEqual(['packages/m2']);
  });

  it('on an edge to a package the dependent sits inside are answered by that package, and cost a layout', () => {
    // The chain rule: a copy of the host nested in its own plugin would be
    // nested again in that copy. These five places take four layouts; with
    // every pinned edge placed beside its dependent, rule or no rule, the
    // planner reaches the same places in three.
    const placement = soundPlan(peerWorld('pin-chain.json'));
    expect(placement.layouts).toBe(4);
    expect(placement.placed).toHaveLength(5);
  });
});

describe('a split no layout avoids', () => {
  it('is kept in the layout with the fewest, still resolves every edge, and is counted', () => {
    // `p1@3` depends on an older `p1` and hosts a plugin `p4` that peers
    // `p1`; `p2` peers both. A tree cannot give `p2` the host `p1@3` and the
    // `p1@1` under one name, so one copy of the host and the plugin is loaded
    // twice (pnpm's symlinks make it one).
    const input = peerWorld('kept-split.json');
    const placement = planPlacement(input);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(input, placement)).toEqual([]);
    expect(placement.fallback).toBe(false);
    expect(placement.splits).toBe(1);
    expect(placement.firstSplit).toEqual({
      importer: expect.any(String),
      dependent: expect.stringMatching(/^p\d@/u),
      dependency: expect.stringMatching(/^p\d@/u),
    });
    // The independent check finds the same second copy.
    expect(peerSplitProblems(input, placement)).not.toEqual([]);
  });

  it('is laid out without peers in view when no layout with them fits, and the splits of that layout are counted', () => {
    const input = peerWorld('fallback.json');
    const placement = planPlacement(input);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(input, placement)).toEqual([]);
    expect(placement.fallback).toBe(true);
    expect(placement.isolated).toEqual([]);
    expect(placement.splits).toBe(1);
    expect(placement.firstSplit).toBeDefined();
  });
});
