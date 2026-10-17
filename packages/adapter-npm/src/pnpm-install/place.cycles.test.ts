import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAXIMUM_LAYOUTS, planPlacement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import { cycleWorld, seeded, type CycleSpec } from './place-cycle-worlds.js';
import type { PlaceInput, PlaceInstance, PlaceTop } from './place-types.js';

/** A fixture world of `test/fixtures/peer-worlds`. */
function fixture(name: string): PlaceInput {
  const text = readFileSync(
    new URL(`../../test/fixtures/peer-worlds/${name}`, import.meta.url),
    'utf8',
  );
  const world = JSON.parse(text) as {
    instances: PlaceInstance[];
    tops: PlaceTop[];
  };
  return {
    instances: new Map(world.instances.map((item) => [item.key, item])),
    tops: world.tops,
  };
}

/**
 * Plan, and require the plan to prove itself: every edge resolved, no peer
 * split, laid out with peers in view and within the bound on layouts.
 */
function planned(input: PlaceInput) {
  const placement = planPlacement(input);
  expect(placement.problems).toEqual([]);
  expect(resolutionProblems(input, placement)).toEqual([]);
  expect(peerSplitProblems(input, placement)).toEqual([]);
  expect(placement.splits).toBe(0);
  expect(placement.fallback).toBe(false);
  expect(placement.layouts).toBeLessThanOrEqual(MAXIMUM_LAYOUTS);
  return placement;
}

describe('a cycle of peers across members', () => {
  it.each(['cycle-split.json', 'triangle-large.json', 'triangle-large-2.json'])(
    'lays out %s: six instances, every edge resolved, one copy of every shared peer',
    (name) => {
      const input = fixture(name);
      const placement = planned(input);
      // The planners before the peer rule wrote each of these in six places.
      expect(placement.placed.length).toBeGreaterThanOrEqual(6);
      expect(placement.placed.length).toBeLessThanOrEqual(24);
    },
  );
});

describe('packages that need each other at different versions, wanted by several members', () => {
  it('keeps them in the members that reach them, every edge resolved and no peer split', () => {
    const input = fixture('host-plugin.json');
    const placement = planPlacement(input);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(input, placement)).toEqual([]);
    expect(peerSplitProblems(input, placement)).toEqual([]);
    expect(placement.splits).toBe(0);
    expect(placement.fallback).toBe(false);
    // Sharing came first and found no layout; then the members that reach the cycle kept to themselves.
    expect(placement.layouts).toBe(2);
    expect(placement.isolated).toEqual([
      'packages/m0',
      'packages/m0/sub4',
      'packages/m1',
      'packages/m2',
      'packages/m3',
    ]);
  });
});

describe('a lock no layout with peers in view can be written for', () => {
  it.each(['cycle-split.json', 'triangle-large.json', 'host-plugin.json'])(
    'is laid out without peers in view, as before the peer rule, not refused (%s)',
    (name) => {
      // Two places for the layout with peers in view: not enough for six instances.
      const input = { ...fixture(name), peerPlacements: 2 };
      const placement = planPlacement(input);
      expect(placement.problems).toEqual([]);
      expect(placement.fallback).toBe(true);
      expect(resolutionProblems(input, placement)).toEqual([]);
      expect(placement.placed.length).toBeGreaterThanOrEqual(6);
      // Sharing gave up, the members that reach the cycle gave up, and then
      // the layout without peers.
      expect(placement.layouts).toBe(3);
    },
  );

  it('is still refused when the lock is too large for any layout', () => {
    const input = { ...fixture('triangle-large.json'), maximumPlacements: 3 };
    expect(() => planPlacement(input)).toThrow(
      /more than 3 package directories/u,
    );
  });
});

describe('random worlds whose packages peer each other, cycles included', () => {
  // The review's specs: packages, members, how likely a package peers a later one.
  const specs: CycleSpec[] = [
    { packages: 4, members: 3, cycles: 0.2 },
    { packages: 5, members: 4, cycles: 0.5 },
    { packages: 6, members: 5, cycles: 0.3 },
    { packages: 7, members: 6, cycles: 0.15 },
    { packages: 9, members: 8, cycles: 0.25 },
  ];

  it('lays out every valid world, resolves every edge and loads every shared peer once', () => {
    let valid = 0;
    specs.forEach((spec, index) => {
      const random = seeded(101 + index);
      for (let draw = 0; draw < 150; draw += 1) {
        const input = cycleWorld(random, spec);
        if (input === undefined) continue;
        valid += 1;
        planned(input);
      }
    });
    // Not vacuous: most draws are valid locks.
    expect(valid).toBeGreaterThan(600);
  }, 120_000);
});
