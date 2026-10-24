/**
 * The worlds under `test/fixtures/peer-worlds`, read for the placement suites
 * (ADR 0055 §9), and the check a plan of one has to pass.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { MAXIMUM_PLANNED_LAYOUTS, planPlacement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import type {
  PlaceInput,
  PlaceInstance,
  PlaceTop,
  PlannedPlacement,
} from './place-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A world of `test/fixtures/peer-worlds`. */
export function peerWorld(name: string): PlaceInput {
  const text = readFileSync(
    join(HERE, '../../test/fixtures/peer-worlds', name),
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
 * split the planner counts or the independent check finds, no fallback, and
 * no more layouts than a plan may make (`MAXIMUM_PLANNED_LAYOUTS`).
 */
export function soundPlan(input: PlaceInput): PlannedPlacement {
  const placement = planPlacement(input);
  expect(placement.problems).toEqual([]);
  expect(resolutionProblems(input, placement)).toEqual([]);
  expect(peerSplitProblems(input, placement)).toEqual([]);
  expect(placement.splits).toBe(0);
  expect(placement.fallback).toBe(false);
  expect(placement.layouts).toBeLessThanOrEqual(MAXIMUM_PLANNED_LAYOUTS);
  return placement;
}
